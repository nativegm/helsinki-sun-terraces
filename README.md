# Helsinki Sun Terraces

Karttapohjainen MVP Helsingin aurinkoisten terassien löytämiseen.

## Mitä tämä tekee
- hakee terassipaikkoja OpenStreetMap/Overpassista (jos saatavilla)
- käyttää fallback-datasettiä, jos live-haku epäonnistuu
- laskee aurinkoisuuden valitulle päivälle ja kellonajalle SunCalc-kirjastolla
- pyytää käyttäjän sijainnin ja laskee etäisyydet
- järjestää vaihtoehdot etäisyyden, aurinkoisuuden ja confidence-scorejen perusteella

## Paikallinen käynnistys

```bash
cd /app/workspace/projects/helsinki-sun-terraces
python3 -m http.server 4173
```

Avaa sitten `http://localhost:4173`.

## Deploy

### GitHub Pages
Pushaa repo GitHubiin ja aktivoi Pages branchista.

### Vercel
Tämä on staattinen appi, joten `vercel --prod` toimii ilman build-vaihetta.

## Datamalli
Katso `data/fallback-terraces.json` sekä `app.js` -> normalizeTerrace().

## Huomioita
Tämä on MVP. Terrace-orientaatio perustuu tässä versiossa pääosin heuristiikkoihin ja fallback-datassa käsin arvioituihin suuntiin. Seuraava vaihe on lisätä kunnollinen datankeruupipeline ja automaattisempi footprint/analyysi.
