-- Anmälda lag 2026 (preliminär lista — namnen är lagens egna stavningar och
-- rättas i admin när den slutliga anmälningslistan är klar).
--
-- OR IGNORE: lag kan hinna läggas in för hand i admin innan migrationen körs på
-- en databas, och unikhetskravet på name skulle då fälla hela migrationen.
-- Domarna ligger kvar från 0001_init.sql (2025 års domarkår) tills årets är spikad.

INSERT OR IGNORE INTO teams (name) VALUES
  ('Smoked by oak'),
  ('Team Ostindiska Ölkompaniet'),
  ('Furulund''s Smash'),
  ('Smash-N-Go'),
  ('Team Djursholm'),
  ('Café Ljusagård'),
  ('Mc Morgan'),
  ('Slim Burger'),
  ('Mansburger'),
  ('Smokey Dog'),
  ('Möd Mad Barbeque & Smashburgers'),
  ('Gurrasgoda'),
  ('Bondens fjällburgare'),
  ('Fridens'),
  ('SiKBBQ'),
  ('Whilburgare'),
  ('Andersson BBQ'),
  ('Rollin'' Streetfood'),
  ('Smooth Hill Bbq'),
  ('Joes Diner'),
  ('Burgerlabs');
