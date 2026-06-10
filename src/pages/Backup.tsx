import React, { useEffect, useMemo, useState } from "react";
import JSZip from "jszip";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  Timestamp,
  writeBatch,
} from "firebase/firestore";
import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";
import { auth, db } from "../lib/firebaseClient";
import { supabase } from "../lib/supabaseClient";
import "./Backup.css";

const STORAGE_BUCKET = "os-arquivos";
const BACKUP_SCHEMA_VERSION = 1;

type CollectionName = "ordens_servico" | "ordensServico";
type Origem = "calcamento" | "asfalto";
type TipoFiltro = "TODOS" | "CALCAMENTO" | "ASFALTO";

type PhotoKind = "abertura" | "execucao";

type PhotoReference = {
  id: string;
  kind: PhotoKind;
  name: string;
  url: string;
  attachedAt: string | null;
  storagePath: string | null;
};

type CloudOrder = {
  sourceCollection: CollectionName;
  sourceId: string;
  origem: Origem;
  raw: Record<string, unknown>;
  status: string;
  tipo: string;
  protocolo: string | null;
  ordemServico: string | null;
  bairro: string | null;
  rua: string | null;
  numero: string | null;
  pontoReferencia: string | null;
  observacoes: string | null;
  createdAtIso: string | null;
  updatedAtIso: string | null;
  dataExecucaoIso: string | null;
  dataReferenciaIso: string | null;
  createdByEmail: string | null;
  createdByUid: string | null;
  slaHoras: number | null;
  slaPausas: unknown[];
  statusAntesAguardandoSanear: string | null;
  photos: PhotoReference[];
};

type PhotoAsset = PhotoReference & {
  zipPath: string;
  bytes: ArrayBuffer | null;
  mimeType: string | null;
  downloadError: string | null;
};

type BackupOrder = Omit<CloudOrder, "raw" | "photos"> & {
  raw: unknown;
  photos: Array<Omit<PhotoAsset, "bytes">>;
  pdfStartPage: number;
  pdfPageCount: number;
};

type BackupManifest = {
  schemaVersion: number;
  system: string;
  generatedAt: string;
  contentHash: string;
  recordCount: number;
  photoCount: number;
  sourceCollections: CollectionName[];
  filter: {
    startDate: string | null;
    endDate: string | null;
    type: TipoFiltro;
  };
  files: {
    json: string;
    csv: string;
    pdf: string;
    photosFolder: string;
  };
};

type BackupResult = {
  filename: string;
  manifest: BackupManifest;
  orders: BackupOrder[];
  sizeBytes: number;
};

type DeletionResult = {
  deletedDocuments: number;
  skippedDocuments: number;
  deletedFiles: number;
  failedFiles: number;
};

