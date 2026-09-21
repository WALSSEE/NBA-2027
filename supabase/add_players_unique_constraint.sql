-- Aja tämä KERTAALLEEN Supabasen SQL Editorissa ennen kuin käytät
-- "EPM koko liiga" -tuontia. Tämä sallii upsert-tallennuksen
-- (team, name) -parin perusteella: jos pelaaja on jo kannassa, hänen
-- rivinsä päivittyy sen sijaan, että syntyisi duplikaatti.

alter table players
  add constraint players_team_name_unique unique (team, name);
