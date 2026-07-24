import { expect, type Page } from "@playwright/test";

export type TestRole = "admin" | "operador" | "terceirizada";

type Credentials = {
  email: string;
  password: string;
};

function env(name: string): string {
  return process.env[name]?.trim() ?? "";
}

export function credentialsFor(role: TestRole): Credentials {
  const prefix = role.toUpperCase();

  const email =
    env(`E2E_${prefix}_EMAIL`) ||
    env(`TEST_${prefix}_EMAIL`);

  const password =
    env(`E2E_${prefix}_PASSWORD`) ||
    env(`TEST_${prefix}_PASSWORD`);

  if (!email || !password) {
    throw new Error(
      `Preencha E2E_${prefix}_EMAIL e E2E_${prefix}_PASSWORD no .env.e2e.local.`
    );
  }

  return { email, password };
}

export function writeTestsEnabled(): boolean {
  return env("E2E_ENABLE_WRITE_TESTS").toLowerCase() === "true";
}

export async function loginAs(page: Page, role: TestRole) {
  const credentials = credentialsFor(role);

  async function openCleanLogin() {
    await page.goto("/");
    await page.evaluate(() => {
      window.localStorage.clear();
      window.sessionStorage.clear();
    });
    await page.goto("/");
  }

  async function submitLogin() {
    await page.getByPlaceholder("seu@email.com").fill(credentials.email);
    await page.getByPlaceholder("Digite sua senha").fill(credentials.password);
    await page.getByRole("button", { name: "Entrar" }).click();
    await expect(page.locator(".app-shell")).toBeVisible({ timeout: 30_000 });
  }

  await openCleanLogin();

  if (await page.locator(".app-shell").count()) {
    await expect(page.locator(".app-shell")).toBeVisible();
    return;
  }

  try {
    await submitLogin();
  } catch {
    await openCleanLogin();
    if (await page.locator(".app-shell").count()) {
      await expect(page.locator(".app-shell")).toBeVisible();
      return;
    }
    await submitLogin();
  }
}

export async function logout(page: Page) {
  const sair = page.getByRole("button", { name: /sair/i });
  if (await sair.count()) {
    await sair.first().click();
  }
}

export async function goToSidebar(page: Page, label: string) {
  await page
    .locator(".sidebar")
    .getByRole("button", { name: new RegExp(label, "i") })
    .first()
    .click();
}

export async function expectTopbarTitle(page: Page, title: string | RegExp) {
  await expect(page.locator(".topbar-page-title")).toHaveText(title);
}

export async function fillPageField(page: Page, label: string, value: string) {
  await page
    .locator(".page-field")
    .filter({ hasText: label })
    .locator("input, textarea")
    .first()
    .fill(value);
}
