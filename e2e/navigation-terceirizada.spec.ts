import { expect, test } from "@playwright/test";
import { expectTopbarTitle, goToSidebar, loginAs } from "./helpers";

test.describe("Navegacao como terceirizada", () => {
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name.includes("mobile"), "Este teste usa a sidebar desktop.");
  });

  test("terceirizada acessa Dashboard e Area da Terceirizada", async ({ page }) => {
    await loginAs(page, "terceirizada");

    // Com a nova permissao, a terceirizada agora inicia no Dashboard.
    await expectTopbarTitle(page, "Dashboard");
    await expect(page.locator(".sidebar").getByText("Dashboard")).toBeVisible();
    await expect(page.locator(".sidebar").getByText("Área da Terceirizada")).toBeVisible();

    // Continua sem acesso aos menus administrativos/cadastrais.
    await expect(page.locator(".sidebar").getByText("Calçamento")).toHaveCount(0);
    await expect(page.locator(".sidebar").getByText("Backup")).toHaveCount(0);

    await goToSidebar(page, "Área da Terceirizada");
    await expectTopbarTitle(page, "Visão da Terceirizada");
  });
});
