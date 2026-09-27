-- Kesken kauden treidatun pelaajan viimeinen joukkue (rosterien palautusta varten).
-- Sisältää myös taulun luonnin, jos add_prev_season_minutes.sql on ajamatta.
create table if not exists prev_season_minutes (
  id uuid primary key default gen_random_uuid(),
  season text not null,
  team text not null,
  name text not null,
  nba_id bigint,
  gp int not null default 0,
  min_total numeric not null default 0,
  updated_at timestamptz default now(),
  unique (season, team, name)
);
alter table prev_season_minutes enable row level security;
alter table prev_season_minutes add column if not exists final_team boolean not null default true;
