import { expect, type Page, test } from "@playwright/test";
import { credentialsFor, expectTopbarTitle, goToSidebar, loginAs, writeTestsEnabled } from "./helpers";

type CollectionName = "ordens_servico" | "ordensServico";

type CreatedDocument = {
  collection: CollectionName;
  documentName: string;
  protocolo: string;
};

const createdDocuments: CreatedDocument[] = [];

function env(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function envOrThrow(name: string): string {
  const value = env(name);
  if (!value) throw new Error(`Preencha ${name} no .env.local ou .env.e2e.local.`);
  return value;
}

function makeCode(): string {
  return `E2E-N3-${Date.now()}`;
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
    throw new Error(`Login admin para preparar Nivel 3 falhou (${response.status}).`);
  }

  const data = (await response.json()) as { idToken?: string; localId?: string; email?: string };
  if (!data.idToken || !data.localId) {
    throw new Error("Firebase nao retornou token/uid para preparar Nivel 3.");
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
}): Promise<CreatedDocument> {
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
          rua: fsString("RUA TESTE TERCEIRIZADA"),
          numero: fsString("S/N"),
          pontoReferencia: fsString("TESTE PLAYWRIGHT NIVEL 3"),
          referencia: fsString("TESTE PLAYWRIGHT NIVEL 3"),
          observacoes: fsString("OS TEMPORARIA PARA TESTE E2E NIVEL 3"),
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
    throw new Error(`Criacao da OS temporaria Nivel 3 falhou (${response.status}): ${await response.text()}`);
  }

  const data = (await response.json()) as { name?: string };
  if (!data.name) throw new Error("Firestore nao retornou o nome do documento criado.");

  const created = {
    collection,
    documentName: data.name,
    protocolo: params.protocolo,
  };
  createdDocuments.push(created);
  return created;
}

async function deleteDocument(token: string, documentName: string) {
  const response = await fetch(`https://firestore.googleapis.com/v1/${documentName}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok && response.status !== 404) {
    throw new Error(`Limpeza Nivel 3 falhou (${response.status}): ${await response.text()}`);
  }
}

async function findDocumentByProtocol(token: string, collection: CollectionName, protocolo: string) {
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
              value: fsString(protocolo),
            },
          },
          limit: 1,
        },
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`Consulta Nivel 3 falhou (${response.status}): ${await response.text()}`);
  }

  const rows = (await response.json()) as Array<{
    document?: { fields?: Record<string, { stringValue?: string }> };
  }>;

  return rows.find((row) => row.document)?.document ?? null;
}

async function statusByProtocol(token: string, collection: CollectionName, protocolo: string) {
  const document = await findDocumentByProtocol(token, collection, protocolo);
  return document?.fields?.status?.stringValue ?? "";
}

async function cleanupCreatedDocuments() {
  if (!createdDocuments.length) return;

  const { token } = await adminTokenAndUid();
  const pending = createdDocuments.splice(0);

  for (const document of pending) {
    await deleteDocument(token, document.documentName);
  }
}

async function openTemporaryOrderInTerceirizada(page: Page, protocolo: string) {
  await loginAs(page, "terceirizada");

  // Depois que a terceirizada passou a ter acesso ao Dashboard,
  // ela pode iniciar no Painel. Para este fluxo operacional,
  // o teste entra explicitamente na Área da Terceirizada.
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

test.describe.configure({ mode: "serial" });

test.describe("Nivel 3 - fluxo operacional da terceirizada", () => {
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name.includes("mobile"), "Nivel 3 fica apenas no desktop.");
    test.skip(!writeTestsEnabled(), "Rode com -WriteTests para criar OS temporaria no banco.");
  });

  test.afterEach(async () => {
    await cleanupCreatedDocuments();
  });

  test("terceirizada marca Aguardando SANEAR e depois retoma a OS", async ({ page }) => {
    const admin = await adminTokenAndUid();
    const protocolo = makeCode();
    const order = await createTemporaryOrder({ ...admin, protocolo });

    const detailsModal = await openTemporaryOrderInTerceirizada(page, protocolo);

    await detailsModal.getByRole("button", { name: "Aguardando SANEAR" }).click();

    const aguardandoModal = page.locator(".modal").filter({ hasText: "Descrição (curta e objetiva)" }).first();
    await expect(aguardandoModal).toBeVisible();
    await aguardandoModal
      .locator("textarea")
      .fill("Teste automatizado: aguardando liberacao da SANEAR.");
    await aguardandoModal.getByRole("button", { name: "Confirmar" }).click();

    await expect(page.getByRole("button", { name: /SANEAR liberou/i })).toBeVisible({
      timeout: 15_000,
    });

    await expect
      .poll(() => statusByProtocol(admin.token, order.collection, protocolo), { timeout: 20_000 })
      .toBe("AGUARDANDO_SANEAR");

    await page.getByRole("button", { name: /SANEAR liberou/i }).click();

    await expect(detailsModal.getByRole("button", { name: "Aguardando SANEAR" })).toBeVisible({
      timeout: 15_000,
    });

    await expect
      .poll(() => statusByProtocol(admin.token, order.collection, protocolo), { timeout: 20_000 })
      .toBe("ABERTA");
  });
});
