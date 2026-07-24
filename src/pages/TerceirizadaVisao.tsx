// src/pages/TerceirizadaVisao.tsx
import React, { useEffect, useMemo, useState } from "react";
import type { ChangeEvent } from "react";
import {
  collection,
  onSnapshot,
  orderBy,
  query,
  updateDoc,
  doc,
  serverTimestamp,
  Timestamp,
} from "firebase/firestore";
import { auth, db } from "../lib/firebaseClient";
import { supabase } from "../lib/supabaseClient";
import {
  compactBlobToZip,
  extractFirstFileObjectUrlFromZipUrl,
  isZipReference,
  ZIP_STORAGE_MIME,
} from "../lib/storageZip";
import {
  upsertSanearPause,
  closeSanearPause,
  hasOpenSanearPause,
  MS_POR_HORA,
  SLA_CONFIGS,
  getSlaConfigFromOrder,
  getSlaHorasFromOrder,
} from "../lib/sla";
import { registrarAuditoriaOs } from "../lib/auditoria";
import {
  formatOrdemStatusLabel,
  getOrdemStatusCssClass,
  isOrdemAberta,
  isOrdemAguardandoSanear,
  isOrdemCancelada,
  isOrdemConcluida,
  normalizeOrdemStatus,
} from "../lib/status";
import { salvarAnexoPendente, resumirErroAnexo } from "../lib/anexosPendentes";
import { AppPagination } from "../components/ui";
import "./TerceirizadaVisao.css";

// bucket do Supabase onde as OS estão sendo gravadas
const STORAGE_BUCKET = "os-arquivos";
const MAX_FOTOS_EXECUCAO = 2;

// pdf-lib para gerar o PDF com dados da OS
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

type OrigemOS = "buraco" | "asfalto";

type FirestoreOS = {
  id: string;
  origem: OrigemOS;

  tipo?: string;
  protocolo?: string | null;
  ordemServico?: string | null;
  bairro?: string | null;
  rua?: string | null;
  numero?: string | null;
  pontoReferencia?: string | null;
  observacoes?: string | null;
  status?: string | null;
  createdAt?: Timestamp | null;
  createdByEmail?: string | null;
  dataExecucao?: Timestamp | null;
  finalizadoPorArea?: string | null;
  finalizadoPorEmail?: string | null;
  finalizadoPorUid?: string | null;

  // SLA por serviço e pausa SANEAR
  slaHoras?: number | null;
  slaServico?: string | null;
  slaPausas?: any[] | null;
  statusAntesAguardandoSanear?: string | null;

  // PDF da papeleta (URL pública Supabase / Storage) – mantido por compatibilidade
  ordemServicoPdfBase64?: string | null;
  ordemServicoPdfNomeArquivo?: string | null;
  ordemServicoPdfDataAnexo?: string | null;
  ordemServicoPdfUrl?: string | null;
  ordemServicoPdfPath?: string | null;
  ordemServicoPdfCompactado?: boolean | null;
  ordemServicoPdfMimeTypeOriginal?: string | null;

  // Fotos da execução (terceirizada) – usadas na ListaOrdensServico
  fotosExecucao?: any[] | null;
};

type LocalPhoto = {
  id: string;
  name: string;
  dataUrl: string;
  createdAt: string;
};

const tipoLabelMap: Record<string, string> = {
  BURACO_RUA: "CALÇAMENTO",
  ASFALTO: "ASFALTO",
};

const origemLabelMap: Record<OrigemOS, string> = {
  buraco: "CALÇAMENTO",
  asfalto: "ASFALTO",
};

function getOrigemLabel(origem: OrigemOS): string {
  return origemLabelMap[origem] || "Ordem de Serviço";
}

function getCollectionName(origem: OrigemOS): "ordens_servico" | "ordensServico" {
  if (origem === "asfalto") return "ordensServico";
  return "ordens_servico";
}

function getStorageBasePath(origem: OrigemOS): string {
  if (origem === "asfalto") return "asfalto";
  return "buraco-rua";
}

function base64PdfToObjectUrl(base64: string): string {
  const clean = base64.includes(",") ? base64.split(",").pop() || "" : base64;
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  const blob = new Blob([bytes as unknown as BlobPart], { type: "application/pdf" });
  return URL.createObjectURL(blob);
}

function hasAttachedPdf(os: FirestoreOS): boolean {
  return Boolean(os.ordemServicoPdfUrl || os.ordemServicoPdfPath || os.ordemServicoPdfBase64);
}

async function resolveAttachedPdfUrl(os: FirestoreOS): Promise<{ url: string; shouldRevoke: boolean } | null> {
  const rawUrl = os.ordemServicoPdfUrl || null;
  const rawPath = os.ordemServicoPdfPath || null;
  const zipped = Boolean(os.ordemServicoPdfCompactado) || isZipReference(rawUrl) || isZipReference(rawPath);

  if (rawUrl) {
    if (zipped) {
      const extracted = await extractFirstFileObjectUrlFromZipUrl(
        rawUrl,
        os.ordemServicoPdfMimeTypeOriginal || "application/pdf"
      );
      return { url: extracted.url, shouldRevoke: true };
    }

    return { url: rawUrl, shouldRevoke: false };
  }

  if (rawPath) {
    const { data } = supabase.storage
      .from(STORAGE_BUCKET)
      .getPublicUrl(rawPath);

    if (data.publicUrl) {
      if (zipped) {
        const extracted = await extractFirstFileObjectUrlFromZipUrl(
          data.publicUrl,
          os.ordemServicoPdfMimeTypeOriginal || "application/pdf"
        );
        return { url: extracted.url, shouldRevoke: true };
      }

      return { url: data.publicUrl, shouldRevoke: false };
    }
  }

  if (os.ordemServicoPdfBase64) {
    return { url: base64PdfToObjectUrl(os.ordemServicoPdfBase64), shouldRevoke: true };
  }

  return null;
}

const tipoBadgeClassMap: Record<string, string> = {
  BURACO_RUA: "os-badge os-badge-buraco",
  ASFALTO: "os-badge os-badge-asfalto",
  HIDROJATO: "os-badge os-badge-asfalto",
};

function normalizeStatusValue(status?: string | null): string {
  return normalizeOrdemStatus(status);
}

function isDoneStatus(status?: string | null): boolean {
  return isOrdemConcluida(status);
}

function isCanceledStatus(status?: string | null): boolean {
  return isOrdemCancelada(status);
}

function isWaitingSanearStatus(status?: string | null): boolean {
  return isOrdemAguardandoSanear(status);
}

function isOpenStatus(status?: string | null): boolean {
  return isOrdemAberta(status);
}

function statusClass(status?: string | null): string {
  return getOrdemStatusCssClass(status);
}

function formatStatusLabel(status?: string | null): string {
  return formatOrdemStatusLabel(status, { uppercase: true });
}

function formatCreatedAt(createdAt?: Timestamp | null): string {
  if (!createdAt) return "-";
  try {
    const d = createdAt.toDate();
    return d.toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "-";
  }
}


// ===== SLA: cálculo de SLA ÚTIL (padrão 72h) (sábado/domingo não contam) =====
function businessMsBetween(start: Date, end: Date): number {
  if (end.getTime() <= start.getTime()) return 0;

  let total = 0;
  let cursor = new Date(start.getTime());

  while (cursor.getTime() < end.getTime()) {
    const day = cursor.getDay(); // 0=dom, 6=sáb
    const isWeekend = day === 0 || day === 6;

    const nextMidnight = new Date(cursor);
    nextMidnight.setHours(24, 0, 0, 0);

    const segmentEndMs = Math.min(end.getTime(), nextMidnight.getTime());
    const segmentMs = Math.max(0, segmentEndMs - cursor.getTime());

    if (!isWeekend) total += segmentMs;

    cursor = new Date(segmentEndMs);
  }

  return total;
}

function formatBusinessDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60000));
  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;

  if (days > 0) return `${days}d ${hours}h úteis`;
  if (totalHours > 0) return `${totalHours}h ${minutes}m úteis`;
  return `${minutes}m úteis`;
}

function getOpenSanearPause(pausas?: any[] | null): any | null {
  if (!Array.isArray(pausas)) return null;
  return (
    pausas.find((pausa) => pausa?.tipo === "SANEAR" && !pausa?.fimEm) ?? null
  );
}

function formatPauseReason(pausa: any | null): string {
  if (!pausa) return "Aguardando uma ação da SANEAR";

  const motivoMap: Record<string, string> = {
    SERVICO_PREVIO: "Aguardando serviço prévio da SANEAR",
    BLOQUEIO_ACESSO: "Acesso ao local bloqueado",
    MATERIAL: "Aguardando material ou recurso",
    INFORMACAO: "Aguardando informação da SANEAR",
    OUTRO: "Aguardando ação da SANEAR",
  };

  const motivo = motivoMap[String(pausa.motivo ?? "").toUpperCase()];
  const descricao = String(pausa.descricao ?? "").trim();

  if (motivo && descricao) return `${motivo}: ${descricao}`;
  return descricao || motivo || "Aguardando uma ação da SANEAR";
}

