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
} from "firebase/firestore";
import { db, auth } from "../lib/firebaseClient";
import { supabase } from "../lib/supabaseClient";
import { upsertSanearPause, closeSanearPause, hasOpenSanearPause } from "../lib/sla";

// pdf-lib para gerar o PDF com os dados da OS
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const STORAGE_BUCKET = "os-arquivos";

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

  // SLA (72h) e pausa SANEAR
  slaHoras?: number | null;
  slaPausas?: any[] | null;
  statusAntesAguardandoSanear?: string | null;

  // ainda mantido por compatibilidade, mas não usado para gerar o PDF de dados
  ordemServicoPdfBase64?: string | null;
  ordemServicoPdfNomeArquivo?: string | null;
  ordemServicoPdfDataAnexo?: string | null;

  // fotos
  fotos?: any[] | null; // operador (abertura)
  fotosExecucao?: any[] | null; // terceirizada (execução)
};

type StatusType = "success" | "error" | "info";

type StatusFiltroOs = "TODAS" | "ABERTAS" | "AGUARDANDO_SANEAR" | "FECHADAS";
type OrdenacaoCampoOs = "createdAt" | "dataExecucao";
type OrdenacaoDirecaoOs = "asc" | "desc";

type NormalizedPhoto = {
  id: string;
  label: string;
  url: string;
  sourceIndex: number; // índice original no array salvo no Firestore
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
} | null;

