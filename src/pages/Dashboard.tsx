import React, { useCallback, useEffect, useMemo, useState } from "react";
import { collection, onSnapshot, orderBy, query } from "firebase/firestore";
import type { Timestamp } from "firebase/firestore";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { db } from "../lib/firebaseClient";
import { MS_POR_HORA, SLA_HORAS_PADRAO } from "../lib/sla";
import type { SlaPausa } from "../lib/sla";
import "./Dashboard.css";

type ModuleKey =
  | "geral"
  | "calcamento"
  | "asfalto"
  | "hidrojato"
  | "esgotoRetornando"
  | "esgotoEntupido";

type RealModuleKey = Exclude<ModuleKey, "geral" | "esgotoRetornando" | "esgotoEntupido">;
type FutureModuleKey = "esgotoRetornando" | "esgotoEntupido";
type DashboardTab = ModuleKey;
type FilterPreset = "hoje" | "7dias" | "30dias" | "mes" | "tudo" | "personalizado";
type ExpandedCardId = "status" | "sla" | "modulos" | "produtividade" | "caminhao";
type ServiceArea = "TERCEIRIZADA" | "SERVICO_SANEAR" | "IMPLANTACAO";

type DashboardOrder = {
  id: string;
  moduleKey: RealModuleKey;
  status: string | null;
  createdAt: Timestamp | Date | null;
  dataExecucao: Timestamp | Date | null;
  slaHoras: number | null;
  slaPausas: SlaPausa[];
  protocolo: string | null;
  ordemServico: string | null;
  bairro: string | null;
  rua: string | null;
  numero: string | null;
  tipoCaminhaoExecucao: string | null;
  tipoCaminhaoExecucaoLabel: string | null;
};

type ChartValue = {
  name: string;
  value: number;
  color: string;
};

type ProductivityValue = {
  dia: string;
  dataCompleta: string;
  concluidas: number;
};

type ModuleSummary = {
  key: ModuleKey;
  label: string;
  shortLabel: string;
  icon: string;
  area: ServiceArea;
  areaLabel: string;
  stateLabel: string;
  stateClass: string;
  collectionName: string | null;
  total: number;
  abertas: number;
  atrasadas: number;
  concluidas: number;
  aguardandoSanear: number;
  future: boolean;
};

type AttentionItem = {
  id: string;
  moduleKey: RealModuleKey;
  moduleLabel: string;
  title: string;
  location: string;
  statusLabel: string;
  hours: number;
  severity: "danger" | "warning" | "info";
};

type Metrics = {
  totalPeriodo: number;
  abertasCount: number;
  aguardandoSanearCount: number;
  atencaoCount: number;
  atrasadasCount: number;
  concluidasStatusPeriodo: number;
  concluidasNoPeriodo: number;
  concluidas7dias: number;
  taxaConclusao: number;
  mediaHorasConclusao: number | null;
  resumoStatus: ChartValue[];
  slaData: ChartValue[];
  modulosData: ChartValue[];
  servicoData: ChartValue[];
  caminhaoData: ChartValue[];
  produtividade7dias: ProductivityValue[];
  attentionItems: AttentionItem[];
};

type ExpandedCardConfig = {
  id: ExpandedCardId;
  title: string;
  subtitle: string;
};

type ResumoNumericoProps = {
  titulo?: string;
  linhas: string[];
};

const CHART_HEIGHT_CARD = 285;
const CHART_HEIGHT_MODAL = 510;

const TOOLTIP_STYLE: React.CSSProperties = {
  backgroundColor: "#ffffff",
  border: "1px solid #cbd5e1",
  borderRadius: 12,
  color: "#0f172a",
  fontSize: 12,
  boxShadow: "0 18px 40px rgba(15, 23, 42, 0.16)",
};

const MODULE_CONFIG: Record<ModuleKey, {
  label: string;
  shortLabel: string;
  icon: string;
  collectionName: string | null;
  area: ServiceArea;
  areaLabel: string;
  color: string;
  future?: boolean;
  description: string;
}> = {
  geral: {
    label: "Visão geral",
    shortLabel: "Geral",
    icon: "📊",
    collectionName: null,
    area: "SERVICO_SANEAR",
    areaLabel: "Operação completa",
    color: "#2563eb",
    description: "Consolida todos os módulos operacionais já ligados ao sistema.",
  },
  calcamento: {
    label: "Calçamento",
    shortLabel: "Calçamento",
    icon: "🧱",
    collectionName: "ordens_servico",
    area: "TERCEIRIZADA",
    areaLabel: "Terceirizada",
    color: "#2563eb",
    description: "Ordens de recuperação de calçamento e buraco na rua.",
  },
  asfalto: {
    label: "Asfalto",
    shortLabel: "Asfalto",
    icon: "🛣️",
    collectionName: "ordensServico",
    area: "TERCEIRIZADA",
    areaLabel: "Terceirizada",
    color: "#16a34a",
    description: "Ordens de recomposição ou manutenção de asfalto.",
  },
  hidrojato: {
    label: "Caminhão Hidrojato",
    shortLabel: "Hidrojato",
    icon: "🚛",
    collectionName: "ordensHidrojato",
    area: "SERVICO_SANEAR",
    areaLabel: "Serviço SANEAR",
    color: "#9333ea",
    description: "Serviço interno do SANEAR, finalizado por caminhão próprio ou terceirizado.",
  },
  esgotoRetornando: {
    label: "Esgoto Retornando",
    shortLabel: "Esgoto retornando",
    icon: "↩️",
    collectionName: null,
    area: "IMPLANTACAO",
    areaLabel: "Em implantação",
    color: "#0ea5e9",
    future: true,
    description: "Módulo reservado para ocorrências de esgoto retornando.",
  },
  esgotoEntupido: {
    label: "Esgoto Entupido",
    shortLabel: "Esgoto entupido",
    icon: "🚧",
    collectionName: null,
    area: "IMPLANTACAO",
    areaLabel: "Em implantação",
    color: "#f59e0b",
    future: true,
    description: "Módulo reservado para ocorrências de esgoto entupido.",
  },
};

const TAB_KEYS: DashboardTab[] = [
  "geral",
  "calcamento",
  "asfalto",
  "hidrojato",
  "esgotoRetornando",
  "esgotoEntupido",
];

const REAL_MODULE_KEYS: RealModuleKey[] = ["calcamento", "asfalto", "hidrojato"];
const FUTURE_MODULE_KEYS: FutureModuleKey[] = ["esgotoRetornando", "esgotoEntupido"];

function normalizeText(value: unknown): string {
  return String(value ?? "")
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
}

function normalizeStatus(value: unknown): string {
  return normalizeText(value).replace(/[\s-]+/g, "_");
}

function isConcluida(status: unknown): boolean {
  const normalized = normalizeStatus(status);
  return normalized === "CONCLUIDA" || normalized === "CONCLUIDO";
}

function isCancelada(status: unknown): boolean {
  const normalized = normalizeStatus(status);
  return normalized === "CANCELADA" || normalized === "CANCELADO";
}

function isAguardandoSanear(status: unknown): boolean {
  return normalizeStatus(status) === "AGUARDANDO_SANEAR";
}

function formatStatusLabel(status: unknown): string {
  const normalized = normalizeStatus(status);
  const labels: Record<string, string> = {
    ABERTA: "Aberta",
    ANDAMENTO: "Em andamento",
    EM_ANDAMENTO: "Em andamento",
    AGUARDANDO_SANEAR: "Aguardando SANEAR",
    CONCLUIDA: "Concluída",
    CONCLUIDO: "Concluída",
    CANCELADA: "Cancelada",
    CANCELADO: "Cancelada",
  };
  return (labels[normalized] ?? normalized.replaceAll("_", " ").toLowerCase()) || "Aberta";
}

function toDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

  if (typeof value === "object" && value !== null && "toDate" in value) {
    const maybeTimestamp = value as { toDate?: () => Date };
    if (typeof maybeTimestamp.toDate === "function") {
      const parsed = maybeTimestamp.toDate();
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
  }

  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  return null;
}

