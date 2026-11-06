// app.js - nettside for døgngrader-måleren, versjon 2 (Web Bluetooth)
//
// Oppbygging:
//   protocol.js  tolking av data fra måleren
//   logic.js     regler: periode, anslag, batterinivå, duggpunkt, råd
//   i18n.js      all tekst, norsk og engelsk
//   ameter.js    analogt instrument (fra webrig-vhf)
// Innstillinger og navn på målere lagres i nettleseren (localStorage).
import * as P from './protocol.js';
import * as L from './logic.js';
import { translate, pickLang } from './i18n.js';

const HIST_TIMEOUT_MS = 60000;
const $ = (id) => document.getElementById(id);

// ---------- lagring i nettleseren ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem('dg.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('dg.' + k, JSON.stringify(v)); } catch (e) { /* privat modus o.l. */ } },
};

const settings = Object.assign(
  { use: 'vilt', mode: window.innerWidth < 900 ? 'simple' : 'adv', lang: null, targetVilt: 40, targetDays: 28, restBy: 'days', pendingSync: false,
    fcOn: false, fcLat: null, fcLon: null },
  store.get('settings', {}),
);
settings.lang = pickLang(settings.lang, navigator.languages || [navigator.language]);

const state = {
  device: null, devId: null, chars: {},
  status: null, statusAt: null, statusHex: '',
  histInfo: null, histReadAt: null, history: [], histBusy: false,
  fw: null, model: null, diag: null, latest: null,
  otaRunning: false, otaDisconnected: false,
  fc: null,             // værvarsel: { series, fetchedAt, expires, lat, lon } eller { error }
  fcBusy: false,
  setState: 'none',     // innstillinger mot måleren: none, synced, saving, pending, old, failed
  setError: '',
  demo: new URLSearchParams(location.search).has('demo'),
};

// ---------- tekst og tall ----------
const t = (key, vars) => translate(settings.lang, key, vars);
const locale = () => (settings.lang === 'nb' ? 'nb-NO' : 'en-GB');
const fmt = (v, d = 1) => new Intl.NumberFormat(locale(), { minimumFractionDigits: d, maximumFractionDigits: d }).format(v);
const fmtT = (v) => `${fmt(v)} °C`;
const fmtRh = (v) => `${Math.round(v)} %`;
const fmtWhen = (d) => new Intl.DateTimeFormat(locale(), { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(d);
const fmtDay = (d) => new Intl.DateTimeFormat(locale(), { weekday: 'long', day: 'numeric', month: 'long' }).format(d);
const fmtTime = (d) => d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });

function applyTexts() {
  document.documentElement.lang = settings.lang === 'nb' ? 'nb' : 'en';
  document.title = t('app.title');
  for (const el of document.querySelectorAll('[data-t]')) el.textContent = t(el.dataset.t);
  for (const el of document.querySelectorAll('[data-t-label]')) el.setAttribute('aria-label', t(el.dataset.tLabel));
  for (const el of document.querySelectorAll('[data-t-ph]')) el.setAttribute('placeholder', t(el.dataset.tPh));
}

function log(msg) {
  const el = $('log');
  el.textContent = `${new Date().toLocaleTimeString(locale())} ${msg}\n` + el.textContent.slice(0, 20000);
}

// ---------- innstillinger og modus ----------
function saveSettings() { store.set('settings', settings); }

function applyMode() {
  document.body.classList.toggle('simple', settings.mode === 'simple');
  $('m-simple').setAttribute('aria-pressed', String(settings.mode === 'simple'));
  $('m-adv').setAttribute('aria-pressed', String(settings.mode !== 'simple'));
}

function applyUse() {
  document.body.dataset.use = settings.use;
  document.querySelector('meta[name=theme-color]').setAttribute('content', settings.use === 'restaurant' ? '#141211' : '#1b2421');
  buildGauge();
}

// ---------- innstillinger: dialog og lagring i måleren (fra firmware 0.5.5) ----------
const LIMITS = { 'target-vilt': P.SET_LIMITS.dg, 'target-days': P.SET_LIMITS.days };
const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, Math.round(v)));

function renderSync() {
  const el = $('set-sync');
  const name = state.device ? state.device.name : '';
  el.classList.toggle('bad', state.setState === 'failed');
  el.textContent = {
    synced: t('settings.synced', { name }),
    saving: t('settings.saving'),
    pending: t('settings.pending'),
    old: t('settings.old'),
    failed: t('settings.failed', { msg: state.setError }),
  }[state.setState] || '';
}

function openSettings() {
  const dlg = $('settings');
  for (const r of dlg.querySelectorAll('input[name=use]')) r.checked = r.value === settings.use;
  for (const r of dlg.querySelectorAll('input[name=lang]')) r.checked = r.value === settings.lang;
  for (const r of dlg.querySelectorAll('input[name=restby]')) r.checked = r.value === settings.restBy;
  $('target-vilt').value = settings.targetVilt;
  $('target-days').value = settings.targetDays;
  applyTargetFields();
  renderSync();
  renderFcSettings();
  dlg.showModal();
}

// Hvilket mål som vises: døgngrader for vilt og for restaurant med døgngrader, ellers dager.
// Målet i døgngrader er det samme feltet i måleren for vilt og restaurant.
function applyTargetFields() {
  const byDays = settings.use === 'restaurant' && settings.restBy !== 'dg';
  $('fs-dg').hidden = byDays;
  $('fs-days').hidden = !byDays;
  $('help-dg').textContent = t(settings.use === 'restaurant' ? 'settings.targetHelpRestDg' : 'settings.targetHelpVilt');
}

