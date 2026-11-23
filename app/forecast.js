// forecast.js - værvarsel (MET Locationforecast, bare vilt) og stedsnavn
// Del av appen (app.js). Delt ut fra app.js 2026-11-22, funksjonene er uendret.
import * as L from './logic.js';
import { $, fmt, fmtDay, fmtT, fmtTime, fmtWhen, locale, log, saveSettings, settings, state, store, t } from './core.js';
import { render } from './view.js';

// ---------- værvarsel (MET Locationforecast, bare vilt) ----------
export const FC_URL = 'https://api.met.no/weatherapi/locationforecast/2.0/compact';

export async function loadForecast() {
  if (!settings.fcOn || settings.fcLat === null || state.fcBusy) return;
  const cached = store.get('fc.cache', null);
  const samePos = cached && cached.lat === settings.fcLat && cached.lon === settings.fcLon;
  if (samePos && cached.expires > Date.now()) { state.fc = cached; return; }
  if (state.demo) {   // ?demo: syntetisk varsel, 6 til 16 °C med døgnvariasjon
    const t0 = Math.floor(Date.now() / 3600e3) * 3600e3;
    const series = Array.from({ length: 24 * 9 }, (_, i) => ({ t: t0 + i * 3600e3, temp: 8 + 3 * Math.sin(((i % 24) - 9) / 24 * 2 * Math.PI) + (i > 96 && i < 130 ? 5 : 0) }));
    state.fc = { series, fetchedAt: Date.now(), expires: Date.now() + 3600e3, lat: settings.fcLat, lon: settings.fcLon };
    return;
  }
  state.fcBusy = true;
  try {
    // enkel GET uten egne headere (MET: Origin identifiserer siden)
    const res = await fetch(`${FC_URL}?lat=${settings.fcLat}&lon=${settings.fcLon}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const series = L.parseMetSeries(await res.json());
    if (!series.length) throw new Error('tomt varsel');
    const exp = Date.parse(res.headers.get('Expires') || '');
    state.fc = { series, fetchedAt: Date.now(), expires: Number.isFinite(exp) ? exp : Date.now() + 3600e3, lat: settings.fcLat, lon: settings.fcLon };
    store.set('fc.cache', state.fc);
    log(`Værvarsel: ${series.length} punkter`);
  } catch (e) {
    // gammelt varsel brukes videre, nytt forsøk om 10 min
    state.fc = samePos ? { ...cached, staleError: e.message, expires: Date.now() + 600e3 } : { error: e.message };
    log(`Værvarsel feilet: ${e.message}`);
  } finally {
    state.fcBusy = false;
    render();
  }
}

// Anslag med værvarsel for hovedtallet, null hvis varselet ikke er i bruk eller ikke hentet
export function forecastEta(s) {
  const fc = state.fc;
  if (!s || !settings.fcOn || settings.use !== 'vilt' || settings.fcLat === null || !fc || !fc.series) return null;
  const now = Date.now();
  const outNow = L.forecastAt(fc.series, now);
  const offset = s.tempC !== null && outNow !== null ? s.tempC - outNow : 0;
  return { ...L.etaWithForecast(s.dg, settings.targetVilt, fc.series, offset, now), offset };
}

export function renderForecast(s) {
  const sec = $('forecast');
  const show = settings.fcOn && settings.use === 'vilt' && settings.fcLat !== null && !!s;
  sec.hidden = !show;
  if (!show) return;
  const fc = state.fc;
  const days = $('fc-days');
  days.innerHTML = '';
  if (!fc || (!fc.series && !fc.error)) { $('fc-text').textContent = t('fc.loading'); $('fc-note').textContent = ''; loadForecast(); return; }
  if (!fc.series) { $('fc-text').textContent = t('fc.failed', { msg: fc.error }); $('fc-note').textContent = ''; return; }
  if (fc.expires <= Date.now()) loadForecast();
  const now = Date.now();
  const outNow = L.forecastAt(fc.series, now);
  const offset = s.tempC !== null && outNow !== null ? s.tempC - outNow : 0;
  const target = settings.targetVilt;
  const e = L.etaWithForecast(s.dg, target, fc.series, offset, now);
  $('fc-text').textContent = s.dg >= target ? t('fc.done')
    : e.at !== null ? t('fc.eta', { target, when: fmtWhen(new Date(e.at)) })
      : t('fc.beyond', { when: fmtWhen(new Date(e.endMs)), dg: fmt(e.dgEnd) });
  const dayFmt = new Intl.DateTimeFormat(locale(), { weekday: 'short', day: 'numeric', month: 'short' });
  let warm = null;
  for (const d of L.dailyRange(fc.series, offset, now)) {
    const li = document.createElement('li');
    const date = new Date(`${d.day}T12:00:00`);
    li.innerHTML = '';
    const a = document.createElement('span'); a.textContent = dayFmt.format(date);
    const b = document.createElement('span'); b.textContent = t('fc.day', { min: fmtT(d.min), max: fmtT(d.max) });
    if (d.max >= 15) { li.className = 'warm'; if (!warm) warm = date; }
    li.append(a, b);
    days.appendChild(li);
  }
  const sign = offset >= 0 ? '+' : '−';
  const notes = [t('fc.offset', { d: `${sign}${fmt(Math.abs(offset))} °C` })];
  if (warm) notes.unshift(t('fc.warm', { when: fmtDay(warm) }));
  const place = placeText();
  notes.push(t('fc.source', { time: fmtTime(new Date(fc.fetchedAt)), place: place || `${settings.fcLat}, ${settings.fcLon}` }));
  if (!place) loadPlaceName();
  $('fc-note').textContent = notes.join(' ');
}

// Stedsnavn for posisjonen fra Kartverket (bare Norge). MET-varselet har ikke stedsnavn.
export let placeTriedFor = '';
export async function loadPlaceName() {
  if (settings.fcLat === null || settings.fcPlace) return;
  const key = `${settings.fcLat},${settings.fcLon}`;
  if (placeTriedFor === key) return;      // ett forsøk per posisjon og sidevisning
  placeTriedFor = key;
  const q = `nord=${settings.fcLat}&ost=${settings.fcLon}&koordsys=4258`;
  try {
    const [k, n] = await Promise.all([
      fetch(`https://ws.geonorge.no/kommuneinfo/v1/punkt?${q}`).then((r) => (r.ok ? r.json() : null)),
      fetch(`https://ws.geonorge.no/stedsnavn/v1/punkt?${q}&radius=5000&treffPerSide=500&utkoordsys=4258`).then((r) => (r.ok ? r.json() : null)),
    ]);
    const kommune = k && k.kommunenavn ? k.kommunenavn : null;
    const sted = L.pickPlaceName(n);
    if (!kommune && !sted) return;
    settings.fcPlace = { sted, kommune, lat: settings.fcLat, lon: settings.fcLon };
    saveSettings();
    renderFcSettings();
    render();
  } catch (e) { log(`Stedsnavn: ${e.message}`); }
}

