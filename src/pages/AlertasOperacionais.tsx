import { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot, query } from "firebase/firestore";
import type { Timestamp } from "firebase/firestore";

import { AppButton, AppPagination, StatusBadge } from "../components/ui";
import { db } from "../lib/firebaseClient";
import { MS_POR_HORA, getSlaConfigFromOrder, getSlaHorasFromOrder } from "../lib/sla";
import type { SlaPausa } from "../lib/sla";
import {
  isOrdemAguardandoSanear,
  isOrdemConcluida,
  isOrdemFechada,
  normalizeOrdemStatus,
} from "../lib/status";

type OrdemCollection = "ordens_servico" | "ordensServico" | "ordensHidrojato";
type OrdemModulo = "CALCAMENTO" | "ASFALTO" | "HIDROJATO";
type AlertSeverity = "critico" | "atencao" | "informativo";
type AlertCategory = "SLA" | "SANEAR" | "ANEXO" | "REABERTURA" | "COMPROVANTE";
type AlertFilter = "todos" | AlertSeverity | AlertCategory;

type OrdemOperacional = {
  id: string;
  collectionName: OrdemCollection;
  modulo: OrdemModulo;
  moduloLabel: string;
  status: string | null;
  createdAt: Timestamp | Date | string | number | null;
  updatedAt: Timestamp | Date | string | number | null;
  dataExecucao: Timestamp | Date | string | number | null;
  protocolo: string | null;
  ordemServico: string | null;
  bairro: string | null;
  rua: string | null;
  numero: string | null;
  pontoReferencia: string | null;
  observacoes: string | null;
  tipo: string | null;
  slaServico: string | null;
  slaHoras: number | null;
  slaLabel: string | null;
  slaPausas: SlaPausa[];
  ordemServicoPdfUrl: string | null;
  ordemServicoPdf: unknown;
  ordemServicoPdfStatus: string | null;
  anexoStatus: string | null;
  anexosPendentes: unknown;
  fotosExecucao: unknown[];
  historicoExecucoes: unknown[];
};

type AlertaOperacional = {
  id: string;
  categoria: AlertCategory;
  severidade: AlertSeverity;
  titulo: string;
  descricao: string;
  recomendacao: string;
  os: OrdemOperacional;
  idadeHoras: number | null;
  slaHoras: number | null;
  percentualSla: number | null;
  ordenacao: number;
};

const PAGE_SIZE = 10;

const COLLECTIONS: Array<{
  name: OrdemCollection;
  modulo: OrdemModulo;
  label: string;
}> = [
  { name: "ordens_servico", modulo: "CALCAMENTO", label: "Calçamento" },
  { name: "ordensServico", modulo: "ASFALTO", label: "Asfalto" },
  { name: "ordensHidrojato", modulo: "HIDROJATO", label: "Caminhão Hidrojato" },
];

const FILTERS: Array<{ key: AlertFilter; label: string }> = [
  { key: "todos", label: "Todos" },
  { key: "critico", label: "Críticos" },
  { key: "atencao", label: "Atenção" },
  { key: "SLA", label: "SLA" },
  { key: "SANEAR", label: "Aguardando SANEAR" },
  { key: "ANEXO", label: "Anexos" },
  { key: "REABERTURA", label: "Reabertas" },
  { key: "COMPROVANTE", label: "Comprovantes" },
];

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

function normalizeText(value: unknown): string {
  return String(value ?? "")
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
}

function formatHours(hours: number | null): string {
  if (hours === null || !Number.isFinite(hours)) return "-";
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  return `${Math.round(hours)}h`;
}

