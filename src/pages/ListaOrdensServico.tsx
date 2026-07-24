import React, {
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type MouseEvent,
  useRef,
} from "react";
import {
  collection,
  onSnapshot,
  orderBy,
  query,
  doc,
  deleteDoc,
  updateDoc,
  serverTimestamp,
  Timestamp,
  arrayUnion,
} from "firebase/firestore";
import { db, auth } from "../lib/firebaseClient";
import { supabase } from "../lib/supabaseClient";
import {
  compactFileToZip,
  extractFirstFileObjectUrlFromZipUrl,
  inferMimeTypeByName,
  isZipReference,
  ZIP_STORAGE_MIME,
} from "../lib/storageZip";
import { upsertSanearPause, closeSanearPause, hasOpenSanearPause } from "../lib/sla";
import {
  assinarAuditoriaOs,
  registrarAuditoriaOs,
  type AuditoriaEvento,
} from "../lib/auditoria";
import { salvarAnexoPendente, resumirErroAnexo } from "../lib/anexosPendentes";
import {
  formatOrdemStatusLabel,
  isOrdemAguardandoSanear,
  isOrdemFechada,
  normalizeOrdemStatus,
} from "../lib/status";
import { AppPagination } from "../components/ui";

// pdf-lib para gerar o PDF com os dados da OS
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const STORAGE_BUCKET = "os-arquivos";

type OrigemOS = "buraco" | "asfalto" | "hidrojato";

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
  tipoCaminhaoExecucao?: string | null;
  tipoCaminhaoExecucaoLabel?: string | null;
  finalizadoPorArea?: string | null;
  finalizadoPorEmail?: string | null;

  // SLA (72h) e pausa SANEAR
  slaHoras?: number | null;
  slaPausas?: any[] | null;
  statusAntesAguardandoSanear?: string | null;

  // ainda mantido por compatibilidade, mas não usado para gerar o PDF de dados
  ordemServicoPdfBase64?: string | null;
  ordemServicoPdfNomeArquivo?: string | null;
  ordemServicoPdfDataAnexo?: string | null;
  ordemServicoPdfUrl?: string | null;
  ordemServicoPdfPath?: string | null;
  ordemServicoPdfCompactado?: boolean | null;
  ordemServicoPdfMimeTypeOriginal?: string | null;

  // fotos
  fotos?: any[] | null; // operador (abertura)
  fotosExecucao?: any[] | null; // terceirizada (execução)
};

type StatusType = "success" | "error" | "info";

type StatusFiltroOs = "TODAS" | "ABERTAS" | "FECHADAS";
type TipoFiltroOs =
  | "TODOS"
  | "BURACO_RUA"
  | "ASFALTO"
  | "HIDROJATO"
  | "ESGOTO_RETORNANDO"
  | "ESGOTO_ENTUPIDO";
type OrdenacaoCampoOs = "createdAt" | "dataExecucao";
type OrdenacaoDirecaoOs = "asc" | "desc";

type NormalizedPhoto = {
  id: string;
  label: string;
  url: string;
  sourceIndex: number; // índice original no array salvo no Firestore
  storagePath?: string | null;
  nomeArquivo?: string;
  arquivoCompactado?: boolean;
  mimeTypeOriginal?: string | null;
};

type PhotoModalTipo = "abertura" | "execucao";

type PhotoModalState = {
  osId: string;
  origem: OrigemOS;
  tipo: PhotoModalTipo;
  currentIndex: number;
};

type PrintPhotoState = {
  title: string;
  url: string;
  shouldRevoke?: boolean;
} | null;

// FRONTEND APENAS: labels amigáveis
const tipoLabelMap: Record<string, string> = {
  BURACO_RUA: "CALÇAMENTO",
  CALCAMENTO: "CALÇAMENTO",
  ASFALTO: "ASFALTO",
  HIDROJATO: "CAMINHÃO HIDROJATO",
  CAMINHAO_HIDROJATO: "CAMINHÃO HIDROJATO",
  ESGOTO_RETORNANDO: "ESGOTO RETORNANDO",
  ESGOTO_ENTUPIDO: "ESGOTO ENTUPIDO",
};

const tipoFiltroOptions: { value: TipoFiltroOs; label: string }[] = [
  { value: "TODOS", label: "TODOS OS SERVIÇOS" },
  { value: "BURACO_RUA", label: "CALÇAMENTO" },
  { value: "ASFALTO", label: "ASFALTO" },
  { value: "HIDROJATO", label: "CAMINHÃO HIDROJATO" },
  { value: "ESGOTO_RETORNANDO", label: "ESGOTO RETORNANDO" },
  { value: "ESGOTO_ENTUPIDO", label: "ESGOTO ENTUPIDO" },
];

const origemLabelMap: Record<OrigemOS, string> = {
  buraco: "CALÇAMENTO",
  asfalto: "ASFALTO",
  hidrojato: "CAMINHÃO HIDROJATO",
};

function getOrigemLabel(origem: OrigemOS): string {
  return origemLabelMap[origem] || "Ordem de Serviço";
}

function normalizeTipoOs(os: Pick<FirestoreOS, "tipo" | "origem">): TipoFiltroOs {
  const rawTipo = String(os.tipo ?? "").trim().toUpperCase();

  if (rawTipo === "BURACO_RUA" || rawTipo === "CALCAMENTO") return "BURACO_RUA";
  if (rawTipo === "ASFALTO") return "ASFALTO";
  if (rawTipo === "HIDROJATO" || rawTipo === "CAMINHAO_HIDROJATO") return "HIDROJATO";
  if (rawTipo === "ESGOTO_RETORNANDO") return "ESGOTO_RETORNANDO";
  if (rawTipo === "ESGOTO_ENTUPIDO") return "ESGOTO_ENTUPIDO";

  if (os.origem === "buraco") return "BURACO_RUA";
  if (os.origem === "asfalto") return "ASFALTO";
  if (os.origem === "hidrojato") return "HIDROJATO";

  return "BURACO_RUA";
}

function getTipoOsLabel(os: Pick<FirestoreOS, "tipo" | "origem">): string {
  const tipoNormalizado = normalizeTipoOs(os);
  return (
    tipoLabelMap[tipoNormalizado] ||
    tipoLabelMap[String(os.tipo || "").trim().toUpperCase()] ||
    getOrigemLabel(os.origem)
  ).toUpperCase();
}

function getCaminhaoExecucaoLabel(os: FirestoreOS): string {
  if (os.tipoCaminhaoExecucaoLabel) return os.tipoCaminhaoExecucaoLabel;
  const tipo = String(os.tipoCaminhaoExecucao ?? "").toUpperCase();
  if (tipo === "PROPRIO") return "Caminhão próprio";
  if (tipo === "TERCEIRIZADO") return "Caminhão terceirizado";
  return "-";
}

function getCollectionName(origem: OrigemOS): "ordens_servico" | "ordensServico" | "ordensHidrojato" {
  if (origem === "asfalto") return "ordensServico";
  if (origem === "hidrojato") return "ordensHidrojato";
  return "ordens_servico";
}

function getStorageBasePath(origem: OrigemOS): string {
  if (origem === "asfalto") return "asfalto";
  if (origem === "hidrojato") return "hidrojato";
  return "buraco-rua";
}

