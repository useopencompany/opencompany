import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const authTransitionPathPattern = /^\/auth\/(?:sign-in|sign-up|sign-out)$/;
const authLinkHrefPattern = /href=(?:"|')\/auth\/(?:sign-in|sign-up|sign-out)(?:"|')/;

test("public signup page loads", async ({ page }) => {
  await page.goto("/signup");

  await expect(page.getByRole("heading", { name: "Sign up for opencompany" })).toBeVisible();
});

test("docs page renders", async ({ page }) => {
  await page.goto("/docs");

  await expect(page.getByRole("heading", { name: "Welcome to opencompany" })).toBeVisible();
});

test("protected routes redirect unauthenticated visitors", async ({ page }) => {
  await page.goto("/agents", { waitUntil: "domcontentloaded" });

  await expect.poll(() => page.url()).not.toContain("/agents");
});

test("public auth CTAs use document navigation instead of RSC fetches", async ({ page }) => {
  await page.goto("/signup");
  await expect(page.getByRole("heading", { name: "Sign up for opencompany" })).toBeVisible();

  const signUpRequest = await captureAuthNavigation(page, "/auth/sign-up", async () => {
    await page.getByRole("link", { name: /^Sign up$/ }).click();
  });

  expect(signUpRequest.resourceType).toBe("document");
  expect(signUpRequest.hasRscParam).toBe(false);

  await page.goto("/signup");
  await expect(page.getByRole("heading", { name: "Sign up for opencompany" })).toBeVisible();

  const signInRequest = await captureAuthNavigation(page, "/auth/sign-in", async () => {
    await page.getByRole("link", { name: /^Sign in$/ }).click();
  });

  expect(signInRequest.resourceType).toBe("document");
  expect(signInRequest.hasRscParam).toBe(false);
});

test("auth transition endpoints are not rendered with next/link", async () => {
  const files = await collectFiles(["app", "components", "lib"]);
  const violations: string[] = [];

  for (const file of files) {
    const source = await readFile(file, "utf8");
    if (!source.includes('from "next/link"') && !source.includes("from 'next/link'")) {
      continue;
    }

    const linkBlocks = source.match(/<Link[\s\S]*?(?:<\/Link>|\/>)/g) ?? [];
    if (linkBlocks.some((block) => authLinkHrefPattern.test(block))) {
      violations.push(path.relative(webRoot, file));
    }
  }

  expect(violations).toEqual([]);
});

async function captureAuthNavigation(page: Page, pathname: string, click: () => Promise<void>) {
  let observedRequest: { resourceType: string; hasRscParam: boolean } | undefined;

  await page.route(`**${pathname}**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname !== pathname || !authTransitionPathPattern.test(url.pathname)) {
      await route.continue();
      return;
    }

    observedRequest = {
      resourceType: request.resourceType(),
      hasRscParam: url.searchParams.has("_rsc"),
    };

    await route.fulfill({
      status: 204,
      contentType: "text/html",
      body: "",
    });
  });

  await click();

  await expect.poll(() => observedRequest).toBeTruthy();
  await page.unroute(`**${pathname}**`);

  return observedRequest!;
}

async function collectFiles(relativeDirs: string[]) {
  const files: string[] = [];

  async function walk(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && fullPath.endsWith(".tsx")) {
        files.push(fullPath);
      }
    }
  }

  for (const relativeDir of relativeDirs) {
    await walk(path.join(webRoot, relativeDir));
  }

  return files;
}
