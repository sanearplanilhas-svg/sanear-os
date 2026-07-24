import { expect, type Page, test } from "@playwright/test";
import path from "node:path";
import {
  credentialsFor,
  expectTopbarTitle,
  fillPageField,
  goToSidebar,
  loginAs,
  writeTestsEnabled,
} from "./helpers";

type CreatedOrder = {
  collection: "ordens_servico";
  documentName?: string;
  protocolo: string;
  storagePath?: string;
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
  return `E2E-N4-${Date.now()}`;
}

async function adminIdToken(): Promise<string> {
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
    throw new Error(`Login admin para limpeza Nivel 4 falhou (${response.status}).`);
  }

  const data = (await response.json()) as { idToken?: string };
  if (!data.idToken) throw new Error("Firebase nao retornou idToken para limpeza Nivel 4.");
  return data.idToken;
}

async function findOrderByProtocol(token: string, protocolo: string) {
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
              value: { stringValue: protocolo },
            },
          },
          limit: 1,
        },
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`Consulta Nivel 4 falhou (${response.status}): ${await response.text()}`);
  }

  const rows = (await response.json()) as Array<{
    document?: {
      name?: string;
      fields?: Record<string, { stringValue?: string; booleanValue?: boolean }>;
    };
  }>;

  return rows.find((row) => row.document)?.document ?? null;
}

