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
import { db } from "../lib/firebaseClient";
import { supabase } from "../lib/supabaseClient";
import {
  upsertSanearPause,
  closeSanearPause,
  hasOpenSanearPause,
  SLA_HORAS_PADRAO,
  MS_POR_HORA,
} from "../lib/sla";
import "./TerceirizadaVisao.css";

// bucket do Supabase onde as OS estão sendo gravadas
const STORAGE_BUCKET = "os-arquivos";

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

  // SLA (72h) e pausa SANEAR
  slaHoras?: number | null;
  slaPausas?: any[] | null;
  statusAntesAguardandoSanear?: string | null;

  // PDF da papeleta (URL pública Supabase / Storage) – mantido por compatibilidade
  ordemServicoPdfBase64?: string | null;
  ordemServicoPdfNomeArquivo?: string | null;
  ordemServicoPdfDataAnexo?: string | null;

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
  BURACO_RUA: "Buraco na rua",
  ASFALTO: "Asfalto",
};

const tipoBadgeClassMap: Record<string, string> = {
  BURACO_RUA: "os-badge os-badge-buraco",
  ASFALTO: "os-badge os-badge-asfalto",
};

function normalizeStatusValue(status?: string | null): string {
  return String(status ?? "").trim().toUpperCase();
}

function isDoneStatus(status?: string | null): boolean {
  const s = normalizeStatusValue(status);
  return s === "CONCLUIDA" || s === "CONCLUIDO";
}

function isCanceledStatus(status?: string | null): boolean {
  const s = normalizeStatusValue(status);
  return s === "CANCELADA" || s === "CANCELADO";
}

function isWaitingSanearStatus(status?: string | null): boolean {
  return normalizeStatusValue(status) === "AGUARDANDO_SANEAR";
}

function isOpenStatus(status?: string | null): boolean {
  return !isDoneStatus(status) && !isCanceledStatus(status);
}

function statusClass(status?: string | null): string {
  const s = normalizeStatusValue(status);
  if (s === "CONCLUIDA" || s === "CONCLUIDO") {
    return "os-status-badge os-status-concluida";
  }
  if (s === "ANDAMENTO" || s === "EM_ANDAMENTO") {
    return "os-status-badge os-status-andamento";
  }
  if (s === "AGUARDANDO_SANEAR") {
    return "os-status-badge os-status-aguardando-sanear";
  }
  if (s === "CANCELADA" || s === "CANCELADO") {
    return "os-status-badge os-status-cancelada";
  }
  return "os-status-badge os-status-aberta";
}

