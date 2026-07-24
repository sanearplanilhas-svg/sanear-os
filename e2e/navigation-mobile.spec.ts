import { expect, test } from "@playwright/test";
import { expectTopbarTitle, loginAs } from "./helpers";

test.describe("Navegacao mobile", () => {
  test.beforeEach(async ({}, testInfo) => {
    test.skip(!testInfo.project.name.includes("mobile"), "Teste exclusivo do layout mobile.");
  });

  test("admin navega pela barra inferior e menus moveis", async ({ page }) => {
    await loginAs(page, "admin");

    const mobileNav = page.locator(".mobile-bottom-nav");

    await mobileNav.getByRole("button", { name: "Painel", exact: true }).click();
    await expectTopbarTitle(page, "Dashboard");

    await mobileNav.getByRole("button", { name: "OS", exact: true }).click();
    await expectTopbarTitle(page, "Lista de Ordens de Serviço");

    await mobileNav.getByRole("button", { name: "SANEAR", exact: true }).click();
    await expectTopbarTitle(page, "Área de Serviço SANEAR");

    await mobileNav.getByRole("button", { name: "Abrir nova ordem de serviço" }).click();
    await expect(page.getByRole("dialog", { name: "Nova ordem de serviço" })).toBeVisible();
    await page.getByRole("button", { name: /Calçamento/i }).click();
    await expectTopbarTitle(page, "Calçamento");

    await mobileNav.getByRole("button", { name: "Mais opções" }).click();
    const moreDialog = page.getByRole("dialog", { name: "Mais opções" });
    await expect(moreDialog).toBeVisible();
    await moreDialog.getByRole("button", { name: /Usuário/i }).click();
    await expectTopbarTitle(page, "Usuário");
  });

  test("terceirizada usa barra inferior limitada", async ({ page }) => {
    await loginAs(page, "terceirizada");

    await expectTopbarTitle(page, "Visão da Terceirizada");
    const mobileNav = page.locator(".mobile-bottom-nav");
    await expect(mobileNav.getByRole("button", { name: "Área", exact: true })).toBeVisible();
    await expect(mobileNav.getByRole("button", { name: "Anexos", exact: true })).toBeVisible();
    await expect(mobileNav.getByRole("button", { name: "Notificações" })).toBeVisible();
    await expect(mobileNav.getByRole("button", { name: "Sair" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Abrir nova ordem de serviço" })).toHaveCount(0);
  });
});
