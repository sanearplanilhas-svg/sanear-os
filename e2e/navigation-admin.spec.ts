import { expect, test } from "@playwright/test";
import { expectTopbarTitle, goToSidebar, loginAs } from "./helpers";

test.describe("Navegacao principal como admin", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name.includes("mobile"), "A navegacao por sidebar e testada apenas no desktop.");
    await loginAs(page, "admin");
  });

  const pages = [
    { menu: "Dashboard", title: "Dashboard" },
    { menu: "Lista de OS", title: "Lista de Ordens de Serviço" },
    { menu: "Calçamento", title: "Calçamento" },
    { menu: "Asfalto", title: "Asfalto" },
    { menu: "Caminhão Hidrojato", title: "Caminhão Hidrojato" },
    { menu: "Área de Serviço SANEAR", title: "Área de Serviço SANEAR" },
    { menu: "Área da Terceirizada", title: "Visão da Terceirizada" },
    { menu: "Usuário", title: "Usuário" },
    { menu: "Backup", title: "Backup" },
  ];

  for (const item of pages) {
    test(`abre ${item.title}`, async ({ page }) => {
      await goToSidebar(page, item.menu);
      await expectTopbarTitle(page, item.title);
      await expect(page.locator(".page-wrapper")).toBeVisible();
    });
  }
});
