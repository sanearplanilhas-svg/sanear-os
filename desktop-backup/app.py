from __future__ import annotations

import hashlib
import html
import io
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import zipfile
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable

import tkinter as tk
from tkinter import filedialog, messagebox, ttk

try:
    from pypdf import PdfReader, PdfWriter
except ImportError:  # pragma: no cover - exibido ao usuário em tempo de execução
    PdfReader = None
    PdfWriter = None

try:
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
    from reportlab.lib import colors
except ImportError:  # pragma: no cover
    A4 = None

APP_TITLE = "Consulta de Backups - SANEAR Operacional"
if getattr(sys, "frozen", False):
    APP_DIR = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "SANEAR_Backup"
else:
    APP_DIR = Path(__file__).resolve().parent
APP_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = APP_DIR / "sanear_operacional.db"
SETTINGS_PATH = APP_DIR / "config.json"


@dataclass
class BackupImportResult:
    filename: str
    imported: bool
    records: int
    reason: str = ""


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def open_path(path: Path) -> None:
    if not path.exists():
        raise FileNotFoundError(str(path))
    if sys.platform.startswith("win"):
        os.startfile(str(path))  # type: ignore[attr-defined]
    elif sys.platform == "darwin":
        subprocess.run(["open", str(path)], check=False)
    else:
        subprocess.run(["xdg-open", str(path)], check=False)


def human_datetime(value: str | None) -> str:
    if not value:
        return "Não informado"
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.astimezone().strftime("%d/%m/%Y %H:%M")
    except (ValueError, TypeError):
        return value


def normalize(value: Any) -> str:
    return str(value or "").strip()


