import { expect, test } from "@playwright/test";

test("public signup page loads", async ({ page }) => {
  await page.goto("/signup");

  await expect(page.getByRole("heading", { name: "Sign up for opencompany" })).toBeVisible();
});

test("docs page renders", async ({ page }) => {
  await page.goto("/docs");

  await expect(page.getByRole("heading", { name: "Getting started" })).toBeVisible();
});

test("protected routes redirect unauthenticated visitors", async ({ page }) => {
  await page.goto("/agents", { waitUntil: "domcontentloaded" });

  await expect.poll(() => page.url()).not.toContain("/agents");
});