function formatStatusLabel(status?: string | null): string {
  const s = normalizeStatusValue(status);

  const labels: Record<string, string> = {
    ABERTA: "ABERTA",
    ANDAMENTO: "EM ANDAMENTO",
    EM_ANDAMENTO: "EM ANDAMENTO",
    AGUARDANDO_SANEAR: "AGUARDANDO SANEAR",
    CONCLUIDA: "CONCLUÍDA",
    CONCLUIDO: "CONCLUÍDA",
    CANCELADA: "CANCELADA",
    CANCELADO: "CANCELADA",
  };

  return labels[s] || s.replaceAll("_", " ") || "ABERTA";
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
    (os.origem === "asfalto" ? "Asfalto" : "Buraco na rua");

  const rows: { label: string; value: string }[] = [
    { label: "Tipo", value: tipoLabel },
    {
      label: "Origem",
      value: os.origem === "asfalto" ? "Asfalto" : "Buraco na rua",
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
            slaPausas: Array.isArray(raw.slaPausas) ? raw.slaPausas : [],
            statusAntesAguardandoSanear:
              raw.statusAntesAguardandoSanear ?? null,
            ordemServicoPdfBase64:
              raw.ordemServicoPdfBase64 ?? pdfNested?.base64 ?? null,
            ordemServicoPdfNomeArquivo:
              raw.ordemServicoPdfNomeArquivo ?? pdfNested?.nomeArquivo ?? null,
            ordemServicoPdfDataAnexo:
              raw.ordemServicoPdfDataAnexo ?? pdfNested?.dataAnexoTexto ?? null,
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
            slaPausas: Array.isArray(raw.slaPausas) ? raw.slaPausas : [],
            statusAntesAguardandoSanear:
              raw.statusAntesAguardandoSanear ?? null,
            ordemServicoPdfBase64:
              raw.ordemServicoPdfBase64 ?? pdfNested?.base64 ?? null,
            ordemServicoPdfNomeArquivo:
              raw.ordemServicoPdfNomeArquivo ?? pdfNested?.nomeArquivo ?? null,
            ordemServicoPdfDataAnexo:
              raw.ordemServicoPdfDataAnexo ?? pdfNested?.dataAnexoTexto ?? null,
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
      const slaHoras =
        typeof os.slaHoras === "number" && os.slaHoras > 0
          ? os.slaHoras
          : SLA_HORAS_PADRAO;
      const slaMs = slaHoras * MS_POR_HORA;
      const isPaused =
        isWaitingSanearStatus(os.status) || hasOpenSanearPause(os.slaPausas);
      const progressPercent =
        slaMs > 0 ? Math.min(100, Math.round((ageMs / slaMs) * 100)) : 0;

      return {
        os,
        ageMs,
        slaHoras,
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

  // Agrupa as filtradas por tipo
  const gruposPorTipo = useMemo(() => {
    const grupos: Record<string, FirestoreOS[]> = {};
    filtradas.forEach((os) => {
      const tipo = os.tipo || "OUTRO";
      if (!grupos[tipo]) grupos[tipo] = [];
      grupos[tipo].push(os);
    });
    return grupos;
  }, [filtradas]);

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

  const totalAbertas = ordens.filter((os) => isOpenStatus(os.status)).length;
  const totalConcluidas = ordens.filter((os) =>
    isDoneStatus(os.status)
  ).length;
  const totalCanceladas = ordens.filter((os) =>
    isCanceledStatus(os.status)
  ).length;

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

  function handleModalFilesChange(e: ChangeEvent<HTMLInputElement>) {
    if (!modalOs) return;

    const files = e.target.files;
    if (!files || files.length === 0) return;

    const allowed = ["image/jpeg", "image/jpg", "image/png", "image/webp"];

    Array.from(files).forEach((file) => {
      if (!allowed.includes(file.type)) {
        setInfoModal({
          title: "Arquivo não suportado",
          message: `O arquivo "${file.name}" não é uma imagem válida. Use formatos JPG, PNG ou WEBP.`,
        });
        return;
      }

      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const nowText = new Date().toLocaleString("pt-BR", {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });

        const photo: LocalPhoto = {
          id: generateLocalId(),
          name: file.name,
          dataUrl,
          createdAt: nowText,
        };

        setPhotosByOsId((prev) => {
          const prevForOs = prev[modalOs.id] || [];
          return {
            ...prev,
            [modalOs.id]: [...prevForOs, photo],
          };
        });
      };
      reader.readAsDataURL(file);
    });

    e.target.value = "";
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
      modalOs.origem === "asfalto" ? "ordensServico" : "ordens_servico";

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
      modalOs.origem === "asfalto" ? "ordensServico" : "ordens_servico";

    const pausasFechadas = closeSanearPause(modalOs.slaPausas, Timestamp.now());
    const novoStatus = modalOs.statusAntesAguardandoSanear || "ABERTA";

    await updateDoc(doc(db, collectionName, modalOs.id), {
      status: novoStatus,
      statusAntesAguardandoSanear: null,
      slaPausas: pausasFechadas,
      updatedAt: serverTimestamp(),
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

    // exige pelo menos uma foto
    if (currentPhotos.length === 0) {
      setShowPhotoUploader(true);
      setInfoModal({
        title: "Foto obrigatória",
        message:
          "Para marcar esta OS como concluída, anexe pelo menos uma foto do serviço executado.",
      });
      return;
    }

    try {
      setIsUpdatingStatus(true);

      const collectionName =
        modalOs.origem === "asfalto" ? "ordensServico" : "ordens_servico";

      const basePath =
        modalOs.origem === "asfalto" ? "asfalto" : "buraco-rua";
      const subfolder = "fotos-execucao";

      const agora = new Date();

      const novosItens: any[] = [];

      for (const photo of currentPhotos) {
        const originalName = photo.name || "foto.jpg";
        const safeName = sanitizeForStoragePath(originalName);

        const id = photo.id || generateLocalId();

        const path = `${basePath}/${modalOs.id}/${subfolder}/${id}-${safeName}`;

        const blob = dataUrlToBlob(photo.dataUrl);

        const { error: uploadError } = await supabase.storage
          .from(STORAGE_BUCKET)
          .upload(path, blob, { upsert: true });

        if (uploadError) {
          console.error(uploadError);
          throw new Error(
            `Erro ao enviar foto "${originalName}" para o armazenamento.`
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
        });
      }

      const originalArray: any[] = modalOs.fotosExecucao || [];
      const updatedArray = [...originalArray, ...novosItens];

      await updateDoc(doc(db, collectionName, modalOs.id), {
        status: "CONCLUIDA",
        dataExecucao: serverTimestamp(),
        fotosExecucao: updatedArray,
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
          ? { ...prev, status: "CONCLUIDA", fotosExecucao: updatedArray }
          : prev
      );

      setInfoModal({
        title: "Status atualizado",
        message: "A OS foi marcada como serviço executado (concluída).",
      });
    } catch (error) {
      console.error(error);
      setInfoModal({
        title: "Erro ao atualizar",
        message:
          "Não foi possível atualizar o status da OS. Verifique sua conexão e tente novamente.",
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
    <section className="page-card terceirizada-page">
      <header className="page-header">
        <div>
          <h2>Área terceirizada</h2>
          <p>
            Aqui a empresa terceirizada acompanha e registra a execução das
            ordens de serviço abertas pelo setor operacional.
          </p>
        </div>
      </header>

      {/* Hero / descrição */}
      <div className="terceirizada-banner">
        <div>
          <span className="terceirizada-pill">VISÃO DA TERCEIRIZADA</span>
          <h2>Fila de atendimento unificada</h2>
          <p className="page-section-description">
            Todas as OS de buraco e asfalto em um só lugar. Ao concluir o
            serviço, será solicitada pelo menos uma foto do local atendido.
          </p>
        </div>

        <div className="terceirizada-highlight">
          <div className="terceirizada-icon">🚧</div>
          <p>
            É de suma importância que as Ordens de Serviço sejam marcadas como
            “Executada” na mesma data em que a execução for realizada. Pedimos
            especial atenção para que todos os registros permaneçam corretos e
            alinhados com a data real da execução.
          </p>
        </div>
      </div>

      <div className="sla-explainer" role="note">
        <div className="sla-explainer-icon" aria-hidden="true">
          ⏱
        </div>

        <div className="sla-explainer-content">
          <div className="sla-explainer-title">
            O que é SLA?
          </div>
          <p className="sla-explainer-text">
            SLA significa <strong>Acordo de Nível de Serviço</strong>. É o prazo
            máximo definido para atendimento de uma OS. Neste sistema, o prazo
            padrão é de <strong>{SLA_HORAS_PADRAO} horas úteis</strong>: a
            contagem ocorre de segunda a sexta, em horas corridas; sábado e
            domingo não contam. Quando a OS fica em “Aguardando SANEAR”, o
            relógio do SLA é pausado até a liberação.
          </p>
        </div>

        <button
          type="button"
          className="sla-explainer-button"
          onClick={handleOpenSlaDrawer}
        >
          Ver situação do SLA
        </button>
      </div>

      {/* KPI cards rápidos */}
      <div className="os-kpi-row">
        <div className="os-kpi-card">
          <div>
            <div className="os-kpi-label">OS em aberto</div>
            <div className="os-kpi-value">{totalAbertas}</div>
          </div>
          <span className="os-kpi-pill">Na fila de execução</span>
        </div>

        <div className="os-kpi-card">
          <div>
            <div className="os-kpi-label">OS concluídas</div>
            <div className="os-kpi-value">{totalConcluidas}</div>
          </div>
          <span className="os-kpi-pill os-kpi-pill-success">
            Serviço finalizado
          </span>
        </div>

        <div className="os-kpi-card">
          <div>
            <div className="os-kpi-label">Total de OS</div>
            <div className="os-kpi-value">{ordens.length}</div>
          </div>
          <span className="os-kpi-pill os-kpi-pill-neutral">
            {totalCanceladas > 0
              ? `${totalCanceladas} cancelada(s)`
              : "Atualizado em tempo real"}
          </span>
        </div>


        <div
          className={`os-kpi-card os-kpi-card-sla ${
            slaSnapshot.overdue.length > 0 ? "is-danger" : "is-ok"
          }`}
          role="button"
          tabIndex={0}
          onClick={handleOpenSlaDrawer}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              handleOpenSlaDrawer();
            }
          }}
          title="Abrir o acompanhamento do prazo de atendimento"
        >
          <div>
            <div className="os-kpi-label">
              Prazo de atendimento (SLA)
            </div>
            <div className="os-kpi-value">{slaSnapshot.overdue.length}</div>
            <div className="sla-kpi-breakdown">
              <span>{slaSnapshot.nearDue.length} em atenção</span>
              <span>{slaSnapshot.paused.length} pausada(s)</span>
            </div>
          </div>

          <span
            className={`os-kpi-pill ${
              slaSnapshot.overdue.length > 0
                ? "os-kpi-pill-danger"
                : "os-kpi-pill-success"
            }`}
          >
            {slaSnapshot.overdue.length > 0
              ? `${slaSnapshot.overdue.length} atrasada(s)`
              : "Dentro do prazo"}
          </span>
        </div>

      </div>

      {/* FILTROS + BUSCA */}
      <div className="os-toolbar">
        {/* Linha 1 – abas de status */}
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

        {/* Linha 2 – submenu (tipos) + barra de busca */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "0.75rem",
            flexWrap: "wrap",
          }}
        >
          {tiposCategoriaOrdenados.length > 0 && (
            <div className="os-category-tabs">
              <button
                type="button"
                className={`os-category-tab ${categoryFilter === "ALL" ? "is-active" : ""}`}
                onClick={() => setCategoryFilter("ALL")}
              >
                Todas ({porStatus.length})
              </button>

              {tiposCategoriaOrdenados.map((tipo) => {
                let label: string;
                if (tipo === "ASFALTO") {
                  label = "asfalto";
                } else if (tipo === "BURACO_RUA") {
                  label = "Buraco na rua";
                } else {
                  label = tipoLabelMap[tipo] || tipo || "Outro";
                }

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
              placeholder="Buscar por protocolo, OS, bairro, rua ou data (dd/mm/aaaa)..."
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
            />
          </div>
        </div>
      </div>

      {/* LISTAGEM PRINCIPAL */}
      <div className="os-main">
        {!loading && filtradas.length === 0 && (
          <div className="os-empty">
            Nenhuma ordem encontrada para os filtros atuais.
          </div>
        )}

        {tiposOrdenados.map((tipo) => {
          const lista = gruposPorTipo[tipo];
          const label = tipoLabelMap[tipo] || tipo || "Outro";
          const badgeClass =
            tipoBadgeClassMap[tipo] || "os-badge os-badge-outro";

          return (
            <section key={tipo} className="os-group-section">
              <div className="os-group-header">
                <div>
                  <span className={badgeClass}>{label}</span>
                </div>
                <span className="os-group-count">
                  {lista.length} OS{" "}
                  {statusTab === "OPEN"
                    ? "em aberto"
                    : statusTab === "DONE"
                    ? "concluída(s)"
                    : "encontrada(s)"}
                </span>
              </div>

              <div className="os-list">
                {lista.map((os) => (
                  <article
                    key={os.id}
                    className="os-card"
                    onClick={() => handleOpenOsModal(os)}
                    role="button"
                  >
                    <div className="os-card-header">
                      <div>
                        <h3>
                          {os.protocolo ||
                            os.ordemServico ||
                            "Sem identificação"}
                        </h3>
                        <p className="os-card-address">
                          {[
                            os.rua,
                            os.numero ? "nº " + os.numero : "",
                            os.bairro ? " – " + os.bairro : "",
                          ]
                            .filter(Boolean)
                            .join(" ") || "Endereço não informado"}
                        </p>
                      </div>
                      <div>
                        <span className={statusClass(os.status)}>
                          {formatStatusLabel(os.status)}
                        </span>
                      </div>
                    </div>

                    <div className="os-card-meta">
                      <span>Criado em {formatCreatedAt(os.createdAt)}</span>
                      {os.createdByEmail && (
                        <span>Por {os.createdByEmail}</span>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            </section>
          );
        })}
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
                    O prazo padrão é de {SLA_HORAS_PADRAO} horas úteis. A
                    contagem ocorre de segunda a sexta, em horas corridas;
                    sábado e domingo não contam. Quando a OS está em
                    “Aguardando SANEAR”, o relógio fica pausado.
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
                                  {slaHoras}h
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
                                  {slaHoras}h
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

              <div className="page-section">
                <h3>Fotos do serviço executado</h3>
                <p className="page-section-description">
                  Ao marcar como concluída, será solicitado anexar pelo menos
                  uma foto. As imagens abaixo ficam apenas nesta sessão.
                </p>

                {currentPhotos.length > 0 ? (
                  <div className="page-photos-block">
                    <div className="photo-preview-grid">
                      {currentPhotos.map((p) => (
                        <div key={p.id} className="photo-preview-item">
                          <img src={p.dataUrl} alt={p.name} />
                          <span className="photo-timestamp">
                            {p.createdAt}
                          </span>
                          <button
                            type="button"
                            className="btn-secondary"
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
                  <p className="photo-hint">
                    Nenhuma foto anexada ainda para esta OS.
                  </p>
                )}

                <div
                  className="page-photos-block"
                  style={{ marginTop: "0.6rem" }}
                >
                  <div className="photo-upload">
                    <label
                      htmlFor="upload-fotos-modal"
                      className="btn-secondary"
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "0.4rem",
                        cursor: "pointer",
                      }}
                    >
                      📷 Adicionar fotos do serviço
                    </label>
                    <input
                      id="upload-fotos-modal"
                      type="file"
                      accept="image/jpeg,image/png,image/webp,image/jpg"
                      multiple
                      onChange={handleModalFilesChange}
                      style={{ display: "none" }}
                    />
                    {showPhotoUploader && (
                      <p className="photo-hint">
                        Anexe pelo menos uma foto do serviço executado para
                        concluir esta OS.
                      </p>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div className="modal-footer">
              <button
                type="button"
                className="btn-secondary"
                onClick={handlePrintModal}
              >
                Imprimir
              </button>
              {normalizeStatus(modalOs.status) === "AGUARDANDO_SANEAR" ? (
                <button
                  type="button"
                  className="btn-primary"
                  onClick={handleRetomarSanear}
                  disabled={isUpdatingStatus}
                >
                  {isUpdatingStatus ? "Atualizando..." : "SANEAR liberou (retomar)"}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setAguardandoSanearOpen(true)}
                  disabled={isUpdatingStatus}
                >
                  Aguardando SANEAR
                </button>
              )}

              <button
                type="button"
                className="btn-secondary"
                onClick={handleServicoExecutado}
                disabled={isUpdatingStatus}
              >
                {isUpdatingStatus ? "Atualizando..." : "Serviço executado"}
              </button>
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
