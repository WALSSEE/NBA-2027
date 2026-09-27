-- Viime kauden (25-26) pelimäärät NYKYISELLE joukkueelle, Matchupin
-- paluuhyvitystä varten. Aja Supabasen SQL Editorissa. Turvallinen ajaa
-- uudelleen. Sisältää sarakkeiden luonnin siltä varalta, ettei
-- add_players_prev_season.sql ole vielä ajettu.

alter table players add column if not exists out_since date;
alter table players add column if not exists out_until date;
alter table players add column if not exists gp_prev_season int;

-- Koko kausi poissa
update players set gp_prev_season = 0 where name ilike 'Damian Lillard%';
update players set gp_prev_season = 0 where name ilike 'Kyrie Irving%';
update players set gp_prev_season = 0 where name ilike 'Tyrese Haliburton%';

-- Osa kaudesta, sama joukkue
update players set gp_prev_season = 38 where name ilike 'Jimmy Butler%';
update players set gp_prev_season = 20 where name ilike 'Ja Morant%';
update players set gp_prev_season = 19 where name ilike 'Domantas Sabonis%';
update players set gp_prev_season = 5  where name ilike 'Walker Kessler%';
update players set gp_prev_season = 39 where name ilike 'Zach LaVine%';
update players set gp_prev_season = 11 where name ilike 'Zach Edey%';

-- Kesken kauden joukkuetta vaihtaneet: pelit sille joukkueelle, jossa pelaaja
-- on nyt. Muut joukkueet -> null (tarkista käsin, ks. tarkistuskysely alla).
update players set gp_prev_season = case team
    when 'Washington Wizards' then 5
    when 'Atlanta Hawks' then 10
    else null end
  where name ilike 'Trae Young%';

update players set gp_prev_season = case team
    when 'Dallas Mavericks' then 20
    when 'Washington Wizards' then 0
    else null end
  where name ilike 'Anthony Davis%';

update players set gp_prev_season = case team
    when 'Utah Jazz' then 3
    when 'Memphis Grizzlies' then 45
    else null end
  where name ilike 'Jaren Jackson%';

-- Tarkistus: pitäisi näkyä 12 pelaajaa. Jos joku puuttuu, nimi on kannassa
-- eri muodossa. Jos gp_prev_season on tyhjä, joukkue ei ollut yllä listattu.
select name, team, gp_prev_season
from players
where name ilike any (array[
  'Damian Lillard%', 'Kyrie Irving%', 'Tyrese Haliburton%', 'Jimmy Butler%',
  'Ja Morant%', 'Domantas Sabonis%', 'Walker Kessler%', 'Zach LaVine%',
  'Zach Edey%', 'Trae Young%', 'Anthony Davis%', 'Jaren Jackson%'
])
order by name;
