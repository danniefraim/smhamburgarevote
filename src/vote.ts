import { getActiveCriteria, resolveJudgeId, type CriterionRow } from "./db";

export type VotePayload = Record<string, unknown>;

export interface SubmitOptions {
  source: "digital" | "paper";
  enteredBy?: string;
  /** Admin kan ersätta en redan registrerad röst — loggas alltid. */
  override?: boolean;
}

export type SubmitResult =
  | { status: "accepted"; lagkod: string }
  | { status: "replaced"; lagkod: string }
  | { status: "duplicate"; lagkod: string; identical: boolean }
  | { status: "rejected"; code: string; message: string };

export function normalizeJudgeName(raw: string): string {
  return raw.replace(/\s+/g, " ").replace(/[\s,.]+$/g, "").trim();
}

export function stableScoreJson(scores: Record<string, number>): string {
  const sorted = Object.keys(scores).sort();
  return JSON.stringify(Object.fromEntries(sorted.map((k) => [k, scores[k]])));
}

export type ScoreCheck = { ok: true; scores: Record<string, number> } | { ok: false; message: string };

/** Kräver ett heltal 0–10 för varje aktivt kriterium, och inga okända kriterier. */
export function validateScores(criteria: CriterionRow[], raw: unknown): ScoreCheck {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, message: "Poäng saknas." };
  }
  const scores = raw as Record<string, unknown>;
  const clean: Record<string, number> = {};
  for (const c of criteria) {
    const v = scores[c.key];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 10) {
      return { ok: false, message: `Ogiltig poäng för ${c.label ?? c.key} (heltal 0–10 krävs).` };
    }
    clean[c.key] = v;
  }
  const extra = Object.keys(scores).filter((k) => !criteria.some((c) => c.key === k));
  if (extra.length > 0) return { ok: false, message: `Okända kriterier: ${extra.join(", ")}.` };
  return { ok: true, scores: clean };
}

export async function submitVote(db: D1Database, payload: VotePayload, opts: SubmitOptions): Promise<SubmitResult> {
  const kortid = typeof payload.kortid === "string" ? payload.kortid.trim() : "";
  const lagkodIn = typeof payload.lagkod === "string" ? payload.lagkod.trim().toUpperCase() : "";
  const judgeName = typeof payload.judge === "string" ? normalizeJudgeName(payload.judge) : "";
  const comment = typeof payload.comment === "string" ? payload.comment.trim().slice(0, 2000) : "";
  const rawScores = payload.scores;

  async function reject(code: string, message: string): Promise<SubmitResult> {
    // Avvisade försök loggas med kapade fält: endpointen är öppen och oautentiserad,
    // så okapade payloads vore ett gratis sätt att fylla databasen med skräp.
    await db
      .prepare(
        `INSERT INTO submission_log (kortid, lagkod, judge_name, scores, comment, source, entered_by, accepted, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      )
      .bind(
        kortid.slice(0, 100) || null,
        lagkodIn.slice(0, 40) || null,
        judgeName.slice(0, 200) || null,
        rawScores ? JSON.stringify(rawScores).slice(0, 2000) : null,
        comment || null,
        opts.source,
        opts.enteredBy ?? null,
        code,
      )
      .run();
    return { status: "rejected", code, message };
  }

  if (!kortid) return reject("validation", "Röstkortets ID saknas.");
  if (!judgeName || judgeName.length > 60) return reject("validation", "Ange ett giltigt domarnamn.");

  const criteria = await getActiveCriteria(db);
  const checked = validateScores(criteria, rawScores);
  if (!checked.ok) return reject("validation", checked.message);
  const clean = checked.scores;

  const card = await db.prepare("SELECT lagkod FROM cards WHERE kortid = ?").bind(kortid).first<{ lagkod: string }>();
  if (!card) return reject("unknown_card", "Röstkortet finns inte i registret.");
  if (lagkodIn && lagkodIn !== card.lagkod) {
    return reject("card_mismatch", "Kortets ID hör inte ihop med angiven lagkod.");
  }
  const lagkod = card.lagkod;

  const judgeId = await resolveJudgeId(db, judgeName);
  const scoresJson = stableScoreJson(clean);

  const insert = await db
    .prepare(
      `INSERT INTO votes (kortid, lagkod, judge_id, scores, comment, source, entered_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (kortid) DO NOTHING`,
    )
    .bind(kortid, lagkod, judgeId, scoresJson, comment || null, opts.source, opts.enteredBy ?? null)
    .run();

  if (insert.meta.changes === 1) {
    await db
      .prepare(
        `INSERT INTO submission_log (kortid, lagkod, judge_name, scores, comment, source, entered_by, accepted, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'accepted')`,
      )
      .bind(kortid, lagkod, judgeName, scoresJson, comment || null, opts.source, opts.enteredBy ?? null)
      .run();
    return { status: "accepted", lagkod };
  }

  // Kortet är redan registrerat: först vinner.
  const existing = await db
    .prepare("SELECT judge_id, scores, comment FROM votes WHERE kortid = ?")
    .bind(kortid)
    .first<{ judge_id: number; scores: string; comment: string | null }>();
  const identical =
    existing !== null &&
    existing.judge_id === judgeId &&
    existing.scores === scoresJson &&
    (existing.comment ?? "") === comment;

  if (opts.override) {
    await db.batch([
      db
        .prepare(
          `UPDATE votes SET judge_id = ?, scores = ?, comment = ?, source = ?, entered_by = ?, created_at = datetime('now')
           WHERE kortid = ?`,
        )
        .bind(judgeId, scoresJson, comment || null, opts.source, opts.enteredBy ?? null, kortid),
      db
        .prepare(
          `INSERT INTO submission_log (kortid, lagkod, judge_name, scores, comment, source, entered_by, accepted, reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'admin_override')`,
        )
        .bind(kortid, lagkod, judgeName, scoresJson, comment || null, opts.source, opts.enteredBy ?? null),
      db
        .prepare("INSERT INTO admin_log (action, detail) VALUES ('vote_override', ?)")
        .bind(JSON.stringify({ kortid, lagkod, judge: judgeName, enteredBy: opts.enteredBy ?? null })),
    ]);
    return { status: "replaced", lagkod };
  }

  await db
    .prepare(
      `INSERT INTO submission_log (kortid, lagkod, judge_name, scores, comment, source, entered_by, accepted, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    )
    .bind(
      kortid,
      lagkod,
      judgeName,
      scoresJson,
      comment || null,
      opts.source,
      opts.enteredBy ?? null,
      identical ? "duplicate_identical" : "duplicate_conflict",
    )
    .run();
  return { status: "duplicate", lagkod, identical };
}
