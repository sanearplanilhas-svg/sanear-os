// src/lib/sla.ts
import type { Timestamp } from "firebase/firestore";

export const SLA_HORAS_PADRAO = 72;
export const MS_POR_HORA = 60 * 60 * 1000;

export type SlaPausaTipo = "SANEAR";

export type SlaPausa = {
  tipo: SlaPausaTipo; // "SANEAR"
  motivo: string; // código curto (ex.: "SERVICO_PREVIO", "BLOQUEIO_ACESSO"...)
  descricao: string; // texto curto do usuário
  inicioEm: Timestamp | Date;
  fimEm?: Timestamp | Date | null;
};

export type SlaServicoKey =
  | "CALCAMENTO"
  | "ASFALTO"
  | "HIDROJATO"
  | "ESGOTO_ENTUPIDO"
  | "ESGOTO_RETORNANDO"
  | "PADRAO";

export type SlaPrioridade = "BAIXA" | "NORMAL" | "ALTA" | "CRITICA";

export type SlaServicoConfig = {
  key: SlaServicoKey;
  label: string;
  horas: number;
  prioridade: SlaPrioridade;
  areaResponsavel: "TERCEIRIZADA" | "SERVICO_SANEAR" | "IMPLANTACAO";
  descricao: string;
};

/**
 * Prazos iniciais por serviço.
 * Ajuste estes valores aqui se a regra interna do SANEAR mudar.
 */
export const SLA_CONFIGS: Record<SlaServicoKey, SlaServicoConfig> = {
  CALCAMENTO: {
    key: "CALCAMENTO",
    label: "Calçamento",
    horas: 72,
    prioridade: "NORMAL",
    areaResponsavel: "TERCEIRIZADA",
    descricao: "Reposição de calçamento / buraco na rua",
  },
  ASFALTO: {
    key: "ASFALTO",
    label: "Asfalto",
    horas: 96,
    prioridade: "NORMAL",
    areaResponsavel: "TERCEIRIZADA",
    descricao: "Serviço de asfalto / tapa-buraco",
  },
  HIDROJATO: {
    key: "HIDROJATO",
    label: "Caminhão Hidrojato",
    horas: 24,
    prioridade: "ALTA",
    areaResponsavel: "SERVICO_SANEAR",
    descricao: "Atendimento interno com caminhão hidrojato",
  },
  ESGOTO_ENTUPIDO: {
    key: "ESGOTO_ENTUPIDO",
    label: "Esgoto Entupido",
    horas: 24,
    prioridade: "ALTA",
    areaResponsavel: "IMPLANTACAO",
    descricao: "Ocorrência de esgoto entupido",
  },
  ESGOTO_RETORNANDO: {
    key: "ESGOTO_RETORNANDO",
    label: "Esgoto Retornando",
    horas: 12,
    prioridade: "CRITICA",
    areaResponsavel: "IMPLANTACAO",
    descricao: "Ocorrência crítica de retorno de esgoto",
  },
  PADRAO: {
    key: "PADRAO",
    label: "Serviço padrão",
    horas: SLA_HORAS_PADRAO,
    prioridade: "NORMAL",
    areaResponsavel: "IMPLANTACAO",
    descricao: "Prazo padrão para serviços sem regra específica",
  },
};

