/**
 * Ren beräkningsmotor — inga databasberoenden, all indata som värden.
 *
 * Poängmodell:
 *   viktad röst      w = Σ vikt_k × poäng_k
 *   rå poäng         medel(w) × avdragsfaktor
 *   justerad poäng   medel(w − stränghet_domare) × avdragsfaktor
 *
 * Strängheten skattas med en additiv modell (bidragskvalitet + domarstränghet),
 * anpassad med alternerande minsta-kvadrat över samtliga röster. dampingK > 0
 * krymper skattningen för domare med få röster: stränghet = residualsumma / (n + K).
 */

export interface CriterionDef {
  key: string;
  weight: number;
  label?: string;
}

export interface GrenDef {
  name: string;
  inTotal: boolean;
}

export interface VoteIn {
  lagkod: string;
  judge: string;
  scores: Record<string, number>;
}

export interface ContributionIn {
  lagkod: string;
  team: string;
  gren: string;
}

export interface AvdragIn {
  lagkod: string;
  pct: number;
}

export interface ScoringOptions {
  method: "adjusted" | "raw";
  dampingK: number;
}

export interface JudgeSeverity {
  judge: string;
  n: number;
  severity: number;
}

export interface StandingEntry {
  lagkod: string;
  team: string;
  gren: string;
  n: number;
  factor: number;
  raw: number;
  adjusted: number;
  final: number;
  rawCrit: Record<string, number>;
  adjCrit: Record<string, number>;
  tieBreakUsed?: string;
  unresolvedTie?: boolean;
}

export interface TotalEntry {
  team: string;
  perGren: Record<string, number>;
  total: number;
  tieBreakUsed?: string;
  unresolvedTie?: boolean;
}

export interface Results {
  severities: JudgeSeverity[];
  standings: Record<string, StandingEntry[]>;
  totals: TotalEntry[];
}

const EPS = 1e-9;
const MAX_ITER = 1000;
const CONVERGENCE = 1e-12;

export function weightedScore(scores: Record<string, number>, criteria: CriterionDef[]): number {
  let sum = 0;
  for (const c of criteria) {
    const v = scores[c.key];
    if (v === undefined || Number.isNaN(v)) {
      throw new Error(`Röst saknar kriterium '${c.key}'`);
    }
    sum += c.weight * v;
  }
  return sum;
}

/**
 * Alternerande minsta-kvadrat för modellen värde ≈ kvalitet(lagkod) + stränghet(domare).
 * `values` är ett värde per röst (viktad poäng eller ett enskilt kriterium).
 * Returnerar stränghet per domare, röstviktat centrerad kring 0.
 */
