# SM i Hamburgare – röstsystem

Röstsystem för SM i Hamburgare: domare skannar anonyma QR-röstkort och poängsätter,
huvuddomaren följer kompletthet och resultat live, pappersröstkort matas in parallellt.
Byggt på Cloudflare Workers + D1 med statiska sidor — en deploy, inga servrar.

## Principer

- **Papper är golvet.** Systemet får aldrig vara en förutsättning för att tävlingen ska
  kunna genomföras. Vid strul: fyll i papperskortet, mata in senare.
- **Först vinner.** En röst per kort (`kortid` är primärnyckel). Omregistreringar ändrar
  inget — de loggas och flaggas. Medveten korrigering görs som loggad admin-override.
- **Allt years-specifikt är data, inte kod:** grenar, kriterier, vikter, lag och domare
  redigeras i admin.
- **Poängmetod:** viktat medel × (1 − avdrag), med stränghetsjustering enligt
  tävlingsreglerna (Variant A). Metoden och dämpningen är inställningar.
- **Facit-test:** motorn reproducerar de officiella resultaten från SM 2025 exakt ur
  rårösterna, inklusive skiljereglerna (`test/replay2025.test.ts`).

## Sidor

| URL | Vad |
|---|---|
| `/?lagkod=XXXX&kortid=<uuid>` | Röstsidan som QR-koderna pekar på (samma URL-format som 2025 års kortgenerator) |
| `/resultat.html` | Publik resultatsida (dold tills du publicerar; pollar var 5:e sekund) |
| `/admin.html` | Tävlingsadmin (admin-nyckel krävs) |

## Kom igång lokalt

```bash
npm install
cp .dev.vars.example .dev.vars        # sätt en lokal ADMIN_TOKEN
npx wrangler d1 migrations apply smhb-rostsystem --local
npm run dev                            # http://localhost:8787
```

Tester (kör alltid innan du rör något inför tävlingen):

```bash
npm test
```

Återställ den lokala databasen: stoppa dev-servern, `rm -rf .wrangler`, kör
migrationskommandot igen.

## Deploy till Cloudflare

```bash
npx wrangler login
npm run deploy                         # skapar D1-databasen automatiskt vid första deployen
npx wrangler d1 migrations apply smhb-rostsystem --remote
npx wrangler secret put ADMIN_TOKEN    # välj en lång, slumpad nyckel
```

Workern får en `*.workers.dev`-adress direkt. För egen domän (t.ex.
`hamburgersm2026.compiled.se`) kräver Workers att zonen `compiled.se` ligger i
Cloudflare DNS (gratis; registrar kan ligga kvar hos Loopia). Med zonen i Cloudflare
får du också snabb failover: QR-URL:en kan pekas om till reservlösning på minuter
utan att korten trycks om. Alternativet är att trycka korten med workers.dev-adressen.

**Viktigt:** bestäm produktions-URL:en *innan* korten genereras och trycks.

## Kortflödet (från `../burgercodes`)

1. Uppdatera bas-URL:en i `main2026.py` till produktions-URL:en (behåll
   `?lagkod=...&kortid=...`-formatet).
2. Generera koder + kort som vanligt.
3. Admin → **Data** → klistra in `result2026.csv` rakt av (formatet
   `lagkod;url;bildsökväg` tolkas; även enkla `kortid;lagkod`-rader fungerar).
4. Kontrollera antalet importerade kort mot generatorns utskrift.

## Körschema tävlingsdagen

**Före start**
- [ ] Kör `npm test` — allt grönt, ingen koddändring efter frysdatum.
- [ ] Kortregistret importerat; antal stämmer.
- [ ] Lag inlagda (fler kan läggas till under dagen), grenar/kriterier/vikter rätt.
- [ ] Inställningar: metod = stränghetsjusterad, publika resultat = dolda,
      reservformulärets URL ifylld (Google Form som backup, `{lagkod}`/`{kortid}` ersätts).
- [ ] Provrösta med ett överblivet testkort; registrera + verifiera i Översikt;
      korrigera med override så att flödet sitter.
- [ ] Admin-nyckeln delad med de som ska mata in papperskort.

**Under dagen**
- När en bunt serveras: Admin → **Tilldela** → koppla gruppkoden till lag + gren.
  (Röster som kommer in före kopplingen syns under "väntar på koppling" och räknas
  så fort kopplingen finns.)
- Följ **Översikt**: röster per bidrag, "alla kort inne"-markering, konflikter.
- Papperskort matas in löpande under **Papper** — dubbletter är ofarliga.
- Ta en CSV-export (**Data → Ladda ner**) ungefär varje halvtimme som ögonblicksbild.
- Avdrag beslutas och loggas under **Avdrag** (procent av bidragets poäng; 100 % nollar).

**Reservlägen, i ordning**
1. Röstsidan visar automatiskt länk till reservformuläret vid nätverksfel
   (om URL:en är satt i Inställningar).
2. Papperskort + inmatning i efterhand — precis som tidigare år.
3. Totalstopp: papperskort + kalkylark. Tävlingen kan alltid slutföras.

**Efter sista rösten**
- Kontrollera Översikt: inga saknade kort du väntar på, inga olösta konflikter.
- Resultat-fliken: granska rå vs justerad, skiljeregel-flaggor och ev. lottningsbehov.
- Publicera med knappen **Publicera resultat publikt** när det är dags.
- Ta en slutlig CSV-export och spara i årets mapp.

## Repetition/generalrepetition

`tools/e2e.js` kör hela flödet i en riktig webbläsare (rösta → dubblett → admin →
publicera → publik sida) mot din lokala dev-server:

```bash
npm i -D playwright && npx playwright install chromium   # engångs
node tools/e2e.js                                        # kräver npm run dev + demodata
```

## Struktur

```
migrations/           D1-schema + startvärden (2025 års upplägg som utgångspunkt)
src/scoring.ts        Poängmotorn (viktning, stränghetsjustering, avdrag, skiljeregler)
src/vote.ts           Röstmottagning: validering, först-vinner, loggning, override
src/public-routes.ts  Publikt API (config, kortstatus, rösta, resultat)
src/admin-routes.ts   Admin-API (tilldelning, lag, domare, avdrag, import/export …)
public/               Röstsida, publik resultatsida, admin (ren HTML/JS, inga ramverk)
test/                 Enhetstester, API-scenario och replay-testet mot SM 2025
tools/                Fixture-export från 2025-arket + E2E-skript
```
