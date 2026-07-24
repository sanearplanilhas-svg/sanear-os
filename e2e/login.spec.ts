import { expect, test } from "@playwright/test";
import { loginAs } from "./helpers";

test.describe("Login e modais iniciais", () => {
  test("abre tela de login e modais de ajuda", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { name: "Sanear Operacional" })).toBeVisible();
    await expect(page.getByPlaceholder("seu@email.com")).toBeVisible();
    await expect(page.getByPlaceholder("Digite sua senha")).toBeVisible();

    await page.getByRole("button", { name: "Esqueceu sua senha?" }).click();
    await expect(page.getByRole("heading", { name: "Esqueceu a senha" })).toBeVisible();
    await page.getByRole("button", { name: "Fechar" }).click();

    await page.getByRole("button", { name: "Crie agora" }).click();
    await expect(page.getByRole("heading", { name: "Solicitar acesso" })).toBeVisible();
    await page.getByRole("button", { name: "Fechar" }).click();
  });

  test("admin consegue entrar no sistema", async ({ page }) => {
    await loginAs(page, "admin");
    await expect(page.locator(".topbar-page-title")).toHaveText("Dashboard");
  });
});
