import { Hono } from "hono";
import { adminAuth } from "./auth";
import { getSettings, loadScoringInputs, logAdmin } from "./db";
import { computeResults } from "./scoring";
import { submitVote } from "./vote";

export const adminRoutes = new Hono<{ Bindings: Env }>();

adminRoutes.use("*", adminAuth);

adminRoutes.get("/ping", (c) => c.json({ ok: true }));

// ---------- Översikt ----------

adminRoutes.get("/overview", async (c) => {
  const db = c.env.DB;
  const [assignments, unassigned, conflicts, counters] = await Promise.all([
    db
      .prepare(
        `SELECT a.lagkod, t.name AS team, g.name AS gren,
                (SELECT COUNT(*) FROM votes v WHERE v.lagkod = a.lagkod) AS votes,
                (SELECT COUNT(*) FROM cards k WHERE k.lagkod = a.lagkod) AS cards
         FROM assignments a
         JOIN teams t ON t.id = a.team_id
         JOIN grenar g ON g.id = a.gren_id
         ORDER BY g.name, t.name`,
      )
      .all(),
    db
      .prepare(
        `SELECT v.lagkod, COUNT(*) AS votes FROM votes v
         WHERE v.lagkod NOT IN (SELECT lagkod FROM assignments)
         GROUP BY v.lagkod ORDER BY MAX(v.created_at) DESC`,
      )
      .all(),
    db
      .prepare("SELECT COUNT(*) AS n FROM submission_log WHERE accepted = 0 AND reason = 'duplicate_conflict'")
      .first<{ n: number }>(),
    db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM votes) AS votes,
                (SELECT COUNT(*) FROM cards) AS cards,
                (SELECT COUNT(*) FROM submission_log WHERE accepted = 0) AS rejected`,
      )
      .first<{ votes: number; cards: number; rejected: number }>(),
  ]);
  return c.json({
    assignments: assignments.results,
    unassignedWithVotes: unassigned.results,
    conflictCount: conflicts?.n ?? 0,
    totals: counters,
  });
});

adminRoutes.get("/conflicts", async (c) => {
  const { results } = await c.env.DB
    .prepare(
      `SELECT l.id, l.received_at, l.kortid, l.lagkod, l.judge_name, l.scores, l.comment, l.source, l.entered_by, l.reason,
              v.scores AS accepted_scores, v.comment AS accepted_comment, j.name AS accepted_judge, v.source AS accepted_source
       FROM submission_log l
       LEFT JOIN votes v ON v.kortid = l.kortid
       LEFT JOIN judges j ON j.id = v.judge_id
       WHERE l.accepted = 0 AND l.reason IN ('duplicate_conflict', 'duplicate_identical')
       ORDER BY l.received_at DESC LIMIT 500`,
    )
    .all();
  return c.json({ conflicts: results });
});

// ---------- Lag ----------

adminRoutes.get("/teams", async (c) => {
  const { results } = await c.env.DB
    .prepare(
      `SELECT t.id, t.name, t.active,
              (SELECT COUNT(*) FROM assignments a WHERE a.team_id = t.id) AS assignments
       FROM teams t ORDER BY t.name COLLATE NOCASE`,
    )
    .all();
  return c.json({ teams: results });
});

adminRoutes.post("/teams", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { name?: string };
  const name = (body.name ?? "").trim();
  if (!name) return c.json({ ok: false, code: "validation", message: "Lagnamn saknas." }, 400);
  try {
    const row = await c.env.DB
      .prepare("INSERT INTO teams (name) VALUES (?) RETURNING id, name, active")
      .bind(name)
      .first();
    await logAdmin(c.env.DB, "team_create", { name });
    return c.json({ ok: true, team: row }, 201);
  } catch {
    return c.json({ ok: false, code: "conflict", message: "Det finns redan ett lag med det namnet." }, 409);
  }
});

adminRoutes.patch("/teams/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = (await c.req.json().catch(() => ({}))) as { name?: string; active?: boolean };
  const existing = await c.env.DB.prepare("SELECT id, name, active FROM teams WHERE id = ?").bind(id).first();
  if (!existing) return c.json({ ok: false, code: "not_found", message: "Laget finns inte." }, 404);
  const name = body.name !== undefined ? body.name.trim() : undefined;
  if (name !== undefined && !name) return c.json({ ok: false, code: "validation", message: "Ogiltigt namn." }, 400);
  try {
    await c.env.DB
      .prepare("UPDATE teams SET name = COALESCE(?, name), active = COALESCE(?, active) WHERE id = ?")
      .bind(name ?? null, body.active === undefined ? null : body.active ? 1 : 0, id)
      .run();
    await logAdmin(c.env.DB, "team_update", { id, ...body });
    return c.json({ ok: true });
  } catch {
    return c.json({ ok: false, code: "conflict", message: "Det finns redan ett lag med det namnet." }, 409);
  }
});

// ---------- Grenar och kriterier ----------

adminRoutes.get("/grenar", async (c) => {
  const { results } = await c.env.DB
    .prepare("SELECT id, name, sort, in_total, active FROM grenar ORDER BY sort")
    .all();
  return c.json({ grenar: results });
});

adminRoutes.post("/grenar", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { name?: string; inTotal?: boolean; sort?: number };
  const name = (body.name ?? "").trim();
  if (!name) return c.json({ ok: false, code: "validation", message: "Grennamn saknas." }, 400);
  try {
    const row = await c.env.DB
      .prepare("INSERT INTO grenar (name, in_total, sort) VALUES (?, ?, ?) RETURNING *")
      .bind(name, body.inTotal === false ? 0 : 1, body.sort ?? 99)
      .first();
    await logAdmin(c.env.DB, "gren_create", { name });
    return c.json({ ok: true, gren: row }, 201);
  } catch {
    return c.json({ ok: false, code: "conflict", message: "Grenen finns redan." }, 409);
  }
});

adminRoutes.patch("/grenar/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = (await c.req.json().catch(() => ({}))) as {
    name?: string;
    inTotal?: boolean;
    sort?: number;
    active?: boolean;
  };
  const existing = await c.env.DB.prepare("SELECT id FROM grenar WHERE id = ?").bind(id).first();
  if (!existing) return c.json({ ok: false, code: "not_found", message: "Grenen finns inte." }, 404);
  await c.env.DB
    .prepare(
      "UPDATE grenar SET name = COALESCE(?, name), in_total = COALESCE(?, in_total), sort = COALESCE(?, sort), active = COALESCE(?, active) WHERE id = ?",
    )
    .bind(
      body.name?.trim() || null,
      body.inTotal === undefined ? null : body.inTotal ? 1 : 0,
      body.sort ?? null,
      body.active === undefined ? null : body.active ? 1 : 0,
      id,
    )
    .run();
  await logAdmin(c.env.DB, "gren_update", { id, ...body });
  return c.json({ ok: true });
});

adminRoutes.get("/criteria", async (c) => {
  const { results } = await c.env.DB
    .prepare("SELECT id, key, label, weight, sort, active FROM criteria ORDER BY sort")
    .all();
  return c.json({ criteria: results });
});

adminRoutes.post("/criteria", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    key?: string;
    label?: string;
    weight?: number;
    sort?: number;
  };
  const key = (body.key ?? "").trim().toLowerCase();
  const label = (body.label ?? "").trim();
  if (!/^[a-zå-ö0-9_]{1,30}$/.test(key) || !label || typeof body.weight !== "number" || body.weight < 0) {
    return c.json({ ok: false, code: "validation", message: "Ogiltigt kriterium (key, label, weight krävs)." }, 400);
  }
  try {
    const row = await c.env.DB
      .prepare("INSERT INTO criteria (key, label, weight, sort) VALUES (?, ?, ?, ?) RETURNING *")
      .bind(key, label, body.weight, body.sort ?? 99)
      .first();
    await logAdmin(c.env.DB, "criteria_create", { key, label, weight: body.weight });
    return c.json({ ok: true, criterion: row }, 201);
  } catch {
    return c.json({ ok: false, code: "conflict", message: "Kriterienyckeln finns redan." }, 409);
  }
});

adminRoutes.patch("/criteria/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = (await c.req.json().catch(() => ({}))) as {
    label?: string;
    weight?: number;
    sort?: number;
    active?: boolean;
  };
  const existing = await c.env.DB.prepare("SELECT id FROM criteria WHERE id = ?").bind(id).first();
  if (!existing) return c.json({ ok: false, code: "not_found", message: "Kriteriet finns inte." }, 404);
  if (body.weight !== undefined && (typeof body.weight !== "number" || body.weight < 0)) {
    return c.json({ ok: false, code: "validation", message: "Ogiltig vikt." }, 400);
  }
  await c.env.DB
    .prepare(
      "UPDATE criteria SET label = COALESCE(?, label), weight = COALESCE(?, weight), sort = COALESCE(?, sort), active = COALESCE(?, active) WHERE id = ?",
    )
    .bind(
      body.label?.trim() || null,
      body.weight ?? null,
      body.sort ?? null,
      body.active === undefined ? null : body.active ? 1 : 0,
      id,
    )
    .run();
  await logAdmin(c.env.DB, "criteria_update", { id, ...body });
  return c.json({ ok: true });
});

// ---------- Domare ----------

adminRoutes.get("/judges", async (c) => {
  const { results } = await c.env.DB
    .prepare(
      `SELECT j.id, j.name, j.alias_of,
              (SELECT COUNT(*) FROM votes v WHERE v.judge_id = j.id) AS votes
       FROM judges j ORDER BY j.name COLLATE NOCASE`,
    )
    .all();
  return c.json({ judges: results });
});

adminRoutes.post("/judges/merge", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { fromId?: number; toId?: number };
  const db = c.env.DB;
  const from = await db.prepare("SELECT id, name, alias_of FROM judges WHERE id = ?").bind(body.fromId ?? -1).first<{
    id: number;
    name: string;
    alias_of: number | null;
  }>();
  let to = await db.prepare("SELECT id, name, alias_of FROM judges WHERE id = ?").bind(body.toId ?? -1).first<{
    id: number;
    name: string;
    alias_of: number | null;
  }>();
  if (!from || !to) return c.json({ ok: false, code: "not_found", message: "Domaren finns inte." }, 404);
  if (to.alias_of !== null) {
    to = await db.prepare("SELECT id, name, alias_of FROM judges WHERE id = ?").bind(to.alias_of).first();
  }
  if (!to || from.id === to.id) {
    return c.json({ ok: false, code: "validation", message: "Ogiltig sammanslagning." }, 400);
  }
  await db.batch([
    db.prepare("UPDATE votes SET judge_id = ? WHERE judge_id = ?").bind(to.id, from.id),
    db.prepare("UPDATE judges SET alias_of = ? WHERE id = ? OR alias_of = ?").bind(to.id, from.id, from.id),
    db
      .prepare("INSERT INTO admin_log (action, detail) VALUES ('judge_merge', ?)")
      .bind(JSON.stringify({ from: from.name, to: to.name })),
  ]);
  return c.json({ ok: true, mergedInto: to.name });
});

// ---------- Tilldelning gruppkod -> lag + gren ----------

adminRoutes.post("/assign", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { lagkod?: string; teamId?: number; grenId?: number };
  const lagkod = (body.lagkod ?? "").trim().toUpperCase();
  const db = c.env.DB;
  if (!lagkod || !body.teamId || !body.grenId) {
    return c.json({ ok: false, code: "validation", message: "lagkod, teamId och grenId krävs." }, 400);
  }
  const known = await db.prepare("SELECT COUNT(*) AS n FROM cards WHERE lagkod = ?").bind(lagkod).first<{ n: number }>();
  if (!known || known.n === 0) {
    return c.json({ ok: false, code: "unknown_lagkod", message: "Gruppkoden finns inte bland de tryckta korten." }, 400);
  }
  try {
    await db
      .prepare(
        `INSERT INTO assignments (lagkod, team_id, gren_id) VALUES (?, ?, ?)
         ON CONFLICT (lagkod) DO UPDATE SET team_id = excluded.team_id, gren_id = excluded.gren_id, assigned_at = datetime('now')`,
      )
      .bind(lagkod, body.teamId, body.grenId)
      .run();
  } catch {
    return c.json(
      { ok: false, code: "conflict", message: "Laget har redan en gruppkod i den grenen. Ta bort den kopplingen först." },
      409,
    );
  }
  await logAdmin(db, "assign", { lagkod, teamId: body.teamId, grenId: body.grenId });
  return c.json({ ok: true });
});

adminRoutes.delete("/assign/:lagkod", async (c) => {
  const lagkod = c.req.param("lagkod").trim().toUpperCase();
  const res = await c.env.DB.prepare("DELETE FROM assignments WHERE lagkod = ?").bind(lagkod).run();
  if (res.meta.changes === 0) return c.json({ ok: false, code: "not_found", message: "Ingen koppling fanns." }, 404);
  await logAdmin(c.env.DB, "unassign", { lagkod });
  return c.json({ ok: true });
});

// ---------- Avdrag ----------

adminRoutes.get("/avdrag", async (c) => {
  const { results } = await c.env.DB
    .prepare(
      `SELECT av.id, av.lagkod, av.pct, av.reason, av.decided_by, av.created_at, av.revoked_at,
              t.name AS team, g.name AS gren
       FROM avdrag av
       LEFT JOIN assignments a ON a.lagkod = av.lagkod
       LEFT JOIN teams t ON t.id = a.team_id
       LEFT JOIN grenar g ON g.id = a.gren_id
       ORDER BY av.created_at DESC`,
    )
    .all();
  return c.json({ avdrag: results });
});

adminRoutes.post("/avdrag", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    lagkod?: string;
    pct?: number;
    reason?: string;
    decidedBy?: string;
  };
  const lagkod = (body.lagkod ?? "").trim().toUpperCase();
  const reason = (body.reason ?? "").trim();
  if (!lagkod || !reason || typeof body.pct !== "number" || body.pct <= 0 || body.pct > 1) {
    return c.json(
      { ok: false, code: "validation", message: "lagkod, pct (0–1) och motivering krävs." },
      400,
    );
  }
  const row = await c.env.DB
    .prepare("INSERT INTO avdrag (lagkod, pct, reason, decided_by) VALUES (?, ?, ?, ?) RETURNING *")
    .bind(lagkod, body.pct, reason, body.decidedBy ?? null)
    .first();
  await logAdmin(c.env.DB, "avdrag_create", { lagkod, pct: body.pct, reason });
  return c.json({ ok: true, avdrag: row }, 201);
});

adminRoutes.post("/avdrag/:id/revoke", async (c) => {
  const id = Number(c.req.param("id"));
  const res = await c.env.DB
    .prepare("UPDATE avdrag SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL")
    .bind(id)
    .run();
  if (res.meta.changes === 0) return c.json({ ok: false, code: "not_found", message: "Avdraget finns inte." }, 404);
  await logAdmin(c.env.DB, "avdrag_revoke", { id });
  return c.json({ ok: true });
});

// ---------- Röster (pappersinmatning + korrigering) ----------

adminRoutes.post("/vote", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown> & {
    enteredBy?: string;
    override?: boolean;
  };
  const result = await submitVote(c.env.DB, body, {
    source: "paper",
    enteredBy: typeof body.enteredBy === "string" ? body.enteredBy.trim() : undefined,
    override: body.override === true,
  });
  if (result.status === "rejected") {
    return c.json({ ok: false, code: result.code, message: result.message }, 400);
  }
  return c.json({ ok: true, status: result.status, identical: "identical" in result ? result.identical : undefined });
});

// ---------- Resultat, inställningar, import/export ----------

adminRoutes.get("/results", async (c) => {
  const db = c.env.DB;
  const [inputs, settings] = await Promise.all([loadScoringInputs(db), getSettings(db)]);
  const method = settings["placement_method"] === "raw" ? "raw" : "adjusted";
  const dampingK = Number(settings["damping_k"] ?? "5");
  const results = computeResults(inputs.votes, inputs.contributions, inputs.criteria, inputs.grenar, inputs.avdrag, {
    method,
    dampingK,
  });
  return c.json({
    method,
    dampingK,
    voteCount: inputs.votes.length,
    grenar: inputs.grenar,
    standings: results.standings,
    totals: results.totals,
    severities: results.severities,
  });
});

adminRoutes.get("/settings", async (c) => c.json({ settings: await getSettings(c.env.DB) }));

const SETTING_VALIDATORS: Record<string, (v: string) => boolean> = {
  event_name: (v) => v.trim().length > 0 && v.length <= 100,
  placement_method: (v) => v === "adjusted" || v === "raw",
  reveal: (v) => v === "hidden" || v === "open",
  damping_k: (v) => Number.isFinite(Number(v)) && Number(v) >= 0,
  backup_form_url: (v) => v === "" || v.startsWith("https://") || v.startsWith("http://"),
};

adminRoutes.patch("/settings", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const db = c.env.DB;
  const updates: [string, string][] = [];
  for (const [key, value] of Object.entries(body)) {
    const validate = SETTING_VALIDATORS[key];
    if (!validate) return c.json({ ok: false, code: "validation", message: `Okänd inställning: ${key}` }, 400);
    if (typeof value !== "string" || !validate(value)) {
      return c.json({ ok: false, code: "validation", message: `Ogiltigt värde för ${key}.` }, 400);
    }
    updates.push([key, value]);
  }
  if (updates.length === 0) return c.json({ ok: false, code: "validation", message: "Inget att uppdatera." }, 400);
  await db.batch(
    updates.map(([key, value]) =>
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(key, value),
    ),
  );
  await logAdmin(db, "settings_update", Object.fromEntries(updates));
  return c.json({ ok: true });
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Importerar kortregistret. Klarar både generatorns CSV (lagkod;url;bild) och enkla kortid/lagkod-par. */
adminRoutes.post("/cards/import", async (c) => {
  const text = await c.req.text();
  const pairs: { kortid: string; lagkod: string }[] = [];
  const errors: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(/[;,\t]/).map((p) => p.trim());
    let kortid = "";
    let lagkod = "";
    const urlPart = parts.find((p) => p.startsWith("http://") || p.startsWith("https://"));
    if (urlPart) {
      try {
        const url = new URL(urlPart);
        kortid = url.searchParams.get("kortid") ?? "";
        lagkod = (url.searchParams.get("lagkod") ?? parts[0] ?? "").toUpperCase();
      } catch {
        errors.push(line.slice(0, 60));
        continue;
      }
    } else if (parts.length >= 2) {
      const uuid = parts.find((p) => UUID_RE.test(p));
      const other = parts.find((p) => p !== uuid && p.length > 0);
      kortid = uuid ?? "";
      lagkod = (other ?? "").toUpperCase();
    }
    if (!kortid || !UUID_RE.test(kortid) || !/^[A-ZÅÄÖ0-9]{2,10}$/.test(lagkod)) {
      errors.push(line.slice(0, 60));
      continue;
    }
    pairs.push({ kortid, lagkod });
  }
  const db = c.env.DB;
  let imported = 0;
  for (let i = 0; i < pairs.length; i += 50) {
    const chunk = pairs.slice(i, i + 50);
    const results = await db.batch(
      chunk.map((p) =>
        db.prepare("INSERT INTO cards (kortid, lagkod) VALUES (?, ?) ON CONFLICT (kortid) DO NOTHING").bind(p.kortid, p.lagkod),
      ),
    );
    for (const r of results) imported += r.meta.changes ?? 0;
  }
  await logAdmin(db, "cards_import", { rows: pairs.length, imported, errors: errors.length });
  return c.json({ ok: true, rows: pairs.length, imported, skipped: pairs.length - imported, badLines: errors });
});

function csvField(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  return /[;"\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

adminRoutes.get("/export.csv", async (c) => {
  const db = c.env.DB;
  const [criteria, votes] = await Promise.all([
    db.prepare("SELECT key FROM criteria WHERE active = 1 ORDER BY sort").all<{ key: string }>(),
    db
      .prepare(
        `SELECT v.kortid, v.lagkod, t.name AS team, g.name AS gren, j.name AS judge,
                v.scores, v.comment, v.source, v.entered_by, v.created_at
         FROM votes v
         JOIN judges j ON j.id = v.judge_id
         LEFT JOIN assignments a ON a.lagkod = v.lagkod
         LEFT JOIN teams t ON t.id = a.team_id
         LEFT JOIN grenar g ON g.id = a.gren_id
         ORDER BY v.created_at`,
      )
      .all<{
        kortid: string;
        lagkod: string;
        team: string | null;
        gren: string | null;
        judge: string;
        scores: string;
        comment: string | null;
        source: string;
        entered_by: string | null;
        created_at: string;
      }>(),
  ]);
  const keys = criteria.results.map((r) => r.key);
  const header = ["kortid", "lagkod", "lag", "gren", "domare", ...keys, "kommentar", "källa", "registrerad_av", "tid"];
  const lines = [header.join(";")];
  for (const v of votes.results) {
    const scores = JSON.parse(v.scores) as Record<string, number>;
    lines.push(
      [
        v.kortid,
        v.lagkod,
        v.team ?? "",
        v.gren ?? "",
        v.judge,
        ...keys.map((k) => scores[k] ?? ""),
        v.comment ?? "",
        v.source,
        v.entered_by ?? "",
        v.created_at,
      ]
        .map(csvField)
        .join(";"),
    );
  }
  return c.body("﻿" + lines.join("\n"), 200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="roster-export.csv"`,
  });
});

adminRoutes.get("/log", async (c) => {
  const { results } = await c.env.DB
    .prepare("SELECT id, at, action, detail FROM admin_log ORDER BY id DESC LIMIT 200")
    .all();
  return c.json({ log: results });
});
