# Tredjepartskode

## beacio-2.2.0.js

Web Bluetooth for Safari på iPhone og iPad (iOS 26 eller nyere), via Safari-utvidelsen og appen beacio (App Store).

- Kilde: npm-pakken `@beacio/core` 2.2.0, filen `dist/browser-auto.global.js` (siste linje med kildekart-henvisning fjernet). MIT-lisens, se `beacio-LICENSE.txt`.
- Lastes før `app.js` i `index.html`. Har nettleseren Web Bluetooth (Chrome, Edge), gjør skriptet ingenting.
- På iPhone setter det `navigator.bluetooth` når utvidelsen er aktiv, ellers viser det et eget installasjonsbanner (engelsk).
- Skriptet kan sende hendelser til api.beacio.com, men bare når en API-nøkkel er satt. Vi setter ingen nøkkel, så det sendes ingenting (sjekket i koden for 2.2.0).
- Oppdatering: `npm pack @beacio/core@<versjon>`, kopier `dist/browser-auto.global.js` hit med nytt versjonsnummer i filnavnet, og endre `index.html` og `sw.js`.
