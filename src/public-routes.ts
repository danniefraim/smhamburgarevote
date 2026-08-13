import { Hono } from "hono";
import { getActiveCriteria, getSettings, loadScoringInputs } from "./db";
import { computeResults } from "./scoring";
import { submitVote } from "./vote";

export const publicRoutes = new Hono<{ Bindings: Env }>();

publicRoutes.get("/health", (c) => c.json({ ok: true }));

/** Allt röstsidan behöver i ett anrop. */
publicRoutes.get("/config", async (c) => {
  const db = c.env.DB;
  const [criteria, settings, judges] = await Promise.all([
    getActiveCriteria(db),
    getSettings(db),
    db
      .prepare("SELECT name FROM judges WHERE alias_of IS NULL ORDER BY name COLLATE NOCASE")
      .all<{ name: string }>(),
  ]);
  return c.json({
    eventName: settings["event_name"] ?? "SM i Hamburgare",
    backupFormUrl: settings["backup_form_url"] ?? "",
    criteria: criteria.map((cr) => ({ key: cr.key, label: cr.label })),
    judges: judges.results.map((j) => j.name),
  });
});

publicRoutes.get("/card/:kortid", async (c) => {
  const kortid = c.req.param("kortid").trim();
  const db = c.env.DB;
  const card = await db.prepare("SELECT lagkod FROM cards WHERE kortid = ?").bind(kortid).first<{ lagkod: string }>();
  if (!card) return c.json({ ok: false, code: "unknown_card" }, 404);
  const used = await db.prepare("SELECT 1 AS x FROM votes WHERE kortid = ?").bind(kortid).first();
  return c.json({ ok: true, lagkod: card.lagkod, used: used !== null });
});

publicRoutes.post("/vote", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, code: "validation", message: "Ogiltig förfrågan." }, 400);
  }
  const result = await submitVote(c.env.DB, body as Record<string, unknown>, { source: "digital" });
  if (result.status === "rejected") {
    return c.json({ ok: false, code: result.code, message: result.message }, 400);
  }
  return c.json({ ok: true, status: result.status, identical: "identical" in result ? result.identical : undefined });
});

publicRoutes.get("/resultat", async (c) => {
  const db = c.env.DB;
  const settings = await getSettings(db);
  const eventName = settings["event_name"] ?? "SM i Hamburgare";
  if (settings["reveal"] !== "open") {
    return c.json({ hidden: true, eventName });
  }
  const inputs = await loadScoringInputs(db);
  const method = settings["placement_method"] === "raw" ? "raw" : "adjusted";
  const results = computeResults(inputs.votes, inputs.contributions, inputs.criteria, inputs.grenar, inputs.avdrag, {
    method,
    dampingK: Number(settings["damping_k"] ?? "5"),
  });
  return c.json({
    hidden: false,
    eventName,
    method,
    grenar: inputs.grenar.map((g) => ({
      name: g.name,
      inTotal: g.inTotal,
      standings: (results.standings[g.name] ?? []).map((e, i) => ({
        place: i + 1,
        team: e.team,
        final: e.final,
        raw: e.raw,
        adjusted: e.adjusted,
        n: e.n,
        tieBreakUsed: e.tieBreakUsed,
        unresolvedTie: e.unresolvedTie,
      })),
    })),
    totals: results.totals.map((t, i) => ({ place: i + 1, team: t.team, total: t.total, perGren: t.perGren })),
  });
});
