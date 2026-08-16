import { describe, expect, it } from "vitest";
import {
  computeResults,
  weightedScore,
  type AvdragIn,
  type ContributionIn,
  type CriterionDef,
  type GrenDef,
  type VoteIn,
} from "../src/scoring";

const CRIT: CriterionDef[] = [
  { key: "smak", weight: 0.5 },
  { key: "textur", weight: 0.5 },
];
const GRENAR: GrenDef[] = [{ name: "Testgren", inTotal: true }];

function vote(lagkod: string, judge: string, smak: number, textur: number): VoteIn {
  return { lagkod, judge, scores: { smak, textur } };
}
const contrib = (lagkod: string, team: string, gren = "Testgren"): ContributionIn => ({ lagkod, team, gren });

describe("weightedScore", () => {
  it("summerar vikt × poäng", () => {
    expect(weightedScore({ smak: 8, textur: 6 }, CRIT)).toBeCloseTo(7, 10);
  });

  it("kastar fel om ett kriterium saknas", () => {
    expect(() => weightedScore({ smak: 8 }, CRIT)).toThrow(/saknar kriterium/);
  });
});

describe("stränghetsskattning", () => {
  // Två domare som båda provar båda burgarna; A ligger konsekvent +2 över B.
  const votes = [
    vote("AAAA", "Generös", 6, 6),
    vote("AAAA", "Sträng", 4, 4),
    vote("BBBB", "Generös", 8, 8),
    vote("BBBB", "Sträng", 6, 6),
  ];
  const contribs = [contrib("AAAA", "Lag 1"), contrib("BBBB", "Lag 2")];

  it("hittar systematisk skillnad utan dämpning", () => {
    const res = computeResults(votes, contribs, CRIT, GRENAR, [], { method: "adjusted", dampingK: 0 });
    const sev = Object.fromEntries(res.severities.map((s) => [s.judge, s.severity]));
    expect(sev["Generös"]).toBeCloseTo(1, 6);
    expect(sev["Sträng"]).toBeCloseTo(-1, 6);
    const standing = res.standings["Testgren"]!;
    expect(standing[0]!.team).toBe("Lag 2");
    expect(standing[0]!.adjusted).toBeCloseTo(7, 6);
    expect(standing[1]!.adjusted).toBeCloseTo(5, 6);
    // Justeringen ändrar inte rå poäng.
    expect(standing[0]!.raw).toBeCloseTo(7, 6);
    expect(standing[1]!.raw).toBeCloseTo(5, 6);
  });

  it("dämpar skattningen för domare med få röster", () => {
    const res = computeResults(votes, contribs, CRIT, GRENAR, [], { method: "adjusted", dampingK: 2 });
    const sev = Object.fromEntries(res.severities.map((s) => [s.judge, s.severity]));
    // residualsumma 2 delat på (n=2 + K=2) = 0.5
    expect(sev["Generös"]).toBeCloseTo(0.5, 6);
    expect(sev["Sträng"]).toBeCloseTo(-0.5, 6);
  });

  it("röster på otilldelade lagkoder bidrar till skattningen men syns inte i listan", () => {
    const extra = [...votes, vote("ZZZZ", "Generös", 9, 9), vote("ZZZZ", "Sträng", 7, 7)];
    const res = computeResults(extra, contribs, CRIT, GRENAR, [], { method: "adjusted", dampingK: 0 });
    expect(res.standings["Testgren"]!).toHaveLength(2);
    const gen = res.severities.find((s) => s.judge === "Generös")!;
    expect(gen.n).toBe(3);
    expect(gen.severity).toBeCloseTo(1, 6);
  });
});