function formatDateTime(value: unknown): string {
  const date = toDate(value);
  if (!date) return "-";

  return date.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getNumeroOs(os: OrdemOperacional): string {
  return os.ordemServico || os.protocolo || os.id.slice(0, 8).toUpperCase();
}

function getEndereco(os: OrdemOperacional): string {
  const ruaNumero = [os.rua, os.numero].filter(Boolean).join(", ");
  return [os.bairro, ruaNumero].filter(Boolean).join(" • ") || "Local não informado";
}

function getPdfUrlFromLegacyValue(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const maybe = value as { url?: unknown; publicUrl?: unknown; downloadUrl?: unknown };
  return stringOrNull(maybe.url) ?? stringOrNull(maybe.publicUrl) ?? stringOrNull(maybe.downloadUrl);
}

function hasPdf(os: OrdemOperacional): boolean {
  return Boolean(os.ordemServicoPdfUrl || getPdfUrlFromLegacyValue(os.ordemServicoPdf));
}

function hasPendingAttachment(os: OrdemOperacional): boolean {
  const anexoStatus = normalizeText(os.anexoStatus);
  const pdfStatus = normalizeText(os.ordemServicoPdfStatus);
  const pendenteFlag = Boolean(os.anexosPendentes);

  return (
    pendenteFlag ||
    anexoStatus === "PENDENTE" ||
    anexoStatus === "ERRO" ||
    anexoStatus === "PENDENTE_UPLOAD" ||
    pdfStatus === "PENDENTE" ||
    pdfStatus === "ERRO" ||
    pdfStatus === "PENDENTE_UPLOAD"
  );
}

function getActiveSanearPauseHours(os: OrdemOperacional, referenceDate: Date): number | null {
  const activePause = os.slaPausas.find((pause) => pause?.tipo === "SANEAR" && !pause?.fimEm);
  if (!activePause) return null;

  const start = toDate(activePause.inicioEm);
  if (!start) return null;

  return Math.max(0, (referenceDate.getTime() - start.getTime()) / MS_POR_HORA);
}

function getActiveHours(os: OrdemOperacional, referenceDate: Date): number {
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

function getSeverityWeight(severity: AlertSeverity): number {
  if (severity === "critico") return 3;
  if (severity === "atencao") return 2;
  return 1;
}

function getSeverityLabel(severity: AlertSeverity): string {
  if (severity === "critico") return "Crítico";
  if (severity === "atencao") return "Atenção";
  return "Informativo";
}

function getCategoryLabel(category: AlertCategory): string {
  const labels: Record<AlertCategory, string> = {
    SLA: "SLA",
    SANEAR: "SANEAR",
    ANEXO: "Anexo",
    REABERTURA: "Reabertura",
    COMPROVANTE: "Comprovante",
  };
  return labels[category];
}

function buildAlertId(os: OrdemOperacional, category: AlertCategory, suffix: string): string {
  return `${os.collectionName}-${os.id}-${category}-${suffix}`;
}

function buildAlerts(ordens: OrdemOperacional[], referenceDate: Date): AlertaOperacional[] {
  const alerts: AlertaOperacional[] = [];

  for (const os of ordens) {
    const status = normalizeOrdemStatus(os.status);
    const closed = isOrdemFechada(status);
    const concluded = isOrdemConcluida(status);
    const aguardandoSanear = isOrdemAguardandoSanear(status);
    const slaConfig = getSlaConfigFromOrder(os);
    const slaHoras = getSlaHorasFromOrder(os);
    const activeHours = getActiveHours(os, referenceDate);
    const percent = slaHoras > 0 ? Math.round((activeHours / slaHoras) * 100) : null;
    const titleNumber = getNumeroOs(os);

    if (!closed && activeHours > slaHoras) {
      alerts.push({
        id: buildAlertId(os, "SLA", "atrasada"),
        categoria: "SLA",
        severidade: "critico",
        titulo: `OS ${titleNumber} fora do prazo`,
        descricao: `${os.moduloLabel} está com ${formatHours(activeHours)} de prazo consumido. Regra atual: ${slaConfig.label} (${slaHoras}h).`,
        recomendacao: aguardandoSanear
          ? "Verificar a pendência interna da SANEAR antes de cobrar a execução."
          : "Priorizar atendimento ou cobrança da equipe responsável.",
        os,
        idadeHoras: activeHours,
        slaHoras,
        percentualSla: percent,
        ordenacao: getSeverityWeight("critico") * 1_000_000 + activeHours,
      });
    } else if (!closed && !aguardandoSanear && activeHours >= slaHoras * 0.75) {
      alerts.push({
        id: buildAlertId(os, "SLA", "atencao"),
        categoria: "SLA",
        severidade: "atencao",
        titulo: `OS ${titleNumber} próxima do vencimento`,
        descricao: `${os.moduloLabel} já consumiu ${formatHours(activeHours)} de ${slaHoras}h previstas (${percent ?? 0}%).`,
        recomendacao: "Acompanhar antes de virar atraso.",
        os,
        idadeHoras: activeHours,
        slaHoras,
        percentualSla: percent,
        ordenacao: getSeverityWeight("atencao") * 1_000_000 + activeHours,
      });
    }

    if (!closed && aguardandoSanear) {
      const pauseHours = getActiveSanearPauseHours(os, referenceDate) ?? activeHours;
      const severity: AlertSeverity = pauseHours >= 48 ? "critico" : pauseHours >= 24 ? "atencao" : "informativo";
      alerts.push({
        id: buildAlertId(os, "SANEAR", "aguardando"),
        categoria: "SANEAR",
        severidade: severity,
        titulo: `OS ${titleNumber} aguardando ação da SANEAR`,
        descricao: `A OS está pausada/aguardando liberação interna há ${formatHours(pauseHours)}.`,
        recomendacao: "Resolver a pendência interna para liberar a execução ou registrar nova orientação.",
        os,
        idadeHoras: pauseHours,
        slaHoras,
        percentualSla: percent,
        ordenacao: getSeverityWeight(severity) * 1_000_000 + pauseHours,
      });
    }

    if (!closed && !hasPdf(os)) {
      alerts.push({
        id: buildAlertId(os, "ANEXO", "sem-pdf"),
        categoria: "ANEXO",
        severidade: "atencao",
        titulo: `OS ${titleNumber} sem PDF da ordem`,
        descricao: "A ordem está cadastrada sem PDF disponível para conferência.",
        recomendacao: "Verificar Anexos Pendentes ou reenviar o PDF da OS.",
        os,
        idadeHoras: activeHours,
        slaHoras,
        percentualSla: percent,
        ordenacao: getSeverityWeight("atencao") * 1_000_000 + activeHours,
      });
    }

    if (!closed && hasPendingAttachment(os)) {
      alerts.push({
        id: buildAlertId(os, "ANEXO", "pendente"),
        categoria: "ANEXO",
        severidade: "atencao",
        titulo: `OS ${titleNumber} com anexo pendente`,
        descricao: "Existe PDF ou foto aguardando reenvio/regularização.",
        recomendacao: "Abrir a tela Anexos Pendentes e reenviar o arquivo pelo aparelho onde ele ficou salvo.",
        os,
        idadeHoras: activeHours,
        slaHoras,
        percentualSla: percent,
        ordenacao: getSeverityWeight("atencao") * 1_000_000 + activeHours,
      });
    }

    if (!closed && os.historicoExecucoes.length > 0) {
      alerts.push({
        id: buildAlertId(os, "REABERTURA", "aberta"),
        categoria: "REABERTURA",
        severidade: "informativo",
        titulo: `OS ${titleNumber} foi reaberta`,
        descricao: "A OS possui execução anterior arquivada no histórico e está disponível novamente.",
        recomendacao: "Acompanhar para garantir nova finalização e novo comprovante, se necessário.",
        os,
        idadeHoras: activeHours,
        slaHoras,
        percentualSla: percent,
        ordenacao: getSeverityWeight("informativo") * 1_000_000 + activeHours,
      });
    }

    if (concluded && os.modulo !== "HIDROJATO" && os.fotosExecucao.length === 0) {
      alerts.push({
        id: buildAlertId(os, "COMPROVANTE", "sem-foto"),
        categoria: "COMPROVANTE",
        severidade: "atencao",
        titulo: `OS ${titleNumber} concluída sem foto`,
        descricao: "A OS está concluída, mas não possui foto de execução da terceirizada.",
        recomendacao: "Conferir se a finalização foi feita corretamente ou se o comprovante ficou pendente.",
        os,
        idadeHoras: null,
        slaHoras,
        percentualSla: null,
        ordenacao: getSeverityWeight("atencao") * 1_000_000,
      });
    }
  }

  return alerts.sort((a, b) => {
    if (b.ordenacao !== a.ordenacao) return b.ordenacao - a.ordenacao;
    return getNumeroOs(a.os).localeCompare(getNumeroOs(b.os), "pt-BR");
  });
}

function convertDocToOrder(
  id: string,
  data: Record<string, unknown>,
  config: { name: OrdemCollection; modulo: OrdemModulo; label: string }
): OrdemOperacional {
  const rawFotos = data.fotosExecucao;
  const rawHistorico = data.historicoExecucoes;
  const rawPausas = data.slaPausas;

  return {
    id,
    collectionName: config.name,
    modulo: config.modulo,
    moduloLabel: config.label,
    status: stringOrNull(data.status),
    createdAt: (data.createdAt as OrdemOperacional["createdAt"]) ?? null,
    updatedAt: (data.updatedAt as OrdemOperacional["updatedAt"]) ?? null,
    dataExecucao: (data.dataExecucao as OrdemOperacional["dataExecucao"]) ?? null,
    protocolo: stringOrNull(data.protocolo),
    ordemServico: stringOrNull(data.ordemServico ?? data.numeroOS ?? data.os),
    bairro: stringOrNull(data.bairro),
    rua: stringOrNull(data.rua ?? data.logradouro),
    numero: stringOrNull(data.numero),
    pontoReferencia: stringOrNull(data.pontoReferencia),
    observacoes: stringOrNull(data.observacoes),
    tipo: stringOrNull(data.tipo),
    slaServico: stringOrNull(data.slaServico),
    slaHoras: typeof data.slaHoras === "number" ? data.slaHoras : null,
    slaLabel: stringOrNull(data.slaLabel),
    slaPausas: Array.isArray(rawPausas) ? (rawPausas as SlaPausa[]) : [],
    ordemServicoPdfUrl: stringOrNull(data.ordemServicoPdfUrl),
    ordemServicoPdf: data.ordemServicoPdf,
    ordemServicoPdfStatus: stringOrNull(data.ordemServicoPdfStatus),
    anexoStatus: stringOrNull(data.anexoStatus),
    anexosPendentes: data.anexosPendentes,
    fotosExecucao: Array.isArray(rawFotos) ? rawFotos : [],
    historicoExecucoes: Array.isArray(rawHistorico) ? rawHistorico : [],
  };
}

export default function AlertasOperacionais() {
  const [ordens, setOrdens] = useState<OrdemOperacional[]>([]);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [filter, setFilter] = useState<AlertFilter>("todos");
  const [busca, setBusca] = useState("");
  const [currentPage, setCurrentPage] = useState(1);

  useEffect(() => {
    setLoading(true);
    setErro(null);

    const dataMap = new Map<OrdemCollection, OrdemOperacional[]>();

    const emit = () => {
      const merged = COLLECTIONS.flatMap((config) => dataMap.get(config.name) ?? []);
      setOrdens(merged);
      setLoading(false);
    };

    const unsubscribes = COLLECTIONS.map((config) => {
      const q = query(collection(db, config.name));
      return onSnapshot(
        q,
        (snapshot) => {
          dataMap.set(
            config.name,
            snapshot.docs.map((docSnap) => convertDocToOrder(docSnap.id, docSnap.data(), config))
          );
          emit();
        },
        (error) => {
          console.error(`Erro ao carregar ${config.name}:`, error);
          setErro("Não foi possível carregar os alertas operacionais.");
          setLoading(false);
        }
      );
    });

    return () => {
      unsubscribes.forEach((unsubscribe) => unsubscribe());
    };
  }, []);

  useEffect(() => {
    setCurrentPage(1);
  }, [filter, busca]);

  const referenceDate = useMemo(() => new Date(), []);

  const alertas = useMemo(() => buildAlerts(ordens, referenceDate), [ordens, referenceDate]);

  const filteredAlerts = useMemo(() => {
    const termo = normalizeText(busca);

    return alertas.filter((alerta) => {
      const matchesFilter =
        filter === "todos" ||
        alerta.severidade === filter ||
        alerta.categoria === filter;

      if (!matchesFilter) return false;
      if (!termo) return true;

      const searchable = normalizeText([
        alerta.titulo,
        alerta.descricao,
        alerta.recomendacao,
        alerta.os.moduloLabel,
        alerta.os.status,
        alerta.os.ordemServico,
        alerta.os.protocolo,
        alerta.os.bairro,
        alerta.os.rua,
        alerta.os.numero,
        alerta.os.observacoes,
      ].filter(Boolean).join(" "));

      return searchable.includes(termo);
    });
  }, [alertas, busca, filter]);

  const totalPages = Math.max(1, Math.ceil(filteredAlerts.length / PAGE_SIZE));
  const safeCurrentPage = Math.min(currentPage, totalPages);
  const pageStartIndex = filteredAlerts.length === 0 ? 0 : (safeCurrentPage - 1) * PAGE_SIZE;
  const pageEndIndex = Math.min(pageStartIndex + PAGE_SIZE, filteredAlerts.length);
  const pageAlerts = filteredAlerts.slice(pageStartIndex, pageEndIndex);

  const summary = useMemo(() => {
    return {
      total: alertas.length,
      criticos: alertas.filter((alerta) => alerta.severidade === "critico").length,
      atencao: alertas.filter((alerta) => alerta.severidade === "atencao").length,
      sanear: alertas.filter((alerta) => alerta.categoria === "SANEAR").length,
      anexos: alertas.filter((alerta) => alerta.categoria === "ANEXO").length,
    };
  }, [alertas]);

  function abrirOs(alerta: AlertaOperacional) {
    window.sessionStorage.setItem(
      "sanear-open-os",
      JSON.stringify({ id: alerta.os.id, col: alerta.os.collectionName })
    );

    window.dispatchEvent(
      new CustomEvent("sanear:navigate", {
        detail: { menu: "listaOS" },
      })
    );
  }

  function abrirAnexosPendentes() {
    window.dispatchEvent(
      new CustomEvent("sanear:navigate", {
        detail: { menu: "anexos_pendentes" },
      })
    );
  }

  return (
    <section className="page-card alertas-page">
      <div className="page-header alertas-header">
        <div>
          <p className="alertas-eyebrow">Central operacional</p>
          <h2>Alertas Operacionais</h2>
          <p className="page-section-description">
            Pendências críticas de prazo, SANEAR, anexos, reaberturas e comprovantes de execução.
          </p>
        </div>

        <div className="alertas-header-actions">
          <AppButton variant="secondary" onClick={abrirAnexosPendentes}>
            Ver anexos pendentes
          </AppButton>
        </div>
      </div>

      <div className="alertas-summary-grid">
        <div className="alertas-summary-card alertas-summary-total">
          <span>Total de alertas</span>
          <strong>{summary.total}</strong>
          <small>Itens encontrados na operação</small>
        </div>
        <div className="alertas-summary-card alertas-summary-danger">
          <span>Críticos</span>
          <strong>{summary.criticos}</strong>
          <small>Ação prioritária</small>
        </div>
        <div className="alertas-summary-card alertas-summary-warning">
          <span>Em atenção</span>
          <strong>{summary.atencao}</strong>
          <small>Evitar virar atraso</small>
        </div>
        <div className="alertas-summary-card alertas-summary-info">
          <span>Aguardando SANEAR</span>
          <strong>{summary.sanear}</strong>
          <small>Pendência interna</small>
        </div>
        <div className="alertas-summary-card alertas-summary-attachment">
          <span>Anexos</span>
          <strong>{summary.anexos}</strong>
          <small>PDF/foto pendente</small>
        </div>
      </div>

      <div className="alertas-toolbar">
        <div className="alertas-filter-tabs" role="tablist" aria-label="Filtro de alertas">
          {FILTERS.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`alertas-filter-tab ${filter === item.key ? "is-active" : ""}`}
              onClick={() => setFilter(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>

        <input
          className="alertas-search"
          type="search"
          value={busca}
          onChange={(event) => setBusca(event.target.value)}
          placeholder="Buscar por OS, bairro, rua, serviço ou alerta"
        />
      </div>

      {erro && <div className="alertas-error">{erro}</div>}

      {loading ? (
        <div className="app-empty-state alertas-loading">
          <strong>Carregando alertas...</strong>
          <span>Conferindo prazos, anexos e pendências das ordens.</span>
        </div>
      ) : filteredAlerts.length === 0 ? (
        <div className="app-empty-state alertas-empty">
          <strong>Nenhum alerta encontrado.</strong>
          <span>Não há pendências para o filtro atual.</span>
        </div>
      ) : (
        <>
          <AppPagination
            currentPage={safeCurrentPage}
            totalPages={totalPages}
            totalItems={filteredAlerts.length}
            pageStart={pageStartIndex + 1}
            pageEnd={pageEndIndex}
            onPageChange={setCurrentPage}
            label="alertas"
          />

          <div className="alertas-list">
            {pageAlerts.map((alerta) => (
              <article
                key={alerta.id}
                className={`alerta-card alerta-card-${alerta.severidade}`}
              >
                <div className="alerta-card-main">
                  <div className="alerta-card-topline">
                    <span className={`alerta-severity alerta-severity-${alerta.severidade}`}>
                      {getSeverityLabel(alerta.severidade)}
                    </span>
                    <span className="alerta-category">{getCategoryLabel(alerta.categoria)}</span>
                    <span className="alerta-service">{alerta.os.moduloLabel}</span>
                  </div>

                  <h3>{alerta.titulo}</h3>
                  <p>{alerta.descricao}</p>

                  <div className="alerta-recomendacao">
                    <strong>Ação recomendada:</strong> {alerta.recomendacao}
                  </div>

                  <div className="alerta-meta-grid">
                    <div>
                      <span>OS</span>
                      <strong>{getNumeroOs(alerta.os)}</strong>
                    </div>
                    <div>
                      <span>Status</span>
                      <StatusBadge status={alerta.os.status} />
                    </div>
                    <div>
                      <span>Local</span>
                      <strong>{getEndereco(alerta.os)}</strong>
                    </div>
                    <div>
                      <span>Criada em</span>
                      <strong>{formatDateTime(alerta.os.createdAt)}</strong>
                    </div>
                    <div>
                      <span>Tempo útil</span>
                      <strong>{formatHours(alerta.idadeHoras)}</strong>
                    </div>
                    <div>
                      <span>SLA</span>
                      <strong>
                        {alerta.slaHoras ? `${alerta.slaHoras}h` : "-"}
                        {alerta.percentualSla !== null ? ` • ${alerta.percentualSla}%` : ""}
                      </strong>
                    </div>
                  </div>
                </div>

                <div className="alerta-card-actions">
                  <AppButton variant="primary" onClick={() => abrirOs(alerta)}>
                    Abrir OS
                  </AppButton>
                  {alerta.categoria === "ANEXO" && (
                    <AppButton variant="secondary" onClick={abrirAnexosPendentes}>
                      Anexos
                    </AppButton>
                  )}
                </div>
              </article>
            ))}
          </div>

          <AppPagination
            currentPage={safeCurrentPage}
            totalPages={totalPages}
            totalItems={filteredAlerts.length}
            onPageChange={setCurrentPage}
            variant="bottom"
            label="alertas"
          />
        </>
      )}
    </section>
  );
}