// FRONTEND APENAS: labels amigáveis
const tipoLabelMap: Record<string, string> = {
  BURACO_RUA: "Calçamento",
  ASFALTO: "Asfalto",
};

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

      return {
        id,
        label,
        url,
        sourceIndex: index,
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

  const [busca, setBusca] = useState("");

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

  useEffect(() => {
    const user = auth.currentUser;
    setCurrentUserEmail(user?.email ?? null);

    const storedRole =
      localStorage.getItem("sanear-role") ?? localStorage.getItem("userRole");
    setCurrentUserRole(storedRole);
  }, []);

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
          const pdfNested = raw.ordemServicoPdf ?? null;
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
            fotos: resolveFotosAbertura(raw),
            fotosExecucao: resolveFotosExecucao(raw),
            ordemServicoPdfBase64:
              raw.ordemServicoPdfBase64 ?? pdfNested?.base64 ?? null,
            ordemServicoPdfNomeArquivo:
              raw.ordemServicoPdfNomeArquivo ?? pdfNested?.nomeArquivo ?? null,
            ordemServicoPdfDataAnexo:
              raw.ordemServicoPdfDataAnexo ?? pdfNested?.dataAnexoTexto ?? null,
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
          const pdfNested = raw.ordemServicoPdf ?? null;
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
            fotos: resolveFotosAbertura(raw),
            fotosExecucao: resolveFotosExecucao(raw),
            ordemServicoPdfBase64:
              raw.ordemServicoPdfBase64 ?? pdfNested?.base64 ?? null,
            ordemServicoPdfNomeArquivo:
              raw.ordemServicoPdfNomeArquivo ?? pdfNested?.nomeArquivo ?? null,
            ordemServicoPdfDataAnexo:
              raw.ordemServicoPdfDataAnexo ?? pdfNested?.dataAnexoTexto ?? null,
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

    return () => {
      unsubBuraco();
      unsubAsfalto();
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

      const all = [...ordensBuraco, ...ordensAsfalto];
      const found = all.find((o) => o.id === id);

      if (found) {
        setDetailsModalOs(found);
        setIsEditingDetails(false);
        window.sessionStorage.removeItem("sanear-open-os");
      }
    } catch {
      window.sessionStorage.removeItem("sanear-open-os");
    }
  }, [loading, ordensBuraco, ordensAsfalto]);

  const ordens = useMemo(() => {
    return [...ordensBuraco, ...ordensAsfalto];
  }, [ordensBuraco, ordensAsfalto]);

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
    const status = String(os.status ?? "ABERTA").trim().toUpperCase();
    if (!status || status === "ABERTA" || status === "ABERTO") return false;

    if (status.startsWith("CONCLU")) return true;
    if (status.startsWith("CANCEL")) return true;
    if (status.startsWith("FECH")) return true;
    if (status.startsWith("ENCERR")) return true;

    if (os.dataExecucao) return true;
    return false;
  }

  function isAguardandoSanearStatus(status?: string | null): boolean {
    const s = String(status ?? "").trim().toUpperCase();
    return s === "AGUARDANDO_SANEAR" || s === "AGUARDANDO SANEAR";
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

    if (filtroDataCriacao) {
      lista = lista.filter((os) =>
        isSameLocalDate(os.createdAt, filtroDataCriacao)
      );
    }

    if (filtroStatus !== "TODAS") {
      lista = lista.filter((os) => {
        if (filtroStatus === "AGUARDANDO_SANEAR") {
          return isAguardandoSanearStatus(os.status);
        }
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
    filtroDataCriacao,
    filtroStatus,
    ordenacaoCampo,
    ordenacaoDirecao,
  ]);

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

    const tipoLabel =
      tipoLabelMap[os.tipo || ""] ||
      os.tipo ||
      (os.origem === "asfalto" ? "Asfalto" : "Calçamento");

    const rows: { label: string; value: string }[] = [
      { label: "Tipo", value: tipoLabel },
      {
        label: "Origem",
        value: os.origem === "asfalto" ? "Asfalto" : "Calçamento",
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
      const url = await generateOsDataPdfUrl(os);
      setPdfModalUrl(url);
    } catch (err) {
      console.error(err);
      setStatusMessage(
        "Não foi possível gerar o PDF com os dados da OS. Tente novamente."
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

  function handlePrintCurrentPdf() {
    window.print();
  }

  // ✅ PASSO 3: delete com cleanup no Storage
  
async function handleMarcarAguardandoSanear() {
  if (!detailsModalOs) return;

  const descricao = aguardandoDescricao.trim();
  if (descricao.length < 3) {
    openAlertModal("Descrição obrigatória", "Informe uma descrição curta do motivo (mín. 3 caracteres).");
    return;
  }

  try {
    setSavingDetails(true);

    const collectionName =
      detailsModalOs.origem === "asfalto" ? "ordensServico" : "ordens_servico";

    const statusAtual = normalizeStatus(detailsModalOs.status);
    const statusAntes =
      detailsModalOs.statusAntesAguardandoSanear ??
      (statusAtual && statusAtual !== "AGUARDANDO_SANEAR" ? statusAtual : "ABERTA");

    const pausasAtualizadas = upsertSanearPause(detailsModalOs.slaPausas, {
      tipo: "SANEAR",
      motivo: aguardandoMotivo,
      descricao,
      inicioEm: new Date(),
    });

    await updateDoc(doc(db, collectionName, detailsModalOs.id), {
      status: "AGUARDANDO_SANEAR",
      statusAntesAguardandoSanear: statusAntes,
      slaPausas: pausasAtualizadas,
      updatedAt: serverTimestamp(),
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
      detailsModalOs.origem === "asfalto" ? "ordensServico" : "ordens_servico";

    const pausasFechadas = closeSanearPause(detailsModalOs.slaPausas, new Date());
    const novoStatus = detailsModalOs.statusAntesAguardandoSanear || "ABERTA";

    await updateDoc(doc(db, collectionName, detailsModalOs.id), {
      status: novoStatus,
      statusAntesAguardandoSanear: null,
      slaPausas: pausasFechadas,
      updatedAt: serverTimestamp(),
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

async function handleDeleteOs(os: FirestoreOS) {
    const confirmDelete = window.confirm(
      "Tem certeza que deseja excluir esta ordem de serviço? Esta ação não pode ser desfeita."
    );
    if (!confirmDelete) return;

    try {
      const collectionName =
        os.origem === "asfalto" ? "ordensServico" : "ordens_servico";

      // Cleanup no Storage ANTES de deletar o doc
      const basePath = os.origem === "asfalto" ? "asfalto" : "buraco-rua";
      const prefix = `${basePath}/${os.id}`;

      let storageOk = true;
      let removedFiles = 0;

      try {
        removedFiles = await removeStorageFolderRecursive(prefix);
      } catch (e) {
        storageOk = false;
        console.error("Falha ao remover arquivos do Storage:", e);
      }

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
  return String(value ?? "").trim().toUpperCase();
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

    try {
      setSavingDetails(true);

      const collectionName =
        detailsModalOs.origem === "asfalto"
          ? "ordensServico"
          : "ordens_servico";

      await updateDoc(doc(db, collectionName, detailsModalOs.id), {
        ordemServico: detailsModalOs.ordemServico || null,
        protocolo: detailsModalOs.protocolo || null,
        bairro: detailsModalOs.bairro || null,
        rua: detailsModalOs.rua || null,
        numero: detailsModalOs.numero || null,
        pontoReferencia: detailsModalOs.pontoReferencia || null,
        observacoes: detailsModalOs.observacoes || null,
        status: detailsModalOs.status || null,

        ...(isAdmRole(currentUserRole)
          ? { dataExecucao: detailsModalOs.dataExecucao ?? null }
          : {}),

        updatedAt: serverTimestamp(),
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

  const canEditCurrent =
    detailsModalOs && canEditOs(detailsModalOs) ? true : false;
  const readOnlyEditableFields = !isEditingDetails || !canEditCurrent;

  function openPhotoModalForOs(os: FirestoreOS, preferido?: PhotoModalTipo) {
    const temAbertura = normalizeFotos(os.fotos).length > 0;
    const temExecucao = normalizeFotos(os.fotosExecucao).length > 0;

    let tipo: PhotoModalTipo = "abertura";
    if (preferido) tipo = preferido;
    else if (!temAbertura && temExecucao) tipo = "execucao";

    setPhotoModal({
      osId: os.id,
      origem: os.origem,
      tipo,
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

  function getFotosFromModalState(state: PhotoModalState | null): NormalizedPhoto[] {
    const os = getOsFromPhotoModal(state);
    if (!os || !state) return [];
    return normalizeFotos(state.tipo === "abertura" ? os.fotos : os.fotosExecucao);
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
        os.origem === "asfalto" ? "ordensServico" : "ordens_servico";

      const originalArray: any[] =
        (tipo === "abertura" ? os.fotos : os.fotosExecucao) || [];
      const updatedArray = originalArray.filter(
        (_f, idx) => idx !== fotoAtual.sourceIndex
      );

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

    const { tipo } = photoModal;

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

    try {
      const basePath = os.origem === "asfalto" ? "asfalto" : "buraco-rua";
      const subfolder = tipo === "abertura" ? "fotos" : "fotos-execucao";

      const agora = new Date();
      const dataAnexoTexto = agora.toLocaleString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });

      const novosItens: any[] = [];

      for (const file of validFiles) {
        const originalName = file.name || "foto.jpg";
        const safeName = sanitizeForStoragePath(originalName);

        const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const path = `${basePath}/${os.id}/${subfolder}/${id}-${safeName}`;

        const { error: uploadError } = await supabase.storage
          .from(STORAGE_BUCKET)
          .upload(path, file, { upsert: true });

        if (uploadError) {
          console.error(uploadError);
          throw new Error(
            `Erro ao enviar foto "${originalName}" para o armazenamento.`
          );
        }

        const { data } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(path);
        const url = data.publicUrl;

        novosItens.push({ id, nomeArquivo: originalName, dataAnexoTexto, url });
      }

      const collectionName =
        os.origem === "asfalto" ? "ordensServico" : "ordens_servico";

      const originalArray: any[] =
        (tipo === "abertura" ? os.fotos : os.fotosExecucao) || [];
      const updatedArray = [...originalArray, ...novosItens];

      await updateDoc(doc(db, collectionName, os.id), {
        [tipo === "abertura" ? "fotos" : "fotosExecucao"]: updatedArray,
        updatedAt: serverTimestamp(),
      });

      setStatusMessage("Foto(s) adicionada(s) com sucesso.");
      setStatusType("success");

      // vai para a última foto
      setPhotoModal((prev) =>
        prev ? { ...prev, currentIndex: updatedArray.length - 1 } : prev
      );
    } catch (error) {
      console.error(error);
      setStatusMessage("Não foi possível adicionar as fotos. Tente novamente mais tarde.");
      setStatusType("error");
    } finally {
      e.target.value = "";
    }
  }

  // IMPRIMIR FOTO (SEM POPUP)
  function handlePrintCurrentPhoto() {
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

    setPrintPhoto({ title: titulo, url: foto.url });
  }

  useEffect(() => {
    if (!printPhoto) return;

    document.body.classList.add("print-photo-active");

    const onAfterPrint = () => {
      document.body.classList.remove("print-photo-active");
      setPrintPhoto(null);
    };

    window.addEventListener("afterprint", onAfterPrint);

    const fallback = window.setTimeout(() => {
      document.body.classList.remove("print-photo-active");
      setPrintPhoto(null);
    }, 15000);

    const tryPrint = () => {
      setTimeout(() => {
        try {
          window.print();
        } catch {
          document.body.classList.remove("print-photo-active");
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

      {/* Filtros + busca (Buscar continua igual) */}
      <div className="os-toolbar">
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "0.9rem",
            alignItems: "flex-end",
          }}
        >
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
              <option value="AGUARDANDO_SANEAR">Aguardando SANEAR</option>
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
      </div>

      {/* Tabela principal */}
      <div className="os-main">
        {loading && <div className="os-empty">Carregando ordens de serviço...</div>}

        {!loading && filtradas.length === 0 && (
          <div className="os-empty">Nenhuma ordem encontrada para os filtros atuais.</div>
        )}

        {!loading && filtradas.length > 0 && (
          <div className="os-table-wrapper" style={{ overflow: "auto", maxHeight: "70vh" }}>
            <table className="os-table">
              <thead style={{ position: "sticky", top: 0, zIndex: 9, background: "#fff" }}>
                <tr>
                  <th style={stickyHeaderCellStyle}>Nº OS</th>
                  <th style={stickyHeaderCellStyle}>Bairro</th>
                  <th style={stickyHeaderCellStyle}>Rua / Avenida</th>
                  <th style={stickyHeaderCellStyle}>Dados da OS</th>
                  <th style={stickyHeaderCellStyle}>Data de criação</th>
                  <th style={stickyHeaderCellStyle}>Data de execução</th>
                  <th style={stickyHeaderCellStyle}>Ações</th>
                </tr>
              </thead>

              <tbody>
                {filtradas.map((os) => {
                  const qtdAbertura = normalizeFotos(os.fotos).length;
                  const qtdExecucao = normalizeFotos(os.fotosExecucao).length;
                  const totalFotos = qtdAbertura + qtdExecucao;
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
                      <td>{os.bairro || "-"}</td>
                      <td>{os.rua || "-"}</td>
                      <td>
                        <div className="os-row-actions">
                          <button
                            type="button"
                            className="btn-secondary"
                            onClick={(event) => handleOpenPdfModal(os, event)}
                          >
                            Ver dados
                          </button>
                        </div>
                      </td>
                      <td>{formatDateTime(os.createdAt)}</td>
                      <td>{formatDateTime(os.dataExecucao)}</td>
                      <td>
                        <div className="os-row-actions" style={{ gap: "0.5rem" }}>
                          <button
                            type="button"
                            className="btn-secondary"
                            onClick={(event) => {
                              event.stopPropagation();
                              openPhotoModalFromRow(os);
                            }}
                          >
                            Ver fotos{totalFotos > 0 ? ` (${totalFotos})` : ""}
                          </button>

                          <button
                            type="button"
                            className="btn-secondary"
                            style={!canEditOs(os) ? { opacity: 0.65 } : undefined}
                            onClick={(event) => {
                              event.stopPropagation();
                              setDetailsModalOs(os);

                              if (canEditOs(os)) {
                                setIsEditingDetails(true);
                              } else {
                                setIsEditingDetails(false);
                                openAlertModal(
                                  "Sem permissão",
                                  "Você não tem permissão para editar esta OS."
                                );
                              }
                            }}
                          >
                            Editar
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
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
                <div className="os-empty">Gerando PDF com dados da OS...</div>
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
                        tipoLabelMap[detailsModalOs.tipo || ""] ||
                        detailsModalOs.tipo ||
                        (detailsModalOs.origem === "asfalto" ? "Asfalto" : "Calçamento")
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
                      readOnly={readOnlyEditableFields}
                      value={detailsModalOs.status || "ABERTA"}
                      onChange={(e) =>
                        setDetailsModalOs((prev) =>
                          prev ? { ...prev, status: e.target.value } : prev
                        )
                      }
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
                <h3>Fotos da abertura da OS (Operador)</h3>
                <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => openPhotoModalFromDetails("abertura")}
                  >
                    Ver fotos cadastradas
                    {fotosAberturaDetalhes.length > 0 ? ` (${fotosAberturaDetalhes.length})` : ""}
                  </button>
                  {fotosAberturaDetalhes.length === 0 && (
                    <span className="field-hint">Nenhuma foto cadastrada na abertura desta OS.</span>
                  )}
                </div>
              </div>

              <div className="page-section">
                <h3>Fotos da execução (Terceirizada)</h3>
                <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => openPhotoModalFromDetails("execucao")}
                  >
                    Ver fotos cadastradas
                    {fotosExecucaoDetalhes.length > 0 ? ` (${fotosExecucaoDetalhes.length})` : ""}
                  </button>
                  {fotosExecucaoDetalhes.length === 0 && (
                    <span className="field-hint">
                      Nenhuma foto de execução cadastrada pela terceirizada para esta OS.
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

              {canEditCurrent && isEditingDetails && (
                <button
                  type="button"
                  className="btn-primary"
                  onClick={handleSaveDetails}
                  disabled={savingDetails}
                >
                  {savingDetails ? "Salvando..." : "Salvar alterações"}
                </button>
              )}

              {normalizeStatus(detailsModalOs.status) === "AGUARDANDO_SANEAR" ? (
                <button
                  type="button"
                  className="btn-primary"
                  onClick={handleRetomarSanear}
                  disabled={savingDetails}
                >
                  {savingDetails ? "Atualizando..." : "SANEAR liberou (retomar)"}
                </button>
              ) : (
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
                className="btn-primary btn-danger"
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

          const totalAbertura = normalizeFotos(os?.fotos).length;
          const totalExec = normalizeFotos(os?.fotosExecucao).length;

          return (
            <div className="modal-backdrop" onClick={closePhotoModal}>
              <div className="modal modal-photo" onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                  <h3 className="modal-title">
                    Fotos da OS {os?.ordemServico || os?.protocolo || os?.id || photoModal.osId}
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
                  <button
                    type="button"
                    className={photoModal.tipo === "abertura" ? "btn-primary" : "btn-secondary"}
                    onClick={() =>
                      setPhotoModal((prev) =>
                        prev ? { ...prev, tipo: "abertura", currentIndex: 0 } : prev
                      )
                    }
                    disabled={totalAbertura === 0}
                  >
                    Fotos do Operador{totalAbertura > 0 ? ` (${totalAbertura})` : ""}
                  </button>

                  <button
                    type="button"
                    className={photoModal.tipo === "execucao" ? "btn-primary" : "btn-secondary"}
                    onClick={() =>
                      setPhotoModal((prev) =>
                        prev ? { ...prev, tipo: "execucao", currentIndex: 0 } : prev
                      )
                    }
                    disabled={totalExec === 0}
                  >
                    Fotos da Terceirizada{totalExec > 0 ? ` (${totalExec})` : ""}
                  </button>
                </div>

                <div className="modal-body modal-photo-body">
                  {!os && <p className="field-hint">OS não encontrada (atualize a página).</p>}

                  {os && fotos.length === 0 && (
                    <p className="field-hint">
                      {photoModal.tipo === "abertura"
                        ? "Nenhuma foto cadastrada pelo operador para esta OS."
                        : "Nenhuma foto cadastrada pela terceirizada para esta OS."}
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
                        <img
                          src={fotoAtual.url}
                          alt={fotoAtual.label}
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
                      <button type="button" className="btn-primary" onClick={handlePrintCurrentPhoto}>
                        Imprimir
                      </button>
                    )}

                    {os && canEditOs(os) && fotos.length > 0 && (
                      <button type="button" className="btn-primary btn-danger" onClick={handleDeleteCurrentPhoto}>
                        Excluir foto
                      </button>
                    )}
                  </div>

                  {os && canEditOs(os) && (
                    <div>
                      <input
                        ref={addPhotoInputRef}
                        type="file"
                        accept="image/*"
                        multiple
                        style={{ display: "none" }}
                        onChange={handleAddPhotosChange}
                      />
                      <button type="button" className="btn-primary" onClick={triggerAddPhotos}>
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