// Endring i dialogen: lagres her med en gang, i måleren litt etter (samler raske trykk).
let syncTimer = 0;
function settingChanged() {
  saveSettings();
  render();
  clearTimeout(syncTimer);
  syncTimer = setTimeout(writeMeterSettings, 700);
}

function setTarget(id, v) {
  const val = clamp(v, LIMITS[id]);
  if (!Number.isFinite(val)) return;
  $(id).value = val;
  if (id === 'target-vilt') settings.targetVilt = val; else settings.targetDays = val;
  settingChanged();
}

async function writeMeterSettings() {
  if (!connected()) {
    settings.pendingSync = true;
    saveSettings();
    state.setState = 'pending';
    renderSync();
    return;
  }
  if (!state.chars.set) { state.setState = 'old'; renderSync(); return; }
  state.setState = 'saving';
  renderSync();
  try {
    const want = { use: settings.use, targetDg: settings.targetVilt, targetDays: settings.targetDays, restBy: settings.restBy };
    await state.chars.set.writeValueWithResponse(P.buildSettings(want));
    const got = P.parseSettings(await state.chars.set.readValue());
    if (got.use !== want.use || got.targetDg !== want.targetDg || got.targetDays !== want.targetDays) {
      throw new Error('måleren svarte med andre verdier');
    }
    if (got.restBy !== want.restBy) throw new Error('måleren kan ikke telle døgngrader i restaurant, oppdater til 0.5.6');
    settings.pendingSync = false;
    saveSettings();
    state.setState = 'synced';
    log(`Innstillinger lagret i måleren: ${want.use}, ${want.targetDg} dg, ${want.targetDays} dager`);
  } catch (e) {
    state.setState = 'failed';
    state.setError = e.message;
    log(`Innstillinger feilet: ${e.message}`);
  }
  renderSync();
  render();
}

// Ved tilkobling: endringer gjort uten tilkobling skrives, ellers gjelder måleren.
async function syncSettingsOnConnect() {
  if (!state.chars.set) { state.setState = 'old'; return; }
  if (settings.pendingSync) return writeMeterSettings();
  try {
    const m = P.parseSettings(await state.chars.set.readValue());
    const useChanged = m.use !== settings.use;
    Object.assign(settings, { use: m.use, targetVilt: m.targetDg, targetDays: m.targetDays, restBy: m.restBy });
    saveSettings();
    if (useChanged) applyUse();
    state.setState = 'synced';
    log(`Innstillinger fra måleren: ${m.use}, ${m.targetDg} dg, ${m.targetDays} dager`);
  } catch (e) {
    state.setState = 'failed';
    state.setError = e.message;
  }
  renderSync();
}

// ---------- tilkoblingspille ----------
function connected() { return !!(state.device && state.device.gatt && state.device.gatt.connected); }

function renderConn(phase) {
  const lamp = $('conn-lamp'), txt = $('conn-txt'), btn = $('conn');
  lamp.className = 'lamp' + (phase === 'on' ? ' on' : phase === 'wait' ? ' wait' : '');
  btn.classList.toggle('on', phase === 'on');
  if (phase === 'on') {
    txt.textContent = '';
    txt.hidden = true;
    btn.setAttribute('aria-label', t('conn.on', { name: state.device.name }));
  } else {
    txt.hidden = false;
    txt.textContent = phase === 'wait' ? t('conn.connecting')
      : state.statusAt ? `${t('conn.lost')}, ${fmtTime(state.statusAt)}` : t('conn.off');
    btn.setAttribute('aria-label', txt.textContent);
  }
}

function toggleConnPop(show) {
  const pop = $('conn-pop');
  if (show === undefined) show = pop.hidden;
  if (show) {
    $('pop-name').textContent = state.device ? state.device.name : '';
    $('pop-read').textContent = state.statusAt ? t('conn.lastRead', { time: fmtTime(state.statusAt) }) : '';
    $('dev-name').value = devInfo().name || '';
  }
  pop.hidden = !show;
}

function devInfo() { return state.devId ? store.get('dev.' + state.devId, {}) : {}; }
function setDevInfo(patch) { if (state.devId) store.set('dev.' + state.devId, Object.assign(devInfo(), patch)); }

// ---------- instrument: fuktighet ----------
// Vilt: opplyst gul skive, rødt fra 90 % (kondens). Restaurant: børstet aluminium,
// grønt bånd for målområdet.
let gauge = null;
function buildGauge() {
  const el = $('gauge');
  if (!window.AnalogMeter) { el.innerHTML = ''; gauge = null; return; }
  const rest = settings.use === 'restaurant';
  const ticks = [0, 20, 40, 60, 80, 100].map((v) => [String(v), v / 100]);
  const zones = rest ? [[L.RESTAURANT_RH[0] / 100, L.RESTAURANT_RH[1] / 100, '#2f8a4f']] : [[L.VILT_RH_CONDENSE / 100, 1, '#b8261b']];
  gauge = new window.AnalogMeter(el, {
    face: rest ? 'alu' : 'amber',
    upper: { label: t('gauge.label'), ticks, minor: 20, zones },
    riseS: 0.8, fallS: 0.8,
  });
  setGauge();
}
function setGauge() {
  const s = state.status;
  if (gauge) gauge.set(s && s.rh !== null ? s.rh / 100 : 0);
}

