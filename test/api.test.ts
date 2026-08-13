/**
 * OBS: testerna i den här filen körs i ordning och delar databas (lagringen är
 * färsk per testfil, inte per test). Filen är skriven som ett sammanhängande
 * scenario — en tävlingsdag i miniatyr. Nya tester bör använda egna kort.
 */
import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

const ADMIN = { authorization: "Bearer test-admin-token" };

const CARD = {
  sodg1: "11111111-1111-4111-8111-111111111111",
  sodg2: "22222222-2222-4222-8222-222222222222",
  abcd1: "33333333-3333-4333-8333-333333333333",
  abcd2: "44444444-4444-4444-8444-444444444444",
  efgh1: "55555555-5555-4555-8555-555555555555",
  sodg3: "66666666-6666-4666-8666-666666666666",
  efgh2: "77777777-7777-4777-8777-777777777777",
};

function post(path: string, body: unknown, admin = false): Promise<Response> {
  return SELF.fetch(`http://t${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(admin ? ADMIN : {}) },
    body: JSON.stringify(body),
  });
}
const get = (path: string, admin = false) => SELF.fetch(`http://t${path}`, { headers: admin ? ADMIN : {} });

function scores(n: number): Record<string, number> {
  return { smak: n, textur: n, utseende: n, kreativitet: n };
}

let teamAlfa = 0;
let teamBeta = 0;
let grenFreestyle = 0;

beforeAll(async () => {
  const csv = [
    `SODG;https://hamburgersm2026.compiled.se/index.html?lagkod=SODG&kortid=${CARD.sodg1};/img/SODG_1.png`,
    `${CARD.sodg2},SODG`,
    `${CARD.abcd1};ABCD`,
    `${CARD.abcd2};ABCD`,
    `${CARD.efgh1};EFGH`,
    `${CARD.sodg3};SODG`,
    `${CARD.efgh2};EFGH`,
    `denna rad är skräp`,
  ].join("\n");
  const imp = await SELF.fetch("http://t/api/admin/cards/import", {
    method: "POST",
    headers: ADMIN,
    body: csv,
  });
  const impData = (await imp.json()) as { imported: number; badLines: string[] };
  if (impData.imported !== 7 || impData.badLines.length !== 1) {
    throw new Error(`Kortimport misslyckades i setup: ${JSON.stringify(impData)}`);
  }

  const alfa = (await (await post("/api/admin/teams", { name: "Lag Alfa" }, true)).json()) as { team: { id: number } };
  const beta = (await (await post("/api/admin/teams", { name: "Lag Beta" }, true)).json()) as { team: { id: number } };
  teamAlfa = alfa.team.id;
  teamBeta = beta.team.id;
  const grenar = (await (await get("/api/admin/grenar", true)).json()) as { grenar: { id: number; name: string }[] };
  grenFreestyle = grenar.grenar.find((g) => g.name === "Freestyle")!.id;

  await post("/api/admin/assign", { lagkod: "SODG", teamId: teamAlfa, grenId: grenFreestyle }, true);
  await post("/api/admin/assign", { lagkod: "ABCD", teamId: teamBeta, grenId: grenFreestyle }, true);
});

describe("publika endpoints", () => {
  it("config levererar kriterier, domare och eventnamn", async () => {
    const data = (await (await get("/api/config")).json()) as {
      eventName: string;
      criteria: { key: string; label: string }[];
      judges: string[];
    };
    expect(data.eventName).toContain("SM i Hamburgare");
    expect(data.criteria.map((c) => c.key)).toEqual(["smak", "textur", "utseende", "kreativitet"]);
    expect(data.judges).toContain("Selin");
  });

  it("kortstatus: okänt kort ger 404, känt kort visar lagkod och används-flagga", async () => {
    expect((await get("/api/card/finns-inte")).status).toBe(404);
    const before = (await (await get(`/api/card/${CARD.sodg1}`)).json()) as { lagkod: string; used: boolean };
    expect(before.lagkod).toBe("SODG");
    expect(before.used).toBe(false);
    await post("/api/vote", { kortid: CARD.sodg1, lagkod: "SODG", judge: "Testdomare", scores: scores(7) });
    const after = (await (await get(`/api/card/${CARD.sodg1}`)).json()) as { used: boolean };
    expect(after.used).toBe(true);
  });
});

describe("röstning", () => {
  it("tar emot en giltig röst och loggar den", async () => {
    const res = await post("/api/vote", {
      kortid: CARD.sodg3,
      lagkod: "SODG",
      judge: "Anna Testsson",
      scores: scores(8),
      comment: "God burgare!",
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("accepted");
    const log = await env.DB.prepare("SELECT accepted, reason FROM submission_log WHERE kortid = ?")
      .bind(CARD.sodg3)
      .first<{ accepted: number; reason: string }>();
    expect(log).toMatchObject({ accepted: 1, reason: "accepted" });
  });

  it("först vinner: identisk omregistrering är ofarlig, avvikande flaggas som konflikt", async () => {
    const payload = { kortid: CARD.sodg2, lagkod: "SODG", judge: "Bo", scores: scores(6), comment: "" };
    await post("/api/vote", payload);

    const same = (await (await post("/api/vote", payload)).json()) as { status: string; identical: boolean };
    expect(same.status).toBe("duplicate");
    expect(same.identical).toBe(true);

    const diff = (await (
      await post("/api/vote", { ...payload, judge: "Kapare", scores: scores(10) })
    ).json()) as { status: string; identical: boolean };
    expect(diff.status).toBe("duplicate");
    expect(diff.identical).toBe(false);

    // Ursprungsrösten står kvar orörd.
    const vote = await env.DB.prepare("SELECT scores FROM votes WHERE kortid = ?").bind(CARD.sodg2).first<{ scores: string }>();
    expect(JSON.parse(vote!.scores)["smak"]).toBe(6);

    const conflicts = (await (await get("/api/admin/conflicts", true)).json()) as { conflicts: { reason: string }[] };
    expect(conflicts.conflicts.some((k) => k.reason === "duplicate_conflict")).toBe(true);
  });

  it("avvisar okänt kort, fel lagkod och ogiltiga poäng", async () => {
    const unknown = await post("/api/vote", {
      kortid: "99999999-9999-4999-8999-999999999999",
      judge: "X",
      scores: scores(5),
    });
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { code: string }).code).toBe("unknown_card");

    const mismatch = await post("/api/vote", { kortid: CARD.efgh1, lagkod: "SODG", judge: "X", scores: scores(5) });
    expect(((await mismatch.json()) as { code: string }).code).toBe("card_mismatch");

    const badScore = await post("/api/vote", {
      kortid: CARD.efgh1,
      judge: "X",
      scores: { ...scores(5), smak: 11 },
    });
    expect(((await badScore.json()) as { code: string }).code).toBe("validation");

    const missing = await post("/api/vote", {
      kortid: CARD.efgh1,
      judge: "X",
      scores: { smak: 5 },
    });
    expect(((await missing.json()) as { code: string }).code).toBe("validation");

    const decimal = await post("/api/vote", {
      kortid: CARD.efgh1,
      judge: "X",
      scores: { ...scores(5), smak: 5.5 },
    });
    expect(((await decimal.json()) as { code: string }).code).toBe("validation");
  });

  it("domarnamn normaliseras och matchas skiftlägesokänsligt mot befintliga", async () => {
    await post("/api/vote", { kortid: CARD.abcd1, judge: "  selin ,", scores: scores(7) });
    const vote = await env.DB.prepare(
      "SELECT j.name FROM votes v JOIN judges j ON j.id = v.judge_id WHERE v.kortid = ?",
    )
      .bind(CARD.abcd1)
      .first<{ name: string }>();
    expect(vote!.name).toBe("Selin");
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM judges WHERE name = 'selin'").first<{ n: number }>();
    expect(count!.n).toBe(1); // ingen ny rad — NOCASE träffade befintliga Selin
  });
});

describe("admin: auth och flöden", () => {
  it("kräver korrekt token", async () => {
    expect((await SELF.fetch("http://t/api/admin/ping")).status).toBe(401);
    expect((await SELF.fetch("http://t/api/admin/ping", { headers: { authorization: "Bearer fel" } })).status).toBe(401);
    expect((await get("/api/admin/ping", true)).status).toBe(200);
  });

  it("lag: dubblettnamn ger 409", async () => {
    const dup = await post("/api/admin/teams", { name: "Lag Alfa" }, true);
    expect(dup.status).toBe(409);
  });

  it("tilldelning: okänd gruppkod avvisas, dubbel gren för samma lag ger 409, omtilldelning fungerar", async () => {
    const unknown = await post("/api/admin/assign", { lagkod: "XXXX", teamId: teamAlfa, grenId: grenFreestyle }, true);
    expect(unknown.status).toBe(400);

    // Lag Alfa har redan SODG i Freestyle -> EFGH till samma lag+gren ska ge 409.
    const conflict = await post("/api/admin/assign", { lagkod: "EFGH", teamId: teamAlfa, grenId: grenFreestyle }, true);
    expect(conflict.status).toBe(409);

    // Omtilldelning av EFGH till Lag Beta i annan gren fungerar (skapa gren först).
    const gren = (await (await post("/api/admin/grenar", { name: "Testgren", inTotal: false }, true)).json()) as {
      gren: { id: number };
    };
    const ok = await post("/api/admin/assign", { lagkod: "EFGH", teamId: teamBeta, grenId: gren.gren.id }, true);
    expect(ok.status).toBe(200);
    const del = await SELF.fetch("http://t/api/admin/assign/EFGH", { method: "DELETE", headers: ADMIN });
    expect(del.status).toBe(200);
  });

  it("pappersinmatning registreras med källa och registrerare; override ersätter och loggas", async () => {
    const paper = await post(
      "/api/admin/vote",
      { kortid: CARD.abcd2, judge: "Pappersdomare", scores: scores(4), enteredBy: "Danni" },
      true,
    );
    expect(((await paper.json()) as { status: string }).status).toBe("accepted");
    const row = await env.DB.prepare("SELECT source, entered_by FROM votes WHERE kortid = ?")
      .bind(CARD.abcd2)
      .first<{ source: string; entered_by: string }>();
    expect(row).toMatchObject({ source: "paper", entered_by: "Danni" });

    const noOverride = (await (
      await post("/api/admin/vote", { kortid: CARD.abcd2, judge: "Pappersdomare", scores: scores(9), enteredBy: "Danni" }, true)
    ).json()) as { status: string };
    expect(noOverride.status).toBe("duplicate");

    const override = (await (
      await post(
        "/api/admin/vote",
        { kortid: CARD.abcd2, judge: "Pappersdomare", scores: scores(9), enteredBy: "Danni", override: true },
        true,
      )
    ).json()) as { status: string };
    expect(override.status).toBe("replaced");
    const after = await env.DB.prepare("SELECT scores FROM votes WHERE kortid = ?").bind(CARD.abcd2).first<{ scores: string }>();
    expect(JSON.parse(after!.scores)["smak"]).toBe(9);
    const logged = await env.DB.prepare("SELECT COUNT(*) AS n FROM admin_log WHERE action = 'vote_override'").first<{ n: number }>();
    expect(logged!.n).toBe(1);
  });

  it("domarsammanslagning pekar om röster och framtida inskick", async () => {
    await post("/api/vote", { kortid: CARD.efgh1, judge: "Johan Broström de", scores: scores(5) });
    const judges = (await (await get("/api/admin/judges", true)).json()) as {
      judges: { id: number; name: string }[];
    };
    const from = judges.judges.find((j) => j.name === "Johan Broström de")!;
    const to = judges.judges.find((j) => j.name === "Johan Broström")!;
    const merge = await post("/api/admin/judges/merge", { fromId: from.id, toId: to.id }, true);
    expect(merge.status).toBe(200);

    const vote = await env.DB.prepare("SELECT judge_id FROM votes WHERE kortid = ?").bind(CARD.efgh1).first<{ judge_id: number }>();
    expect(vote!.judge_id).toBe(to.id);

    // Alias syns inte längre i autocomplete, och nya inskick löses till kanoniskt id.
    const config = (await (await get("/api/config")).json()) as { judges: string[] };
    expect(config.judges).not.toContain("Johan Broström de");
  });

  it("avdrag påverkar resultatet och kan återkallas", async () => {
    await post("/api/vote", { kortid: CARD.sodg1, judge: "D1", scores: scores(8) });
    const created = (await (
      await post("/api/admin/avdrag", { lagkod: "SODG", pct: 0.5, reason: "Test", decidedBy: "Danni" }, true)
    ).json()) as { avdrag: { id: number } };

    let results = (await (await get("/api/admin/results", true)).json()) as {
      standings: Record<string, { team: string; factor: number }[]>;
    };
    const entry = results.standings["Freestyle"]!.find((e) => e.team === "Lag Alfa")!;
    expect(entry.factor).toBeCloseTo(0.5, 6);

    await post(`/api/admin/avdrag/${created.avdrag.id}/revoke`, {}, true);
    results = (await (await get("/api/admin/results", true)).json()) as {
      standings: Record<string, { team: string; factor: number }[]>;
    };
    expect(results.standings["Freestyle"]!.find((e) => e.team === "Lag Alfa")!.factor).toBe(1);
  });

  it("resultat följer placement_method-inställningen", async () => {
    await post("/api/vote", { kortid: CARD.sodg1, judge: "D1", scores: scores(8) });
    await post("/api/vote", { kortid: CARD.abcd1, judge: "D2", scores: scores(6) });

    const adjusted = (await (await get("/api/admin/results", true)).json()) as {
      method: string;
      standings: Record<string, { team: string; final: number; adjusted: number }[]>;
    };
    expect(adjusted.method).toBe("adjusted");
    for (const e of adjusted.standings["Freestyle"]!) expect(e.final).toBe(e.adjusted);

    await SELF.fetch("http://t/api/admin/settings", {
      method: "PATCH",
      headers: { ...ADMIN, "content-type": "application/json" },
      body: JSON.stringify({ placement_method: "raw" }),
    });
    const raw = (await (await get("/api/admin/results", true)).json()) as {
      method: string;
      standings: Record<string, { final: number; raw: number }[]>;
    };
    expect(raw.method).toBe("raw");
    for (const e of raw.standings["Freestyle"]!) expect(e.final).toBe(e.raw);

    // Återställ standardmetoden för resten av scenariot.
    await SELF.fetch("http://t/api/admin/settings", {
      method: "PATCH",
      headers: { ...ADMIN, "content-type": "application/json" },
      body: JSON.stringify({ placement_method: "adjusted" }),
    });
  });

  it("okända eller ogiltiga inställningar avvisas", async () => {
    const bad = await SELF.fetch("http://t/api/admin/settings", {
      method: "PATCH",
      headers: { ...ADMIN, "content-type": "application/json" },
      body: JSON.stringify({ hemlig_bakdorr: "x" }),
    });
    expect(bad.status).toBe(400);
    const badValue = await SELF.fetch("http://t/api/admin/settings", {
      method: "PATCH",
      headers: { ...ADMIN, "content-type": "application/json" },
      body: JSON.stringify({ placement_method: "magi" }),
    });
    expect(badValue.status).toBe(400);
  });

  it("översikten visar tilldelningar, röstantal och otilldelade koder", async () => {
    // Läget vid det här steget i scenariot: SODG har 3 kort och 3 röster
    // (Testdomare, Bo, Anna Testsson); EFGH har röster men saknar koppling.
    const data = (await (await get("/api/admin/overview", true)).json()) as {
      assignments: { lagkod: string; votes: number; cards: number }[];
      unassignedWithVotes: { lagkod: string }[];
      conflictCount: number;
    };
    const sodg = data.assignments.find((a) => a.lagkod === "SODG")!;
    expect(sodg.cards).toBe(3);
    expect(sodg.votes).toBe(3);
    expect(data.unassignedWithVotes.map((u) => u.lagkod)).toContain("EFGH");
    expect(data.conflictCount).toBeGreaterThanOrEqual(1);
  });

  it("exporterar röster som CSV", async () => {
    await post("/api/vote", { kortid: CARD.efgh2, judge: "Kommentatorn", scores: scores(8), comment: 'Med;semikolon "och" citat' });
    const res = await get("/api/admin/export.csv", true);
    expect(res.headers.get("content-type")).toContain("text/csv");
    const text = await res.text();
    expect(text).toContain("kortid;lagkod;lag;gren;domare;smak");
    expect(text).toContain('"Med;semikolon ""och"" citat"');
    expect(text).toContain("Lag Alfa");
  });
});

describe("publik resultatsida", () => {
  it("är dold tills reveal öppnas", async () => {
    const hidden = (await (await get("/api/resultat")).json()) as { hidden: boolean };
    expect(hidden.hidden).toBe(true);

    await SELF.fetch("http://t/api/admin/settings", {
      method: "PATCH",
      headers: { ...ADMIN, "content-type": "application/json" },
      body: JSON.stringify({ reveal: "open" }),
    });
    const open = (await (await get("/api/resultat")).json()) as {
      hidden: boolean;
      grenar: { name: string; standings: { team: string; final: number; n: number }[] }[];
      totals: { team: string; total: number }[];
    };
    expect(open.hidden).toBe(false);
    // Scenariots ställning i Freestyle: Lag Beta (Selin 7 + Pappersdomare 9 -> 8,0)
    // före Lag Alfa (7 + 6 + 8 -> 7,0).
    const freestyle = open.grenar.find((g) => g.name === "Freestyle")!;
    expect(freestyle.standings.map((s) => s.team)).toEqual(["Lag Beta", "Lag Alfa"]);
    expect(freestyle.standings[0]!.n).toBe(2);
    expect(open.totals[0]!.team).toBe("Lag Beta");
  });
});