function stringOrNull(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text || null;
}

function formatDateInput(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDateInput(value: string | null, endOfDay = false): Date | null {
  if (!value) return null;
  const parts = value.split("-").map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return null;

  const [year, month, day] = parts;
  const date = endOfDay
    ? new Date(year, month - 1, day, 23, 59, 59, 999)
    : new Date(year, month - 1, day, 0, 0, 0, 0);

  return Number.isNaN(date.getTime()) ? null : date;
}

function isWithinPeriod(date: Date | null, start: Date | null, end: Date | null): boolean {
  if (!date) return false;
  if (start && date.getTime() < start.getTime()) return false;
  if (end && date.getTime() > end.getTime()) return false;
  return true;
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, amount: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return startOfDay(next);
}

function getSlaHours(os: DashboardOrder): number {
  return typeof os.slaHoras === "number" && os.slaHoras > 0
    ? os.slaHoras
    : SLA_HORAS_PADRAO;
}

function getActiveHours(os: DashboardOrder, referenceDate: Date): number {
  const createdAt = toDate(os.createdAt);
  if (!createdAt) return 0;

  let pausedMs = 0;
  for (const pause of os.slaPausas) {
    const startedAt = toDate(pause.inicioEm);
    if (!startedAt) continue;

    const finishedAt = toDate(pause.fimEm) ?? referenceDate;
    const duration = Math.min(finishedAt.getTime(), referenceDate.getTime()) - startedAt.getTime();
    if (duration > 0) pausedMs += duration;
  }

  const activeMs = referenceDate.getTime() - createdAt.getTime() - pausedMs;
  return Math.max(0, activeMs / MS_POR_HORA);
}

function getCompletionHours(os: DashboardOrder): number | null {
  const createdAt = toDate(os.createdAt);
  const executionAt = toDate(os.dataExecucao);
  if (!createdAt || !executionAt) return null;
  const hours = (executionAt.getTime() - createdAt.getTime()) / MS_POR_HORA;
  return hours >= 0 ? hours : null;
}

function formatHours(hours: number | null): string {
  if (hours === null || !Number.isFinite(hours)) return "-";
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  return `${Math.round(hours)}h`;
}

function getOrderTitle(os: DashboardOrder): string {
  return os.ordemServico || os.protocolo || os.id.slice(0, 8).toUpperCase();
}

function getOrderLocation(os: DashboardOrder): string {
  const street = [os.rua, os.numero].filter(Boolean).join(", ");
  return [os.bairro, street].filter(Boolean).join(" • ") || "Local não informado";
}

function mapSnapshotDocument(
  id: string,
  data: Record<string, unknown>,
  moduleKey: RealModuleKey
): DashboardOrder {
  return {
    id,
    moduleKey,
    status: typeof data.status === "string" ? data.status : null,
    createdAt: (data.createdAt as Timestamp | Date | null | undefined) ?? null,
    dataExecucao: (data.dataExecucao as Timestamp | Date | null | undefined) ?? null,
    slaHoras: typeof data.slaHoras === "number" ? data.slaHoras : null,
    slaPausas: Array.isArray(data.slaPausas) ? (data.slaPausas as SlaPausa[]) : [],
    protocolo: stringOrNull(data.protocolo),
    ordemServico: stringOrNull(data.ordemServico ?? data.os ?? data.numeroOs),
    bairro: stringOrNull(data.bairro),
    rua: stringOrNull(data.rua ?? data.logradouro),
    numero: stringOrNull(data.numero),
    tipoCaminhaoExecucao: stringOrNull(data.tipoCaminhaoExecucao),
    tipoCaminhaoExecucaoLabel: stringOrNull(data.tipoCaminhaoExecucaoLabel),
  };
}

function buildProductivityDays(referenceDate: Date): ProductivityValue[] {
  const lastSevenDaysStart = addDays(referenceDate, -6);
  const days: ProductivityValue[] = [];

  for (let index = 0; index < 7; index += 1) {
    const day = addDays(lastSevenDaysStart, index);
    days.push({
      dia: day.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }),
      dataCompleta: day.toLocaleDateString("pt-BR", {
        weekday: "short",
        day: "2-digit",
        month: "2-digit",
      }),
      concluidas: 0,
    });
  }

  return days;
}