function normalizeText(value: unknown): string {
  return String(value ?? "")
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[\s\-/]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function normalizeSlaServico(value: unknown, fallback?: unknown): SlaServicoKey {
  const values = [value, fallback].map(normalizeText).filter(Boolean);

  for (const current of values) {
    if (
      current === "CALCAMENTO" ||
      current === "BURACO_RUA" ||
      current === "BURACO" ||
      current === "BURACO_NA_RUA" ||
      current === "CALCADA" ||
      current === "CALCADAS" ||
      current === "REPOSICAO_CALCAMENTO"
    ) {
      return "CALCAMENTO";
    }

    if (current === "ASFALTO" || current === "TAPA_BURACO" || current === "PAVIMENTACAO") {
      return "ASFALTO";
    }

    if (
      current === "HIDROJATO" ||
      current === "CAMINHAO_HIDROJATO" ||
      current === "CAMINHAO" ||
      current === "SERVICO_SANEAR"
    ) {
      return "HIDROJATO";
    }

    if (current === "ESGOTO_ENTUPIDO" || current === "ENTUPIDO") {
      return "ESGOTO_ENTUPIDO";
    }

    if (current === "ESGOTO_RETORNANDO" || current === "RETORNANDO" || current === "RETORNO_ESGOTO") {
      return "ESGOTO_RETORNANDO";
    }
  }

  return "PADRAO";
}

export function getSlaConfig(servico: unknown, fallback?: unknown): SlaServicoConfig {
  return SLA_CONFIGS[normalizeSlaServico(servico, fallback)] ?? SLA_CONFIGS.PADRAO;
}

export function getSlaHorasPorServico(servico: unknown, fallback?: unknown): number {
  return getSlaConfig(servico, fallback).horas;
}

export function formatSlaResumo(servico: unknown, fallback?: unknown): string {
  const config = getSlaConfig(servico, fallback);
  return `${config.label}: ${config.horas} horas úteis`;
}

export function getSlaConfigFromOrder(os: {
  slaServico?: unknown;
  servico?: unknown;
  tipo?: unknown;
  origem?: unknown;
  moduleKey?: unknown;
  areaExecucao?: unknown;
}): SlaServicoConfig {
  return getSlaConfig(
    os.slaServico ?? os.servico ?? os.tipo ?? os.origem ?? os.moduleKey,
    os.areaExecucao
  );
}

/**
 * Retorna o SLA real da OS.
 * Quando a OS antiga possui 72h apenas por padrão, recalcula pelo serviço para aplicar a nova regra.
 * Se algum dia houver SLA manual diferente do padrão antigo, ele é respeitado.
 */
export function getSlaHorasFromOrder(os: {
  slaHoras?: number | null;
  slaServico?: unknown;
  servico?: unknown;
  tipo?: unknown;
  origem?: unknown;
  moduleKey?: unknown;
  areaExecucao?: unknown;
}): number {
  const config = getSlaConfigFromOrder(os);
  const explicit = os.slaHoras;

  if (typeof explicit === "number" && explicit > 0 && explicit !== SLA_HORAS_PADRAO) {
    return explicit;
  }

  return config.horas;
}

export function getSlaPercentualConsumido(params: {
  horasUtil: number;
  slaHoras: number;
}): number {
  if (!Number.isFinite(params.horasUtil) || !Number.isFinite(params.slaHoras) || params.slaHoras <= 0) {
    return 0;
  }

  return Math.max(0, Math.round((params.horasUtil / params.slaHoras) * 100));
}

export function getSlaFaixa(params: {
  horasUtil: number;
  slaHoras: number;
  pausada?: boolean;
}): "DENTRO" | "ATENCAO" | "ATRASADA" | "PAUSADA" {
  if (params.pausada) return "PAUSADA";
  if (params.horasUtil > params.slaHoras) return "ATRASADA";
  if (params.horasUtil >= params.slaHoras * 0.75) return "ATENCAO";
  return "DENTRO";
}

function toDate(value: Timestamp | Date | null | undefined): Date | null {
  if (!value) return null;
  // Timestamp do Firestore tem .toDate()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyValue: any = value;
  if (typeof anyValue?.toDate === "function") return anyValue.toDate() as Date;
  if (value instanceof Date) return value;
  return null;
}

export function getSlaHoras(os: { slaHoras?: number | null }): number {
  const v = os?.slaHoras;
  return typeof v === "number" && v > 0 ? v : SLA_HORAS_PADRAO;
}

export function calcPausadoMs(
  pausas: SlaPausa[] | null | undefined,
  agora: Date = new Date()
): number {
  if (!pausas || pausas.length === 0) return 0;

  let total = 0;

  for (const p of pausas) {
    const ini = toDate(p.inicioEm);
    const fim = toDate(p.fimEm ?? null) ?? agora;

    if (!ini) continue;

    const ms = fim.getTime() - ini.getTime();
    if (ms > 0) total += ms;
  }

  return total;
}

export function calcTempoUtilMs(params: {
  createdAt: Timestamp | Date | null | undefined;
  pausas?: SlaPausa[] | null;
  agora?: Date;
}): number {
  const agora = params.agora ?? new Date();
  const created = toDate(params.createdAt);

  if (!created) return 0;

  const decorrido = agora.getTime() - created.getTime();
  const pausado = calcPausadoMs(params.pausas, agora);

  const util = decorrido - pausado;
  return util > 0 ? util : 0;
}

export function calcAtraso(params: {
  slaHoras: number;
  createdAt: Timestamp | Date | null | undefined;
  pausas?: SlaPausa[] | null;
  agora?: Date;
}): { estaAtrasada: boolean; horasUtil: number } {
  const agora = params.agora ?? new Date();
  const utilMs = calcTempoUtilMs({
    createdAt: params.createdAt,
    pausas: params.pausas ?? null,
    agora,
  });

  const horasUtil = utilMs / MS_POR_HORA;
  return { estaAtrasada: horasUtil > params.slaHoras, horasUtil };
}

// ===== Helpers para pausa SANEAR =====

export function upsertSanearPause(
  pausas: any[] | null | undefined,
  data: { motivo: string; descricao: string; inicioEm: any }
): any[] {
  const arr = Array.isArray(pausas) ? [...pausas] : [];
  const idx = arr.findIndex((p) => p?.tipo === "SANEAR" && !p?.fimEm);

  // Se já existe pausa SANEAR ativa, apenas atualiza motivo/descrição (idempotente)
  if (idx >= 0) {
    arr[idx] = {
      ...arr[idx],
      motivo: data.motivo,
      descricao: data.descricao,
    };
    return arr;
  }

  // Se não existe, cria uma nova pausa ativa
  arr.push({
    tipo: "SANEAR",
    motivo: data.motivo,
    descricao: data.descricao,
    inicioEm: data.inicioEm,
    fimEm: null,
  });

  return arr;
}

export function closeSanearPause(
  pausas: any[] | null | undefined,
  fimEm: any
): any[] {
  const arr = Array.isArray(pausas) ? [...pausas] : [];
  const idx = arr.findIndex((p) => p?.tipo === "SANEAR" && !p?.fimEm);
  if (idx >= 0) {
    arr[idx] = { ...arr[idx], fimEm };
  }
  return arr;
}

export function hasOpenSanearPause(pausas: any[] | null | undefined): boolean {
  return Array.isArray(pausas) && pausas.some((p) => p?.tipo === "SANEAR" && !p?.fimEm);
}
