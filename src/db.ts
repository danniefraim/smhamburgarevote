import type { AvdragIn, ContributionIn, CriterionDef, GrenDef, VoteIn } from "./scoring";

export interface CriterionRow {
  id: number;
  key: string;
  label: string;
  weight: number;
  sort: number;
  active: number;
}

export interface GrenRow {
  id: number;
  name: string;
  sort: number;
  in_total: number;
  active: number;
}

export async function getSettings(db: D1Database): Promise<Record<string, string>> {
  const { results } = await db.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
  return Object.fromEntries(results.map((r) => [r.key, r.value]));
}

export async function getActiveCriteria(db: D1Database): Promise<CriterionRow[]> {
  const { results } = await db
    .prepare("SELECT id, key, label, weight, sort, active FROM criteria WHERE active = 1 ORDER BY sort")
    .all<CriterionRow>();
  return results;
}

export interface ScoringInputs {
  votes: VoteIn[];
  contributions: ContributionIn[];
  criteria: CriterionDef[];
  grenar: GrenDef[];
  avdrag: AvdragIn[];
}

export async function loadScoringInputs(db: D1Database): Promise<ScoringInputs> {
  const [criteria, grenar, votes, contributions, avdrag] = await Promise.all([
    getActiveCriteria(db),
    db.prepare("SELECT name, in_total FROM grenar WHERE active = 1 ORDER BY sort").all<{ name: string; in_total: number }>(),
    db
      .prepare(
        "SELECT v.lagkod, j.name AS judge, v.scores FROM votes v JOIN judges j ON j.id = v.judge_id",
      )
      .all<{ lagkod: string; judge: string; scores: string }>(),
    db
      .prepare(
        `SELECT a.lagkod, t.name AS team, g.name AS gren
         FROM assignments a
         JOIN teams t ON t.id = a.team_id
         JOIN grenar g ON g.id = a.gren_id
         WHERE t.active = 1 AND g.active = 1`,
      )
      .all<{ lagkod: string; team: string; gren: string }>(),
    db
      .prepare("SELECT lagkod, pct, points FROM avdrag WHERE revoked_at IS NULL")
      .all<{ lagkod: string; pct: number; points: number }>(),
  ]);

  return {
    criteria: criteria.map((c) => ({ key: c.key, weight: c.weight, label: c.label })),
    grenar: grenar.results.map((g) => ({ name: g.name, inTotal: g.in_total === 1 })),
    votes: votes.results.map((v) => ({
      lagkod: v.lagkod,
      judge: v.judge,
      scores: JSON.parse(v.scores) as Record<string, number>,
    })),
    contributions: contributions.results,
    avdrag: avdrag.results,
  };
}

/** Slår upp domare på namn (skiftlägesokänsligt), följer alias och skapar vid behov. */
export async function resolveJudgeId(db: D1Database, name: string): Promise<number> {
  const existing = await db
    .prepare("SELECT id, alias_of FROM judges WHERE name = ?")
    .bind(name)
    .first<{ id: number; alias_of: number | null }>();
  if (existing) return existing.alias_of ?? existing.id;
  const inserted = await db
    .prepare("INSERT INTO judges (name) VALUES (?) RETURNING id")
    .bind(name)
    .first<{ id: number }>();
  if (!inserted) throw new Error("Kunde inte skapa domare");
  return inserted.id;
}

export async function logAdmin(db: D1Database, action: string, detail: unknown): Promise<void> {
  await db.prepare("INSERT INTO admin_log (action, detail) VALUES (?, ?)").bind(action, JSON.stringify(detail)).run();
}
