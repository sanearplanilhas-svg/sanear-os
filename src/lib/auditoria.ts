import {
  addDoc,
  collection,
  onSnapshot,
  query,
  where,
  type QueryDocumentSnapshot,
  type Timestamp,
  type Unsubscribe,
} from "firebase/firestore";
import { auth, db } from "./firebaseClient";
import { normalizeOrdemStatus } from "./status";

export type AuditoriaOrigem = "buraco" | "asfalto" | "hidrojato" | string;

export type AuditoriaAcao =
  | "EDICAO_OS"
  | "AGUARDANDO_SANEAR"
  | "RETOMADA_SANEAR"
  | "FINALIZACAO_TERCEIRIZADA"
  | "FINALIZACAO_SANEAR"
  | "REABERTURA_OS"
  | "EXCLUSAO_OS"
  | "FOTO_EXCLUIDA"
  | string;

export type AuditoriaEvento = {
  id: string;
  osId: string;
  osKey: string;
  origem: AuditoriaOrigem;
  collectionName: string;
  acao: AuditoriaAcao;
  titulo: string;
  descricao?: string | null;
  statusAntes?: string | null;
  statusDepois?: string | null;
  criadoEm?: Timestamp | null;
  usuarioEmail?: string | null;
  usuarioUid?: string | null;
  detalhes?: Record<string, unknown> | null;
};

type RegistrarAuditoriaInput = Omit<AuditoriaEvento, "id" | "osKey" | "criadoEm" | "usuarioEmail" | "usuarioUid">;

const AUDITORIA_COLLECTION = "ordens_auditoria";

function makeOsKey(origem: AuditoriaOrigem, osId: string): string {
  return `${origem}:${osId}`;
}

function normalizeEvento(docSnap: QueryDocumentSnapshot): AuditoriaEvento {
  const data = docSnap.data();

  return {
    id: docSnap.id,
    osId: String(data.osId ?? ""),
    osKey: String(data.osKey ?? ""),
    origem: String(data.origem ?? ""),
    collectionName: String(data.collectionName ?? ""),
    acao: String(data.acao ?? ""),
    titulo: String(data.titulo ?? "Registro operacional"),
    descricao: data.descricao ?? null,
    statusAntes: data.statusAntes ?? null,
    statusDepois: data.statusDepois ?? null,
    criadoEm: data.criadoEm ?? null,
    usuarioEmail: data.usuarioEmail ?? null,
    usuarioUid: data.usuarioUid ?? null,
    detalhes: data.detalhes ?? null,
  };
}

export async function registrarAuditoriaOs(input: RegistrarAuditoriaInput): Promise<void> {
  try {
    const user = auth.currentUser;
    const payload = {
      ...input,
      statusAntes: input.statusAntes ? normalizeOrdemStatus(input.statusAntes) : null,
      statusDepois: input.statusDepois ? normalizeOrdemStatus(input.statusDepois) : null,
      osKey: makeOsKey(input.origem, input.osId),
      criadoEm: new Date(),
      criadoEmServidor: new Date(),
      usuarioEmail: user?.email?.toLowerCase() ?? null,
      usuarioUid: user?.uid ?? null,
    };

    await addDoc(collection(db, AUDITORIA_COLLECTION), payload);
  } catch (error) {
    // Auditoria não pode travar o fluxo principal da OS.
    console.warn("Não foi possível registrar auditoria da OS:", error);
  }
}

export function assinarAuditoriaOs(
  origem: AuditoriaOrigem,
  osId: string,
  callback: (eventos: AuditoriaEvento[]) => void,
  onError?: (error: unknown) => void
): Unsubscribe {
  const q = query(
    collection(db, AUDITORIA_COLLECTION),
    where("osKey", "==", makeOsKey(origem, osId))
  );

  return onSnapshot(
    q,
    (snapshot) => {
      const eventos = snapshot.docs
        .map(normalizeEvento)
        .sort((a, b) => {
          const aTime = a.criadoEm?.toMillis?.() ?? 0;
          const bTime = b.criadoEm?.toMillis?.() ?? 0;
          return bTime - aTime;
        });

      callback(eventos);
    },
    (error) => {
      console.warn("Não foi possível carregar auditoria da OS:", error);
      onError?.(error);
    }
  );
}