// ---------- beregnet tilstand ----------
// Periodestart fra måleren (0.5.5) når den finnes, ellers merket «ny periode» i historikken.
function period() {
  const info = state.histInfo;
  const p = L.currentPeriod(state.history, info ? info.psHour : null);
  let start = P.periodStartMs(info, state.histReadAt);
  if (start === null && info && p.complete && p.records.length) start = p.records[0].time - 3600e3;
  const hours = start !== null ? Math.max(0, (Date.now() - start) / 3600e3) : null;
  return { ...p, hours, start };
}

// ---------- visning ----------
function render() {
  applyTexts();
  const s = state.status;
  renderMeters();
  const per = period();
  const avg24 = L.avgTemp(per.records);

  // hvem
  const info = devInfo();
  $('who').hidden = !state.devId;
  $('who-name').textContent = info.name || (state.device ? state.device.name : '');
  $('who-id').textContent = info.name && state.devId ? state.devId : '';

  // målinger
  $('temp').textContent = s && s.tempC !== null ? fmtT(s.tempC) : '–';
  $('rh').textContent = s && s.rh !== null ? fmtRh(s.rh) : '–';
  const lvl = s ? L.batteryLevel(s.vbatMv) : null;
  $('bat').textContent = lvl ? t('bat.' + lvl) : '–';
  const pct = s ? L.batteryPercent(s.vbatMv) : null;
  $('bat-pct').textContent = pct !== null ? `${pct} %` : '';
  const dew = s ? L.dewPoint(s.tempC, s.rh) : null;
  $('dew').textContent = dew !== null ? fmtT(dew) : '–';

  if (settings.use === 'restaurant') renderRestaurant(s, per); else renderVilt(s, per, avg24);

  // råd
  const adv = s ? L.advise({
    use: settings.use, tempC: s.tempC, rh: s.rh, dg: s.dg,
    target: settings.targetVilt, periodHours: per.hours, avg24,
    sensorErr: s.tempC === null, batteryLevel: lvl,
  }) : [];
  const ul = $('advice');
  ul.innerHTML = '';
  const fmtVars = (v = {}) => {
    const o = { ...v };
    // grensene (min/max) har samme enhet som verdien de står sammen med
    const lim = 'rh' in v ? fmtRh : (x) => `${fmt(x, Number.isInteger(x) ? 0 : 1)} °C`;
    if (typeof o.t === 'number') o.t = fmtT(o.t);
    if (typeof o.rh === 'number') o.rh = fmtRh(o.rh);
    if (typeof o.max === 'number') o.max = lim(o.max);
    if (typeof o.min === 'number') o.min = lim(o.min);
    return o;
  };
  if (!s) {
    $('advice').parentElement.hidden = true;
  } else {
    $('advice').parentElement.hidden = false;
    if (!adv.length) {
      const li = document.createElement('li');
      li.className = 'calm';
      li.textContent = t('adv.allGood');
      ul.appendChild(li);
    }
    for (const a of adv) {
      const li = document.createElement('li');
      li.className = a.level;
      li.textContent = t(a.key, fmtVars(a.vars));
      ul.appendChild(li);
    }
  }
  setGauge();
  $('btn-refresh').hidden = !connected();
  renderChart(per);
  renderPeriodNote();
  renderForecast(s);
  renderDebug();
  updateOtaButton();
}

function renderVilt(s, per, avg24) {
  const target = settings.targetVilt;
  $('dg-value').textContent = s ? fmt(Math.floor(s.dg * 10) / 10) : '–';
  $('goal-fill').style.width = `${s ? Math.round(Math.min(1, s.dg / target) * 100) : 0}%`;
  $('goal-fill').classList.toggle('done', !!(s && s.dg >= target));
  let note = t('hero.connectFirst');
  if (s) {
    const left = target - s.dg;
    if (left <= 0) note = t('hero.done', { target });
    else {
      const basisT = avg24 ?? s.tempC;
      const days = L.etaDays(s.dg, target, basisT);
      note = t('hero.left', { left: fmt(left), target }) + ' ';
      if (days === null) note += t('hero.tooCold');
      else {
        const basis = avg24 !== null ? t('hero.basisAvg', { t: fmtT(avg24) }) : t('hero.basisNow', { t: fmtT(s.tempC) });
        note += t('hero.eta', { basis, when: fmtWhen(new Date(Date.now() + days * 86400e3)) });
      }
    }
  }
  $('hero-note').textContent = note;
}

