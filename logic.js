// logic.js - regler og beregninger for nettsiden, uten nettleseravhengigheter.
// Testes med node (app/tests/logic.test.mjs). Kilder: docs/fagkilder-morning.md.

export const HIST_FLAG_POWERUP = 0x01;
export const HIST_FLAG_NEW_PERIOD = 0x02;
export const HIST_FLAG_SENSOR_ERR = 0x04;

// ---------- bruk og mål ----------
export const USES = ['vilt', 'restaurant'];
export const VILT_TARGETS = [40, 50, 60, 80, 100, 120];   // døgngrader (Hjortesenteret: 40 kalv, 40–50 vanlig, 60–120 gamle dyr)
export const RESTAURANT_DAYS = [14, 21, 28, 35, 45];      // dager (Beef Research: 14–35 dager vanlig)
export const DEVICE_SMILEY_TARGET = 40;                    // fast i firmwaren (DG_TARGET_TENTHS)

// Restaurant (tørrmodning storfe): MLA, Beef Research
export const RESTAURANT_RH = [75, 85];
export const RESTAURANT_TEMP = [0, 4];

// Vilt: fra 90 % fuktighet varsles kondens (rød sone på instrumentet).
export const VILT_RH_CONDENSE = 90;

// ---------- batteri ----------
// Nordic sin CR2032-kurve (nRF5 SDK app_utils.h), stykkevis lineær. Unøyaktig ved kulde og last.
const NORDIC = [[3000, 100], [2900, 42], [2740, 18], [2440, 6], [2100, 0]];
export function batteryPercent(mv) {
  if (!mv) return null;
  if (mv >= NORDIC[0][0]) return 100;
  for (let i = 1; i < NORDIC.length; i++) {
    const [v1, p1] = NORDIC[i - 1], [v0, p0] = NORDIC[i];
    if (mv >= v0) return Math.round(p0 + ((mv - v0) * (p1 - p0)) / (v1 - v0));
  }
  return 0;
}

// Nivå i stedet for et hoppende prosenttall.
export function batteryLevel(mv) {
  if (!mv) return null;
  if (mv >= 2900) return 'full';
  if (mv >= 2740) return 'ok';
  if (mv >= 2440) return 'low';
  return 'replace';
}

// ---------- fukt ----------
// Duggpunkt med Magnus-formelen (b = 17,62, c = 243,12 °C), gyldig ca. -45 til 60 °C.
export function dewPoint(tC, rh) {
  if (tC === null || rh === null || rh <= 0) return null;
  const g = Math.log(rh / 100) + (17.62 * tC) / (243.12 + tC);
  return (243.12 * g) / (17.62 - g);
}

// ---------- periode ----------
// Postene i perioden som pågår.
// psHour (fra firmware 0.5.5): timenummeret perioden startet i. Gjelder når det er kjent.
// Ellers: fra og med siste «ny periode»-merke. Finnes ingen, regnes hele historikken
// som perioden, men complete = false (starten kan ligge før eldste post).
export function currentPeriod(records, psHour = null) {
  if (psHour !== null && psHour !== undefined) {
    let i = records.findIndex((r) => r.hour >= psHour);
    if (i < 0) i = records.length;
    return { records: records.slice(i), before: records.slice(0, i), complete: true };
  }
  let start = -1;
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i].flags & HIST_FLAG_NEW_PERIOD) { start = i; break; }
  }
  return {
    records: start >= 0 ? records.slice(start) : records.slice(),
    before: start >= 0 ? records.slice(0, start) : [],
    complete: start >= 0,
  };
}

export function dgFromRecords(records) {
  let dg = 0;
  for (const r of records) if (r.tempC !== null && r.tempC > 0) dg += r.tempC / 24;
  return dg;
}

// Snitt av de siste `hours` timene med gyldig temperatur. null hvis færre enn minHours.
export function avgTemp(records, hours = 24, minHours = 6) {
  const recs = records.slice(-hours).filter((r) => r.tempC !== null);
  if (recs.length < minHours) return null;
  return recs.reduce((a, r) => a + r.tempC, 0) / recs.length;
}

export function avgRh(records, hours = 24, minHours = 6) {
  const recs = records.slice(-hours).filter((r) => r.rh !== null);
  if (recs.length < minHours) return null;
  return recs.reduce((a, r) => a + r.rh, 0) / recs.length;
}

// Døgn til målet ved jevn temperatur. null hvis det ikke går å anslå.
export function etaDays(dg, target, tempC) {
  if (dg >= target) return 0;
  if (tempC === null || tempC <= 0.5) return null;
  return (target - dg) / tempC;
}

// Svinn i prosent av startvekt.
export function shrinkPercent(startKg, nowKg) {
  if (!(startKg > 0) || !(nowKg > 0)) return null;
  return ((startKg - nowKg) / startKg) * 100;
}

