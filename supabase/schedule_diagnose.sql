-- Aja hakunapin painamisen JÄLKEEN ja lähetä tulos.
select case when game_id like 'espn-%' then 'ESPN' else 'NBA' end as lahde, season_type,
       count(*) as rivit, count(distinct game_id) as eri_idt,
       count(distinct (date, home, away)) as eri_otteluita, min(date) as eka, max(date) as vika
from schedule where date >= '2026-09-20'
group by 1, 2 order by 1, 2;
