export type OrdemStatusCanonical =
  | "ABERTA"
  | "EM_ANDAMENTO"
  | "AGUARDANDO_SANEAR"
  | "CONCLUIDA"
  | "CANCELADA";

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

/**
 * Converte status antigos/inconsistentes para os valores canônicos do sistema.
 * Novos registros devem gravar somente os status retornados por esta função.
 */
export function normalizeOrdemStatus(value: unknown): OrdemStatusCanonical {
  const status = normalizeText(value);

  if (!status || status === "ABERTO" || status === "ABERTA" || status === "NOVA") {
    return "ABERTA";
  }

  if (
    status === "ANDAMENTO" ||
    status === "EM_ANDAMENTO" ||
    status === "EM_EXECUCAO" ||
    status === "EXECUCAO"
  ) {
    return "EM_ANDAMENTO";
  }

  if (
    status === "AGUARDANDO_SANEAR" ||
    status === "AGUARDANDO_LIBERACAO_SANEAR" ||
    status === "PAUSADA_SANEAR"
  ) {
    return "AGUARDANDO_SANEAR";
  }

  if (
    status === "CONCLUIDA" ||
    status === "CONCLUIDO" ||
    status === "FINALIZADA" ||
    status === "FINALIZADO" ||
    status === "FECHADA" ||
    status === "FECHADO" ||
    status === "ENCERRADA" ||
    status === "ENCERRADO"
  ) {
    return "CONCLUIDA";
  }

  if (
    status === "CANCELADA" ||
    status === "CANCELADO" ||
    status === "CANCELAMENTO" ||
    status === "EXCLUIDA" ||
    status === "EXCLUIDO"
  ) {
    return "CANCELADA";
  }

  return "ABERTA";
}

export function isOrdemConcluida(value: unknown): boolean {
  return normalizeOrdemStatus(value) === "CONCLUIDA";
}

export function isOrdemCancelada(value: unknown): boolean {
  return normalizeOrdemStatus(value) === "CANCELADA";
}

export function isOrdemAguardandoSanear(value: unknown): boolean {
  return normalizeOrdemStatus(value) === "AGUARDANDO_SANEAR";
}

export function isOrdemFechada(value: unknown): boolean {
  const status = normalizeOrdemStatus(value);
  return status === "CONCLUIDA" || status === "CANCELADA";
}

export function isOrdemAberta(value: unknown): boolean {
  return !isOrdemFechada(value);
}

export function formatOrdemStatusLabel(value: unknown, options?: { uppercase?: boolean }): string {
  const labels: Record<OrdemStatusCanonical, string> = {
    ABERTA: "Aberta",
    EM_ANDAMENTO: "Em andamento",
    AGUARDANDO_SANEAR: "Aguardando SANEAR",
    CONCLUIDA: "Concluída",
    CANCELADA: "Cancelada",
  };

  const label = labels[normalizeOrdemStatus(value)];
  return options?.uppercase ? label.toUpperCase() : label;
}

export function getOrdemStatusCssClass(value: unknown): string {
  const status = normalizeOrdemStatus(value);

  if (status === "CONCLUIDA") return "os-status-badge os-status-concluida";
  if (status === "EM_ANDAMENTO") return "os-status-badge os-status-andamento";
  if (status === "AGUARDANDO_SANEAR") return "os-status-badge os-status-aguardando-sanear";
  if (status === "CANCELADA") return "os-status-badge os-status-cancelada";
  return "os-status-badge os-status-aberta";
}
