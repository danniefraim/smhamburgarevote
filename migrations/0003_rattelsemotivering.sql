-- Rättelser ska bära ett varför, inte bara ett vem.
-- edited_by = personen som rättade (kommer ihåg sig mellan kort, det är du).
-- edited_reason = motiveringen för just det här kortet (alltid tom från början).
-- Hela historiken ligger kvar i admin_log; kolumnen här är den senaste motiveringen
-- så att den kan visas direkt i röstkortslistan.

ALTER TABLE votes ADD COLUMN edited_reason TEXT;