def json_text(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def ensure_database(connection: sqlite3.Connection) -> None:
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA journal_mode = WAL")
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS backups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            content_hash TEXT NOT NULL UNIQUE,
            file_sha256 TEXT NOT NULL UNIQUE,
            filename TEXT NOT NULL,
            source_path TEXT NOT NULL,
            generated_at TEXT,
            imported_at TEXT NOT NULL,
            record_count INTEGER NOT NULL DEFAULT 0,
            photo_count INTEGER NOT NULL DEFAULT 0,
            schema_version INTEGER NOT NULL DEFAULT 1
        );

        CREATE TABLE IF NOT EXISTS ordens (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            backup_id INTEGER NOT NULL REFERENCES backups(id) ON DELETE CASCADE,
            source_collection TEXT NOT NULL,
            source_id TEXT NOT NULL,
            origem TEXT,
            tipo TEXT,
            protocolo TEXT,
            ordem_servico TEXT,
            bairro TEXT,
            rua TEXT,
            numero TEXT,
            ponto_referencia TEXT,
            observacoes TEXT,
            status TEXT,
            created_at TEXT,
            updated_at TEXT,
            data_execucao TEXT,
            created_by_email TEXT,
            created_by_uid TEXT,
            sla_horas REAL,
            status_antes_sanear TEXT,
            sla_pausas_json TEXT,
            fotos_json TEXT,
            pdf_start_page INTEGER,
            pdf_page_count INTEGER,
            raw_json TEXT NOT NULL,
            UNIQUE(source_collection, source_id)
        );

        CREATE INDEX IF NOT EXISTS idx_ordens_protocolo ON ordens(protocolo);
        CREATE INDEX IF NOT EXISTS idx_ordens_os ON ordens(ordem_servico);
        CREATE INDEX IF NOT EXISTS idx_ordens_bairro ON ordens(bairro);
        CREATE INDEX IF NOT EXISTS idx_ordens_execucao ON ordens(data_execucao);
        CREATE INDEX IF NOT EXISTS idx_ordens_operador ON ordens(created_by_email);
        """
    )
    connection.commit()


def load_settings() -> dict[str, Any]:
    if not SETTINGS_PATH.exists():
        return {}
    try:
        return json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def save_settings(data: dict[str, Any]) -> None:
    SETTINGS_PATH.write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def import_backup(connection: sqlite3.Connection, zip_path: Path) -> BackupImportResult:
    if not zip_path.exists() or zip_path.suffix.lower() != ".zip":
        return BackupImportResult(zip_path.name, False, 0, "Arquivo ZIP inválido")

    file_hash = sha256_file(zip_path)
    existing = connection.execute(
        "SELECT 1 FROM backups WHERE file_sha256 = ?", (file_hash,)
    ).fetchone()
    if existing:
        return BackupImportResult(zip_path.name, False, 0, "ZIP já importado")

    try:
        with zipfile.ZipFile(zip_path, "r") as archive:
            if "manifest.json" not in archive.namelist() or "dados/ordens.json" not in archive.namelist():
                return BackupImportResult(
                    zip_path.name, False, 0, "Não é um backup compatível do SANEAR"
                )

            manifest = json.loads(archive.read("manifest.json").decode("utf-8"))
            payload = json.loads(archive.read("dados/ordens.json").decode("utf-8"))
            records = payload.get("records", [])
            if not isinstance(records, list):
                raise ValueError("A lista de registros do JSON é inválida")

            content_hash = normalize(manifest.get("contentHash"))
            if not content_hash:
                content_hash = hashlib.sha256(
                    json.dumps(records, ensure_ascii=False, sort_keys=True).encode("utf-8")
                ).hexdigest()

            existing_content = connection.execute(
                "SELECT 1 FROM backups WHERE content_hash = ?", (content_hash,)
            ).fetchone()
            if existing_content:
                return BackupImportResult(
                    zip_path.name, False, 0, "Conteúdo do backup já importado"
                )

            cursor = connection.execute(
                """
                INSERT INTO backups (
                    content_hash, file_sha256, filename, source_path,
                    generated_at, imported_at, record_count, photo_count, schema_version
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    content_hash,
                    file_hash,
                    zip_path.name,
                    str(zip_path.resolve()),
                    manifest.get("generatedAt"),
                    datetime.now().isoformat(timespec="seconds"),
                    len(records),
                    int(manifest.get("photoCount") or 0),
                    int(manifest.get("schemaVersion") or 1),
                ),
            )
            backup_id = cursor.lastrowid

            inserted = 0
            for record in records:
                if not isinstance(record, dict):
                    continue
                try:
                    connection.execute(
                        """
                        INSERT OR IGNORE INTO ordens (
                            backup_id, source_collection, source_id, origem, tipo,
                            protocolo, ordem_servico, bairro, rua, numero,
                            ponto_referencia, observacoes, status, created_at,
                            updated_at, data_execucao, created_by_email, created_by_uid,
                            sla_horas, status_antes_sanear, sla_pausas_json,
                            fotos_json, pdf_start_page, pdf_page_count, raw_json
                        ) VALUES (
                            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                        )
                        """,
                        (
                            backup_id,
                            normalize(record.get("sourceCollection")),
                            normalize(record.get("sourceId")),
                            normalize(record.get("origem")),
                            normalize(record.get("tipo")),
                            normalize(record.get("protocolo")),
                            normalize(record.get("ordemServico")),
                            normalize(record.get("bairro")),
                            normalize(record.get("rua")),
                            normalize(record.get("numero")),
                            normalize(record.get("pontoReferencia")),
                            normalize(record.get("observacoes")),
                            normalize(record.get("status")),
                            record.get("createdAtIso"),
                            record.get("updatedAtIso"),
                            record.get("dataExecucaoIso"),
                            normalize(record.get("createdByEmail")),
                            normalize(record.get("createdByUid")),
                            record.get("slaHoras"),
                            normalize(record.get("statusAntesAguardandoSanear")),
                            json_text(record.get("slaPausas") or []),
                            json_text(record.get("photos") or []),
                            int(record.get("pdfStartPage") or 1),
                            int(record.get("pdfPageCount") or 1),
                            json.dumps(record, ensure_ascii=False),
                        ),
                    )
                    if connection.execute("SELECT changes()").fetchone()[0]:
                        inserted += 1
                except (sqlite3.Error, ValueError, TypeError):
                    continue

            connection.commit()
            return BackupImportResult(zip_path.name, True, inserted)
    except (zipfile.BadZipFile, json.JSONDecodeError, OSError, ValueError) as error:
        connection.rollback()
        return BackupImportResult(zip_path.name, False, 0, str(error))


