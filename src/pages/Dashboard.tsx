import React, { useCallback, useEffect, useMemo, useState } from "react";
import { collection, onSnapshot, orderBy, query } from "firebase/firestore";
import type { Timestamp } from "firebase/firestore";
import { db } from "../lib/firebaseClient";
import { MS_POR_HORA, SLA_HORAS_PADRAO } from "../lib/sla";
import type { SlaPausa } from "../lib/sla";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  PieChart,
  Pie,
  Cell,
  LabelList,
} from "recharts";

type Origem = "buraco" | "asfalto";

type OSItem = {
  id: string;
  origem: Origem;
  tipo?: string | null;
  status?: string | null;
  createdAt?: Timestamp | null;
  dataExecucao?: Timestamp | null;
  slaHoras?: number | null;
  slaPausas?: SlaPausa[] | null;
};

type Metrics = {
  totalHoje: number; // aqui vira "total no período", mas mantive o nome
  abertasCount: number;
  aguardandoSanearCount: number;
  osAtrasadas72hCount: number;
  concluidasHoje: number;
  concluidas7dias: number;
  concluidasTotal: number;
  resumoStatus: { status: string; value: number; color: string }[];
  porTipoData: { tipo: string; value: number }[];
  produtividade7dias: { dia: string; concluidas: number }[];
};

function normalizeStatus(status?: string | null): string {
  return (status || "").toString().trim().toUpperCase();
}

function normalizeText(value?: string | null): string {
  return (value ?? "")
    .toString()
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
}

/**
 * Inferência robusta da origem:
 * - Se o tipo indicar BURACO/CALÇAMENTO => buraco
 * - Se indicar ASFALTO => asfalto
 * - Se não der para saber, usa fallback (pela coleção)
 */
function inferOrigem(tipo?: string | null, fallback: Origem = "asfalto"): Origem {
  const t = normalizeText(tipo);
  if (!t) return fallback;

  // Calçamento
  if (
    t === "BURACO_RUA" ||
    t.includes("BURACO") ||
    t.includes("CALCAMENTO") ||
    t.includes("PAVIMENTO")
  ) {
    return "buraco";
  }

  // Asfalto
  if (t === "ASFALTO" || t.includes("ASFALTO")) {
    return "asfalto";
  }

  return fallback;
}

function tipoLabel(os: OSItem): string {
  const t = normalizeText(os.tipo);

  if (t === "BURACO_RUA" || os.origem === "buraco") return "Calçamento";
  if (t === "ASFALTO" || os.origem === "asfalto") return "Asfalto";
  return "Outros";
}

function toDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function tsToDateKey(ts?: Timestamp | null): string | null {
  if (!ts) return null;
  return toDateKey(ts.toDate());
}
function anyToDate(value: unknown): Date | null {
  if (!value) return null;
  const v: any = value as any;
  if (typeof v?.toDate === "function") return v.toDate() as Date;
  if (value instanceof Date) return value;
  return null;
}


// buildMetrics aplica recorte de período baseado em createdAt
function buildMetrics(
  ordens: OSItem[],
  referenceDate: Date,
  startDate?: Date | null,
  endDate?: Date | null
): Metrics {
  const today = referenceDate;
  const todayKey = toDateKey(today);
  const sevenDaysAgo = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() - 6
  );
  const sevenDaysAgoKey = toDateKey(sevenDaysAgo);

  const startKey = startDate ? toDateKey(startDate) : null;
  const endKey = endDate ? toDateKey(endDate) : null;

  let totalHoje = 0; // total dentro do período
  let abertasCount = 0;
  let concluidasTotal = 0;
  let aguardandoSanearCount = 0;
  let osAtrasadas72hCount = 0;
  let concluidasHoje = 0;
  let concluidas7dias = 0;

  const porTipoMap = new Map<string, number>();

  const diasArr: { label: string; key: string; concluidas: number }[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate() - i
    );
    const key = toDateKey(d);
    const label = d.toLocaleDateString("pt-BR", { weekday: "short" });
    diasArr.push({ label, key, concluidas: 0 });
  }

  for (const os of ordens) {
    const createdKey = tsToDateKey(os.createdAt);

    // aplica recorte de período (por createdAt)
    if (startKey && (!createdKey || createdKey < startKey)) continue;
    if (endKey && (!createdKey || createdKey > endKey)) continue;

    totalHoje++;

    const s = normalizeStatus(os.status);
    const isConcluida =
      s === "CONCLUIDA" || s === "CONCLUIDO" || s === "CONCLUÍDA";
    const isCancelada = s === "CANCELADA" || s === "CANCELADO";
    const isAguardandoSanear =
      s === "AGUARDANDO_SANEAR" || s === "AGUARDANDO SANEAR";

    // Você não precisa mais de "canceladas": ignorar no dashboard
    if (isCancelada) continue;

    if (isConcluida) {
      concluidasTotal++;
    } else {
      abertasCount++;
      if (isAguardandoSanear) {
        aguardandoSanearCount++;
      }
    }

    // Contagem de atraso (72h), descontando pausas (SLA pausado)
    if (!isConcluida) {
      const created = anyToDate(os.createdAt);
      if (created) {
        const slaHoras =
          typeof os.slaHoras === "number" && os.slaHoras > 0
            ? os.slaHoras
            : SLA_HORAS_PADRAO;

        const pausas = Array.isArray(os.slaPausas) ? os.slaPausas : [];
        let pausadoMs = 0;

        for (const p of pausas) {
          const ini = anyToDate((p as any)?.inicioEm);
          if (!ini) continue;
          const fim = anyToDate((p as any)?.fimEm) ?? today;
          const ms = fim.getTime() - ini.getTime();
          if (ms > 0) pausadoMs += ms;
        }

        const utilMs = today.getTime() - created.getTime() - pausadoMs;
        const horasUtil = utilMs / MS_POR_HORA;

        if (horasUtil > slaHoras) osAtrasadas72hCount++;
      }
    }

    const labelTipo = tipoLabel(os);
    porTipoMap.set(labelTipo, (porTipoMap.get(labelTipo) ?? 0) + 1);

    // produtividade só para concluídas
    if (isConcluida) {
      const refTs = os.dataExecucao ?? os.createdAt;
      const key = tsToDateKey(refTs);

      if (key === todayKey) concluidasHoje++;
      if (key && key >= sevenDaysAgoKey && key <= todayKey) concluidas7dias++;
      if (key) {
        const dia = diasArr.find((d) => d.key === key);
        if (dia) dia.concluidas += 1;
      }
    }
  }

  const porTipoData = Array.from(porTipoMap.entries()).map(([tipo, value]) => ({
    tipo,
    value,
  }));

  const produtividade7dias = diasArr.map((d) => ({
    dia: d.label,
    concluidas: d.concluidas,
  }));

  const resumoStatus = [
    {
      status: "Abertas",
      value: Math.max(0, abertasCount - aguardandoSanearCount),
      color: "#f97316",
    },
    { status: "Aguardando SANEAR", value: aguardandoSanearCount, color: "#facc15" },
    { status: "Concluídas", value: concluidasTotal, color: "#22c55e" },
  ];

  return {
    totalHoje,
    abertasCount,
    aguardandoSanearCount,
    osAtrasadas72hCount,
    concluidasHoje,
    concluidas7dias,
    concluidasTotal,
    resumoStatus,
    porTipoData,
    produtividade7dias,
  };
}

