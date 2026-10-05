-- Poistaa otteluohjelman tuplat (sama päivä + koti + vieras). Pidetään ottelu, jolla on tulos,
-- ja muuten NBA:n oma id (ei 'espn-'). Pelattuja otteluita ei poisteta.
delete from schedule s using schedule t
where s.date = t.date and s.home = t.home and s.away = t.away and s.id <> t.id
  and s.home_score is null
  and (
    t.home_score is not null
    or (s.game_id like 'espn-%' and t.game_id not like 'espn-%')
    or ((s.game_id like 'espn-%') = (t.game_id like 'espn-%') and s.id::text > t.id::text)
  );
select season_type, count(*) as otteluita, count(distinct (date, home, away)) as eri_otteluita
from schedule where date >= '2026-09-20' group by season_type;