function fitSeverity(
  votes: VoteIn[],
  values: number[],
  dampingK: number,
): Map<string, number> {
  const judges = new Map<string, number[]>(); // domare -> röstindex
  const groups = new Map<string, number[]>(); // lagkod -> röstindex
  votes.forEach((v, i) => {
    let j = judges.get(v.judge);
    if (!j) judges.set(v.judge, (j = []));
    j.push(i);
    let g = groups.get(v.lagkod);
    if (!g) groups.set(v.lagkod, (g = []));
    g.push(i);
  });

  const sev = new Map<string, number>();
  for (const name of judges.keys()) sev.set(name, 0);

  for (let iter = 0; iter < MAX_ITER; iter++) {
    const qual = new Map<string, number>();
    for (const [lagkod, idxs] of groups) {
      let s = 0;
      for (const i of idxs) s += values[i]! - sev.get(votes[i]!.judge)!;
      qual.set(lagkod, s / idxs.length);
    }

    let maxDelta = 0;
    const next = new Map<string, number>();
    for (const [name, idxs] of judges) {
      let s = 0;
      for (const i of idxs) s += values[i]! - qual.get(votes[i]!.lagkod)!;
      next.set(name, s / (idxs.length + dampingK));
    }
    let center = 0;
    for (const v of votes) center += next.get(v.judge)!;
    center /= votes.length;
    for (const [name, value] of next) {
      const centered = value - center;
      maxDelta = Math.max(maxDelta, Math.abs(centered - sev.get(name)!));
      next.set(name, centered);
    }
    for (const [name, value] of next) sev.set(name, value);
    if (maxDelta < CONVERGENCE) break;
  }
  return sev;
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function computeResults(
  votes: VoteIn[],
  contributions: ContributionIn[],
  criteria: CriterionDef[],
  grenar: GrenDef[],
  avdrag: AvdragIn[],
  options: ScoringOptions,
): Results {
  const weighted = votes.map((v) => weightedScore(v.scores, criteria));
  const sevTotal = fitSeverity(votes, weighted, options.dampingK);
  const sevCrit = new Map<string, Map<string, number>>();
  for (const c of criteria) {
    sevCrit.set(c.key, fitSeverity(votes, votes.map((v) => v.scores[c.key]!), options.dampingK));
  }

  const votesByLagkod = new Map<string, number[]>();
  votes.forEach((v, i) => {
    let g = votesByLagkod.get(v.lagkod);
    if (!g) votesByLagkod.set(v.lagkod, (g = []));
    g.push(i);
  });

  const factorByLagkod = new Map<string, number>();
  for (const a of avdrag) {
    const prev = factorByLagkod.get(a.lagkod) ?? 1;
    factorByLagkod.set(a.lagkod, prev * (1 - Math.min(1, Math.max(0, a.pct))));
  }

  // Kriterier i skiljeregelordning: fallande vikt.
  const tieOrder = [...criteria].sort((a, b) => b.weight - a.weight);

  const entries: StandingEntry[] = contributions.map((c) => {
    const idxs = votesByLagkod.get(c.lagkod) ?? [];
    const factor = factorByLagkod.get(c.lagkod) ?? 1;
    const rawCrit: Record<string, number> = {};
    const adjCrit: Record<string, number> = {};
    for (const crit of criteria) {
      const raw = idxs.map((i) => votes[i]!.scores[crit.key]!);
      const adj = idxs.map((i) => votes[i]!.scores[crit.key]! - sevCrit.get(crit.key)!.get(votes[i]!.judge)!);
      rawCrit[crit.key] = mean(raw) * factor;
      adjCrit[crit.key] = mean(adj) * factor;
    }
    const raw = mean(idxs.map((i) => weighted[i]!)) * factor;
    const adjusted = mean(idxs.map((i) => weighted[i]! - sevTotal.get(votes[i]!.judge)!)) * factor;
    return {
      lagkod: c.lagkod,
      team: c.team,
      gren: c.gren,
      n: idxs.length,
      factor,
      raw,
      adjusted,
      final: options.method === "adjusted" ? adjusted : raw,
      rawCrit,
      adjCrit,
    };
  });

  const critValues = (e: StandingEntry) => (options.method === "adjusted" ? e.adjCrit : e.rawCrit);

  function compareEntries(a: StandingEntry, b: StandingEntry): number {
    if (Math.abs(a.final - b.final) > EPS) return b.final - a.final;
    for (const crit of tieOrder) {
      const av = critValues(a)[crit.key] ?? 0;
      const bv = critValues(b)[crit.key] ?? 0;
      if (Math.abs(av - bv) > EPS) return bv - av;
    }
    return 0;
  }

  function annotateTies<T extends { final?: number; total?: number; tieBreakUsed?: string; unresolvedTie?: boolean }>(
    sorted: T[],
    score: (x: T) => number,
    crits: (x: T) => Record<string, number>,
  ): void {
    for (let i = 0; i + 1 < sorted.length; i++) {
      const a = sorted[i]!;
      const b = sorted[i + 1]!;
      if (Math.abs(score(a) - score(b)) > EPS) continue;
      let used: string | undefined;
      for (const crit of tieOrder) {
        const av = crits(a)[crit.key] ?? 0;
        const bv = crits(b)[crit.key] ?? 0;
        if (Math.abs(av - bv) > EPS) {
          used = crit.key;
          break;
        }
      }
      if (used) {
        a.tieBreakUsed = a.tieBreakUsed ?? used;
        b.tieBreakUsed = b.tieBreakUsed ?? used;
      } else {
        a.unresolvedTie = true;
        b.unresolvedTie = true;
      }
    }
  }

  const standings: Record<string, StandingEntry[]> = {};
  for (const gren of grenar) {
    const list = entries.filter((e) => e.gren === gren.name).sort(compareEntries);
    annotateTies(list, (e) => e.final, critValues);
    standings[gren.name] = list;
  }

  // Totalpoäng: summan av slutpoängen i grenar som ingår; lag utan bidrag i en gren får 0 där.
  const totalGrenar = grenar.filter((g) => g.inTotal).map((g) => g.name);
  const teams = new Map<string, TotalEntry & { critSums: Record<string, number> }>();
  for (const e of entries) {
    if (!totalGrenar.includes(e.gren)) continue;
    let t = teams.get(e.team);
    if (!t) {
      const critSums: Record<string, number> = {};
      for (const c of criteria) critSums[c.key] = 0;
      teams.set(e.team, (t = { team: e.team, perGren: {}, total: 0, critSums }));
    }
    t.perGren[e.gren] = e.final;
    t.total += e.final;
    for (const c of criteria) t.critSums[c.key]! += critValues(e)[c.key] ?? 0;
  }
  const totals = [...teams.values()].sort((a, b) => {
    if (Math.abs(a.total - b.total) > EPS) return b.total - a.total;
    for (const crit of tieOrder) {
      const av = a.critSums[crit.key] ?? 0;
      const bv = b.critSums[crit.key] ?? 0;
      if (Math.abs(av - bv) > EPS) return bv - av;
    }
    return 0;
  });
  annotateTies(totals, (t) => t.total, (t) => t.critSums);

  const severities: JudgeSeverity[] = [...sevTotal.entries()]
    .map(([judge, severity]) => ({
      judge,
      severity,
      n: votes.filter((v) => v.judge === judge).length,
    }))
    .sort((a, b) => a.severity - b.severity);

  return {
    severities,
    standings,
    totals: totals.map(({ critSums: _drop, ...t }) => t),
  };
}
