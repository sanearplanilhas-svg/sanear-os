export type TipoAnexoPendente = "PDF_OS" | "FOTO_EXECUCAO";

export type AnexoPendenteRegistro = {
  id: string;
  tipo: TipoAnexoPendente;
  osId: string;
  collectionName: string;
  origem: string;
  storageBasePath: string;
  storageSubfolder: string;
  nomeArquivo: string;
  mimeType: string;
  tamanho: number;
  criadoEm: string;
  criadoPorEmail: string | null;
  observacao?: string;
  tentativas: number;
  ultimoErro?: string;
  arquivoBlob: Blob;
};

type SalvarAnexoPendenteInput = Omit<
  AnexoPendenteRegistro,
  "id" | "criadoEm" | "tentativas" | "arquivoBlob"
> & {
  arquivo: Blob;
  ultimoErro?: string;
};

const DB_NAME = "sanear-operacional-anexos";
const DB_VERSION = 1;
const STORE_NAME = "pendentes";

function gerarIdPendente(tipo: TipoAnexoPendente, osId: string): string {
  const random = Math.random().toString(36).slice(2);
  return `${tipo}-${osId}-${Date.now()}-${random}`;
}

function abrirBanco(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("osId", "osId", { unique: false });
        store.createIndex("tipo", "tipo", { unique: false });
        store.createIndex("collectionName", "collectionName", { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Erro ao abrir fila local de anexos."));
  });
}

export async function salvarAnexoPendente(
  input: SalvarAnexoPendenteInput
): Promise<AnexoPendenteRegistro> {
  const db = await abrirBanco();
  const registro: AnexoPendenteRegistro = {
    ...input,
    id: gerarIdPendente(input.tipo, input.osId),
    criadoEm: new Date().toISOString(),
    tentativas: 0,
    ultimoErro: input.ultimoErro,
    arquivoBlob: input.arquivo,
  };

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const request = store.put(registro);

    request.onsuccess = () => resolve(registro);
    request.onerror = () => reject(request.error ?? new Error("Erro ao salvar anexo na fila local."));
    tx.oncomplete = () => db.close();
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? new Error("Erro ao gravar fila local de anexos."));
    };
  });
}

export async function listarAnexosPendentes(): Promise<AnexoPendenteRegistro[]> {
  const db = await abrirBanco();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAll();

    request.onsuccess = () => {
      const registros = (request.result as AnexoPendenteRegistro[]).sort(
        (a, b) => new Date(a.criadoEm).getTime() - new Date(b.criadoEm).getTime()
      );
      resolve(registros);
    };
    request.onerror = () => reject(request.error ?? new Error("Erro ao listar anexos pendentes."));
    tx.oncomplete = () => db.close();
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? new Error("Erro ao consultar fila local de anexos."));
    };
  });
}

export async function buscarAnexoPendente(id: string): Promise<AnexoPendenteRegistro | null> {
  const db = await abrirBanco();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(id);

    request.onsuccess = () => resolve((request.result as AnexoPendenteRegistro | undefined) ?? null);
    request.onerror = () => reject(request.error ?? new Error("Erro ao buscar anexo pendente."));
    tx.oncomplete = () => db.close();
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? new Error("Erro ao consultar fila local de anexos."));
    };
  });
}

export async function atualizarErroAnexoPendente(id: string, erro: string): Promise<void> {
  const db = await abrirBanco();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const getRequest = store.get(id);

    getRequest.onsuccess = () => {
      const registro = getRequest.result as AnexoPendenteRegistro | undefined;
      if (!registro) {
        resolve();
        return;
      }

      const atualizado: AnexoPendenteRegistro = {
        ...registro,
        tentativas: (registro.tentativas ?? 0) + 1,
        ultimoErro: erro,
      };
      store.put(atualizado);
    };

    getRequest.onerror = () => reject(getRequest.error ?? new Error("Erro ao atualizar tentativa do anexo."));
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? new Error("Erro ao atualizar fila local de anexos."));
    };
  });
}

export async function removerAnexoPendente(id: string): Promise<void> {
  const db = await abrirBanco();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const request = store.delete(id);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("Erro ao remover anexo pendente."));
    tx.oncomplete = () => db.close();
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? new Error("Erro ao remover anexo da fila local."));
    };
  });
}

export async function contarAnexosPendentes(): Promise<number> {
  const db = await abrirBanco();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const request = store.count();

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Erro ao contar anexos pendentes."));
    tx.oncomplete = () => db.close();
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? new Error("Erro ao consultar fila local de anexos."));
    };
  });
}

export function resumirErroAnexo(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Falha desconhecida no envio do anexo.";
}
