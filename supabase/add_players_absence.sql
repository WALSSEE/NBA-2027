-- Poissaolojen seuranta (tuplalaskennan korjaus Matchup-laskurissa).
-- out_since = ensimmäinen päivä jona pelaaja on poissa
-- out_until = paluupäivä (null = edelleen poissa)
alter table players add column if not exists out_since date;
alter table players add column if not exists out_until date;
