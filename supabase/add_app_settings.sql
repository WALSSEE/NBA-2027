-- Sovelluksen asetukset tietokantaan (samat kaikilla laitteilla).
-- Matchup tallentaa mallin asetukset avaimella 'model'. Turvallinen ajaa uudelleen.
create table if not exists app_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz default now()
);
alter table app_settings enable row level security;
select * from app_settings;