function renderRestaurant(s, per) {
  const target = settings.targetDays;
  const rhB = $('rh-band'), tB = $('t-band');
  rhB.textContent = t('read.target', { min: L.RESTAURANT_RH[0], max: `${L.RESTAURANT_RH[1]} %` });
  tB.textContent = t('read.target', { min: L.RESTAURANT_TEMP[0], max: `${L.RESTAURANT_TEMP[1]} °C` });
  rhB.classList.toggle('out', !!(s && s.rh !== null && (s.rh < L.RESTAURANT_RH[0] || s.rh > L.RESTAURANT_RH[1])));
  tB.classList.toggle('out', !!(s && s.tempC !== null && (s.tempC < L.RESTAURANT_TEMP[0] - 1 || s.tempC > L.RESTAURANT_TEMP[1])));

  // Hovedtallet følger valget (dager eller døgngrader), det andre står under.
  const day = per.hours !== null ? Math.floor(per.hours / 24) + 1 : null;
  const started = per.start !== null ? t('hero.restStart', { when: fmtDay(new Date(per.start)) }) : '';
  let big = '–', unit = '', sub = '', fill = 0, note = s ? '' : t('hero.connectFirst');
  if (s) {
    const dg = fmt(Math.floor(s.dg * 10) / 10);
    if (settings.restBy === 'dg') {
      const tg = settings.targetVilt;
      big = dg;
      unit = t('hero.dgOf', { target: tg });
      sub = day !== null ? t('hero.restSubDay', { day }) : '';
      fill = Math.min(1, s.dg / tg);
      note = s.dg >= tg ? t('hero.done', { target: tg }) : started;
    } else if (day !== null) {
      big = t('hero.dayOf', { day, target });
      sub = t('hero.restSubDg', { dg });
      fill = Math.min(1, per.hours / 24 / target);
      note = per.hours / 24 >= target ? t('hero.restDone', { target }) : started;
    } else {
      big = dg;                       // starten er ukjent: vis døgngradene
      unit = t('unit.dg');
      note = t('hero.resetForDays');
    }
  }
  $('day-value').textContent = big;
  $('day-unit').textContent = unit;
  $('rest-sub').textContent = sub;
  $('rest-sub').hidden = !sub;
  $('goal-fill').style.width = `${Math.round(fill * 100)}%`;
  $('goal-fill').classList.toggle('done', fill >= 1);
  $('hero-note').textContent = note;

  // vekt og svinn per måler og periode
  const key = s && state.devId ? `w.${state.devId}.${s.period}` : null;
  const w = key ? store.get(key, {}) : {};
  if (document.activeElement !== $('w-start')) $('w-start').value = w.start ?? '';
  if (document.activeElement !== $('w-now')) $('w-now').value = w.now ?? '';
  $('w-start').disabled = $('w-now').disabled = !key;
  const sh = L.shrinkPercent(w.start, w.now);
  $('shrink').textContent = sh !== null ? t('rest.shrink', { pct: `${fmt(sh)} %` }) : '';
}

function saveWeights() {
  const s = state.status;
  if (!s || !state.devId) return;
  const num = (v) => { const n = parseFloat(String(v).replace(',', '.')); return n > 0 ? n : null; };
  store.set(`w.${state.devId}.${s.period}`, { start: num($('w-start').value), now: num($('w-now').value) });
  render();
}

