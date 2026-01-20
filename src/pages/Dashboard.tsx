import React, { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot, orderBy, query } from "firebase/firestore";
import type { Timestamp } from "firebase/firestore";
import { db } from "../lib/firebaseClient";
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
};

type Metrics = {
  totalHoje: number; // aqui vira "total no período", mas mantive o nome
  abertasCount: number;
  concluidasHoje: number;
  concluidas7dias: number;
  concluidasTotal: number;
  canceladasCount: number;
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
    t.includes("CALCAMENTO") ||
    t.includes("PAVIMENTO") // opcional (se você usar algo assim)
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

// Agora o buildMetrics recebe também um período (start/end)
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

  let totalHoje = 0; // vai contar "total dentro do período"
  let abertasCount = 0;
  let concluidasTotal = 0;
  let canceladasCount = 0;
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

    // total dentro do período
    totalHoje++;

    const s = normalizeStatus(os.status);

    const isConcluida =
      s === "CONCLUIDA" || s === "CONCLUIDO" || s === "CONCLUÍDA";
    const isCancelada = s === "CANCELADA" || s === "CANCELADO";

    if (isConcluida) {
      concluidasTotal++;
    } else if (isCancelada) {
      canceladasCount++;
    } else {
      abertasCount++;
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
    { status: "Abertas", value: abertasCount, color: "#f97316" },
    { status: "Concluídas", value: concluidasTotal, color: "#22c55e" },
    { status: "Canceladas", value: canceladasCount, color: "#ef4444" },
  ];

  return {
    totalHoje,
    abertasCount,
    concluidasHoje,
    concluidas7dias,
    concluidasTotal,
    canceladasCount,
    resumoStatus,
    porTipoData,
    produtividade7dias,
  };
}

