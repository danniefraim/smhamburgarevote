import { Hono } from "hono";
import { adminAuth } from "./auth";
import { getActiveCriteria, getSettings, loadScoringInputs, logAdmin, resolveJudgeId } from "./db";
import { computeResults } from "./scoring";
import { normalizeJudgeName, stableScoreJson, submitVote, validateScores } from "./vote";

export const adminRoutes = new Hono<{ Bindings: Env }>();

adminRoutes.use("*", adminAuth);

adminRoutes.get("/ping", (c) => c.json({ ok: true }));

// ---------- Översikt ----------

adminRoutes.get("/overview", async (c) => {
  const db = c.env.DB;
  const [assignments, unassigned, conflicts, counters, recent] = await Promise.all([
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
    db
      .prepare(
        `SELECT v.kortid, v.lagkod, v.created_at, v.source, v.edited_at, j.name AS judge,
                t.name AS team, g.name AS gren
         FROM votes v
         JOIN judges j ON j.id = v.judge_id
         LEFT JOIN assignments a ON a.lagkod = v.lagkod
         LEFT JOIN teams t ON t.id = a.team_id
         LEFT JOIN grenar g ON g.id = a.gren_id
         ORDER BY v.created_at DESC, v.rowid DESC LIMIT 10`,
      )
      .all(),
  ]);
  return c.json({
    assignments: assignments.results,
    unassignedWithVotes: unassigned.results,
    conflictCount: conflicts?.n ?? 0,
    totals: counters,
    recentVotes: recent.results,
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

/**
 * Registrerade röster saknar poäng för kriterier som tillkommer efteråt, och då
 * kastar poängmotorn — hela resultatsidan går ner. Därför är det spärrat att
 * lägga till eller återaktivera kriterier så länge röster finns.
 */
async function criteriaLocked(db: D1Database): Promise<boolean> {
  return (await db.prepare("SELECT 1 AS x FROM votes LIMIT 1").first()) !== null;
}

const CRITERIA_LOCKED_MSG =
  "Röster är redan registrerade — ett nytt aktivt kriterium skulle sakna poäng i befintliga röster och stoppa resultatberäkningen. Kriterieuppsättningen är låst tills rösterna rensats.";

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
  if (await criteriaLocked(c.env.DB)) {
    return c.json({ ok: false, code: "locked", message: CRITERIA_LOCKED_MSG }, 409);
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
  const existing = await c.env.DB.prepare("SELECT id, active FROM criteria WHERE id = ?").bind(id).first<{
    id: number;
    active: number;
  }>();
  if (!existing) return c.json({ ok: false, code: "not_found", message: "Kriteriet finns inte." }, 404);
  if (body.weight !== undefined && (typeof body.weight !== "number" || body.weight < 0)) {
    return c.json({ ok: false, code: "validation", message: "Ogiltig vikt." }, 400);
  }
  // Att stänga av ett kriterium är ofarligt (överblivna poäng ignoreras); att slå
  // på ett gör att alla registrerade röster saknar poäng för det — spärrat.
  if (body.active === true && existing.active === 0 && (await criteriaLocked(c.env.DB))) {
    return c.json({ ok: false, code: "locked", message: CRITERIA_LOCKED_MSG }, 409);
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
  const db = c.env.DB;
  const [judges, merges] = await Promise.all([
    db
      .prepare(
        `SELECT j.id, j.name, j.alias_of,
                (SELECT COUNT(*) FROM votes v WHERE v.judge_id = j.id) AS votes
         FROM judges j ORDER BY j.name COLLATE NOCASE`,
      )
      .all(),
    db
      .prepare(
        `SELECT m.id, m.from_id, m.to_id, m.created_at, m.detail,
                f.name AS from_name, t.name AS to_name
         FROM judge_merges m
         JOIN judges f ON f.id = m.from_id
         JOIN judges t ON t.id = m.to_id
         WHERE m.undone_at IS NULL
         ORDER BY m.id DESC LIMIT 50`,
      )
      .all<{ id: number; detail: string }>(),
  ]);
  return c.json({
    judges: judges.results,
    merges: merges.results.map(({ detail, ...m }) => ({
      ...m,
      movedVotes: ((JSON.parse(detail) as { kortids?: string[] }).kortids ?? []).length,
    })),
  });
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

  // Spara exakt vad sammanslagningen rör, så att den kan ångras utan att dra med
  // sig röster som kommit in på målet efteråt.
  const [moved, aliases] = await Promise.all([
    db.prepare("SELECT kortid FROM votes WHERE judge_id = ?").bind(from.id).all<{ kortid: string }>(),
    db.prepare("SELECT id FROM judges WHERE alias_of = ?").bind(from.id).all<{ id: number }>(),
  ]);
  const detail = {
    kortids: moved.results.map((r) => r.kortid),
    aliasIds: aliases.results.map((r) => r.id),
  };

  await db.batch([
    db.prepare("UPDATE votes SET judge_id = ? WHERE judge_id = ?").bind(to.id, from.id),
    db.prepare("UPDATE judges SET alias_of = ? WHERE id = ? OR alias_of = ?").bind(to.id, from.id, from.id),
    db
      .prepare("INSERT INTO judge_merges (from_id, to_id, detail) VALUES (?, ?, ?)")
      .bind(from.id, to.id, JSON.stringify(detail)),
    db
      .prepare("INSERT INTO admin_log (action, detail) VALUES ('judge_merge', ?)")
      .bind(JSON.stringify({ from: from.name, to: to.name, movedVotes: detail.kortids.length })),
  ]);
  return c.json({ ok: true, mergedInto: to.name, movedVotes: detail.kortids.length });
});

/**
 * Ångrar en sammanslagning. En röst går tillbaka om namnet som senast skrevs för den
 * (submission_log är källan) hör till det namnkluster som nu bryts loss igen. Det
 * fångar både rösterna slagningen flyttade och de som kommit in på variantnamnet
 * medan slagningen gällde — men lämnar kvar röster som faktiskt skrevs med målnamnet.
 */
adminRoutes.post("/judges/merge/:id/undo", async (c) => {
  const id = Number(c.req.param("id"));
  const db = c.env.DB;
  const merge = await db
    .prepare(
      `SELECT m.id, m.from_id, m.to_id, m.detail, f.name AS from_name, t.name AS to_name
       FROM judge_merges m
       JOIN judges f ON f.id = m.from_id
       JOIN judges t ON t.id = m.to_id
       WHERE m.id = ? AND m.undone_at IS NULL`,
    )
    .bind(id)
    .first<{ id: number; from_id: number; to_id: number; detail: string; from_name: string; to_name: string }>();
  if (!merge) return c.json({ ok: false, code: "not_found", message: "Sammanslagningen finns inte (eller är redan ångrad)." }, 404);

  const from = await db
    .prepare("SELECT id, alias_of FROM judges WHERE id = ?")
    .bind(merge.from_id)
    .first<{ id: number; alias_of: number | null }>();
  if (!from || from.alias_of !== merge.to_id) {
    return c.json(
      {
        ok: false,
        code: "conflict",
        message: `${merge.from_name} har slagits ihop vidare sedan dess. Ångra den senaste sammanslagningen först.`,
      },
      409,
    );
  }

  const detail = JSON.parse(merge.detail) as { kortids?: string[]; aliasIds?: number[] };
  const kortids = detail.kortids ?? [];
  const aliasIds = detail.aliasIds ?? [];
  // Namnklustret som bryts loss: domaren själv plus de alias slagningen tog med sig.
  const clusterIds = [merge.from_id, ...aliasIds];
  const clusterPlaceholders = clusterIds.map(() => "?").join(",");

  // Jämförelsen sker mot judges.name_norm — samma skiftlägesokänsliga matchning
  // (även Å/Ä/Ö) som när en röst kommer in och namnet slås upp. Loggens namn
  // gemeneras i SQL med samma replace-kedja som migrationens backfill.
  const svLower = (col: string) =>
    `lower(replace(replace(replace(replace(replace(${col}, 'Å', 'å'), 'Ä', 'ä'), 'Ö', 'ö'), 'É', 'é'), 'Ü', 'ü'))`;
  const restore = [
    db
      .prepare(
        `UPDATE votes SET judge_id = ? WHERE judge_id = ? AND EXISTS (
           SELECT 1 FROM judges j
           WHERE j.id IN (${clusterPlaceholders})
             AND j.name_norm = ${svLower(
               `(SELECT l.judge_name FROM submission_log l
                 WHERE l.kortid = votes.kortid AND l.accepted = 1
                 ORDER BY l.id DESC LIMIT 1)`,
             )}
         )`,
      )
      .bind(merge.from_id, merge.to_id, ...clusterIds),
  ];
  // Skyddsnät: röster utan spår i submission_log kan inte namnmatchas, så de
  // flyttas tillbaka på vad slagningen faktiskt tog med sig.
  for (let i = 0; i < kortids.length; i += 50) {
    const chunk = kortids.slice(i, i + 50);
    restore.push(
      db
        .prepare(
          `UPDATE votes SET judge_id = ? WHERE judge_id = ? AND kortid IN (${chunk.map(() => "?").join(",")})
             AND NOT EXISTS (SELECT 1 FROM submission_log l WHERE l.kortid = votes.kortid AND l.accepted = 1)`,
        )
        .bind(merge.from_id, merge.to_id, ...chunk),
    );
  }

  const statements = [...restore];
  statements.push(db.prepare("UPDATE judges SET alias_of = NULL WHERE id = ?").bind(merge.from_id));
  if (aliasIds.length > 0) {
    statements.push(
      db
        .prepare(`UPDATE judges SET alias_of = ? WHERE id IN (${aliasIds.map(() => "?").join(",")})`)
        .bind(merge.from_id, ...aliasIds),
    );
  }
  statements.push(db.prepare("UPDATE judge_merges SET undone_at = datetime('now') WHERE id = ?").bind(merge.id));

  const results = await db.batch(statements);
  const restoredVotes = results
    .slice(0, restore.length)
    .reduce((sum, r) => sum + (r.meta.changes ?? 0), 0);
  await logAdmin(db, "judge_merge_undo", {
    from: merge.from_name,
    to: merge.to_name,
    restoredVotes,
    movedByMerge: kortids.length,
  });
  return c.json({ ok: true, restoredVotes });
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
      `SELECT av.id, av.lagkod, av.pct, av.points, av.reason, av.decided_by, av.created_at, av.revoked_at,
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

/** Avdrag är antingen procent av bidragets poäng eller ett fast poängavdrag. */
adminRoutes.post("/avdrag", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    lagkod?: string;
    pct?: number;
    points?: number;
    reason?: string;
    decidedBy?: string;
  };
  const lagkod = (body.lagkod ?? "").trim().toUpperCase();
  const reason = (body.reason ?? "").trim();
  const pct = typeof body.pct === "number" ? body.pct : 0;
  const points = typeof body.points === "number" ? body.points : 0;
  if (!lagkod || !reason) {
    return c.json({ ok: false, code: "validation", message: "lagkod och motivering krävs." }, 400);
  }
  if (pct < 0 || pct > 1 || points < 0 || !Number.isFinite(pct) || !Number.isFinite(points)) {
    return c.json({ ok: false, code: "validation", message: "Ogiltigt avdrag (pct 0–1, points ≥ 0)." }, 400);
  }
  const kinds = (pct > 0 ? 1 : 0) + (points > 0 ? 1 : 0);
  if (kinds !== 1) {
    return c.json(
      { ok: false, code: "validation", message: "Ange antingen ett procentavdrag eller ett fast poängavdrag." },
      400,
    );
  }
  const row = await c.env.DB
    .prepare("INSERT INTO avdrag (lagkod, pct, points, reason, decided_by) VALUES (?, ?, ?, ?, ?) RETURNING *")
    .bind(lagkod, pct, points, reason, body.decidedBy ?? null)
    .first();
  await logAdmin(c.env.DB, "avdrag_create", { lagkod, pct, points, reason });
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

// ---------- Röstkort (lista, filtrering och rättelse) ----------

/** Alla registrerade röstkort, filtrerbara på domare, lag och gren. */
adminRoutes.get("/votes", async (c) => {
  const q = c.req.query();
  const wheres: string[] = [];
  const binds: unknown[] = [];
  for (const [param, column] of [
    ["judgeId", "v.judge_id"],
    ["teamId", "a.team_id"],
    ["grenId", "a.gren_id"],
  ] as const) {
    const value = Number(q[param]);
    if (!q[param] || !Number.isFinite(value)) continue;
    wheres.push(`${column} = ?`);
    binds.push(value);
  }
  if (q["lagkod"]) {
    wheres.push("v.lagkod = ?");
    binds.push(q["lagkod"].trim().toUpperCase());
  }
  const limit = Math.min(Math.max(Number(q["limit"] ?? 500) || 500, 1), 2000);
  const { results } = await c.env.DB
    .prepare(
      `SELECT v.kortid, v.lagkod, v.judge_id, j.name AS judge, v.scores, v.comment, v.source,
              v.entered_by, v.created_at, v.edited_at, v.edited_by, v.edited_reason,
              t.name AS team, g.name AS gren
       FROM votes v
       JOIN judges j ON j.id = v.judge_id
       LEFT JOIN assignments a ON a.lagkod = v.lagkod
       LEFT JOIN teams t ON t.id = a.team_id
       LEFT JOIN grenar g ON g.id = a.gren_id
       ${wheres.length ? "WHERE " + wheres.join(" AND ") : ""}
       ORDER BY v.created_at DESC, v.rowid DESC
       LIMIT ?`,
    )
    .bind(...binds, limit)
    .all<{ scores: string }>();
  return c.json({
    votes: results.map(({ scores, ...v }) => ({ ...v, scores: JSON.parse(scores) as Record<string, number> })),
    limit,
  });
});

/** Rättar en registrerad röst. Ursprunglig tidsstämpel behålls; ändringen loggas. */
adminRoutes.patch("/votes/:kortid", async (c) => {
  const kortid = c.req.param("kortid").trim();
  const body = (await c.req.json().catch(() => ({}))) as {
    judge?: string;
    scores?: unknown;
    comment?: string;
    editedBy?: string;
    reason?: string;
  };
  const db = c.env.DB;
  const existing = await db
    .prepare(
      `SELECT v.kortid, v.lagkod, v.judge_id, j.name AS judge, v.scores, v.comment
       FROM votes v JOIN judges j ON j.id = v.judge_id WHERE v.kortid = ?`,
    )
    .bind(kortid)
    .first<{ kortid: string; lagkod: string; judge_id: number; judge: string; scores: string; comment: string | null }>();
  if (!existing) return c.json({ ok: false, code: "not_found", message: "Röstkortet är inte registrerat." }, 404);

  let judgeId = existing.judge_id;
  let judgeName = existing.judge;
  if (body.judge !== undefined) {
    judgeName = normalizeJudgeName(body.judge);
    if (!judgeName || judgeName.length > 60) {
      return c.json({ ok: false, code: "validation", message: "Ange ett giltigt domarnamn." }, 400);
    }
    judgeId = await resolveJudgeId(db, judgeName);
  }

  let scoresJson = existing.scores;
  if (body.scores !== undefined) {
    const checked = validateScores(await getActiveCriteria(db), body.scores);
    if (!checked.ok) return c.json({ ok: false, code: "validation", message: checked.message }, 400);
    scoresJson = stableScoreJson(checked.scores);
  }

  const comment = body.comment === undefined ? existing.comment : body.comment.trim().slice(0, 2000) || null;
  const editedBy = typeof body.editedBy === "string" ? body.editedBy.trim() || null : null;
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";

  if (judgeId === existing.judge_id && scoresJson === existing.scores && comment === existing.comment) {
    return c.json({ ok: true, unchanged: true });
  }
  // Motiveringen hör till just det här kortet — den är det som gör rättelsen granskbar.
  if (!reason) {
    return c.json({ ok: false, code: "validation", message: "Ange varför kortet rättas." }, 400);
  }

  await db.batch([
    db
      .prepare(
        `UPDATE votes SET judge_id = ?, scores = ?, comment = ?, edited_at = datetime('now'), edited_by = ?,
                edited_reason = ?
         WHERE kortid = ?`,
      )
      .bind(judgeId, scoresJson, comment, editedBy, reason, kortid),
    db
      .prepare(
        `INSERT INTO submission_log (kortid, lagkod, judge_name, scores, comment, source, entered_by, accepted, reason)
         VALUES (?, ?, ?, ?, ?, 'paper', ?, 1, 'admin_edit')`,
      )
      .bind(kortid, existing.lagkod, judgeName, scoresJson, comment, editedBy),
    db.prepare("INSERT INTO admin_log (action, detail) VALUES ('vote_edit', ?)").bind(
      JSON.stringify({
        kortid,
        lagkod: existing.lagkod,
        editedBy,
        reason,
        before: { judge: existing.judge, scores: JSON.parse(existing.scores), comment: existing.comment },
        after: { judge: judgeName, scores: JSON.parse(scoresJson), comment },
      }),
    ),
  ]);
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

const TID_STHLM = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Europe/Stockholm",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** D1:s datetime('now') är UTC ("YYYY-MM-DD HH:MM:SS"); exporten visar svensk tid. */
function svTid(utc: string | null): string {
  if (!utc) return "";
  const d = new Date(utc.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return utc;
  const p: Record<string, string> = {};
  for (const part of TID_STHLM.formatToParts(d)) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

function csvField(value: unknown): string {
  let s = value === null || value === undefined ? "" : String(value);
  // Excel kör fält som börjar med = + - @ (eller tab/CR) som formler — en inledande
  // apostrof neutraliserar utan att förstöra CSV-parsning. Poängen är alltid 0–10,
  // så inga riktiga värden börjar med de tecknen.
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[;"\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

adminRoutes.get("/export.csv", async (c) => {
  const db = c.env.DB;
  const [criteria, votes] = await Promise.all([
    db.prepare("SELECT key FROM criteria WHERE active = 1 ORDER BY sort").all<{ key: string }>(),
    db
      .prepare(
        `SELECT v.kortid, v.lagkod, t.name AS team, g.name AS gren, j.name AS judge,
                v.scores, v.comment, v.source, v.entered_by, v.created_at, v.edited_at, v.edited_by, v.edited_reason
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
        edited_at: string | null;
        edited_by: string | null;
        edited_reason: string | null;
      }>(),
  ]);
  const keys = criteria.results.map((r) => r.key);
  const header = [
    "kortid", "lagkod", "lag", "gren", "domare", ...keys,
    "kommentar", "källa", "registrerad_av", "tid", "ändrad", "ändrad_av", "ändringsmotivering",
  ];
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
        svTid(v.created_at),
        svTid(v.edited_at),
        v.edited_by ?? "",
        v.edited_reason ?? "",
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