function renderChart(per) {
  const svg = $('chart');
  const all = state.history;
  const W = Math.max(280, Math.round(svg.getBoundingClientRect().width) || 360), H = 240, Lm = 30, Rm = 30, T = 10, B = 26;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  if (!all.length) { svg.innerHTML = ''; return; }
  // vis perioden, og opptil 24 timer før den i grått
  const shownOld = per.before.slice(-24);
  const recs = shownOld.concat(per.records);
  const temps = recs.map((r) => r.tempC).filter((v) => v !== null);
  let lo = Math.floor(Math.min(0, ...temps) / 5) * 5, hi = Math.ceil(Math.max(5, ...temps) / 5) * 5;
  const t0 = recs[0].time, t1 = recs[recs.length - 1].time, span = Math.max(t1 - t0, 3600e3);
  const x = (tm) => Lm + ((tm - t0) / span) * (W - Lm - Rm);
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const yh = (v) => T + (1 - v / 100) * (H - T - B);
  let s = '';
  if (settings.use === 'restaurant') s += `<rect class="band" x="${Lm}" width="${W - Lm - Rm}" y="${yh(L.RESTAURANT_RH[1])}" height="${yh(L.RESTAURANT_RH[0]) - yh(L.RESTAURANT_RH[1])}"/>`;
  for (let v = lo; v <= hi; v += 5) {
    s += `<line class="${v === 0 ? 'zero' : 'grid'}" x1="${Lm}" x2="${W - Rm}" y1="${y(v)}" y2="${y(v)}"/>`;
    s += `<text x="${Lm - 5}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
  }
  for (const v of [0, 50, 100]) s += `<text x="${W - Rm + 5}" y="${yh(v) + 4}">${v}</text>`;
  const dayFmt = new Intl.DateTimeFormat(locale(), { weekday: 'short', day: 'numeric' });
  const day = new Date(t0); day.setHours(24, 0, 0, 0);
  const step = span / 86400e3 > 14 ? 7 : span / 86400e3 > 6 ? 2 : 1;
  for (let d = day.getTime(), k = 0; d <= t1; d += 86400e3, k++) {
    if (k % step) continue;
    s += `<line class="grid" x1="${x(d)}" x2="${x(d)}" y1="${T}" y2="${H - B}"/><text x="${x(d) + 3}" y="${H - 8}">${dayFmt.format(d)}</text>`;
  }
  const line = (rs, val, yf) => {
    let d = '', open = false;
    for (const r of rs) { const v = val(r); if (v === null) { open = false; continue; } d += `${open ? 'L' : 'M'}${x(r.time).toFixed(1)},${yf(v).toFixed(1)}`; open = true; }
    return d;
  };
  const split = shownOld.length;
  const oldR = recs.slice(0, split + 1), newR = recs.slice(split);
  if (split) {
    s += `<path class="h old" d="${line(oldR, (r) => r.rh, yh)}"/><path class="t old" d="${line(oldR, (r) => r.tempC, y)}"/>`;
    s += `<line class="mark" x1="${x(newR[0].time)}" x2="${x(newR[0].time)}" y1="${T}" y2="${H - B}"/>`;
  }
  s += `<path class="h" d="${line(newR, (r) => r.rh, yh)}"/><path class="t" d="${line(newR, (r) => r.tempC, y)}"/>`;
  svg.innerHTML = s;
  $('hist-note').textContent = t('hist.summary', { hours: per.records.length, dg: fmt(L.dgFromRecords(per.records)) });
}

function renderDebug() {
  const s = state.status, rows = [];
  if (state.device) rows.push([t('dbg.device'), state.device.name]);
  if (state.fw) rows.push([t('dbg.firmware'), state.fw]);
  if (state.model) rows.push([t('dbg.model'), state.model]);
  if (s) {
    rows.push([t('dbg.read'), state.statusAt.toLocaleTimeString(locale())]);
    rows.push([t('dbg.period'), s.period]);
    rows.push([t('dbg.sum'), `${s.sum} (${fmt(s.dg, 2)})`]);
    rows.push([t('dbg.counter'), s.measCounter]);
    rows.push([t('dbg.uptime'), `${s.uptimeMin} min`]);
    rows.push([t('dbg.sleeps'), s.sleepCount]);
    rows.push([t('dbg.battery'), `${s.vbatMv} mV`]);
    rows.push([t('dbg.flags'), `0x${s.flags.toString(16).padStart(2, '0')}`]);
    rows.push([t('dbg.raw'), state.statusHex]);
  }
  if (state.diag) {
    const d = state.diag;
    rows.push([t('dbg.cal'), d.capFlash === null ? t('dbg.calNone') : `0x${d.capFlash.toString(16)} (${t('dbg.calUsed')})`]);
    rows.push([t('dbg.bank'), `0x${d.runningFrom.toString(16).padStart(5, '0')}`]);
    rows.push([t('dbg.otaWin'), d.otaBusy ? t('dbg.otaBusy') : d.otaMinutesLeft ? t('dbg.otaOpen', { min: d.otaMinutesLeft }) : t('dbg.otaClosed')]);
  }
  if (state.histInfo) {
    const i = state.histInfo;
    rows.push([t('dbg.history'), t('dbg.historyVal', { a: i.oldest, b: i.next - 1, min: Math.round(i.secsSinceLast / 60) })]);
    const ps = P.periodStartMs(i, state.histReadAt);
    rows.push([t('dbg.periodStart'), ps !== null ? `${fmtWhen(new Date(ps))} (${i.psHour}/${i.psSample})` : t('dbg.unknown')]);
  }
  if (state.device) rows.push([t('dbg.settings'), state.chars.set ? `${settings.use}, ${settings.targetVilt} dg, ${settings.targetDays} d, ${settings.restBy}` : t('settings.old')]);
  const esc = (v) => String(v).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  $('debug-list').innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
}

// ---------- Bluetooth ----------
async function connect() {
  if (state.demo) return demoConnect();
  try {
    const device = state.device && !state.device.gatt.connected ? state.device : await navigator.bluetooth.requestDevice({
      // Windows husker gjerne gammelt navn for samme MAC (0.4: "Doegngrader")
      filters: [{ namePrefix: 'DG-' }, { namePrefix: 'Doegngrader' }, { manufacturerData: [{ companyIdentifier: 0xffff }] }],
      optionalServices: [P.UUID.service, 'device_information', P.OTA_SERVICE, P.SET_SERVICE],
    });
    state.device = device;
    state.devId = L.deviceId(device.name);
    device.removeEventListener('gattserverdisconnected', onDisconnected);
    device.addEventListener('gattserverdisconnected', onDisconnected);
    renderConn('wait');
    log(`Kobler til ${device.name}`);
    const server = await device.gatt.connect();
    const svc = await server.getPrimaryService(P.UUID.service);
    for (const k of ['status', 'histInfo', 'histCtl', 'histData']) state.chars[k] = await svc.getCharacteristic(P.UUID[k]);
    try {
      const dis = await server.getPrimaryService('device_information');
      const dec = new TextDecoder();
      state.fw = dec.decode(await (await dis.getCharacteristic('firmware_revision_string')).readValue()).trim();
      state.model = dec.decode(await (await dis.getCharacteristic('model_number_string')).readValue()).trim();
    } catch (e) { log(`Enhetsinfo: ${e.message}`); }
    try {
      state.chars.diag = await svc.getCharacteristic(P.DIAG_UUID);
      state.diag = P.parseDiag(await state.chars.diag.readValue());
    } catch (e) { state.chars.diag = null; state.diag = null; }
    try {
      const ota = await server.getPrimaryService(P.OTA_SERVICE);
      state.chars.ota = await ota.getCharacteristic(P.OTA_CHAR);
    } catch (e) { state.chars.ota = null; }
    try {
      const set = await server.getPrimaryService(P.SET_SERVICE);
      state.chars.set = await set.getCharacteristic(P.SET_CHAR);
    } catch (e) { state.chars.set = null; }
    state.chars.status.addEventListener('characteristicvaluechanged', (ev) => onStatus(ev.target.value));
    onStatus(await state.chars.status.readValue());
    await state.chars.status.startNotifications();
    renderConn('on');
    $('btn-hist').disabled = false;
    log('Tilkoblet');
    await syncSettingsOnConnect();
    fetchHistory();   // trengs for periode, anslag og graf
  } catch (e) {
    log(`Feil: ${e.message}`);
    if (e.name !== 'NotFoundError') alertBox(t('err.connect', { msg: e.message }));
    renderConn('off');
  }
}

function alertBox(msg) { log(msg); }

function onDisconnected() {
  log('Frakoblet');
  state.otaDisconnected = true;
  renderConn('off');
  toggleConnPop(false);
  $('btn-hist').disabled = true;
  updateOtaButton();
}

function onStatus(dv) {
  state.status = P.parseStatus(dv);
  state.statusHex = P.hex(dv);
  state.statusAt = new Date();
  const st = state.status;
  setDevInfo({ last: { dg: st.dg, tempC: st.tempC, rh: st.rh, mv: st.vbatMv, at: Date.now() } });
  log(`Status ${state.statusHex}`);
  render();
}

async function fetchHistory() {
  if (state.demo) return demoHistory();
  if (state.histBusy || !connected()) return;
  state.histBusy = true;
  $('btn-hist').disabled = true;
  try {
    const info = P.parseHistInfo(await state.chars.histInfo.readValue());
    const readAt = Date.now();
    const count = info.next - info.oldest;
    if (count <= 0) { state.histInfo = info; $('hist-note').textContent = t('hist.empty'); return; }
    const got = [];
    await new Promise((resolve, reject) => {
      const ch = state.chars.histData;
      const timer = setTimeout(() => { cleanup(); reject(new Error(`${got.length}/${count}`)); }, HIST_TIMEOUT_MS);
      const onData = (ev) => {
        const p = P.parseHistPacket(ev.target.value);
        if (p.done) { cleanup(); resolve(); return; }
        got.push(...p.records);
        $('hist-note').textContent = t('hist.fetching', { n: got.length, total: count });
      };
      const cleanup = () => { clearTimeout(timer); ch.removeEventListener('characteristicvaluechanged', onData); };
      ch.addEventListener('characteristicvaluechanged', onData);
      ch.startNotifications()
        .then(() => state.chars.histCtl.writeValueWithResponse(P.buildHistRequest(info.oldest, count)))
        .catch((e) => { cleanup(); reject(e); });
    });
    state.histInfo = info;
    state.histReadAt = readAt;
    state.history = got.map((r) => ({ ...r, time: P.hourToTimeMs(r.hour, info, readAt) }));
    log(`Historikk: ${got.length} poster`);
    $('btn-csv').disabled = !got.length;
    render();
  } catch (e) {
    log(`Historikk feilet: ${e.message}`);
    $('hist-note').textContent = t('hist.failed', { msg: e.message });
  } finally {
    state.histBusy = false;
    $('btn-hist').disabled = !connected() && !state.demo;
  }
}

function downloadCsv() {
  const lines = ['tid;time_nr;temperatur_c;fuktighet_pst;status'];
  for (const r of state.history) lines.push([new Date(r.time).toISOString(), r.hour, r.tempC ?? '', r.rh ?? '', P.flagNames(r.flags, P.HIST_FLAGS).join(',')].join(';'));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([lines.join('\r\n') + '\r\n'], { type: 'text/csv' }));
  a.download = `${state.device?.name || 'dg'}-historikk.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// «Les på nytt» erstatter sveip ned (som laster siden på nytt og kobler fra).
async function refreshAll() {
  if (state.demo) { demoHistory(); return; }
  if (!connected()) return;
  try {
    onStatus(await state.chars.status.readValue());
    if (state.chars.diag) state.diag = P.parseDiag(await state.chars.diag.readValue());
    if (state.chars.set && !settings.pendingSync) await syncSettingsOnConnect();
  } catch (e) { log(`Les på nytt: ${e.message}`); }
  fetchHistory();
}

// ---------- oversikt over målere (lagret i nettleseren) ----------
function knownMeters() {
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      const m = /^dg\.dev\.([0-9A-F]{4})$/.exec(k || '');
      if (m) out.push({ id: m[1], ...store.get('dev.' + m[1], {}) });
    }
  } catch (e) { /* ingen lagring */ }
  return out.filter((m) => m.last).sort((a, b) => b.last.at - a.last.at);
}

