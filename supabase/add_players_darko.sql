-- DARKO-luvut (O-DPM / D-DPM) EPM:n rinnalle. Mallin asetuksista valitaan EPM / DARKO / keskiarvo.
alter table players add column if not exists darko_o numeric;
alter table players add column if not exists darko_d numeric;
select count(*) filter (where darko_o is not null) as darko_luvut, count(*) as pelaajia from players;