function normalizeStatus(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

function isFinalStatus(value: unknown): boolean {
  const status = normalizeStatus(value);
  return status === "CONCLUIDA" || status === "CONCLUIDO";
}

function stringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function timestampToIso(value: unknown): string | null {
  try {
    if (value instanceof Timestamp) return value.toDate().toISOString();
    if (
      value &&
      typeof value === "object" &&
      "seconds" in value &&
      typeof (value as { seconds?: unknown }).seconds === "number"
    ) {
      const timestampLike = value as {
        seconds: number;
        nanoseconds?: number;
      };
      const seconds = timestampLike.seconds;
      const nanoseconds =
        typeof timestampLike.nanoseconds === "number"
          ? timestampLike.nanoseconds
          : 0;
      return new Date(seconds * 1000 + nanoseconds / 1_000_000).toISOString();
    }
    if (typeof value === "string" || typeof value === "number") {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }
  } catch {
    return null;
  }
  return null;
}

function serializeFirestore(value: unknown): unknown {
  if (value instanceof Timestamp) {
    return {
      __type: "timestamp",
      iso: value.toDate().toISOString(),
      seconds: value.seconds,
      nanoseconds: value.nanoseconds,
    };
  }

  if (Array.isArray(value)) return value.map(serializeFirestore);

  if (value && typeof value === "object") {
    const candidate = value as Record<string, unknown>;
    if (
      typeof candidate.seconds === "number" &&
      typeof candidate.nanoseconds === "number"
    ) {
      const date = new Date(
        candidate.seconds * 1000 + candidate.nanoseconds / 1_000_000
      );
      return {
        __type: "timestamp",
        iso: date.toISOString(),
        seconds: candidate.seconds,
        nanoseconds: candidate.nanoseconds,
      };
    }

    return Object.fromEntries(
      Object.entries(candidate).map(([key, item]) => [
        key,
        serializeFirestore(item),
      ])
    );
  }

  return value ?? null;
}

function sanitizeFileName(value: string): string {
  const cleaned = value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return cleaned || "arquivo";
}

function extractStoragePath(url: string): string | null {
  try {
    const decoded = decodeURIComponent(url);
    const publicMarker = `/storage/v1/object/public/${STORAGE_BUCKET}/`;
    const signedMarker = `/storage/v1/object/sign/${STORAGE_BUCKET}/`;
    const marker = decoded.includes(publicMarker) ? publicMarker : signedMarker;
    const index = decoded.indexOf(marker);
    if (index < 0) return null;
    return decoded.slice(index + marker.length).split("?")[0] || null;
  } catch {
    return null;
  }
}

function normalizePhotos(raw: unknown, kind: PhotoKind): PhotoReference[] {
  if (!Array.isArray(raw)) return [];

  return raw
    .map((item, index): PhotoReference | null => {
      if (typeof item === "string") {
        const url = item.trim();
        if (!url) return null;
        return {
          id: `${kind}-${index + 1}`,
          kind,
          name: `foto-${kind}-${index + 1}.jpg`,
          url,
          attachedAt: null,
          storagePath: extractStoragePath(url),
        };
      }

      if (!item || typeof item !== "object") return null;
      const data = item as Record<string, unknown>;
      const url = stringOrNull(data.url ?? data.publicUrl ?? data.downloadURL);
      if (!url) return null;

      return {
        id: stringOrNull(data.id) ?? `${kind}-${index + 1}`,
        kind,
        name:
          stringOrNull(data.nomeArquivo ?? data.name ?? data.nome) ??
          `foto-${kind}-${index + 1}.jpg`,
        url,
        attachedAt: stringOrNull(
          data.dataAnexoTexto ?? data.createdAt ?? data.timestamp
        ),
        storagePath: extractStoragePath(url),
      };
    })
    .filter((item): item is PhotoReference => item !== null);
}

function mapDocument(
  sourceCollection: CollectionName,
  sourceId: string,
  raw: Record<string, unknown>
): CloudOrder | null {
  if (!isFinalStatus(raw.status)) return null;

  const origem: Origem =
    sourceCollection === "ordensServico" ? "asfalto" : "calcamento";
  const createdAtIso = timestampToIso(raw.createdAt);
  const updatedAtIso = timestampToIso(raw.updatedAt);
  const dataExecucaoIso = timestampToIso(raw.dataExecucao);

  return {
    sourceCollection,
    sourceId,
    origem,
    raw,
    status: normalizeStatus(raw.status),
    tipo:
      stringOrNull(raw.tipo) ??
      (origem === "asfalto" ? "ASFALTO" : "BURACO_RUA"),
    protocolo: stringOrNull(raw.protocolo),
    ordemServico: stringOrNull(raw.ordemServico),
    bairro: stringOrNull(raw.bairro),
    rua: stringOrNull(raw.rua),
    numero: stringOrNull(raw.numero),
    pontoReferencia: stringOrNull(raw.pontoReferencia ?? raw.referencia),
    observacoes: stringOrNull(raw.observacoes),
    createdAtIso,
    updatedAtIso,
    dataExecucaoIso,
    dataReferenciaIso: dataExecucaoIso ?? updatedAtIso ?? createdAtIso,
    createdByEmail: stringOrNull(raw.createdByEmail),
    createdByUid: stringOrNull(raw.createdByUid),
    slaHoras: numberOrNull(raw.slaHoras),
    slaPausas: Array.isArray(raw.slaPausas) ? raw.slaPausas : [],
    statusAntesAguardandoSanear: stringOrNull(
      raw.statusAntesAguardandoSanear
    ),
    photos: [
      ...normalizePhotos(raw.fotos ?? raw.fotosAbertura, "abertura"),
      ...normalizePhotos(raw.fotosExecucao, "execucao"),
    ],
  };
}

function dateInputToBoundary(
  value: string,
  boundary: "start" | "end"
): number | null {
  if (!value) return null;
  const suffix = boundary === "start" ? "T00:00:00" : "T23:59:59.999";
  const date = new Date(`${value}${suffix}`);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

function formatDateTime(value: string | null): string {
  if (!value) return "Não informado";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

function csvEscape(value: unknown): string {
  const text = String(value ?? "").replace(/\r?\n/g, " ");
  return `"${text.replace(/"/g, '""')}"`;
}

function buildCsv(orders: BackupOrder[]): string {
  const headers = [
    "colecao",
    "id",
    "origem",
    "tipo",
    "protocolo",
    "ordem_servico",
    "bairro",
    "rua",
    "numero",
    "ponto_referencia",
    "observacoes",
    "status",
    "data_criacao",
    "data_atualizacao",
    "data_execucao",
    "operador_email",
    "operador_uid",
    "sla_horas",
    "quantidade_fotos_abertura",
    "quantidade_fotos_execucao",
    "backup_pdf_pagina_inicial",
    "backup_pdf_quantidade_paginas",
  ];

  const rows = orders.map((order) => [
    order.sourceCollection,
    order.sourceId,
    order.origem,
    order.tipo,
    order.protocolo,
    order.ordemServico,
    order.bairro,
    order.rua,
    order.numero,
    order.pontoReferencia,
    order.observacoes,
    order.status,
    order.createdAtIso,
    order.updatedAtIso,
    order.dataExecucaoIso,
    order.createdByEmail,
    order.createdByUid,
    order.slaHoras,
    order.photos.filter((photo) => photo.kind === "abertura").length,
    order.photos.filter((photo) => photo.kind === "execucao").length,
    order.pdfStartPage,
    order.pdfPageCount,
  ]);

  return `\uFEFF${[headers, ...rows]
    .map((row) => row.map(csvEscape).join(";"))
    .join("\r\n")}`;
}

async function sha256Hex(value: string | ArrayBuffer): Promise<string> {
  const bytes =
    typeof value === "string" ? new TextEncoder().encode(value) : value;
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash))
    .map((item) => item.toString(16).padStart(2, "0"))
    .join("");
}

function safePdfText(value: unknown): string {
  return String(value ?? "Não informado")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'");
}

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number) {
  const words = safePdfText(text).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) <= maxWidth) {
      current = next;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function drawWrappedText(
  page: ReturnType<PDFDocument["addPage"]>,
  text: string,
  options: {
    x: number;
    y: number;
    maxWidth: number;
    font: PDFFont;
    size: number;
    lineHeight: number;
    color?: ReturnType<typeof rgb>;
  }
): number {
  const lines = wrapText(text, options.font, options.size, options.maxWidth);
  let y = options.y;
  for (const line of lines) {
    page.drawText(line, {
      x: options.x,
      y,
      size: options.size,
      font: options.font,
      color: options.color ?? rgb(0.12, 0.15, 0.2),
    });
    y -= options.lineHeight;
  }
  return y;
}

async function embedPhoto(
  pdf: PDFDocument,
  asset: PhotoAsset
): Promise<Awaited<ReturnType<PDFDocument["embedJpg"]>> | null> {
  if (!asset.bytes) return null;
  try {
    const mime = asset.mimeType?.toLowerCase() ?? "";
    if (mime.includes("png") || asset.name.toLowerCase().endsWith(".png")) {
      return await pdf.embedPng(asset.bytes);
    }
    if (
      mime.includes("jpeg") ||
      mime.includes("jpg") ||
      /\.(jpe?g)$/i.test(asset.name)
    ) {
      return await pdf.embedJpg(asset.bytes);
    }
  } catch {
    return null;
  }
  return null;
}

async function buildPdf(
  orders: CloudOrder[],
  assetsByOrder: Map<string, PhotoAsset[]>
): Promise<{ bytes: Uint8Array; orders: BackupOrder[] }> {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pageSize: [number, number] = [595.28, 841.89];
  const backupOrders: BackupOrder[] = [];

  for (const order of orders) {
    const pageStart = pdf.getPageCount() + 1;
    const page = pdf.addPage(pageSize);
    const { width, height } = page.getSize();
    const margin = 42;

    page.drawRectangle({
      x: 0,
      y: height - 82,
      width,
      height: 82,
      color: rgb(0.04, 0.16, 0.31),
    });
    page.drawText("SANEAR - HISTORICO OPERACIONAL", {
      x: margin,
      y: height - 36,
      font: bold,
      size: 16,
      color: rgb(1, 1, 1),
    });
    page.drawText(
      order.origem === "asfalto" ? "ORDEM DE SERVICO - ASFALTO" : "ORDEM DE SERVICO - CALCAMENTO",
      {
        x: margin,
        y: height - 60,
        font: regular,
        size: 11,
        color: rgb(0.86, 0.92, 1),
      }
    );

    let y = height - 112;
    const labelWidth = 136;
    const contentX = margin + labelWidth;
    const contentWidth = width - margin - contentX;

    const rows: Array<[string, string]> = [
      ["Identificador", `${order.sourceCollection}/${order.sourceId}`],
      ["Protocolo", order.protocolo ?? "Não informado"],
      ["Ordem de Serviço", order.ordemServico ?? "Não informada"],
      ["Status", "CONCLUÍDA"],
      ["Tipo", order.tipo],
      ["Endereço", `${order.rua ?? "Não informada"}, ${order.numero ?? "S/N"}`],
      ["Bairro", order.bairro ?? "Não informado"],
      ["Ponto de referência", order.pontoReferencia ?? "Não informado"],
      ["Criada em", formatDateTime(order.createdAtIso)],
      ["Executada em", formatDateTime(order.dataExecucaoIso)],
      ["Operador", order.createdByEmail ?? order.createdByUid ?? "Não informado"],
      ["Prazo SLA", order.slaHoras ? `${order.slaHoras} horas úteis` : "Não informado"],
    ];

    for (const [label, value] of rows) {
      page.drawText(safePdfText(label), {
        x: margin,
        y,
        font: bold,
        size: 9,
        color: rgb(0.18, 0.25, 0.36),
      });
      y = drawWrappedText(page, value, {
        x: contentX,
        y,
        maxWidth: contentWidth,
        font: regular,
        size: 9,
        lineHeight: 12,
      });
      y -= 6;
    }

    page.drawText("Observações", {
      x: margin,
      y,
      font: bold,
      size: 9,
      color: rgb(0.18, 0.25, 0.36),
    });
    y -= 15;
    y = drawWrappedText(page, order.observacoes ?? "Não informadas", {
      x: margin,
      y,
      maxWidth: width - margin * 2,
      font: regular,
      size: 9,
      lineHeight: 12,
    });

    const assets = assetsByOrder.get(`${order.sourceCollection}/${order.sourceId}`) ?? [];
    const openingCount = assets.filter((asset) => asset.kind === "abertura").length;
    const executionCount = assets.filter((asset) => asset.kind === "execucao").length;

    y -= 18;
    page.drawRectangle({
      x: margin,
      y: Math.max(68, y - 52),
      width: width - margin * 2,
      height: 52,
      borderColor: rgb(0.78, 0.82, 0.88),
      borderWidth: 1,
      color: rgb(0.96, 0.97, 0.99),
    });
    page.drawText(`Fotos de abertura: ${openingCount}`, {
      x: margin + 14,
      y: Math.max(90, y - 21),
      font: bold,
      size: 10,
      color: rgb(0.1, 0.3, 0.55),
    });
    page.drawText(`Fotos de execução: ${executionCount}`, {
      x: margin + 210,
      y: Math.max(90, y - 21),
      font: bold,
      size: 10,
      color: rgb(0.08, 0.45, 0.25),
    });

    page.drawText(
      `Documento gerado no backup. Página ${pageStart}.`,
      {
        x: margin,
        y: 28,
        font: regular,
        size: 8,
        color: rgb(0.4, 0.45, 0.52),
      }
    );

    for (const asset of assets) {
      const photoPage = pdf.addPage(pageSize);
      photoPage.drawText(
        asset.kind === "abertura"
          ? "EVIDÊNCIA FOTOGRÁFICA - ABERTURA"
          : "EVIDÊNCIA FOTOGRÁFICA - EXECUÇÃO",
        {
          x: margin,
          y: height - 45,
          font: bold,
          size: 14,
          color:
            asset.kind === "abertura"
              ? rgb(0.1, 0.3, 0.55)
              : rgb(0.08, 0.45, 0.25),
        }
      );
      photoPage.drawText(
        safePdfText(
          `${order.protocolo ?? order.ordemServico ?? order.sourceId} - ${asset.name}`
        ),
        {
          x: margin,
          y: height - 67,
          font: regular,
          size: 9,
          color: rgb(0.28, 0.33, 0.4),
        }
      );

      const embedded = await embedPhoto(pdf, asset);
      if (embedded) {
        const maxWidth = width - margin * 2;
        const maxHeight = height - 160;
        const scale = Math.min(maxWidth / embedded.width, maxHeight / embedded.height);
        const imageWidth = embedded.width * scale;
        const imageHeight = embedded.height * scale;
        photoPage.drawImage(embedded, {
          x: (width - imageWidth) / 2,
          y: 62 + (maxHeight - imageHeight) / 2,
          width: imageWidth,
          height: imageHeight,
        });
      } else {
        photoPage.drawRectangle({
          x: margin,
          y: 180,
          width: width - margin * 2,
          height: 420,
          borderColor: rgb(0.75, 0.78, 0.84),
          borderWidth: 1,
          color: rgb(0.97, 0.97, 0.98),
        });
        drawWrappedText(
          photoPage,
          asset.downloadError
            ? `A fotografia não pôde ser baixada: ${asset.downloadError}`
            : "O formato desta fotografia não pôde ser incorporado ao PDF. O arquivo original permanece dentro da pasta fotos do ZIP.",
          {
            x: margin + 24,
            y: 410,
            maxWidth: width - margin * 2 - 48,
            font: regular,
            size: 11,
            lineHeight: 16,
            color: rgb(0.45, 0.25, 0.2),
          }
        );
      }

      photoPage.drawText(
        safePdfText(`Anexada em: ${asset.attachedAt ?? "Não informado"}`),
        {
          x: margin,
          y: 36,
          font: regular,
          size: 8,
          color: rgb(0.4, 0.45, 0.52),
        }
      );
    }

    const pageCount = pdf.getPageCount() - pageStart + 1;
    backupOrders.push({
      ...order,
      raw: serializeFirestore(order.raw),
      photos: assets.map(({ bytes: _bytes, ...asset }) => asset),
      pdfStartPage: pageStart,
      pdfPageCount: pageCount,
    });
  }

  return { bytes: await pdf.save(), orders: backupOrders };
}

async function saveBlob(filename: string, blob: Blob): Promise<void> {
  const picker = (window as unknown as {
    showSaveFilePicker?: (options: unknown) => Promise<{
      createWritable: () => Promise<{
        write: (data: Blob) => Promise<void>;
        close: () => Promise<void>;
      }>;
    }>;
  }).showSaveFilePicker;

  if (picker) {
    const handle = await picker({
      suggestedName: filename,
      types: [
        {
          description: "Backup ZIP do SANEAR",
          accept: { "application/zip": [".zip"] },
        },
      ],
    });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return;
  }

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

const Backup: React.FC = () => {
  const today = new Date();
  const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);
  const toInput = (date: Date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  };

  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [startDate, setStartDate] = useState(toInput(firstDay));
  const [endDate, setEndDate] = useState(toInput(today));
  const [typeFilter, setTypeFilter] = useState<TipoFiltro>("TODOS");
  const [orders, setOrders] = useState<CloudOrder[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressText, setProgressText] = useState("");
  const [message, setMessage] = useState<{
    type: "success" | "error" | "info";
    text: string;
  } | null>(null);
  const [backupResult, setBackupResult] = useState<BackupResult | null>(null);
  const [showReviewModal, setShowReviewModal] = useState(false);
  const [reviewSearch, setReviewSearch] = useState("");
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [deletionResult, setDeletionResult] = useState<DeletionResult | null>(
    null
  );

  useEffect(() => {
    let active = true;

    async function verifyRole() {
      try {
        const user = auth.currentUser;
        if (!user) {
          if (active) setAuthorized(false);
          return;
        }
        const profile = await getDoc(doc(db, "usuarios_sistema", user.uid));
        const role = String(profile.data()?.role ?? "").toLowerCase();
        if (active) setAuthorized(role === "adm");
      } catch (error) {
        console.error(error);
        if (active) setAuthorized(false);
      }
    }

    void verifyRole();
    return () => {
      active = false;
    };
  }, []);

  const photoCount = useMemo(
    () => orders.reduce((total, order) => total + order.photos.length, 0),
    [orders]
  );

  const calcamentoCount = useMemo(
    () => orders.filter((order) => order.origem === "calcamento").length,
    [orders]
  );

  const asfaltoCount = orders.length - calcamentoCount;

  const reviewedOrders = useMemo(() => {
    const term = reviewSearch.trim().toLocaleLowerCase("pt-BR");
    if (!term) return orders;

    return orders.filter((order) =>
      [
        order.origem === "asfalto" ? "asfalto" : "calçamento",
        order.protocolo,
        order.ordemServico,
        order.bairro,
        order.rua,
        order.numero,
        order.pontoReferencia,
        order.createdByEmail,
        formatDateTime(order.dataExecucaoIso),
      ]
        .filter(Boolean)
        .some((value) =>
          String(value).toLocaleLowerCase("pt-BR").includes(term)
        )
    );
  }, [orders, reviewSearch]);

  async function analyze() {
    setAnalyzing(true);
    setMessage(null);
    setBackupResult(null);
    setDeletionResult(null);

    try {
      const startMs = dateInputToBoundary(startDate, "start");
      const endMs = dateInputToBoundary(endDate, "end");
      if (startMs !== null && endMs !== null && startMs > endMs) {
        throw new Error("A data inicial não pode ser maior que a data final.");
      }

      const [calcamentoSnapshot, asfaltoSnapshot] = await Promise.all([
        getDocs(collection(db, "ordens_servico")),
        getDocs(collection(db, "ordensServico")),
      ]);

      const all: CloudOrder[] = [
        ...calcamentoSnapshot.docs
          .map((item) =>
            mapDocument("ordens_servico", item.id, item.data())
          )
          .filter((item): item is CloudOrder => item !== null),
        ...asfaltoSnapshot.docs
          .map((item) => mapDocument("ordensServico", item.id, item.data()))
          .filter((item): item is CloudOrder => item !== null),
      ];

      const filtered = all
        .filter((order) => {
          if (typeFilter === "CALCAMENTO" && order.origem !== "calcamento") {
            return false;
          }
          if (typeFilter === "ASFALTO" && order.origem !== "asfalto") {
            return false;
          }

          if (!order.dataReferenciaIso) return startMs === null && endMs === null;
          const referenceMs = new Date(order.dataReferenciaIso).getTime();
          if (Number.isNaN(referenceMs)) return false;
          if (startMs !== null && referenceMs < startMs) return false;
          if (endMs !== null && referenceMs > endMs) return false;
          return true;
        })
        .sort((a, b) =>
          String(a.dataReferenciaIso ?? "").localeCompare(
            String(b.dataReferenciaIso ?? "")
          )
        );

      setOrders(filtered);
      setMessage({
        type: filtered.length > 0 ? "success" : "info",
        text:
          filtered.length > 0
            ? `${filtered.length} ordem(ns) concluída(s) pronta(s) para backup.`
            : "Nenhuma ordem concluída foi encontrada para o período e tipo selecionados.",
      });
    } catch (error) {
      console.error(error);
      setOrders([]);
      setMessage({
        type: "error",
        text:
          error instanceof Error
            ? error.message
            : "Não foi possível analisar as ordens concluídas.",
      });
    } finally {
      setAnalyzing(false);
    }
  }

  async function downloadPhoto(
    order: CloudOrder,
    photo: PhotoReference,
    index: number
  ): Promise<PhotoAsset> {
    const orderFolder = `${order.origem}/${sanitizeFileName(
      order.protocolo ?? order.ordemServico ?? order.sourceId
    )}-${sanitizeFileName(order.sourceId)}`;
    const requestedName = sanitizeFileName(photo.name);
    const zipPath = `fotos/${orderFolder}/${photo.kind}/${String(index + 1).padStart(
      3,
      "0"
    )}-${requestedName}`;

    try {
      const response = await fetch(photo.url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return {
        ...photo,
        zipPath,
        bytes: await response.arrayBuffer(),
        mimeType: response.headers.get("content-type"),
        downloadError: null,
      };
    } catch (error) {
      return {
        ...photo,
        zipPath,
        bytes: null,
        mimeType: null,
        downloadError:
          error instanceof Error ? error.message : "Falha ao baixar o arquivo",
      };
    }
  }

  async function generateBackup() {
    if (orders.length === 0) {
      setMessage({
        type: "error",
        text: "Analise e selecione pelo menos uma ordem concluída antes de gerar o backup.",
      });
      return;
    }

    setShowReviewModal(false);
    setGenerating(true);
    setProgress(0);
    setProgressText("Preparando o backup...");
    setMessage(null);
    setBackupResult(null);
    setDeletionResult(null);

    try {
      const zip = new JSZip();
      const assetsByOrder = new Map<string, PhotoAsset[]>();
      const totalPhotos = Math.max(photoCount, 1);
      let processedPhotos = 0;

      for (const order of orders) {
        const assets: PhotoAsset[] = [];
        for (let index = 0; index < order.photos.length; index += 1) {
          const photo = order.photos[index];
          setProgressText(
            `Baixando fotografias (${processedPhotos + 1}/${photoCount})...`
          );
          const asset = await downloadPhoto(order, photo, index);
          assets.push(asset);
          if (asset.bytes) zip.file(asset.zipPath, asset.bytes);
          processedPhotos += 1;
          setProgress(Math.round((processedPhotos / totalPhotos) * 45));
        }
        assetsByOrder.set(`${order.sourceCollection}/${order.sourceId}`, assets);
      }

      setProgressText("Gerando relatório PDF...");
      setProgress(52);
      const pdfResult = await buildPdf(orders, assetsByOrder);
      zip.file("relatorio/ordens-concluidas.pdf", pdfResult.bytes);

      const contentHashPayload = JSON.stringify({
        schemaVersion: BACKUP_SCHEMA_VERSION,
        records: pdfResult.orders,
      });
      const contentHash = await sha256Hex(contentHashPayload);
      const generatedAt = new Date().toISOString();
      const manifest: BackupManifest = {
        schemaVersion: BACKUP_SCHEMA_VERSION,
        system: "SANEAR OPERACIONAL",
        generatedAt,
        contentHash,
        recordCount: pdfResult.orders.length,
        photoCount: pdfResult.orders.reduce(
          (total, order) => total + order.photos.length,
          0
        ),
        sourceCollections: ["ordens_servico", "ordensServico"],
        filter: {
          startDate: startDate || null,
          endDate: endDate || null,
          type: typeFilter,
        },
        files: {
          json: "dados/ordens.json",
          csv: "dados/ordens.csv",
          pdf: "relatorio/ordens-concluidas.pdf",
          photosFolder: "fotos/",
        },
      };

      const jsonPayload = {
        manifest,
        records: pdfResult.orders,
      };

      zip.file("manifest.json", JSON.stringify(manifest, null, 2));
      zip.file("dados/ordens.json", JSON.stringify(jsonPayload, null, 2));
      zip.file("dados/ordens.csv", buildCsv(pdfResult.orders));
      zip.file(
        "LEIA-ME.txt",
        [
          "BACKUP OFICIAL - SANEAR OPERACIONAL",
          "",
          `Gerado em: ${formatDateTime(generatedAt)}`,
          `Hash do conteúdo: ${contentHash}`,
          `Ordens concluídas: ${manifest.recordCount}`,
          `Fotografias: ${manifest.photoCount}`,
          "",
          "Conteúdo:",
          "- dados/ordens.json: todos os dados estruturados e metadados.",
          "- dados/ordens.csv: planilha compatível com Excel.",
          "- relatorio/ordens-concluidas.pdf: relatório para conferência e impressão.",
          "- fotos/: arquivos originais de abertura e execução, quando disponíveis.",
          "",
          "Este ZIP permite reconstruir o banco histórico local.",
          "Não altere os arquivos internos do backup oficial.",
        ].join("\r\n")
      );

      setProgressText("Compactando os arquivos...");
      setProgress(65);
      const blob = await zip.generateAsync(
        {
          type: "blob",
          compression: "DEFLATE",
          compressionOptions: { level: 6 },
          mimeType: "application/zip",
        },
        (metadata) => {
          setProgress(65 + Math.round(metadata.percent * 0.3));
          setProgressText(`Compactando: ${Math.round(metadata.percent)}%`);
        }
      );

      const stamp = generatedAt.replace(/[-:]/g, "").slice(0, 15);
      const filename = `SANEAR-BACKUP-${stamp}-${contentHash.slice(0, 12)}.zip`;

      setProgressText("Escolha onde salvar o arquivo ZIP...");
      setProgress(97);
      await saveBlob(filename, blob);

      setProgress(100);
      setProgressText("Backup salvo com sucesso.");
      setBackupResult({
        filename,
        manifest,
        orders: pdfResult.orders,
        sizeBytes: blob.size,
      });
      setMessage({
        type: "success",
        text:
          "O ZIP foi gerado e salvo. Confira o arquivo antes de solicitar a exclusão da nuvem.",
      });
    } catch (error) {
      console.error(error);
      setMessage({
        type: "error",
        text:
          error instanceof Error
            ? `Não foi possível gerar o backup: ${error.message}`
            : "Não foi possível gerar o backup.",
      });
    } finally {
      setGenerating(false);
    }
  }

  async function deleteFromCloud() {
    if (!backupResult || deleteConfirmation.trim().toUpperCase() !== "APAGAR") {
      return;
    }

    setDeleting(true);
    setMessage(null);
    setDeletionResult(null);
    setProgress(0);
    setProgressText("Validando os registros antes da exclusão...");

    try {
      const user = auth.currentUser;
      if (!user) throw new Error("Sessão não encontrada. Entre novamente.");
      const profile = await getDoc(doc(db, "usuarios_sistema", user.uid));
      if (String(profile.data()?.role ?? "").toLowerCase() !== "adm") {
        throw new Error("Somente um administrador pode apagar o backup da nuvem.");
      }

      const eligible: BackupOrder[] = [];
      let skippedDocuments = 0;

      for (let index = 0; index < backupResult.orders.length; index += 1) {
        const order = backupResult.orders[index];
        const current = await getDoc(
          doc(db, order.sourceCollection, order.sourceId)
        );

        if (!current.exists() || !isFinalStatus(current.data().status)) {
          skippedDocuments += 1;
          continue;
        }

        const currentUpdatedAt = timestampToIso(current.data().updatedAt);
        if (currentUpdatedAt !== order.updatedAtIso) {
          skippedDocuments += 1;
          continue;
        }

        eligible.push(order);
        setProgress(
          Math.round(((index + 1) / backupResult.orders.length) * 25)
        );
      }

      let deletedDocuments = 0;
      for (let index = 0; index < eligible.length; index += 400) {
        const chunk = eligible.slice(index, index + 400);
        const batch = writeBatch(db);
        chunk.forEach((order) => {
          batch.delete(doc(db, order.sourceCollection, order.sourceId));
        });
        await batch.commit();
        deletedDocuments += chunk.length;
        setProgress(
          25 + Math.round((deletedDocuments / Math.max(eligible.length, 1)) * 40)
        );
        setProgressText(
          `Excluindo documentos do Firestore (${deletedDocuments}/${eligible.length})...`
        );
      }

      const storagePaths = Array.from(
        new Set(
          eligible.flatMap((order) =>
            order.photos
              .map((photo) => photo.storagePath)
              .filter((path): path is string => Boolean(path))
          )
        )
      );

      let deletedFiles = 0;
      let failedFiles = 0;
      for (let index = 0; index < storagePaths.length; index += 50) {
        const chunk = storagePaths.slice(index, index + 50);
        const { error } = await supabase.storage
          .from(STORAGE_BUCKET)
          .remove(chunk);
        if (error) {
          console.error(error);
          failedFiles += chunk.length;
        } else {
          deletedFiles += chunk.length;
        }
        setProgress(
          65 +
            Math.round(
              ((index + chunk.length) / Math.max(storagePaths.length, 1)) * 35
            )
        );
        setProgressText(
          `Excluindo arquivos do Supabase (${index + chunk.length}/${storagePaths.length})...`
        );
      }

      const result: DeletionResult = {
        deletedDocuments,
        skippedDocuments,
        deletedFiles,
        failedFiles,
      };
      setDeletionResult(result);
      setOrders((current) =>
        current.filter(
          (item) =>
            !eligible.some(
              (deleted) =>
                deleted.sourceCollection === item.sourceCollection &&
                deleted.sourceId === item.sourceId
            )
        )
      );
      setShowDeleteModal(false);
      setDeleteConfirmation("");
      setProgress(100);
      setProgressText("Limpeza finalizada.");
      setMessage({
        type: failedFiles > 0 || skippedDocuments > 0 ? "info" : "success",
        text:
          failedFiles > 0 || skippedDocuments > 0
            ? "A limpeza foi concluída com ressalvas. Confira o resumo exibido abaixo."
            : "Todos os registros e arquivos incluídos no backup foram removidos da nuvem.",
      });
    } catch (error) {
      console.error(error);
      setMessage({
        type: "error",
        text:
          error instanceof Error
            ? `Não foi possível concluir a limpeza: ${error.message}`
            : "Não foi possível concluir a limpeza.",
      });
    } finally {
      setDeleting(false);
    }
  }

  if (authorized === null) {
    return (
      <section className="page-card backup-page">
        <div className="backup-loading">Verificando permissão de acesso...</div>
      </section>
    );
  }

  if (!authorized) {
    return (
      <section className="page-card backup-page">
        <div className="backup-denied">
          <div className="backup-denied-icon">🔒</div>
          <h2>Acesso restrito</h2>
          <p>Somente usuários com perfil ADM podem gerar e excluir backups.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="page-card backup-page">
      <header className="backup-header">
        <div>
          <span className="backup-eyebrow">Manutenção do banco online</span>
          <h2>Backup de ordens concluídas</h2>
          <p>
            Gera um ZIP completo e mantém no Firebase somente as ordens que ainda
            estão abertas, em atendimento ou aguardando o SANEAR.
          </p>
        </div>
        <div className="backup-safety-badge">
          <span>✓</span>
          <div>
            <strong>Exclusão controlada</strong>
            <small>Nada é apagado antes da confirmação</small>
          </div>
        </div>
      </header>

      <div className="backup-flow">
        <div className="backup-flow-step">
          <span>1</span>
          <strong>Analisar</strong>
          <small>Selecionar ordens concluídas</small>
        </div>
        <div className="backup-flow-arrow">→</div>
        <div className="backup-flow-step">
          <span>2</span>
          <strong>Conferir OS</strong>
          <small>Revisar tudo que será incluído</small>
        </div>
        <div className="backup-flow-arrow">→</div>
        <div className="backup-flow-step">
          <span>3</span>
          <strong>Gerar ZIP</strong>
          <small>JSON, CSV, PDF e fotos</small>
        </div>
        <div className="backup-flow-arrow">→</div>
        <div className="backup-flow-step">
          <span>4</span>
          <strong>Limpar nuvem</strong>
          <small>Somente após confirmação</small>
        </div>
      </div>

      <section className="backup-panel">
        <div className="backup-panel-title">
          <div>
            <h3>Seleção do período</h3>
            <p>
              O filtro usa a data de execução. Quando ela não existe, utiliza a
              última atualização ou a data de criação.
            </p>
          </div>
          <button
            type="button"
            className="backup-link-button"
            onClick={() => {
              setStartDate("");
              setEndDate("");
            }}
          >
            Selecionar todo o histórico
          </button>
        </div>

        <div className="backup-filter-grid">
          <label>
            <span>Data inicial</span>
            <input
              type="date"
              value={startDate}
              onChange={(event) => setStartDate(event.target.value)}
              disabled={analyzing || generating || deleting}
            />
          </label>
          <label>
            <span>Data final</span>
            <input
              type="date"
              value={endDate}
              onChange={(event) => setEndDate(event.target.value)}
              disabled={analyzing || generating || deleting}
            />
          </label>
          <label>
            <span>Tipo de serviço</span>
            <select
              value={typeFilter}
              onChange={(event) =>
                setTypeFilter(event.target.value as TipoFiltro)
              }
              disabled={analyzing || generating || deleting}
            >
              <option value="TODOS">Calçamento e Asfalto</option>
              <option value="CALCAMENTO">Somente Calçamento</option>
              <option value="ASFALTO">Somente Asfalto</option>
            </select>
          </label>
          <button
            type="button"
            className="backup-analyze-button"
            onClick={() => void analyze()}
            disabled={analyzing || generating || deleting}
          >
            {analyzing ? "Analisando..." : "Analisar registros"}
          </button>
        </div>
      </section>

      {message && (
        <div className={`backup-message backup-message-${message.type}`}>
          {message.text}
        </div>
      )}

      <div className="backup-kpi-grid">
        <div className="backup-kpi">
          <span>Ordens selecionadas</span>
          <strong>{orders.length}</strong>
        </div>
        <div className="backup-kpi">
          <span>Calçamento</span>
          <strong>{calcamentoCount}</strong>
        </div>
        <div className="backup-kpi">
          <span>Asfalto</span>
          <strong>{asfaltoCount}</strong>
        </div>
        <div className="backup-kpi">
          <span>Fotos vinculadas</span>
          <strong>{photoCount}</strong>
        </div>
      </div>

      <section className="backup-orders-preview">
        <div className="backup-orders-preview-header">
          <div>
            <span className="backup-orders-preview-eyebrow">Conferência obrigatória</span>
            <h3>OS que serão incluídas no próximo backup</h3>
            <p>
              Somente as ordens exibidas nesta lista entrarão no ZIP. Confira
              protocolo, número da OS, endereço, execução e quantidade de fotos.
            </p>
          </div>
          <div className="backup-orders-preview-actions">
            <label className="backup-orders-search">
              <span>Pesquisar na seleção</span>
              <input
                type="search"
                value={reviewSearch}
                onChange={(event) => setReviewSearch(event.target.value)}
                placeholder="Protocolo, OS, rua, bairro..."
                disabled={generating || deleting}
              />
            </label>
            <div className="backup-orders-count">
              <strong>{reviewedOrders.length}</strong>
              <span>de {orders.length} OS exibidas</span>
            </div>
          </div>
        </div>

        {orders.length === 0 ? (
          <div className="backup-orders-empty">
            Clique em <b>Analisar registros</b> para carregar as OS concluídas.
          </div>
        ) : reviewedOrders.length === 0 ? (
          <div className="backup-orders-empty">
            Nenhuma OS da seleção corresponde à pesquisa informada.
          </div>
        ) : (
          <div className="backup-orders-table-wrap">
            <table className="backup-orders-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Tipo</th>
                  <th>Protocolo</th>
                  <th>Ordem de Serviço</th>
                  <th>Endereço</th>
                  <th>Executada em</th>
                  <th>Fotos</th>
                </tr>
              </thead>
              <tbody>
                {reviewedOrders.map((order) => {
                  const originalIndex = orders.findIndex(
                    (item) =>
                      item.sourceCollection === order.sourceCollection &&
                      item.sourceId === order.sourceId
                  );
                  return (
                    <tr key={`${order.sourceCollection}/${order.sourceId}`}>
                      <td className="backup-orders-index">{originalIndex + 1}</td>
                      <td>
                        <span
                          className={`backup-order-type backup-order-type-${order.origem}`}
                        >
                          {order.origem === "asfalto" ? "Asfalto" : "Calçamento"}
                        </span>
                      </td>
                      <td>
                        <b>{order.protocolo ?? "Não informado"}</b>
                      </td>
                      <td>{order.ordemServico ?? "Não informada"}</td>
                      <td>
                        <span className="backup-order-address">
                          {order.rua ?? "Rua não informada"}
                          {order.numero ? `, ${order.numero}` : ""}
                          {order.bairro ? ` — ${order.bairro}` : ""}
                        </span>
                      </td>
                      <td>{formatDateTime(order.dataExecucaoIso)}</td>
                      <td>
                        <span className="backup-order-photo-count">
                          {order.photos.length}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {orders.length > 0 && (
          <div className="backup-orders-preview-footer">
            <span>
              A pesquisa acima apenas facilita a conferência; ela não remove OS
              do backup. O ZIP incluirá todas as <b>{orders.length}</b> ordens
              selecionadas pela análise.
            </span>
            <button
              type="button"
              className="backup-review-button"
              onClick={() => setShowReviewModal(true)}
              disabled={generating || deleting}
            >
              Revisar lista e continuar
            </button>
          </div>
        )}
      </section>

      <section className="backup-content-card">
        <div className="backup-content-icon">ZIP</div>
        <div className="backup-content-copy">
          <h3>Conteúdo do arquivo oficial</h3>
          <div className="backup-content-list">
            <span><b>JSON</b> — dados completos para reconstrução do histórico</span>
            <span><b>CSV</b> — consulta rápida no Excel</span>
            <span><b>PDF</b> — uma ficha por OS e páginas das evidências</span>
            <span><b>Fotos</b> — arquivos originais de abertura e execução</span>
            <span><b>Hash SHA-256</b> — identifica o conteúdo e evita duplicidade</span>
          </div>
        </div>
        <button
          type="button"
          className="backup-generate-button"
          onClick={() => setShowReviewModal(true)}
          disabled={orders.length === 0 || generating || deleting}
        >
          {generating ? "Gerando backup..." : "Revisar e gerar ZIP"}
        </button>
      </section>

      {(generating || deleting || progress > 0) && (
        <div className="backup-progress-card">
          <div className="backup-progress-header">
            <strong>{progressText}</strong>
            <span>{progress}%</span>
          </div>
          <div className="backup-progress-track">
            <div
              className="backup-progress-bar"
              style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
            />
          </div>
        </div>
      )}

      {backupResult && (
        <section className="backup-result-card">
          <div className="backup-result-check">✓</div>
          <div className="backup-result-main">
            <h3>Backup gerado</h3>
            <p className="backup-result-filename">{backupResult.filename}</p>
            <div className="backup-result-meta">
              <span>{backupResult.manifest.recordCount} OS</span>
              <span>{backupResult.manifest.photoCount} fotos</span>
              <span>{formatBytes(backupResult.sizeBytes)}</span>
              <span>Hash: {backupResult.manifest.contentHash.slice(0, 16)}…</span>
            </div>
          </div>
          <button
            type="button"
            className="backup-delete-button"
            onClick={() => setShowDeleteModal(true)}
            disabled={deleting}
          >
            Apagar itens incluídos da nuvem
          </button>
        </section>
      )}

      {deletionResult && (
        <section className="backup-deletion-summary">
          <h3>Resumo da limpeza</h3>
          <div>
            <span>Documentos excluídos: <b>{deletionResult.deletedDocuments}</b></span>
            <span>Documentos preservados por alteração: <b>{deletionResult.skippedDocuments}</b></span>
            <span>Arquivos excluídos: <b>{deletionResult.deletedFiles}</b></span>
            <span>Arquivos com falha: <b>{deletionResult.failedFiles}</b></span>
          </div>
        </section>
      )}

      <aside className="backup-warning">
        <strong>Importante</strong>
        <p>
          O navegador não envia o ZIP para outro servidor. O arquivo é salvo no
          computador escolhido pelo usuário. Mantenha pelo menos duas cópias em
          locais diferentes, como servidor interno e mídia externa.
        </p>
      </aside>

      {showReviewModal && orders.length > 0 && (
        <div className="modal-backdrop backup-modal-backdrop">
          <div
            className="modal backup-review-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="backup-review-title"
          >
            <div className="modal-header">
              <div>
                <h3 className="modal-title" id="backup-review-title">
                  Conferir OS antes de salvar o ZIP
                </h3>
                <p className="backup-review-subtitle">
                  Esta é a última conferência. O arquivo será gerado somente após
                  sua confirmação.
                </p>
              </div>
              <button
                type="button"
                className="modal-close"
                onClick={() => setShowReviewModal(false)}
                disabled={generating}
                aria-label="Fechar conferência"
              >
                ×
              </button>
            </div>
            <div className="modal-body backup-review-body">
              <div className="backup-review-summary">
                <div>
                  <span>Total de OS</span>
                  <strong>{orders.length}</strong>
                </div>
                <div>
                  <span>Calçamento</span>
                  <strong>{calcamentoCount}</strong>
                </div>
                <div>
                  <span>Asfalto</span>
                  <strong>{asfaltoCount}</strong>
                </div>
                <div>
                  <span>Fotos</span>
                  <strong>{photoCount}</strong>
                </div>
              </div>

              <div className="backup-review-notice">
                Confira a relação abaixo. Todas estas OS serão gravadas no JSON,
                CSV e PDF do backup. As respectivas fotos também serão baixadas.
              </div>

              <div className="backup-review-table-wrap">
                <table className="backup-orders-table backup-orders-table-modal">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Tipo</th>
                      <th>Protocolo</th>
                      <th>OS</th>
                      <th>Endereço</th>
                      <th>Execução</th>
                      <th>Fotos</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orders.map((order, index) => (
                      <tr key={`${order.sourceCollection}/${order.sourceId}`}>
                        <td className="backup-orders-index">{index + 1}</td>
                        <td>
                          <span
                            className={`backup-order-type backup-order-type-${order.origem}`}
                          >
                            {order.origem === "asfalto" ? "Asfalto" : "Calçamento"}
                          </span>
                        </td>
                        <td><b>{order.protocolo ?? "Não informado"}</b></td>
                        <td>{order.ordemServico ?? "Não informada"}</td>
                        <td>
                          <span className="backup-order-address">
                            {order.rua ?? "Rua não informada"}
                            {order.numero ? `, ${order.numero}` : ""}
                            {order.bairro ? ` — ${order.bairro}` : ""}
                          </span>
                        </td>
                        <td>{formatDateTime(order.dataExecucaoIso)}</td>
                        <td>
                          <span className="backup-order-photo-count">
                            {order.photos.length}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="modal-footer backup-review-footer">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setShowReviewModal(false)}
                disabled={generating}
              >
                Voltar e revisar filtros
              </button>
              <button
                type="button"
                className="backup-review-confirm-button"
                onClick={() => void generateBackup()}
                disabled={generating}
              >
                {generating ? "Gerando backup..." : `Confirmar e salvar ${orders.length} OS`}
              </button>
            </div>
          </div>
        </div>
      )}

      {showDeleteModal && backupResult && (
        <div className="modal-backdrop backup-modal-backdrop">
          <div className="modal backup-delete-modal" role="dialog" aria-modal="true">
            <div className="modal-header">
              <h3 className="modal-title">Confirmar limpeza da nuvem</h3>
              <button
                type="button"
                className="modal-close"
                onClick={() => {
                  setShowDeleteModal(false);
                  setDeleteConfirmation("");
                }}
                disabled={deleting}
              >
                ×
              </button>
            </div>
            <div className="modal-body">
              <div className="backup-delete-alert">
                Esta ação apagará <b>{backupResult.orders.length}</b> documento(s)
                finalizado(s) do Firestore e tentará remover as respectivas fotos
                do Supabase.
              </div>
              <p>
                Ordens pendentes, em atendimento ou aguardando o SANEAR não serão
                alteradas. Registros modificados depois da geração do ZIP também
                serão preservados automaticamente.
              </p>
              <label className="backup-confirm-field">
                <span>Digite <b>APAGAR</b> para confirmar</span>
                <input
                  value={deleteConfirmation}
                  onChange={(event) => setDeleteConfirmation(event.target.value)}
                  autoComplete="off"
                  disabled={deleting}
                />
              </label>
            </div>
            <div className="modal-footer">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  setShowDeleteModal(false);
                  setDeleteConfirmation("");
                }}
                disabled={deleting}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="backup-delete-confirm-button"
                onClick={() => void deleteFromCloud()}
                disabled={
                  deleting || deleteConfirmation.trim().toUpperCase() !== "APAGAR"
                }
              >
                {deleting ? "Excluindo..." : "Confirmar exclusão"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};

export default Backup;
