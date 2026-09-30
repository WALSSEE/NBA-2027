-- Otteluohjelmaan kausityyppi: 'reg' = runkosarja, 'pre' = harjoituskausi.
-- Harjoituspelit näkyvät omana listanaan, mutta eivät vaikuta malliin (EWMA, väsymys, kausisimulaatio).
alter table schedule add column if not exists season_type text not null default 'reg';
select season_type, count(*) from schedule group by season_type;
