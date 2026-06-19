// Headless browser smoke check used by `make verify-ui`.
//
// Trusted surface: this file is write-denied in .claude/settings.json so the
// agent can run it (via `make verify-ui`) but cannot widen it. It only opens a
// URL and reports — it never takes free-form code.
//
//   make verify-ui URL=http://localhost:7373/?dir=...&path=...  [TESTIDS=a,b]
import { chromium } from "@playwright/test";

const url = process.argv[2] || process.env.URL;
if (!url) {
  console.error(
    "usage: node scripts/dev/verify-ui.mjs <url> [testid,testid,...]",
  );
  process.exit(2);
}

const testids = (process.argv[3] || process.env.TESTIDS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));

await page.goto(url, { waitUntil: "load" });
await page.waitForTimeout(1800);

console.log("URL:", url);
console.log("table count:", await page.locator("table").count());
for (const testid of testids) {
  console.log(`testid ${testid}:`, await page.getByTestId(testid).count());
}
const body = (await page.locator("body").innerText())
  .replace(/\s+/g, " ")
  .slice(0, 400);
console.log("body:", body);
console.log("pageerrors:", errors.length ? errors : "none");

await browser.close();
