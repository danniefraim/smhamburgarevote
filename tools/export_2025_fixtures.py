#!/usr/bin/env python3
"""Exporterar 2025 års röstdata + officiella resultat till test/fixtures/replay2025.json.

Körs en gång (kräver pandas + openpyxl):
    python3 tools/export_2025_fixtures.py "../2025/SM i Hamburgare 2025 röstning (Svar).xlsx"

Fixturen är facit för motorns replay-test: rå-pipelinen ska reproducera de
officiella resultaten exakt, inklusive båda skiljeregelavgörandena.
"""
import json
import sys
from pathlib import Path

import pandas as pd

XLSX = Path(sys.argv[1])
OUT = Path(__file__).resolve().parent.parent / "test" / "fixtures" / "replay2025.json"

CRIT_MAP = {
    "Smak/Arom": "smak",
    "Textur/Mörhet": "textur",
    "Utseende/Visualitet": "utseende",
    "Kreativitet": "kreativitet",
}
ALIASES = {"Johan Broström de": "Johan Broström"}

weights_df = pd.read_excel(XLSX, sheet_name="Viktningar")
weights = {CRIT_MAP[c]: float(weights_df[c].iloc[0]) for c in CRIT_MAP}
criteria = [
    {"key": CRIT_MAP[c], "label": c, "weight": weights[CRIT_MAP[c]]}
    for c in CRIT_MAP
]

resp = pd.read_excel(XLSX, sheet_name="Formulärsvar 3")
resp = resp.dropna(subset=["Lagkod", "Röstkortets ID"]).sort_values("Tidstämpel")
resp = resp.drop_duplicates(subset=["Röstkortets ID"], keep="first")

votes = []
for _, r in resp.iterrows():
    judge = str(r["Domare"]).strip().strip(",.").strip()
    judge = ALIASES.get(judge, judge)
    votes.append({
        "kortid": str(r["Röstkortets ID"]).strip(),
        "lagkod": str(r["Lagkod"]).strip(),
        "judge": judge,
        "scores": {CRIT_MAP[c]: int(r[c]) for c in CRIT_MAP},
    })

lag = pd.read_excel(XLSX, sheet_name="Lag")
GREN_COLS = {
    "Vegetarisk": "Lagkod Vegetarisk",
    "Freestyle": "Lagkod Freestyle",
    "Hemliga Lådan": "Lagkod Hemliga Lådan",
    "Tjockpuck": "Lagkod Tjockpuck",
}
contributions = []
for gren, col in GREN_COLS.items():
    for _, r in lag.iterrows():
        code = r.get(col)
        if isinstance(code, str) and code.strip():
            contributions.append({"lagkod": code.strip(), "team": str(r["Lagnamn"]).strip(), "gren": gren})

known = {c["lagkod"] for c in contributions}
unmapped = sorted({v["lagkod"] for v in votes} - known)
assert not unmapped, f"Röster på okända lagkoder: {unmapped}"

avdrag_df = pd.read_excel(XLSX, sheet_name="Avdrag")
avdrag = [
    {"lagkod": str(r["Kod"]).strip(), "pct": float(r["Avdrag"]), "reason": str(r["Anmärkning"])}
    for _, r in avdrag_df.iterrows()
    if isinstance(r.get("Kod"), str) and str(r["Kod"]).strip()
]

OFFICIAL_TABS = {
    "Vegetarisk": ("Vegetarisk", "Poäng vegetarisk"),
    "Freestyle": ("Freestyle", "Poäng Freestyle"),
    "Hemliga Lådan": ("Hemliga lådan", "Poäng Hemliga lådan"),
    "Tjockpuck": ("Tjockpuck", "Poäng Tjockpuck"),
}
official = {}
for gren, (tab, score_col) in OFFICIAL_TABS.items():
    df = pd.read_excel(XLSX, sheet_name=tab).dropna(subset=["Lagnamn"])
    official[gren] = [
        {"team": str(r["Lagnamn"]).strip(), "score": float(r[score_col])}
        for _, r in df.iterrows()
    ]

tot = pd.read_excel(XLSX, sheet_name="Totalpoäng").dropna(subset=["Lagnamn"])
official_totals = [
    {"team": str(r["Lagnamn"]).strip(), "score": float(r["Poäng totalt"])}
    for _, r in tot.iterrows()
]

fixture = {
    "criteria": criteria,
    "grenar": [
        {"name": "Freestyle", "inTotal": True},
        {"name": "Hemliga Lådan", "inTotal": True},
        {"name": "Tjockpuck", "inTotal": True},
        {"name": "Vegetarisk", "inTotal": False},
    ],
    "votes": votes,
    "contributions": contributions,
    "avdrag": avdrag,
    "official": official,
    "officialTotals": official_totals,
}
OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps(fixture, ensure_ascii=False, indent=1))
print(f"{len(votes)} röster, {len(contributions)} bidrag, {len(avdrag)} avdrag -> {OUT}")
for gren in official:
    print(f"  {gren}: {len(official[gren])} officiella rader")
print(f"  Totalpoäng: {len(official_totals)} rader")
