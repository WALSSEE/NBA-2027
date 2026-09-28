-- Runkosarjan win totalit 2026-27 (markkinan voittorajat, SportsBettingDime-kooste 28.9.2026).
-- Matchup vertaa niitä mallin kauden alun Netiin (Malli vs. win totalit) ja voi käyttää niitä
-- lähtötason painona. Päivitä luvut Teams-sivulla, jos rajat liikkuvat. Turvallinen ajaa uudelleen.
alter table team_stats add column if not exists win_total numeric;
update team_stats set win_total = 43.5 where team = 'Atlanta Hawks';
update team_stats set win_total = 51.5 where team = 'Boston Celtics';
update team_stats set win_total = 24.5 where team = 'Brooklyn Nets';
update team_stats set win_total = 37.5 where team = 'Charlotte Hornets';
update team_stats set win_total = 27.5 where team = 'Chicago Bulls';
update team_stats set win_total = 47.5 where team = 'Cleveland Cavaliers';
update team_stats set win_total = 34.5 where team = 'Dallas Mavericks';
update team_stats set win_total = 49.5 where team = 'Denver Nuggets';
update team_stats set win_total = 49.5 where team = 'Detroit Pistons';
update team_stats set win_total = 40.5 where team = 'Golden State Warriors';
update team_stats set win_total = 47.5 where team = 'Houston Rockets';
update team_stats set win_total = 44.5 where team = 'Indiana Pacers';
update team_stats set win_total = 30.5 where team = 'Los Angeles Clippers';
update team_stats set win_total = 46.5 where team = 'Los Angeles Lakers';
update team_stats set win_total = 28.5 where team = 'Memphis Grizzlies';
update team_stats set win_total = 46.5 where team = 'Miami Heat';
update team_stats set win_total = 26.5 where team = 'Milwaukee Bucks';
update team_stats set win_total = 48.5 where team = 'Minnesota Timberwolves';
update team_stats set win_total = 27.5 where team = 'New Orleans Pelicans';
update team_stats set win_total = 52.5 where team = 'New York Knicks';
update team_stats set win_total = 60.5 where team = 'Oklahoma City Thunder';
update team_stats set win_total = 43.5 where team = 'Orlando Magic';
update team_stats set win_total = 50.5 where team = 'Philadelphia 76ers';
update team_stats set win_total = 38.5 where team = 'Phoenix Suns';
update team_stats set win_total = 43.5 where team = 'Portland Trail Blazers';
update team_stats set win_total = 21.5 where team = 'Sacramento Kings';
update team_stats set win_total = 59.5 where team = 'San Antonio Spurs';
update team_stats set win_total = 45.5 where team = 'Toronto Raptors';
update team_stats set win_total = 35.5 where team = 'Utah Jazz';
update team_stats set win_total = 35.5 where team = 'Washington Wizards';

select team, win_total from team_stats order by win_total desc;
