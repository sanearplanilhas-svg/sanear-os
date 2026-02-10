// src/lib/sla.ts
// Regras utilitárias de SLA para as OS (SANEAR)
// - SLA padrão: 72 horas (úteis/corridas conforme a tela calcular)
// - Pausas do SLA: tipo "SANEAR" (ex.: aguardando liberação/serviço da SANEAR)
//
// Observação importante (Firestore):
// - serverTimestamp() NÃO pode ser usado dentro de arrays.
// - Para registrar timestamps dentro de slaPausas, use Timestamp.now().

import { Timestamp } from "firebase/firestore";

export const SLA_HORAS_PADRAO = 72;
export const MS_POR_HORA = 60 * 60 * 1000;

export type SlaPausaTipo = "SANEAR" | string;

export type SlaPausa = {
  tipo: SlaPausaTipo;
  motivo?: string | null;
  descricao?: string | null;
  // Timestamp do Firestore (recomendado) ou Date (legado)
  inicioEm?: any;
  fimEm?: any | null;
};

function normTipo(v: any): string {
  return String(v || "").toUpperCase().trim();
}

export function isAguardandoSanear(status?: string | null): boolean {
  const s = normTipo(status);
  return s === "AGUARDANDO_SANEAR" || s === "AGUARDANDO SANEAR";
}

export function getSlaHoras(os: { slaHoras?: number | null } | null | undefined): number {
  const v = os?.slaHoras;
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  return SLA_HORAS_PADRAO;
}

export function hasOpenSanearPause(pausas?: SlaPausa[] | null): boolean {
  const arr = Array.isArray(pausas) ? pausas : [];
  for (let i = arr.length - 1; i >= 0; i--) {
    const p = arr[i];
    if (!p) continue;
    if (normTipo((p as any).tipo) !== "SANEAR") continue;
    if (!(p as any).fimEm) return true;
  }
  return false;
}

/**
 * Garante que exista UMA pausa ativa (fimEm null) do tipo SANEAR.
 * Se já houver uma pausa ativa, atualiza motivo/descrição.
 *
 * @param pausas array atual (pode ser null/undefined)
 * @param nova deve conter { tipo:"SANEAR", motivo, descricao, inicioEm?, fimEm? }
 *             - se inicioEm não vier, será Timestamp.now()
 *             - fimEm é forçado para null (pausa ativa)
 */
export function upsertSanearPause(pausas: SlaPausa[] | null | undefined, nova: SlaPausa): SlaPausa[] {
  const arr = [...(Array.isArray(pausas) ? pausas : [])];
  const now = Timestamp.now();

  const idx = (() => {
    for (let i = arr.length - 1; i >= 0; i--) {
      const p = arr[i];
      if (!p) continue;
      if (normTipo((p as any).tipo) !== "SANEAR") continue;
      if (!(p as any).fimEm) return i;
    }
    return -1;
  })();

  const inicioEm = (nova as any).inicioEm ?? now;

  if (idx >= 0) {
    const prev = arr[idx] as any;
    arr[idx] = {
      ...prev,
      tipo: "SANEAR",
      motivo: (nova as any).motivo ?? prev.motivo ?? null,
      descricao: (nova as any).descricao ?? prev.descricao ?? null,
      inicioEm: prev.inicioEm ?? inicioEm,
      fimEm: null,
    };
    return arr;
  }

  arr.push({
    tipo: "SANEAR",
    motivo: (nova as any).motivo ?? null,
    descricao: (nova as any).descricao ?? null,
    inicioEm,
    fimEm: null,
  });

  return arr;
}

/**
 * Encerra a última pausa ativa do tipo SANEAR (seta fimEm).
 * Se não houver pausa ativa, retorna o array sem alterações.
 *
 * @param pausas array atual (pode ser null/undefined)
 * @param fimEm timestamp (recomendado Timestamp.now()) – se não vier, Timestamp.now()
 */
export function closeSanearPause(pausas: SlaPausa[] | null | undefined, fimEm?: any): SlaPausa[] {
  const arr = [...(Array.isArray(pausas) ? pausas : [])];
  const idx = (() => {
    for (let i = arr.length - 1; i >= 0; i--) {
      const p = arr[i];
      if (!p) continue;
      if (normTipo((p as any).tipo) !== "SANEAR") continue;
      if (!(p as any).fimEm) return i;
    }
    return -1;
  })();

  if (idx === -1) return arr;

  const now = fimEm ?? Timestamp.now();
  const prev = arr[idx] as any;

  arr[idx] = {
    ...prev,
    fimEm: now,
  };

  return arr;
}