function renderMeters() {
  const list = state.status ? [] : knownMeters();
  document.body.classList.toggle('overview', list.length > 0);
  $('meters').hidden = !list.length;
  const ul = $('meter-list');
  ul.innerHTML = '';
  for (const m of list) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'meter-card';
    const L1 = document.createElement('span'); L1.className = 'mc-name'; L1.textContent = m.name || `DG-${m.id}`;
    const L2 = document.createElement('span'); L2.className = 'mc-id'; L2.textContent = m.name ? `DG-${m.id}` : '';
    const L3 = document.createElement('span'); L3.className = 'mc-vals';
    L3.textContent = [`${fmt(Math.floor(m.last.dg * 10) / 10)} dg`, m.last.tempC !== null ? fmtT(m.last.tempC) : null, m.last.rh !== null ? fmtRh(m.last.rh) : null].filter(Boolean).join('  ·  ');
    const L4 = document.createElement('span'); L4.className = 'mc-when'; L4.textContent = t('meters.last', { when: fmtWhen(new Date(m.last.at)) });
    b.append(L1, L2, L3, L4);
    b.addEventListener('click', connect);
    li.appendChild(b);
    ul.appendChild(li);
  }
}

// ---------- notat per periode ----------
function noteKey() { return state.status && state.devId ? `note.${state.devId}.${state.status.period}` : null; }
function renderPeriodNote() {
  const el = $('per-note'), key = noteKey();
  el.disabled = !key;
  if (document.activeElement !== el) el.value = key ? store.get(key, '') : '';
}

// ---------- værvarsel (MET Locationforecast, bare vilt) ----------
const FC_URL = 'https://api.met.no/weatherapi/locationforecast/2.0/compact';