const Dashboard: React.FC = () => {
  // RAW por coleção
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
      if (!isNaN(d.getTime())) return d;
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
            // fallback buraco (porque veio da coleção de calçamento)
            origem: inferOrigem(data.tipo ?? null, "buraco"),
            tipo: data.tipo ?? null,
            status: data.status ?? null,
            createdAt: (data.createdAt as Timestamp | null) ?? null,
            dataExecucao: (data.dataExecucao as Timestamp | null) ?? null,
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
            // fallback asfalto (porque veio da coleção de asfalto)
            origem: inferOrigem(data.tipo ?? null, "asfalto"),
            tipo: data.tipo ?? null,
            status: data.status ?? null,
            createdAt: (data.createdAt as Timestamp | null) ?? null,
            dataExecucao: (data.dataExecucao as Timestamp | null) ?? null,
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

  // Junta tudo e separa pela origem inferida (corrige o problema do card)
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
    headerSubBase =
      "Total de ordens registradas dentro do período selecionado.";
  } else if (activeTab === "buraco") {
    headerTitle = "Calçamento";
    headerDesc =
      "Indicadores focados apenas nas ordens de Calçamento registradas no sistema.";
    headerLabel = "OS no período (Calçamento)";
    headerSubBase = "Ordens de Calçamento dentro do período configurado no filtro.";
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
    card4Sub = "Quantidade de ordens de Calçamento que ainda não foram concluídas.";
  } else if (activeTab === "buraco") {
    card4Label = "Total Calçamento";
    card4Value = ordensBuraco.length;
    card4Sub = "Total de ordens de Calçamento cadastradas no sistema.";
  } else {
    card4Label = "Total Asfalto";
    card4Value = ordensAsfalto.length;
    card4Sub = "Total de ordens de Asfalto cadastradas no sistema.";
  }

  // Card 2 dinâmico (Asfalto ou Calçamento em aberto)
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

  const handlePrint = () => {
    window.print();
  };

  const handleClearFilter = () => {
    setFilterStartDate(null);
    setFilterEndDate(null);
  };

  return (
    <section className="page-card dashboard-layout">

      {/* Cabeçalho do relatório (somente impressão) */}
      <div className="dashboard-print-header print-only">
        <div className="dashboard-print-title">Relatório Operacional — SANEAR</div>
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

      {/* TOOLBAR DO DASHBOARD (FILTRO + INDICAÇÃO DO PERÍODO) */}
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

      {/* Abinhas internas do dashboard */}
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

      {/* KPIs principais */}
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

        {/* Card 2 dinâmico: Asfalto ou Calçamento em aberto */}
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
          {/* Status */}
          <div className="dashboard-chart-card">
            <div className="dashboard-chart-header">
              <div>
                <h3>OS por status</h3>
                <p className="dashboard-chart-sub">
                  Distribuição das ordens entre abertas, concluídas e canceladas
                  de acordo com a aba selecionada.
                </p>
              </div>
            </div>

            <div className="dashboard-chart-body">
              <ResponsiveContainer width="100%" height={260}>
                <BarChart
                  data={resumoStatus}
                  margin={{ top: 10, right: 16, left: 0, bottom: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                  <XAxis dataKey="status" tick={{ fontSize: 11 }} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "#020617",
                      border: "1px solid #1f2937",
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="value" name="Quantidade">
                    {resumoStatus.map((entry) => (
                      <Cell key={entry.status} fill={entry.color} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Tipo */}
          <div className="dashboard-chart-card">
            <div className="dashboard-chart-header">
              <div>
                <h3>OS por tipo de atendimento</h3>
                <p className="dashboard-chart-sub">
                  Classificação das ordens pelo tipo mais relevante para o setor operacional.
                </p>
              </div>
            </div>
            <div className="dashboard-chart-body">
              <ResponsiveContainer width="100%" height={260}>
                <BarChart
                  data={porTipoData}
                  layout="vertical"
                  margin={{ top: 10, right: 16, left: 80, bottom: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                  <XAxis type="number" tick={{ fontSize: 11 }} allowDecimals={false} />
                  <YAxis type="category" dataKey="tipo" tick={{ fontSize: 11 }} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "#020617",
                      border: "1px solid #1f2937",
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                  />
                  <Bar dataKey="value" name="Quantidade" fill="url(#tipoGradient)" />
                  <defs>
                    <linearGradient id="tipoGradient" x1="0" y1="0" x2="1" y2="0">
                      <stop offset="0%" stopColor="#22c55e" />
                      <stop offset="100%" stopColor="#0ea5e9" />
                    </linearGradient>
                  </defs>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      </div>

      {/* GRÁFICOS BLOCO 2 */}
      <div className="dashboard-section">
        {activeTab === "geral" ? (
          <div className="dashboard-charts-grid">
            {/* Origem: Calçamento x Asfalto */}
            <div className="dashboard-chart-card">
              <div className="dashboard-chart-header">
                <div>
                  <h3>Distribuição por origem</h3>
                  <p className="dashboard-chart-sub">
                    Quantidade de ordens criadas para Calçamento e Asfalto.
                  </p>
                </div>
              </div>
              <div className="dashboard-chart-body">
                <ResponsiveContainer width="100%" height={260}>
                  <PieChart>
                    <Pie
                      data={origemData}
                      cx="50%"
                      cy="50%"
                      outerRadius={80}
                      innerRadius={45}
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
              </div>
            </div>

            {/* Produtividade 7 dias */}
            <div className="dashboard-chart-card">
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
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart
                    data={produtividade7dias}
                    margin={{ top: 10, right: 16, left: 0, bottom: 22 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                    <XAxis dataKey="dia" tick={{ fontSize: 11 }} interval={0} tickMargin={8} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "#020617",
                        border: "1px solid #1f2937",
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                    />
                    <Bar dataKey="concluidas" name="Concluídas" fill="url(#prodGradient)" barSize={34} minPointSize={2}>
                      <LabelList dataKey="concluidas" position="top" fontSize={11} />
                    </Bar>
                    <defs>
                      <linearGradient id="prodGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#22c55e" />
                        <stop offset="100%" stopColor="#166534" />
                      </linearGradient>
                    </defs>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        ) : (
          <div className="dashboard-charts-grid">
            <div className="dashboard-chart-card" style={{ gridColumn: "1 / -1" }}>
              <div className="dashboard-chart-header">
                <div>
                  <h3>Produtividade - últimos 7 dias</h3>
                  <p className="dashboard-chart-sub">
                    Quantidade de ordens concluídas por dia, apenas deste serviço.
                  </p>
                </div>
              </div>
              <div className="dashboard-chart-body">
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart
                    data={produtividade7dias}
                    margin={{ top: 10, right: 16, left: 0, bottom: 22 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                    <XAxis dataKey="dia" tick={{ fontSize: 11 }} interval={0} tickMargin={8} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "#020617",
                        border: "1px solid #1f2937",
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                    />
                    <Bar dataKey="concluidas" name="Concluídas" fill="url(#prodGradient)" barSize={34} minPointSize={2}>
                      <LabelList dataKey="concluidas" position="top" fontSize={11} />
                    </Bar>
                    <defs>
                      <linearGradient id="prodGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#22c55e" />
                        <stop offset="100%" stopColor="#166534" />
                      </linearGradient>
                    </defs>
                  </BarChart>
                </ResponsiveContainer>
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
          onClick={handlePrint}
        >
          🖨 Imprimir dashboard
        </button>
      </div>
    </section>
  );
};

export default Dashboard;
