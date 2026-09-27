-- Poissaolojen seuranta Matchup-laskuria varten. Turvallinen ajaa uudelleen
-- (sisältää myös add_players_absence.sql:n sarakkeet).
-- out_since / out_until = tämän kauden poissaolo (null = ei poissa / edelleen poissa)
-- gp_prev_season = montako peliä pelaaja pelasi viime kaudella TÄLLE joukkueelle
--                  (null = ei asetettu -> oletetaan pelanneen normaalisti)
alter table players add column if not exists out_since date;
alter table players add column if not exists out_until date;
alter table players add column if not exists gp_prev_season int;