// ---------- råd: «Dette må du passe på» ----------
// ctx: { use, tempC, rh, dg, target, periodHours, avg24, sensorErr, batteryLevel }
// Svar: liste med { level: 'warn' | 'info' | 'ok', key, vars }, viktigst først.
export function advise(ctx) {
  const out = [];
  const t = ctx.tempC, rh = ctx.rh;
  if (ctx.sensorErr) out.push({ level: 'warn', key: 'adv.sensor' });
  if (ctx.batteryLevel === 'replace') out.push({ level: 'warn', key: 'adv.batteryReplace' });
  else if (ctx.batteryLevel === 'low') out.push({ level: 'info', key: 'adv.batteryLow' });

  if (t !== null && t <= -1) out.push({ level: 'warn', key: 'adv.frost', vars: { t } });

  if (ctx.use === 'restaurant') {
    if (t !== null && t > RESTAURANT_TEMP[1]) out.push({ level: 'warn', key: 'adv.r.warm', vars: { t, max: RESTAURANT_TEMP[1] } });
    if (rh !== null && rh > RESTAURANT_RH[1]) out.push({ level: 'warn', key: 'adv.r.wet', vars: { rh, max: RESTAURANT_RH[1] } });
    if (rh !== null && rh < RESTAURANT_RH[0]) out.push({ level: 'info', key: 'adv.r.dry', vars: { rh, min: RESTAURANT_RH[0] } });
  } else {
    const firstDay = ctx.periodHours !== null && ctx.periodHours < 24;
    if (firstDay && t !== null && t < 12) out.push({ level: 'info', key: 'adv.v.coldShort', vars: { t } });
    if (t !== null && t >= 15) out.push({ level: 'warn', key: 'adv.v.flies', vars: { t } });
    if (!firstDay && ctx.avg24 !== null && ctx.avg24 > 15) out.push({ level: 'warn', key: 'adv.v.avg15', vars: { t: ctx.avg24 } });
    else if (!firstDay && ctx.avg24 !== null && ctx.avg24 > 10) out.push({ level: 'info', key: 'adv.v.avg10', vars: { t: ctx.avg24 } });
    if (rh !== null && rh >= VILT_RH_CONDENSE) out.push({ level: 'warn', key: 'adv.v.condense', vars: { rh } });
    if (ctx.dg !== null && ctx.target && ctx.dg >= ctx.target) out.push({ level: 'ok', key: 'adv.v.done', vars: { target: ctx.target } });
  }
  const rank = { warn: 0, info: 1, ok: 2 };
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}

// Kort ID fra navnet "DG-4AF2" -> "4AF2".
export function deviceId(name) {
  const m = /^DG-([0-9A-F]{4})$/i.exec(name || '');
  return m ? m[1].toUpperCase() : null;
}

// ---------- værvarsel (MET Locationforecast 2.0, compact) ----------
// Tidsserie [{t (ms), temp (°C)}] fra svaret. Ukjente punkter hoppes over.
export function parseMetSeries(json) {
  const ts = json && json.properties && json.properties.timeseries;
  if (!Array.isArray(ts)) return [];
  const out = [];
  for (const p of ts) {
    const v = p && p.data && p.data.instant && p.data.instant.details && p.data.instant.details.air_temperature;
    const t = Date.parse(p && p.time);
    if (typeof v === 'number' && Number.isFinite(t)) out.push({ t, temp: v });
  }
  return out.sort((a, b) => a.t - b.t);
}

// Varslet temperatur nærmest tidspunktet.
export function forecastAt(series, ms) {
  let best = null;
  for (const p of series) if (!best || Math.abs(p.t - ms) < Math.abs(best.t - ms)) best = p;
  return best ? best.temp : null;
}

// Anslag: døgngrader fra nå med varslet temperatur + offset (måleren minus varselet nå).
// Hvert punkt gjelder til neste punkt. Svar: { at: ms eller null, dgEnd, endMs }.
export function etaWithForecast(dgNow, target, series, offset, nowMs) {
  if (dgNow >= target) return { at: nowMs, dgEnd: dgNow, endMs: nowMs };
  let dg = dgNow;
  for (let i = 0; i < series.length - 1; i++) {
    const a = Math.max(series[i].t, nowMs), b = series[i + 1].t;
    if (b <= a) continue;
    const temp = Math.max(0, series[i].temp + offset);
    const add = (temp * (b - a)) / 86400e3;
    if (temp > 0 && dg + add >= target) {
      return { at: a + ((target - dg) / temp) * 86400e3, dgEnd: target, endMs: b };
    }
    dg += add;
  }
  const endMs = series.length ? Math.max(series[series.length - 1].t, nowMs) : nowMs;
  return { at: null, dgEnd: dg, endMs };
}

// Laveste og høyeste temperatur per dag (lokal tid), med offset. [{day: 'YYYY-MM-DD', min, max}]
export function dailyRange(series, offset, fromMs) {
  const days = new Map();
  for (const p of series) {
    if (p.t < fromMs) continue;
    const d = new Date(p.t);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const v = p.temp + offset;
    const cur = days.get(key);
    if (!cur) days.set(key, { day: key, min: v, max: v });
    else { cur.min = Math.min(cur.min, v); cur.max = Math.max(cur.max, v); }
  }
  return [...days.values()];
}

// Posisjon avrundet til 2 desimaler (omtrent 1 km). MET tillater høyst 4.
export function roundPos(lat, lon) {
  return { lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100 };
}

// ---------- stedsnavn (Kartverket) ----------
// Velger et stedsnavn som folk kjenner igjen fra svaret til
// ws.geonorge.no/stedsnavn/v1/punkt: tettsted/bygd/grend først, ellers gard, ellers nærmeste.
const PLACE_RANK = [/^(By|Tettsted|Tettbebyggelse)$/i, /^(Bygd|Bygdelag|Grend|Boligfelt)/i, /^(Gard|Navnegard)$/i];
export function pickPlaceName(json) {
  const list = (json && Array.isArray(json.navn) ? json.navn : [])
    .map((n) => ({ name: n.stedsnavn && n.stedsnavn[0] && n.stedsnavn[0]['skrivemåte'], type: n.navneobjekttype || '', m: n.meterFraPunkt ?? Infinity }))
    .filter((n) => n.name);
  for (const re of PLACE_RANK) {
    const hits = list.filter((n) => re.test(n.type)).sort((a, b) => a.m - b.m);
    if (hits.length) return hits[0].name;
  }
  return list.sort((a, b) => a.m - b.m)[0]?.name ?? null;
}