class BackupViewer(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title(APP_TITLE)
        self.geometry("1220x760")
        self.minsize(980, 620)

        self.connection = sqlite3.connect(DB_PATH)
        self.connection.row_factory = sqlite3.Row
        ensure_database(self.connection)

        self.settings = load_settings()
        self.backup_folder = Path(self.settings.get("backup_folder", "")) if self.settings.get("backup_folder") else None
        self.selected_order_id: int | None = None

        self.search_var = tk.StringVar()
        self.type_var = tk.StringVar(value="TODOS")
        self.status_var = tk.StringVar(value="TODOS")
        self.folder_var = tk.StringVar(value=str(self.backup_folder or "Nenhuma pasta selecionada"))
        self.count_var = tk.StringVar(value="0 registros")

        self._configure_style()
        self._build_ui()
        self.refresh_results()

    def _configure_style(self) -> None:
        style = ttk.Style(self)
        if "vista" in style.theme_names():
            style.theme_use("vista")
        style.configure("Treeview", rowheight=28, font=("Segoe UI", 9))
        style.configure("Treeview.Heading", font=("Segoe UI", 9, "bold"))
        style.configure("Title.TLabel", font=("Segoe UI", 18, "bold"))
        style.configure("Subtitle.TLabel", font=("Segoe UI", 9), foreground="#64748b")
        style.configure("Primary.TButton", font=("Segoe UI", 9, "bold"))

    def _build_ui(self) -> None:
        main = ttk.Frame(self, padding=14)
        main.pack(fill=tk.BOTH, expand=True)

        header = ttk.Frame(main)
        header.pack(fill=tk.X)
        ttk.Label(header, text="Histórico Offline SANEAR", style="Title.TLabel").pack(anchor=tk.W)
        ttk.Label(
            header,
            text="Consulta os ZIPs oficiais sem depender do Firebase, Supabase ou internet.",
            style="Subtitle.TLabel",
        ).pack(anchor=tk.W, pady=(2, 10))

        folder_frame = ttk.LabelFrame(main, text="Pasta de backups", padding=10)
        folder_frame.pack(fill=tk.X, pady=(0, 10))
        ttk.Label(folder_frame, textvariable=self.folder_var).pack(side=tk.LEFT, fill=tk.X, expand=True)
        ttk.Button(folder_frame, text="Selecionar pasta", command=self.choose_folder).pack(side=tk.LEFT, padx=4)
        ttk.Button(folder_frame, text="Importar ZIP", command=self.choose_zip).pack(side=tk.LEFT, padx=4)
        ttk.Button(folder_frame, text="Importar pasta", command=self.import_folder).pack(side=tk.LEFT, padx=4)
        ttk.Button(folder_frame, text="Reconstruir banco", command=self.rebuild_database).pack(side=tk.LEFT, padx=4)

        filters = ttk.Frame(main)
        filters.pack(fill=tk.X, pady=(0, 10))
        ttk.Label(filters, text="Pesquisar:").pack(side=tk.LEFT)
        search = ttk.Entry(filters, textvariable=self.search_var, width=48)
        search.pack(side=tk.LEFT, padx=(6, 12))
        search.bind("<Return>", lambda _event: self.refresh_results())
        ttk.Label(filters, text="Tipo:").pack(side=tk.LEFT)
        ttk.Combobox(
            filters,
            textvariable=self.type_var,
            values=("TODOS", "CALÇAMENTO", "ASFALTO"),
            state="readonly",
            width=14,
        ).pack(side=tk.LEFT, padx=(6, 12))
        ttk.Label(filters, text="Status:").pack(side=tk.LEFT)
        ttk.Combobox(
            filters,
            textvariable=self.status_var,
            values=("TODOS", "CONCLUIDA", "CONCLUIDO"),
            state="readonly",
            width=13,
        ).pack(side=tk.LEFT, padx=(6, 12))
        ttk.Button(filters, text="Pesquisar", command=self.refresh_results, style="Primary.TButton").pack(side=tk.LEFT)
        ttk.Button(filters, text="Limpar", command=self.clear_filters).pack(side=tk.LEFT, padx=5)
        ttk.Label(filters, textvariable=self.count_var).pack(side=tk.RIGHT)

        content = ttk.Panedwindow(main, orient=tk.HORIZONTAL)
        content.pack(fill=tk.BOTH, expand=True)

        list_frame = ttk.Frame(content)
        detail_frame = ttk.LabelFrame(content, text="Detalhes da ordem", padding=8)
        content.add(list_frame, weight=3)
        content.add(detail_frame, weight=2)

        columns = ("tipo", "protocolo", "os", "bairro", "execucao", "operador", "backup")
        self.tree = ttk.Treeview(list_frame, columns=columns, show="headings")
        headings = {
            "tipo": "Tipo",
            "protocolo": "Protocolo",
            "os": "Ordem de Serviço",
            "bairro": "Bairro",
            "execucao": "Execução",
            "operador": "Operador",
            "backup": "Backup",
        }
        widths = {"tipo": 100, "protocolo": 120, "os": 125, "bairro": 140, "execucao": 130, "operador": 175, "backup": 190}
        for column in columns:
            self.tree.heading(column, text=headings[column])
            self.tree.column(column, width=widths[column], minwidth=80)
        scrollbar = ttk.Scrollbar(list_frame, orient=tk.VERTICAL, command=self.tree.yview)
        self.tree.configure(yscrollcommand=scrollbar.set)
        self.tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        self.tree.bind("<<TreeviewSelect>>", self.on_select)
        self.tree.bind("<Double-1>", lambda _event: self.open_order_pdf())

        self.details = tk.Text(
            detail_frame,
            wrap=tk.WORD,
            font=("Segoe UI", 9),
            background="#f8fafc",
            relief=tk.FLAT,
            padx=10,
            pady=10,
        )
        self.details.pack(fill=tk.BOTH, expand=True)
        self.details.configure(state=tk.DISABLED)

        action_frame = ttk.Frame(detail_frame)
        action_frame.pack(fill=tk.X, pady=(8, 0))
        ttk.Button(action_frame, text="Abrir páginas da OS", command=self.open_order_pdf).pack(side=tk.LEFT, padx=3)
        ttk.Button(action_frame, text="Abrir PDF completo", command=self.open_full_pdf).pack(side=tk.LEFT, padx=3)
        ttk.Button(action_frame, text="Extrair fotos", command=self.extract_photos).pack(side=tk.LEFT, padx=3)
        ttk.Button(action_frame, text="Gerar comprovante", command=self.generate_receipt).pack(side=tk.LEFT, padx=3)

        self.status_bar = ttk.Label(main, text="Pronto", relief=tk.SUNKEN, anchor=tk.W)
        self.status_bar.pack(fill=tk.X, pady=(10, 0))

    def set_status(self, text: str) -> None:
        self.status_bar.configure(text=text)
        self.update_idletasks()

    def choose_folder(self) -> None:
        selected = filedialog.askdirectory(title="Selecione a pasta onde os ZIPs são guardados")
        if not selected:
            return
        self.backup_folder = Path(selected)
        self.folder_var.set(str(self.backup_folder))
        self.settings["backup_folder"] = str(self.backup_folder)
        save_settings(self.settings)

    def choose_zip(self) -> None:
        initial = str(self.backup_folder) if self.backup_folder else str(Path.home())
        selected = filedialog.askopenfilename(
            title="Selecione um backup ZIP",
            initialdir=initial,
            filetypes=[("Backup ZIP", "*.zip")],
        )
        if selected:
            self.import_paths([Path(selected)])

    def import_folder(self) -> None:
        if not self.backup_folder:
            self.choose_folder()
        if not self.backup_folder:
            return
        paths = sorted(self.backup_folder.glob("*.zip"))
        if not paths:
            messagebox.showinfo(APP_TITLE, "Nenhum arquivo ZIP encontrado na pasta selecionada.")
            return
        self.import_paths(paths)

    def import_paths(self, paths: Iterable[Path]) -> None:
        imported = 0
        ignored = 0
        errors: list[str] = []
        for index, path in enumerate(paths, start=1):
            self.set_status(f"Importando {index}: {path.name}")
            result = import_backup(self.connection, path)
            if result.imported:
                imported += result.records
            elif "já importado" in result.reason:
                ignored += 1
            else:
                errors.append(f"{result.filename}: {result.reason}")
        self.refresh_results()
        summary = f"{imported} registro(s) novo(s). {ignored} backup(s) ignorado(s) por duplicidade."
        if errors:
            summary += "\n\nFalhas:\n" + "\n".join(errors[:10])
        messagebox.showinfo(APP_TITLE, summary)
        self.set_status("Importação finalizada")

    def rebuild_database(self) -> None:
        if not self.backup_folder:
            self.choose_folder()
        if not self.backup_folder:
            return
        if not messagebox.askyesno(
            APP_TITLE,
            "O banco SQLite atual será apagado e reconstruído com todos os ZIPs da pasta. Continuar?",
        ):
            return
        self.connection.close()
        for path in (DB_PATH, DB_PATH.with_suffix(".db-wal"), DB_PATH.with_suffix(".db-shm")):
            if path.exists():
                path.unlink()
        self.connection = sqlite3.connect(DB_PATH)
        self.connection.row_factory = sqlite3.Row
        ensure_database(self.connection)
        self.import_paths(sorted(self.backup_folder.glob("*.zip")))

    def clear_filters(self) -> None:
        self.search_var.set("")
        self.type_var.set("TODOS")
        self.status_var.set("TODOS")
        self.refresh_results()

    def refresh_results(self) -> None:
        query_text = self.search_var.get().strip()
        type_filter = self.type_var.get()
        status_filter = self.status_var.get()

        clauses: list[str] = []
        params: list[Any] = []
        if query_text:
            pattern = f"%{query_text}%"
            clauses.append(
                """(
                    o.protocolo LIKE ? OR o.ordem_servico LIKE ? OR o.bairro LIKE ? OR
                    o.rua LIKE ? OR o.numero LIKE ? OR o.ponto_referencia LIKE ? OR
                    o.observacoes LIKE ? OR o.created_by_email LIKE ? OR o.created_by_uid LIKE ? OR
                    o.tipo LIKE ? OR o.status LIKE ? OR o.data_execucao LIKE ? OR
                    b.filename LIKE ?
                )"""
            )
            params.extend([pattern] * 13)
        if type_filter == "CALÇAMENTO":
            clauses.append("o.origem = 'calcamento'")
        elif type_filter == "ASFALTO":
            clauses.append("o.origem = 'asfalto'")
        if status_filter != "TODOS":
            clauses.append("o.status = ?")
            params.append(status_filter)

        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        rows = self.connection.execute(
            f"""
            SELECT o.*, b.filename AS backup_filename, b.source_path AS backup_path
            FROM ordens o
            JOIN backups b ON b.id = o.backup_id
            {where}
            ORDER BY COALESCE(o.data_execucao, o.created_at) DESC, o.id DESC
            LIMIT 5000
            """,
            params,
        ).fetchall()

        for item in self.tree.get_children():
            self.tree.delete(item)
        for row in rows:
            self.tree.insert(
                "",
                tk.END,
                iid=str(row["id"]),
                values=(
                    "Asfalto" if row["origem"] == "asfalto" else "Calçamento",
                    row["protocolo"] or "-",
                    row["ordem_servico"] or "-",
                    row["bairro"] or "-",
                    human_datetime(row["data_execucao"]),
                    row["created_by_email"] or "-",
                    row["backup_filename"],
                ),
            )
        self.count_var.set(f"{len(rows)} registro(s)")
        self.selected_order_id = None
        self.show_details(None)

    def selected_row(self) -> sqlite3.Row | None:
        if self.selected_order_id is None:
            return None
        return self.connection.execute(
            """
            SELECT o.*, b.filename AS backup_filename, b.source_path AS backup_path,
                   b.content_hash, b.generated_at
            FROM ordens o JOIN backups b ON b.id = o.backup_id
            WHERE o.id = ?
            """,
            (self.selected_order_id,),
        ).fetchone()

    def on_select(self, _event: tk.Event[Any]) -> None:
        selection = self.tree.selection()
        if not selection:
            return
        self.selected_order_id = int(selection[0])
        self.show_details(self.selected_row())

    def show_details(self, row: sqlite3.Row | None) -> None:
        self.details.configure(state=tk.NORMAL)
        self.details.delete("1.0", tk.END)
        if row is not None:
            photos = json.loads(row["fotos_json"] or "[]")
            opening = sum(1 for item in photos if item.get("kind") == "abertura")
            execution = sum(1 for item in photos if item.get("kind") == "execucao")
            lines = [
                f"Tipo: {'Asfalto' if row['origem'] == 'asfalto' else 'Calçamento'}",
                f"Protocolo: {row['protocolo'] or 'Não informado'}",
                f"Ordem de Serviço: {row['ordem_servico'] or 'Não informada'}",
                f"Status: {row['status'] or 'Não informado'}",
                "",
                f"Endereço: {row['rua'] or 'Não informado'}, {row['numero'] or 'S/N'}",
                f"Bairro: {row['bairro'] or 'Não informado'}",
                f"Ponto de referência: {row['ponto_referencia'] or 'Não informado'}",
                "",
                f"Criada em: {human_datetime(row['created_at'])}",
                f"Executada em: {human_datetime(row['data_execucao'])}",
                f"Operador: {row['created_by_email'] or row['created_by_uid'] or 'Não informado'}",
                f"SLA: {row['sla_horas'] or 'Não informado'} horas úteis",
                "",
                f"Fotos de abertura: {opening}",
                f"Fotos de execução: {execution}",
                f"Páginas no PDF: {row['pdf_start_page']} a {row['pdf_start_page'] + row['pdf_page_count'] - 1}",
                "",
                "Observações:",
                row["observacoes"] or "Não informadas",
                "",
                f"Backup: {row['backup_filename']}",
                f"Hash: {row['content_hash']}",
            ]
            self.details.insert("1.0", "\n".join(lines))
        self.details.configure(state=tk.DISABLED)

    def require_selection(self) -> sqlite3.Row | None:
        row = self.selected_row()
        if row is None:
            messagebox.showwarning(APP_TITLE, "Selecione uma ordem na lista.")
        return row

    def zip_path_for_row(self, row: sqlite3.Row) -> Path:
        path = Path(row["backup_path"])
        if path.exists():
            return path
        if self.backup_folder:
            alternative = self.backup_folder / row["backup_filename"]
            if alternative.exists():
                return alternative
        raise FileNotFoundError(
            f"O ZIP {row['backup_filename']} não foi encontrado. Selecione a pasta correta de backups."
        )

    def extract_pdf_member(self, zip_path: Path, member: str, destination: Path) -> None:
        with zipfile.ZipFile(zip_path, "r") as archive:
            destination.write_bytes(archive.read(member))

    def open_full_pdf(self) -> None:
        row = self.require_selection()
        if row is None:
            return
        try:
            zip_path = self.zip_path_for_row(row)
            destination = Path(tempfile.gettempdir()) / f"SANEAR-{row['backup_id']}-completo.pdf"
            self.extract_pdf_member(zip_path, "relatorio/ordens-concluidas.pdf", destination)
            open_path(destination)
        except Exception as error:  # noqa: BLE001
            messagebox.showerror(APP_TITLE, str(error))

    def open_order_pdf(self) -> None:
        row = self.require_selection()
        if row is None:
            return
        if PdfReader is None or PdfWriter is None:
            messagebox.showerror(APP_TITLE, "Instale as dependências com: pip install -r requirements.txt")
            return
        try:
            zip_path = self.zip_path_for_row(row)
            with zipfile.ZipFile(zip_path, "r") as archive:
                source = io.BytesIO(archive.read("relatorio/ordens-concluidas.pdf"))
                reader = PdfReader(source)
                writer = PdfWriter()
                start = max(0, int(row["pdf_start_page"] or 1) - 1)
                count = max(1, int(row["pdf_page_count"] or 1))
                for page_index in range(start, min(start + count, len(reader.pages))):
                    writer.add_page(reader.pages[page_index])
                destination = Path(tempfile.gettempdir()) / f"SANEAR-OS-{row['id']}.pdf"
                with destination.open("wb") as output:
                    writer.write(output)
            open_path(destination)
        except Exception as error:  # noqa: BLE001
            messagebox.showerror(APP_TITLE, str(error))

    def extract_photos(self) -> None:
        row = self.require_selection()
        if row is None:
            return
        try:
            photos = json.loads(row["fotos_json"] or "[]")
            members = [item.get("zipPath") for item in photos if item.get("zipPath")]
            if not members:
                messagebox.showinfo(APP_TITLE, "Esta ordem não possui fotografias armazenadas no ZIP.")
                return
            zip_path = self.zip_path_for_row(row)
            destination = Path(tempfile.gettempdir()) / f"SANEAR-FOTOS-OS-{row['id']}"
            if destination.exists():
                shutil.rmtree(destination)
            destination.mkdir(parents=True)
            with zipfile.ZipFile(zip_path, "r") as archive:
                for member in members:
                    if member not in archive.namelist():
                        continue
                    target = destination / Path(member).name
                    target.write_bytes(archive.read(member))
            open_path(destination)
        except Exception as error:  # noqa: BLE001
            messagebox.showerror(APP_TITLE, str(error))

    def generate_receipt(self) -> None:
        row = self.require_selection()
        if row is None:
            return
        if PdfReader is None or PdfWriter is None or A4 is None:
            messagebox.showerror(APP_TITLE, "Instale as dependências com: pip install -r requirements.txt")
            return
        destination_name = f"Comprovante-{row['protocolo'] or row['ordem_servico'] or row['source_id']}.pdf"
        selected = filedialog.asksaveasfilename(
            title="Salvar comprovante individual",
            defaultextension=".pdf",
            initialfile=destination_name,
            filetypes=[("Arquivo PDF", "*.pdf")],
        )
        if not selected:
            return
        try:
            temp_summary = Path(tempfile.gettempdir()) / f"sanear-resumo-{row['id']}.pdf"
            styles = getSampleStyleSheet()
            story: list[Any] = [
                Paragraph("SANEAR - COMPROVANTE DE ORDEM DE SERVIÇO", styles["Title"]),
                Spacer(1, 5 * mm),
            ]
            data = [
                ["Tipo", "Asfalto" if row["origem"] == "asfalto" else "Calçamento"],
                ["Protocolo", row["protocolo"] or "Não informado"],
                ["Ordem de Serviço", row["ordem_servico"] or "Não informada"],
                ["Status", row["status"] or "Não informado"],
                ["Endereço", f"{row['rua'] or 'Não informado'}, {row['numero'] or 'S/N'}"],
                ["Bairro", row["bairro"] or "Não informado"],
                ["Ponto de referência", row["ponto_referencia"] or "Não informado"],
                ["Criada em", human_datetime(row["created_at"])],
                ["Executada em", human_datetime(row["data_execucao"])],
                ["Operador", row["created_by_email"] or row["created_by_uid"] or "Não informado"],
                ["Backup de origem", row["backup_filename"]],
                ["Hash", row["content_hash"]],
            ]
            table = Table(data, colWidths=[45 * mm, 135 * mm])
            table.setStyle(
                TableStyle(
                    [
                        ("BACKGROUND", (0, 0), (0, -1), colors.HexColor("#eaf2fb")),
                        ("TEXTCOLOR", (0, 0), (-1, -1), colors.HexColor("#172033")),
                        ("FONTNAME", (0, 0), (0, -1), "Helvetica-Bold"),
                        ("FONTNAME", (1, 0), (1, -1), "Helvetica"),
                        ("FONTSIZE", (0, 0), (-1, -1), 9),
                        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#cbd5e1")),
                        ("VALIGN", (0, 0), (-1, -1), "TOP"),
                        ("LEFTPADDING", (0, 0), (-1, -1), 6),
                        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                        ("TOPPADDING", (0, 0), (-1, -1), 5),
                        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
                    ]
                )
            )
            story.extend([
                table,
                Spacer(1, 5 * mm),
                Paragraph("Observações", styles["Heading3"]),
                Paragraph(html.escape(row["observacoes"] or "Não informadas"), styles["BodyText"]),
            ])
            document = SimpleDocTemplate(str(temp_summary), pagesize=A4, rightMargin=15 * mm, leftMargin=15 * mm, topMargin=15 * mm, bottomMargin=15 * mm)
            document.build(story)

            zip_path = self.zip_path_for_row(row)
            writer = PdfWriter()
            summary_reader = PdfReader(str(temp_summary))
            for page in summary_reader.pages:
                writer.add_page(page)
            with zipfile.ZipFile(zip_path, "r") as archive:
                source_reader = PdfReader(
                    io.BytesIO(archive.read("relatorio/ordens-concluidas.pdf"))
                )
                start = max(0, int(row["pdf_start_page"] or 1) - 1)
                count = max(1, int(row["pdf_page_count"] or 1))
                for page_index in range(start, min(start + count, len(source_reader.pages))):
                    writer.add_page(source_reader.pages[page_index])
            with Path(selected).open("wb") as output:
                writer.write(output)
            open_path(Path(selected))
        except Exception as error:  # noqa: BLE001
            messagebox.showerror(APP_TITLE, str(error))

    def destroy(self) -> None:
        self.connection.close()
        super().destroy()


if __name__ == "__main__":
    BackupViewer().mainloop()
