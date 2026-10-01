-- 2026 draftin 60 tulokasta (ESPN, varausnumero ja joukkue kauppojen jälkeen).
-- O = 0.6 − 0.75·ln(varaus), D = −0.5 (2025 luokan tulokaskauden data). Minuutit 0 — aseta itse.
-- Jo kannassa oleva samanniminen pelaaja: lisätään varausnumero, ja O/D päivitetään vain jos hänellä on vielä
-- vanha pikavalinta-arvo (ei käsin muokattu).
alter table players add column if not exists draft_pick int;
notify pgrst, 'reload schema';
with v(pick, name, pos, team, o, d) as (values
(1, 'AJ Dybantsa', 'F', 'Washington Wizards', 0.6, -0.5),
(2, 'Darryn Peterson', 'G', 'Utah Jazz', 0.08, -0.5),
(3, 'Cameron Boozer', 'F', 'Memphis Grizzlies', -0.22, -0.5),
(4, 'Caleb Wilson', 'F', 'Chicago Bulls', -0.44, -0.5),
(5, 'Keaton Wagler', 'G', 'Los Angeles Clippers', -0.61, -0.5),
(6, 'Mikel Brown Jr.', 'G', 'Brooklyn Nets', -0.74, -0.5),
(7, 'Darius Acuff Jr.', 'G', 'Sacramento Kings', -0.86, -0.5),
(8, 'Kingston Flemings', 'G', 'Atlanta Hawks', -0.96, -0.5),
(9, 'Morez Johnson Jr.', 'F', 'Dallas Mavericks', -1.05, -0.5),
(10, 'Brayden Burries', 'G', 'Milwaukee Bucks', -1.13, -0.5),
(11, 'Yaxel Lendeborg', 'F', 'Golden State Warriors', -1.2, -0.5),
(12, 'Aday Mara', 'C', 'Oklahoma City Thunder', -1.26, -0.5),
(13, 'Nate Ament', 'F', 'Milwaukee Bucks', -1.32, -0.5),
(14, 'Hannes Steinbach', 'F', 'Charlotte Hornets', -1.38, -0.5),
(15, 'Dailyn Swain', 'G', 'Chicago Bulls', -1.43, -0.5),
(16, 'Bennett Stirtz', 'G', 'Oklahoma City Thunder', -1.48, -0.5),
(17, 'Ebuka Okorie', 'G', 'Detroit Pistons', -1.52, -0.5),
(18, 'Christian Anderson Jr.', 'G', 'Charlotte Hornets', -1.57, -0.5),
(19, 'Allen Graves', 'F', 'Toronto Raptors', -1.61, -0.5),
(20, 'Jayden Quaintance', 'F', 'San Antonio Spurs', -1.65, -0.5),
(21, 'Karim Lopez', 'F', 'Memphis Grizzlies', -1.68, -0.5),
(22, 'Labaron Philon Jr.', 'G', 'Philadelphia 76ers', -1.72, -0.5),
(23, 'Zuby Ejiofor', 'F', 'Atlanta Hawks', -1.75, -0.5),
(24, 'Cameron Carr', 'G', 'Los Angeles Lakers', -1.78, -0.5),
(25, 'Sergio De Larrea', 'G', 'Dallas Mavericks', -1.81, -0.5),
(26, 'Tarris Reed Jr.', 'C', 'San Antonio Spurs', -1.84, -0.5),
(27, 'Chris Cenac Jr.', 'F', 'Boston Celtics', -1.87, -0.5),
(28, 'Joshua Jefferson', 'F', 'Brooklyn Nets', -1.9, -0.5),
(29, 'Alex Karaban', 'F', 'Sacramento Kings', -1.93, -0.5),
(30, 'Koa Peat', 'F', 'Phoenix Suns', -1.95, -0.5),
(31, 'Bruce Thornton', 'G', 'Houston Rockets', -1.98, -0.5),
(32, 'Richie Saunders', 'G', 'Memphis Grizzlies', -2.0, -0.5),
(33, 'Isaiah Evans', 'G', 'Minnesota Timberwolves', -2.02, -0.5),
(34, 'Meleek Thomas', 'G', 'Cleveland Cavaliers', -2.04, -0.5),
(35, 'Trevon Brazile', 'F', 'Denver Nuggets', -2.07, -0.5),
(36, 'Baba Miller', 'F', 'Los Angeles Clippers', -2.09, -0.5),
(37, 'Ryan Conwell', 'G', 'Miami Heat', -2.11, -0.5),
(38, 'Braden Smith', 'G', 'Indiana Pacers', -2.13, -0.5),
(39, 'Jack Kayil', 'G', 'New York Knicks', -2.15, -0.5),
(40, 'Dillon Mitchell', 'F', 'Boston Celtics', -2.17, -0.5),
(41, 'Otega Oweh', 'G', 'Oklahoma City Thunder', -2.19, -0.5),
(42, 'Ja''Kobi Gillespie', 'G', 'San Antonio Spurs', -2.2, -0.5),
(43, 'Tyler Bilodeau', 'F', 'Brooklyn Nets', -2.22, -0.5),
(44, 'Maliq Brown', 'F', 'San Antonio Spurs', -2.24, -0.5),
(45, 'Emanuel Sharp', 'G', 'Sacramento Kings', -2.25, -0.5),
(46, 'Felix Okpara', 'F', 'Washington Wizards', -2.27, -0.5),
(47, 'Tyler Nickel', 'F', 'New York Knicks', -2.29, -0.5),
(48, 'Tobi Lawal', 'F', 'Dallas Mavericks', -2.3, -0.5),
(49, 'Bryce Hopkins', 'F', 'Denver Nuggets', -2.32, -0.5),
(50, 'Jaden Bradley', 'G', 'Toronto Raptors', -2.33, -0.5),
(51, 'Izaiyah Nelson', 'F', 'Orlando Magic', -2.35, -0.5),
(52, 'Henri Veesaar', 'C', 'Atlanta Hawks', -2.36, -0.5),
(53, 'Ugonna Onyenso', 'C', 'Detroit Pistons', -2.38, -0.5),
(54, 'Lajae Jones', 'G', 'Golden State Warriors', -2.39, -0.5),
(55, 'Nick Martinelli', 'F', 'Los Angeles Clippers', -2.41, -0.5),
(56, 'Vsevolod Ishchenko', 'G', 'Dallas Mavericks', -2.42, -0.5),
(57, 'Narcisse Ngoy', 'F', 'Los Angeles Clippers', -2.43, -0.5),
(58, 'Jaron Pierre Jr.', 'G', 'New Orleans Pelicans', -2.45, -0.5),
(59, 'Trey Kaufman-Renn', 'F', 'Minnesota Timberwolves', -2.46, -0.5),
(60, 'Malique Lewis', 'F', 'Milwaukee Bucks', -2.47, -0.5)
),
upd as (
  update players p set draft_pick = v.pick,
    oepm = case when (p.oepm, p.depm) in ((-0.75,-0.75),(-1.5,-1.0),(-1.75,-1.25),(-2.0,-1.5),(-1.5,-1.0)) or (p.oepm = 0 and p.depm = 0) then v.o else p.oepm end,
    depm = case when (p.oepm, p.depm) in ((-0.75,-0.75),(-1.5,-1.0),(-1.75,-1.25),(-2.0,-1.5),(-1.5,-1.0)) or (p.oepm = 0 and p.depm = 0) then v.d else p.depm end
  from v where lower(p.name) = lower(v.name)
  returning p.name
)
insert into players (team, name, pos, mpg_base, oepm, depm, active, draft_pick)
select v.team, v.name, v.pos, 0, v.o, v.d, true, v.pick from v
where not exists (select 1 from players p where lower(p.name) = lower(v.name));
select draft_pick, name, team, oepm, depm, mpg_base from players where draft_pick is not null order by draft_pick;
