// E2E NIVEL 5 ESTAVEL V27 - valida finalizacao por Firestore/Supabase, sem login admin final
import { expect, type Page, test } from "@playwright/test";
import path from "node:path";
import { credentialsFor, expectTopbarTitle, goToSidebar, loginAs, writeTestsEnabled } from "./helpers";

type CollectionName = "ordens_servico";

type FirestoreValue = {
  stringValue?: string;
  integerValue?: string;
  booleanValue?: boolean;
  timestampValue?: string;
  arrayValue?: { values?: FirestoreValue[] };
  mapValue?: { fields?: Record<string, FirestoreValue> };
};

type CreatedOrder = {
  collection: CollectionName;
  documentName?: string;
  protocolo: string;
  storagePaths: string[];
};

type OrderState = {
  documentName: string;
  status: string;
  fotosExecucao: Array<{
    nomeArquivo: string;
    path: string;
    storagePath: string;
    arquivoCompactado: boolean;
  }>;
};

const createdOrders: CreatedOrder[] = [];

function env(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function envOrThrow(name: string): string {
  const value = env(name);
  if (!value) throw new Error(`Preencha ${name} no .env.local ou .env.e2e.local.`);
  return value;
}

function makeCode(): string {
  return `E2E-N5-${Date.now()}`;
}

function fsString(value: string) {
  return { stringValue: value };
}

function fsInteger(value: number) {
  return { integerValue: String(value) };
}

function fsTimestamp(value: Date) {
  return { timestampValue: value.toISOString() };
}

function fsArray(values: unknown[] = []) {
  return values.length ? { arrayValue: { values } } : { arrayValue: {} };
}

function fieldString(fields: Record<string, FirestoreValue> | undefined, name: string): string {
  return fields?.[name]?.stringValue ?? "";
}

function fieldBoolean(fields: Record<string, FirestoreValue> | undefined, name: string): boolean {
  return fields?.[name]?.booleanValue ?? false;
}

async function adminTokenAndUid(): Promise<{ token: string; uid: string; email: string }> {
  const apiKey = envOrThrow("VITE_FIREBASE_API_KEY");
  const credentials = credentialsFor("admin");

  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: credentials.email,
        password: credentials.password,
        returnSecureToken: true,
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`Login admin para preparar Nivel 5 falhou (${response.status}): ${await response.text()}`);
  }

  const data = (await response.json()) as { idToken?: string; localId?: string; email?: string };
  if (!data.idToken || !data.localId) {
    throw new Error("Firebase nao retornou token/uid para preparar Nivel 5.");
  }

  return {
    token: data.idToken,
    uid: data.localId,
    email: (data.email || credentials.email).toLowerCase(),
  };
}

