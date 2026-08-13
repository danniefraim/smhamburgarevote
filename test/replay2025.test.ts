/**
 * Replay-testet: motorn måste reproducera de officiella resultaten från
 * SM i Hamburgare 2025 exakt utifrån rårösterna — inklusive avdragen och
 * båda skiljeregelavgörandena (Freestyle guld, Hemliga Lådan silver).
 */
import { describe, expect, it } from "vitest";
import { computeResults, type Results } from "../src/scoring";
import fixture from "./fixtures/replay2025.json";

const TOL = 1e-6;

const grenNames = fixture.grenar.map((g) => g.name);

function officialFor(gren: string): { team: string; score: number }[] {
  const competing = new Set(fixture.contributions.filter((c) => c.gren === gren).map((c) => c.team));
  return fixture.official[gren as keyof typeof fixture.official].filter((r) => competing.has(r.team));
}

function run(method: "raw" | "adjusted", dampingK: number): Results {
  return computeResults(fixture.votes, fixture.contributions, fixture.criteria, fixture.grenar, fixture.avdrag, {
    method,
    dampingK,
  });
}

describe("replay av SM 2025", () => {
  const raw = run("raw", 5); // rå-poäng påverkas inte av dämpningen

  it("fixturen är komplett", () => {
    expect(fixture.votes).toHaveLength(552);
    expect(fixture.contributions).toHaveLength(87);
    expect(fixture.avdrag).toHaveLength(3);
  });

  for (const gren of ["Freestyle", "Hemliga Lådan", "Tjockpuck", "Vegetarisk"]) {
    it(`reproducerar officiella resultatet i ${gren} (poäng och ordning)`, () => {
      const official = officialFor(gren);
      const engine = raw.standings[gren]!;
      expect(engine).toHaveLength(official.length);
      // Ordningen jämförs grupp för grupp: inom en grupp med exakt lika officiell
      // poäng är arkets radordning godtycklig (2025 tillämpade bara skiljeregeln
      // på medaljplatser) — där räcker mängdlikhet. Medaljskiljereglerna
      // verifieras separat nedan.
      let i = 0;
      while (i < official.length) {
        let j = i + 1;
        while (j < official.length && Math.abs(official[j]!.score - official[i]!.score) < 1e-9) j++;
        expect(new Set(engine.slice(i, j).map((e) => e.team))).toEqual(
          new Set(official.slice(i, j).map((o) => o.team)),
        );
        i = j;
      }
      for (let k = 0; k < official.length; k++) {
        expect(Math.abs(engine[k]!.final - official[k]!.score)).toBeLessThan(TOL);
      }
    });
  }

  it("reproducerar skiljeregelavgörandena från 2025", () => {
    const freestyle = raw.standings["Freestyle"]!;
    expect(freestyle[0]!.team).toBe("Smooth Hill");
    expect(freestyle[0]!.tieBreakUsed).toBe("smak");
    const hemliga = raw.standings["Hemliga Lådan"]!;
    expect(hemliga[1]!.team).toBe("Burn BBQ");
    expect(hemliga[1]!.tieBreakUsed).toBe("smak");
  });

  it("reproducerar officiell totalpoäng", () => {
    const byTeam = new Map(raw.totals.map((t) => [t.team, t.total]));
    for (const row of fixture.officialTotals) {
      expect(Math.abs((byTeam.get(row.team) ?? NaN) - row.score)).toBeLessThan(TOL);
    }
    // Ordningsinvariant: alla par med tydligt skilda officiella poäng ska rankas likadant.
    const rank = new Map(raw.totals.map((t, i) => [t.team, i]));
    for (let i = 0; i < fixture.officialTotals.length; i++) {
      for (let j = i + 1; j < fixture.officialTotals.length; j++) {
        const a = fixture.officialTotals[i]!;
        const b = fixture.officialTotals[j]!;
        if (a.score - b.score > 1e-9) {
          expect(rank.get(a.team)!).toBeLessThan(rank.get(b.team)!);
        }
      }
    }
  });

  it("stränghetsjusteringen (utan dämpning) behåller alla grenvinnare och pallplatser från 2025", () => {
    const adjusted = run("adjusted", 0);
    for (const gren of grenNames) {
      const official = officialFor(gren);
      const engine = adjusted.standings[gren]!;
      expect(engine[0]!.team).toBe(official[0]!.team);
      const officialPodium = new Set(official.slice(0, 3).map((o) => o.team));
      const enginePodium = new Set(engine.slice(0, 3).map((e) => e.team));
      expect(enginePodium).toEqual(officialPodium);
    }
    expect(adjusted.totals[0]!.team).toBe(fixture.officialTotals[0]!.team);
  });

  it("skattar domarnas stränghet i nivå med analysen", () => {
    const adjusted = run("adjusted", 0);
    const sev = Object.fromEntries(adjusted.severities.map((s) => [s.judge, s.severity]));
    expect(sev["Selin"]).toBeCloseTo(-1.48, 1);
    expect(sev["Pierre"]).toBeCloseTo(0.99, 1);
  });
});