function buildMetrics(
  ordens: DashboardOrder[],
  referenceDate: Date,
  startDate: Date | null,
  endDate: Date | null
): Metrics {
  const ordensValidas = ordens.filter((os) => !isCancelada(os.status));
  const ordensCriadasNoPeriodo = ordensValidas.filter((os) =>
    isWithinPeriod(toDate(os.createdAt), startDate, endDate)
  );

  let abertasCount = 0;
  let aguardandoSanearCount = 0;
  let atencaoCount = 0;
  let atrasadasCount = 0;
  let concluidasStatusPeriodo = 0;

  const statusMap = {
    abertas: 0,
    andamento: 0,
    aguardando: 0,
    concluidas: 0,
  };

  const slaMap = {
    dentro: 0,
    atencao: 0,
    atrasadas: 0,
    pausadas: 0,
  };

  const moduleMap: Record<RealModuleKey, number> = {
    calcamento: 0,
    asfalto: 0,
    hidrojato: 0,
  };

  const serviceMap: Record<ServiceArea, number> = {
    TERCEIRIZADA: 0,
    SERVICO_SANEAR: 0,
    IMPLANTACAO: 0,
  };

  const attentionItems: AttentionItem[] = [];

  for (const os of ordensCriadasNoPeriodo) {
    const config = MODULE_CONFIG[os.moduleKey];
    moduleMap[os.moduleKey] += 1;
    serviceMap[config.area] += 1;

    if (isConcluida(os.status)) {
      concluidasStatusPeriodo += 1;
      statusMap.concluidas += 1;
      continue;
    }

    abertasCount += 1;
    const normalized = normalizeStatus(os.status);

    if (normalized === "ANDAMENTO" || normalized === "EM_ANDAMENTO") {
      statusMap.andamento += 1;
    } else if (isAguardandoSanear(os.status)) {
      aguardandoSanearCount += 1;
      statusMap.aguardando += 1;
      slaMap.pausadas += 1;
    } else {
      statusMap.abertas += 1;
    }

    const slaHours = getSlaHours(os);
    const activeHours = getActiveHours(os, referenceDate);
    const isAguardando = isAguardandoSanear(os.status);

    if (activeHours > slaHours) {
      atrasadasCount += 1;
      if (!isAguardando) slaMap.atrasadas += 1;
      attentionItems.push({
        id: os.id,
        moduleKey: os.moduleKey,
        moduleLabel: config.shortLabel,
        title: getOrderTitle(os),
        location: getOrderLocation(os),
        statusLabel: formatStatusLabel(os.status),
        hours: activeHours,
        severity: "danger",
      });
    } else if (!isAguardando && activeHours >= slaHours * 0.75) {
      atencaoCount += 1;
      slaMap.atencao += 1;
      attentionItems.push({
        id: os.id,
        moduleKey: os.moduleKey,
        moduleLabel: config.shortLabel,
        title: getOrderTitle(os),
        location: getOrderLocation(os),
        statusLabel: formatStatusLabel(os.status),
        hours: activeHours,
        severity: "warning",
      });
    } else if (!isAguardando) {
      slaMap.dentro += 1;
    }
  }

  const concluidasNoPeriodo = ordensValidas.reduce((total, os) => {
    if (!isConcluida(os.status)) return total;
    const executionDate = toDate(os.dataExecucao) ?? toDate(os.createdAt);
    return isWithinPeriod(executionDate, startDate, endDate) ? total + 1 : total;
  }, 0);

  const completionHours = ordensValidas
    .filter((os) => isConcluida(os.status))
    .filter((os) => isWithinPeriod(toDate(os.dataExecucao) ?? toDate(os.createdAt), startDate, endDate))
    .map(getCompletionHours)
    .filter((value): value is number => value !== null && Number.isFinite(value));

  const mediaHorasConclusao = completionHours.length > 0
    ? Math.round(completionHours.reduce((sum, value) => sum + value, 0) / completionHours.length)
    : null;

  const days = buildProductivityDays(referenceDate);
  const lastSevenDaysStart = addDays(referenceDate, -6);

  for (const os of ordensValidas) {
    if (!isConcluida(os.status)) continue;

    const executionDate = toDate(os.dataExecucao) ?? toDate(os.createdAt);
    if (!executionDate) continue;
    if (!isWithinPeriod(executionDate, startDate, endDate)) continue;

    const normalizedExecutionDate = startOfDay(executionDate);
    const diffDays = Math.round(
      (normalizedExecutionDate.getTime() - lastSevenDaysStart.getTime()) /
        (24 * MS_POR_HORA)
    );

    if (diffDays >= 0 && diffDays < days.length) {
      days[diffDays].concluidas += 1;
    }
  }

  const hidrojatoConcluidas = ordensValidas.filter((os) =>
    os.moduleKey === "hidrojato" &&
    isConcluida(os.status) &&
    isWithinPeriod(toDate(os.dataExecucao) ?? toDate(os.createdAt), startDate, endDate)
  );

  const caminhaoMap = {
    proprio: 0,
    terceirizado: 0,
    naoInformado: 0,
  };

  for (const os of hidrojatoConcluidas) {
    const tipo = normalizeStatus(os.tipoCaminhaoExecucao);
    if (tipo === "PROPRIO") caminhaoMap.proprio += 1;
    else if (tipo === "TERCEIRIZADO") caminhaoMap.terceirizado += 1;
    else caminhaoMap.naoInformado += 1;
  }

  const totalPeriodo = ordensCriadasNoPeriodo.length;
  const concluidas7dias = days.reduce((total, day) => total + day.concluidas, 0);
  const taxaConclusao = totalPeriodo > 0
    ? Math.round((concluidasStatusPeriodo / totalPeriodo) * 100)
    : 0;

  return {
    totalPeriodo,
    abertasCount,
    aguardandoSanearCount,
    atencaoCount,
    atrasadasCount,
    concluidasStatusPeriodo,
    concluidasNoPeriodo,
    concluidas7dias,
    taxaConclusao,
    mediaHorasConclusao,
    resumoStatus: [
      { name: "Abertas", value: statusMap.abertas, color: "#f97316" },
      { name: "Em andamento", value: statusMap.andamento, color: "#0ea5e9" },
      { name: "Aguardando SANEAR", value: statusMap.aguardando, color: "#eab308" },
      { name: "Concluídas", value: statusMap.concluidas, color: "#16a34a" },
    ],
    slaData: [
      { name: "Dentro do prazo", value: slaMap.dentro, color: "#16a34a" },
      { name: "Atenção (75%+)", value: slaMap.atencao, color: "#f59e0b" },
      { name: "Atrasadas", value: slaMap.atrasadas, color: "#dc2626" },
      { name: "Pausadas SANEAR", value: slaMap.pausadas, color: "#6366f1" },
    ],
    modulosData: [
      { name: "Calçamento", value: moduleMap.calcamento, color: MODULE_CONFIG.calcamento.color },
      { name: "Asfalto", value: moduleMap.asfalto, color: MODULE_CONFIG.asfalto.color },
      { name: "Hidrojato", value: moduleMap.hidrojato, color: MODULE_CONFIG.hidrojato.color },
      { name: "Esgoto retornando", value: 0, color: MODULE_CONFIG.esgotoRetornando.color },
      { name: "Esgoto entupido", value: 0, color: MODULE_CONFIG.esgotoEntupido.color },
    ],
    servicoData: [
      { name: "Terceirizada", value: serviceMap.TERCEIRIZADA, color: "#2563eb" },
      { name: "Serviço SANEAR", value: serviceMap.SERVICO_SANEAR, color: "#9333ea" },
      { name: "Em implantação", value: serviceMap.IMPLANTACAO, color: "#64748b" },
    ],
    caminhaoData: [
      { name: "Caminhão próprio", value: caminhaoMap.proprio, color: "#2563eb" },
      { name: "Caminhão terceirizado", value: caminhaoMap.terceirizado, color: "#9333ea" },
      { name: "Não informado", value: caminhaoMap.naoInformado, color: "#94a3b8" },
    ],
    produtividade7dias: days,
    attentionItems: attentionItems
      .sort((a, b) => b.hours - a.hours)
      .slice(0, 6),
  };
}

function buildModuleSummary(
  key: ModuleKey,
  allOrders: DashboardOrder[],
  startDate: Date | null,
  endDate: Date | null,
  referenceDate: Date
): ModuleSummary {
  const config = MODULE_CONFIG[key];

  if (key === "geral") {
    return {
      key,
      label: config.label,
      shortLabel: config.shortLabel,
      icon: config.icon,
      area: config.area,
      areaLabel: config.areaLabel,
      stateLabel: "Operacional",
      stateClass: "is-online",
      collectionName: config.collectionName,
      total: 0,
      abertas: 0,
      atrasadas: 0,
      concluidas: 0,
      aguardandoSanear: 0,
      future: false,
    };
  }

  if (config.future) {
    return {
      key,
      label: config.label,
      shortLabel: config.shortLabel,
      icon: config.icon,
      area: config.area,
      areaLabel: config.areaLabel,
      stateLabel: "Reservado",
      stateClass: "is-planned",
      collectionName: config.collectionName,
      total: 0,
      abertas: 0,
      atrasadas: 0,
      concluidas: 0,
      aguardandoSanear: 0,
      future: true,
    };
  }

  const moduleOrders = allOrders
    .filter((os) => os.moduleKey === key)
    .filter((os) => !isCancelada(os.status))
    .filter((os) => isWithinPeriod(toDate(os.createdAt), startDate, endDate));

  let abertas = 0;
  let atrasadas = 0;
  let concluidas = 0;
  let aguardandoSanear = 0;

  for (const os of moduleOrders) {
    if (isConcluida(os.status)) {
      concluidas += 1;
      continue;
    }

    abertas += 1;
    if (isAguardandoSanear(os.status)) aguardandoSanear += 1;
    if (getActiveHours(os, referenceDate) > getSlaHours(os)) atrasadas += 1;
  }

  return {
    key,
    label: config.label,
    shortLabel: config.shortLabel,
    icon: config.icon,
    area: config.area,
    areaLabel: config.areaLabel,
    stateLabel: "Operacional",
    stateClass: "is-online",
    collectionName: config.collectionName,
    total: moduleOrders.length,
    abertas,
    atrasadas,
    concluidas,
    aguardandoSanear,
    future: false,
  };
}

function chunkLines(items: string[], maxPerLine: number): string[] {
  const lines: string[] = [];
  for (let index = 0; index < items.length; index += maxPerLine) {
    lines.push(items.slice(index, index + maxPerLine).join("  •  "));
  }
  return lines;
}

const ResumoNumerico: React.FC<ResumoNumericoProps> = ({ titulo, linhas }) => {
  if (linhas.length === 0) return null;

  return (
    <div className="dashboard-resumo-numerico">
      {titulo && <div className="dashboard-resumo-title">{titulo}</div>}
      <div className="dashboard-resumo-linhas">
        {linhas.map((line) => (
          <div key={line} className="dashboard-resumo-linha">
            {line}
          </div>
        ))}
      </div>
    </div>
  );
};

const ChartEmptyState: React.FC<{ message: string }> = ({ message }) => (
  <div className="dashboard-chart-empty">{message}</div>
);

