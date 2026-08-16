-- Domarnamn ska matcha skiftlägesokänsligt även för Å/Ä/Ö.
-- SQLites NOCASE viker bara A–Z, så "Åsa" och "åsa" blev två olika domare.
-- name_norm är namnet gemenerat i appkod (JS toLowerCase, full Unicode) och
-- det unika indexet gör uppslag + insättning atomär — det stänger samtidigt
-- SELECT-then-INSERT-racet i resolveJudgeId.
--
-- Backfillen kan inte använda JS; replace-kedjan täcker svenska namn
-- (Å/Ä/Ö samt É/Ü som förekommer i namn). Nya rader skrivs alltid från appkod.

ALTER TABLE judges ADD COLUMN name_norm TEXT;

UPDATE judges SET name_norm =
  lower(replace(replace(replace(replace(replace(name, 'Å', 'å'), 'Ä', 'ä'), 'Ö', 'ö'), 'É', 'é'), 'Ü', 'ü'));

-- Om databasen redan hunnit få skiftlägesdubbletter får de senare raderna en
-- unik markör så att indexet kan skapas; uppslag träffar då bara den äldsta
-- raden och dubbletterna slås ihop manuellt under Domare precis som förut.
UPDATE judges SET name_norm = name_norm || '#' || id
WHERE id NOT IN (SELECT MIN(id) FROM judges GROUP BY name_norm);

CREATE UNIQUE INDEX idx_judges_name_norm ON judges(name_norm);
