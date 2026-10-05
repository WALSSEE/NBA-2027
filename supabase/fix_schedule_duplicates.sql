-- 1) Mitä taulussa on: lähde (NBA-id vai espn-), kausityyppi, määrät ja päivät.
select case when game_id like 'espn-%' then 'ESPN' else 'NBA' end as lahde, season_type,
       count(*) as rivit, count(*) filter (where home_score is null) as ilman_tulosta, min(date), max(date)
from schedule where date >= '2026-09-20' group by 1, 2 order by 1, 2;

-- 2) Siivous: poistetaan KAIKKI tämän kauden pelaamattomat ottelut. Paina sen jälkeen Games-sivulla
--    "Hae kauden otteluohjelma", joka lisää ohjelman yhdestä lähteestä puhtaalta pöydältä.
delete from schedule where date >= '2026-09-20' and home_score is null;

select count(*) as jaljella_tamalta_kaudelta from schedule where date >= '2026-09-20';