export function placeText() {
  const p = settings.fcPlace;
  if (!p || p.lat !== settings.fcLat || p.lon !== settings.fcLon) return null;
  return p.sted && p.kommune && p.sted !== p.kommune ? t('fc.near', { sted: p.sted, kommune: p.kommune }) : (p.sted || p.kommune);
}

export function renderFcSettings() {
  $('fc-on').checked = !!settings.fcOn;
  const place = placeText();
  $('fc-pos').textContent = settings.fcLat === null ? t('fc.noPos')
    : place ? `${place} (${settings.fcLat}, ${settings.fcLon})` : t('fc.pos', { lat: settings.fcLat, lon: settings.fcLon });
  if (settings.fcLat !== null && !place) loadPlaceName();
}

export function askPosition() {
  if (!navigator.geolocation) { $('fc-pos').textContent = t('fc.posFailed', { msg: 'geolocation' }); return; }
  navigator.geolocation.getCurrentPosition((p) => {
    const r = L.roundPos(p.coords.latitude, p.coords.longitude);
    settings.fcLat = r.lat; settings.fcLon = r.lon; settings.fcOn = true; settings.fcPlace = null; placeTriedFor = '';
    saveSettings(); state.fc = null;
    renderFcSettings(); render();
  }, (err) => { $('fc-pos').textContent = t('fc.posFailed', { msg: err.message }); }, { maximumAge: 3600e3, timeout: 20000 });
}
