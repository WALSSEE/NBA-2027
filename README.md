# NBA-malli — oma sovellus (Vaihe 1: automaattinen data-backend)

Tää on ensimmäinen vaihe sun NBA-mallin siirtämisessä pois Claude-chatista
omaksi, aina päällä olevaksi sovellukseksi. Tässä vaiheessa on pystyssä:

- Oikea tietokanta (Supabase)
- Automaattinen, ajastettu NBA-datan haku (Vercel Cron) — **ei koskaan
  manuaalista liittämistä**
- Yksinkertainen sivu (`/dashboard`) joka todistaa datan kulkevan

Rikas käyttöliittymä (drag & drop -kokoonpano, Players/Transactions-välilehdet)
tulee Vaiheessa 2, kun tää perusta on validoitu toimivaksi.

---

## 1. Luo tilit (jos ei jo ole)

1. **GitHub** — [github.com](https://github.com) — ilmainen
2. **Supabase** — [supabase.com](https://supabase.com) — ilmainen taso riittää
3. **Vercel** — [vercel.com](https://vercel.com) — ilmainen taso riittää, kirjaudu suoraan GitHub-tunnuksilla

## 2. Vie koodi GitHubiin

1. Pura tän mukana tullut zip-tiedosto omalle koneelle
2. Mene [github.com/new](https://github.com/new), luo uusi **yksityinen** repo, esim. `nba-model-app`
3. GitHubin ohjeiden mukaan (näet ne heti repon luonnin jälkeen "…or push an existing repository from the command line" -kohdassa) lataa pururettu kansio sinne. Jos et ole käyttänyt gitiä, helpoin on GitHub Desktop -sovellus ([desktop.github.com](https://desktop.github.com)) — sillä voit vetää kansion sinne ilman komentorivin käyttöä.

## 3. Luo Supabase-tietokanta

1. Luo uusi projekti Supabasessa
2. Mene **SQL Editor** -välilehdelle
3. Kopioi `supabase/schema.sql`:n koko sisältö, liitä ja aja (Run)
4. Mene **Settings → API** -sivulle, kopioi talteen:
   - `Project URL` → tästä tulee `SUPABASE_URL` ja `NEXT_PUBLIC_SUPABASE_URL`
   - `service_role` secret key → tästä tulee `SUPABASE_SERVICE_ROLE_KEY` (**älä koskaan jaa tätä avainta kenellekään tai laita sitä selaimeen päätyvään koodiin**)
   - `anon public` key → tästä tulee `NEXT_PUBLIC_SUPABASE_ANON_KEY`

## 4. Deployaa Vercelissä

1. Mene [vercel.com/new](https://vercel.com/new), valitse äsken luotu GitHub-repo
2. Ennen "Deploy"-nappia, avaa **Environment Variables** ja lisää:

   | Nimi | Arvo |
   |---|---|
   | `SUPABASE_URL` | Supabasen Project URL |
   | `SUPABASE_SERVICE_ROLE_KEY` | Supabasen service_role key |
   | `NEXT_PUBLIC_SUPABASE_URL` | sama Project URL |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabasen anon key |
   | `CRON_SECRET` | keksi itse pitkä satunnainen merkkijono, esim. 32 merkkiä |
   | `NBA_SEASON` | `2026-27` |

3. Paina **Deploy**. Muutaman minuutin päästä sovellus on osoitteessa `https://<projektin-nimi>.vercel.app`
4. Vercel lukee automaattisesti `vercel.json`:n ja ottaa Cron-ajastukset käyttöön — **ei vaadi mitään erillistä asetusta**, kunhan `CRON_SECRET` on asetettu (Vercel lisää sen automaattisesti Authorization-headeriin cron-kutsuihin).

## 5. Ensimmäinen ajo (manuaalisesti, kertaalleen)

Cron-ajastukset alkavat pyöriä automaattisesti asetetun aikataulun mukaan
(oletuksena: otteluohjelma kerran viikossa maanantaisin, tulokset kerran
päivässä), mutta **kannattaa ajaa molemmat kertaalleen heti käsin**, jotta
näet toimiiko haku ja jotta otteluohjelma tulee sisään heti eikä vasta
seuraavana maanantaina:

```
curl -H "Authorization: Bearer <CRON_SECRET-arvosi>" https://<projektisi>.vercel.app/api/cron/update-schedule
curl -H "Authorization: Bearer <CRON_SECRET-arvosi>" https://<projektisi>.vercel.app/api/cron/update-nba-data
```

(Voit ajaa nää myös selaimessa jos lisäät osoitteeseen `?secret=...`-tyylisen
tarkistuksen myöhemmin — nyt curl on yksinkertaisin, tai käytä esim.
[Postman](https://www.postman.com)-sovellusta jos komentorivi ei ole tuttu.)

Käy sen jälkeen osoitteessa `https://<projektisi>.vercel.app/dashboard` —
pitäisi näkyä dataa.

## 6. Tiedossa olevat rajoitukset / mitä voi mennä pieleen

- **`update-schedule`-reittiä ei ole voitu testata oikealla NBA-datalla**
  kehitysympäristön verkkorajoituksen takia. Jos ensimmäinen ajo palauttaa
  `"0 ottelua parsittu"`, vastauksessa on `rawSample`-kenttä joka näyttää
  mitä NBA:n rajapinta oikeasti palautti — kopioi se ja näytä minulle, niin
  korjaan parsinnan.
- Cron-ajat (`vercel.json`) ovat UTC-aikaa. Oletusaikataulu: tulokset klo
  10:00 UTC (n. 06:00 Suomen aikaa talvella / 07:00 kesällä, eli aamulla
  edellisen illan pelien jälkeen), otteluohjelma maanantaisin klo 09:00 UTC.
- Vercelin **ilmainen (Hobby) taso** rajoittaa yksittäisen funktion
  suoritusajan lyhyemmäksi kuin `update-nba-data`-reitin `maxDuration: 300`
  vaatisi jos pelattavia otteluita on kerralla paljon (esim. ensimmäinen ajo
  kesken kautta). Jos näet aikakatkaisuja, joko ajele käsin useammin pienemmissä
  erissä alkuun, tai päivitä Vercelin Pro-tasolle (maksullinen).

## Seuraavaksi (Vaihe 2)

Kun tää on pystyssä ja `/dashboard` näyttää oikeaa dataa, palataan chattiin
ja jatketaan: Players/Teams/Matchup/Transactions-välilehdet siirretään
artifaktista tähän samaan projektiin, lukien nyt tästä samasta
tietokannasta artifaktin `window.storage`:n sijaan.
