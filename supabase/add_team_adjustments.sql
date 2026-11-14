-- Teams-sivun käsin tehtävät säädöt mallin ORTG/DRTG/Pace-lukuihin (lisätään
-- Matchup-laskurin lukuihin EWMA:n jälkeen). Aja kerran Supabasen SQL Editorissa.
alter table team_stats add column if not exists adj_ortg numeric default 0;
alter table team_stats add column if not exists adj_drtg numeric default 0;
alter table team_stats add column if not exists adj_pace numeric default 0;