const generateLocalId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// remove acentos e caracteres estranhos para usar no path do Supabase
function sanitizeForStoragePath(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9.\-_]/g, "_");
}

// converte um dataURL (base64) em Blob para upload no Supabase
function dataUrlToBlob(dataUrl: string): Blob {
  const [header, base64] = dataUrl.split(",");
  const mimeMatch = header.match(/data:(.*);base64/);
  const mime = mimeMatch ? mimeMatch[1] : "image/jpeg";

  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return new Blob([bytes], { type: mime });
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Falha ao ler a imagem."));
    reader.readAsDataURL(file);
  });
}

// quebra texto dentro da largura no PDF
function wrapPdfText(
  text: string,
  font: any,
  fontSize: number,
  maxWidth: number
): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let currentLine = "";

  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    const width = font.widthOfTextAtSize(testLine, fontSize);
    if (width > maxWidth && currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = testLine;
    }
  }

  if (currentLine) lines.push(currentLine);
  return lines;
}

// gera um PDF novo com todos os dados da OS (tabela) e devolve um ObjectURL
async function generateOsDataPdfUrl(os: FirestoreOS): Promise<string> {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage();
  const { width, height } = page.getSize();

  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontSizeTitle = 16;
  const fontSize = 10;
  const lineHeight = fontSize + 4;

  const marginLeft = 40;
  const marginRight = 40;
  const maxWidth = width - marginLeft - marginRight;

  let y = height - 60;

  // Título
  const titulo = `ORDEM DE SERVIÇO - ${
    os.ordemServico || os.protocolo || os.id
  }`;
  const titleWidth = boldFont.widthOfTextAtSize(titulo, fontSizeTitle);
  page.drawText(titulo, {
    x: (width - titleWidth) / 2,
    y,
    size: fontSizeTitle,
    font: boldFont,
    color: rgb(0, 0, 0),
  });

  y -= lineHeight * 2;

  const tipoLabel =
    tipoLabelMap[os.tipo || ""] ||
    os.tipo ||
    getOrigemLabel(os.origem);

  const rows: { label: string; value: string }[] = [
    { label: "Tipo", value: tipoLabel },
    {
      label: "Origem",
      value: getOrigemLabel(os.origem),
    },
    { label: "Nº OS", value: os.ordemServico || "-" },
    { label: "Protocolo", value: os.protocolo || "-" },
    { label: "Bairro", value: os.bairro || "-" },
    { label: "Rua / Avenida", value: os.rua || "-" },
    { label: "Número", value: os.numero || "-" },
    { label: "Ponto de referência", value: os.pontoReferencia || "-" },
    { label: "Status", value: formatStatusLabel(os.status) },
    {
      label: "Data de criação",
      value: formatCreatedAt(os.createdAt),
    },
    {
      label: "Data de execução",
      value: formatCreatedAt(os.dataExecucao),
    },
    {
      label: "Criado por",
      value: os.createdByEmail || "-",
    },
    {
      label: "Observações",
      value:
        (os.observacoes || "")
          .replace(/\s+/g, " ")
          .trim() || "-",
    },
  ];

  const labelGap = 4;

  rows.forEach(({ label, value }) => {
    if (y < 80) {
      // se chegar muito perto do rodapé, poderia abrir nova página;
      // aqui simplificamos e paramos para não quebrar nada.
      return;
    }

    const labelText = `${label}: `;
    const labelWidth = boldFont.widthOfTextAtSize(labelText, fontSize);
    const valueLines = wrapPdfText(
      value,
      font,
      fontSize,
      maxWidth - labelWidth
    );

    // primeira linha: label + primeira linha do value
    const firstValueLine = valueLines[0] ?? "";
    page.drawText(labelText, {
      x: marginLeft,
      y,
      size: fontSize,
      font: boldFont,
      color: rgb(0, 0, 0),
    });
    page.drawText(firstValueLine, {
      x: marginLeft + labelWidth + labelGap,
      y,
      size: fontSize,
      font,
      color: rgb(0, 0, 0),
    });

    // demais linhas só com o value
    let currentY = y;
    for (let i = 1; i < valueLines.length; i++) {
      currentY -= lineHeight;
      page.drawText(valueLines[i], {
        x: marginLeft + labelWidth + labelGap,
        y: currentY,
        size: fontSize,
        font,
        color: rgb(0, 0, 0),
      });
    }

    y = currentY - lineHeight;
  });

  const pdfBytes = await pdfDoc.save();
  const blob = new Blob([pdfBytes as unknown as BlobPart], {
    type: "application/pdf",
  });
  return URL.createObjectURL(blob);
}

