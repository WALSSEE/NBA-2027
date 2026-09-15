-- NBA-mallin tietokantaskeema (Supabase / Postgres)
-- Aja tämä Supabasen SQL Editorissa kertaalleen projektin luonnin jälkeen.

create table if not exists players (
  id uuid primary key default gen_random_uuid(),
  team text not null,
  name text not null,
  pos text default '',
  mpg_base numeric default 0,
  oepm numeric default 0,
  depm numeric default 0,
  nba_id bigint,
  active boolean default true,
  updated_at timestamptz default now()
);

create table if not exists team_stats (
  id uuid primary key default gen_random_uuid(),
  team text unique not null,
  pace_2425 numeric,
  ortg_2425 numeric,
  drtg_2425 numeric,
  pace_2526 numeric,
  ortg_2526 numeric,
  drtg_2526 numeric,
  coach_change boolean default false,
  home_adv numeric,
  updated_at timestamptz default now()
);

create table if not exists schedule (
  id uuid primary key default gen_random_uuid(),
  game_id text unique,
  date date not null,
  home text not null,
  away text not null,
  home_score int,
  away_score int,
  home_ortg numeric,
  home_drtg numeric,
  home_pace numeric,
  away_ortg numeric,
  away_drtg numeric,
  away_pace numeric,
  updated_at timestamptz default now()
);

create table if not exists transactions (
  id uuid primary key default gen_random_uuid(),
  date date not null default current_date,
  player_name text not null,
  team text not null,
  direction text not null check (direction in ('in', 'out')),
  delta_o numeric,
  delta_d numeric,
  created_at timestamptz default now()
);

-- Automaattinen updated_at-päivitys
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_players_updated on players;
create trigger trg_players_updated before update on players
  for each row execute function set_updated_at();

drop trigger if exists trg_team_stats_updated on team_stats;
create trigger trg_team_stats_updated before update on team_stats
  for each row execute function set_updated_at();

drop trigger if exists trg_schedule_updated on schedule;
create trigger trg_schedule_updated before update on schedule
  for each row execute function set_updated_at();