describe("avdrag", () => {
  const votes = [vote("AAAA", "D1", 8, 8)];
  const contribs = [contrib("AAAA", "Lag 1")];

  it("multiplicerar poängen med (1 - pct)", () => {
    const avdrag: AvdragIn[] = [{ lagkod: "AAAA", pct: 0.5 }];
    const res = computeResults(votes, contribs, CRIT, GRENAR, avdrag, { method: "raw", dampingK: 0 });
    expect(res.standings["Testgren"]![0]!.final).toBeCloseTo(4, 6);
  });

  it("flera avdrag multipliceras ihop", () => {
    const avdrag: AvdragIn[] = [
      { lagkod: "AAAA", pct: 0.5 },
      { lagkod: "AAAA", pct: 0.2 },
    ];
    const res = computeResults(votes, contribs, CRIT, GRENAR, avdrag, { method: "raw", dampingK: 0 });
    expect(res.standings["Testgren"]![0]!.factor).toBeCloseTo(0.4, 6);
    expect(res.standings["Testgren"]![0]!.final).toBeCloseTo(3.2, 6);
  });

  it("100 % avdrag nollar bidraget", () => {
    const res = computeResults(votes, contribs, CRIT, GRENAR, [{ lagkod: "AAAA", pct: 1 }], {
      method: "raw",
      dampingK: 0,
    });
    expect(res.standings["Testgren"]![0]!.final).toBe(0);
  });

  it("fast poängavdrag dras från slutpoängen", () => {
    const avdrag: AvdragIn[] = [{ lagkod: "AAAA", pct: 0, points: 2.5 }];
    const res = computeResults(votes, contribs, CRIT, GRENAR, avdrag, { method: "raw", dampingK: 0 });
    const entry = res.standings["Testgren"]![0]!;
    expect(entry.deduction).toBeCloseTo(2.5, 6);
    expect(entry.final).toBeCloseTo(5.5, 6);
  });

  it("procent dras först, fasta poäng därefter", () => {
    const avdrag: AvdragIn[] = [
      { lagkod: "AAAA", pct: 0.5 },
      { lagkod: "AAAA", pct: 0, points: 1 },
    ];
    const res = computeResults(votes, contribs, CRIT, GRENAR, avdrag, { method: "raw", dampingK: 0 });
    // 8 × 0,5 = 4, minus 1 poäng = 3.
    expect(res.standings["Testgren"]![0]!.final).toBeCloseTo(3, 6);
  });

  it("poängavdrag kan inte pressa bidraget under noll", () => {
    const avdrag: AvdragIn[] = [{ lagkod: "AAAA", pct: 0, points: 99 }];
    const res = computeResults(votes, contribs, CRIT, GRENAR, avdrag, { method: "raw", dampingK: 0 });
    expect(res.standings["Testgren"]![0]!.final).toBe(0);
  });
});

describe("skiljeregler", () => {
  it("avgör lika slutpoäng på kriteriet med högst vikt där de skiljer sig", () => {
    // Båda får viktad poäng 6.0, men A har högre smak.
    const votes = [vote("AAAA", "D1", 8, 4), vote("BBBB", "D2", 6, 6)];
    const contribs = [contrib("AAAA", "Lag A"), contrib("BBBB", "Lag B")];
    const res = computeResults(votes, contribs, CRIT, GRENAR, [], { method: "raw", dampingK: 5 });
    const list = res.standings["Testgren"]!;
    expect(list[0]!.team).toBe("Lag A");
    expect(list[0]!.tieBreakUsed).toBe("smak");
    expect(list[1]!.tieBreakUsed).toBe("smak");
    expect(list[0]!.unresolvedTie).toBeUndefined();
  });

  it("flaggar helt identiska resultat för lottning", () => {
    const votes = [vote("AAAA", "D1", 6, 6), vote("BBBB", "D2", 6, 6)];
    const contribs = [contrib("AAAA", "Lag A"), contrib("BBBB", "Lag B")];
    const res = computeResults(votes, contribs, CRIT, GRENAR, [], { method: "raw", dampingK: 5 });
    expect(res.standings["Testgren"]![0]!.unresolvedTie).toBe(true);
    expect(res.standings["Testgren"]![1]!.unresolvedTie).toBe(true);
  });
});

describe("ofullständiga bidrag och totalpoäng", () => {
  it("bidrag utan röster hamnar sist med 0 poäng", () => {
    const votes = [vote("AAAA", "D1", 5, 5)];
    const contribs = [contrib("AAAA", "Lag A"), contrib("CCCC", "Lag C")];
    const res = computeResults(votes, contribs, CRIT, GRENAR, [], { method: "raw", dampingK: 5 });
    const list = res.standings["Testgren"]!;
    expect(list[1]!.team).toBe("Lag C");
    expect(list[1]!.n).toBe(0);
    expect(list[1]!.final).toBe(0);
  });

  it("totalpoäng summerar endast grenar som ingår; saknad gren räknas som 0", () => {
    const grenar: GrenDef[] = [
      { name: "Gren 1", inTotal: true },
      { name: "Gren 2", inTotal: true },
      { name: "Utanför", inTotal: false },
    ];
    const votes = [
      vote("AAAA", "D1", 8, 8),
      vote("BBBB", "D1", 6, 6),
      vote("CCCC", "D1", 4, 4),
      vote("DDDD", "D1", 10, 10),
    ];
    const contribs = [
      contrib("AAAA", "Lag A", "Gren 1"),
      contrib("BBBB", "Lag A", "Gren 2"),
      contrib("CCCC", "Lag B", "Gren 1"),
      contrib("DDDD", "Lag B", "Utanför"),
    ];
    const res = computeResults(votes, contribs, CRIT, grenar, [], { method: "raw", dampingK: 5 });
    const byTeam = Object.fromEntries(res.totals.map((t) => [t.team, t]));
    expect(byTeam["Lag A"]!.total).toBeCloseTo(14, 6);
    expect(byTeam["Lag B"]!.total).toBeCloseTo(4, 6);
    expect(byTeam["Lag B"]!.perGren["Gren 2"]).toBeUndefined();
    expect(res.totals[0]!.team).toBe("Lag A");
  });
});
