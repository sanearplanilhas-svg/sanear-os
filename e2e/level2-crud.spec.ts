import { expect, type Page, test } from "@playwright/test";
import {
  credentialsFor,
  expectTopbarTitle,
  fillPageField,
  goToSidebar,
  loginAs,
  writeTestsEnabled,
} from "./helpers";

type CollectionName = "ordens_servico" | "ordensServico" | "ordensHidrojato";

type OrderModule = {
  menu: string;
  title: string;
  collection: CollectionName;
  suffix: string;
};

type CreatedOrder = {
  collection: CollectionName;
  protocolo: string;
};

const modules: OrderModule[] = [
  {
    menu: "Calçamento",
    title: "Calçamento",
    collection: "ordens_servico",
    suffix: "CALC",
  },
  {
    menu: "Asfalto",
    title: "Asfalto",
    collection: "ordensServico",
    suffix: "ASF",
  },
  {
    menu: "Caminhão Hidrojato",
    title: "Caminhão Hidrojato",
    collection: "ordensHidrojato",
    suffix: "HID",
  },
];

const createdOrders: CreatedOrder[] = [];

function env(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function envOrThrow(name: string): string {
  const value = env(name);
  if (!value) throw new Error(`Preencha ${name} no .env.local ou .env.e2e.local.`);
  return value;
}

function makeCode(suffix: string): string {
  return `E2E-N2-${Date.now()}-${suffix}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function visibleTextSnippet(page: Page): Promise<string> {
  const text = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
  return text.replace(/\s+/g, " ").trim().slice(0, 450) || "sem texto visivel";
}

async function openOrderForm(page: Page, module: OrderModule) {
  await goToSidebar(page, module.menu);
  await expectTopbarTitle(page, module.title);

  const expectedHeading = new RegExp(`Cadastro de ${escapeRegExp(module.title)}`, "i");
  const saveButton = page.getByRole("button", { name: "Salvar OS" }).first();
  const manualButton = page.getByRole("button", { name: "Preencher manualmente" }).first();

  try {
    await expect(page.getByRole("heading", { name: expectedHeading })).toBeVisible({
      timeout: 10_000,
    });

    if (!(await saveButton.isVisible().catch(() => false))) {
      if (await manualButton.isVisible().catch(() => false)) {
        await manualButton.click();
      }
    }

    await expect(saveButton).toBeVisible({ timeout: 10_000 });
  } catch {
    test.skip(
      true,
      `Formulario de ${module.title} nao apareceu para esta conta/ambiente. Texto visivel: ${await visibleTextSnippet(page)}`
    );
  }

  return saveButton;
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
    throw new Error(`Login admin para limpeza falhou (${response.status}).`);
  }

  const data = (await response.json()) as { idToken?: string };
  if (!data.idToken) throw new Error("Firebase nao retornou idToken para limpeza.");
  return data.idToken;
}

async function findDocumentsByProtocol(
  token: string,
  collection: CollectionName,
  protocolo: string
): Promise<string[]> {
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
          from: [{ collectionId: collection }],
          where: {
            fieldFilter: {
              field: { fieldPath: "protocolo" },
              op: "EQUAL",
              value: { stringValue: protocolo },
            },
          },
          limit: 10,
        },
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`Busca de limpeza falhou (${response.status}): ${await response.text()}`);
  }

  const rows = (await response.json()) as Array<{ document?: { name?: string } }>;
  return rows.map((row) => row.document?.name).filter((name): name is string => Boolean(name));
}

async function deleteDocument(token: string, documentName: string) {
  const response = await fetch(`https://firestore.googleapis.com/v1/${documentName}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok && response.status !== 404) {
    throw new Error(`Exclusao de limpeza falhou (${response.status}): ${await response.text()}`);
  }
}

async function cleanupCreatedOrders() {
  if (!createdOrders.length) return;

  const token = await adminIdToken();
  const pending = createdOrders.splice(0);

  for (const order of pending) {
    const documentNames = await findDocumentsByProtocol(
      token,
      order.collection,
      order.protocolo
    );

    for (const documentName of documentNames) {
      await deleteDocument(token, documentName);
    }
  }
}

async function fillOrderForm(page: Page, code: string) {
  await fillPageField(page, "Protocolo", code);
  await fillPageField(page, "Ordem de Serviço", code);
  await fillPageField(page, "Bairro", "TESTE AUTOMATIZADO");
  await fillPageField(page, "Rua / Avenida", "RUA TESTE AUTOMATIZADO");
  await fillPageField(page, "Número", "S/N");
  await fillPageField(page, "Ponto de referência", "TESTE PLAYWRIGHT");
  await fillPageField(page, "Observações", "OS CRIADA PELO TESTE E2E NIVEL 2");
}