function formatDateTime(value?: Timestamp | null): string {
  try {
    if (!value) return "-";
    const date = value.toDate();
    return date.toLocaleString("pt-BR", {
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

function formatAuditDate(value?: Timestamp | null): string {
  if (!value) return "Agora";
  return formatDateTime(value);
}

// Para usar no <input type="datetime-local" />
function toDateTimeLocal(value?: Timestamp | null): string {
  if (!value) return "";
  const d = value.toDate();
  const pad = (n: number) => String(n).padStart(2, "0");
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const mi = pad(d.getMinutes());
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

// Evita problemas de fuso/parse do Date() com string ISO sem timezone
function fromDateTimeLocal(value: string): Date {
  const [datePart, timePart] = value.split("T");
  const [y, m, d] = datePart.split("-").map(Number);
  const [hh, mm] = (timePart || "00:00").split(":").map(Number);
  return new Date(y, m - 1, d, hh, mm, 0, 0);
}

function isAdmRole(role?: string | null): boolean {
  const r = (role ?? "").toUpperCase();
  return r === "ADMIN" || r === "ADM";
}

/**
 * CORREÇÃO: prioriza URL/publicUrl/downloadURL antes de base64,
 * evitando mostrar foto errada quando existir ambos.
 */
function normalizeFotos(fotos: any): NormalizedPhoto[] {
  if (!Array.isArray(fotos)) return [];
  return fotos
    .map((f, index) => {
      if (!f) return null;

      const url =
        (typeof f.url === "string" && f.url) ||
        (typeof f.publicUrl === "string" && f.publicUrl) ||
        (typeof f.downloadURL === "string" && f.downloadURL) ||
        (typeof f.base64 === "string" && f.base64) ||
        (typeof f === "string" ? f : "");

      if (!url) return null;

      const nomeArquivo =
        typeof f.nomeArquivo === "string" ? f.nomeArquivo : `Foto ${index + 1}`;
      const dataTexto =
        typeof f.dataAnexoTexto === "string"
          ? f.dataAnexoTexto
          : typeof f.timestamp === "string"
          ? f.timestamp
          : "";

      const label = dataTexto ? `${nomeArquivo} – ${dataTexto}` : nomeArquivo;
      const id = typeof f.id === "string" ? f.id : String(index);

      const storagePath =
        typeof f.storagePath === "string"
          ? f.storagePath
          : typeof f.path === "string"
          ? f.path
          : null;
      const arquivoCompactado =
        Boolean(f.arquivoCompactado || f.compactadoZip || f.zip) ||
        isZipReference(url) ||
        isZipReference(storagePath);
      const mimeTypeOriginal =
        typeof f.mimeTypeOriginal === "string" ? f.mimeTypeOriginal : null;

      return {
        id,
        label,
        url,
        sourceIndex: index,
        storagePath,
        nomeArquivo,
        arquivoCompactado,
        mimeTypeOriginal,
      } as NormalizedPhoto;
    })
    .filter((p): p is NormalizedPhoto => p !== null);
}

// helper para quebrar o texto dentro da largura no PDF
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

function sanitizeForStoragePath(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9.\-_]/g, "_");
}

function getPdfNested(raw: any): Record<string, any> | null {
  return raw && typeof raw.ordemServicoPdf === "object" && raw.ordemServicoPdf !== null
    ? raw.ordemServicoPdf
    : null;
}

function resolveRawPdfUrl(raw: any, pdfNested: Record<string, any> | null): string | null {
  return (
    raw.ordemServicoPdfUrl ??
    raw.osPdfUrl ??
    raw.pdfUrl ??
    (typeof raw.ordemServicoPdf === "string" ? raw.ordemServicoPdf : null) ??
    pdfNested?.url ??
    pdfNested?.publicUrl ??
    pdfNested?.downloadURL ??
    null
  );
}

function resolveRawPdfPath(raw: any, pdfNested: Record<string, any> | null): string | null {
  return raw.ordemServicoPdfPath ?? raw.osPdfPath ?? pdfNested?.path ?? null;
}

function resolveRawPdfCompactado(raw: any, pdfNested: Record<string, any> | null): boolean {
  return Boolean(
    raw.ordemServicoPdfCompactado ??
      raw.osPdfCompactado ??
      pdfNested?.arquivoCompactado ??
      pdfNested?.compactadoZip ??
      false
  );
}

function resolveRawPdfMimeTypeOriginal(raw: any, pdfNested: Record<string, any> | null): string | null {
  return raw.ordemServicoPdfMimeTypeOriginal ?? pdfNested?.mimeTypeOriginal ?? null;
}

function resolveRawPdfBase64(raw: any, pdfNested: Record<string, any> | null): string | null {
  return raw.ordemServicoPdfBase64 ?? raw.osPdfBase64 ?? pdfNested?.base64 ?? null;
}

function resolveRawPdfNomeArquivo(raw: any, pdfNested: Record<string, any> | null): string | null {
  return (
    raw.ordemServicoPdfNomeArquivo ??
    raw.osPdfNomeArquivo ??
    pdfNested?.nomeArquivo ??
    pdfNested?.name ??
    null
  );
}

function resolveRawPdfDataAnexo(raw: any, pdfNested: Record<string, any> | null): string | null {
  return raw.ordemServicoPdfDataAnexo ?? raw.osPdfDataAnexo ?? pdfNested?.dataAnexoTexto ?? null;
}

function base64PdfToObjectUrl(base64OrDataUrl: string): string {
  const base64 = base64OrDataUrl.includes(",")
    ? base64OrDataUrl.split(",").pop() || ""
    : base64OrDataUrl;

  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  const blob = new Blob([bytes], { type: "application/pdf" });
  return URL.createObjectURL(blob);
}

function hasAttachedPdf(os: FirestoreOS): boolean {
  return Boolean(os.ordemServicoPdfUrl || os.ordemServicoPdfPath || os.ordemServicoPdfBase64);
}

async function resolveAttachedPdfUrl(os: FirestoreOS): Promise<{ url: string; shouldRevoke: boolean } | null> {
  const rawUrl = os.ordemServicoPdfUrl || null;
  const rawPath = os.ordemServicoPdfPath || null;
  const isZipped = Boolean(os.ordemServicoPdfCompactado) || isZipReference(rawUrl) || isZipReference(rawPath);

  if (rawUrl) {
    if (isZipped) {
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
      if (isZipped) {
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

async function resolvePhotoDisplayUrl(photo: NormalizedPhoto): Promise<{ url: string; shouldRevoke: boolean }> {
  const zipped = Boolean(photo.arquivoCompactado) || isZipReference(photo.url) || isZipReference(photo.storagePath);

  if (!zipped) {
    return { url: photo.url, shouldRevoke: false };
  }

  const extracted = await extractFirstFileObjectUrlFromZipUrl(
    photo.url,
    photo.mimeTypeOriginal || inferMimeTypeByName(photo.nomeArquivo || "foto.jpg", "image/jpeg")
  );

  return { url: extracted.url, shouldRevoke: true };
}

type ZipAwarePhotoProps = {
  photo: NormalizedPhoto;
  style?: React.CSSProperties;
};

function ZipAwarePhoto({ photo, style }: ZipAwarePhotoProps) {
  const [src, setSrc] = useState(photo.url);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;

    setSrc(photo.url);
    setError(null);

    if (!photo.arquivoCompactado && !isZipReference(photo.url) && !isZipReference(photo.storagePath)) {
      return () => undefined;
    }

    resolvePhotoDisplayUrl(photo)
      .then((result) => {
        if (!active) {
          if (result.shouldRevoke) URL.revokeObjectURL(result.url);
          return;
        }
        objectUrl = result.shouldRevoke ? result.url : null;
        setSrc(result.url);
      })
      .catch((err) => {
        console.error(err);
        if (active) setError("Não foi possível abrir a foto compactada.");
      });

    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [photo]);

  if (error) {
    return <div className="field-hint">{error}</div>;
  }

  return <img src={src} alt={photo.label} style={style} />;
}

/**
 * PASSO 3: limpa arquivos do Supabase Storage ao excluir OS
 * Remove recursivamente tudo dentro do prefix (pasta).
 * Ex.: "asfalto/<osId>" ou "buraco-rua/<osId>"
 */
async function removeStorageFolderRecursive(prefix: string): Promise<number> {
  const LIMIT = 1000;

  async function listAll(path: string) {
    const all: any[] = [];
    let offset = 0;

    while (true) {
      const { data, error } = await supabase.storage
        .from(STORAGE_BUCKET)
        .list(path, { limit: LIMIT, offset });

      if (error) throw error;
      if (!data || data.length === 0) break;

      all.push(...data);

      if (data.length < LIMIT) break;
      offset += LIMIT;
    }

    return all;
  }

  async function walk(path: string, depth: number): Promise<number> {
    if (depth > 8) return 0; // proteção contra loop/estrutura inesperada

    const items = await listAll(path);
    if (!items.length) return 0;

    const filesToRemove: string[] = [];
    const foldersToWalk: string[] = [];

    for (const it of items) {
      const name = typeof it?.name === "string" ? it.name : "";
      if (!name) continue;

      // Em geral: arquivos vêm com metadata, pastas vêm sem metadata
      const isFolder = !it?.metadata;
      const fullPath = path ? `${path}/${name}` : name;

      if (isFolder) foldersToWalk.push(fullPath);
      else filesToRemove.push(fullPath);
    }

    // remove arquivos em blocos (evita payload grande)
    let removedCount = 0;
    for (let i = 0; i < filesToRemove.length; i += 900) {
      const chunk = filesToRemove.slice(i, i + 900);
      const { error } = await supabase.storage.from(STORAGE_BUCKET).remove(chunk);
      if (error) throw error;
      removedCount += chunk.length;
    }

    // desce em subpastas
    for (const folder of foldersToWalk) {
      removedCount += await walk(folder, depth + 1);
    }

    return removedCount;
  }

  return await walk(prefix, 0);
}

// Normaliza o nome dos campos de fotos da abertura (operador)
function resolveFotosAbertura(raw: any): any[] | null {
  return (
    raw.fotos ??
    raw.fotosAbertura ??
    raw.fotos_abertura ??
    raw.fotosServico ??
    raw.fotos_servico ??
    null
  );
}

// Normaliza o nome dos campos de fotos da execução (terceirizada)
function resolveFotosExecucao(raw: any): any[] | null {
  return (
    raw.fotosExecucao ??
    raw.fotos_execucao ??
    raw.fotosServicoExecucao ??
    raw.fotos_servico_execucao ??
    null
  );
}

const ListaOrdensServico: React.FC = () => {
  const [ordensBuraco, setOrdensBuraco] = useState<FirestoreOS[]>([]);
  const [ordensAsfalto, setOrdensAsfalto] = useState<FirestoreOS[]>([]);
  const [ordensHidrojato, setOrdensHidrojato] = useState<FirestoreOS[]>([]);

  const [busca, setBusca] = useState("");
  const [filtroTipo, setFiltroTipo] = useState<TipoFiltroOs>("TODOS");
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);

  // Destaque automático vindo do alerta de SLA (48h úteis)
  const [highlightRowKey, setHighlightRowKey] = useState<string | null>(null);
  const pendingHighlightRef = useRef<string | null>(null);

  // filtros adicionais (sem alterar o buscar)
  const [filtroDataCriacao, setFiltroDataCriacao] = useState<string>("");
  const [filtroStatus, setFiltroStatus] = useState<StatusFiltroOs>("TODAS");
  const [ordenacaoCampo, setOrdenacaoCampo] =
    useState<OrdenacaoCampoOs>("createdAt");
  const [ordenacaoDirecao, setOrdenacaoDirecao] =
    useState<OrdenacaoDirecaoOs>("desc");
  const [loading, setLoading] = useState(true);

  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [statusType, setStatusType] = useState<StatusType>("info");
  const [currentPage, setCurrentPage] = useState<number>(1);
  const PAGE_SIZE = 20;

  const [alertModal, setAlertModal] = useState<
    { title: string; message: string } | null
  >(null);

  function openAlertModal(title: string, message: string) {
    setAlertModal({ title, message });
  }

  function closeAlertModal() {
    setAlertModal(null);
  }

  // modal de detalhes (texto / edição)
  const [detailsModalOs, setDetailsModalOs] = useState<FirestoreOS | null>(null);

  // ===== Aguardando SANEAR (SLA pausado) =====
  const [aguardandoSanearOpen, setAguardandoSanearOpen] = useState(false);
  const [aguardandoMotivo, setAguardandoMotivo] = useState("SERVICO_PREVIO");
  const [aguardandoDescricao, setAguardandoDescricao] = useState("");

  // modal do PDF com dados da OS
  const [pdfModalOs, setPdfModalOs] = useState<FirestoreOS | null>(null);
  const [pdfModalUrl, setPdfModalUrl] = useState<string | null>(null);
  const [pdfModalLoading, setPdfModalLoading] = useState(false);

  // modal de fotos (abertura / execução)
  const [photoModal, setPhotoModal] = useState<PhotoModalState | null>(null);
  const addPhotoInputRef = useRef<HTMLInputElement | null>(null);

  // imprimir foto SEM pop-up
  const [printPhoto, setPrintPhoto] = useState<PrintPhotoState>(null);

  // usuário atual (para controle de edição)
  const [currentUserEmail, setCurrentUserEmail] = useState<string | null>(null);
  const [currentUserRole, setCurrentUserRole] = useState<string | null>(null);

  // estado de edição dentro do modal de detalhes
  const [isEditingDetails, setIsEditingDetails] = useState(false);
  const [savingDetails, setSavingDetails] = useState(false);
  const [auditoriaEventos, setAuditoriaEventos] = useState<AuditoriaEvento[]>([]);

  useEffect(() => {
    const user = auth.currentUser;
    setCurrentUserEmail(user?.email ?? null);

    const storedRole =
      localStorage.getItem("sanear-role") ?? localStorage.getItem("userRole");
    setCurrentUserRole(storedRole);
  }, []);

  useEffect(() => {
    if (!statusMessage) return;

    const timer = window.setTimeout(() => {
      setStatusMessage(null);
    }, 3000);

    return () => window.clearTimeout(timer);
  }, [statusMessage]);

  useEffect(() => {
    // Calçamento (coleção ordens_servico)
    const qBuraco = query(
      collection(db, "ordens_servico"),
      orderBy("createdAt", "desc")
    );

    const unsubBuraco = onSnapshot(
      qBuraco,
      (snap) => {
        const data: FirestoreOS[] = snap.docs.map((d) => {
          const raw = d.data() as any;
          const pdfNested = getPdfNested(raw);
          return {
            id: d.id,
            origem: "buraco",
            tipo: raw.tipo || "BURACO_RUA",
            protocolo: raw.protocolo ?? null,
            ordemServico: raw.ordemServico ?? null,
            bairro: raw.bairro ?? null,
            rua: raw.rua ?? null,
            numero: raw.numero ?? null,
            // ✅ manter compatibilidade com "referencia"
            pontoReferencia: raw.pontoReferencia ?? raw.referencia ?? null,
            observacoes: raw.observacoes ?? null,
            status: raw.status ?? null,
            createdAt: raw.createdAt ?? null,
            createdByEmail: raw.createdByEmail ?? null,
            dataExecucao: raw.dataExecucao ?? null,
            tipoCaminhaoExecucao: raw.tipoCaminhaoExecucao ?? null,
            tipoCaminhaoExecucaoLabel: raw.tipoCaminhaoExecucaoLabel ?? null,
            finalizadoPorArea: raw.finalizadoPorArea ?? null,
            finalizadoPorEmail: raw.finalizadoPorEmail ?? null,
            fotos: resolveFotosAbertura(raw),
            fotosExecucao: resolveFotosExecucao(raw),
            ordemServicoPdfBase64: resolveRawPdfBase64(raw, pdfNested),
            ordemServicoPdfNomeArquivo: resolveRawPdfNomeArquivo(raw, pdfNested),
            ordemServicoPdfDataAnexo: resolveRawPdfDataAnexo(raw, pdfNested),
            ordemServicoPdfUrl: resolveRawPdfUrl(raw, pdfNested),
            ordemServicoPdfPath: resolveRawPdfPath(raw, pdfNested),
            ordemServicoPdfCompactado: resolveRawPdfCompactado(raw, pdfNested),
            ordemServicoPdfMimeTypeOriginal: resolveRawPdfMimeTypeOriginal(raw, pdfNested),
          };
        });
        setOrdensBuraco(data);
        setLoading(false);
      },
      (err) => {
        console.error(err);
        setLoading(false);
        setStatusMessage(
          "Não foi possível carregar as ordens de Calçamento. Verifique sua conexão e tente novamente."
        );
        setStatusType("error");
      }
    );

    // Asfalto (ordensServico)
    const qAsfalto = query(
      collection(db, "ordensServico"),
      orderBy("createdAt", "desc")
    );

    const unsubAsfalto = onSnapshot(
      qAsfalto,
      (snap) => {
        const data: FirestoreOS[] = snap.docs.map((d) => {
          const raw = d.data() as any;
          const pdfNested = getPdfNested(raw);
          return {
            id: d.id,
            origem: "asfalto",
            tipo: raw.tipo || "ASFALTO",
            protocolo: raw.protocolo ?? null,
            ordemServico: raw.ordemServico ?? null,
            bairro: raw.bairro ?? null,
            rua: raw.rua ?? null,
            numero: raw.numero ?? null,
            pontoReferencia: raw.pontoReferencia ?? raw.referencia ?? null,
            observacoes: raw.observacoes ?? null,
            status: raw.status ?? null,
            createdAt: raw.createdAt ?? null,
            createdByEmail: raw.createdByEmail ?? null,
            dataExecucao: raw.dataExecucao ?? null,
            tipoCaminhaoExecucao: raw.tipoCaminhaoExecucao ?? null,
            tipoCaminhaoExecucaoLabel: raw.tipoCaminhaoExecucaoLabel ?? null,
            finalizadoPorArea: raw.finalizadoPorArea ?? null,
            finalizadoPorEmail: raw.finalizadoPorEmail ?? null,
            fotos: resolveFotosAbertura(raw),
            fotosExecucao: resolveFotosExecucao(raw),
            ordemServicoPdfBase64: resolveRawPdfBase64(raw, pdfNested),
            ordemServicoPdfNomeArquivo: resolveRawPdfNomeArquivo(raw, pdfNested),
            ordemServicoPdfDataAnexo: resolveRawPdfDataAnexo(raw, pdfNested),
            ordemServicoPdfUrl: resolveRawPdfUrl(raw, pdfNested),
            ordemServicoPdfPath: resolveRawPdfPath(raw, pdfNested),
            ordemServicoPdfCompactado: resolveRawPdfCompactado(raw, pdfNested),
            ordemServicoPdfMimeTypeOriginal: resolveRawPdfMimeTypeOriginal(raw, pdfNested),
          };
        });
        setOrdensAsfalto(data);
        setLoading(false);
      },
      (err) => {
        console.error(err);
        setLoading(false);
        setStatusMessage(
          "Não foi possível carregar as ordens de Asfalto. Verifique sua conexão e tente novamente."
        );
        setStatusType("error");
      }
    );

    // Caminhão Hidrojato (ordensHidrojato)
    const qHidrojato = query(
      collection(db, "ordensHidrojato"),
      orderBy("createdAt", "desc")
    );

    const unsubHidrojato = onSnapshot(
      qHidrojato,
      (snap) => {
        const data: FirestoreOS[] = snap.docs.map((d) => {
          const raw = d.data() as any;
          const pdfNested = getPdfNested(raw);
          return {
            id: d.id,
            origem: "hidrojato",
            tipo: raw.tipo || "HIDROJATO",
            protocolo: raw.protocolo ?? null,
            ordemServico: raw.ordemServico ?? null,
            bairro: raw.bairro ?? null,
            rua: raw.rua ?? null,
            numero: raw.numero ?? null,
            pontoReferencia: raw.pontoReferencia ?? raw.referencia ?? null,
            observacoes: raw.observacoes ?? null,
            status: raw.status ?? null,
            createdAt: raw.createdAt ?? null,
            createdByEmail: raw.createdByEmail ?? null,
            dataExecucao: raw.dataExecucao ?? null,
            tipoCaminhaoExecucao: raw.tipoCaminhaoExecucao ?? null,
            tipoCaminhaoExecucaoLabel: raw.tipoCaminhaoExecucaoLabel ?? null,
            finalizadoPorArea: raw.finalizadoPorArea ?? null,
            finalizadoPorEmail: raw.finalizadoPorEmail ?? null,
            fotos: resolveFotosAbertura(raw),
            fotosExecucao: resolveFotosExecucao(raw),
            ordemServicoPdfBase64: resolveRawPdfBase64(raw, pdfNested),
            ordemServicoPdfNomeArquivo: resolveRawPdfNomeArquivo(raw, pdfNested),
            ordemServicoPdfDataAnexo: resolveRawPdfDataAnexo(raw, pdfNested),
            ordemServicoPdfUrl: resolveRawPdfUrl(raw, pdfNested),
            ordemServicoPdfPath: resolveRawPdfPath(raw, pdfNested),
            ordemServicoPdfCompactado: resolveRawPdfCompactado(raw, pdfNested),
            ordemServicoPdfMimeTypeOriginal: resolveRawPdfMimeTypeOriginal(raw, pdfNested),
          };
        });
        setOrdensHidrojato(data);
        setLoading(false);
      },
      (err) => {
        console.error(err);
        setLoading(false);
        setStatusMessage(
          "Não foi possível carregar as ordens de Caminhão Hidrojato. Verifique sua conexão e tente novamente."
        );
        setStatusType("error");
      }
    );

    return () => {
      unsubBuraco();
      unsubAsfalto();
      unsubHidrojato();
    };
  }, []);

  // ABRIR OS VINDO DE NOTIFICAÇÃO (sessionStorage sanear-open-os)
  useEffect(() => {
    if (loading) return;

    const raw = window.sessionStorage.getItem("sanear-open-os");
    if (!raw) return;

    try {
      const parsed = JSON.parse(raw) as { id: string; col?: string };
      const id = parsed?.id;
      if (!id) return;

      const all = [...ordensBuraco, ...ordensAsfalto, ...ordensHidrojato];
      const found = all.find((o) => o.id === id);

      if (found) {
        setDetailsModalOs(found);
        setIsEditingDetails(false);
        window.sessionStorage.removeItem("sanear-open-os");
      }
    } catch {
      window.sessionStorage.removeItem("sanear-open-os");
    }
  }, [loading, ordensBuraco, ordensAsfalto, ordensHidrojato]);

  const ordens = useMemo(() => {
    return [...ordensBuraco, ...ordensAsfalto, ...ordensHidrojato];
  }, [ordensBuraco, ordensAsfalto, ordensHidrojato]);

  const ordensByKey = useMemo(() => {
    const m = new Map<string, FirestoreOS>();
    for (const o of ordens) m.set(`${o.origem}:${o.id}`, o);
    return m;
  }, [ordens]);

  function getOsBy(origem: OrigemOS, id: string): FirestoreOS | null {
    return ordensByKey.get(`${origem}:${id}`) ?? null;
  }

  // Mantém detailsModalOs sincronizado com snapshots (sem sobrescrever edição ativa)
  useEffect(() => {
    if (!detailsModalOs) return;
    if (isEditingDetails) return;
    const fresh = getOsBy(detailsModalOs.origem, detailsModalOs.id);
    if (!fresh) return;
    setDetailsModalOs(fresh);
  }, [ordensByKey, detailsModalOs, isEditingDetails]);
  // Histórico operacional da OS exibido dentro do modal de detalhes.
  useEffect(() => {
    if (!detailsModalOs) {
      setAuditoriaEventos([]);
      return;
    }

    return assinarAuditoriaOs(
      detailsModalOs.origem,
      detailsModalOs.id,
      setAuditoriaEventos,
      () => setAuditoriaEventos([])
    );
  }, [detailsModalOs?.origem, detailsModalOs?.id]);


  // regra de permissão: criador OU admin OU diretor
  const canEditOs = (os: FirestoreOS): boolean => {
    const emailAtual = currentUserEmail?.toLowerCase() ?? null;
    const emailCriador = os.createdByEmail?.toLowerCase() ?? null;

    const isCreator =
      !!emailAtual && !!emailCriador && emailAtual === emailCriador;

    const role = currentUserRole?.toUpperCase() ?? "";
    const isAdmin = role === "ADMIN" || role === "ADM";
    const isDiretor =
      role === "DIRETOR" || role === "DIRETORIA" || role === "DIR";

    return isCreator || isAdmin || isDiretor;
  };

  function isOsFechada(os: FirestoreOS): boolean {
    return isOrdemFechada(os.status) || Boolean(os.dataExecucao);
  }

  function isSameLocalDate(
    ts: Timestamp | null | undefined,
    yyyyMmDd: string
  ): boolean {
    try {
      if (!ts) return false;
      if (!yyyyMmDd) return true;

      const parts = yyyyMmDd.split("-").map((n) => Number(n));
      if (parts.length !== 3) return false;
      const [y, m, d] = parts;

      const date = ts.toDate();
      return (
        date.getFullYear() === y &&
        date.getMonth() + 1 === m &&
        date.getDate() === d
      );
    } catch {
      return false;
    }
  }

  const filtradasBusca = useMemo(() => {
    const texto = busca.trim().toLowerCase();
    if (!texto) return ordens;

    return ordens.filter((os) => {
      const dataCriacao = formatDateTime(os.createdAt).toLowerCase();
      const dataExec = formatDateTime(os.dataExecucao).toLowerCase();

      return (
        os.ordemServico?.toLowerCase().includes(texto) ||
        os.protocolo?.toLowerCase().includes(texto) ||
        os.bairro?.toLowerCase().includes(texto) ||
        os.rua?.toLowerCase().includes(texto) ||
        dataCriacao.includes(texto) ||
        dataExec.includes(texto)
      );
    });
  }, [busca, ordens]);

  const filtradas = useMemo(() => {
    let lista = [...filtradasBusca];

    if (filtroTipo !== "TODOS") {
      lista = lista.filter((os) => normalizeTipoOs(os) === filtroTipo);
    }

    if (filtroDataCriacao) {
      lista = lista.filter((os) =>
        isSameLocalDate(os.createdAt, filtroDataCriacao)
      );
    }

    if (filtroStatus !== "TODAS") {
      lista = lista.filter((os) => {
        const fechada = isOsFechada(os);
        return filtroStatus === "ABERTAS" ? !fechada : fechada;
      });
    }

    const getMillis = (os: FirestoreOS): number | null => {
      const ts = ordenacaoCampo === "createdAt" ? os.createdAt : os.dataExecucao;
      const ms = ts && typeof ts.toMillis === "function" ? ts.toMillis() : null;
      return typeof ms === "number" && ms > 0 ? ms : null;
    };

    lista.sort((a, b) => {
      const aMs = getMillis(a);
      const bMs = getMillis(b);

      const aHas = aMs !== null;
      const bHas = bMs !== null;

      if (!aHas && !bHas) {
        const aCreated =
          a.createdAt && typeof a.createdAt.toMillis === "function"
            ? a.createdAt.toMillis()
            : 0;
        const bCreated =
          b.createdAt && typeof b.createdAt.toMillis === "function"
            ? b.createdAt.toMillis()
            : 0;
        return bCreated - aCreated;
      }
      if (!aHas) return 1;
      if (!bHas) return -1;

      const diff = (aMs as number) - (bMs as number);
      if (diff === 0) {
        const aCreated =
          a.createdAt && typeof a.createdAt.toMillis === "function"
            ? a.createdAt.toMillis()
            : 0;
        const bCreated =
          b.createdAt && typeof b.createdAt.toMillis === "function"
            ? b.createdAt.toMillis()
            : 0;
        return bCreated - aCreated;
      }

      return ordenacaoDirecao === "asc" ? diff : -diff;
    });

    return lista;
  }, [
    filtradasBusca,
    filtroTipo,
    filtroDataCriacao,
    filtroStatus,
    ordenacaoCampo,
    ordenacaoDirecao,
  ]);

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
  }, [busca, filtroTipo, filtroDataCriacao, filtroStatus, ordenacaoCampo, ordenacaoDirecao]);

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  const filtroTipoLabel = useMemo(() => {
    return tipoFiltroOptions.find((option) => option.value === filtroTipo)?.label ?? "TODOS OS SERVIÇOS";
  }, [filtroTipo]);

  const filtroStatusLabel = useMemo(() => {
    if (filtroStatus === "ABERTAS") return "Abertas";
    if (filtroStatus === "FECHADAS") return "Fechadas";
    return "Todas";
  }, [filtroStatus]);

  const ordenacaoLabel = useMemo(() => {
    const campo = ordenacaoCampo === "createdAt" ? "criação" : "execução";
    const direcao = ordenacaoDirecao === "asc" ? "crescente" : "decrescente";
    return `${campo}, ${direcao}`;
  }, [ordenacaoCampo, ordenacaoDirecao]);

  const filtrosAtivosQuantidade = useMemo(() => {
    let total = 0;
    if (filtroTipo !== "TODOS") total += 1;
    if (filtroDataCriacao) total += 1;
    if (filtroStatus !== "TODAS") total += 1;
    if (ordenacaoCampo !== "createdAt" || ordenacaoDirecao !== "desc") total += 1;
    return total;
  }, [filtroTipo, filtroDataCriacao, filtroStatus, ordenacaoCampo, ordenacaoDirecao]);

  function limparFiltrosLista() {
    setFiltroTipo("TODOS");
    setFiltroStatus("TODAS");
    setFiltroDataCriacao("");
    setOrdenacaoCampo("createdAt");
    setOrdenacaoDirecao("desc");
  }

  useEffect(() => {
    if (!mobileFiltersOpen) return;

    document.body.classList.add("mobile-filter-sheet-open");

    return () => {
      document.body.classList.remove("mobile-filter-sheet-open");
    };
  }, [mobileFiltersOpen]);

  // ======= Destaque / navegação vinda de outras telas (ex.: Alerta SLA) =======

  // Se veio um destaque, rola até a linha quando ela existir no DOM
  useEffect(() => {
    const key = pendingHighlightRef.current;
    if (!key) return;

    const t = window.setTimeout(() => {
      const el = document.querySelector(
        `[data-os-key="${key}"]`
      ) as HTMLElement | null;

      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        pendingHighlightRef.current = null;
      }
    }, 150);

    return () => window.clearTimeout(t);
  }, [filtradas]);

  // Lê o "alvo" (OS) vindo de outras telas (ex.: alerta SLA) e aplica destaque
  useEffect(() => {
    if (typeof window === "undefined") return;

    const raw = window.sessionStorage.getItem("sanear-listaos-highlight");
    if (!raw) return;

    try {
      const payload = JSON.parse(raw) as {
        osId: string;
        origem: OrigemOS;
        numero?: string;
      };

      const key = `${payload.origem}:${payload.osId}`;

      pendingHighlightRef.current = key;
      setHighlightRowKey(key);

      // Garante visibilidade da OS
      setFiltroTipo("TODOS");
      setFiltroStatus("TODAS");
      setFiltroDataCriacao("");

      // Se veio nº/protocolo, já filtra na busca (melhor UX)
      setBusca(payload.numero ? String(payload.numero) : "");

      window.sessionStorage.removeItem("sanear-listaos-highlight");

      const t = window.setTimeout(() => {
        setHighlightRowKey((prev) => (prev === key ? null : prev));
        pendingHighlightRef.current = null;
      }, 12000);

      return () => window.clearTimeout(t);
    } catch {
      window.sessionStorage.removeItem("sanear-listaos-highlight");
    }
  }, []);

  function handleSearchChange(e: ChangeEvent<HTMLInputElement>) {
    setBusca(e.target.value);
  }

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

    const tipoLabel = getTipoOsLabel(os);

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
      { label: "Status", value: os.status || "ABERTA" },
      { label: "Data de criação", value: formatDateTime(os.createdAt) },
      { label: "Data de execução", value: formatDateTime(os.dataExecucao) },
      ...(os.origem === "hidrojato"
        ? [{ label: "Execução Hidrojato", value: getCaminhaoExecucaoLabel(os) }]
        : []),
      { label: "Criado por", value: os.createdByEmail || "-" },
      {
        label: "Observações",
        value: (os.observacoes || "").replace(/\s+/g, " ").trim() || "-",
      },
    ];

    const labelGap = 4;

    rows.forEach(({ label, value }) => {
      if (y < 80) return;

      const labelText = `${label}: `;
      const labelWidth = boldFont.widthOfTextAtSize(labelText, fontSize);
      const valueLines = wrapPdfText(
        value,
        font,
        fontSize,
        maxWidth - labelWidth
      );

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

    // ✅ correção TS: Uint8Array -> ArrayBuffer para BlobPart
    const pdfArrayBuffer = pdfBytes.buffer.slice(
      pdfBytes.byteOffset,
      pdfBytes.byteOffset + pdfBytes.byteLength
    ) as ArrayBuffer;

    const blob = new Blob([pdfArrayBuffer], { type: "application/pdf" });
    return URL.createObjectURL(blob);
  }

  async function handleOpenPdfModal(
    os: FirestoreOS,
    e: MouseEvent<HTMLButtonElement>
  ) {
    e.stopPropagation();

    if (pdfModalUrl) {
      URL.revokeObjectURL(pdfModalUrl);
      setPdfModalUrl(null);
    }

    setPdfModalOs(os);
    setPdfModalLoading(true);

    try {
      const attachedPdf = await resolveAttachedPdfUrl(os);

      if (attachedPdf) {
        setPdfModalUrl(attachedPdf.url);
        return;
      }

      const url = await generateOsDataPdfUrl(os);
      setPdfModalUrl(url);
      setStatusMessage(
        "Esta OS não possui PDF original anexado. Foi aberto o PDF gerado com os dados do cadastro."
      );
      setStatusType("info");
    } catch (err) {
      console.error(err);
      setStatusMessage(
        "Não foi possível abrir o PDF da OS. Tente novamente."
      );
      setStatusType("error");
      setPdfModalOs(null);
    } finally {
      setPdfModalLoading(false);
    }
  }

  function closePdfModal() {
    if (pdfModalUrl) URL.revokeObjectURL(pdfModalUrl);
    setPdfModalUrl(null);
    setPdfModalOs(null);
    setPdfModalLoading(false);
  }

  async function handleOpenAttachedPdfFromDetails(os: FirestoreOS) {
    try {
      const attachedPdf = await resolveAttachedPdfUrl(os);

      if (!attachedPdf) {
        openAlertModal(
          "PDF não encontrado",
          "Esta OS não possui PDF anexado na criação."
        );
        return;
      }

      window.open(attachedPdf.url, "_blank", "noopener,noreferrer");

      if (attachedPdf.shouldRevoke) {
        window.setTimeout(() => URL.revokeObjectURL(attachedPdf.url), 60000);
      }
    } catch (error) {
      console.error(error);
      openAlertModal(
        "PDF compactado",
        "Não foi possível abrir o PDF compactado desta OS."
      );
    }
  }

  function handlePrintCurrentPdf() {
    window.print();
  }

  // ✅ PASSO 3: delete com cleanup no Storage
  
async function handleMarcarAguardandoSanear() {
  if (!detailsModalOs) return;

  if (isOsFechada(detailsModalOs)) {
    openAlertModal(
      "OS fechada",
      "Esta OS já está fechada. Reabra a OS antes de marcar como Aguardando SANEAR."
    );
    return;
  }

  const descricao = aguardandoDescricao.trim();
  if (descricao.length < 3) {
    openAlertModal("Descrição obrigatória", "Informe uma descrição curta do motivo (mín. 3 caracteres).");
    return;
  }

  try {
    setSavingDetails(true);

    const collectionName =
      getCollectionName(detailsModalOs.origem);

    const statusAtual = normalizeStatus(detailsModalOs.status);
    const statusAntes =
      detailsModalOs.statusAntesAguardandoSanear ??
      (statusAtual && statusAtual !== "AGUARDANDO_SANEAR" ? statusAtual : "ABERTA");

    const pausasAtualizadas = upsertSanearPause(detailsModalOs.slaPausas, {
      motivo: aguardandoMotivo,
      descricao,
      inicioEm: serverTimestamp(),
    });

    await updateDoc(doc(db, collectionName, detailsModalOs.id), {
      status: "AGUARDANDO_SANEAR",
      statusAntesAguardandoSanear: statusAntes,
      slaPausas: pausasAtualizadas,
      updatedAt: serverTimestamp(),
    });

    void registrarAuditoriaOs({
      osId: detailsModalOs.id,
      origem: detailsModalOs.origem,
      collectionName,
      acao: "AGUARDANDO_SANEAR",
      titulo: "OS marcada como Aguardando SANEAR",
      descricao: descricao || "Serviço pausado aguardando ação interna da SANEAR.",
      statusAntes,
      statusDepois: "AGUARDANDO_SANEAR",
      detalhes: { motivo: aguardandoMotivo },
    });

    setDetailsModalOs((prev) =>
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
    setStatusMessage("OS marcada como Aguardando SANEAR.");
    setStatusType("success");
  } catch (e) {
    console.error(e);
    setStatusMessage("Não foi possível marcar como Aguardando SANEAR.");
    setStatusType("error");
  } finally {
    setSavingDetails(false);
  }
}

async function handleRetomarSanear() {
  if (!detailsModalOs) return;

  try {
    setSavingDetails(true);

    const collectionName =
      getCollectionName(detailsModalOs.origem);

    const pausasFechadas = closeSanearPause(detailsModalOs.slaPausas, serverTimestamp());
    const novoStatus = detailsModalOs.statusAntesAguardandoSanear || "ABERTA";

    await updateDoc(doc(db, collectionName, detailsModalOs.id), {
      status: novoStatus,
      statusAntesAguardandoSanear: null,
      slaPausas: pausasFechadas,
      updatedAt: serverTimestamp(),
    });

    void registrarAuditoriaOs({
      osId: detailsModalOs.id,
      origem: detailsModalOs.origem,
      collectionName,
      acao: "RETOMADA_SANEAR",
      titulo: "OS retomada pela SANEAR",
      descricao: "A pausa Aguardando SANEAR foi encerrada e a OS voltou ao fluxo normal.",
      statusAntes: "AGUARDANDO_SANEAR",
      statusDepois: novoStatus,
    });

    setDetailsModalOs((prev) =>
      prev
        ? { ...prev, status: novoStatus, statusAntesAguardandoSanear: null, slaPausas: pausasFechadas }
        : prev
    );

    setStatusMessage("OS retomada com sucesso.");
    setStatusType("success");
  } catch (e) {
    console.error(e);
    setStatusMessage("Não foi possível retomar a OS.");
    setStatusType("error");
  } finally {
    setSavingDetails(false);
  }
}

async function handleReabrirOs(os: FirestoreOS) {
  const motivoInformado = window.prompt(
    "Informe o motivo da reabertura da OS:",
    "Correção ou nova finalização necessária."
  );

  if (motivoInformado === null) return;

  const motivoReabertura = motivoInformado.trim();
  if (!motivoReabertura) {
    setStatusMessage("Informe o motivo da reabertura antes de continuar.");
    setStatusType("error");
    return;
  }

  const confirmReopen = window.confirm(
    "Deseja reabrir esta OS? A execução atual será preservada no histórico e a OS ficará disponível para nova finalização."
  );

  if (!confirmReopen) return;

  try {
    setSavingDetails(true);

    const collectionName = getCollectionName(os.origem);
    const pausasFechadas = closeSanearPause(os.slaPausas, serverTimestamp());
    const fotosExecucaoAtuais = Array.isArray(os.fotosExecucao) ? os.fotosExecucao : [];
    const temExecucaoAnterior =
      !!os.dataExecucao ||
      !!os.finalizadoPorArea ||
      !!os.finalizadoPorEmail ||
      fotosExecucaoAtuais.length > 0 ||
      !!os.tipoCaminhaoExecucao ||
      !!os.tipoCaminhaoExecucaoLabel;

    const historicoExecucao = {
      tipo: "REABERTURA_EXECUCAO",
      statusAnterior: os.status ?? null,
      dataExecucao: os.dataExecucao ?? null,
      finalizadoPorArea: os.finalizadoPorArea ?? null,
      finalizadoPorEmail: os.finalizadoPorEmail ?? null,
      tipoCaminhaoExecucao: os.tipoCaminhaoExecucao ?? null,
      tipoCaminhaoExecucaoLabel: os.tipoCaminhaoExecucaoLabel ?? null,
      fotosExecucao: fotosExecucaoAtuais,
      motivoReabertura,
      reabertaEm: Timestamp.now(),
      reabertaPorEmail: currentUserEmail ?? null,
      reabertaPorUid: auth.currentUser?.uid ?? null,
    };

    await updateDoc(doc(db, collectionName, os.id), {
      status: "ABERTA",
      dataExecucao: null,
      finalizadoPorArea: null,
      finalizadoPorEmail: null,
      tipoCaminhaoExecucao: null,
      tipoCaminhaoExecucaoLabel: null,
      fotosExecucao: [],
      statusAntesAguardandoSanear: null,
      slaPausas: pausasFechadas,
      reabertaEm: serverTimestamp(),
      reabertaPorEmail: currentUserEmail ?? null,
      reabertaPorUid: auth.currentUser?.uid ?? null,
      motivoUltimaReabertura: motivoReabertura,
      ...(temExecucaoAnterior ? { historicoExecucoes: arrayUnion(historicoExecucao) } : {}),
      updatedAt: serverTimestamp(),
    });

    void registrarAuditoriaOs({
      osId: os.id,
      origem: os.origem,
      collectionName,
      acao: "REABERTURA_OS",
      titulo: "OS reaberta",
      descricao: motivoReabertura,
      statusAntes: os.status ?? null,
      statusDepois: "ABERTA",
      detalhes: { execucaoAnteriorPreservada: temExecucaoAnterior },
    });

    setDetailsModalOs((prev) =>
      prev
        ? {
            ...prev,
            status: "ABERTA",
            dataExecucao: null,
            finalizadoPorArea: null,
            finalizadoPorEmail: null,
            tipoCaminhaoExecucao: null,
            tipoCaminhaoExecucaoLabel: null,
            fotosExecucao: [],
            statusAntesAguardandoSanear: null,
            slaPausas: pausasFechadas,
          }
        : prev
    );

    setIsEditingDetails(false);
    setStatusMessage(
      temExecucaoAnterior
        ? "OS reaberta com sucesso. A execução anterior foi preservada no histórico."
        : "OS reaberta com sucesso."
    );
    setStatusType("success");
  } catch (error) {
    console.error(error);
    setStatusMessage("Não foi possível reabrir a OS. Tente novamente.");
    setStatusType("error");
  } finally {
    setSavingDetails(false);
  }
}

async function handleDeleteOs(os: FirestoreOS) {
    const confirmDelete = window.confirm(
      "Tem certeza que deseja excluir esta ordem de serviço? Esta ação não pode ser desfeita."
    );
    if (!confirmDelete) return;

    try {
      const collectionName =
        getCollectionName(os.origem);

      // Cleanup no Storage ANTES de deletar o doc
      const basePath = getStorageBasePath(os.origem);
      const prefix = `${basePath}/${os.id}`;

      let storageOk = true;
      let removedFiles = 0;

      try {
        removedFiles = await removeStorageFolderRecursive(prefix);
      } catch (e) {
        storageOk = false;
        console.error("Falha ao remover arquivos do Storage:", e);
      }

      void registrarAuditoriaOs({
        osId: os.id,
        origem: os.origem,
        collectionName,
        acao: "EXCLUSAO_OS",
        titulo: "OS excluída",
        descricao: `OS removida da coleção ${collectionName}. Arquivos removidos do Storage: ${removedFiles}.`,
        statusAntes: os.status ?? null,
        statusDepois: "EXCLUIDA",
        detalhes: { storageOk, removedFiles },
      });

      await deleteDoc(doc(db, collectionName, os.id));
      setDetailsModalOs(null);

      if (storageOk) {
        setStatusMessage(
          `Ordem de serviço excluída com sucesso. Arquivos removidos do Storage: ${removedFiles}.`
        );
        setStatusType("success");
      } else {
        setStatusMessage(
          "OS excluída, porém houve falha ao remover alguns arquivos do Storage (ver console)."
        );
        setStatusType("info");
      }
    } catch (error) {
      console.error(error);
      setStatusMessage(
        "Não foi possível excluir a ordem de serviço. Tente novamente."
      );
      setStatusType("error");
    }
  }

  function closeDetailsModal() {
    setDetailsModalOs(null);
    setIsEditingDetails(false);
  }

  function normalizeStatus(value: string | null | undefined): string {
    return normalizeOrdemStatus(value);
  }

async function handleSaveDetails() {
    if (!detailsModalOs) return;

    const stAtual = normalizeStatus(detailsModalOs.status);
    const temPausaSanearAtiva = stAtual === "AGUARDANDO_SANEAR" || hasOpenSanearPause(detailsModalOs.slaPausas);
    const querConcluir = stAtual.startsWith("CONCLU");

    if (temPausaSanearAtiva && querConcluir) {
      openAlertModal(
        "Aguardando SANEAR",
        "Esta OS está com SLA pausado (Aguardando SANEAR). Retome a OS (SANEAR liberou) antes de concluir."
      );
      return;
    }

    if (!canEditOs(detailsModalOs)) {
      openAlertModal(
        "Sem permissão",
        "Você não tem permissão para editar esta OS."
      );
      return;
    }

    if (isOsFechada(detailsModalOs)) {
      openAlertModal(
        "OS fechada",
        "Esta OS está fechada. Para alterar dados, primeiro reabra a OS."
      );
      return;
    }

    try {
      setSavingDetails(true);

      const collectionName =
        getCollectionName(detailsModalOs.origem);

      await updateDoc(doc(db, collectionName, detailsModalOs.id), {
        ordemServico: detailsModalOs.ordemServico || null,
        protocolo: detailsModalOs.protocolo || null,
        bairro: detailsModalOs.bairro || null,
        rua: detailsModalOs.rua || null,
        numero: detailsModalOs.numero || null,
        pontoReferencia: detailsModalOs.pontoReferencia || null,
        observacoes: detailsModalOs.observacoes || null,
        status: normalizeStatus(detailsModalOs.status),

        ...(isAdmRole(currentUserRole)
          ? { dataExecucao: detailsModalOs.dataExecucao ?? null }
          : {}),

        updatedAt: serverTimestamp(),
      });

      void registrarAuditoriaOs({
        osId: detailsModalOs.id,
        origem: detailsModalOs.origem,
        collectionName,
        acao: "EDICAO_OS",
        titulo: "Dados da OS editados",
        descricao: "Alteração manual realizada pela Lista de OS.",
        statusDepois: normalizeStatus(detailsModalOs.status),
        detalhes: {
          protocolo: detailsModalOs.protocolo || null,
          ordemServico: detailsModalOs.ordemServico || null,
          bairro: detailsModalOs.bairro || null,
          rua: detailsModalOs.rua || null,
        },
      });

      setStatusMessage("Ordem de serviço atualizada com sucesso.");
      setStatusType("success");
      setIsEditingDetails(false);
    } catch (error) {
      console.error(error);
      setStatusMessage(
        "Não foi possível atualizar a ordem de serviço. Tente novamente."
      );
      setStatusType("error");
    } finally {
      setSavingDetails(false);
    }
  }

  const fotosAberturaDetalhes: NormalizedPhoto[] = useMemo(() => {
    if (!detailsModalOs) return [];
    return normalizeFotos(detailsModalOs.fotos);
  }, [detailsModalOs]);

  const fotosExecucaoDetalhes: NormalizedPhoto[] = useMemo(() => {
    if (!detailsModalOs) return [];
    return normalizeFotos(detailsModalOs.fotosExecucao);
  }, [detailsModalOs]);

  const detailsModalFechada = detailsModalOs ? isOsFechada(detailsModalOs) : false;
  const canEditCurrent =
    detailsModalOs && canEditOs(detailsModalOs) ? true : false;
  const canEditCurrentFields = canEditCurrent && !detailsModalFechada;
  const readOnlyEditableFields = !isEditingDetails || !canEditCurrentFields;

  function openPhotoModalForOs(os: FirestoreOS, _preferido?: PhotoModalTipo) {
    // A Lista de OS deve mostrar somente as fotos de execução/finalização da terceirizada.
    // Fotos de abertura/operador não fazem mais parte deste fluxo visual.
    setPhotoModal({
      osId: os.id,
      origem: os.origem,
      tipo: "execucao",
      currentIndex: 0,
    });
  }

  function openPhotoModalFromDetails(tipo: PhotoModalTipo) {
    if (!detailsModalOs) return;
    openPhotoModalForOs(detailsModalOs, tipo);
  }

  function openPhotoModalFromRow(os: FirestoreOS) {
    openPhotoModalForOs(os);
  }

  function closePhotoModal() {
    setPhotoModal(null);
  }

  function getOsFromPhotoModal(state: PhotoModalState | null): FirestoreOS | null {
    if (!state) return null;
    return getOsBy(state.origem, state.osId);
  }

  void fotosAberturaDetalhes;
  void openPhotoModalFromRow;

  function getFotosFromModalState(state: PhotoModalState | null): NormalizedPhoto[] {
    const os = getOsFromPhotoModal(state);
    if (!os || !state) return [];
    return normalizeFotos(os.fotosExecucao);
  }

  function goToNextPhoto() {
    setPhotoModal((prev) => {
      if (!prev) return prev;
      const fotos = getFotosFromModalState(prev);
      if (fotos.length === 0) return prev;
      const nextIndex = (prev.currentIndex + 1) % fotos.length;
      return { ...prev, currentIndex: nextIndex };
    });
  }

  function goToPrevPhoto() {
    setPhotoModal((prev) => {
      if (!prev) return prev;
      const fotos = getFotosFromModalState(prev);
      if (fotos.length === 0) return prev;
      const prevIndex = (prev.currentIndex - 1 + fotos.length) % fotos.length;
      return { ...prev, currentIndex: prevIndex };
    });
  }

  async function handleDeleteCurrentPhoto() {
    if (!photoModal) return;

    const os = getOsFromPhotoModal(photoModal);
    if (!os) {
      openAlertModal("OS não encontrada", "Não foi possível localizar esta OS.");
      return;
    }

    if (!canEditOs(os)) {
      openAlertModal(
        "Sem permissão",
        "Você não tem permissão para excluir fotos desta OS."
      );
      return;
    }

    const fotosNormalizadas = getFotosFromModalState(photoModal);
    if (fotosNormalizadas.length === 0) return;

    const confirmDelete = window.confirm("Tem certeza que deseja excluir esta foto?");
    if (!confirmDelete) return;

    const { tipo, currentIndex } = photoModal;
    const fotoAtual = fotosNormalizadas[currentIndex];

    try {
      const collectionName =
        getCollectionName(os.origem);

      const originalArray: any[] =
        (tipo === "abertura" ? os.fotos : os.fotosExecucao) || [];
      const updatedArray = originalArray.filter(
        (_f, idx) => idx !== fotoAtual.sourceIndex
      );

      if (fotoAtual.storagePath) {
        const { error: removeError } = await supabase.storage
          .from(STORAGE_BUCKET)
          .remove([fotoAtual.storagePath]);

        if (removeError) {
          console.warn("Não foi possível remover o arquivo da foto no Supabase:", removeError);
        }
      }

      await updateDoc(doc(db, collectionName, os.id), {
        [tipo === "abertura" ? "fotos" : "fotosExecucao"]: updatedArray,
        updatedAt: serverTimestamp(),
      });

      setStatusMessage("Foto excluída com sucesso.");
      setStatusType("success");

      setPhotoModal((prev) => {
        if (!prev) return prev;
        const normalizedNew = normalizeFotos(updatedArray);
        const nextIndex =
          normalizedNew.length === 0
            ? 0
            : Math.min(prev.currentIndex, normalizedNew.length - 1);
        return { ...prev, currentIndex: nextIndex };
      });
    } catch (error) {
      console.error(error);
      setStatusMessage("Não foi possível excluir a foto. Tente novamente mais tarde.");
      setStatusType("error");
    }
  }

  function triggerAddPhotos() {
    if (!photoModal) return;
    addPhotoInputRef.current?.click();
  }

  async function handleAddPhotosChange(e: ChangeEvent<HTMLInputElement>) {
    if (!photoModal) {
      e.target.value = "";
      return;
    }

    const os = getOsFromPhotoModal(photoModal);
    if (!os) {
      e.target.value = "";
      openAlertModal(
        "OS não encontrada",
        "Não foi possível localizar esta OS para adicionar fotos."
      );
      return;
    }

    const files = e.target.files;
    if (!files || files.length === 0) {
      e.target.value = "";
      return;
    }

    if (!canEditOs(os)) {
      e.target.value = "";
      openAlertModal(
        "Sem permissão",
        "Você não tem permissão para adicionar fotos nesta OS."
      );
      return;
    }

    const fotosAtuais = normalizeFotos(os.fotosExecucao).length;
    const limiteFotos = 2;

    if (isOsFechada(os)) {
      e.target.value = "";
      openAlertModal(
        "OS fechada",
        "Esta OS está fechada. Reabra a OS antes de adicionar novas fotos."
      );
      return;
    }

    if (fotosAtuais >= limiteFotos) {
      e.target.value = "";
      openAlertModal(
        "Limite de fotos",
        "Esta OS já possui 2 fotos da terceirizada. Para adicionar outra, exclua uma foto primeiro."
      );
      return;
    }

    const validFiles = Array.from(files).filter((file) => {
      if (file.type && file.type.startsWith("image/")) return true;
      const name = file.name.toLowerCase();
      const exts = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".heic", ".heif"];
      return exts.some((ext) => name.endsWith(ext));
    });

    if (validFiles.length === 0) {
      setStatusMessage("Somente arquivos de imagem são permitidos.");
      setStatusType("error");
      e.target.value = "";
      return;
    }

    const vagasDisponiveis = Math.max(0, limiteFotos - fotosAtuais);
    const filesParaEnviar = validFiles.slice(0, vagasDisponiveis);

    if (filesParaEnviar.length === 0) {
      setStatusMessage("Limite de 2 fotos da terceirizada já atingido.");
      setStatusType("info");
      e.target.value = "";
      return;
    }

    if (validFiles.length > filesParaEnviar.length) {
      setStatusMessage(
        `Limite de 2 fotos por OS. Apenas ${filesParaEnviar.length} foto(s) será(ão) adicionada(s).`
      );
      setStatusType("info");
    }

    try {
      const basePath = getStorageBasePath(os.origem);
      const subfolder = "fotos-execucao";

      const agora = new Date();
      const dataAnexoTexto = agora.toLocaleString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });

      const novosItens: any[] = [];

      for (const file of filesParaEnviar) {
        const originalName = file.name || "foto.jpg";
        const safeName = sanitizeForStoragePath(originalName);

        const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const compactado = await compactFileToZip(file);
        const path = `${basePath}/${os.id}/${subfolder}/${id}-${compactado.zipFileName || `${safeName}.zip`}`;

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

        const { data } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(path);
        const url = data.publicUrl;

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

      const collectionName =
        getCollectionName(os.origem);

      const originalArray: any[] = os.fotosExecucao || [];
      const updatedArray = [...originalArray, ...novosItens];

      await updateDoc(doc(db, collectionName, os.id), {
        fotosExecucao: updatedArray,
        updatedAt: serverTimestamp(),
      });

      setStatusMessage("Foto(s) adicionada(s) com sucesso.");
      setStatusType("success");

      // vai para a última foto
      setPhotoModal((prev) =>
        prev ? { ...prev, currentIndex: updatedArray.length - 1 } : prev
      );
    } catch (error: unknown) {
      console.error(error);

      try {
        const collectionName = getCollectionName(os.origem);
        const basePath = getStorageBasePath(os.origem);
        const erroResumo = resumirErroAnexo(error);

        await Promise.all(
          filesParaEnviar.map((file) =>
            salvarAnexoPendente({
              tipo: "FOTO_EXECUCAO",
              osId: os.id,
              collectionName,
              origem: os.origem.toLocaleUpperCase("pt-BR"),
              storageBasePath: basePath,
              storageSubfolder: "fotos-execucao",
              nomeArquivo: file.name || "foto.jpg",
              mimeType: file.type || "image/jpeg",
              tamanho: file.size,
              criadoPorEmail: auth.currentUser?.email?.toLowerCase() ?? null,
              observacao: "Foto da terceirizada salva localmente porque o envio ao Supabase falhou.",
              ultimoErro: erroResumo,
              arquivo: file,
            })
          )
        );
      } catch (queueError) {
        console.error("Erro ao salvar fotos na fila local", queueError);
      }

      setStatusMessage("Não foi possível enviar agora. A(s) foto(s) ficaram na fila local de anexos pendentes.");
      setStatusType("info");
    } finally {
      e.target.value = "";
    }
  }

  // IMPRIMIR FOTO (SEM POPUP)
  async function handlePrintCurrentPhoto() {
    if (!photoModal) return;

    const os = getOsFromPhotoModal(photoModal);
    if (!os) {
      openAlertModal(
        "OS não encontrada",
        "Não foi possível localizar esta OS para imprimir a foto."
      );
      return;
    }

    const fotos = getFotosFromModalState(photoModal);
    if (fotos.length === 0) {
      openAlertModal("Sem fotos", "Não há fotos para imprimir nesta aba.");
      return;
    }

    const foto = fotos[photoModal.currentIndex] ?? fotos[0];
    const titulo = `OS ${os.ordemServico || os.protocolo || os.id} - ${
      foto.label || "Foto"
    }`;

    try {
      const resolved = await resolvePhotoDisplayUrl(foto);
      setPrintPhoto({
        title: titulo,
        url: resolved.url,
        shouldRevoke: resolved.shouldRevoke,
      });
    } catch (error) {
      console.error(error);
      openAlertModal(
        "Foto compactada",
        "Não foi possível abrir a foto compactada para impressão."
      );
    }
  }

  useEffect(() => {
    if (!printPhoto) return;

    document.body.classList.add("print-photo-active");

    const onAfterPrint = () => {
      document.body.classList.remove("print-photo-active");
      if (printPhoto.shouldRevoke) URL.revokeObjectURL(printPhoto.url);
      setPrintPhoto(null);
    };

    window.addEventListener("afterprint", onAfterPrint);

    const fallback = window.setTimeout(() => {
      document.body.classList.remove("print-photo-active");
      if (printPhoto.shouldRevoke) URL.revokeObjectURL(printPhoto.url);
      setPrintPhoto(null);
    }, 15000);

    const tryPrint = () => {
      setTimeout(() => {
        try {
          window.print();
        } catch {
          document.body.classList.remove("print-photo-active");
          if (printPhoto.shouldRevoke) URL.revokeObjectURL(printPhoto.url);
          setPrintPhoto(null);
        }
      }, 50);
    };

    const img = document.getElementById("print-photo-img") as HTMLImageElement | null;
    if (img) {
      if (img.complete) {
        tryPrint();
      } else {
        const done = () => tryPrint();
        img.addEventListener("load", done, { once: true });
        img.addEventListener("error", done, { once: true });
      }
    } else {
      tryPrint();
    }

    return () => {
      window.removeEventListener("afterprint", onAfterPrint);
      window.clearTimeout(fallback);
      document.body.classList.remove("print-photo-active");
    };
  }, [printPhoto]);

  const stickyHeaderCellStyle = {
    position: "sticky" as const,
    top: 0,
    zIndex: 8,
    background: "#fff",
    boxShadow: "0 1px 0 rgba(0,0,0,0.08)",
  };

  function getMobileStatusLabel(os: FirestoreOS): string {
    if (os.dataExecucao && !isOrdemFechada(os.status)) return "Executada";
    return formatOrdemStatusLabel(os.status);
  }

  function getMobileStatusClass(os: FirestoreOS): string {
    const status = normalizeStatus(os.status);

    if (isOrdemAguardandoSanear(status)) return "is-waiting";
    if (status === "CONCLUIDA" || os.dataExecucao) return "is-done";
    if (status === "CANCELADA") return "is-canceled";
    return "is-open";
  }

  function getMobileTipoClass(os: FirestoreOS): string {
    const tipo = normalizeTipoOs(os);
    if (tipo === "BURACO_RUA") return "is-calcamento";
    if (tipo === "ASFALTO") return "is-asfalto";
    if (tipo === "HIDROJATO") return "is-hidrojato";
    if (tipo === "ESGOTO_RETORNANDO") return "is-esgoto-retornando";
    if (tipo === "ESGOTO_ENTUPIDO") return "is-esgoto-entupido";
    return "is-default";
  }

  function getMobileAddress(os: FirestoreOS): string {
    const rua = os.rua?.trim() || "Rua não informada";
    const numero = os.numero?.trim();
    const bairro = os.bairro?.trim();

    return [rua + (numero ? `, Nº ${numero}` : ""), bairro].filter(Boolean).join(" · ");
  }

  function getMobileProtocolLine(os: FirestoreOS): string {
    const protocolo = os.protocolo?.trim();
    const numeroOs = os.ordemServico?.trim();

    if (protocolo && numeroOs) return `Protocolo ${protocolo} · OS ${numeroOs}`;
    if (numeroOs) return `OS ${numeroOs}`;
    if (protocolo) return `Protocolo ${protocolo}`;
    return "Sem protocolo/OS informado";
  }

  return (
    <section className="page-card">
      <style>{`
        @media screen {
          #print-area { display: none; }
        }
        @media print {
          body.print-photo-active * { visibility: hidden !important; }
          body.print-photo-active #print-area,
          body.print-photo-active #print-area * { visibility: visible !important; }
          body.print-photo-active #print-area {
            display: block !important;
            position: fixed;
            inset: 0;
            padding: 12mm;
            background: #fff;
          }
          body.print-photo-active #print-area .print-title {
            margin: 0 0 8mm 0;
            font-size: 14px;
            font-weight: 600;
          }
          body.print-photo-active #print-area img {
            width: 100%;
            height: auto;
            max-height: calc(100vh - 30mm);
            object-fit: contain;
          }
        }
      `}</style>

      {printPhoto && (
        <div id="print-area">
          <p className="print-title">{printPhoto.title}</p>
          <img id="print-photo-img" src={printPhoto.url} alt={printPhoto.title} />
        </div>
      )}

      <header className="page-header">
        <div>
          <h2>Lista de Ordens de Serviço</h2>
          <p className="page-section-description">
            Visualize todas as OS cadastradas, gere o PDF com os dados completos,
            consulte as datas de criação e execução e veja os detalhes.
          </p>
        </div>
      </header>

      {statusMessage && (
        <div className={`status-banner status-${statusType}`}>{statusMessage}</div>
      )}

      {alertModal && (
        <div className="modal-backdrop" onClick={closeAlertModal}>
          <div
            className="modal"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: "560px", width: "92%" }}
          >
            <div className="modal-header">
              <h3 className="modal-title">{alertModal.title}</h3>
              <button type="button" className="modal-close" onClick={closeAlertModal}>
                ×
              </button>
            </div>

            <div className="modal-body">
              <p style={{ whiteSpace: "pre-line" }}>{alertModal.message}</p>
            </div>

            <div className="modal-footer">
              <button type="button" className="btn-primary" onClick={closeAlertModal}>
                OK
              </button>
            </div>
          </div>
        </div>
      )}


      {aguardandoSanearOpen && (
        <div
          className="modal-backdrop"
          onClick={() => {
            if (!savingDetails) setAguardandoSanearOpen(false);
          }}
        >
          <div
            className="modal"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: "640px", width: "92%" }}
          >
            <div className="modal-header">
              <h3 className="modal-title">Aguardando SANEAR</h3>
              <button
                type="button"
                className="modal-close"
                onClick={() => {
                  if (!savingDetails) setAguardandoSanearOpen(false);
                }}
              >
                ×
              </button>
            </div>

            <div className="modal-body">
              <p style={{ marginTop: 0, color: "#374151", lineHeight: 1.4 }}>
                Use quando a terceirizada não consegue executar porque depende de um serviço prévio
                da SANEAR. Enquanto estiver aguardando, o SLA fica pausado.
              </p>

              <div className="page-field" style={{ marginTop: "0.75rem" }}>
                <label>Motivo</label>
                <select
                  value={aguardandoMotivo}
                  onChange={(e) => setAguardandoMotivo(e.target.value)}
                  disabled={savingDetails}
                >
                  <option value="SERVICO_PREVIO">Serviço prévio da SANEAR</option>
                  <option value="BLOQUEIO_ACESSO">Bloqueio / acesso</option>
                  <option value="SEM_MATERIAL">Sem material</option>
                  <option value="RISCO">Risco / segurança</option>
                  <option value="OUTRO">Outro</option>
                </select>
              </div>

              <div className="page-field" style={{ marginTop: "0.75rem" }}>
                <label>Descrição (obrigatória)</label>
                <textarea
                  value={aguardandoDescricao}
                  onChange={(e) => setAguardandoDescricao(e.target.value)}
                  placeholder="Ex.: SANEAR precisa fazer manutenção na rede antes da execução."
                  rows={4}
                  disabled={savingDetails}
                />
              </div>
            </div>

            <div className="modal-footer">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setAguardandoSanearOpen(false)}
                disabled={savingDetails}
              >
                Cancelar
              </button>

              <button
                type="button"
                className="btn-primary"
                onClick={handleMarcarAguardandoSanear}
                disabled={savingDetails}
              >
                {savingDetails ? "Salvando..." : "Confirmar"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Filtros + busca (desktop normal, mobile em painel deslizante) */}
      <div className="os-toolbar os-toolbar-smart">
        <div
          className="os-toolbar-desktop-filters"
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "0.9rem",
            alignItems: "flex-end",
          }}
        >
          <div className="page-field" style={{ minWidth: 230 }}>
            <label>Serviço</label>
            <select
              value={filtroTipo}
              onChange={(e) => setFiltroTipo(e.target.value as TipoFiltroOs)}
            >
              {tipoFiltroOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div className="page-field" style={{ minWidth: 190 }}>
            <label>Data de criação</label>
            <input
              type="date"
              value={filtroDataCriacao}
              onChange={(e) => setFiltroDataCriacao(e.target.value)}
            />
          </div>

          <div className="page-field" style={{ minWidth: 170 }}>
            <label>Status</label>
            <select
              value={filtroStatus}
              onChange={(e) => setFiltroStatus(e.target.value as StatusFiltroOs)}
            >
              <option value="TODAS">Todas</option>
              <option value="ABERTAS">Abertas</option>
              <option value="FECHADAS">Fechadas</option>
            </select>
          </div>

          <div className="page-field" style={{ minWidth: 210 }}>
            <label>Ordenar por</label>
            <select
              value={ordenacaoCampo}
              onChange={(e) => setOrdenacaoCampo(e.target.value as OrdenacaoCampoOs)}
            >
              <option value="createdAt">Data de criação</option>
              <option value="dataExecucao">Data de execução</option>
            </select>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
            <span style={{ fontSize: "0.78rem", color: "#6b7280", fontWeight: 500 }}>
              Ordem
            </span>
            <button
              type="button"
              className="btn-secondary"
              onClick={() =>
                setOrdenacaoDirecao((prev) => (prev === "asc" ? "desc" : "asc"))
              }
            >
              {ordenacaoDirecao === "asc" ? "Crescente" : "Decrescente"}
            </button>
          </div>
        </div>

        <div className="os-search">
          <input
            className="os-search-input"
            type="text"
            placeholder="Buscar por número da OS, protocolo, endereço ou data..."
            value={busca}
            onChange={handleSearchChange}
          />
        </div>

        <div className="os-mobile-filter-bar">
          <div className="os-mobile-filter-summary">
            <span>{filtradas.length} OS encontradas</span>
            <strong>{filtrosAtivosQuantidade > 0 ? `${filtrosAtivosQuantidade} filtro(s) ativo(s)` : "Sem filtros extras"}</strong>
          </div>
          <button
            type="button"
            className="btn-primary os-mobile-filter-open"
            onClick={() => setMobileFiltersOpen(true)}
          >
            Filtrar
          </button>
        </div>
      </div>

      {mobileFiltersOpen && (
        <div
          className="os-mobile-filter-backdrop"
          onClick={() => setMobileFiltersOpen(false)}
        >
          <aside
            className="os-mobile-filter-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="Filtros da lista de OS"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="os-mobile-filter-handle" />

            <div className="os-mobile-filter-header">
              <div>
                <span>Lista de OS</span>
                <h3>Filtrar ordens</h3>
              </div>
              <button
                type="button"
                className="os-mobile-filter-close"
                onClick={() => setMobileFiltersOpen(false)}
                aria-label="Fechar filtros"
              >
                ×
              </button>
            </div>

            <div className="os-mobile-filter-current">
              <div>
                <span>Resultado</span>
                <strong>{filtradas.length} de {ordens.length} OS</strong>
              </div>
              <div>
                <span>Serviço</span>
                <strong>{filtroTipoLabel}</strong>
              </div>
              <div>
                <span>Status</span>
                <strong>{filtroStatusLabel}</strong>
              </div>
              <div>
                <span>Ordem</span>
                <strong>{ordenacaoLabel}</strong>
              </div>
            </div>

            <div className="os-mobile-filter-content">
              <section className="os-mobile-filter-section">
                <div className="os-mobile-filter-section-title">Serviço</div>
                <div className="os-mobile-chip-grid">
                  {tipoFiltroOptions.map((option) => (
                    <button
                      type="button"
                      key={option.value}
                      className={`os-mobile-chip ${filtroTipo === option.value ? "is-active" : ""}`}
                      onClick={() => setFiltroTipo(option.value)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </section>

              <section className="os-mobile-filter-section">
                <div className="os-mobile-filter-section-title">Status</div>
                <div className="os-mobile-chip-grid os-mobile-chip-grid-compact">
                  <button
                    type="button"
                    className={`os-mobile-chip ${filtroStatus === "TODAS" ? "is-active" : ""}`}
                    onClick={() => setFiltroStatus("TODAS")}
                  >
                    Todas
                  </button>
                  <button
                    type="button"
                    className={`os-mobile-chip ${filtroStatus === "ABERTAS" ? "is-active" : ""}`}
                    onClick={() => setFiltroStatus("ABERTAS")}
                  >
                    Abertas
                  </button>
                  <button
                    type="button"
                    className={`os-mobile-chip ${filtroStatus === "FECHADAS" ? "is-active" : ""}`}
                    onClick={() => setFiltroStatus("FECHADAS")}
                  >
                    Fechadas
                  </button>
                </div>
              </section>

              <section className="os-mobile-filter-section">
                <div className="os-mobile-filter-section-title">Data de criação</div>
                <div className="page-field os-mobile-filter-date">
                  <input
                    type="date"
                    value={filtroDataCriacao}
                    onChange={(e) => setFiltroDataCriacao(e.target.value)}
                  />
                </div>
              </section>

              <section className="os-mobile-filter-section">
                <div className="os-mobile-filter-section-title">Ordenação</div>
                <div className="os-mobile-sort-grid">
                  <button
                    type="button"
                    className={`os-mobile-sort-button ${ordenacaoCampo === "createdAt" ? "is-active" : ""}`}
                    onClick={() => setOrdenacaoCampo("createdAt")}
                  >
                    Data de criação
                  </button>
                  <button
                    type="button"
                    className={`os-mobile-sort-button ${ordenacaoCampo === "dataExecucao" ? "is-active" : ""}`}
                    onClick={() => setOrdenacaoCampo("dataExecucao")}
                  >
                    Data de execução
                  </button>
                  <button
                    type="button"
                    className={`os-mobile-sort-button ${ordenacaoDirecao === "desc" ? "is-active" : ""}`}
                    onClick={() => setOrdenacaoDirecao("desc")}
                  >
                    Mais recentes
                  </button>
                  <button
                    type="button"
                    className={`os-mobile-sort-button ${ordenacaoDirecao === "asc" ? "is-active" : ""}`}
                    onClick={() => setOrdenacaoDirecao("asc")}
                  >
                    Mais antigas
                  </button>
                </div>
              </section>
            </div>

            <div className="os-mobile-filter-footer">
              <button
                type="button"
                className="btn-secondary"
                onClick={limparFiltrosLista}
              >
                Limpar
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={() => setMobileFiltersOpen(false)}
              >
                Ver {filtradas.length} OS
              </button>
            </div>
          </aside>
        </div>
      )}

      {/* Tabela principal */}
      <div className="os-main">
        {loading && <div className="os-empty">Carregando ordens de serviço...</div>}

        {!loading && filtradas.length === 0 && (
          <div className="os-empty">Nenhuma ordem encontrada para os filtros atuais.</div>
        )}

        {!loading && filtradas.length > 0 && (
          <>
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

            <div className="os-table-wrapper os-table-wrapper-desktop" style={{ overflow: "auto", maxHeight: "70vh" }}>
              <table className="os-table">
                <thead style={{ position: "sticky", top: 0, zIndex: 9, background: "#fff" }}>
                  <tr>
                    <th style={stickyHeaderCellStyle}>Nº OS</th>
                    <th style={stickyHeaderCellStyle}>Serviço</th>
                    <th style={stickyHeaderCellStyle}>Bairro</th>
                    <th style={stickyHeaderCellStyle}>Rua / Avenida</th>
                    <th style={stickyHeaderCellStyle}>Dados da OS</th>
                    <th style={stickyHeaderCellStyle}>Data de criação</th>
                    <th style={stickyHeaderCellStyle}>Data de execução</th>
                    <th style={stickyHeaderCellStyle}>Fotos</th>
                  </tr>
                </thead>

                <tbody>
                  {paginatedOrdens.map((os) => {
                    const osKey = `${os.origem}:${os.id}`;
                    const isBlink = highlightRowKey === osKey;

                    return (
                      <tr
                        key={osKey}
                        data-os-key={osKey}
                        className={`os-table-row ${isBlink ? "os-table-row--blink" : ""}`}
                        onClick={() => {
                          setDetailsModalOs(os);
                          setIsEditingDetails(false);
                        }}
                        style={{ cursor: "pointer" }}
                      >
                        <td>{os.ordemServico || os.protocolo || "-"}</td>
                        <td>{getTipoOsLabel(os)}</td>
                        <td>{os.bairro || "-"}</td>
                        <td>{os.rua || "-"}</td>
                        <td>
                          <div className="os-row-actions">
                            <button
                              type="button"
                              className="btn-secondary"
                              onClick={(event) => handleOpenPdfModal(os, event)}
                            >
                              Abrir PDF
                            </button>
                          </div>
                        </td>
                        <td>{formatDateTime(os.createdAt)}</td>
                        <td>
                          <div>{formatDateTime(os.dataExecucao)}</div>
                          {os.origem === "hidrojato" && (
                            <small>{getCaminhaoExecucaoLabel(os)}</small>
                          )}
                        </td>
                        <td>
                          <div className="os-row-actions" style={{ gap: "0.5rem" }}>
                            {normalizeFotos(os.fotosExecucao).length > 0 && (
                              <button
                                type="button"
                                className="btn-secondary"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  openPhotoModalForOs(os, "execucao");
                                }}
                              >
                                Fotos ({normalizeFotos(os.fotosExecucao).length})
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="os-mobile-list" aria-label="Lista de ordens de serviço em cartões">
              {paginatedOrdens.map((os) => {
                const osKey = `${os.origem}:${os.id}`;
                const isBlink = highlightRowKey === osKey;
                return (
                  <article
                    key={`mobile-${osKey}`}
                    data-os-key={osKey}
                    className={`os-mobile-card ${getMobileTipoClass(os)} ${isBlink ? "os-mobile-card--blink" : ""}`}
                    onClick={() => {
                      setDetailsModalOs(os);
                      setIsEditingDetails(false);
                    }}
                  >
                    <div className="os-mobile-card-topline">
                      <span className={`os-mobile-type ${getMobileTipoClass(os)}`}>
                        {getTipoOsLabel(os)}
                      </span>
                      <span className={`os-mobile-status ${getMobileStatusClass(os)}`}>
                        {getMobileStatusLabel(os)}
                      </span>
                    </div>

                    <div className="os-mobile-card-main">
                      <div>
                        <h3>{os.ordemServico || os.protocolo || "OS sem número"}</h3>
                        <p>{getMobileProtocolLine(os)}</p>
                      </div>

                      {hasAttachedPdf(os) ? (
                        <span className="os-mobile-pdf-tag">PDF anexado</span>
                      ) : (
                        <span className="os-mobile-pdf-tag is-fallback">PDF gerado</span>
                      )}
                    </div>

                    <div className="os-mobile-location">
                      <span>📍</span>
                      <p>{getMobileAddress(os)}</p>
                    </div>

                    {os.pontoReferencia && (
                      <div className="os-mobile-reference">
                        <strong>Referência:</strong> {os.pontoReferencia}
                      </div>
                    )}

                    <div className="os-mobile-meta-grid">
                      <div>
                        <span>Criada</span>
                        <strong>{formatDateTime(os.createdAt)}</strong>
                      </div>
                      <div>
                        <span>Execução</span>
                        <strong>{formatDateTime(os.dataExecucao)}</strong>
                      </div>
                      {os.origem === "hidrojato" && (
                        <div>
                          <span>Caminhão</span>
                          <strong>{getCaminhaoExecucaoLabel(os)}</strong>
                        </div>
                      )}
                    </div>

                    <div className="os-mobile-actions">
                      <button
                        type="button"
                        className="btn-primary"
                        onClick={(event) => handleOpenPdfModal(os, event)}
                      >
                        Abrir PDF
                      </button>

                      {normalizeFotos(os.fotosExecucao).length > 0 && (
                        <button
                          type="button"
                          className="btn-secondary"
                          onClick={(event) => {
                            event.stopPropagation();
                            openPhotoModalForOs(os, "execucao");
                          }}
                        >
                          Fotos ({normalizeFotos(os.fotosExecucao).length})
                        </button>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>

            <AppPagination
              currentPage={currentPage}
              totalPages={totalPages}
              totalItems={filtradas.length}
              onPageChange={setCurrentPage}
              variant="bottom"
              label="OS"
            />
          </>
        )}
      </div>

      {/* Modal de PDF com dados da OS */}
      {pdfModalOs && (
        <div className="modal-backdrop" onClick={closePdfModal}>
          <div
            className="modal"
            onClick={(e) => e.stopPropagation()}
            style={{
              maxWidth: "95vw",
              width: "95vw",
              height: "90vh",
              padding: 0,
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div
              style={{
                padding: "0.5rem 1rem",
                borderBottom: "1px solid #e5e7eb",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <h3 className="modal-title" style={{ margin: 0 }}>
                OS {pdfModalOs.ordemServico || pdfModalOs.protocolo || pdfModalOs.id}
              </h3>
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <button type="button" className="btn-secondary" onClick={closePdfModal}>
                  Fechar
                </button>
                {!pdfModalLoading && pdfModalUrl && (
                  <button type="button" className="btn-primary" onClick={handlePrintCurrentPdf}>
                    Imprimir
                  </button>
                )}
              </div>
            </div>

            <div style={{ flex: 1 }}>
              {pdfModalLoading && (
                <div className="os-empty">Abrindo PDF da OS...</div>
              )}
              {!pdfModalLoading && pdfModalUrl && (
                <iframe
                  src={pdfModalUrl}
                  title="PDF com dados da OS"
                  style={{ width: "100%", height: "100%", border: "none" }}
                />
              )}
            </div>
          </div>
        </div>
      )}

      {/* Modal de detalhes */}
      {detailsModalOs && (
        <div className="modal-backdrop" onClick={closeDetailsModal}>
          <div
            className="modal"
            style={{ maxWidth: "900px", width: "90%" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h3 className="modal-title">
                Detalhes da OS{" "}
                {detailsModalOs.ordemServico || detailsModalOs.protocolo || detailsModalOs.id}
              </h3>
              <button
                type="button"
                className="modal-close"
                onClick={closeDetailsModal}
                disabled={savingDetails}
              >
                ×
              </button>
            </div>

            <div className="modal-body">
              <div className="page-section">
                <h3>Identificação</h3>
                <div className="page-form-grid">
                  <div className="page-field">
                    <label>Tipo</label>
                    <input
                      className="field-readonly"
                      readOnly
                      value={
                        getTipoOsLabel(detailsModalOs)
                      }
                    />
                  </div>

                  <div className="page-field">
                    <label>Nº OS</label>
                    <input
                      className="field-readonly"
                      readOnly={readOnlyEditableFields}
                      value={detailsModalOs.ordemServico ?? ""}
                      onChange={(e) =>
                        setDetailsModalOs((prev) =>
                          prev ? { ...prev, ordemServico: e.target.value } : prev
                        )
                      }
                    />
                  </div>

                  <div className="page-field">
                    <label>Protocolo</label>
                    <input
                      className="field-readonly"
                      readOnly={readOnlyEditableFields}
                      value={detailsModalOs.protocolo ?? ""}
                      onChange={(e) =>
                        setDetailsModalOs((prev) =>
                          prev ? { ...prev, protocolo: e.target.value } : prev
                        )
                      }
                    />
                  </div>

                  <div className="page-field">
                    <label>Status</label>
                    <input
                      className="field-readonly"
                      readOnly
                      value={formatOrdemStatusLabel(detailsModalOs.status, { uppercase: true })}
                    />
                  </div>

                  <div className="page-field">
                    <label>Data de criação</label>
                    <input className="field-readonly" readOnly value={formatDateTime(detailsModalOs.createdAt)} />
                  </div>

                  <div className="page-field">
                    <label>Data de execução</label>

                    {isEditingDetails && canEditCurrent && isAdmRole(currentUserRole) ? (
                      <input
                        className="field-readonly"
                        type="datetime-local"
                        value={toDateTimeLocal(detailsModalOs.dataExecucao)}
                        onChange={(e) =>
                          setDetailsModalOs((prev) =>
                            prev
                              ? {
                                  ...prev,
                                  dataExecucao: e.target.value
                                    ? Timestamp.fromDate(fromDateTimeLocal(e.target.value))
                                    : null,
                                }
                              : prev
                          )
                        }
                      />
                    ) : (
                      <input className="field-readonly" readOnly value={formatDateTime(detailsModalOs.dataExecucao)} />
                    )}
                  </div>

                  {detailsModalOs.origem === "hidrojato" && (
                    <div className="page-field">
                      <label>Execução Hidrojato</label>
                      <input
                        className="field-readonly"
                        readOnly
                        value={getCaminhaoExecucaoLabel(detailsModalOs)}
                      />
                    </div>
                  )}
                </div>
              </div>

              <div className="page-section">
                <h3>Local do serviço</h3>
                <div className="page-form-grid">
                  <div className="page-field">
                    <label>Bairro</label>
                    <input
                      className="field-readonly"
                      readOnly={readOnlyEditableFields}
                      value={detailsModalOs.bairro ?? ""}
                      onChange={(e) =>
                        setDetailsModalOs((prev) =>
                          prev ? { ...prev, bairro: e.target.value } : prev
                        )
                      }
                    />
                  </div>

                  <div className="page-field">
                    <label>Rua / Avenida</label>
                    <input
                      className="field-readonly"
                      readOnly={readOnlyEditableFields}
                      value={detailsModalOs.rua ?? ""}
                      onChange={(e) =>
                        setDetailsModalOs((prev) =>
                          prev ? { ...prev, rua: e.target.value } : prev
                        )
                      }
                    />
                  </div>

                  <div className="page-field">
                    <label>Número</label>
                    <input
                      className="field-readonly"
                      readOnly={readOnlyEditableFields}
                      value={detailsModalOs.numero ?? ""}
                      onChange={(e) =>
                        setDetailsModalOs((prev) =>
                          prev ? { ...prev, numero: e.target.value } : prev
                        )
                      }
                    />
                  </div>

                  <div className="page-field">
                    <label>Ponto de referência</label>
                    <input
                      className="field-readonly"
                      readOnly={readOnlyEditableFields}
                      value={detailsModalOs.pontoReferencia ?? ""}
                      onChange={(e) =>
                        setDetailsModalOs((prev) =>
                          prev ? { ...prev, pontoReferencia: e.target.value } : prev
                        )
                      }
                    />
                  </div>
                </div>
              </div>

              <div className="page-section">
                <h3>Observações</h3>
                <div className="page-field">
                  <textarea
                    className="field-readonly"
                    readOnly={readOnlyEditableFields}
                    value={detailsModalOs.observacoes ?? ""}
                    onChange={(e) =>
                      setDetailsModalOs((prev) =>
                        prev ? { ...prev, observacoes: e.target.value } : prev
                      )
                    }
                  />
                </div>
              </div>


              <div className="page-section">
                <h3>Histórico operacional</h3>
                {auditoriaEventos.length === 0 ? (
                  <p className="field-hint">
                    Nenhum registro de auditoria foi encontrado para esta OS ainda.
                  </p>
                ) : (
                  <div className="audit-timeline">
                    {auditoriaEventos.slice(0, 8).map((evento) => (
                      <div className="audit-item" key={evento.id}>
                        <div className="audit-dot" aria-hidden="true" />
                        <div>
                          <strong>{evento.titulo}</strong>
                          <span>
                            {formatAuditDate(evento.criadoEm)}
                            {evento.usuarioEmail ? ` • ${evento.usuarioEmail}` : ""}
                          </span>
                          {evento.descricao && <p>{evento.descricao}</p>}
                          {(evento.statusAntes || evento.statusDepois) && (
                            <small>
                              Status: {evento.statusAntes || "-"} → {evento.statusDepois || "-"}
                            </small>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="page-section">
                <h3>PDF da OS anexado</h3>
                <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
                  {hasAttachedPdf(detailsModalOs) ? (
                    <>
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => handleOpenAttachedPdfFromDetails(detailsModalOs)}
                      >
                        Abrir PDF anexado na criação
                      </button>
                      <span className="field-hint">
                        {detailsModalOs.ordemServicoPdfNomeArquivo || "PDF anexado"}
                        {detailsModalOs.ordemServicoPdfDataAnexo ? ` — ${detailsModalOs.ordemServicoPdfDataAnexo}` : ""}
                      </span>
                    </>
                  ) : (
                    <span className="field-hint">Nenhum PDF anexado na criação desta OS.</span>
                  )}
                </div>
              </div>

              <div className="page-section">
                <h3>Fotos de execução da terceirizada</h3>
                <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => openPhotoModalFromDetails("execucao")}
                    disabled={fotosExecucaoDetalhes.length === 0}
                  >
                    Ver fotos
                    {fotosExecucaoDetalhes.length > 0 ? ` (${fotosExecucaoDetalhes.length})` : ""}
                  </button>
                  {fotosExecucaoDetalhes.length === 0 && (
                    <span className="field-hint">
                      Nenhuma foto de encerramento foi enviada pela terceirizada para esta OS.
                    </span>
                  )}
                </div>
              </div>
            </div>

            <div className="modal-footer">
              <button
                type="button"
                className="btn-secondary"
                onClick={closeDetailsModal}
                disabled={savingDetails}
              >
                Fechar
              </button>

              {canEditCurrent && detailsModalFechada && (
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => handleReabrirOs(detailsModalOs)}
                  disabled={savingDetails}
                >
                  {savingDetails ? "Reabrindo..." : "Reabrir OS"}
                </button>
              )}

              {canEditCurrentFields && !isEditingDetails && (
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => setIsEditingDetails(true)}
                  disabled={savingDetails}
                >
                  Editar OS
                </button>
              )}

              {canEditCurrentFields && isEditingDetails && (
                <button
                  type="button"
                  className="btn-primary"
                  onClick={handleSaveDetails}
                  disabled={savingDetails}
                >
                  {savingDetails ? "Salvando..." : "Salvar alterações"}
                </button>
              )}

              {!detailsModalFechada && normalizeStatus(detailsModalOs.status) === "AGUARDANDO_SANEAR" && (
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={handleRetomarSanear}
                  disabled={savingDetails}
                >
                  {savingDetails ? "Atualizando..." : "SANEAR liberou"}
                </button>
              )}

              {!detailsModalFechada && normalizeStatus(detailsModalOs.status) !== "AGUARDANDO_SANEAR" && (
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => {
                    setAguardandoMotivo("SERVICO_PREVIO");
                    setAguardandoDescricao("");
                    setAguardandoSanearOpen(true);
                  }}
                  disabled={savingDetails}
                >
                  Aguardando SANEAR
                </button>
              )}

              <button
                type="button"
                className="btn-danger"
                onClick={() => handleDeleteOs(detailsModalOs)}
                disabled={savingDetails}
              >
                Excluir OS
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL DE FOTOS */}
      {photoModal &&
        (() => {
          const os = getOsFromPhotoModal(photoModal);
          const fotos = getFotosFromModalState(photoModal);
          const fotoAtual = fotos[photoModal.currentIndex] ?? fotos[0];

          const totalExec = normalizeFotos(os?.fotosExecucao).length;

          return (
            <div className="modal-backdrop" onClick={closePhotoModal}>
              <div className="modal modal-photo" onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                  <h3 className="modal-title">
                    Fotos da Terceirizada — OS {os?.ordemServico || os?.protocolo || os?.id || photoModal.osId}
                  </h3>
                  <button type="button" className="modal-close" onClick={closePhotoModal}>
                    ×
                  </button>
                </div>

                <div
                  style={{
                    padding: "0.75rem 1rem 0.5rem",
                    borderBottom: "1px solid #e5e7eb",
                    display: "flex",
                    gap: "0.5rem",
                    flexWrap: "wrap",
                  }}
                >
                  <span className="btn-primary" style={{ pointerEvents: "none" }}>
                    Fotos da Terceirizada{totalExec > 0 ? ` (${totalExec})` : ""}
                  </span>
                </div>

                <div className="modal-body modal-photo-body">
                  {!os && <p className="field-hint">OS não encontrada (atualize a página).</p>}

                  {os && fotos.length === 0 && (
                    <p className="field-hint">
                      Nenhuma foto cadastrada pela terceirizada para esta OS.
                    </p>
                  )}

                  {os && fotos.length > 0 && fotoAtual && (
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "1rem" }}>
                      {fotos.length > 1 && (
                        <button type="button" className="btn-secondary" onClick={goToPrevPhoto}>
                          ←
                        </button>
                      )}

                      <div style={{ maxWidth: "100%", width: "100%", textAlign: "center" }}>
                        <ZipAwarePhoto
                          photo={fotoAtual}
                          style={{
                            width: "100%",
                            maxHeight: "70vh",
                            objectFit: "contain",
                            borderRadius: "0.75rem",
                          }}
                        />
                        <p className="photo-modal-timestamp">
                          {fotoAtual.label}
                          {fotos.length > 1 && (
                            <>
                              {" "}
                              · Foto {photoModal.currentIndex + 1} de {fotos.length}
                            </>
                          )}
                        </p>
                      </div>

                      {fotos.length > 1 && (
                        <button type="button" className="btn-secondary" onClick={goToNextPhoto}>
                          →
                        </button>
                      )}
                    </div>
                  )}
                </div>

                <div
                  className="modal-footer"
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: "0.75rem",
                    flexWrap: "wrap",
                  }}
                >
                  <div style={{ display: "flex", gap: "0.5rem" }}>
                    <button type="button" className="btn-secondary" onClick={closePhotoModal}>
                      Fechar
                    </button>

                    {os && fotos.length > 0 && (
                      <button type="button" className="btn-secondary" onClick={handlePrintCurrentPhoto}>
                        Imprimir
                      </button>
                    )}

                    {os && canEditOs(os) && !isOsFechada(os) && fotos.length > 0 && (
                      <button type="button" className="btn-danger" onClick={handleDeleteCurrentPhoto}>
                        Excluir foto
                      </button>
                    )}
                  </div>

                  {os && canEditOs(os) && !isOsFechada(os) && fotos.length < 2 && (
                    <div>
                      <input
                        ref={addPhotoInputRef}
                        type="file"
                        accept="image/*"
                        multiple
                        style={{ display: "none" }}
                        onChange={handleAddPhotosChange}
                      />
                      <button type="button" className="btn-secondary" onClick={triggerAddPhotos}>
                        Adicionar fotos
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })()}
    </section>
  );
};

export default ListaOrdensServico;
