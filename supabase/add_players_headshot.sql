-- Pelaajakuvien osoite (ESPN). Matchup käyttää tätä ensisijaisesti.
alter table players add column if not exists headshot_url text;