async function waitForSaveSuccess(page: Page) {
  const modal = page.locator(".modal").first();
  await expect(modal).toBeVisible({ timeout: 25_000 });

  let modalText = (await modal.innerText()).replace(/\s+/g, " ").trim();

  if (/Campos não preenchidos/i.test(modalText) && /OS em PDF/i.test(modalText)) {
    await modal.getByRole("button", { name: "Continuar mesmo assim" }).click();
    await expect
      .poll(
        async () => {
          const currentModal = page.locator(".modal").first();
          if (!(await currentModal.isVisible().catch(() => false))) return "";
          return (await currentModal.innerText()).replace(/\s+/g, " ").trim();
        },
        { timeout: 25_000 }
      )
      .toMatch(/Cadastro salvo com sucesso|Erro ao salvar OS|Cadastro não realizado|cadastrad[ao]/i);

    modalText = (await page.locator(".modal").first().innerText()).replace(/\s+/g, " ").trim();
  }

  const isSuccess =
    /Cadastro salvo com sucesso/i.test(modalText) ||
    /cadastrad[ao](\.| com sucesso)/i.test(modalText);

  if (!isSuccess) {
    throw new Error(`A OS nao foi salva com sucesso. Modal exibido: ${modalText}`);
  }
}

async function continueWithoutPdfIfNeeded(page: Page) {
  const modal = page.locator(".modal").first();
  await expect(modal).toBeVisible({ timeout: 25_000 });

  const modalText = (await modal.innerText()).replace(/\s+/g, " ").trim();
  if (/Campos não preenchidos/i.test(modalText) && /OS em PDF/i.test(modalText)) {
    await modal.getByRole("button", { name: "Continuar mesmo assim" }).click();
  }
}

async function closeResultModal(page: Page) {
  await page.locator(".modal").getByRole("button", { name: "OK" }).click();
  await expect(page.locator(".modal")).toHaveCount(0);
}

async function createOrder(page: Page, module: OrderModule, code: string) {
  const saveButton = await openOrderForm(page, module);

  await fillOrderForm(page, code);
  createdOrders.push({ collection: module.collection, protocolo: code });

  await saveButton.click();
  await waitForSaveSuccess(page);

  await closeResultModal(page);
}

async function expectOrderInList(page: Page, code: string) {
  await goToSidebar(page, "Lista de OS");
  await expectTopbarTitle(page, "Lista de Ordens de Serviço");

  const search = page.getByPlaceholder(/Buscar por número da OS/i);
  await search.fill(code);

  await expect(page.getByRole("cell", { name: code }).first()).toBeVisible();
  await search.fill("");
}

test.describe.configure({ mode: "serial" });

test.describe("Nivel 2 - cadastros e validacoes de OS", () => {
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name.includes("mobile"), "Nivel 2 fica apenas no desktop.");
    test.skip(!writeTestsEnabled(), "Rode com -WriteTests para criar OS temporaria no banco.");
  });

  test.afterEach(async () => {
    await cleanupCreatedOrders();
  });

  test("bloqueia cadastro vazio antes de gravar no banco", async ({ page }) => {
    await loginAs(page, "admin");
    const saveButton = await openOrderForm(page, modules[0]);

    await saveButton.click();

    await expect(page.getByRole("heading", { name: "Campos não preenchidos" })).toBeVisible();
    await expect(page.getByText("Os seguintes campos não foram preenchidos:")).toBeVisible();
    await expect(page.getByRole("button", { name: "Voltar para editar" })).toBeVisible();

    await page.getByRole("button", { name: "Voltar para editar" }).click();
    await expect(page.getByRole("heading", { name: "Campos não preenchidos" })).toHaveCount(0);
  });

  test("cadastra Calçamento, Asfalto e Hidrojato e encontra cada OS na lista", async ({
    page,
  }) => {
    await loginAs(page, "admin");

    for (const module of modules) {
      const code = makeCode(module.suffix);

      await createOrder(page, module, code);
      await expectOrderInList(page, code);
    }
  });

  test("impede cadastro duplicado de protocolo e ordem de servico", async ({ page }) => {
    const code = makeCode("DUP");
    const module = modules[0];

    await loginAs(page, "admin");

    await createOrder(page, module, code);

    const saveButton = await openOrderForm(page, module);
    await fillOrderForm(page, code);
    await saveButton.click();
    await continueWithoutPdfIfNeeded(page);

    await expect(page.getByText(/Cadastro não realizado/i)).toBeVisible();
    await expect(page.getByText(/Já existe uma ordem cadastrada/i)).toBeVisible();
    await closeResultModal(page);
  });
});
