-- BBall Indexin durability-projektio: odotetut loukkaantumispoissaolot / 82 peliä
-- ("Injury / 82 … on a normal team"). Käytetään kausisimulaatiossa ja kauden keskitasossa.
alter table players add column if not exists inj82 numeric;
notify pgrst, 'reload schema';