const CHART_HEIGHT_CARD = 260;
const CHART_HEIGHT_MODAL = 520;

type ExpandedCardId = "status" | "tipo" | "origem" | "prod";

type ExpandedCardConfig = {
  id: ExpandedCardId;
  title: string;
  subtitle: string;
};

/** Resumo numérico bonito (aparece no modal e imprime no PDF) */
type ResumoNumericoProps = {
  titulo?: string;
  linhas: string[];
};

const ResumoNumerico: React.FC<ResumoNumericoProps> = ({ titulo, linhas }) => {
  if (!linhas || linhas.length === 0) return null;

  return (
    <div className="dashboard-resumo-numerico">
      {titulo && <div className="dashboard-resumo-title">{titulo}</div>}
      <div className="dashboard-resumo-linhas">
        {linhas.map((t, idx) => (
          <div key={idx} className="dashboard-resumo-linha">
            {t}
          </div>
        ))}
      </div>
    </div>
  );
};

/** Quebra uma lista em linhas menores para não ficar uma linha gigante no PDF */
function chunkLines(items: string[], maxPerLine: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < items.length; i += maxPerLine) {
    out.push(items.slice(i, i + maxPerLine).join("  •  "));
  }
  return out;
}

const Dashboard: React.FC = () => {
  const [ordensBuracoRaw, setOrdensBuracoRaw] = useState<OSItem[]>([]);
  const [ordensAsfaltoRaw, setOrdensAsfaltoRaw] = useState<OSItem[]>([]);
  const [loading, setLoading] = useState(true);

  const [activeTab, setActiveTab] = useState<"geral" | "buraco" | "asfalto">(
    "geral"
  );

  // FILTRO DE PERÍODO (PERSISTENTE)
  const [filterStartDate, setFilterStartDate] = useState<string | null>(null);
  const [filterEndDate, setFilterEndDate] = useState<string | null>(null);
  const [isFilterOpen, setIsFilterOpen] = useState(false);

  const isPeriodFilterActive = Boolean(filterStartDate || filterEndDate);

  // EXPANDIR GRÁFICO
  const [expandedCard, setExpandedCard] = useState<ExpandedCardConfig | null>(
    null
  );

  // trava scroll do body quando modal abre
  useEffect(() => {
    if (expandedCard || isFilterOpen) {
      document.body.classList.add("dashboard-lock-scroll");
    } else {
      document.body.classList.remove("dashboard-lock-scroll");
    }
    return () => {
      document.body.classList.remove("dashboard-lock-scroll");
    };
  }, [expandedCard, isFilterOpen]);

  // ESC fecha modais
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (expandedCard) setExpandedCard(null);
      if (isFilterOpen) setIsFilterOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expandedCard, isFilterOpen]);

  // Carrega período salvo
  useEffect(() => {
    const start = localStorage.getItem("dashboardDateFilterStart");
    const end = localStorage.getItem("dashboardDateFilterEnd");
    if (start) setFilterStartDate(start);
    if (end) setFilterEndDate(end);
  }, []);

  // Salva período sempre que mudar
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

  // Data de referência: usa a data final, ou hoje se não tiver
  const referenceDate = useMemo(() => {
    if (filterEndDate) {
      const d = new Date(filterEndDate);
      if (!Number.isNaN(d.getTime())) return d;
    }
    return new Date();
  }, [filterEndDate]);

  const startDateObj = useMemo(
    () => (filterStartDate ? new Date(filterStartDate) : null),
    [filterStartDate]
  );
  const endDateObj = useMemo(
    () => (filterEndDate ? new Date(filterEndDate) : null),
    [filterEndDate]
  );

  const filterRangeLabel = useMemo(() => {
    const startLabel = filterStartDate
      ? new Date(filterStartDate).toLocaleDateString("pt-BR")
      : null;
    const endLabel = filterEndDate
      ? new Date(filterEndDate).toLocaleDateString("pt-BR")
      : null;

    if (startLabel && endLabel) return `${startLabel} até ${endLabel}`;
    if (startLabel) return `A partir de ${startLabel}`;
    if (endLabel) return `Até ${endLabel}`;
    return null;
  }, [filterStartDate, filterEndDate]);

  useEffect(() => {
    // Calçamento (ordens_servico)
    const colBuraco = collection(db, "ordens_servico");
    const qBuraco = query(colBuraco, orderBy("createdAt", "desc"));

    const unsubBuraco = onSnapshot(
      qBuraco,
      (snapshot) => {
        const lista: OSItem[] = snapshot.docs.map((docSnap) => {
          const data = docSnap.data() as any;
          return {
            id: docSnap.id,
            origem: inferOrigem(data.tipo ?? null, "buraco"),
            tipo: data.tipo ?? null,
            status: data.status ?? null,
            createdAt: (data.createdAt as Timestamp | null) ?? null,
            dataExecucao: (data.dataExecucao as Timestamp | null) ?? null,
            slaHoras: (data.slaHoras as number | null) ?? null,
            slaPausas: (data.slaPausas as SlaPausa[] | null) ?? null,
          };
        });
        setOrdensBuracoRaw(lista);
        setLoading(false);
      },
      (err) => {
        console.error("Erro ao carregar ordens_servico:", err);
        setLoading(false);
      }
    );

    // Asfalto (ordensServico)
    const colAsfalto = collection(db, "ordensServico");
    const qAsfalto = query(colAsfalto, orderBy("createdAt", "desc"));

    const unsubAsfalto = onSnapshot(
      qAsfalto,
      (snapshot) => {
        const lista: OSItem[] = snapshot.docs.map((docSnap) => {
          const data = docSnap.data() as any;
          return {
            id: docSnap.id,
            origem: inferOrigem(data.tipo ?? null, "asfalto"),
            tipo: data.tipo ?? null,
            status: data.status ?? null,
            createdAt: (data.createdAt as Timestamp | null) ?? null,
            dataExecucao: (data.dataExecucao as Timestamp | null) ?? null,
            slaHoras: (data.slaHoras as number | null) ?? null,
            slaPausas: (data.slaPausas as SlaPausa[] | null) ?? null,
          };
        });
        setOrdensAsfaltoRaw(lista);
        setLoading(false);
      },
      (err) => {
        console.error("Erro ao carregar ordensServico:", err);
        setLoading(false);
      }
    );

    return () => {
      unsubBuraco();
      unsubAsfalto();
    };
  }, []);

  // Junta tudo e separa pela origem inferida
  const ordensAll = useMemo(
    () => [...ordensBuracoRaw, ...ordensAsfaltoRaw],
    [ordensBuracoRaw, ordensAsfaltoRaw]
  );

  const ordensBuraco = useMemo(
    () => ordensAll.filter((o) => o.origem === "buraco"),
    [ordensAll]
  );

  const ordensAsfalto = useMemo(
    () => ordensAll.filter((o) => o.origem === "asfalto"),
    [ordensAll]
  );

  const ordens = useMemo(
    () => [...ordensBuraco, ...ordensAsfalto],
    [ordensBuraco, ordensAsfalto]
  );

  const metricsGeral = useMemo(
    () => buildMetrics(ordens, referenceDate, startDateObj, endDateObj),
    [ordens, referenceDate, startDateObj, endDateObj]
  );

  const metricsBuraco = useMemo(
    () => buildMetrics(ordensBuraco, referenceDate, startDateObj, endDateObj),
    [ordensBuraco, referenceDate, startDateObj, endDateObj]
  );

  const metricsAsfalto = useMemo(
    () => buildMetrics(ordensAsfalto, referenceDate, startDateObj, endDateObj),
    [ordensAsfalto, referenceDate, startDateObj, endDateObj]
  );

  const origemData = useMemo(() => {
    const totalBuraco = ordensBuraco.length;
    const totalAsfalto = ordensAsfalto.length;
    const data: { name: string; value: number }[] = [];
    if (totalBuraco > 0) data.push({ name: "Calçamento", value: totalBuraco });
    if (totalAsfalto > 0) data.push({ name: "Asfalto", value: totalAsfalto });
    return data;
  }, [ordensBuraco.length, ordensAsfalto.length]);

  const currentMetrics =
    activeTab === "geral"
      ? metricsGeral
      : activeTab === "buraco"
      ? metricsBuraco
      : metricsAsfalto;

  const pieColors = ["#22c55e", "#3b82f6", "#f97316", "#a855f7"];

  // Header dinâmico por aba
  let headerTitle = "";
  let headerDesc = "";
  let headerLabel = "";
  let headerSubBase = "";

  if (activeTab === "geral") {
    headerTitle = "Visão geral da operação";
    headerDesc =
      "Consolida todas as ordens de Calçamento e Asfalto para uma visão macro da operação.";
    headerLabel = "OS no período";
    headerSubBase = "Total de ordens registradas dentro do período selecionado.";
  } else if (activeTab === "buraco") {
    headerTitle = "Calçamento";
    headerDesc =
      "Indicadores focados apenas nas ordens de Calçamento registradas no sistema.";
    headerLabel = "OS no período (Calçamento)";
    headerSubBase =
      "Ordens de Calçamento dentro do período configurado no filtro.";
  } else {
    headerTitle = "Asfalto";
    headerDesc =
      "Indicadores focados apenas nas ordens de Asfalto registradas no sistema.";
    headerLabel = "OS no período (Asfalto)";
    headerSubBase = "Ordens de Asfalto dentro do período configurado no filtro.";
  }

  const headerSub = filterRangeLabel
    ? `${headerSubBase} Período: ${filterRangeLabel}.`
    : `${headerSubBase} (sem filtro: considerando todo o histórico).`;

  // Card 4 dinâmico
  let card4Label = "";
  let card4Value = 0;
  let card4Sub = "";

  if (activeTab === "geral") {
    card4Label = "Calçamento em aberto";
    card4Value = metricsBuraco.abertasCount;
    card4Sub =
      "Quantidade de ordens de Calçamento que ainda não foram concluídas.";
  } else if (activeTab === "buraco") {
    card4Label = "Total Calçamento";
    card4Value = ordensBuraco.length;
    card4Sub = "Total de ordens de Calçamento cadastradas no sistema.";
  } else {
    card4Label = "Total Asfalto";
    card4Value = ordensAsfalto.length;
    card4Sub = "Total de ordens de Asfalto cadastradas no sistema.";
  }

  // Card 2 dinâmico
  let card2Label = "";
  let card2Value = 0;
  let card2Sub = "";

  if (activeTab === "buraco") {
    card2Label = "Calçamento em aberto";
    card2Value = metricsBuraco.abertasCount;
    card2Sub = "Ordens de Calçamento que estão em aberto no sistema.";
  } else {
    card2Label = "Asfalto em aberto";
    card2Value = metricsAsfalto.abertasCount;
    card2Sub = "Ordens de Asfalto que estão em aberto no sistema.";
  }

  const resumoStatus = currentMetrics.resumoStatus;
  const porTipoData = currentMetrics.porTipoData;
  const produtividade7dias = currentMetrics.produtividade7dias;
  const totalHojeHeader = currentMetrics.totalHoje;

  const expandedConfigs = useMemo<Record<ExpandedCardId, ExpandedCardConfig>>(
    () => ({
      status: {
        id: "status",
        title: "OS por status",
        subtitle:
          "Distribuição das ordens entre abertas, aguardando SANEAR e concluídas (conforme a aba selecionada).",
      },
      tipo: {
        id: "tipo",
        title: "OS por tipo de atendimento",
        subtitle:
          "Classificação das ordens pelo tipo mais relevante para o setor operacional.",
      },
      origem: {
        id: "origem",
        title: "Distribuição por origem",
        subtitle: "Quantidade de ordens criadas para Calçamento e Asfalto.",
      },
      prod: {
        id: "prod",
        title: "Produtividade — últimos 7 dias",
        subtitle:
          activeTab === "geral"
            ? "Quantidade de ordens concluídas por dia, considerando o período e a data final como referência."
            : "Quantidade de ordens concluídas por dia, apenas deste serviço.",
      },
    }),
    [activeTab]
  );

  const handleClearFilter = useCallback(() => {
    setFilterStartDate(null);
    setFilterEndDate(null);
  }, []);

  const handlePrintDashboard = useCallback(() => {
    document.body.classList.add("print-dashboard");
    if (isPeriodFilterActive) {
      document.body.classList.add("print-dashboard-period-filter");
    }

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      document.body.classList.remove("print-dashboard");
      document.body.classList.remove("print-dashboard-period-filter");
      window.removeEventListener("afterprint", cleanup);
    };

    window.addEventListener("afterprint", cleanup);
    window.print();

    // fallback (alguns browsers não disparam afterprint)
    setTimeout(cleanup, 2000);
  }, [isPeriodFilterActive]);


  const openExpanded = useCallback((cfg: ExpandedCardConfig) => {
    setExpandedCard(cfg);
  }, []);

  const closeExpanded = useCallback(() => {
    setExpandedCard(null);
  }, []);

  const onCardKeyDown = useCallback(
    (e: React.KeyboardEvent, cfg: ExpandedCardConfig) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openExpanded(cfg);
      }
    },
    [openExpanded]
  );

  // ---------- Legenda "print-only" (garante que apareça no papel) ----------
  const renderLegendPrintOnly = useCallback((items: string[]) => {
    if (!items || items.length === 0) return null;
    return <div className="legend-print-only">{items.join(" • ")}</div>;
  }, []);

  const legendStatusItems = useMemo(
    () => resumoStatus.map((s) => `${s.status}: ${s.value}`),
    [resumoStatus]
  );

  const legendTipoItems = useMemo(() => {
    const sorted = [...porTipoData].sort((a, b) => b.value - a.value);
    return sorted.map((t) => `${t.tipo}: ${t.value}`);
  }, [porTipoData]);

  const legendOrigemItems = useMemo(
    () => origemData.map((o) => `${o.name}: ${o.value}`),
    [origemData]
  );

  const legendProdItems = useMemo(() => {
    const total = produtividade7dias.reduce((acc, d) => acc + d.concluidas, 0);
    return [`Total 7 dias: ${total}`];
  }, [produtividade7dias]);

  // ---------- Impressão somente do card expandido (sem about:blank) ----------
  const handlePrintExpandedOnly = useCallback(() => {
    if (!expandedCard) return;

    const prevTitle = document.title;
    document.title = `SANEAR - ${expandedCard.title}`;

    document.body.classList.add("print-expanded-only");

    // garante que o root existe antes de mandar imprimir
    requestAnimationFrame(() => {
      const root = document.getElementById("dashboard-expanded-print-root");
      root?.scrollIntoView({ block: "start" });

      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        document.body.classList.remove("print-expanded-only");
        document.title = prevTitle;
        window.removeEventListener("afterprint", cleanup);
      };

      window.addEventListener("afterprint", cleanup);

      // pequena folga pro browser recalcular layout do Recharts
      setTimeout(() => {
        window.print();
        setTimeout(cleanup, 1500);
      }, 120);
    });
  }, [expandedCard]);

  // ---------- RENDERIZAÇÕES DE CHART ----------
  const renderStatusChart = useCallback(
    (height: number) => (
      <>
        <ResponsiveContainer width="100%" height={height}>
          <BarChart
            data={resumoStatus}
            margin={{ top: 10, right: 16, left: 0, bottom: 34 }} // ✅ mais espaço pro print
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
            <XAxis dataKey="status" tick={{ fontSize: 11 }} />
            <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
            <Tooltip
              formatter={(value: any) => [`${value}`, "Quantidade"]}
              contentStyle={{
                backgroundColor: "#020617",
                border: "1px solid #1f2937",
                borderRadius: 8,
                fontSize: 12,
              }}
            />
            <Legend
              verticalAlign="bottom"
              height={24}
              wrapperStyle={{ fontSize: 12 }}
            />
            <Bar dataKey="value" name="Quantidade">
              {resumoStatus.map((entry) => (
                <Cell key={entry.status} fill={entry.color} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>

        {/* ✅ garante legenda no papel */}
        {renderLegendPrintOnly(legendStatusItems)}
      </>
    ),
    [resumoStatus, renderLegendPrintOnly, legendStatusItems]
  );

  const renderTipoChart = useCallback(
    (height: number, suffix: string) => {
      const gradId = `tipoGradient-${suffix}`;
      return (
        <>
          <ResponsiveContainer width="100%" height={height}>
            <BarChart
              data={porTipoData}
              layout="vertical"
              margin={{ top: 10, right: 28, left: 12, bottom: 34 }} // ✅ mais espaço no print
            >
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="rgba(148, 163, 184, 0.35)"
              />

              <XAxis
                type="number"
                allowDecimals={false}
                domain={[0, "dataMax"]}
                tick={{ fontSize: 12 }}
                axisLine={{ stroke: "rgba(148, 163, 184, 0.55)" }}
                tickLine={{ stroke: "rgba(148, 163, 184, 0.35)" }}
              />

              <YAxis
                type="category"
                dataKey="tipo"
                width={120}
                tick={{ fontSize: 12 }}
                axisLine={{ stroke: "rgba(148, 163, 184, 0.55)" }}
                tickLine={{ stroke: "rgba(148, 163, 184, 0.35)" }}
              />

              <Tooltip
                formatter={(value: any) => [`${value}`, "Quantidade"]}
                contentStyle={{
                  backgroundColor: "#0b1220",
                  border: "1px solid rgba(148, 163, 184, 0.35)",
                  borderRadius: 10,
                  fontSize: 12,
                }}
              />

              <Bar
                dataKey="value"
                name="Quantidade"
                fill={`url(#${gradId})`}
                barSize={72}
                radius={[12, 12, 12, 12]}
              />

              <Legend
                verticalAlign="bottom"
                height={24}
                wrapperStyle={{ fontSize: 12, marginTop: 8 }}
              />

              <defs>
                <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0%" stopColor="#22c55e" />
                  <stop offset="100%" stopColor="#0ea5e9" />
                </linearGradient>
              </defs>
            </BarChart>
          </ResponsiveContainer>

          {/* ✅ garante legenda no papel */}
          {renderLegendPrintOnly(legendTipoItems)}
        </>
      );
    },
    [porTipoData, renderLegendPrintOnly, legendTipoItems]
  );

  const renderOrigemChart = useCallback(
    (height: number) => (
      <>
        <ResponsiveContainer width="100%" height={height}>
          <PieChart>
            <Pie
              data={origemData}
              cx="50%"
              cy="50%"
              outerRadius={Math.min(120, Math.floor(height * 0.32))}
              innerRadius={Math.min(70, Math.floor(height * 0.18))}
              paddingAngle={3}
              dataKey="value"
            >
              {origemData.map((entry, index) => (
                <Cell
                  key={entry.name}
                  fill={pieColors[index % pieColors.length]}
                />
              ))}
            </Pie>
            <Tooltip
              formatter={(value: any) => [`${value}`, "Quantidade"]}
              contentStyle={{
                backgroundColor: "#020617",
                border: "1px solid #1f2937",
                borderRadius: 8,
                fontSize: 12,
              }}
            />
            <Legend
              layout="vertical"
              align="right"
              verticalAlign="middle"
              wrapperStyle={{ fontSize: 12 }}
            />
          </PieChart>
        </ResponsiveContainer>

        {/* ✅ garante legenda no papel */}
        {renderLegendPrintOnly(legendOrigemItems)}
      </>
    ),
    [origemData, pieColors, renderLegendPrintOnly, legendOrigemItems]
  );

  const renderProdChart = useCallback(
    (height: number, suffix: string) => {
      const gradId = `prodGradient-${suffix}`;
      return (
        <>
          <ResponsiveContainer width="100%" height={height}>
            <BarChart
              data={produtividade7dias}
              margin={{ top: 10, right: 16, left: 0, bottom: 40 }} // ✅ mais espaço no print
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
              <XAxis
                dataKey="dia"
                tick={{ fontSize: 11 }}
                interval={0}
                tickMargin={8}
              />
              <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
              <Tooltip
                formatter={(value: any) => [`${value}`, "Concluídas"]}
                contentStyle={{
                  backgroundColor: "#020617",
                  border: "1px solid #1f2937",
                  borderRadius: 8,
                  fontSize: 12,
                }}
              />
              <Bar
                dataKey="concluidas"
                name="Concluídas"
                fill={`url(#${gradId})`}
                barSize={34}
                minPointSize={2}
              >
                <LabelList dataKey="concluidas" position="top" fontSize={11} />
              </Bar>
              <Legend
                verticalAlign="bottom"
                height={24}
                wrapperStyle={{ fontSize: 12, marginTop: 8 }}
              />
              <defs>
                <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#22c55e" />
                  <stop offset="100%" stopColor="#166534" />
                </linearGradient>
              </defs>
            </BarChart>
          </ResponsiveContainer>

          {/* ✅ garante legenda no papel */}
          {renderLegendPrintOnly(legendProdItems)}
        </>
      );
    },
    [produtividade7dias, renderLegendPrintOnly, legendProdItems]
  );

  // ---------- RESUMOS NUMÉRICOS (somente no MODAL expandido) ----------
  const resumoNumericoStatus = useMemo(() => {
    const items = resumoStatus.map((s) => `${s.status}: ${s.value}`);
    return chunkLines(items, 3);
  }, [resumoStatus]);

  const resumoNumericoTipo = useMemo(() => {
    const sorted = [...porTipoData].sort((a, b) => b.value - a.value);
    const items = sorted.map((t) => `${t.tipo}: ${t.value}`);
    return chunkLines(items, 4);
  }, [porTipoData]);

  const resumoNumericoOrigem = useMemo(() => {
    const items = origemData.map((o) => `${o.name}: ${o.value}`);
    return chunkLines(items, 3);
  }, [origemData]);

  const resumoNumericoProd = useMemo(() => {
    const total = produtividade7dias.reduce((acc, d) => acc + d.concluidas, 0);
    const items = produtividade7dias.map((d) => `${d.dia}: ${d.concluidas}`);
    const lines = chunkLines(items, 4);
    lines.push(`Total (7 dias): ${total}`);
    return lines;
  }, [produtividade7dias]);

  const renderExpandedContent = useMemo(() => {
    if (!expandedCard) return null;

    let body: React.ReactNode = null;
    let resumoLinhas: string[] = [];
    let resumoTitulo = "Resumo numérico";

    if (expandedCard.id === "status") {
      body = renderStatusChart(CHART_HEIGHT_MODAL);
      resumoLinhas = resumoNumericoStatus;
    } else if (expandedCard.id === "tipo") {
      body = renderTipoChart(CHART_HEIGHT_MODAL, "tipo-modal");
      resumoLinhas = resumoNumericoTipo;
    } else if (expandedCard.id === "origem") {
      body = renderOrigemChart(CHART_HEIGHT_MODAL);
      resumoLinhas = resumoNumericoOrigem;
    } else {
      body = renderProdChart(CHART_HEIGHT_MODAL, "prod-modal");
      resumoLinhas = resumoNumericoProd;
      resumoTitulo = "Resumo numérico (últimos 7 dias)";
    }

    return (
      <div id="dashboard-expanded-print-root" className="dashboard-chart-card">
        <div className="dashboard-chart-header">
          <div>
            <h3>{expandedCard.title}</h3>
            <p className="dashboard-chart-sub">{expandedCard.subtitle}</p>
          </div>
        </div>

        <div className="dashboard-chart-body">{body}</div>

        <ResumoNumerico titulo={resumoTitulo} linhas={resumoLinhas} />
      </div>
    );
  }, [
    expandedCard,
    renderStatusChart,
    renderTipoChart,
    renderOrigemChart,
    renderProdChart,
    resumoNumericoStatus,
    resumoNumericoTipo,
    resumoNumericoOrigem,
    resumoNumericoProd,
  ]);

  return (
    <section className="page-card dashboard-layout">
      {/* Cabeçalho do relatório (somente impressão) */}
      <div className="dashboard-print-header print-only">
        <div className="dashboard-print-title">
          Relatório Operacional — SANEAR
        </div>
        <div className="dashboard-print-meta">
          <span>
            <strong>Seção:</strong> {headerTitle}
          </span>
          <span>
            <strong>Período:</strong> {filterRangeLabel || "Hoje"}
          </span>
          <span>
            <strong>Gerado em:</strong> {new Date().toLocaleString("pt-BR")}
          </span>
        </div>
      </div>

      <header className="page-header dashboard-header-grid">
        <div>
          <h2>{headerTitle}</h2>
          <p>{headerDesc}</p>
        </div>
        <div className="dashboard-header-highlight">
          <span className="dashboard-header-label">{headerLabel}</span>
          <span className="dashboard-header-value">{totalHojeHeader}</span>
          <span className="dashboard-header-sub">{headerSub}</span>
        </div>
      </header>

      {/* TOOLBAR */}
      <div className="dashboard-toolbar">
        <button
          type="button"
          className="dashboard-filter-button"
          onClick={() => setIsFilterOpen(true)}
        >
          <span className="dashboard-filter-icon" aria-hidden="true">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polygon points="3 4 21 4 14 12 14 19 10 21 10 12 3 4"></polygon>
            </svg>
          </span>
          <span>Filtro de período</span>
        </button>

        {filterRangeLabel && (
          <span className="dashboard-toolbar-active-filter">
            Período ativo: <strong>{filterRangeLabel}</strong>
          </span>
        )}
      </div>

      {/* MODAL DE PERÍODO */}
      {isFilterOpen && (
        <div
          className="dashboard-modal-backdrop"
          onClick={() => setIsFilterOpen(false)}
        >
          <div className="dashboard-modal" onClick={(e) => e.stopPropagation()}>
            <div className="dashboard-modal-header">
              <div>
                <div className="dashboard-modal-title">
                  Filtro de período do dashboard
                </div>
                <div className="dashboard-modal-subtitle">
                  Selecione a data inicial e final. Esse filtro fica salvo para
                  as próximas vezes que você abrir o sistema.
                </div>
              </div>
              <button
                type="button"
                className="dashboard-modal-close"
                onClick={() => setIsFilterOpen(false)}
                aria-label="Fechar filtro de período"
              >
                ✕
              </button>
            </div>

            <div className="dashboard-modal-body">
              <div className="dashboard-filter-field">
                <span>Data inicial</span>
                <input
                  type="date"
                  value={filterStartDate ?? ""}
                  onChange={(e) =>
                    setFilterStartDate(e.target.value ? e.target.value : null)
                  }
                />
              </div>
              <div className="dashboard-filter-field">
                <span>Data final</span>
                <input
                  type="date"
                  value={filterEndDate ?? ""}
                  onChange={(e) =>
                    setFilterEndDate(e.target.value ? e.target.value : null)
                  }
                />
              </div>
            </div>

            <div className="dashboard-modal-footer">
              <button
                type="button"
                className="dashboard-filter-clear"
                onClick={handleClearFilter}
              >
                Limpar período
              </button>
              <button
                type="button"
                className="dashboard-filter-button"
                onClick={() => setIsFilterOpen(false)}
              >
                Aplicar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Abinhas */}
      <div className="page-tabs dashboard-tabs">
        <button
          type="button"
          className={`page-tab ${activeTab === "geral" ? "is-active" : ""}`}
          onClick={() => setActiveTab("geral")}
        >
          Geral
        </button>
        <button
          type="button"
          className={`page-tab ${activeTab === "buraco" ? "is-active" : ""}`}
          onClick={() => setActiveTab("buraco")}
        >
          Calçamento
        </button>
        <button
          type="button"
          className={`page-tab ${activeTab === "asfalto" ? "is-active" : ""}`}
          onClick={() => setActiveTab("asfalto")}
        >
          Asfalto
        </button>
      </div>

      {loading && ordens.length === 0 && (
        <p className="field-hint">Carregando dados do dashboard...</p>
      )}

      {/* KPIs */}
      <div className="dashboard-kpi-grid">
        <div className="dashboard-kpi-card kpi-abertas">
          <div className="dashboard-kpi-header">
            <span className="dashboard-kpi-icon">📂</span>
            <span className="dashboard-kpi-label">OS abertas</span>
          </div>
          <div className="dashboard-kpi-value">{currentMetrics.abertasCount}</div>
          <div className="dashboard-kpi-sub">
            Ordens que foram criadas e ainda não concluídas.
          </div>
        </div>

        <div className="dashboard-kpi-card kpi-aguardando">
          <div className="dashboard-kpi-header">
            <span className="dashboard-kpi-icon">🟡</span>
            <span className="dashboard-kpi-label">Aguardando SANEAR</span>
          </div>
          <div className="dashboard-kpi-value">
            {currentMetrics.aguardandoSanearCount}
          </div>
          <div className="dashboard-kpi-sub">
            OS com dependência da SANEAR (SLA pausado enquanto aguardando).
          </div>
        </div>

        <div className="dashboard-kpi-card kpi-atrasadas">
          <div className="dashboard-kpi-header">
            <span className="dashboard-kpi-icon">⏱️</span>
            <span className="dashboard-kpi-label">OS atrasadas (72h)</span>
          </div>
          <div className="dashboard-kpi-value">{currentMetrics.osAtrasadas72hCount}</div>
          <div className="dashboard-kpi-sub">
            Abertas com tempo útil acima de 72h (descontando pausas do SLA).
          </div>
        </div>

        <div className="dashboard-kpi-card kpi-execucao">
          <div className="dashboard-kpi-header">
            <span className="dashboard-kpi-icon">🛣️</span>
            <span className="dashboard-kpi-label">{card2Label}</span>
          </div>
          <div className="dashboard-kpi-value">{card2Value}</div>
          <div className="dashboard-kpi-sub">{card2Sub}</div>
        </div>

        <div className="dashboard-kpi-card kpi-concluidas">
          <div className="dashboard-kpi-header">
            <span className="dashboard-kpi-icon">📈</span>
            <span className="dashboard-kpi-label">Concluídas últimos 7 dias</span>
          </div>
          <div className="dashboard-kpi-value">{currentMetrics.concluidas7dias}</div>
          <div className="dashboard-kpi-sub">
            Visão de produtividade recente considerando o período e a data final.
          </div>
        </div>

        <div className="dashboard-kpi-card kpi-terceirizada">
          <div className="dashboard-kpi-header">
            <span className="dashboard-kpi-icon">🏗️</span>
            <span className="dashboard-kpi-label">{card4Label}</span>
          </div>
          <div className="dashboard-kpi-value">{card4Value}</div>
          <div className="dashboard-kpi-sub">{card4Sub}</div>
        </div>
      </div>

      {/* GRÁFICOS BLOCO 1 */}
      <div className="dashboard-section">
        <div className="dashboard-charts-grid">

          <div
            className="dashboard-chart-card dashboard-chart-card--clickable"
            role="button"
            tabIndex={0}
            onClick={() => openExpanded(expandedConfigs.status)}
            onKeyDown={(e) => onCardKeyDown(e, expandedConfigs.status)}
            aria-label="Expandir gráfico OS por status"
          >
            <div className="dashboard-chart-header">
              <div>
                <h3>OS por status</h3>
                <p className="dashboard-chart-sub">
                  Distribuição das ordens entre abertas, aguardando SANEAR e concluídas
                  de acordo com a aba selecionada.
                </p>
              </div>
            </div>

            <div className="dashboard-chart-body">
              {renderStatusChart(CHART_HEIGHT_CARD)}
            </div>
          </div>

          <div
            className="dashboard-chart-card dashboard-chart-card--clickable"
            role="button"
            tabIndex={0}
            onClick={() => openExpanded(expandedConfigs.tipo)}
            onKeyDown={(e) => onCardKeyDown(e, expandedConfigs.tipo)}
            aria-label="Expandir gráfico OS por tipo de atendimento"
          >
            <div className="dashboard-chart-header">
              <div>
                <h3>OS por tipo de atendimento</h3>
                <p className="dashboard-chart-sub">
                  Classificação das ordens pelo tipo mais relevante para o setor
                  operacional.
                </p>
              </div>
            </div>
            <div className="dashboard-chart-body">
              {renderTipoChart(CHART_HEIGHT_CARD, "tipo-card")}
            </div>
          </div>
        </div>
      </div>

      {/* GRÁFICOS BLOCO 2 */}
      <div className="dashboard-section">
        {activeTab === "geral" ? (
          <div className="dashboard-charts-grid">
            <div
              className="dashboard-chart-card dashboard-chart-card--clickable"
              role="button"
              tabIndex={0}
              onClick={() => openExpanded(expandedConfigs.origem)}
              onKeyDown={(e) => onCardKeyDown(e, expandedConfigs.origem)}
              aria-label="Expandir gráfico Distribuição por origem"
            >
              <div className="dashboard-chart-header">
                <div>
                  <h3>Distribuição por origem</h3>
                  <p className="dashboard-chart-sub">
                    Quantidade de ordens criadas para Calçamento e Asfalto.
                  </p>
                </div>
              </div>
              <div className="dashboard-chart-body">
                {renderOrigemChart(CHART_HEIGHT_CARD)}
              </div>
            </div>

            <div
              className="dashboard-chart-card dashboard-chart-card--clickable dashboard-chart-prod7"
              role="button"
              tabIndex={0}
              onClick={() => openExpanded(expandedConfigs.prod)}
              onKeyDown={(e) => onCardKeyDown(e, expandedConfigs.prod)}
              aria-label="Expandir gráfico Produtividade últimos 7 dias"
            >
              <div className="dashboard-chart-header">
                <div>
                  <h3>Produtividade - últimos 7 dias</h3>
                  <p className="dashboard-chart-sub">
                    Quantidade de ordens concluídas por dia, considerando o período
                    e a data final como referência.
                  </p>
                </div>
              </div>
              <div className="dashboard-chart-body">
                {renderProdChart(CHART_HEIGHT_CARD, "prod-card")}
              </div>
            </div>
          </div>
        ) : (
          <div className="dashboard-charts-grid">
            <div
              className="dashboard-chart-card dashboard-chart-card--clickable dashboard-chart-prod7"
              role="button"
              tabIndex={0}
              onClick={() => openExpanded(expandedConfigs.prod)}
              onKeyDown={(e) => onCardKeyDown(e, expandedConfigs.prod)}
              aria-label="Expandir gráfico Produtividade últimos 7 dias"
              style={{ gridColumn: "1 / -1" }}
            >
              <div className="dashboard-chart-header">
                <div>
                  <h3>Produtividade - últimos 7 dias</h3>
                  <p className="dashboard-chart-sub">
                    Quantidade de ordens concluídas por dia, apenas deste serviço.
                  </p>
                </div>
              </div>
              <div className="dashboard-chart-body">
                {renderProdChart(CHART_HEIGHT_CARD, "prod-card-single")}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* BOTÃO DE IMPRESSÃO */}
      <div className="dashboard-print-container">
        <button
          type="button"
          className="dashboard-print-button"
          onClick={handlePrintDashboard}
        >
          🖨 Imprimir dashboard
        </button>
      </div>

      {/* MODAL EXPANDIDO */}
      {expandedCard && (
        <div className="dashboard-modal-backdrop" onClick={closeExpanded}>
          <div
            className="dashboard-expanded-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="dashboard-expanded-header">
              <div>
                <div className="dashboard-expanded-title">
                  {expandedCard.title}
                </div>
                <div className="dashboard-expanded-subtitle">
                  {expandedCard.subtitle}
                </div>
              </div>

              <div className="dashboard-expanded-controls">
                <div className="dashboard-expanded-dates">
                  <div className="dashboard-filter-field">
                    <span>Data inicial</span>
                    <input
                      type="date"
                      value={filterStartDate ?? ""}
                      onChange={(e) =>
                        setFilterStartDate(
                          e.target.value ? e.target.value : null
                        )
                      }
                    />
                  </div>
                  <div className="dashboard-filter-field">
                    <span>Data final</span>
                    <input
                      type="date"
                      value={filterEndDate ?? ""}
                      onChange={(e) =>
                        setFilterEndDate(e.target.value ? e.target.value : null)
                      }
                    />
                  </div>
                </div>

                <button
                  type="button"
                  className="dashboard-filter-clear"
                  onClick={handleClearFilter}
                >
                  Limpar
                </button>

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

            <div className="dashboard-expanded-body">{renderExpandedContent}</div>
          </div>
        </div>
      )}
    </section>
  );
};

export default Dashboard;