/**
 * E2E-generalrepetition mot lokal dev-server (http://localhost:8787).
 *
 * Förberedelser (engångs):
 *   npm i -D playwright && npx playwright install chromium
 * Kör:
 *   npm run dev                      (i ett annat fönster)
 *   node tools/e2e.js
 *
 * Skriptet förutsätter demodata: kort enligt CANDIDATE_CARDS på gruppkod DEMO
 * kopplad till ett lag, plus ADMIN_TOKEN nedan i .dev.vars. Se README.
 * Skärmdumpar hamnar i tools/e2e-shots/.
 */
const { chromium } = require("playwright");
const path = require("path");

const BASE = process.env.E2E_BASE || "http://localhost:8787";
const TOKEN = process.env.E2E_TOKEN || "lokal-test-nyckel";
const CANDIDATE_CARDS = [
  "aaaaaaa1-0000-4000-8000-000000000002",
  "aaaaaaa1-0000-4000-8000-000000000003",
  "aaaaaaa1-0000-4000-8000-000000000004",
  "aaaaaaa1-0000-4000-8000-000000000005",
];
const SHOTS = path.join(__dirname, "e2e-shots");

function fail(msg) { throw new Error("E2E-FEL: " + msg); }

async function pickUnusedCard() {
  for (const kortid of CANDIDATE_CARDS) {
    const res = await fetch(`${BASE}/api/card/${kortid}`);
    if (res.ok) {
      const data = await res.json();
      if (!data.used) return kortid;
    }
  }
  throw new Error("Inga oanvända demokort kvar — rensa .wrangler och seeda om, se README.");
}

(async () => {
  const fs = require("fs");
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const consoleErrors = [];
  const trackErrors = (p, label) => {
    p.on("console", (m) => {
      if (m.type() !== "error") return;
      const url = (m.location() && m.location().url) || "";
      if (url.includes("favicon")) return;
      // 404 på kortuppslag är ett förväntat API-svar (okänt kort), inte ett fel.
      if (url.includes("/api/card/")) return;
      consoleErrors.push(label + ": " + m.text() + " [" + url + "]");
    });
    p.on("pageerror", (e) => consoleErrors.push(label + ": " + String(e)));
  };
  trackErrors(page, "rösta");

  const CARD = await pickUnusedCard();

  // ---- 1. Röstsidan: fyll i och skicka ----
  await page.goto(`${BASE}/?lagkod=DEMO&kortid=${CARD}`);
  await page.waitForSelector("#judge");
  await page.fill("#judge", "Browser-Testare");
  const pick = async (key, v) => page.click(`.btns[data-key="${key}"] button[data-v="${v}"]`);
  await pick("smak", 8);
  await pick("textur", 7);
  await pick("utseende", 9);
  await pick("kreativitet", 8);
  await page.fill("#comment", "Saftig och fin sälta. Brödet kunde rostats lite mer.");
  const disabled = await page.$eval("#submitBtn", (b) => b.disabled);
  if (disabled) fail("Skicka-knappen är fortfarande inaktiverad trots komplett formulär");
  await page.screenshot({ path: path.join(SHOTS, "1-rosta-ifylld.png"), fullPage: true });
  await page.click("#submitBtn");
  await page.waitForSelector("text=Tack, din röst är registrerad!", { timeout: 5000 });
  await page.screenshot({ path: path.join(SHOTS, "2-rosta-klar.png") });
  console.log("✓ Röst inskickad via UI");

  // ---- 2. Samma kort igen: redan registrerat ----
  await page.goto(`${BASE}/?lagkod=DEMO&kortid=${CARD}`);
  await page.waitForSelector("text=redan registrerat");
  console.log("✓ Omscannat kort visar 'redan registrerat'");

  // ---- 3. Okänt kort ----
  await page.goto(`${BASE}/?lagkod=XXXX&kortid=99999999-9999-4999-8999-999999999999`);
  await page.waitForSelector("text=Kortet kunde inte hittas");
  console.log("✓ Okänt kort hanteras");

  // ---- 4. Admin: login, översikt, resultat, publicera ----
  const desktop = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const admin = await desktop.newPage();
  trackErrors(admin, "admin");
  await admin.goto(`${BASE}/admin.html`);
  await admin.fill("#tok", TOKEN);
  await admin.click("#loginBtn");
  await admin.waitForSelector("text=Bidrag");
  console.log("✓ Admin-login och översikt");

  await admin.click('nav button[data-v="resultat"]');
  await admin.waitForSelector("text=Domarnas stränghet");
  const resText = await admin.textContent("#main");
  if (!resText.includes("Browser-Testare")) fail("Domaren från UI-rösten saknas i stränghetstabellen");
  await admin.screenshot({ path: path.join(SHOTS, "3-admin-resultat.png"), fullPage: true });

  admin.once("dialog", (d) => d.accept());
  await admin.click("#revealBtn");
  await admin.waitForSelector("text=Dölj publika resultat");
  console.log("✓ Resultat publicerade via admin");

  // ---- 5. Publika resultatsidan ----
  const pub = await ctx.newPage();
  trackErrors(pub, "resultat");
  await pub.goto(`${BASE}/resultat.html`);
  await pub.waitForSelector("text=Freestyle");
  await pub.screenshot({ path: path.join(SHOTS, "4-publikt-resultat.png"), fullPage: true });
  console.log("✓ Publik resultatsida visar ställningen");

  // ---- 6. Dölj igen + kontrollera konsolfel ----
  admin.once("dialog", (d) => d.accept());
  await admin.click("#revealBtn");
  await admin.waitForSelector("text=Publicera resultat publikt");

  if (consoleErrors.length) fail("Konsolfel: " + consoleErrors.join(" ;; "));
  console.log("✓ Inga konsolfel");

  await browser.close();
  console.log("\nALLA E2E-STEG GRÖNA");
})().catch((e) => { console.error(e); process.exit(1); });