async function createTemporaryOrder(params: {
  token: string;
  uid: string;
  email: string;
  protocolo: string;
}): Promise<CreatedOrder> {
  const projectId = envOrThrow("VITE_FIREBASE_PROJECT_ID");
  const collection: CollectionName = "ordens_servico";
  const now = new Date();
  const documentId = params.protocolo;

  const response = await fetch(
    `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${collection}?documentId=${encodeURIComponent(documentId)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        fields: {
          tipo: fsString("BURACO_RUA"),
          protocolo: fsString(params.protocolo),
          ordemServico: fsString(params.protocolo),
          bairro: fsString("TESTE AUTOMATIZADO"),
          rua: fsString("RUA TESTE FOTO FINALIZACAO"),
          numero: fsString("S/N"),
          pontoReferencia: fsString("TESTE PLAYWRIGHT NIVEL 5"),
          referencia: fsString("TESTE PLAYWRIGHT NIVEL 5"),
          observacoes: fsString("OS TEMPORARIA PARA TESTE E2E NIVEL 5"),
          status: fsString("ABERTA"),
          slaServico: fsString("CALCAMENTO"),
          slaLabel: fsString("Calçamento"),
          slaPrioridade: fsString("NORMAL"),
          slaConfigVersao: fsInteger(1),
          slaHoras: fsInteger(48),
          slaPausas: fsArray(),
          createdAt: fsTimestamp(now),
          updatedAt: fsTimestamp(now),
          createdByEmail: fsString(params.email),
          createdByUid: fsString(params.uid),
          fotos: fsArray(),
          fotosExecucao: fsArray(),
          anexoStatus: fsString("SEM_ANEXO"),
          ordemServicoPdfStatus: fsString("SEM_ANEXO"),
          anexosPendentes: fsArray(),
        },
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`Criacao da OS temporaria Nivel 5 falhou (${response.status}): ${await response.text()}`);
  }

  const data = (await response.json()) as { name?: string };
  if (!data.name) throw new Error("Firestore nao retornou o nome do documento criado no Nivel 5.");

  const created = {
    collection,
    documentName: data.name,
    protocolo: params.protocolo,
    storagePaths: [],
  };
  createdOrders.push(created);
  return created;
}

async function findDocumentByProtocol(token: string, protocolo: string) {
  const projectId = envOrThrow("VITE_FIREBASE_PROJECT_ID");

  const response = await fetch(
    `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: "ordens_servico" }],
          where: {
            fieldFilter: {
              field: { fieldPath: "protocolo" },
              op: "EQUAL",
              value: fsString(protocolo),
            },
          },
          limit: 1,
        },
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`Consulta Nivel 5 falhou (${response.status}): ${await response.text()}`);
  }

  const rows = (await response.json()) as Array<{
    document?: {
      name?: string;
      fields?: Record<string, FirestoreValue>;
    };
  }>;

  return rows.find((row) => row.document)?.document ?? null;
}

async function getOrderState(token: string, protocolo: string): Promise<OrderState> {
  const document = await findDocumentByProtocol(token, protocolo);
  const fields = document?.fields;
  const fotoValues = fields?.fotosExecucao?.arrayValue?.values ?? [];

  const fotosExecucao = fotoValues.map((value) => {
    const fotoFields = value.mapValue?.fields;
    return {
      nomeArquivo: fieldString(fotoFields, "nomeArquivo"),
      path: fieldString(fotoFields, "path"),
      storagePath: fieldString(fotoFields, "storagePath"),
      arquivoCompactado: fieldBoolean(fotoFields, "arquivoCompactado"),
    };
  });

  return {
    documentName: document?.name ?? "",
    status: fieldString(fields, "status"),
    fotosExecucao,
  };
}

