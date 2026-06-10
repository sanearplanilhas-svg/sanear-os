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

// ===== PASSO 6 (consistência): helpers para pausa SANEAR =====

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