async function deleteFirestoreDocument(token: string, documentName: string) {
  const response = await fetch(`https://firestore.googleapis.com/v1/${documentName}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok && response.status !== 404) {
    throw new Error(`Limpeza Firestore Nivel 4 falhou (${response.status}): ${await response.text()}`);
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
      `Limpeza Supabase Nivel 4 falhou (${response.status}) no caminho ${storagePath}: ${await response.text()}`
    );
  }
}

async function cleanupCreatedOrders() {
  if (!createdOrders.length) return;

  const token = await adminIdToken();
  const pending = createdOrders.splice(0);

  for (const order of pending) {
    const latest = await findOrderByProtocol(token, order.protocolo);
    const documentName = latest?.name || order.documentName;
    const storagePath =
      latest?.fields?.ordemServicoPdfPath?.stringValue || order.storagePath;

    if (storagePath) {
      await deleteSupabaseObject(storagePath);
    }

    if (documentName) {
      await deleteFirestoreDocument(token, documentName);
    }
  }
}

async function openCalcamentoForm(page: Page) {
  await goToSidebar(page, "Calçamento");
  await expectTopbarTitle(page, "Calçamento");
  await expect(page.getByRole("heading", { name: /Cadastro de Calçamento/i })).toBeVisible();
}

async function fillOrderForm(page: Page, code: string) {
  await fillPageField(page, "Protocolo", code);
  await fillPageField(page, "Ordem de Serviço", code);
  await fillPageField(page, "Bairro", "TESTE AUTOMATIZADO");
  await fillPageField(page, "Rua / Avenida", "RUA TESTE ANEXO PDF");
  await fillPageField(page, "Número", "S/N");
  await fillPageField(page, "Ponto de referência", "TESTE PLAYWRIGHT NIVEL 4");
  await fillPageField(page, "Observações", "OS CRIADA PELO TESTE E2E NIVEL 4");
}

async function waitForSaveSuccess(page: Page) {
  const modal = page.locator(".modal").first();
  await expect(modal).toBeVisible({ timeout: 45_000 });

  const modalText = (await modal.innerText()).replace(/\s+/g, " ").trim();
  const isSuccess =
    /Cadastro salvo com sucesso/i.test(modalText) ||
    /cadastrad[ao](\.| com sucesso)/i.test(modalText);

  if (!isSuccess) {
    throw new Error(`A OS com PDF nao foi salva com sucesso. Modal exibido: ${modalText}`);
  }
}

type PdfFirestoreState = {
  documentName: string;
  status: string;
  path: string;
  compactado: boolean;
  nomeArquivo: string;
  pendenteId: string;
};

async function getPdfStateFromFirestore(token: string, protocolo: string): Promise<PdfFirestoreState> {
  const document = await findOrderByProtocol(token, protocolo);

  return {
    documentName: document?.name ?? "",
    status: document?.fields?.ordemServicoPdfStatus?.stringValue ?? "",
    path: document?.fields?.ordemServicoPdfPath?.stringValue ?? "",
    compactado: document?.fields?.ordemServicoPdfCompactado?.booleanValue ?? false,
    nomeArquivo: document?.fields?.ordemServicoPdfNomeArquivo?.stringValue ?? "",
    pendenteId: document?.fields?.ordemServicoPdfPendenteId?.stringValue ?? "",
  };
}

async function listarPendentesLocais(page: Page) {
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

async function limparPendentesLocaisNivel4(page: Page) {
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
            if (registro.id && registro.nomeArquivo === "e2e-nivel4-os.pdf") {
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

async function expectPdfRegisteredInFirestore(page: Page, protocolo: string) {
  const token = await adminIdToken();
  const deadline = Date.now() + 60_000;
  let lastState: PdfFirestoreState = {
    documentName: "",
    status: "",
    path: "",
    compactado: false,
    nomeArquivo: "",
    pendenteId: "",
  };

  while (Date.now() < deadline) {
    lastState = await getPdfStateFromFirestore(token, protocolo);

    if (lastState.status === "OK" && lastState.path && lastState.nomeArquivo) {
      break;
    }

    await page.waitForTimeout(1_000);
  }

  if (lastState.documentName) {
    const created = createdOrders.find((order) => order.protocolo === protocolo);
    if (created) {
      created.documentName = lastState.documentName;
      created.storagePath = lastState.path || created.storagePath;
    }
  }

  if (lastState.status !== "OK") {
    const pendentes = await listarPendentesLocais(page);
    const pendenteRelacionado = pendentes.find(
      (pendente) =>
        pendente.id === lastState.pendenteId ||
        pendente.nomeArquivo === "e2e-nivel4-os.pdf"
    );

    const erroLocal = pendenteRelacionado?.ultimoErro
      ? ` Erro local: ${pendenteRelacionado.ultimoErro}`
      : "";

    throw new Error(
      `PDF da OS ficou com status ${lastState.status || "VAZIO"} no Firestore, ` +
        `em vez de OK. Isso normalmente indica falha no upload para o Supabase ` +
        `ou policy/mime type do bucket sem aceitar ZIP. pendenteId=${lastState.pendenteId || "vazio"}.` +
        erroLocal
    );
  }

  if (!lastState.path || !lastState.documentName) {
    throw new Error("PDF Nivel 4 foi salvo, mas Firestore nao retornou documentName/storagePath.");
  }

  expect(lastState.nomeArquivo).toBe("e2e-nivel4-os.pdf");
  expect(lastState.compactado).toBe(true);
}

async function expectPdfInList(page: Page, protocolo: string) {
  await goToSidebar(page, "Lista de OS");
  await expectTopbarTitle(page, "Lista de Ordens de Serviço");

  await page.getByPlaceholder(/Buscar por número da OS/i).fill(protocolo);
  const row = page.locator("tr").filter({ hasText: protocolo }).first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();

  const detailsModal = page.locator(".modal").filter({ hasText: protocolo }).first();
  await expect(detailsModal).toBeVisible();
  await expect(detailsModal.getByText("PDF da OS anexado")).toBeVisible();
  await expect(detailsModal.getByText("e2e-nivel4-os.pdf")).toBeVisible();
  await expect(detailsModal.getByRole("button", { name: "Abrir PDF anexado na criação" })).toBeVisible();
}

test.describe.configure({ mode: "serial" });

test.describe("Nivel 4 seguro - PDF da OS", () => {
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name.includes("mobile"), "Nivel 4 seguro fica apenas no desktop.");
    test.skip(!writeTestsEnabled(), "Rode com -WriteTests para criar OS temporaria e upload real.");
  });

  test.afterEach(async ({ page }) => {
    await limparPendentesLocaisNivel4(page);
    await cleanupCreatedOrders();
  });

  test("cadastra OS temporaria com PDF e valida registro na Lista", async ({ page }) => {
    const code = makeCode();
    const pdfPath = path.resolve(process.cwd(), "e2e", "fixtures", "e2e-nivel4-os.pdf");

    createdOrders.push({ collection: "ordens_servico", protocolo: code });

    await loginAs(page, "admin");
    await openCalcamentoForm(page);

    await page.locator('input[type="file"][accept*="pdf"]').setInputFiles(pdfPath);
    await expect(page.getByText(/PDF anexado/i).first()).toBeVisible({ timeout: 20_000 });

    await fillOrderForm(page, code);
    await page.getByRole("button", { name: "Salvar OS" }).first().click();
    await waitForSaveSuccess(page);
    await page.locator(".modal").getByRole("button", { name: "OK" }).click();

    await expectPdfRegisteredInFirestore(page, code);
    await expectPdfInList(page, code);
  });
});