async function loadForecast() {
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

function renderForecast(s) {
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
  notes.push(t('fc.source', { time: fmtTime(new Date(fc.fetchedAt)) }));
  $('fc-note').textContent = notes.join(' ');
}

function renderFcSettings() {
  $('fc-on').checked = !!settings.fcOn;
  $('fc-pos').textContent = settings.fcLat !== null ? t('fc.pos', { lat: settings.fcLat, lon: settings.fcLon }) : t('fc.noPos');
}

function askPosition() {
  if (!navigator.geolocation) { $('fc-pos').textContent = t('fc.posFailed', { msg: 'geolocation' }); return; }
  navigator.geolocation.getCurrentPosition((p) => {
    const r = L.roundPos(p.coords.latitude, p.coords.longitude);
    settings.fcLat = r.lat; settings.fcLon = r.lon; settings.fcOn = true;
    saveSettings(); state.fc = null;
    renderFcSettings(); render();
  }, (err) => { $('fc-pos').textContent = t('fc.posFailed', { msg: err.message }); }, { maximumAge: 3600e3, timeout: 20000 });
}

// ---------- byggeinfo ----------
async function loadBuildInfo() {
  const el = $('build');
  const year = new Date().getFullYear();
  try {
    const res = await fetch('build.json', { cache: 'no-store' });
    if (!res.ok) throw new Error();
    const b = await res.json();
    const d = new Date(b.built);
    const when = new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d);
    el.textContent = t('foot.build', { commit: b.commit, when, year: d.getFullYear() });
  } catch (e) {
    el.textContent = t('foot.copy', { year });
  }
  $('build-menu').textContent = el.textContent;
}