async function deleteFirestoreDocument(token: string, documentName: string) {
  const response = await fetch(`https://firestore.googleapis.com/v1/${documentName}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok && response.status !== 404) {
    throw new Error(`Limpeza Firestore Nivel 5 falhou (${response.status}): ${await response.text()}`);
  }
}

async function deleteSupabaseObject(storagePath: string) {
  const supabaseUrl = envOrThrow("VITE_SUPABASE_URL").replace(/\/+$/, "");
  const anonKey = envOrThrow("VITE_SUPABASE_ANON_KEY");
  const bucket = "os-arquivos";

  const response = await fetch(
    `${supabaseUrl}/storage/v1/object/${bucket}/${storagePath
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`,
    {
      method: "DELETE",
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
      },
    }
  );

  if (!response.ok && response.status !== 404) {
    throw new Error(
      `Limpeza Supabase Nivel 5 falhou (${response.status}) no caminho ${storagePath}: ${await response.text()}`
    );
  }
}

async function cleanupCreatedOrders() {
  if (!createdOrders.length) return;

  const { token } = await adminTokenAndUid();
  const pending = createdOrders.splice(0);

  for (const order of pending) {
    const latest = await getOrderState(token, order.protocolo);
    const documentName = latest.documentName || order.documentName;
    const paths = new Set<string>();

    for (const foto of latest.fotosExecucao) {
      if (foto.storagePath) paths.add(foto.storagePath);
      if (foto.path) paths.add(foto.path);
    }

    for (const storagePath of order.storagePaths) {
      paths.add(storagePath);
    }

    for (const storagePath of paths) {
      await deleteSupabaseObject(storagePath);
    }

    if (documentName) {
      await deleteFirestoreDocument(token, documentName);
    }
  }
}

async function limparPendentesLocaisNivel5(page: Page) {
  await page.evaluate(async () => {
    type RegistroPendente = {
      id?: string;
      nomeArquivo?: string;
    };

    await new Promise<void>((resolve) => {
      const request = indexedDB.open("sanear-operacional-anexos", 1);

      request.onerror = () => resolve();
      request.onupgradeneeded = () => resolve();
      request.onsuccess = () => {
        const db = request.result;

        if (!db.objectStoreNames.contains("pendentes")) {
          db.close();
          resolve();
          return;
        }

        const tx = db.transaction("pendentes", "readwrite");
        const store = tx.objectStore("pendentes");
        const getAll = store.getAll();

        getAll.onsuccess = () => {
          const registros = (getAll.result as RegistroPendente[]) ?? [];
          for (const registro of registros) {
            if (registro.id && registro.nomeArquivo?.startsWith("e2e-nivel5-foto")) {
              store.delete(registro.id);
            }
          }
        };

        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => {
          db.close();
          resolve();
        };
      };
    });
  }).catch(() => undefined);
}

async function listarPendentesLocaisNivel5(page: Page) {
  return page.evaluate(async () => {
    type RegistroPendente = {
      id?: string;
      nomeArquivo?: string;
      ultimoErro?: string;
      observacao?: string;
    };

    return new Promise<RegistroPendente[]>((resolve) => {
      const request = indexedDB.open("sanear-operacional-anexos", 1);

      request.onerror = () => resolve([]);
      request.onupgradeneeded = () => resolve([]);
      request.onsuccess = () => {
        const db = request.result;

        if (!db.objectStoreNames.contains("pendentes")) {
          db.close();
          resolve([]);
          return;
        }

        const tx = db.transaction("pendentes", "readonly");
        const store = tx.objectStore("pendentes");
        const getAll = store.getAll();

        getAll.onsuccess = () => {
          db.close();
          resolve((getAll.result as RegistroPendente[]) ?? []);
        };
        getAll.onerror = () => {
          db.close();
          resolve([]);
        };
      };
    });
  });
}

async function openTemporaryOrderInTerceirizada(page: Page, protocolo: string) {
  await loginAs(page, "terceirizada");

  // Depois que a terceirizada passou a ter acesso ao Dashboard,
  // ela pode iniciar no Painel. Para finalizar OS, o teste
  // entra explicitamente na Área da Terceirizada.
  if ((await page.locator(".topbar-page-title").innerText().catch(() => "")) !== "Visão da Terceirizada") {
    await goToSidebar(page, "Área da Terceirizada");
  }

  await expectTopbarTitle(page, "Visão da Terceirizada");

  const search = page.getByPlaceholder(/Buscar por protocolo/i);
  await search.fill(protocolo);

  const card = page.locator(".os-card").filter({ hasText: protocolo }).first();
  await expect(card).toBeVisible({ timeout: 25_000 });
  await card.getByRole("button", { name: "Ver dados" }).click();

  const detailsModal = page.locator(".modal").filter({ hasText: "Detalhes da OS" }).first();
  await expect(detailsModal).toBeVisible();
  await expect(detailsModal.getByText(protocolo)).toBeVisible();
  return detailsModal;
}

async function closeInfoModal(page: Page, title: string | RegExp) {
  const modal = page.locator(".modal").filter({ hasText: title }).last();
  await expect(modal).toBeVisible({ timeout: 15_000 });
  await modal.getByRole("button", { name: "Fechar" }).click();
  await expect(modal).toHaveCount(0, { timeout: 15_000 });
}

async function finalizeWithPhotos(page: Page, protocolo: string) {
  const detailsModal = await openTemporaryOrderInTerceirizada(page, protocolo);

  const foto1 = path.resolve(process.cwd(), "e2e", "fixtures", "e2e-nivel5-foto-1.png");
  const foto2 = path.resolve(process.cwd(), "e2e", "fixtures", "e2e-nivel5-foto-2.png");
  const foto3 = path.resolve(process.cwd(), "e2e", "fixtures", "e2e-nivel5-foto-3.png");

  await page.locator("#upload-fotos-modal").setInputFiles([foto1, foto2, foto3]);

  const restrictionModal = page.locator(".modal").filter({ hasText: "Fotos adicionadas com restrições" }).last();
  await expect(restrictionModal).toBeVisible({ timeout: 15_000 });
  await expect(restrictionModal.getByText(/limite é de 2/i)).toBeVisible();
  await restrictionModal.getByRole("button", { name: "Fechar" }).click();

  await expect(detailsModal.locator(".photo-preview-item")).toHaveCount(2, { timeout: 15_000 });
  await expect(detailsModal.locator(".execution-photo-limit strong")).toHaveText("2/2");

  await detailsModal.getByRole("button", { name: "Finalizar serviço" }).click();

  const successModal = page.locator(".modal").filter({ hasText: "Status atualizado" }).last();
  await expect(successModal).toBeVisible({ timeout: 45_000 });
  await expect(successModal.getByText(/serviço executado|concluída/i)).toBeVisible();
  await successModal.getByRole("button", { name: "Fechar" }).click();
}

async function expectFinishedInFirestore(page: Page, token: string, protocolo: string) {
  let lastState: OrderState = {
    documentName: "",
    status: "",
    fotosExecucao: [],
  };

  await expect
    .poll(async () => {
      lastState = await getOrderState(token, protocolo);
      return {
        status: lastState.status,
        fotos: lastState.fotosExecucao.length,
        paths: lastState.fotosExecucao.filter((foto) => foto.path || foto.storagePath).length,
      };
    }, { timeout: 45_000 })
    .toMatchObject({ status: "CONCLUIDA", fotos: 2, paths: 2 });

  const created = createdOrders.find((order) => order.protocolo === protocolo);
  if (created) {
    created.documentName = lastState.documentName || created.documentName;
    created.storagePaths = lastState.fotosExecucao
      .map((foto) => foto.storagePath || foto.path)
      .filter(Boolean);
  }

  const fotosInvalidas = lastState.fotosExecucao.filter((foto) => !foto.arquivoCompactado || !foto.nomeArquivo);
  if (fotosInvalidas.length > 0) {
    throw new Error(`Fotos de execução foram gravadas sem compactação ou sem nome: ${JSON.stringify(fotosInvalidas)}`);
  }

  const pendentes = await listarPendentesLocaisNivel5(page);
  const pendentesNivel5 = pendentes.filter((pendente) => pendente.nomeArquivo?.startsWith("e2e-nivel5-foto"));
  if (pendentesNivel5.length > 0) {
    throw new Error(
      `Existem fotos do Nivel 5 na fila local, indicando falha de upload. ` +
        `Pendentes: ${JSON.stringify(pendentesNivel5)}`
    );
  }
}



test.describe.configure({ mode: "serial" });

test.describe("Nivel 5 seguro - fotos e finalizacao", () => {
  test.setTimeout(240_000);

  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name.includes("mobile"), "Nivel 5 seguro fica apenas no desktop.");
    test.skip(!writeTestsEnabled(), "Rode com -WriteTests para criar OS temporaria e upload real de fotos.");
  });

  test.afterEach(async ({ page }) => {
    await limparPendentesLocaisNivel5(page);
    await cleanupCreatedOrders();
  });

  test("bloqueia finalizacao sem foto obrigatoria", async ({ page }) => {
    const admin = await adminTokenAndUid();
    const protocolo = makeCode();
    await createTemporaryOrder({ ...admin, protocolo });

    const detailsModal = await openTemporaryOrderInTerceirizada(page, protocolo);
    await detailsModal.getByRole("button", { name: "Finalizar serviço" }).click();

    await closeInfoModal(page, "Foto obrigatória");

    await expect
      .poll(async () => (await getOrderState(admin.token, protocolo)).status, { timeout: 20_000 })
      .toBe("ABERTA");
  });

  test("V27 - anexa duas fotos, respeita limite, finaliza e valida somente no Firestore", async ({ page }) => {
    const admin = await adminTokenAndUid();
    const protocolo = makeCode();
    await createTemporaryOrder({ ...admin, protocolo });

    await finalizeWithPhotos(page, protocolo);
    await expectFinishedInFirestore(page, admin.token, protocolo);
  });
});
