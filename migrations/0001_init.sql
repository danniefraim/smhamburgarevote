-- Grundschema för SM i Hamburgare röstsystem.
-- Designprinciper:
--  * votes har PRIMARY KEY (kortid) => "först vinner" garanteras av databasen.
--  * submission_log är append-only: varje inkommet försök loggas, även avvisade.
--  * Grenar/kriterier/vikter är data, inte kod — de ändras per år i admin.
--  * avdrag är multiplikativa procentavdrag (0–1) med motivering, återkallbara.

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE grenar (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  name     TEXT NOT NULL UNIQUE,
  sort     INTEGER NOT NULL DEFAULT 0,
  in_total INTEGER NOT NULL DEFAULT 1,
  active   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE criteria (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  key    TEXT NOT NULL UNIQUE,
  label  TEXT NOT NULL,
  weight REAL NOT NULL,
  sort   INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE teams (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Tryckta kort, seedas från kortgenereringens CSV.
CREATE TABLE cards (
  kortid TEXT PRIMARY KEY,
  lagkod TEXT NOT NULL
);
CREATE INDEX idx_cards_lagkod ON cards(lagkod);

-- Koppling gruppkod -> (lag, gren). Görs på tävlingsdagen när en bunt serveras.
CREATE TABLE assignments (
  lagkod      TEXT PRIMARY KEY,
  team_id     INTEGER NOT NULL REFERENCES teams(id),
  gren_id     INTEGER NOT NULL REFERENCES grenar(id),
  assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (team_id, gren_id)
);

CREATE TABLE judges (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL COLLATE NOCASE UNIQUE,
  alias_of   INTEGER REFERENCES judges(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE votes (
  kortid     TEXT PRIMARY KEY REFERENCES cards(kortid),
  lagkod     TEXT NOT NULL,
  judge_id   INTEGER NOT NULL REFERENCES judges(id),
  scores     TEXT NOT NULL, -- JSON: { kriterienyckel: heltal 0-10 }
  comment    TEXT,
  source     TEXT NOT NULL DEFAULT 'digital' CHECK (source IN ('digital', 'paper')),
  entered_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_votes_lagkod ON votes(lagkod);
CREATE INDEX idx_votes_judge ON votes(judge_id);

CREATE TABLE submission_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  kortid      TEXT,
  lagkod      TEXT,
  judge_name  TEXT,
  scores      TEXT,
  comment     TEXT,
  source      TEXT,
  entered_by  TEXT,
  accepted    INTEGER NOT NULL,
  reason      TEXT
);
CREATE INDEX idx_sublog_kortid ON submission_log(kortid);

CREATE TABLE avdrag (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  lagkod     TEXT NOT NULL,
  pct        REAL NOT NULL CHECK (pct >= 0 AND pct <= 1),
  reason     TEXT NOT NULL,
  decided_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT
);
CREATE INDEX idx_avdrag_lagkod ON avdrag(lagkod);

CREATE TABLE admin_log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     TEXT NOT NULL DEFAULT (datetime('now')),
  action TEXT NOT NULL,
  detail TEXT
);

-- ===== Startvärden (2026 utgår från 2025 års upplägg; allt redigerbart i admin) =====

INSERT INTO settings (key, value) VALUES
  ('event_name', 'SM i Hamburgare 2026'),
  ('placement_method', 'adjusted'),   -- 'adjusted' (Variant A) | 'raw' (Variant B)
  ('reveal', 'hidden'),               -- 'hidden' | 'open'  (publik resultatsida)
  ('damping_k', '5'),                 -- dämpning av stränghetsskattning för domare med få röster
  ('backup_form_url', '');            -- reservformulär (Google Form) vid driftstopp

INSERT INTO grenar (name, sort, in_total, active) VALUES
  ('Freestyle', 1, 1, 1),
  ('Hemliga Lådan', 2, 1, 1),
  ('Tjockpuck', 3, 1, 1),
  ('Vegetarisk', 4, 0, 1);

INSERT INTO criteria (key, label, weight, sort, active) VALUES
  ('smak', 'Smak/Arom', 0.45, 1, 1),
  ('textur', 'Textur/Mörhet', 0.35, 2, 1),
  ('utseende', 'Utseende/Visualitet', 0.15, 3, 1),
  ('kreativitet', 'Kreativitet', 0.05, 4, 1);

INSERT INTO judges (name) VALUES
  ('Niklas'), ('Mikael Karlsson'), ('Selin'), ('Linus'), ('Micke Gustavsson'),
  ('Toby'), ('Pierre'), ('Kong Lee'), ('Stefan'), ('Johan Broström'),
  ('Joachim Holst'), ('Erik Edsberger'), ('Ida'), ('Lisa'), ('Karin'),
  ('Thess'), ('Frida');