// ---------- OTA ----------
async function loadLatestFirmware() {
  try {
    const res = await fetch('firmware/latest.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.latest = await res.json();
  } catch (e) { state.latest = null; }
  updateOtaButton();
}

function updateOtaButton() {
  const ready = connected() && state.chars.ota && !state.otaRunning;
  $('btn-ota').disabled = !(ready && $('ota-file').files.length);
  $('btn-ota-latest').disabled = !(ready && state.latest);
  const el = $('ota-latest');
  if (state.latest) {
    el.textContent = t('ota.latest', { v: state.latest.version, kb: Math.round(state.latest.size / 1024), cur: state.fw || '?' });
    $('btn-ota-latest').textContent = state.fw === state.latest.version ? t('ota.reinstall', { v: state.latest.version }) : t('ota.update', { v: state.latest.version });
  } else {
    el.textContent = t('ota.latestMissing');
  }
  $('btn-ota-latest').hidden = !state.latest;
  if (connected() && !state.chars.ota && !state.demo) $('ota-status').textContent = t('ota.noOta');
}

async function runOta(source) {
  const st = $('ota-status'), bar = $('ota-progress');
  let fw;
  st.classList.remove('failed');
  try {
    if (source === 'latest') {
      st.textContent = t('ota.fetching', { v: state.latest.version });
      const res = await fetch(`firmware/doegngrader.bin?v=${state.latest.sha256.slice(0, 12)}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fw = new Uint8Array(await res.arrayBuffer());
      if (fw.length !== state.latest.size) throw new Error('feil størrelse på nedlastet fil');
    } else {
      fw = new Uint8Array(await $('ota-file').files[0].arrayBuffer());
    }
    P.validateFirmware(fw);
  } catch (e) { st.textContent = t('ota.badFile', { msg: e.message }); st.classList.add('failed'); return; }

  if (state.chars.diag) {
    state.diag = P.parseDiag(await state.chars.diag.readValue());
    renderDebug();
    if (!state.diag.otaMinutesLeft && !state.diag.otaBusy) { st.textContent = t('ota.windowClosed'); st.classList.add('failed'); return; }
  }

  const ch = state.chars.ota;
  const n = Math.ceil(fw.length / 16);
  state.otaRunning = true;
  state.otaDisconnected = false;
  updateOtaButton();
  bar.hidden = false; bar.max = n; bar.value = 0; bar.classList.remove('failed');
  let result = null;
  const onNotify = (ev) => {
    const r = P.parseOtaNotify(ev.target.value);
    if (r.type === 'result') { result = r; log(`OTA: ${r.text}`); }
  };
  ch.addEventListener('characteristicvaluechanged', onNotify);
  const t0 = Date.now();
  try {
    await ch.startNotifications();
    await ch.writeValueWithoutResponse(P.OTA_CMD_START);
    for (let i = 0; i < n; i++) {
      if (result && result.code !== 0) throw new Error(result.text);
      await ch.writeValueWithoutResponse(P.otaPacket(fw, i));
      if (i % 8 === 7) {
        await ch.readValue();   // flytkontroll: venter til måleren har tatt imot
        bar.value = i + 1;
        st.textContent = t('ota.sending', { pct: Math.round(((i + 1) / n) * 100), i: i + 1, n });
      }
    }
    await ch.readValue();
    await ch.writeValueWithoutResponse(P.otaEndCmd(n - 1));
    bar.value = n;
    st.textContent = t('ota.waiting');
    for (let k = 0; k < 100 && !result && !state.otaDisconnected; k++) await new Promise((r) => setTimeout(r, 100));
    const secs = Math.round((Date.now() - t0) / 1000);
    if (result && result.code !== 0) throw new Error(result.text);
    st.textContent = result ? t('ota.done', { s: secs }) : t('ota.doneNoReply', { s: secs });
  } catch (e) {
    st.textContent = t('ota.failed', { msg: e.message });
    bar.classList.add('failed'); st.classList.add('failed');
    log(`OTA feilet: ${e.message}`);
  } finally {
    ch.removeEventListener('characteristicvaluechanged', onNotify);
    state.otaRunning = false;
    updateOtaButton();
  }
}

// ---------- demo (?demo, nevnes i bruksanvisningen) ----------
function demoConnect() {
  state.device = { name: 'DG-DE40', gatt: { connected: true, disconnect() { this.connected = false; onDisconnected(); } } };
  state.devId = 'DE40';
  state.fw = '0.5.6';
  state.model = 'LYWSD03MMC B1.1';
  // innstillinger i «måleren», samme bytes som firmwaren
  let demoSet = P.buildSettings({ use: settings.use, targetDg: settings.targetVilt, targetDays: settings.targetDays, restBy: settings.restBy });
  state.chars.set = {
    async writeValueWithResponse(b) { demoSet = new Uint8Array(b); },
    async readValue() { return new DataView(demoSet.buffer.slice(0)); },
  };
  demoHistory(false);
  const b = new Uint8Array(21), v = new DataView(b.buffer);
  const sum = Math.round(L.dgFromRecords(L.currentPeriod(state.history, state.histInfo.psHour).records) * 28800);
  v.setUint8(0, 1); v.setUint8(1, 0x56); v.setUint16(2, Math.floor(sum / 2880), true); v.setInt16(4, 612, true);
  v.setUint8(6, 82); v.setUint16(7, 2931, true); v.setUint8(9, 61); v.setUint32(10, sum, true);
  v.setUint16(14, 14, true); v.setUint16(16, 7843, true); v.setUint16(18, 47012, true);
  renderConn('on');
  $('btn-hist').disabled = false;
  onStatus(v);
  syncSettingsOnConnect().then(render);
}

function demoHistory(draw = true) {
  const now = Date.now(), n = 24 * 6;
  state.histInfo = { oldest: 0, next: n, secsSinceLast: 1200, psHour: 21, psSample: 4 };
  state.histReadAt = now;
  state.history = Array.from({ length: n }, (_, h) => {
    const day = Math.sin((((h % 24) - 8) / 24) * 2 * Math.PI);
    const tC = 5.5 + 1.2 * day + (h < 30 ? 2.5 - h / 12 : 0);
    return { hour: h, tempC: Math.round(tC * 10) / 10, rh: Math.round(80 + 6 * day), flags: h === 20 ? 0x02 : h === 0 ? 0x01 : 0, time: P.hourToTimeMs(h, state.histInfo, now) };
  });
  $('btn-csv').disabled = false;
  if (draw) render();
}

// ---------- oppstart ----------
function init() {
  applyMode();
  applyUse();
  if (!state.demo && !('bluetooth' in navigator)) $('nosupport').hidden = false;

  $('conn').addEventListener('click', (e) => {
    e.stopPropagation();
    if (connected()) toggleConnPop();
    else connect();
  });
  $('btn-disconnect').addEventListener('click', () => { if (state.device) state.device.gatt.disconnect(); toggleConnPop(false); });
  $('dev-name').addEventListener('input', (e) => { setDevInfo({ name: e.target.value.trim() }); render(); });
  document.addEventListener('click', (e) => { if (!$('conn-pop').hidden && !$('conn-pop').contains(e.target)) toggleConnPop(false); });

  $('m-simple').addEventListener('click', () => { settings.mode = 'simple'; saveSettings(); applyMode(); render(); });
  $('m-adv').addEventListener('click', () => { settings.mode = 'adv'; saveSettings(); applyMode(); render(); });
  $('btn-settings').addEventListener('click', openSettings);
  $('btn-refresh').addEventListener('click', refreshAll);
  for (const r of document.querySelectorAll('#settings input[name=use]')) r.addEventListener('change', (e) => { settings.use = e.target.value; applyUse(); applyTargetFields(); settingChanged(); });
  for (const r of document.querySelectorAll('#settings input[name=restby]')) r.addEventListener('change', (e) => { settings.restBy = e.target.value; applyTargetFields(); settingChanged(); });
  for (const b of document.querySelectorAll('#settings [data-step]')) {
    b.addEventListener('click', () => setTarget(b.dataset.step, Number($(b.dataset.step).value) + Number(b.dataset.d)));
  }
  for (const id of ['target-vilt', 'target-days']) $(id).addEventListener('change', (e) => setTarget(id, Number(e.target.value)));
  for (const r of document.querySelectorAll('#settings input[name=lang]')) r.addEventListener('change', (e) => { settings.lang = e.target.value; saveSettings(); buildGauge(); render(); loadBuildInfo(); });

  $('w-start').addEventListener('change', saveWeights);
  let noteT = 0;
  $('per-note').addEventListener('input', (e) => {
    clearTimeout(noteT);
    noteT = setTimeout(() => { const k = noteKey(); if (k) store.set(k, e.target.value); }, 400);
  });
  $('fc-on').addEventListener('change', (e) => {
    settings.fcOn = e.target.checked; saveSettings();
    if (settings.fcOn && settings.fcLat === null) askPosition(); else render();
  });
  $('btn-fc-pos').addEventListener('click', askPosition);
  // Menyen lukkes med krysset eller Esc. Enter i et felt skal ikke lukke den.
  $('settings').querySelector('form').addEventListener('submit', (e) => e.preventDefault());
  $('btn-menu-close').addEventListener('click', () => $('settings').close());
  $('w-now').addEventListener('change', saveWeights);
  $('btn-hist').addEventListener('click', fetchHistory);
  $('btn-csv').addEventListener('click', downloadCsv);
  $('btn-ota').addEventListener('click', () => runOta('file'));
  $('btn-ota-latest').addEventListener('click', () => runOta('latest'));
  $('ota-file').addEventListener('change', updateOtaButton);

  let rt;
  addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(render, 150); });
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

  renderConn('off');
  render();
  loadLatestFirmware();
  loadBuildInfo();
  if (state.demo) demoConnect();
}

init();
