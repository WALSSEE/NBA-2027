-- Viime kauden (25-26) minuutit per pelaaja per joukkue. Matchup laskee tästä,
-- mitä joukkueen viime kauden luvuissa on mukana:
--   vaikutusminuutit = min_total / 82
-- Kesken kauden treidatulla pelaajalla on oma rivi jokaiselle joukkueelle.
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
-- Sovellus käyttää palvelinpuolen service_role-avainta, joka ohittaa RLS:n.
alter table prev_season_minutes enable row level security;
