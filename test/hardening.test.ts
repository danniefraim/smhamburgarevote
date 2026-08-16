/**
 * Härdningar efter tillförlitlighetsgranskningen inför tävlingsdagen.
 * OBS: som i api.test.ts delar filen databas och körs i ordning —
 * kriterietestet utan röster ligger därför FÖRST, före första rösten.
 */
import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

const ADMIN = { authorization: "Bearer test-admin-token" };

const CARD = {
  asa1: "eeeeeee1-0000-4000-8000-000000000001",
  asa2: "eeeeeee1-0000-4000-8000-000000000002",
  asa3: "eeeeeee1-0000-4000-8000-000000000003",
  lock: "eeeeeee1-0000-4000-8000-000000000004",
  csv: "eeeeeee1-0000-4000-8000-000000000005",
  merg1: "eeeeeee1-0000-4000-8000-000000000006",
  merg2: "eeeeeee1-0000-4000-8000-000000000007",
  merg3: "eeeeeee1-0000-4000-8000-000000000008",
};

function post(path: string, body: unknown, admin = false): Promise<Response> {
  return SELF.fetch(`http://t${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(admin ? ADMIN : {}) },
    body: JSON.stringify(body),
  });
}
const get = (path: string, admin = false) => SELF.fetch(`http://t${path}`, { headers: admin ? ADMIN : {} });
const patch = (path: string, body: unknown) =>
  SELF.fetch(`http://t${path}`, {
    method: "PATCH",
    headers: { ...ADMIN, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

function scores(n: number): Record<string, number> {
  return { smak: n, textur: n, utseende: n, kreativitet: n };
}

const judgeIdOf = (kortid: string) =>
  env.DB.prepare("SELECT judge_id FROM votes WHERE kortid = ?")
    .bind(kortid)
    .first<{ judge_id: number }>()
    .then((r) => r!.judge_id);

beforeAll(async () => {
  await SELF.fetch("http://t/api/admin/cards/import", {
    method: "POST",
    headers: ADMIN,
    body: Object.values(CARD)
      .map((kortid) => `${kortid};HARD`)
      .join("\n"),
  });
});

describe("kriteriespärr", () => {
  it("utan röster går kriterier att skapa och redigera", async () => {
    const res = await post("/api/admin/criteria", { key: "provkrit", label: "Provkriterium", weight: 0.1 }, true);
    expect(res.status).toBe(201);
    const created = ((await res.json()) as { criterion: { id: number } }).criterion;
    // Städa undan: avaktivera så att röstvalideringen nedan inte kräver poäng för det.
    expect((await patch(`/api/admin/criteria/${created.id}`, { active: false })).status).toBe(200);
  });

  it("med röster: nytt kriterium och återaktivering ger 409, vikt/etikett går fortfarande", async () => {
    await post("/api/vote", { kortid: CARD.lock, judge: "Låsdomaren", scores: scores(5) });

    const blocked = await post("/api/admin/criteria", { key: "doft", label: "Doft", weight: 0.1 }, true);
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { code: string }).code).toBe("locked");

    const provkrit = ((await (await get("/api/admin/criteria", true)).json()) as {
      criteria: { id: number; key: string; active: number }[];
    }).criteria.find((c) => c.key === "provkrit")!;
    expect(provkrit.active).toBe(0);
    const reactivate = await patch(`/api/admin/criteria/${provkrit.id}`, { active: true });
    expect(reactivate.status).toBe(409);

    const smak = ((await (await get("/api/admin/criteria", true)).json()) as {
      criteria: { id: number; key: string }[];
    }).criteria.find((c) => c.key === "smak")!;
    // Vikt/etikett (och att spara ett redan aktivt kriterium med active: true) är ofarligt.
    expect((await patch(`/api/admin/criteria/${smak.id}`, { label: "Smak/Arom", weight: 0.45, active: true })).status).toBe(200);
    // Resultaten räknas fortfarande — spärren skyddade motorn.
    expect((await get("/api/admin/results", true)).status).toBe(200);
  });
});

describe("domarnamn: skiftläge med Å/Ä/Ö", () => {
  it("migrationen har normaliserat seedade namn", async () => {
    const row = await env.DB.prepare("SELECT name_norm FROM judges WHERE name = 'Johan Broström'").first<{
      name_norm: string;
    }>();
    expect(row!.name_norm).toBe("johan broström");
  });

  it("Åsa, åsa och ÅSA är samma domare", async () => {
    await post("/api/vote", { kortid: CARD.asa1, judge: "Åsa Testberg", scores: scores(7) });
    await post("/api/vote", { kortid: CARD.asa2, judge: "åsa testberg", scores: scores(8) });
    expect(await judgeIdOf(CARD.asa2)).toBe(await judgeIdOf(CARD.asa1));

    // Rättelseflödet använder samma uppslag.
    await post("/api/vote", { kortid: CARD.asa3, judge: "Tillfällig", scores: scores(5) });
    await patch(`/api/admin/votes/${CARD.asa3}`, { judge: "ÅSA TESTBERG", reason: "Fel domare på kortet" });
    expect(await judgeIdOf(CARD.asa3)).toBe(await judgeIdOf(CARD.asa1));

    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM judges WHERE name_norm = 'åsa testberg'").first<{
      n: number;
    }>();
    expect(rows!.n).toBe(1);
  });

  it("sammanslagning + ångra följer namnet även i gemen Ö-variant", async () => {
    await post("/api/vote", { kortid: CARD.merg1, judge: "Örjan Eek", scores: scores(6) });
    await post("/api/vote", { kortid: CARD.merg2, judge: "Örjan Ek", scores: scores(4) });
    const judges = ((await (await get("/api/admin/judges", true)).json()) as {
      judges: { id: number; name: string }[];
    }).judges;
    const from = judges.find((j) => j.name === "Örjan Eek")!;
    const to = judges.find((j) => j.name === "Örjan Ek")!;
    await post("/api/admin/judges/merge", { fromId: from.id, toId: to.id }, true);

    // Under slagningen: gemen variant av variantnamnet hamnar också på målet.
    await post("/api/vote", { kortid: CARD.merg3, judge: "örjan eek", scores: scores(2) });
    expect(await judgeIdOf(CARD.merg3)).toBe(to.id);

    const merge = ((await (await get("/api/admin/judges", true)).json()) as {
      merges: { id: number; from_name: string }[];
    }).merges.find((m) => m.from_name === "Örjan Eek")!;
    const undo = (await (await post(`/api/admin/judges/merge/${merge.id}/undo`, {}, true)).json()) as {
      restoredVotes: number;
    };
    // Både den flyttade rösten och den som skrevs "örjan eek" går tillbaka.
    expect(undo.restoredVotes).toBe(2);
    expect(await judgeIdOf(CARD.merg1)).toBe(from.id);
    expect(await judgeIdOf(CARD.merg3)).toBe(from.id);
    expect(await judgeIdOf(CARD.merg2)).toBe(to.id);
  });
});

describe("avvisade försök loggas kapat", () => {
  it("jättepayload ger 400 och kapade fält i submission_log", async () => {
    const junkScores: Record<string, number> = {};
    for (let i = 0; i < 1000; i++) junkScores[`k${i}`] = 5;
    const res = await post("/api/vote", {
      kortid: "x".repeat(500),
      judge: "Å".repeat(300),
      scores: junkScores,
    });
    expect(res.status).toBe(400);
    const log = await env.DB.prepare(
      "SELECT LENGTH(kortid) AS klen, LENGTH(judge_name) AS jlen, LENGTH(scores) AS slen FROM submission_log WHERE accepted = 0 ORDER BY id DESC LIMIT 1",
    ).first<{ klen: number; jlen: number; slen: number }>();
    expect(log!.klen).toBeLessThanOrEqual(100);
    expect(log!.jlen).toBeLessThanOrEqual(200);
    expect(log!.slen).toBeLessThanOrEqual(2000);
  });
});

describe("CSV-exporten", () => {
  it("neutraliserar formelinledande fält och visar svensk tid", async () => {
    await post("/api/vote", { kortid: CARD.csv, judge: "Exceldomaren", scores: scores(9), comment: "=SUM(1)" });
    const text = await (await get("/api/admin/export.csv", true)).text();
    expect(text).toContain("'=SUM(1)");
    expect(text).not.toContain(";=SUM(1)");

    const created = (await env.DB.prepare("SELECT created_at FROM votes WHERE kortid = ?").bind(CARD.csv).first<{
      created_at: string;
    }>())!.created_at;
    const parts: Record<string, string> = {};
    for (const p of new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Europe/Stockholm",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(created.replace(" ", "T") + "Z"))) {
      parts[p.type] = p.value;
    }
    const expected = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
    const csvRow = text.split("\n").find((l) => l.includes("Exceldomaren"))!;
    expect(csvRow).toContain(expected);
    // Stockholm ligger alltid före UTC — exporten får inte visa råa UTC-stämpeln.
    expect(expected).not.toBe(created);
  });
});
