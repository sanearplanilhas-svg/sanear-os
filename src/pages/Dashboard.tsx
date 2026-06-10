import React, { useCallback, useEffect, useMemo, useState } from "react";
import { collection, onSnapshot, orderBy, query } from "firebase/firestore";
import type { Timestamp } from "firebase/firestore";
import {
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

type Origem = "buraco" | "asfalto";
type DashboardTab = "geral" | Origem;
type FilterPreset = "hoje" | "7dias" | "30dias" | "mes" | "tudo" | "personalizado";
type ExpandedCardId = "status" | "sla" | "origem" | "produtividade";

type OSItem = {
  id: string;
  origem: Origem;
  status: string | null;
  createdAt: Timestamp | Date | null;
  dataExecucao: Timestamp | Date | null;
  slaHoras: number | null;
  slaPausas: SlaPausa[];
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

type Metrics = {
  totalPeriodo: number;
  abertasCount: number;
  aguardandoSanearCount: number;
  atrasadasCount: number;
  concluidasStatusPeriodo: number;
  concluidasNoPeriodo: number;
  concluidas7dias: number;
  taxaConclusao: number;
  resumoStatus: ChartValue[];
  slaData: ChartValue[];
  origemData: ChartValue[];
  produtividade7dias: ProductivityValue[];
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
  borderRadius: 10,
  color: "#0f172a",
  fontSize: 12,
  boxShadow: "0 14px 32px rgba(15, 23, 42, 0.14)",
};

const PIE_COLORS = ["#2563eb", "#16a34a"];

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

function toDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;

  if (typeof value === "object" && value !== null && "toDate" in value) {
    const maybeTimestamp = value as { toDate?: () => Date };
    if (typeof maybeTimestamp.toDate === "function") {
      const parsed = maybeTimestamp.toDate();
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
  }

  return null;
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

function getActiveHours(os: OSItem, referenceDate: Date): number {
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

function getSlaHours(os: OSItem): number {
  return typeof os.slaHoras === "number" && os.slaHoras > 0
    ? os.slaHoras
    : SLA_HORAS_PADRAO;
}

function buildMetrics(
  ordens: OSItem[],
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
  let atrasadasCount = 0;
  let concluidasStatusPeriodo = 0;

  const statusMap = {
    abertas: 0,
    aguardando: 0,
    concluidas: 0,
  };

  const slaMap = {
    dentro: 0,
    atencao: 0,
    atrasadas: 0,
    pausadas: 0,
  };

  const origemMap: Record<Origem, number> = {
    buraco: 0,
    asfalto: 0,
  };

  for (const os of ordensCriadasNoPeriodo) {
    origemMap[os.origem] += 1;

    if (isConcluida(os.status)) {
      concluidasStatusPeriodo += 1;
      statusMap.concluidas += 1;
      continue;
    }

    abertasCount += 1;

    const aguardando = isAguardandoSanear(os.status);
    if (aguardando) {
      aguardandoSanearCount += 1;
      statusMap.aguardando += 1;
      slaMap.pausadas += 1;
    } else {
      statusMap.abertas += 1;
    }

    const slaHours = getSlaHours(os);
    const activeHours = getActiveHours(os, referenceDate);

    if (activeHours > slaHours) {
      atrasadasCount += 1;
      if (!aguardando) slaMap.atrasadas += 1;
    } else if (!aguardando && activeHours >= slaHours * 0.75) {
      slaMap.atencao += 1;
    } else if (!aguardando) {
      slaMap.dentro += 1;
    }
  }

  const concluidasNoPeriodo = ordensValidas.reduce((total, os) => {
    if (!isConcluida(os.status)) return total;
    const executionDate = toDate(os.dataExecucao) ?? toDate(os.createdAt);
    return isWithinPeriod(executionDate, startDate, endDate) ? total + 1 : total;
  }, 0);

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

  const totalPeriodo = ordensCriadasNoPeriodo.length;
  const concluidas7dias = days.reduce((total, day) => total + day.concluidas, 0);
  const taxaConclusao = totalPeriodo > 0
    ? Math.round((concluidasStatusPeriodo / totalPeriodo) * 100)
    : 0;

  return {
    totalPeriodo,
    abertasCount,
    aguardandoSanearCount,
    atrasadasCount,
    concluidasStatusPeriodo,
    concluidasNoPeriodo,
    concluidas7dias,
    taxaConclusao,
    resumoStatus: [
      { name: "Abertas", value: statusMap.abertas, color: "#f97316" },
      { name: "Aguardando SANEAR", value: statusMap.aguardando, color: "#eab308" },
      { name: "Concluídas", value: statusMap.concluidas, color: "#16a34a" },
    ],
    slaData: [
      { name: "Dentro do prazo", value: slaMap.dentro, color: "#16a34a" },
      { name: "Atenção (75%+)", value: slaMap.atencao, color: "#f59e0b" },
      { name: "Atrasadas", value: slaMap.atrasadas, color: "#dc2626" },
      { name: "Pausadas SANEAR", value: slaMap.pausadas, color: "#6366f1" },
    ],
    origemData: [
      { name: "Calçamento", value: origemMap.buraco, color: PIE_COLORS[0] },
      { name: "Asfalto", value: origemMap.asfalto, color: PIE_COLORS[1] },
    ],
    produtividade7dias: days,
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

function mapSnapshotDocument(
  id: string,
  data: Record<string, unknown>,
  origem: Origem
): OSItem {
  return {
    id,
    origem,
    status: typeof data.status === "string" ? data.status : null,
    createdAt: (data.createdAt as Timestamp | Date | null | undefined) ?? null,
    dataExecucao:
      (data.dataExecucao as Timestamp | Date | null | undefined) ?? null,
    slaHoras: typeof data.slaHoras === "number" ? data.slaHoras : null,
    slaPausas: Array.isArray(data.slaPausas)
      ? (data.slaPausas as SlaPausa[])
      : [],
  };
}

const Dashboard: React.FC = () => {
  const [ordensBuraco, setOrdensBuraco] = useState<OSItem[]>([]);
  const [ordensAsfalto, setOrdensAsfalto] = useState<OSItem[]>([]);
  const [loadingBuraco, setLoadingBuraco] = useState(true);
  const [loadingAsfalto, setLoadingAsfalto] = useState(true);
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

  const loading = loadingBuraco || loadingAsfalto;
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
    const qBuraco = query(
      collection(db, "ordens_servico"),
      orderBy("createdAt", "desc")
    );

    const unsubscribe = onSnapshot(
      qBuraco,
      (snapshot) => {
        setOrdensBuraco(
          snapshot.docs.map((document) =>
            mapSnapshotDocument(document.id, document.data(), "buraco")
          )
        );
        setLoadingBuraco(false);
        setLastUpdatedAt(new Date());
      },
      (error) => {
        console.error("Erro ao carregar ordens_servico:", error);
        setLoadError("Não foi possível carregar as ordens de Calçamento.");
        setLoadingBuraco(false);
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

  const startDate = useMemo(
    () => parseDateInput(filterStartDate),
    [filterStartDate]
  );
  const endDate = useMemo(
    () => parseDateInput(filterEndDate, true),
    [filterEndDate]
  );
  const referenceDate = endDate ?? now;

  const allOrders = useMemo(
    () => [...ordensBuraco, ...ordensAsfalto],
    [ordensBuraco, ordensAsfalto]
  );

  const metricsGeral = useMemo(
    () => buildMetrics(allOrders, referenceDate, startDate, endDate),
    [allOrders, referenceDate, startDate, endDate]
  );
  const metricsBuraco = useMemo(
    () => buildMetrics(ordensBuraco, referenceDate, startDate, endDate),
    [ordensBuraco, referenceDate, startDate, endDate]
  );
  const metricsAsfalto = useMemo(
    () => buildMetrics(ordensAsfalto, referenceDate, startDate, endDate),
    [ordensAsfalto, referenceDate, startDate, endDate]
  );

  const currentMetrics =
    activeTab === "geral"
      ? metricsGeral
      : activeTab === "buraco"
        ? metricsBuraco
        : metricsAsfalto;

  const header = useMemo(() => {
    if (activeTab === "buraco") {
      return {
        title: "Calçamento",
        description: "Indicadores das ordens de Calçamento registradas no sistema.",
      };
    }

    if (activeTab === "asfalto") {
      return {
        title: "Asfalto",
        description: "Indicadores das ordens de Asfalto registradas no sistema.",
      };
    }

    return {
      title: "Visão geral da operação",
      description:
        "Consolida Calçamento e Asfalto em uma visão operacional única.",
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
    const monthStartKey = formatDateInput(
      new Date(today.getFullYear(), today.getMonth(), 1)
    );

    if (filterStartDate === todayKey && filterEndDate === todayKey) return "hoje";
    if (
      filterStartDate === formatDateInput(addDays(today, -6)) &&
      filterEndDate === todayKey
    ) {
      return "7dias";
    }
    if (
      filterStartDate === formatDateInput(addDays(today, -29)) &&
      filterEndDate === todayKey
    ) {
      return "30dias";
    }
    if (filterStartDate === monthStartKey && filterEndDate === todayKey) return "mes";
    return "personalizado";
  }, [filterStartDate, filterEndDate, now]);

  const applyPreset = useCallback(
    (preset: Exclude<FilterPreset, "personalizado">) => {
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

      setFilterStartDate(
        formatDateInput(new Date(today.getFullYear(), today.getMonth(), 1))
      );
      setFilterEndDate(todayKey);
    },
    []
  );

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
        subtitle:
          "Situação atual das ordens criadas dentro do período selecionado.",
      },
      sla: {
        id: "sla",
        title: "Situação do SLA",
        subtitle:
          "Faixas de prazo das ordens abertas, considerando as pausas registradas.",
      },
      origem: {
        id: "origem",
        title: "Distribuição por origem",
        subtitle: "Participação de Calçamento e Asfalto no período selecionado.",
      },
      produtividade: {
        id: "produtividade",
        title: "Produtividade — últimos 7 dias",
        subtitle:
          "Ordens concluídas por data de execução nos sete dias anteriores à data final.",
      },
    }),
    []
  );

  const openExpanded = useCallback((config: ExpandedCardConfig) => {
    setExpandedCard(config);
  }, []);

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
    if (isPeriodFilterActive) {
      document.body.classList.add("print-dashboard-period-filter");
    }

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
      const total = currentMetrics.resumoStatus.reduce(
        (sum, item) => sum + item.value,
        0
      );

      if (total === 0) {
        return <ChartEmptyState message="Nenhuma ordem encontrada para este período." />;
      }

      return (
        <>
          <ResponsiveContainer width="100%" height={height}>
            <BarChart
              data={currentMetrics.resumoStatus}
              margin={{ top: 12, right: 18, left: 0, bottom: 36 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="name" tick={{ fontSize: 11 }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
              <Tooltip
                formatter={(value) => [String(value), "Quantidade"]}
                contentStyle={TOOLTIP_STYLE}
              />
              <Bar dataKey="value" name="Quantidade" radius={[8, 8, 0, 0]}>
                {currentMetrics.resumoStatus.map((entry) => (
                  <Cell key={entry.name} fill={entry.color} />
                ))}
                <LabelList dataKey="value" position="top" fontSize={11} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          {renderLegendPrintOnly(
            currentMetrics.resumoStatus.map((item) => `${item.name}: ${item.value}`)
          )}
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
            <BarChart
              data={data}
              layout="vertical"
              margin={{ top: 12, right: 34, left: 18, bottom: 26 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} />
              <YAxis
                type="category"
                dataKey="name"
                width={132}
                tick={{ fontSize: 11 }}
              />
              <Tooltip
                formatter={(value) => [String(value), "Quantidade"]}
                contentStyle={TOOLTIP_STYLE}
              />
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

  const renderOriginChart = useCallback(
    (height: number) => {
      const data = currentMetrics.origemData.filter((item) => item.value > 0);
      if (data.length === 0) {
        return <ChartEmptyState message="Nenhuma ordem encontrada para este período." />;
      }

      return (
        <>
          <ResponsiveContainer width="100%" height={height}>
            <PieChart>
              <Pie
                data={data}
                cx="45%"
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
              <Tooltip
                formatter={(value) => [String(value), "Quantidade"]}
                contentStyle={TOOLTIP_STYLE}
              />
              <Legend
                layout="vertical"
                align="right"
                verticalAlign="middle"
                wrapperStyle={{ fontSize: 12 }}
              />
            </PieChart>
          </ResponsiveContainer>
          {renderLegendPrintOnly(data.map((item) => `${item.name}: ${item.value}`))}
        </>
      );
    },
    [currentMetrics.origemData, renderLegendPrintOnly]
  );

  const renderProductivityChart = useCallback(
    (height: number) => {
      const total = currentMetrics.produtividade7dias.reduce(
        (sum, item) => sum + item.concluidas,
        0
      );

      return (
        <>
          <ResponsiveContainer width="100%" height={height}>
            <BarChart
              data={currentMetrics.produtividade7dias}
              margin={{ top: 16, right: 18, left: 0, bottom: 36 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="dia" interval={0} tick={{ fontSize: 11 }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
              <Tooltip
                labelFormatter={(_, payload) =>
                  payload?.[0]?.payload?.dataCompleta ?? ""
                }
                formatter={(value) => [String(value), "Concluídas"]}
                contentStyle={TOOLTIP_STYLE}
              />
              <Bar
                dataKey="concluidas"
                name="Concluídas"
                fill="#16a34a"
                radius={[8, 8, 0, 0]}
                minPointSize={2}
              >
                <LabelList dataKey="concluidas" position="top" fontSize={11} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          {renderLegendPrintOnly([`Total nos últimos 7 dias: ${total}`])}
        </>
      );
    },
    [currentMetrics.produtividade7dias, renderLegendPrintOnly]
  );

  const expandedContent = useMemo(() => {
    if (!expandedCard) return null;

    let chart: React.ReactNode;
    let summaryLines: string[];

    if (expandedCard.id === "status") {
      chart = renderStatusChart(CHART_HEIGHT_MODAL);
      summaryLines = chunkLines(
        currentMetrics.resumoStatus.map((item) => `${item.name}: ${item.value}`),
        3
      );
    } else if (expandedCard.id === "sla") {
      chart = renderSlaChart(CHART_HEIGHT_MODAL);
      summaryLines = chunkLines(
        currentMetrics.slaData.map((item) => `${item.name}: ${item.value}`),
        2
      );
    } else if (expandedCard.id === "origem") {
      chart = renderOriginChart(CHART_HEIGHT_MODAL);
      summaryLines = chunkLines(
        currentMetrics.origemData.map((item) => `${item.name}: ${item.value}`),
        2
      );
    } else {
      chart = renderProductivityChart(CHART_HEIGHT_MODAL);
      summaryLines = chunkLines(
        currentMetrics.produtividade7dias.map(
          (item) => `${item.dia}: ${item.concluidas}`
        ),
        4
      );
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
    renderOriginChart,
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

      <header className="page-header dashboard-header-grid">
        <div>
          <span className="dashboard-eyebrow">Painel operacional</span>
          <h2>{header.title}</h2>
          <p className="page-section-description">{header.description}</p>
        </div>
        <div className="dashboard-header-highlight">
          <span className="dashboard-header-label">OS criadas no período</span>
          <span className="dashboard-header-value">{currentMetrics.totalPeriodo}</span>
          <span className="dashboard-header-sub">{filterRangeLabel}</span>
        </div>
      </header>

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
              ? `Atualizado às ${lastUpdatedAt.toLocaleTimeString("pt-BR", {
                  hour: "2-digit",
                  minute: "2-digit",
                })}`
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
                <div id="dashboard-filter-title" className="dashboard-modal-title">
                  Período personalizado
                </div>
                <div className="dashboard-modal-subtitle">
                  A alteração só será aplicada ao clicar em “Aplicar período”.
                </div>
              </div>
              <button
                type="button"
                className="dashboard-modal-close"
                onClick={() => setIsFilterOpen(false)}
                aria-label="Fechar filtro"
              >
                ✕
              </button>
            </div>

            <div className="dashboard-modal-body">
              <label className="dashboard-filter-field">
                <span>Data inicial</span>
                <input
                  type="date"
                  value={draftStartDate ?? ""}
                  onChange={(event) =>
                    setDraftStartDate(event.target.value || null)
                  }
                />
              </label>
              <label className="dashboard-filter-field">
                <span>Data final</span>
                <input
                  type="date"
                  value={draftEndDate ?? ""}
                  onChange={(event) => setDraftEndDate(event.target.value || null)}
                />
              </label>
              {filterError && (
                <div className="dashboard-filter-error" role="alert">
                  {filterError}
                </div>
              )}
            </div>

            <div className="dashboard-modal-footer">
              <button
                type="button"
                className="dashboard-filter-clear"
                onClick={clearDraftFilter}
              >
                Limpar
              </button>
              <button
                type="button"
                className="dashboard-filter-button"
                onClick={applyCustomFilter}
              >
                Aplicar período
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="page-tabs dashboard-tabs screen-only" role="tablist">
        {([
          ["geral", "Geral"],
          ["buraco", "Calçamento"],
          ["asfalto", "Asfalto"],
        ] as const).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={activeTab === value}
            className={`page-tab ${activeTab === value ? "is-active" : ""}`}
            onClick={() => setActiveTab(value)}
          >
            {label}
          </button>
        ))}
      </div>

      {loadError && <div className="status-banner status-error">{loadError}</div>}
      {loading && allOrders.length === 0 ? (
        <div className="dashboard-loading">Carregando indicadores...</div>
      ) : (
        <>
          <div className="dashboard-kpi-grid">
            <div className="dashboard-kpi-card kpi-abertas">
              <div className="dashboard-kpi-header">
                <span className="dashboard-kpi-icon">📂</span>
                <span className="dashboard-kpi-label">OS abertas</span>
              </div>
              <div className="dashboard-kpi-value">{currentMetrics.abertasCount}</div>
              <div className="dashboard-kpi-sub">Ainda não concluídas.</div>
            </div>

            <div className="dashboard-kpi-card kpi-aguardando">
              <div className="dashboard-kpi-header">
                <span className="dashboard-kpi-icon">⏸</span>
                <span className="dashboard-kpi-label">Aguardando SANEAR</span>
              </div>
              <div className="dashboard-kpi-value">
                {currentMetrics.aguardandoSanearCount}
              </div>
              <div className="dashboard-kpi-sub">SLA pausado por dependência interna.</div>
            </div>

            <div className="dashboard-kpi-card kpi-atrasadas">
              <div className="dashboard-kpi-header">
                <span className="dashboard-kpi-icon">⏱</span>
                <span className="dashboard-kpi-label">OS atrasadas</span>
              </div>
              <div className="dashboard-kpi-value">{currentMetrics.atrasadasCount}</div>
              <div className="dashboard-kpi-sub">
                Acima do SLA configurado de {SLA_HORAS_PADRAO}h.
              </div>
            </div>

            <div className="dashboard-kpi-card kpi-concluidas-periodo">
              <div className="dashboard-kpi-header">
                <span className="dashboard-kpi-icon">✅</span>
                <span className="dashboard-kpi-label">Concluídas no período</span>
              </div>
              <div className="dashboard-kpi-value">
                {currentMetrics.concluidasNoPeriodo}
              </div>
              <div className="dashboard-kpi-sub">Considera a data de execução.</div>
            </div>

            <div className="dashboard-kpi-card kpi-concluidas">
              <div className="dashboard-kpi-header">
                <span className="dashboard-kpi-icon">📈</span>
                <span className="dashboard-kpi-label">Concluídas em 7 dias</span>
              </div>
              <div className="dashboard-kpi-value">{currentMetrics.concluidas7dias}</div>
              <div className="dashboard-kpi-sub">Produtividade recente.</div>
            </div>

            <div className="dashboard-kpi-card kpi-taxa">
              <div className="dashboard-kpi-header">
                <span className="dashboard-kpi-icon">%</span>
                <span className="dashboard-kpi-label">Taxa de conclusão</span>
              </div>
              <div className="dashboard-kpi-value">{currentMetrics.taxaConclusao}%</div>
              <div className="dashboard-kpi-sub">
                Das OS criadas no período selecionado.
              </div>
            </div>
          </div>

          <div className="dashboard-section">
            <div className="dashboard-charts-grid">
              {renderExpandableCard(
                expandedConfigs.status,
                renderStatusChart(CHART_HEIGHT_CARD)
              )}
              {renderExpandableCard(
                expandedConfigs.sla,
                renderSlaChart(CHART_HEIGHT_CARD)
              )}
            </div>
          </div>

          <div className="dashboard-section">
            <div className="dashboard-charts-grid">
              {activeTab === "geral" &&
                renderExpandableCard(
                  expandedConfigs.origem,
                  renderOriginChart(CHART_HEIGHT_CARD)
                )}
              {renderExpandableCard(
                expandedConfigs.produtividade,
                renderProductivityChart(CHART_HEIGHT_CARD),
                activeTab === "geral" ? "" : "dashboard-chart-card--full"
              )}
            </div>
          </div>
        </>
      )}

      <div className="dashboard-print-container screen-only">
        <button
          type="button"
          className="dashboard-print-button"
          onClick={handlePrintDashboard}
        >
          🖨 Imprimir dashboard
        </button>
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
                <div id="dashboard-expanded-title" className="dashboard-expanded-title">
                  {expandedCard.title}
                </div>
                <div className="dashboard-expanded-subtitle">
                  {expandedCard.subtitle}
                </div>
              </div>
              <div className="dashboard-expanded-controls">
                <button
                  type="button"
                  className="dashboard-print-button"
                  onClick={handlePrintExpandedOnly}
                >
                  🖨 Imprimir gráfico
                </button>
                <button
                  type="button"
                  className="dashboard-modal-close"
                  onClick={closeExpanded}
                  aria-label="Fechar gráfico expandido"
                >
                  ✕
                </button>
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
