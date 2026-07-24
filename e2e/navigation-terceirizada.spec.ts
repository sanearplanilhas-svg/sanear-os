import { expect, test } from "@playwright/test";
import { expectTopbarTitle, loginAs } from "./helpers";

test.describe("Navegacao como terceirizada", () => {
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name.includes("mobile"), "Este teste usa a sidebar desktop.");
  });

  test("terceirizada entra direto na area permitida", async ({ page }) => {
    await loginAs(page, "terceirizada");

    await expectTopbarTitle(page, "Visão da Terceirizada");
    await expect(page.locator(".sidebar").getByText("Área da Terceirizada")).toBeVisible();
    await expect(page.locator(".sidebar").getByText("Calçamento")).toHaveCount(0);
    await expect(page.locator(".sidebar").getByText("Backup")).toHaveCount(0);
  });
});