const Dashboard: React.FC = () => {
  const [ordensCalcamento, setOrdensCalcamento] = useState<DashboardOrder[]>([]);
  const [ordensAsfalto, setOrdensAsfalto] = useState<DashboardOrder[]>([]);
  const [ordensHidrojato, setOrdensHidrojato] = useState<DashboardOrder[]>([]);
  const [loadingCalcamento, setLoadingCalcamento] = useState(true);
  const [loadingAsfalto, setLoadingAsfalto] = useState(true);
  const [loadingHidrojato, setLoadingHidrojato] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);

  const [activeTab, setActiveTab] = useState<DashboardTab>("geral");
  const [now, setNow] = useState(() => new Date());

  const [filterStartDate, setFilterStartDate] = useState<string | null>(null);
  const [filterEndDate, setFilterEndDate] = useState<string | null>(null);
  const [draftStartDate, setDraftStartDate] = useState<string | null>(null);
  const [draftEndDate, setDraftEndDate] = useState<string | null>(null);
  const [filterError, setFilterError] = useState<string | null>(null);
  const [isFilterOpen, setIsFilterOpen] = useState(false);

  const [expandedCard, setExpandedCard] = useState<ExpandedCardConfig | null>(null);

  const loading = loadingCalcamento || loadingAsfalto || loadingHidrojato;
  const isPeriodFilterActive = Boolean(filterStartDate || filterEndDate);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (expandedCard || isFilterOpen) {
      document.body.classList.add("dashboard-lock-scroll");
    } else {
      document.body.classList.remove("dashboard-lock-scroll");
    }

    return () => document.body.classList.remove("dashboard-lock-scroll");
  }, [expandedCard, isFilterOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (expandedCard) setExpandedCard(null);
      if (isFilterOpen) setIsFilterOpen(false);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [expandedCard, isFilterOpen]);

  useEffect(() => {
    const savedStart = localStorage.getItem("dashboardDateFilterStart");
    const savedEnd = localStorage.getItem("dashboardDateFilterEnd");
    setFilterStartDate(savedStart || null);
    setFilterEndDate(savedEnd || null);
  }, []);

  useEffect(() => {
    if (filterStartDate) {
      localStorage.setItem("dashboardDateFilterStart", filterStartDate);
    } else {
      localStorage.removeItem("dashboardDateFilterStart");
    }

    if (filterEndDate) {
      localStorage.setItem("dashboardDateFilterEnd", filterEndDate);
    } else {
      localStorage.removeItem("dashboardDateFilterEnd");
    }
  }, [filterStartDate, filterEndDate]);

  useEffect(() => {
    const qCalcamento = query(
      collection(db, "ordens_servico"),
      orderBy("createdAt", "desc")
    );

    const unsubscribe = onSnapshot(
      qCalcamento,
      (snapshot) => {
        setOrdensCalcamento(
          snapshot.docs.map((document) =>
            mapSnapshotDocument(document.id, document.data(), "calcamento")
          )
        );
        setLoadingCalcamento(false);
        setLastUpdatedAt(new Date());
      },
      (error) => {
        console.error("Erro ao carregar ordens_servico:", error);
        setLoadError("Não foi possível carregar as ordens de Calçamento.");
        setLoadingCalcamento(false);
      }
    );

    return unsubscribe;
  }, []);

  useEffect(() => {
    const qAsfalto = query(
      collection(db, "ordensServico"),
      orderBy("createdAt", "desc")
    );

    const unsubscribe = onSnapshot(
      qAsfalto,
      (snapshot) => {
        setOrdensAsfalto(
          snapshot.docs.map((document) =>
            mapSnapshotDocument(document.id, document.data(), "asfalto")
          )
        );
        setLoadingAsfalto(false);
        setLastUpdatedAt(new Date());
      },
      (error) => {
        console.error("Erro ao carregar ordensServico:", error);
        setLoadError("Não foi possível carregar as ordens de Asfalto.");
        setLoadingAsfalto(false);
      }
    );

    return unsubscribe;
  }, []);

  useEffect(() => {
    const qHidrojato = query(
      collection(db, "ordensHidrojato"),
      orderBy("createdAt", "desc")
    );

    const unsubscribe = onSnapshot(
      qHidrojato,
      (snapshot) => {
        setOrdensHidrojato(
          snapshot.docs.map((document) =>
            mapSnapshotDocument(document.id, document.data(), "hidrojato")
          )
        );
        setLoadingHidrojato(false);
        setLastUpdatedAt(new Date());
      },
      (error) => {
        console.error("Erro ao carregar ordensHidrojato:", error);
        setLoadError("Não foi possível carregar as ordens de Caminhão Hidrojato.");
        setLoadingHidrojato(false);
      }
    );

    return unsubscribe;
  }, []);

  const startDate = useMemo(() => parseDateInput(filterStartDate), [filterStartDate]);
  const endDate = useMemo(() => parseDateInput(filterEndDate, true), [filterEndDate]);
  const referenceDate = endDate ?? now;

  const allOrders = useMemo(
    () => [...ordensCalcamento, ...ordensAsfalto, ...ordensHidrojato],
    [ordensCalcamento, ordensAsfalto, ordensHidrojato]
  );

  const selectedOrders = useMemo(() => {
    if (activeTab === "geral") return allOrders;
    if (activeTab === "calcamento") return ordensCalcamento;
    if (activeTab === "asfalto") return ordensAsfalto;
    if (activeTab === "hidrojato") return ordensHidrojato;
    return [];
  }, [activeTab, allOrders, ordensAsfalto, ordensCalcamento, ordensHidrojato]);

  const currentMetrics = useMemo(
    () => buildMetrics(selectedOrders, referenceDate, startDate, endDate),
    [selectedOrders, referenceDate, startDate, endDate]
  );

  const generalMetrics = useMemo(
    () => buildMetrics(allOrders, referenceDate, startDate, endDate),
    [allOrders, referenceDate, startDate, endDate]
  );

  const moduleSummaries = useMemo(
    () =>
      [...REAL_MODULE_KEYS, ...FUTURE_MODULE_KEYS].map((key) =>
        buildModuleSummary(key, allOrders, startDate, endDate, referenceDate)
      ),
    [allOrders, startDate, endDate, referenceDate]
  );

  const header = useMemo(() => {
    const config = MODULE_CONFIG[activeTab];
    if (activeTab === "geral") {
      return {
        title: "Central operacional SANEAR",
        eyebrow: "Dashboard executivo",
        description:
          "Visão integrada de Calçamento, Asfalto, Hidrojato e módulos de Esgoto em implantação.",
      };
    }

    return {
      title: config.label,
      eyebrow: config.areaLabel,
      description: config.description,
    };
  }, [activeTab]);

  const filterRangeLabel = useMemo(() => {
    const start = parseDateInput(filterStartDate);
    const end = parseDateInput(filterEndDate);
    const startLabel = start?.toLocaleDateString("pt-BR") ?? null;
    const endLabel = end?.toLocaleDateString("pt-BR") ?? null;

    if (startLabel && endLabel) return `${startLabel} até ${endLabel}`;
    if (startLabel) return `A partir de ${startLabel}`;
    if (endLabel) return `Até ${endLabel}`;
    return "Todo o histórico";
  }, [filterStartDate, filterEndDate]);

  const currentPreset = useMemo<FilterPreset>(() => {
    if (!filterStartDate && !filterEndDate) return "tudo";

    const today = startOfDay(now);
    const todayKey = formatDateInput(today);
    const monthStartKey = formatDateInput(new Date(today.getFullYear(), today.getMonth(), 1));

    if (filterStartDate === todayKey && filterEndDate === todayKey) return "hoje";
    if (filterStartDate === formatDateInput(addDays(today, -6)) && filterEndDate === todayKey) {
      return "7dias";
    }
    if (filterStartDate === formatDateInput(addDays(today, -29)) && filterEndDate === todayKey) {
      return "30dias";
    }
    if (filterStartDate === monthStartKey && filterEndDate === todayKey) return "mes";
    return "personalizado";
  }, [filterStartDate, filterEndDate, now]);

  const applyPreset = useCallback((preset: Exclude<FilterPreset, "personalizado">) => {
    const today = startOfDay(new Date());
    const todayKey = formatDateInput(today);

    if (preset === "tudo") {
      setFilterStartDate(null);
      setFilterEndDate(null);
      return;
    }

    if (preset === "hoje") {
      setFilterStartDate(todayKey);
      setFilterEndDate(todayKey);
      return;
    }

    if (preset === "7dias") {
      setFilterStartDate(formatDateInput(addDays(today, -6)));
      setFilterEndDate(todayKey);
      return;
    }

    if (preset === "30dias") {
      setFilterStartDate(formatDateInput(addDays(today, -29)));
      setFilterEndDate(todayKey);
      return;
    }

    setFilterStartDate(formatDateInput(new Date(today.getFullYear(), today.getMonth(), 1)));
    setFilterEndDate(todayKey);
  }, []);

  const openFilter = useCallback(() => {
    setDraftStartDate(filterStartDate);
    setDraftEndDate(filterEndDate);
    setFilterError(null);
    setIsFilterOpen(true);
  }, [filterStartDate, filterEndDate]);

  const applyCustomFilter = useCallback(() => {
    const draftStart = parseDateInput(draftStartDate);
    const draftEnd = parseDateInput(draftEndDate, true);

    if (draftStart && draftEnd && draftStart.getTime() > draftEnd.getTime()) {
      setFilterError("A data inicial não pode ser maior que a data final.");
      return;
    }

    setFilterStartDate(draftStartDate);
    setFilterEndDate(draftEndDate);
    setFilterError(null);
    setIsFilterOpen(false);
  }, [draftStartDate, draftEndDate]);

  const clearDraftFilter = useCallback(() => {
    setDraftStartDate(null);
    setDraftEndDate(null);
    setFilterError(null);
  }, []);

  const expandedConfigs = useMemo<Record<ExpandedCardId, ExpandedCardConfig>>(
    () => ({
      status: {
        id: "status",
        title: "OS por status",
        subtitle: "Situação das ordens criadas dentro do período selecionado.",
      },
      sla: {
        id: "sla",
        title: "SLA e prioridades",
        subtitle: "Ordens abertas separadas por prazo, atenção, atraso e pausa SANEAR.",
      },
      modulos: {
        id: "modulos",
        title: "Distribuição por módulo",
        subtitle: "Participação de cada serviço no volume de ordens do período.",
      },
      produtividade: {
        id: "produtividade",
        title: "Produtividade — últimos 7 dias",
        subtitle: "Ordens concluídas por data de execução nos sete dias anteriores à data final.",
      },
      caminhao: {
        id: "caminhao",
        title: "Hidrojato — tipo de caminhão",
        subtitle: "Serviços finalizados com caminhão próprio ou caminhão terceirizado.",
      },
    }),
    []
  );

  const openExpanded = useCallback((config: ExpandedCardConfig) => setExpandedCard(config), []);
  const closeExpanded = useCallback(() => setExpandedCard(null), []);

  const onCardKeyDown = useCallback(
    (event: React.KeyboardEvent, config: ExpandedCardConfig) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openExpanded(config);
      }
    },
    [openExpanded]
  );

  const handlePrintDashboard = useCallback(() => {
    document.body.classList.add("print-dashboard");
    if (isPeriodFilterActive) document.body.classList.add("print-dashboard-period-filter");

    const cleanup = () => {
      document.body.classList.remove("print-dashboard");
      document.body.classList.remove("print-dashboard-period-filter");
      window.removeEventListener("afterprint", cleanup);
    };

    window.addEventListener("afterprint", cleanup);
    window.print();
    window.setTimeout(cleanup, 2000);
  }, [isPeriodFilterActive]);

  const handlePrintExpandedOnly = useCallback(() => {
    if (!expandedCard) return;

    const previousTitle = document.title;
    document.title = `SANEAR - ${expandedCard.title}`;
    document.body.classList.add("print-expanded-only");

    const cleanup = () => {
      document.body.classList.remove("print-expanded-only");
      document.title = previousTitle;
      window.removeEventListener("afterprint", cleanup);
    };

    window.addEventListener("afterprint", cleanup);
    window.requestAnimationFrame(() => {
      window.setTimeout(() => {
        window.print();
        window.setTimeout(cleanup, 1500);
      }, 150);
    });
  }, [expandedCard]);

  const renderLegendPrintOnly = useCallback((items: string[]) => {
    if (items.length === 0) return null;
    return <div className="legend-print-only">{items.join(" • ")}</div>;
  }, []);

  const renderStatusChart = useCallback(
    (height: number) => {
      const data = currentMetrics.resumoStatus.filter((item) => item.value > 0);
      if (data.length === 0) {
        return <ChartEmptyState message="Nenhuma ordem encontrada para este período." />;
      }

      return (
        <>
          <ResponsiveContainer width="100%" height={height}>
            <BarChart data={data} margin={{ top: 12, right: 18, left: 0, bottom: 36 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="name" tick={{ fontSize: 11 }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
              <Tooltip formatter={(value) => [String(value), "Quantidade"]} contentStyle={TOOLTIP_STYLE} />
              <Bar dataKey="value" name="Quantidade" radius={[8, 8, 0, 0]}>
                {data.map((entry) => (
                  <Cell key={entry.name} fill={entry.color} />
                ))}
                <LabelList dataKey="value" position="top" fontSize={11} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          {renderLegendPrintOnly(data.map((item) => `${item.name}: ${item.value}`))}
        </>
      );
    },
    [currentMetrics.resumoStatus, renderLegendPrintOnly]
  );

  const renderSlaChart = useCallback(
    (height: number) => {
      const data = currentMetrics.slaData.filter((item) => item.value > 0);
      if (data.length === 0) {
        return <ChartEmptyState message="Não há ordens abertas para analisar o SLA." />;
      }

      return (
        <>
          <ResponsiveContainer width="100%" height={height}>
            <BarChart data={data} layout="vertical" margin={{ top: 12, right: 34, left: 18, bottom: 26 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} />
              <YAxis type="category" dataKey="name" width={132} tick={{ fontSize: 11 }} />
              <Tooltip formatter={(value) => [String(value), "Quantidade"]} contentStyle={TOOLTIP_STYLE} />
              <Bar dataKey="value" name="Quantidade" radius={[0, 8, 8, 0]}>
                {data.map((entry) => (
                  <Cell key={entry.name} fill={entry.color} />
                ))}
                <LabelList dataKey="value" position="right" fontSize={11} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          {renderLegendPrintOnly(data.map((item) => `${item.name}: ${item.value}`))}
        </>
      );
    },
    [currentMetrics.slaData, renderLegendPrintOnly]
  );

  const renderModulesChart = useCallback(
    (height: number) => {
      const data = currentMetrics.modulosData.filter((item) => item.value > 0);
      if (data.length === 0) {
        return <ChartEmptyState message="Nenhum módulo possui OS registrada no período selecionado." />;
      }

      return (
        <>
          <ResponsiveContainer width="100%" height={height}>
            <PieChart>
              <Pie
                data={data}
                cx="44%"
                cy="50%"
                outerRadius={Math.min(118, Math.floor(height * 0.32))}
                innerRadius={Math.min(66, Math.floor(height * 0.18))}
                paddingAngle={3}
                dataKey="value"
                nameKey="name"
              >
                {data.map((entry) => (
                  <Cell key={entry.name} fill={entry.color} />
                ))}
              </Pie>
              <Tooltip formatter={(value) => [String(value), "Quantidade"]} contentStyle={TOOLTIP_STYLE} />
              <Legend layout="vertical" align="right" verticalAlign="middle" wrapperStyle={{ fontSize: 12 }} />
            </PieChart>
          </ResponsiveContainer>
          {renderLegendPrintOnly(data.map((item) => `${item.name}: ${item.value}`))}
        </>
      );
    },
    [currentMetrics.modulosData, renderLegendPrintOnly]
  );

  const renderProductivityChart = useCallback(
    (height: number) => {
      const total = currentMetrics.produtividade7dias.reduce((sum, item) => sum + item.concluidas, 0);

      return (
        <>
          <ResponsiveContainer width="100%" height={height}>
            <AreaChart data={currentMetrics.produtividade7dias} margin={{ top: 16, right: 18, left: 0, bottom: 36 }}>
              <defs>
                <linearGradient id="dashboardProductivityGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#16a34a" stopOpacity={0.32} />
                  <stop offset="95%" stopColor="#16a34a" stopOpacity={0.04} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="dia" interval={0} tick={{ fontSize: 11 }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
              <Tooltip
                labelFormatter={(_, payload) => payload?.[0]?.payload?.dataCompleta ?? ""}
                formatter={(value) => [String(value), "Concluídas"]}
                contentStyle={TOOLTIP_STYLE}
              />
              <Area
                type="monotone"
                dataKey="concluidas"
                name="Concluídas"
                stroke="#16a34a"
                fill="url(#dashboardProductivityGradient)"
                strokeWidth={3}
                dot={{ r: 4 }}
                activeDot={{ r: 6 }}
              >
                <LabelList dataKey="concluidas" position="top" fontSize={11} />
              </Area>
            </AreaChart>
          </ResponsiveContainer>
          {renderLegendPrintOnly([`Total nos últimos 7 dias: ${total}`])}
        </>
      );
    },
    [currentMetrics.produtividade7dias, renderLegendPrintOnly]
  );

  const renderCaminhaoChart = useCallback(
    (height: number) => {
      const data = currentMetrics.caminhaoData.filter((item) => item.value > 0);
      if (data.length === 0) {
        return <ChartEmptyState message="Ainda não há finalizações de Hidrojato com tipo de caminhão neste período." />;
      }

      return (
        <>
          <ResponsiveContainer width="100%" height={height}>
            <BarChart data={data} margin={{ top: 12, right: 18, left: 0, bottom: 36 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="name" tick={{ fontSize: 11 }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
              <Tooltip formatter={(value) => [String(value), "Serviços"]} contentStyle={TOOLTIP_STYLE} />
              <Bar dataKey="value" name="Serviços" radius={[8, 8, 0, 0]}>
                {data.map((entry) => (
                  <Cell key={entry.name} fill={entry.color} />
                ))}
                <LabelList dataKey="value" position="top" fontSize={11} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          {renderLegendPrintOnly(data.map((item) => `${item.name}: ${item.value}`))}
        </>
      );
    },
    [currentMetrics.caminhaoData, renderLegendPrintOnly]
  );

  const expandedContent = useMemo(() => {
    if (!expandedCard) return null;

    let chart: React.ReactNode;
    let summaryLines: string[];

    if (expandedCard.id === "status") {
      chart = renderStatusChart(CHART_HEIGHT_MODAL);
      summaryLines = chunkLines(currentMetrics.resumoStatus.map((item) => `${item.name}: ${item.value}`), 3);
    } else if (expandedCard.id === "sla") {
      chart = renderSlaChart(CHART_HEIGHT_MODAL);
      summaryLines = chunkLines(currentMetrics.slaData.map((item) => `${item.name}: ${item.value}`), 2);
    } else if (expandedCard.id === "modulos") {
      chart = renderModulesChart(CHART_HEIGHT_MODAL);
      summaryLines = chunkLines(currentMetrics.modulosData.map((item) => `${item.name}: ${item.value}`), 2);
    } else if (expandedCard.id === "caminhao") {
      chart = renderCaminhaoChart(CHART_HEIGHT_MODAL);
      summaryLines = chunkLines(currentMetrics.caminhaoData.map((item) => `${item.name}: ${item.value}`), 2);
    } else {
      chart = renderProductivityChart(CHART_HEIGHT_MODAL);
      summaryLines = chunkLines(currentMetrics.produtividade7dias.map((item) => `${item.dia}: ${item.concluidas}`), 4);
      summaryLines.push(`Total em 7 dias: ${currentMetrics.concluidas7dias}`);
    }

    return (
      <div id="dashboard-expanded-print-root" className="dashboard-chart-card">
        <div className="dashboard-chart-header">
          <div>
            <h3>{expandedCard.title}</h3>
            <p className="dashboard-chart-sub">{expandedCard.subtitle}</p>
          </div>
        </div>
        <div className="dashboard-chart-body">{chart}</div>
        <ResumoNumerico titulo="Resumo numérico" linhas={summaryLines} />
      </div>
    );
  }, [
    currentMetrics,
    expandedCard,
    renderCaminhaoChart,
    renderModulesChart,
    renderProductivityChart,
    renderSlaChart,
    renderStatusChart,
  ]);

  const renderExpandableCard = (
    config: ExpandedCardConfig,
    chart: React.ReactNode,
    extraClass = ""
  ) => (
    <div
      className={`dashboard-chart-card dashboard-chart-card--clickable ${extraClass}`.trim()}
      role="button"
      tabIndex={0}
      onClick={() => openExpanded(config)}
      onKeyDown={(event) => onCardKeyDown(event, config)}
      aria-label={`Expandir ${config.title}`}
    >
      <div className="dashboard-chart-header">
        <div>
          <h3>{config.title}</h3>
          <p className="dashboard-chart-sub">{config.subtitle}</p>
        </div>
        <span className="dashboard-expand-hint" aria-hidden="true">↗</span>
      </div>
      <div className="dashboard-chart-body">{chart}</div>
    </div>
  );

  const activeFutureModule = activeTab === "esgotoRetornando" || activeTab === "esgotoEntupido";

  function navigateMobileWork(menu: string) {
    window.dispatchEvent(new CustomEvent("sanear:navigate", { detail: { menu } }));
  }

  return (
    <section className="page-card dashboard-layout">
      <div className="dashboard-print-header print-only">
        <div className="dashboard-print-title">Relatório Operacional — SANEAR</div>
        <div className="dashboard-print-meta">
          <span><strong>Seção:</strong> {header.title}</span>
          <span><strong>Período:</strong> {filterRangeLabel}</span>
          <span><strong>Gerado em:</strong> {now.toLocaleString("pt-BR")}</span>
        </div>
      </div>

      <header className="dashboard-hero">
        <div className="dashboard-hero-main">
          <span className="dashboard-eyebrow">{header.eyebrow}</span>
          <h2>{header.title}</h2>
          <p>{header.description}</p>
          <div className="dashboard-hero-tags screen-only">
            <span>Terceirizada: Calçamento e Asfalto</span>
            <span>Serviço SANEAR: Hidrojato</span>
            <span>Esgoto: reservado para implantação</span>
          </div>
        </div>
        <div className="dashboard-command-card">
          <span className="dashboard-command-label">OS criadas no período</span>
          <strong>{currentMetrics.totalPeriodo}</strong>
          <span>{filterRangeLabel}</span>
          <div className="dashboard-command-grid">
            <div><b>{currentMetrics.abertasCount}</b><small>Abertas</small></div>
            <div><b>{currentMetrics.atrasadasCount}</b><small>Atrasadas</small></div>
            <div><b>{currentMetrics.taxaConclusao}%</b><small>Conclusão</small></div>
          </div>
        </div>
      </header>

      <div className="dashboard-mobile-command screen-only" aria-label="Resumo mobile do dashboard">
        <div className="dashboard-mobile-period-bar">
          <div>
            <span>Período em análise</span>
            <strong>{filterRangeLabel}</strong>
          </div>
          <button type="button" onClick={openFilter}>Filtrar</button>
        </div>

        <div className="dashboard-mobile-preset-row" aria-label="Filtros rápidos mobile">
          {([
            ["hoje", "Hoje"],
            ["7dias", "7 dias"],
            ["30dias", "30 dias"],
            ["mes", "Mês"],
            ["tudo", "Tudo"],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`dashboard-mobile-preset ${currentPreset === value ? "is-active" : ""}`}
              onClick={() => applyPreset(value)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="dashboard-mobile-kpi-strip">
          <div className="dashboard-mobile-kpi is-total">
            <span>Total</span>
            <strong>{currentMetrics.totalPeriodo}</strong>
            <small>no período</small>
          </div>
          <div className="dashboard-mobile-kpi is-open">
            <span>Abertas</span>
            <strong>{currentMetrics.abertasCount}</strong>
            <small>em campo</small>
          </div>
          <div className="dashboard-mobile-kpi is-danger">
            <span>Atraso</span>
            <strong>{currentMetrics.atrasadasCount}</strong>
            <small>SLA vencido</small>
          </div>
          <div className="dashboard-mobile-kpi is-success">
            <span>Conclusão</span>
            <strong>{currentMetrics.taxaConclusao}%</strong>
            <small>resolvidas</small>
          </div>
        </div>

        <div className="dashboard-mobile-status-card">
          <div>
            <span className="dashboard-mobile-status-label">Situação da operação</span>
            <strong>
              {currentMetrics.atrasadasCount > 0
                ? "Atenção necessária"
                : currentMetrics.atencaoCount > 0
                  ? "Monitorar prazos"
                  : "Operação controlada"}
            </strong>
            <small>
              {currentMetrics.atrasadasCount > 0
                ? `${currentMetrics.atrasadasCount} OS acima do SLA.`
                : currentMetrics.atencaoCount > 0
                  ? `${currentMetrics.atencaoCount} OS próximas do limite.`
                  : "Nenhuma criticidade forte neste filtro."}
            </small>
          </div>
          <div className="dashboard-mobile-status-meter">
            <span style={{ width: `${Math.min(100, Math.max(8, currentMetrics.taxaConclusao))}%` }} />
          </div>
        </div>

        <div className="dashboard-mobile-section-head">
          <div>
            <span>Serviços</span>
            <strong>Escolha uma visão</strong>
          </div>
          <small>{activeTab === "geral" ? "Todos" : MODULE_CONFIG[activeTab].shortLabel}</small>
        </div>

        <div className="dashboard-mobile-module-rail" aria-label="Módulos operacionais">
          <button
            type="button"
            className={`dashboard-mobile-module ${activeTab === "geral" ? "is-selected" : ""}`}
            onClick={() => setActiveTab("geral")}
          >
            <span>📊</span>
            <strong>Geral</strong>
            <small>{generalMetrics.totalPeriodo} OS</small>
          </button>
          {moduleSummaries.map((summary) => (
            <button
              key={summary.key}
              type="button"
              className={`dashboard-mobile-module ${activeTab === summary.key ? "is-selected" : ""} ${summary.future ? "is-future" : ""}`}
              onClick={() => setActiveTab(summary.key)}
            >
              <span>{summary.icon}</span>
              <strong>{summary.shortLabel}</strong>
              <small>{summary.future ? "Reservado" : `${summary.abertas} abertas`}</small>
            </button>
          ))}
        </div>

        <div className="dashboard-mobile-work-center" aria-label="Central de trabalho mobile">
          <div className="dashboard-mobile-section-head dashboard-mobile-section-head--inside">
            <div>
              <span>Central de trabalho</span>
              <strong>Atalhos do plantão</strong>
            </div>
            <small>Campo</small>
          </div>

          <div className="dashboard-mobile-work-grid">
            <button type="button" onClick={() => navigateMobileWork("buraco")}>
              <span>🧱</span>
              <strong>Nova calçamento</strong>
              <small>Buraco na rua</small>
            </button>
            <button type="button" onClick={() => navigateMobileWork("asfalto")}>
              <span>🛣️</span>
              <strong>Nova asfalto</strong>
              <small>Tapa-buraco</small>
            </button>
            <button type="button" onClick={() => navigateMobileWork("hidrojato")}>
              <span>🚛</span>
              <strong>Novo hidrojato</strong>
              <small>Serviço SANEAR</small>
            </button>
            <button type="button" onClick={() => navigateMobileWork("listaOS")}>
              <span>📋</span>
              <strong>Consultar OS</strong>
              <small>PDF, fotos e status</small>
            </button>
          </div>
        </div>

        <div className="dashboard-mobile-priority-panel">
          <div className="dashboard-mobile-section-head dashboard-mobile-section-head--inside">
            <div>
              <span>Campo</span>
              <strong>Prioridades rápidas</strong>
            </div>
            <small>{currentMetrics.attentionItems.length}</small>
          </div>
          {currentMetrics.attentionItems.length === 0 ? (
            <div className="dashboard-mobile-empty-state">Nenhuma OS crítica para este filtro.</div>
          ) : (
            <div className="dashboard-mobile-priority-list">
              {currentMetrics.attentionItems.slice(0, 3).map((item) => (
                <div key={item.id} className={`dashboard-mobile-priority is-${item.severity}`}>
                  <div>
                    <strong>{item.moduleLabel}</strong>
                    <span>{item.title}</span>
                    <small>{item.location}</small>
                  </div>
                  <b>{Math.round(item.hours)}h</b>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="dashboard-toolbar screen-only">
        <div className="dashboard-presets" aria-label="Filtros rápidos de período">
          {([
            ["hoje", "Hoje"],
            ["7dias", "7 dias"],
            ["30dias", "30 dias"],
            ["mes", "Mês atual"],
            ["tudo", "Todo histórico"],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`dashboard-preset ${currentPreset === value ? "is-active" : ""}`}
              onClick={() => applyPreset(value)}
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            className={`dashboard-preset ${currentPreset === "personalizado" ? "is-active" : ""}`}
            onClick={openFilter}
          >
            Personalizado
          </button>
        </div>

        <div className="dashboard-toolbar-meta">
          <span className="dashboard-active-period">{filterRangeLabel}</span>
          <span className="dashboard-live-indicator">
            <span aria-hidden="true" />
            {lastUpdatedAt
              ? `Atualizado às ${lastUpdatedAt.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`
              : "Aguardando dados"}
          </span>
        </div>
      </div>

      {isFilterOpen && (
        <div className="dashboard-modal-backdrop" onClick={() => setIsFilterOpen(false)}>
          <div
            className="dashboard-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="dashboard-filter-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="dashboard-modal-header">
              <div>
                <div id="dashboard-filter-title" className="dashboard-modal-title">Período personalizado</div>
                <div className="dashboard-modal-subtitle">A alteração só será aplicada ao clicar em “Aplicar período”.</div>
              </div>
              <button type="button" className="dashboard-modal-close" onClick={() => setIsFilterOpen(false)} aria-label="Fechar filtro">✕</button>
            </div>

            <div className="dashboard-modal-body">
              <label className="dashboard-filter-field">
                <span>Data inicial</span>
                <input type="date" value={draftStartDate ?? ""} onChange={(event) => setDraftStartDate(event.target.value || null)} />
              </label>
              <label className="dashboard-filter-field">
                <span>Data final</span>
                <input type="date" value={draftEndDate ?? ""} onChange={(event) => setDraftEndDate(event.target.value || null)} />
              </label>
              {filterError && <div className="dashboard-filter-error" role="alert">{filterError}</div>}
            </div>

            <div className="dashboard-modal-footer">
              <button type="button" className="dashboard-filter-clear" onClick={clearDraftFilter}>Limpar</button>
              <button type="button" className="dashboard-filter-button" onClick={applyCustomFilter}>Aplicar período</button>
            </div>
          </div>
        </div>
      )}

      <div className="page-tabs dashboard-tabs screen-only" role="tablist">
        {TAB_KEYS.map((value) => {
          const config = MODULE_CONFIG[value];
          return (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={activeTab === value}
              className={`page-tab dashboard-tab-pill ${activeTab === value ? "is-active" : ""}`}
              onClick={() => setActiveTab(value)}
            >
              <span>{config.icon}</span>
              {config.shortLabel}
            </button>
          );
        })}
      </div>

      {loadError && <div className="status-banner status-error">{loadError}</div>}

      {loading && allOrders.length === 0 ? (
        <div className="dashboard-loading">Carregando indicadores...</div>
      ) : (
        <>
          {activeFutureModule && (
            <div className="dashboard-future-banner">
              <div>
                <span>{MODULE_CONFIG[activeTab].icon}</span>
              </div>
              <div>
                <strong>{MODULE_CONFIG[activeTab].label} ainda está reservado no painel.</strong>
                <p>
                  O card já aparece no Dashboard para manter a visão completa da operação, mas ainda não consulta banco de dados porque o módulo de cadastro ainda não foi ativado.
                </p>
              </div>
            </div>
          )}

          <div className="dashboard-kpi-grid">
            <div className="dashboard-kpi-card kpi-total">
              <div className="dashboard-kpi-header"><span className="dashboard-kpi-icon">📌</span><span className="dashboard-kpi-label">Total no período</span></div>
              <div className="dashboard-kpi-value">{currentMetrics.totalPeriodo}</div>
              <div className="dashboard-kpi-sub">Ordens criadas no filtro atual.</div>
            </div>
            <div className="dashboard-kpi-card kpi-abertas">
              <div className="dashboard-kpi-header"><span className="dashboard-kpi-icon">📂</span><span className="dashboard-kpi-label">OS abertas</span></div>
              <div className="dashboard-kpi-value">{currentMetrics.abertasCount}</div>
              <div className="dashboard-kpi-sub">Pendentes de execução ou finalização.</div>
            </div>
            <div className="dashboard-kpi-card kpi-atencao">
              <div className="dashboard-kpi-header"><span className="dashboard-kpi-icon">⚠️</span><span className="dashboard-kpi-label">Em atenção</span></div>
              <div className="dashboard-kpi-value">{currentMetrics.atencaoCount}</div>
              <div className="dashboard-kpi-sub">Acima de 75% do SLA padrão.</div>
            </div>
            <div className="dashboard-kpi-card kpi-atrasadas">
              <div className="dashboard-kpi-header"><span className="dashboard-kpi-icon">⏱</span><span className="dashboard-kpi-label">Atrasadas</span></div>
              <div className="dashboard-kpi-value">{currentMetrics.atrasadasCount}</div>
              <div className="dashboard-kpi-sub">Acima do SLA configurado de {SLA_HORAS_PADRAO}h.</div>
            </div>
            <div className="dashboard-kpi-card kpi-concluidas">
              <div className="dashboard-kpi-header"><span className="dashboard-kpi-icon">✅</span><span className="dashboard-kpi-label">Concluídas</span></div>
              <div className="dashboard-kpi-value">{currentMetrics.concluidasNoPeriodo}</div>
              <div className="dashboard-kpi-sub">Considera a data de execução.</div>
            </div>
            <div className="dashboard-kpi-card kpi-media">
              <div className="dashboard-kpi-header"><span className="dashboard-kpi-icon">⌛</span><span className="dashboard-kpi-label">Tempo médio</span></div>
              <div className="dashboard-kpi-value dashboard-kpi-value--text">{formatHours(currentMetrics.mediaHorasConclusao)}</div>
              <div className="dashboard-kpi-sub">Média entre criação e conclusão.</div>
            </div>
          </div>

          <div className="dashboard-module-board">
            {moduleSummaries.map((summary) => (
              <button
                key={summary.key}
                type="button"
                className={`dashboard-module-card ${activeTab === summary.key ? "is-selected" : ""} ${summary.future ? "is-future" : ""}`}
                onClick={() => setActiveTab(summary.key)}
              >
                <div className="dashboard-module-topline">
                  <span className="dashboard-module-icon">{summary.icon}</span>
                  <span className={`dashboard-module-state ${summary.stateClass}`}>{summary.stateLabel}</span>
                </div>
                <strong>{summary.label}</strong>
                <small>{summary.areaLabel}</small>
                <div className="dashboard-module-numbers">
                  <span><b>{summary.total}</b>Total</span>
                  <span><b>{summary.abertas}</b>Abertas</span>
                  <span><b>{summary.atrasadas}</b>Atraso</span>
                  <span><b>{summary.concluidas}</b>Concl.</span>
                </div>
              </button>
            ))}
          </div>

          <div className="dashboard-intel-grid">
            <div className="dashboard-intel-card dashboard-attention-card">
              <div className="dashboard-intel-header">
                <div>
                  <h3>Prioridades de campo</h3>
                  <p>OS abertas com maior consumo de SLA no período.</p>
                </div>
                <span>{currentMetrics.attentionItems.length}</span>
              </div>
              {currentMetrics.attentionItems.length === 0 ? (
                <div className="dashboard-intel-empty">Nenhuma OS crítica neste filtro.</div>
              ) : (
                <div className="dashboard-attention-list">
                  {currentMetrics.attentionItems.map((item) => (
                    <div key={item.id} className={`dashboard-attention-item is-${item.severity}`}>
                      <div>
                        <strong>{item.moduleLabel} • {item.title}</strong>
                        <small>{item.location}</small>
                      </div>
                      <div>
                        <b>{Math.round(item.hours)}h</b>
                        <small>{item.statusLabel}</small>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="dashboard-intel-card dashboard-flow-card">
              <div className="dashboard-intel-header">
                <div>
                  <h3>Fluxo da operação</h3>
                  <p>Como o volume está dividido por área responsável.</p>
                </div>
              </div>
              <div className="dashboard-flow-bars">
                {currentMetrics.servicoData.map((item) => {
                  const max = Math.max(...currentMetrics.servicoData.map((entry) => entry.value), 1);
                  const width = Math.max(4, Math.round((item.value / max) * 100));
                  return (
                    <div key={item.name} className="dashboard-flow-row">
                      <div><span>{item.name}</span><b>{item.value}</b></div>
                      <div className="dashboard-flow-track"><span style={{ width: `${width}%`, background: item.color }} /></div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="dashboard-section">
            <div className="dashboard-charts-grid">
              {renderExpandableCard(expandedConfigs.status, renderStatusChart(CHART_HEIGHT_CARD))}
              {renderExpandableCard(expandedConfigs.sla, renderSlaChart(CHART_HEIGHT_CARD))}
            </div>
          </div>

          <div className="dashboard-section">
            <div className="dashboard-charts-grid dashboard-charts-grid--three">
              {activeTab === "geral" && renderExpandableCard(expandedConfigs.modulos, renderModulesChart(CHART_HEIGHT_CARD))}
              {renderExpandableCard(
                expandedConfigs.produtividade,
                renderProductivityChart(CHART_HEIGHT_CARD),
                activeTab === "geral" ? "" : "dashboard-chart-card--wide"
              )}
              {(activeTab === "geral" || activeTab === "hidrojato") &&
                renderExpandableCard(expandedConfigs.caminhao, renderCaminhaoChart(CHART_HEIGHT_CARD))}
            </div>
          </div>

          {activeTab === "geral" && (
            <div className="dashboard-snapshot-grid">
              <div className="dashboard-snapshot-card">
                <span>Operação completa</span>
                <strong>{generalMetrics.totalPeriodo}</strong>
                <small>OS criadas no período em todos os módulos ativos.</small>
              </div>
              <div className="dashboard-snapshot-card">
                <span>Backlog aberto</span>
                <strong>{generalMetrics.abertasCount}</strong>
                <small>Calçamento, Asfalto e Hidrojato ainda pendentes.</small>
              </div>
              <div className="dashboard-snapshot-card">
                <span>Risco operacional</span>
                <strong>{generalMetrics.atencaoCount + generalMetrics.atrasadasCount}</strong>
                <small>Soma de OS em atenção e atrasadas.</small>
              </div>
              <div className="dashboard-snapshot-card">
                <span>Módulos futuros</span>
                <strong>2</strong>
                <small>Esgoto retornando e esgoto entupido já aparecem no painel.</small>
              </div>
            </div>
          )}
        </>
      )}

      <div className="dashboard-print-container screen-only">
        <button type="button" className="dashboard-print-button" onClick={handlePrintDashboard}>🖨 Imprimir dashboard</button>
      </div>

      {expandedCard && (
        <div className="dashboard-modal-backdrop" onClick={closeExpanded}>
          <div
            className="dashboard-expanded-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="dashboard-expanded-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="dashboard-expanded-header">
              <div>
                <div id="dashboard-expanded-title" className="dashboard-expanded-title">{expandedCard.title}</div>
                <div className="dashboard-expanded-subtitle">{expandedCard.subtitle}</div>
              </div>
              <div className="dashboard-expanded-controls">
                <button type="button" className="dashboard-print-button" onClick={handlePrintExpandedOnly}>🖨 Imprimir gráfico</button>
                <button type="button" className="dashboard-modal-close" onClick={closeExpanded} aria-label="Fechar gráfico expandido">✕</button>
              </div>
            </div>
            <div className="dashboard-expanded-body">{expandedContent}</div>
          </div>
        </div>
      )}
    </section>
  );
};

export default Dashboard;
