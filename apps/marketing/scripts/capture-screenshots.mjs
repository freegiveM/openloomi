// Capture screenshots of the running OpenLoomi (Tauri dev shares the same
// Next.js server on :3515) for the marketing docs.
//
// Each entry: which slug folder under /img/openloomi/ to drop into, the URL
// fragment after host, the PNG file name, and how to wait for the page to
// be ready.
//   wait: <ms>                       — fixed sleep
//   wait: { selector: '...' }        — wait for a specific element
//
// We log every save so we can see where files actually land.
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { stat } from "node:fs/promises";
import path from "node:path";

const BASE = process.env.LOOMI_BASE_URL || "http://localhost:3515";
const OUT = path.resolve("apps/marketing/public/img/openloomi");

const PAGES = [
  { slug: "what-is-openloomi",     url: "/",                                file: "chat.png",            wait: 8000 },
  { slug: "what-is-openloomi",     url: "/brief",                           file: "brief.png",           wait: 8000 },
  { slug: "chat",                  url: "/?page=chat",                      file: "chat.png",            wait: { selector: "textarea, [contenteditable], main" } },
  { slug: "loop",                  url: "/brief",                           file: "brief.png",           wait: 10000 },
  { slug: "loop",                  url: "/wrap",                            file: "wrap.png",            wait: 10000 },
  { slug: "loop",                  url: "/inbox",                           file: "inbox.png",           wait: 10000 },
  { slug: "loop",                  url: "/scheduled-jobs",                  file: "scheduled-jobs.png",  wait: 8000 },
  { slug: "connectors",            url: "/connectors",                      file: "connectors.png",      wait: { selector: "[data-platform], button" } },
  { slug: "scheduled-jobs",        url: "/scheduled-jobs",                  file: "jobs-list.png",       wait: { selector: "table, [role='list'], main" } },
  { slug: "scheduled-jobs",        url: "/scheduled-jobs/new",              file: "jobs-new.png",        wait: 8000 },
  { slug: "skills",                url: "/skills",                          file: "skills.png",          wait: 8000 },
  { slug: "audit",                 url: "/audit",                           file: "audit.png",           wait: { selector: "table, [role='list'], main" } },
  { slug: "storage-management",    url: "/?page=storage-management",        file: "storage.png",         wait: 8000 },
  { slug: "onboarding",            url: "/?page=ai-api-settings",           file: "ai-settings.png",     wait: { selector: "form, input, select, main" } },
  { slug: "onboarding",            url: "/?page=openloomi-soul",            file: "soul.png",            wait: { selector: "textarea, main" } },
  { slug: "onboarding",            url: "/?page=profile",                   file: "profile.png",         wait: { selector: "form, input, main" } },
  { slug: "onboarding",            url: "/?page=account-settings",          file: "account-settings.png",wait: { selector: "form, input, main" } },
  { slug: "global-search",         url: "/?page=chat",                      file: "chat.png",            wait: { selector: "textarea, [contenteditable]" } },
  { slug: "getting-started",       url: "/?page=ai-api-settings",           file: "ai-settings.png",     wait: { selector: "form, input, select" } },
  { slug: "settings-reference",    url: "/?page=profile",                   file: "profile.png",         wait: { selector: "form, input, main" } },
];

const NETWORK_IDLE_TIMEOUT_MS = 30000;
const SELECTOR_TIMEOUT_MS     = 15000;
const FIXED_FALLBACK_MS       = 5000;

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
});

console.log("→ login as guest");
{
  const page = await context.newPage();
  await page.goto(`${BASE}/guest-login`, { waitUntil: "domcontentloaded", timeout: 60000 });
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(1000);
    const u = page.url();
    if (u === `${BASE}/` || u === `${BASE}` || u.startsWith(`${BASE}/?page=`)) break;
  }
  await page.close();
}

console.log(`→ capturing screenshots into ${OUT}`);
for (const target of PAGES) {
  const page = await context.newPage();
  try {
    await page.goto(`${BASE}${target.url}`, { waitUntil: "domcontentloaded", timeout: 60000 });

    try {
      await page.waitForLoadState("networkidle", { timeout: NETWORK_IDLE_TIMEOUT_MS });
    } catch {
      console.warn(`  ! ${target.url} didn't reach networkidle within ${NETWORK_IDLE_TIMEOUT_MS}ms`);
    }

    const w = target.wait;
    if (typeof w === "number") {
      await page.waitForTimeout(w);
    } else if (w && typeof w === "object" && w.selector) {
      try {
        await page.waitForSelector(w.selector, { timeout: SELECTOR_TIMEOUT_MS, state: "visible" });
      } catch {
        console.warn(`  ! ${target.url} selector "${w.selector}" didn't appear`);
      }
      await page.waitForTimeout(FIXED_FALLBACK_MS);
    }

    const dir = path.join(OUT, target.slug);
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, target.file);
    const buf = await page.screenshot({ fullPage: false });
    await writeFile(filePath, buf);
    const s = await stat(filePath);
    console.log(`✓ ${target.slug}/${target.file}  ←  ${target.url}  (${(s.size / 1024).toFixed(1)} KB)`);
  } catch (e) {
    console.warn(`✗ ${target.slug}/${target.file}  (${(e.message || e).toString().split("\n")[0]})`);
  } finally {
    await page.close();
  }
}

await browser.close();
console.log("done.");