const TerceirizadaVisao: React.FC = () => {
  const [ordensBuraco, setOrdensBuraco] = useState<FirestoreOS[]>([]);
  const [ordensAsfalto, setOrdensAsfalto] = useState<FirestoreOS[]>([]);
  const [busca, setBusca] = useState("");
  const [loadingBuraco, setLoadingBuraco] = useState(true);
  const [loadingAsfalto, setLoadingAsfalto] = useState(true);
  const loading = loadingBuraco || loadingAsfalto;

  // ===== SLA (72h úteis) =====
  const [slaOpen, setSlaOpen] = useState(false);

  // "tick" para recalcular o SLA periodicamente (sem reabrir listeners)
  const [nowTick, setNowTick] = useState<number>(() => Date.now());

  useEffect(() => {
    const t = window.setInterval(() => setNowTick(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, []);

  // Abas de status: Abertas / Concluídas / Todas
  const [statusTab, setStatusTab] = useState<"ALL" | "OPEN" | "DONE">("OPEN");

  // Filtro por categoria de serviço (tipo)
  const [categoryFilter, setCategoryFilter] = useState<string>("ALL");
  const [currentPage, setCurrentPage] = useState(1);
  const PAGE_SIZE = 10;

  // OS selecionada no modal
  const [modalOs, setModalOs] = useState<FirestoreOS | null>(null);

  // Fotos em memória, por OS (somente na sessão atual)
  const [photosByOsId, setPhotosByOsId] = useState<Record<string, LocalPhoto[]>>(
    {}
  );

  // Se deve mostrar o campo de upload no modal
  const [showPhotoUploader, setShowPhotoUploader] = useState(false);

  const [isUpdatingStatus, setIsUpdatingStatus] = useState(false);

  // Modal de informação (substitui alert())
  const [infoModal, setInfoModal] = useState<{
    title: string;
    message: string;
  } | null>(null);

  // ===== Aguardando SANEAR (SLA pausado) =====
  const [aguardandoSanearOpen, setAguardandoSanearOpen] = useState(false);
  const [aguardandoMotivo, setAguardandoMotivo] = useState("SERVICO_PREVIO");
  const [aguardandoDescricao, setAguardandoDescricao] = useState("");

  // ======= CARREGAR OS DE BURACO + ASFALTO =======
  useEffect(() => {
    // Buraco na Rua (calçamento) – coleção ordens_servico
    const qBuraco = query(
      collection(db, "ordens_servico"),
      orderBy("createdAt", "desc")
    );

    const unsubBuraco = onSnapshot(
      qBuraco,
      (snap) => {
        const data: FirestoreOS[] = snap.docs.map((d) => {
          const raw = d.data() as any;
          const pdfNested = raw.ordemServicoPdf ?? null;

          return {
            id: d.id,
            origem: "buraco",
            tipo: raw.tipo || "BURACO_RUA",
            protocolo: raw.protocolo ?? null,
            ordemServico: raw.ordemServico ?? null,

            // Compatibilidade: tenta primeiro os campos novos (bairro, rua, pontoReferencia),
            // se não tiver, usa alternativas que possam existir em documentos antigos.
            bairro:
              raw.bairro ??
              raw.bairroLocal ??
              raw.bairro_os ??
              null,
            rua:
              raw.rua ??
              raw.logradouro ??
              raw.ruaAvenida ??
              null,
            numero:
              raw.numero ??
              raw.numeroCasa ??
              null,
            pontoReferencia:
              raw.pontoReferencia ??
              raw.referencia ??
              raw.ponto ??
              null,

            observacoes: raw.observacoes ?? null,
            status: raw.status ?? null,
            createdAt: raw.createdAt ?? null,
            createdByEmail: raw.createdByEmail ?? null,
            dataExecucao: raw.dataExecucao ?? null,
            slaHoras: raw.slaHoras ?? null,
            slaServico: raw.slaServico ?? null,
            slaPausas: Array.isArray(raw.slaPausas) ? raw.slaPausas : [],
            statusAntesAguardandoSanear:
              raw.statusAntesAguardandoSanear ?? null,
            ordemServicoPdfBase64:
              raw.ordemServicoPdfBase64 ?? pdfNested?.base64 ?? null,
            ordemServicoPdfNomeArquivo:
              raw.ordemServicoPdfNomeArquivo ?? pdfNested?.nomeArquivo ?? null,
            ordemServicoPdfDataAnexo:
              raw.ordemServicoPdfDataAnexo ?? pdfNested?.dataAnexoTexto ?? null,
            ordemServicoPdfUrl:
              raw.ordemServicoPdfUrl ?? pdfNested?.url ?? null,
            ordemServicoPdfPath:
              raw.ordemServicoPdfPath ?? pdfNested?.path ?? null,
            ordemServicoPdfCompactado:
              raw.ordemServicoPdfCompactado ?? pdfNested?.compactado ?? null,
            ordemServicoPdfMimeTypeOriginal:
              raw.ordemServicoPdfMimeTypeOriginal ?? pdfNested?.mimeTypeOriginal ?? null,
            fotosExecucao: raw.fotosExecucao ?? null,
          };
        });
        setOrdensBuraco(data);
        setLoadingBuraco(false);
      },
      (err) => {
        console.error(err);
        setLoadingBuraco(false);
        setInfoModal({
          title: "Erro ao carregar ordens",
          message:
            "Não foi possível carregar as ordens de Buraco na rua. Verifique sua conexão e tente novamente.",
        });
      }
    );

    // Asfalto – coleção ordensServico
    const qAsfalto = query(
      collection(db, "ordensServico"),
      orderBy("createdAt", "desc")
    );

    const unsubAsfalto = onSnapshot(
      qAsfalto,
      (snap) => {
        const data: FirestoreOS[] = snap.docs.map((d) => {
          const raw = d.data() as any;
          const pdfNested = raw.ordemServicoPdf ?? null;

          return {
            id: d.id,
            origem: "asfalto",
            tipo: raw.tipo || "ASFALTO",
            protocolo: raw.protocolo ?? null,
            ordemServico: raw.ordemServico ?? null,

            // Mesmo padrão de compatibilidade
            bairro:
              raw.bairro ??
              raw.bairroLocal ??
              raw.bairro_os ??
              null,
            rua:
              raw.rua ??
              raw.logradouro ??
              raw.ruaAvenida ??
              null,
            numero:
              raw.numero ??
              raw.numeroCasa ??
              null,
            pontoReferencia:
              raw.pontoReferencia ??
              raw.referencia ??
              raw.ponto ??
              null,

            observacoes: raw.observacoes ?? null,
            status: raw.status ?? null,
            createdAt: raw.createdAt ?? null,
            createdByEmail: raw.createdByEmail ?? null,
            dataExecucao: raw.dataExecucao ?? null,
            slaHoras: raw.slaHoras ?? null,
            slaServico: raw.slaServico ?? null,
            slaPausas: Array.isArray(raw.slaPausas) ? raw.slaPausas : [],
            statusAntesAguardandoSanear:
              raw.statusAntesAguardandoSanear ?? null,
            ordemServicoPdfBase64:
              raw.ordemServicoPdfBase64 ?? pdfNested?.base64 ?? null,
            ordemServicoPdfNomeArquivo:
              raw.ordemServicoPdfNomeArquivo ?? pdfNested?.nomeArquivo ?? null,
            ordemServicoPdfDataAnexo:
              raw.ordemServicoPdfDataAnexo ?? pdfNested?.dataAnexoTexto ?? null,
            ordemServicoPdfUrl:
              raw.ordemServicoPdfUrl ?? pdfNested?.url ?? null,
            ordemServicoPdfPath:
              raw.ordemServicoPdfPath ?? pdfNested?.path ?? null,
            ordemServicoPdfCompactado:
              raw.ordemServicoPdfCompactado ?? pdfNested?.compactado ?? null,
            ordemServicoPdfMimeTypeOriginal:
              raw.ordemServicoPdfMimeTypeOriginal ?? pdfNested?.mimeTypeOriginal ?? null,
            fotosExecucao: raw.fotosExecucao ?? null,
          };
        });
        setOrdensAsfalto(data);
        setLoadingAsfalto(false);
      },
      (err) => {
        console.error(err);
        setLoadingAsfalto(false);
        setInfoModal({
          title: "Erro ao carregar ordens",
          message:
            "Não foi possível carregar as ordens de Asfalto. Verifique sua conexão e tente novamente.",
        });
      }
    );

    return () => {
      unsubBuraco();
      unsubAsfalto();
    };
  }, []);

  // Todas as ordens, combinadas
  const ordens = useMemo(() => {
    return [...ordensBuraco, ...ordensAsfalto];
  }, [ordensBuraco, ordensAsfalto]);

  // ===== SLA: prazo de atendimento (segunda a sexta) =====
  const slaSnapshot = useMemo(() => {
    const now = new Date(nowTick);

    const abertas = ordens.filter(
      (os) => isOpenStatus(os.status) && !!os.createdAt
    );

    const toJsDate = (value: any): Date | null => {
      if (!value) return null;
      if (value instanceof Date) return value;
      if (typeof value?.toDate === "function") return value.toDate() as Date;
      return null;
    };

    const list = abertas.map((os) => {
      const created = os.createdAt ? os.createdAt.toDate() : null;
      const baseMs = created ? businessMsBetween(created, now) : 0;
      const pausas = Array.isArray(os.slaPausas) ? os.slaPausas : [];

      let pausadoMs = 0;

      for (const pausa of pausas) {
        if (pausa?.tipo !== "SANEAR") continue;

        const inicio = toJsDate(pausa?.inicioEm);
        if (!inicio) continue;

        const fim = toJsDate(pausa?.fimEm) ?? now;
        pausadoMs += businessMsBetween(inicio, fim);
      }

      const ageMs = Math.max(0, baseMs - pausadoMs);
      const slaConfig = getSlaConfigFromOrder(os);
      const slaHoras = getSlaHorasFromOrder(os);
      const slaMs = slaHoras * MS_POR_HORA;
      const isPaused =
        isWaitingSanearStatus(os.status) || hasOpenSanearPause(os.slaPausas);
      const progressPercent =
        slaMs > 0 ? Math.min(100, Math.round((ageMs / slaMs) * 100)) : 0;

      return {
        os,
        ageMs,
        slaHoras,
        slaConfig,
        slaMs,
        isPaused,
        progressPercent,
        remainingMs: Math.max(0, slaMs - ageMs),
        overdueByMs: Math.max(0, ageMs - slaMs),
      };
    });

    const active = list.filter((item) => !item.isPaused);

    const overdue = active
      .filter((item) => item.ageMs >= item.slaMs)
      .sort((a, b) => b.overdueByMs - a.overdueByMs);

    const nearDue = active
      .filter(
        (item) => item.ageMs >= item.slaMs * 0.75 && item.ageMs < item.slaMs
      )
      .sort((a, b) => a.remainingMs - b.remainingMs);

    const onTime = active.filter((item) => item.ageMs < item.slaMs * 0.75);

    const paused = list
      .filter((item) => item.isPaused)
      .sort((a, b) => b.ageMs - a.ageMs);

    return {
      overdue,
      nearDue,
      onTime,
      paused,
      totalOpen: abertas.length,
    };
  }, [ordens, nowTick]);

  // 1) Filtra por status (aba)
  const porStatus = useMemo(() => {
    return ordens.filter((os) => {
      if (statusTab === "ALL") return true;
      const done = isDoneStatus(os.status);
      if (statusTab === "OPEN") return isOpenStatus(os.status);
      if (statusTab === "DONE") return done;
      return true;
    });
  }, [ordens, statusTab]);

  // 2) Contador por tipo (para o submenu de categorias)
  const countsPorTipo = useMemo(() => {
    const counts: Record<string, number> = {};
    porStatus.forEach((os) => {
      const tipo = os.tipo || "OUTRO";
      counts[tipo] = (counts[tipo] || 0) + 1;
    });
    return counts;
  }, [porStatus]);

  // 3) Filtra por categoria + texto
  const filtradas = useMemo(() => {
    const texto = busca.trim().toLowerCase();

    const base =
      categoryFilter === "ALL"
        ? porStatus
        : porStatus.filter((os) => (os.tipo || "OUTRO") === categoryFilter);

    if (!texto) return base;

    return base.filter((os) => {
      const dataAbertura = formatCreatedAt(os.createdAt).toLowerCase();
      return (
        os.protocolo?.toLowerCase().includes(texto) ||
        os.ordemServico?.toLowerCase().includes(texto) ||
        os.bairro?.toLowerCase().includes(texto) ||
        os.rua?.toLowerCase().includes(texto) ||
        dataAbertura.includes(texto)
      );
    });
  }, [busca, porStatus, categoryFilter]);

  const totalPages = useMemo(() => {
    return Math.max(1, Math.ceil(filtradas.length / PAGE_SIZE));
  }, [filtradas.length, PAGE_SIZE]);

  const paginatedOrdens = useMemo(() => {
    const start = (currentPage - 1) * PAGE_SIZE;
    return filtradas.slice(start, start + PAGE_SIZE);
  }, [filtradas, currentPage, PAGE_SIZE]);

  const paginationStart = filtradas.length === 0 ? 0 : (currentPage - 1) * PAGE_SIZE + 1;
  const paginationEnd = Math.min(currentPage * PAGE_SIZE, filtradas.length);

  useEffect(() => {
    setCurrentPage(1);
  }, [statusTab, categoryFilter, busca]);

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  // Agrupa as filtradas por tipo
  const gruposPorTipo = useMemo(() => {
    const grupos: Record<string, FirestoreOS[]> = {};
    paginatedOrdens.forEach((os) => {
      const tipo = os.tipo || "OUTRO";
      if (!grupos[tipo]) grupos[tipo] = [];
      grupos[tipo].push(os);
    });
    return grupos;
  }, [paginatedOrdens]);

  const tiposOrdenados = useMemo(
    () => Object.keys(gruposPorTipo).sort((a, b) => a.localeCompare(b)),
    [gruposPorTipo]
  );

  const tiposCategoriaOrdenados = useMemo(
    () => Object.keys(countsPorTipo).sort((a, b) => a.localeCompare(b)),
    [countsPorTipo]
  );

  // Fotos da OS aberta no modal (apenas para visualização/obrigatoriedade)
  const currentPhotos: LocalPhoto[] = useMemo(() => {
    if (!modalOs) return [];
    return photosByOsId[modalOs.id] || [];
  }, [modalOs, photosByOsId]);

  const fotosExecucaoJaSalvas = useMemo(() => {
    if (!modalOs || !Array.isArray(modalOs.fotosExecucao)) return 0;
    return modalOs.fotosExecucao.length;
  }, [modalOs]);

  const totalFotosExecucao = fotosExecucaoJaSalvas + currentPhotos.length;
  const vagasFotosExecucao = Math.max(
    0,
    MAX_FOTOS_EXECUCAO - totalFotosExecucao
  );

  const totalAbertas = ordens.filter((os) => isOpenStatus(os.status)).length;
  const totalConcluidas = ordens.filter((os) =>
    isDoneStatus(os.status)
  ).length;
  const totalCanceladas = ordens.filter((os) =>
    isCanceledStatus(os.status)
  ).length;
  const totalCalcamento = ordens.filter((os) => (os.tipo || "") === "BURACO_RUA").length;
  const totalAsfalto = ordens.filter((os) => (os.tipo || "") === "ASFALTO").length;

  async function handleOpenPdf(os: FirestoreOS, event?: React.MouseEvent) {
    event?.stopPropagation();

    try {
      const pdf = await resolveAttachedPdfUrl(os);
      if (!pdf) {
        setInfoModal({
          title: "PDF não encontrado",
          message: "Esta OS não possui PDF anexado.",
        });
        return;
      }

      window.open(pdf.url, "_blank", "noopener,noreferrer");

      if (pdf.shouldRevoke) {
        window.setTimeout(() => URL.revokeObjectURL(pdf.url), 60_000);
      }
    } catch (error) {
      console.error(error);
      setInfoModal({
        title: "Erro ao abrir PDF",
        message: "Não foi possível abrir o PDF anexado a esta OS.",
      });
    }
  }

  function handleOpenOsModal(os: FirestoreOS) {
    setModalOs(os);
    setShowPhotoUploader(false);
  }

  function handleCloseModal() {
    setModalOs(null);
    setShowPhotoUploader(false);
  }

  function handleOpenSlaDrawer() {
    setSlaOpen(true);
  }

  function navigateToListaOsHighlight(os: FirestoreOS) {
    try {
      const payload = {
        osId: os.id,
        origem: os.origem,
      };
      window.sessionStorage.setItem(
        "sanear-listaos-highlight",
        JSON.stringify(payload)
      );
      window.dispatchEvent(
        new CustomEvent("sanear:navigate", { detail: { menu: "listaOS" } })
      );
    } catch {
      // se algo falhar, ao menos navega para a lista
      window.dispatchEvent(
        new CustomEvent("sanear:navigate", { detail: { menu: "listaOS" } })
      );
    } finally {
      setSlaOpen(false);
    }
  }

  async function handleModalFilesChange(
    e: ChangeEvent<HTMLInputElement>
  ) {
    if (!modalOs) return;

    const input = e.currentTarget;
    const files = Array.from(input.files ?? []);
    input.value = "";

    if (files.length === 0) return;

    const fotosAtuais = photosByOsId[modalOs.id] || [];
    const salvas = Array.isArray(modalOs.fotosExecucao)
      ? modalOs.fotosExecucao.length
      : 0;
    const vagas = Math.max(
      0,
      MAX_FOTOS_EXECUCAO - salvas - fotosAtuais.length
    );

    if (vagas === 0) {
      setInfoModal({
        title: "Limite de fotos atingido",
        message: `Cada OS pode ter no máximo ${MAX_FOTOS_EXECUCAO} fotos do serviço executado. Exclua uma foto antes de adicionar outra.`,
      });
      return;
    }

    const allowed = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
    const validFiles = files.filter((file) => allowed.includes(file.type));
    const invalidFiles = files.filter((file) => !allowed.includes(file.type));
    const acceptedFiles = validFiles.slice(0, vagas);
    const ignoredByLimit = Math.max(0, validFiles.length - acceptedFiles.length);

    if (acceptedFiles.length === 0) {
      setInfoModal({
        title: "Nenhuma foto adicionada",
        message:
          invalidFiles.length > 0
            ? "Use somente imagens nos formatos JPG, PNG ou WEBP."
            : `O limite é de ${MAX_FOTOS_EXECUCAO} fotos por OS.`,
      });
      return;
    }

    try {
      const nowText = new Date().toLocaleString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });

      const newPhotos: LocalPhoto[] = await Promise.all(
        acceptedFiles.map(async (file) => ({
          id: generateLocalId(),
          name: file.name,
          dataUrl: await fileToDataUrl(file),
          createdAt: nowText,
        }))
      );

      setPhotosByOsId((prev) => {
        const prevForOs = prev[modalOs.id] || [];
        const limiteDisponivel = Math.max(
          0,
          MAX_FOTOS_EXECUCAO - salvas - prevForOs.length
        );

        return {
          ...prev,
          [modalOs.id]: [
            ...prevForOs,
            ...newPhotos.slice(0, limiteDisponivel),
          ],
        };
      });

      if (ignoredByLimit > 0 || invalidFiles.length > 0) {
        const mensagens: string[] = [];

        if (ignoredByLimit > 0) {
          mensagens.push(
            `${ignoredByLimit} foto(s) não foram adicionadas porque o limite é de ${MAX_FOTOS_EXECUCAO} por OS.`
          );
        }

        if (invalidFiles.length > 0) {
          mensagens.push(
            `${invalidFiles.length} arquivo(s) foram ignorados por não serem JPG, PNG ou WEBP.`
          );
        }

        setInfoModal({
          title: "Fotos adicionadas com restrições",
          message: mensagens.join(" "),
        });
      }
    } catch (error) {
      console.error(error);
      setInfoModal({
        title: "Erro ao ler as fotos",
        message: "Não foi possível carregar uma das imagens selecionadas.",
      });
    }
  }

  function handleRemoveModalPhoto(id: string) {
    if (!modalOs) return;
    setPhotosByOsId((prev) => {
      const prevForOs = prev[modalOs.id] || [];
      return {
        ...prev,
        [modalOs.id]: prevForOs.filter((p) => p.id !== id),
      };
    });
  }

  function normalizeStatus(value: string | null | undefined): string {
    return normalizeStatusValue(value);
  }


async function handleMarcarAguardandoSanear() {
  if (!modalOs) return;

  const descricao = aguardandoDescricao.trim();
  if (descricao.length < 3) {
    setInfoModal({
      title: "Descrição obrigatória",
      message: "Informe uma descrição curta do motivo (mín. 3 caracteres).",
    });
    return;
  }

  try {
    setIsUpdatingStatus(true);

    const collectionName =
      getCollectionName(modalOs.origem);

    const statusAtual = normalizeStatus(modalOs.status);
    const statusAntes =
      modalOs.statusAntesAguardandoSanear ??
      (statusAtual && statusAtual !== "AGUARDANDO_SANEAR" ? statusAtual : "ABERTA");

    const pausasAtualizadas = upsertSanearPause(modalOs.slaPausas, {
      motivo: aguardandoMotivo,
      descricao,
      inicioEm: Timestamp.now(),
    });

    await updateDoc(doc(db, collectionName, modalOs.id), {
      status: "AGUARDANDO_SANEAR",
      statusAntesAguardandoSanear: statusAntes,
      slaPausas: pausasAtualizadas,
      updatedAt: serverTimestamp(),
    });

    void registrarAuditoriaOs({
      osId: modalOs.id,
      origem: modalOs.origem,
      collectionName,
      acao: "AGUARDANDO_SANEAR",
      titulo: "Terceirizada marcou Aguardando SANEAR",
      descricao,
      statusAntes,
      statusDepois: "AGUARDANDO_SANEAR",
      detalhes: { motivo: aguardandoMotivo },
    });

    setModalOs((prev) =>
      prev
        ? {
            ...prev,
            status: "AGUARDANDO_SANEAR",
            statusAntesAguardandoSanear: statusAntes,
            slaPausas: pausasAtualizadas,
          }
        : prev
    );

    setAguardandoSanearOpen(false);
    setAguardandoDescricao("");
  } catch (e) {
    console.error(e);
    setInfoModal({
      title: "Erro",
      message: "Não foi possível marcar como Aguardando SANEAR. Tente novamente.",
    });
  } finally {
    setIsUpdatingStatus(false);
  }
}

async function handleRetomarSanear() {
  if (!modalOs) return;

  try {
    setIsUpdatingStatus(true);

    const collectionName =
      getCollectionName(modalOs.origem);

    const pausasFechadas = closeSanearPause(modalOs.slaPausas, Timestamp.now());
    const novoStatus = modalOs.statusAntesAguardandoSanear || "ABERTA";

    await updateDoc(doc(db, collectionName, modalOs.id), {
      status: novoStatus,
      statusAntesAguardandoSanear: null,
      slaPausas: pausasFechadas,
      updatedAt: serverTimestamp(),
    });

    void registrarAuditoriaOs({
      osId: modalOs.id,
      origem: modalOs.origem,
      collectionName,
      acao: "RETOMADA_SANEAR",
      titulo: "Terceirizada retomou a OS",
      descricao: "A OS saiu de Aguardando SANEAR e voltou ao fluxo de execução.",
      statusAntes: "AGUARDANDO_SANEAR",
      statusDepois: novoStatus,
    });

    setModalOs((prev) =>
      prev
        ? {
            ...prev,
            status: novoStatus,
            statusAntesAguardandoSanear: null,
            slaPausas: pausasFechadas,
          }
        : prev
    );
  } catch (e) {
    console.error(e);
    setInfoModal({
      title: "Erro",
      message: "Não foi possível retomar a OS. Tente novamente.",
    });
  } finally {
    setIsUpdatingStatus(false);
  }
}

async function handleServicoExecutado() {
    if (!modalOs) return;

    const st = normalizeStatus(modalOs.status);
    if (st === "AGUARDANDO_SANEAR" || hasOpenSanearPause(modalOs.slaPausas)) {
      setInfoModal({
        title: "Aguardando SANEAR",
        message:
          "Esta OS está aguardando uma ação da SANEAR (SLA pausado). Clique em 'SANEAR liberou (retomar)' antes de marcar como concluída.",
      });
      return;
    }

    if (totalFotosExecucao === 0) {
      setShowPhotoUploader(true);
      setInfoModal({
        title: "Foto obrigatória",
        message:
          "Para marcar esta OS como concluída, anexe uma ou duas fotos do serviço executado.",
      });
      return;
    }

    if (totalFotosExecucao > MAX_FOTOS_EXECUCAO) {
      setShowPhotoUploader(true);
      setInfoModal({
        title: "Limite de fotos excedido",
        message: `A OS pode ter no máximo ${MAX_FOTOS_EXECUCAO} fotos do serviço executado. Exclua as fotos excedentes antes de concluir.`,
      });
      return;
    }

    try {
      setIsUpdatingStatus(true);

      const collectionName =
        getCollectionName(modalOs.origem);

      const basePath =
        getStorageBasePath(modalOs.origem);
      const subfolder = "fotos-execucao";

      const agora = new Date();

      const novosItens: any[] = [];

      for (const photo of currentPhotos) {
        const originalName = photo.name || "foto.jpg";
        const safeName = sanitizeForStoragePath(originalName);

        const id = photo.id || generateLocalId();

        const blob = dataUrlToBlob(photo.dataUrl);
        const compactado = await compactBlobToZip(blob, originalName, blob.type || "image/jpeg");
        const path = `${basePath}/${modalOs.id}/${subfolder}/${id}-${compactado.zipFileName || `${safeName}.zip`}`;

        const { error: uploadError } = await supabase.storage
          .from(STORAGE_BUCKET)
          .upload(path, compactado.blob, {
            upsert: false,
            contentType: ZIP_STORAGE_MIME,
          });

        if (uploadError) {
          console.error(uploadError);
          throw new Error(
            `Erro ao enviar foto "${originalName}" compactada em ZIP para o armazenamento.`
          );
        }

        const { data } = supabase.storage
          .from(STORAGE_BUCKET)
          .getPublicUrl(path);

        const url = data.publicUrl;

        const dataAnexoTexto =
          photo.createdAt ||
          agora.toLocaleString("pt-BR", {
            day: "2-digit",
            month: "2-digit",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          });

        novosItens.push({
          id,
          nomeArquivo: originalName,
          dataAnexoTexto,
          url,
          path,
          storagePath: path,
          arquivoCompactado: true,
          nomeArquivoZip: compactado.zipFileName,
          mimeTypeOriginal: compactado.originalMimeType,
          tamanhoOriginal: compactado.originalSize,
          tamanhoCompactado: compactado.zipSize,
        });
      }

      const originalArray: any[] = modalOs.fotosExecucao || [];
      const updatedArray = [...originalArray, ...novosItens];

      await updateDoc(doc(db, collectionName, modalOs.id), {
        status: "CONCLUIDA",
        dataExecucao: serverTimestamp(),
        fotosExecucao: updatedArray,
        finalizadoPorArea: "TERCEIRIZADA",
        finalizadoPorEmail: auth.currentUser?.email?.toLowerCase() ?? null,
        finalizadoPorUid: auth.currentUser?.uid ?? null,
        updatedAt: serverTimestamp(),
      });

      void registrarAuditoriaOs({
        osId: modalOs.id,
        origem: modalOs.origem,
        collectionName,
        acao: "FINALIZACAO_TERCEIRIZADA",
        titulo: "OS finalizada pela terceirizada",
        descricao: `Serviço concluído com ${updatedArray.length} foto(s) de execução.`,
        statusAntes: modalOs.status ?? null,
        statusDepois: "CONCLUIDA",
        detalhes: { fotosExecucao: updatedArray.length, fotosNovas: novosItens.length },
      });

      // Limpa fotos em memória para essa OS
      setPhotosByOsId((prev) => {
        const clone = { ...prev };
        delete clone[modalOs.id];
        return clone;
      });
      setShowPhotoUploader(false);

      // Atualiza o modal com o novo status e fotosExecucao
      setModalOs((prev) =>
        prev && prev.id === modalOs.id
          ? {
              ...prev,
              status: "CONCLUIDA",
              fotosExecucao: updatedArray,
              finalizadoPorArea: "TERCEIRIZADA",
              finalizadoPorEmail: auth.currentUser?.email?.toLowerCase() ?? null,
              finalizadoPorUid: auth.currentUser?.uid ?? null,
            }
          : prev
      );

      setInfoModal({
        title: "Status atualizado",
        message: "A OS foi marcada como serviço executado (concluída).",
      });
    } catch (error: unknown) {
      console.error(error);

      try {
        const collectionName = getCollectionName(modalOs.origem);
        const basePath = getStorageBasePath(modalOs.origem);
        const erroResumo = resumirErroAnexo(error);

        await Promise.all(
          currentPhotos.map((photo) => {
            const originalName = photo.name || "foto.jpg";
            const blob = dataUrlToBlob(photo.dataUrl);

            return salvarAnexoPendente({
              tipo: "FOTO_EXECUCAO",
              osId: modalOs.id,
              collectionName,
              origem: modalOs.origem.toLocaleUpperCase("pt-BR"),
              storageBasePath: basePath,
              storageSubfolder: "fotos-execucao",
              nomeArquivo: originalName,
              mimeType: blob.type || "image/jpeg",
              tamanho: blob.size,
              criadoPorEmail: auth.currentUser?.email?.toLowerCase() ?? null,
              observacao: "Foto de execução salva localmente porque o envio ao Supabase falhou.",
              ultimoErro: erroResumo,
              arquivo: blob,
            });
          })
        );
      } catch (queueError) {
        console.error("Erro ao salvar fotos na fila local", queueError);
      }

      setInfoModal({
        title: "Fotos na fila local",
        message:
          "Não foi possível concluir o envio agora. As fotos ficaram salvas na fila local deste computador para reenvio posterior.",
      });
    } finally {
      setIsUpdatingStatus(false);
    }
  }

  // IMPRIMIR: gera PDF com os dados da OS (tabela) e envia para impressão,
  // igual ao comportamento do "Ver dados" na ListaOrdensServico
  async function handlePrintModal() {
    if (!modalOs) return;

    try {
      const url = await generateOsDataPdfUrl(modalOs);

      const iframe = document.createElement("iframe");
      iframe.style.position = "fixed";
      iframe.style.right = "0";
      iframe.style.bottom = "0";
      iframe.style.width = "0";
      iframe.style.height = "0";
      iframe.style.border = "0";
      iframe.src = url;

      document.body.appendChild(iframe);

      iframe.onload = () => {
        iframe.contentWindow?.focus();
        iframe.contentWindow?.print();
        setTimeout(() => {
          document.body.removeChild(iframe);
          URL.revokeObjectURL(url);
        }, 1000);
      };
    } catch (error) {
      console.error(error);
      setInfoModal({
        title: "Erro ao imprimir",
        message:
          "Não foi possível gerar o PDF com os dados da OS para impressão. Tente novamente.",
      });
    }
  }

  return (
    <section className="page-card terceirizada-page servico-sanear-page terceirizada-executora-page">
      <header className="page-header">
        <div>
          <h2>Área da Terceirizada</h2>
          <p className="page-section-description">
            Área externa para acompanhamento e finalização das ordens de Calçamento e Asfalto.
            As ordens de Caminhão Hidrojato permanecem somente na Área de Serviço SANEAR.
          </p>
        </div>
      </header>

      <div className="terceirizada-banner">
        <div>
          <span className="terceirizada-pill">EXECUÇÃO EXTERNA</span>
          <h2>Fila da terceirizada</h2>
          <p>
            Consulte a OS em PDF, acompanhe o prazo de atendimento e finalize o serviço
            com até duas fotos de execução para comprovação do encerramento.
          </p>

          <div className="servico-sanear-hero-mini">
            <span><b>{totalCalcamento}</b> calçamento</span>
            <span><b>{totalAsfalto}</b> asfalto</span>
            <span><b>{totalConcluidas}</b> finalizada(s)</span>
          </div>
        </div>

        <div className="terceirizada-highlight">
          <div className="terceirizada-icon">🤝</div>
          <div>
            <span>Fila terceirizada</span>
            <strong>{totalAbertas} OS aberta(s)</strong>
          </div>
        </div>
      </div>

      <div className="sla-explainer" role="note">
        <div className="sla-explainer-icon" aria-hidden="true">⏱</div>
        <div className="sla-explainer-content">
          <div className="sla-explainer-title">Prazo de atendimento</div>
          <p className="sla-explainer-text">
            A terceirizada acompanha o SLA das OS abertas. Agora o prazo é calculado por serviço: <strong>Calçamento {SLA_CONFIGS.CALCAMENTO.horas}h</strong> e <strong>Asfalto {SLA_CONFIGS.ASFALTO.horas}h</strong>, com pausa quando a OS estiver aguardando ação da SANEAR.
          </p>
        </div>
        <button type="button" className="sla-explainer-button" onClick={handleOpenSlaDrawer}>
          Ver situação do SLA
        </button>
      </div>

      <div className="os-kpi-row">
        <div className="os-kpi-card servico-sanear-kpi is-open">
          <div>
            <div className="os-kpi-label">OS em aberto</div>
            <div className="os-kpi-value">{totalAbertas}</div>
          </div>
          <span className="os-kpi-pill">Na fila de execução</span>
        </div>

        <div className="os-kpi-card servico-sanear-kpi is-done">
          <div>
            <div className="os-kpi-label">OS concluídas</div>
            <div className="os-kpi-value">{totalConcluidas}</div>
          </div>
          <span className="os-kpi-pill os-kpi-pill-success">Finalizadas</span>
        </div>

        <div className="os-kpi-card servico-sanear-kpi is-total">
          <div>
            <div className="os-kpi-label">Total de OS</div>
            <div className="os-kpi-value">{ordens.length}</div>
          </div>
          <span className="os-kpi-pill os-kpi-pill-neutral">
            {totalCanceladas > 0 ? `${totalCanceladas} cancelada(s)` : "Atualizado em tempo real"}
          </span>
        </div>

        <div
          className={`os-kpi-card os-kpi-card-sla ${slaSnapshot.overdue.length > 0 ? "is-danger" : "is-ok"}`}
          role="button"
          tabIndex={0}
          onClick={handleOpenSlaDrawer}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              handleOpenSlaDrawer();
            }
          }}
          title="Abrir acompanhamento do SLA"
        >
          <div>
            <div className="os-kpi-label">SLA em atraso</div>
            <div className="os-kpi-value">{slaSnapshot.overdue.length}</div>
            <div className="sla-kpi-breakdown">
              <span>{slaSnapshot.nearDue.length} em atenção</span>
              <span>{slaSnapshot.paused.length} pausada(s)</span>
            </div>
          </div>
          <span className={`os-kpi-pill ${slaSnapshot.overdue.length > 0 ? "os-kpi-pill-danger" : "os-kpi-pill-success"}`}>
            {slaSnapshot.overdue.length > 0 ? `${slaSnapshot.overdue.length} atrasada(s)` : "Dentro do prazo"}
          </span>
        </div>
      </div>

      <div className="os-toolbar">
        <div className="os-status-tabs" style={{ marginBottom: "0.5rem" }}>
          <button
            type="button"
            className={`os-status-tab ${statusTab === "OPEN" ? "is-active" : ""}`}
            onClick={() => {
              setStatusTab("OPEN");
              setCategoryFilter("ALL");
            }}
          >
            Abertas ({totalAbertas})
          </button>
          <button
            type="button"
            className={`os-status-tab ${statusTab === "DONE" ? "is-active" : ""}`}
            onClick={() => {
              setStatusTab("DONE");
              setCategoryFilter("ALL");
            }}
          >
            Concluídas ({totalConcluidas})
          </button>
          <button
            type="button"
            className={`os-status-tab ${statusTab === "ALL" ? "is-active" : ""}`}
            onClick={() => {
              setStatusTab("ALL");
              setCategoryFilter("ALL");
            }}
          >
            Todas ({ordens.length})
          </button>
        </div>

        <div className="terceirizada-filter-row">
          {tiposCategoriaOrdenados.length > 0 && (
            <div className="os-category-tabs">
              <button
                type="button"
                className={`os-category-tab ${categoryFilter === "ALL" ? "is-active" : ""}`}
                onClick={() => setCategoryFilter("ALL")}
              >
                TODOS OS SERVIÇOS ({porStatus.length})
              </button>

              {tiposCategoriaOrdenados.map((tipo) => {
                const label = tipoLabelMap[tipo] || tipo || "OUTRO";
                const count = countsPorTipo[tipo];

                return (
                  <button
                    key={tipo}
                    type="button"
                    className={`os-category-tab ${categoryFilter === tipo ? "is-active" : ""}`}
                    onClick={() => setCategoryFilter(tipo)}
                  >
                    {label} ({count})
                  </button>
                );
              })}
            </div>
          )}

          <div className="os-search">
            <input
              className="os-search-input"
              type="text"
              placeholder="Buscar por protocolo, OS, bairro, rua ou data..."
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
            />
          </div>
        </div>
      </div>

      <div className="os-main">
        {loading && <div className="os-empty">Carregando ordens da terceirizada...</div>}

        {!loading && filtradas.length === 0 && (
          <div className="os-empty">Nenhuma ordem encontrada para os filtros atuais.</div>
        )}

        {!loading && filtradas.length > 0 && (
          <section className="os-group-section">
            <div className="os-group-header">
              <div>
                <span className="os-badge os-badge-terceirizada">SERVIÇOS DA TERCEIRIZADA</span>
              </div>
              <span className="os-group-count">
                {filtradas.length} OS {statusTab === "OPEN" ? "em aberto" : statusTab === "DONE" ? "concluída(s)" : "encontrada(s)"}
              </span>
            </div>

            <AppPagination
              currentPage={currentPage}
              totalPages={totalPages}
              totalItems={filtradas.length}
              pageStart={paginationStart}
              pageEnd={paginationEnd}
              onPageChange={setCurrentPage}
              variant="top"
              label="OS"
            />

            {tiposOrdenados.map((tipo) => {
              const lista = gruposPorTipo[tipo];
              const label = tipoLabelMap[tipo] || tipo || "OUTRO";
              const badgeClass = tipoBadgeClassMap[tipo] || "os-badge os-badge-outro";

              return (
                <div key={tipo} className="terceirizada-page-group">
                  <div className="os-group-header os-group-header-sub">
                    <span className={badgeClass}>{label}</span>
                    <span className="os-group-count">{lista.length} nesta página</span>
                  </div>

                  <div className="os-list">
                    {lista.map((os) => (
                      <article
                        key={os.id}
                        className={`os-card servico-sanear-os-card terceirizada-os-card ${isDoneStatus(os.status) ? "is-done" : "is-open"}`}
                        onClick={() => handleOpenOsModal(os)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            handleOpenOsModal(os);
                          }
                        }}
                      >
                        <div className="os-card-header servico-sanear-card-header">
                          <div>
                            <span className="servico-sanear-card-eyebrow">{label}</span>
                            <h3>{os.ordemServico || os.protocolo || "OS sem número"}</h3>
                            <p className="os-card-address">
                              {[
                                os.rua,
                                os.numero ? "nº " + os.numero : "",
                                os.bairro ? "– " + os.bairro : "",
                              ].filter(Boolean).join(" ") || "Endereço não informado"}
                            </p>
                          </div>

                          <div className="servico-sanear-status-area">
                            <span className={statusClass(os.status)}>{formatStatusLabel(os.status)}</span>
                            {hasAttachedPdf(os) ? (
                              <span className="servico-sanear-pdf-chip">PDF anexado</span>
                            ) : (
                              <span className="servico-sanear-pdf-chip is-missing">Sem PDF</span>
                            )}
                          </div>
                        </div>

                        <div className="servico-sanear-card-info">
                          <div>
                            <span>Criada em</span>
                            <strong>{formatCreatedAt(os.createdAt)}</strong>
                          </div>
                          <div>
                            <span>Execução</span>
                            <strong>{formatCreatedAt(os.dataExecucao)}</strong>
                          </div>
                          <div>
                            <span>Fotos</span>
                            <strong>{Array.isArray(os.fotosExecucao) ? os.fotosExecucao.length : 0}/{MAX_FOTOS_EXECUCAO}</strong>
                          </div>
                        </div>

                        {os.createdByEmail && (
                          <div className="servico-sanear-created-by">Responsável pelo cadastro: {os.createdByEmail}</div>
                        )}

                        <div className="servico-sanear-card-actions">
                          <button type="button" className="btn-secondary" onClick={(event) => handleOpenPdf(os, event)}>
                            Abrir PDF
                          </button>
                          <button
                            type="button"
                            className="btn-primary"
                            onClick={(event) => {
                              event.stopPropagation();
                              handleOpenOsModal(os);
                            }}
                          >
                            Ver dados
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                </div>
              );
            })}

            <AppPagination
              currentPage={currentPage}
              totalPages={totalPages}
              totalItems={filtradas.length}
              onPageChange={setCurrentPage}
              variant="bottom"
              label="OS"
            />
          </section>
        )}
      </div>

      {/* DRAWER – acompanhamento do prazo de atendimento */}
      {slaOpen && (
        <div
          className="modal-backdrop sla-backdrop"
          onClick={() => setSlaOpen(false)}
        >
          <div className="sla-drawer" onClick={(e) => e.stopPropagation()}>
            <div className="sla-drawer-header">
              <div>
                <h3 className="sla-title">Prazo de atendimento (SLA)</h3>
                <p className="sla-subtitle">
                  Acompanhe as OS que estão dentro do prazo, próximas do limite,
                  atrasadas ou com a contagem pausada.
                </p>
              </div>

              <button
                type="button"
                className="modal-close"
                onClick={() => setSlaOpen(false)}
                aria-label="Fechar acompanhamento do SLA"
              >
                ×
              </button>
            </div>

            <div className="sla-drawer-body">
              <div className="sla-definition-box">
                <div className="sla-definition-icon" aria-hidden="true">
                  ⏱
                </div>
                <div>
                  <strong>SLA é o prazo máximo para atender uma OS.</strong>
                  <p>
                    O prazo é definido conforme o serviço: Calçamento {SLA_CONFIGS.CALCAMENTO.horas}h e Asfalto {SLA_CONFIGS.ASFALTO.horas}h. A contagem ocorre de segunda a sexta, em horas corridas; sábado e domingo não contam. Quando a OS está em “Aguardando SANEAR”, o relógio fica pausado.
                  </p>
                </div>
              </div>

              <div className="sla-metrics sla-metrics-four">
                <div className="sla-metric sla-metric-ok">
                  <div className="sla-metric-label">Dentro do prazo</div>
                  <div className="sla-metric-value">{slaSnapshot.onTime.length}</div>
                </div>
                <div className="sla-metric sla-metric-warning">
                  <div className="sla-metric-label">Em atenção</div>
                  <div className="sla-metric-value">{slaSnapshot.nearDue.length}</div>
                </div>
                <div className="sla-metric sla-metric-danger">
                  <div className="sla-metric-label">Atrasadas</div>
                  <div className="sla-metric-value">{slaSnapshot.overdue.length}</div>
                </div>
                <div className="sla-metric sla-metric-paused">
                  <div className="sla-metric-label">Pausadas</div>
                  <div className="sla-metric-value">{slaSnapshot.paused.length}</div>
                </div>
              </div>

              {slaSnapshot.totalOpen === 0 && (
                <div className="sla-empty">
                  Não há ordens de serviço abertas para acompanhamento.
                </div>
              )}

              {slaSnapshot.overdue.length > 0 && (
                <div className="sla-section">
                  <div className="sla-section-title">
                    ⚠ Atrasadas
                  </div>
                  <p className="sla-section-description">
                    Estas OS ultrapassaram o prazo definido e devem ser
                    priorizadas.
                  </p>

                  <div className="sla-list">
                    {slaSnapshot.overdue.map(
                      ({
                        os,
                        ageMs,
                        overdueByMs,
                        progressPercent,
                        slaHoras,
                        slaConfig,
                      }) => {
                        const ident =
                          os.ordemServico || os.protocolo || os.id;
                        const address =
                          [
                            os.rua,
                            os.numero ? "nº " + os.numero : "",
                            os.bairro ? " – " + os.bairro : "",
                          ]
                            .filter(Boolean)
                            .join(" ") || "Endereço não informado";

                        return (
                          <button
                            key={`${os.origem}:${os.id}`}
                            type="button"
                            className="sla-item"
                            onClick={() => navigateToListaOsHighlight(os)}
                          >
                            <div className="sla-item-content">
                              <div className="sla-item-main">
                                <div className="sla-item-ident">{ident}</div>
                                <div className="sla-item-sub">
                                  {address} • criada em{" "}
                                  {formatCreatedAt(os.createdAt)}
                                </div>
                              </div>

                              <div className="sla-item-side">
                                <div className="sla-item-age">
                                  Atrasada há{" "}
                                  {formatBusinessDuration(overdueByMs)}
                                </div>
                                <div className="sla-item-limit">
                                  {formatBusinessDuration(ageMs)} consumidas de{" "}
                                  {slaHoras}h • {slaConfig.label}
                                </div>
                              </div>
                            </div>

                            <div
                              className="sla-progress sla-progress-danger"
                              aria-label={`${progressPercent}% do prazo consumido`}
                            >
                              <span style={{ width: `${progressPercent}%` }} />
                            </div>
                          </button>
                        );
                      }
                    )}
                  </div>
                </div>
              )}

              {slaSnapshot.nearDue.length > 0 && (
                <div className="sla-section">
                  <div className="sla-section-title">
                    ⏳ Em atenção
                  </div>
                  <p className="sla-section-description">
                    Estas OS já consumiram pelo menos 75% do prazo.
                  </p>

                  <div className="sla-list">
                    {slaSnapshot.nearDue.map(
                      ({
                        os,
                        ageMs,
                        remainingMs,
                        progressPercent,
                        slaHoras,
                        slaConfig,
                      }) => {
                        const ident =
                          os.ordemServico || os.protocolo || os.id;
                        const address =
                          [
                            os.rua,
                            os.numero ? "nº " + os.numero : "",
                            os.bairro ? " – " + os.bairro : "",
                          ]
                            .filter(Boolean)
                            .join(" ") || "Endereço não informado";

                        return (
                          <button
                            key={`${os.origem}:${os.id}`}
                            type="button"
                            className="sla-item sla-item-soon"
                            onClick={() => navigateToListaOsHighlight(os)}
                          >
                            <div className="sla-item-content">
                              <div className="sla-item-main">
                                <div className="sla-item-ident">{ident}</div>
                                <div className="sla-item-sub">
                                  {address} • criada em{" "}
                                  {formatCreatedAt(os.createdAt)}
                                </div>
                              </div>

                              <div className="sla-item-side">
                                <div className="sla-item-age">
                                  Restam {formatBusinessDuration(remainingMs)}
                                </div>
                                <div className="sla-item-limit">
                                  {formatBusinessDuration(ageMs)} consumidas de{" "}
                                  {slaHoras}h • {slaConfig.label}
                                </div>
                              </div>
                            </div>

                            <div
                              className="sla-progress sla-progress-warning"
                              aria-label={`${progressPercent}% do prazo consumido`}
                            >
                              <span style={{ width: `${progressPercent}%` }} />
                            </div>
                          </button>
                        );
                      }
                    )}
                  </div>
                </div>
              )}

              {slaSnapshot.paused.length > 0 && (
                <div className="sla-section">
                  <div className="sla-section-title">
                    ⏸ Aguardando SANEAR
                  </div>
                  <p className="sla-section-description">
                    A contagem está parada e será retomada após a liberação da
                    SANEAR.
                  </p>

                  <div className="sla-list">
                    {slaSnapshot.paused.map(({ os, ageMs, slaHoras }) => {
                      const ident =
                        os.ordemServico || os.protocolo || os.id;
                      const address =
                        [
                          os.rua,
                          os.numero ? "nº " + os.numero : "",
                          os.bairro ? " – " + os.bairro : "",
                        ]
                          .filter(Boolean)
                          .join(" ") || "Endereço não informado";
                      const pausa = getOpenSanearPause(os.slaPausas);

                      return (
                        <button
                          key={`${os.origem}:${os.id}`}
                          type="button"
                          className="sla-item sla-item-paused"
                          onClick={() => navigateToListaOsHighlight(os)}
                        >
                          <div className="sla-item-content">
                            <div className="sla-item-main">
                              <div className="sla-item-ident">{ident}</div>
                              <div className="sla-item-sub">
                                {address}
                              </div>
                              <div className="sla-item-reason">
                                {formatPauseReason(pausa)}
                              </div>
                            </div>

                            <div className="sla-item-side">
                              <div className="sla-item-age">SLA pausado</div>
                              <div className="sla-item-limit">
                                {formatBusinessDuration(ageMs)} consumidas de{" "}
                                {slaHoras}h
                              </div>
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {slaSnapshot.overdue.length === 0 &&
                slaSnapshot.nearDue.length === 0 &&
                slaSnapshot.paused.length === 0 &&
                slaSnapshot.totalOpen > 0 && (
                  <div className="sla-empty sla-empty-success">
                    Todas as OS abertas estão dentro do prazo de atendimento.
                  </div>
                )}
            </div>

            <div className="sla-drawer-footer">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setSlaOpen(false)}
              >
                Fechar
              </button>

              <button
                type="button"
                className="btn-primary"
                onClick={() => {
                  window.dispatchEvent(
                    new CustomEvent("sanear:navigate", {
                      detail: { menu: "listaOS" },
                    })
                  );
                  setSlaOpen(false);
                }}
              >
                Abrir Lista de OS
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL DE DETALHES DA OS */}
      {modalOs && (
        <div className="modal-backdrop" onClick={handleCloseModal}>
          <div
            className="modal modal-photo"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h3 className="modal-title">
                Detalhes da OS –{" "}
                {modalOs.protocolo ||
                  modalOs.ordemServico ||
                  "Sem identificação"}
              </h3>
              <button
                type="button"
                className="modal-close"
                onClick={handleCloseModal}
              >
                ×
              </button>
            </div>

            <div className="modal-body modal-photo-body">
              <div className="page-form-grid">
                <div className="page-field">
                  <label>Tipo</label>
                  <input
                    className="field-readonly"
                    value={
                      tipoLabelMap[modalOs.tipo || ""] ||
                      modalOs.tipo ||
                      "-"
                    }
                    readOnly
                  />
                </div>

                <div className="page-field">
                  <label>Protocolo</label>
                  <input
                    className="field-readonly"
                    value={modalOs.protocolo || "-"}
                    readOnly
                  />
                </div>

                <div className="page-field">
                  <label>Ordem de serviço</label>
                  <input
                    className="field-readonly"
                    value={modalOs.ordemServico || "-"}
                    readOnly
                  />
                </div>

                <div className="page-field">
                  <label>Status atual</label>
                  <input
                    className="field-readonly"
                    value={formatStatusLabel(modalOs.status)}
                    readOnly
                  />
                </div>

                <div className="page-field">
                  <label>Endereço</label>
                  <input
                    className="field-readonly"
                    value={
                      [
                        modalOs.rua,
                        modalOs.numero ? "nº " + modalOs.numero : "",
                        modalOs.bairro ? " – " + modalOs.bairro : "",
                      ]
                        .filter(Boolean)
                        .join(" ") || "-"
                    }
                    readOnly
                  />
                </div>

                <div className="page-field">
                  <label>Ponto de referência</label>
                  <input
                    className="field-readonly"
                    value={modalOs.pontoReferencia || "-"}
                    readOnly
                  />
                </div>
              </div>

              <div className="page-field">
                <label>Observações</label>
                <textarea
                  className="field-readonly"
                  value={modalOs.observacoes || "-"}
                  readOnly
                  rows={3}
                />
              </div>

              {isDoneStatus(modalOs.status) ? (
                <div className="page-section terceirizada-execution-summary">
                  <h3>Resumo da execução</h3>
                  <p className="page-section-description">
                    Esta OS já foi finalizada pela terceirizada. Para conferir as imagens, use a coluna Fotos na listagem principal.
                  </p>
                  <div className="servico-sanear-summary-grid">
                    <div>
                      <span>Status</span>
                      <strong>{formatStatusLabel(modalOs.status)}</strong>
                    </div>
                    <div>
                      <span>Finalizada em</span>
                      <strong>{formatCreatedAt(modalOs.dataExecucao)}</strong>
                    </div>
                    <div>
                      <span>Fotos registradas</span>
                      <strong>{fotosExecucaoJaSalvas}/{MAX_FOTOS_EXECUCAO}</strong>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="page-section">
                  <h3>Fotos do serviço executado</h3>
                  <p className="page-section-description">
                    Para concluir a OS, anexe uma ou duas fotos do serviço executado.
                    Não é permitido anexar mais de duas imagens.
                  </p>

                  <div className="execution-photo-limit">
                    <span>Fotos anexadas</span>
                    <strong>{totalFotosExecucao}/{MAX_FOTOS_EXECUCAO}</strong>
                  </div>

                  {currentPhotos.length > 0 ? (
                    <div className="page-photos-block">
                      <div className="photo-preview-grid">
                        {currentPhotos.map((p) => (
                          <div key={p.id} className="photo-preview-item">
                            <img src={p.dataUrl} alt={p.name} />
                            <span className="photo-timestamp">{p.createdAt}</span>
                            <button
                              type="button"
                              className="btn-danger"
                              style={{
                                position: "absolute",
                                top: "0.3rem",
                                right: "0.3rem",
                                padding: "0.1rem 0.5rem",
                                fontSize: "0.7rem",
                              }}
                              onClick={() => handleRemoveModalPhoto(p.id)}
                            >
                              Excluir
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <p className="photo-hint">Nenhuma foto anexada ainda para esta OS.</p>
                  )}

                  {vagasFotosExecucao > 0 && (
                    <div className="page-photos-block" style={{ marginTop: "0.6rem" }}>
                      <div className="photo-upload">
                        <label htmlFor="upload-fotos-modal" className="btn-secondary">
                          📷 Adicionar foto{vagasFotosExecucao > 1 ? "s" : ""} ({vagasFotosExecucao} restante{vagasFotosExecucao > 1 ? "s" : ""})
                        </label>
                        <input
                          id="upload-fotos-modal"
                          type="file"
                          accept="image/jpeg,image/png,image/webp,image/jpg"
                          multiple
                          onChange={handleModalFilesChange}
                          style={{ display: "none" }}
                        />
                        {showPhotoUploader && totalFotosExecucao === 0 && (
                          <p className="photo-hint">
                            Anexe uma ou duas fotos do serviço executado para concluir esta OS.
                          </p>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="modal-footer">
              <button
                type="button"
                className="btn-secondary"
                onClick={handlePrintModal}
              >
                Imprimir
              </button>
              {isDoneStatus(modalOs.status) ? (
                <button type="button" className="btn-primary" disabled>
                  Serviço já finalizado
                </button>
              ) : normalizeStatus(modalOs.status) === "AGUARDANDO_SANEAR" ? (
                <button
                  type="button"
                  className="btn-primary"
                  onClick={handleRetomarSanear}
                  disabled={isUpdatingStatus}
                >
                  {isUpdatingStatus ? "Atualizando..." : "SANEAR liberou (retomar)"}
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => setAguardandoSanearOpen(true)}
                    disabled={isUpdatingStatus}
                  >
                    Aguardando SANEAR
                  </button>
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={handleServicoExecutado}
                    disabled={isUpdatingStatus}
                  >
                    {isUpdatingStatus ? "Atualizando..." : "Finalizar serviço"}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* MODAL: Aguardando SANEAR (justificativa) */}
      {modalOs && aguardandoSanearOpen && (
        <div className="modal-backdrop" onClick={() => setAguardandoSanearOpen(false)}>
          <div className="modal" style={{ maxWidth: 720, width: "92%" }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Aguardando SANEAR</h3>
              <button type="button" className="modal-close" onClick={() => setAguardandoSanearOpen(false)}>
                ×
              </button>
            </div>

            <div className="modal-body">
              <div className="page-field" style={{ marginBottom: 12 }}>
                <label>Motivo</label>
                <select
                  className="field-readonly"
                  value={aguardandoMotivo}
                  onChange={(e) => setAguardandoMotivo(e.target.value)}
                >
                  <option value="SERVICO_PREVIO">Serviço prévio da SANEAR</option>
                  <option value="BLOQUEIO_ACESSO">Bloqueio / sem acesso</option>
                  <option value="AGUARDANDO_MATERIAL">Aguardando material / equipe</option>
                  <option value="OUTRO">Outro</option>
                </select>
              </div>

              <div className="page-field">
                <label>Descrição (curta e objetiva)</label>
                <textarea
                  className="field-readonly"
                  rows={3}
                  value={aguardandoDescricao}
                  onChange={(e) => setAguardandoDescricao(e.target.value)}
                  placeholder="Ex.: SANEAR precisa realizar serviço antes da execução desta OS."
                />
              </div>
            </div>

            <div className="modal-footer">
              <button type="button" className="btn-secondary" onClick={() => setAguardandoSanearOpen(false)} disabled={isUpdatingStatus}>
                Cancelar
              </button>
              <button type="button" className="btn-primary" onClick={handleMarcarAguardandoSanear} disabled={isUpdatingStatus}>
                {isUpdatingStatus ? "Salvando..." : "Confirmar"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL DE AVISO / ERRO */}
      {infoModal && (
        <div className="modal-backdrop" onClick={() => setInfoModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">{infoModal.title}</h3>
              <button
                type="button"
                className="modal-close"
                onClick={() => setInfoModal(null)}
              >
                ×
              </button>
            </div>
            <div className="modal-body">
              <p>{infoModal.message}</p>
            </div>
            <div className="modal-footer">
              <button
                type="button"
                className="btn-primary"
                onClick={() => setInfoModal(null)}
              >
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};

export default TerceirizadaVisao;
