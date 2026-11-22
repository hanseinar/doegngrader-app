// app.js - nettside for døgngrader-måleren, versjon 3 (Web Bluetooth)
//
// Versjon 3 (2026-11-22): ingen Enkel/Avansert. Forsiden har hovedtall, tre
// instrumenter (temperatur, fuktighet, duggpunkt) som er opplyst bare når
// måleren er tilkoblet, og grafen bak en trekant. Resten ligger under
// tannhjulet. Notat og vekt er tatt ut (lå bare i nettleseren).
//
// Oppbygging:
//   protocol.js  tolking av data fra måleren
//   logic.js     regler: periode, anslag, batterinivå, duggpunkt, råd
//   i18n.js      all tekst, norsk og engelsk
//   ameter.js    analogt instrument (fra webrig-vhf)
// Innstillinger og navn på målere lagres i nettleseren (localStorage).
import * as P from './protocol.js';
import * as L from './logic.js';
import * as LIC from './license.js';
import { translate, pickLang } from './i18n.js';
import { BUILD } from './version.js';

const HIST_TIMEOUT_MS = 60000;
const $ = (id) => document.getElementById(id);

// ---------- lagring i nettleseren ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem('dg.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('dg.' + k, JSON.stringify(v)); } catch (e) { /* privat modus o.l. */ } },
};

const settings = Object.assign(
  { use: 'vilt', lang: null, targetVilt: 40, targetDays: 28, restBy: 'days', smiley: false, pendingSync: false,
    fcOn: false, fcLat: null, fcLon: null, fcPlace: null },
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

function applyUse() {
  document.body.dataset.use = settings.use;
  // samme farger for vilt og restaurant (fra 2.4), skalaene følger bruken
  buildGauges();
}

// Smilefjes ved mål finnes fra firmware 0.6.3. Ukjent firmware (ikke tilkoblet): tillatt.
const SMILEY_FW = '0.6.3';
function smileySupported() { return !state.fw || P.fwNum(state.fw) >= P.fwNum(SMILEY_FW); }

// ---------- innstillinger: dialog og lagring i måleren (fra firmware 0.5.5) ----------
const LIMITS = { 'target-vilt': P.SET_LIMITS.dg, 'target-days': P.SET_LIMITS.days };
const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, Math.round(v)));

function renderSync() {
  const el = $('set-sync');
  const name = state.device ? state.device.name : '';
  el.classList.toggle('bad', state.setState === 'failed');
  // «Lagret i måleren» vises ikke (2026-11-22), bare det brukeren må vite
  el.textContent = {
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
  $('smiley-on').checked = !!settings.smiley;
  $('target-vilt').value = settings.targetVilt;
  $('target-days').value = settings.targetDays;
  refreshSettingsTexts();
  renderFcSettings();
  dlg.showModal();
}

// Tekster i dialogen som avhenger av språk og firmware
function refreshSettingsTexts() {
  $('smiley-on').disabled = !smileySupported();
  $('smiley-help').textContent = smileySupported() ? t('settings.smileyHelp') : t('settings.smileyOld', { v: SMILEY_FW });
  applyTargetFields();
  renderSync();
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
    const want = { use: settings.use, targetDg: settings.targetVilt, targetDays: settings.targetDays, restBy: settings.restBy,
      smiley: smileySupported() && !!settings.smiley };
    const got = await gattQ(async () => {
      await state.chars.set.writeValueWithResponse(P.buildSettings(want));
      return P.parseSettings(await state.chars.set.readValue());
    });
    if (got.use !== want.use || got.targetDg !== want.targetDg || got.targetDays !== want.targetDays) {
      throw new Error('måleren svarte med andre verdier');
    }
    if (got.restBy !== want.restBy) throw new Error('måleren kan ikke telle døgngrader i restaurant, oppdater til 0.5.6');
    if (got.smiley !== want.smiley) throw new Error(`smilefjes krever firmware ${SMILEY_FW}`);
    settings.pendingSync = false;
    saveSettings();
    state.setState = 'synced';
    log(`Innstillinger lagret i måleren: ${want.use}, ${want.targetDg} dg, ${want.targetDays} dager, smilefjes ${want.smiley ? 'på' : 'av'}`);
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
    const m = await gattQ(async () => P.parseSettings(await state.chars.set.readValue()));
    const useChanged = m.use !== settings.use;
    Object.assign(settings, { use: m.use, targetVilt: m.targetDg, targetDays: m.targetDays, restBy: m.restBy, smiley: m.smiley });
    saveSettings();
    if (useChanged) applyUse();
    state.setState = 'synced';
    log(`Innstillinger fra måleren: ${m.use}, ${m.targetDg} dg, ${m.targetDays} dager, smilefjes ${m.smiley ? 'på' : 'av'}`);
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
      : state.statusAt ? t('conn.again', { time: fmtTime(state.statusAt) }) : t('conn.off');
    btn.setAttribute('aria-label', txt.textContent);
  }
}

function toggleConnPop(show) {
  const pop = $('conn-pop');
  if (show === undefined) show = pop.hidden;
  if (show) {
    $('pop-name').textContent = state.device ? state.device.name : '';
    $('pop-read').textContent = state.statusAt ? t('conn.lastRead', { time: fmtTime(state.statusAt) }) : '';
    const s = state.status, lvl = s ? L.batteryLevel(s.vbatMv) : null, pct = s ? L.batteryPercent(s.vbatMv) : null;
    $('pop-bat').textContent = lvl ? t('conn.battery', { lvl: t('bat.' + lvl), pct: pct !== null ? `${pct} %` : '' }) : '';
    $('dev-name').value = devInfo().name || '';
  }
  pop.hidden = !show;
}

function devInfo() { return state.devId ? store.get('dev.' + state.devId, {}) : {}; }
function setDevInfo(patch) { if (state.devId) store.set('dev.' + state.devId, Object.assign(devInfo(), patch)); }

// ---------- instrumenter: temperatur, fuktighet, duggpunkt ----------
// Børstet aluminium. Opplyst når måleren er tilkoblet, mørke ellers (gamle verdier).
// Vilt: rødt fra 15 °C (insekter) og fra 90 % (kondens). Restaurant: grønne bånd for målområdet.
const G_TEMP = [-10, 30], G_DEW = [-10, 20];
const frac = ([lo, hi], v) => (v - lo) / (hi - lo);
let gauges = null;
function buildGauges() {
  if (!window.AnalogMeter) { gauges = null; return; }
  const rest = settings.use === 'restaurant';
  const ticks = (r, vals) => vals.map((v) => [String(v), frac(r, v)]);
  const make = (id, label, tk, zones, minor) => new window.AnalogMeter($(id), {
    face: 'alu', upper: { label, ticks: tk, minor, zones }, riseS: 0.8, fallS: 0.8,
  });
  gauges = {
    temp: make('g-temp', t('gauge.temp'), ticks(G_TEMP, [-10, 0, 10, 20, 30]),
      rest ? [[frac(G_TEMP, L.RESTAURANT_TEMP[0]), frac(G_TEMP, L.RESTAURANT_TEMP[1]), '#2f8a4f']] : [[frac(G_TEMP, 15), 1, '#b8261b']], 40),
    rh: make('g-rh', t('gauge.rh'), ticks([0, 100], [0, 20, 40, 60, 80, 100]),
      rest ? [[L.RESTAURANT_RH[0] / 100, L.RESTAURANT_RH[1] / 100, '#2f8a4f']] : [[L.VILT_RH_CONDENSE / 100, 1, '#b8261b']], 20),
    dew: make('g-dew', t('gauge.dew'), ticks(G_DEW, [-10, -5, 0, 5, 10, 15, 20]), [], 30),
  };
  setGauges();
}
function setGauges() {
  if (!gauges) return;
  const s = state.status;
  const dew = s ? L.dewPoint(s.tempC, s.rh) : null;
  gauges.temp.set(s && s.tempC !== null ? frac(G_TEMP, s.tempC) : 0);
  gauges.rh.set(s && s.rh !== null ? s.rh / 100 : 0);
  gauges.dew.set(dew !== null ? frac(G_DEW, dew) : 0);
  const live = connected();
  $('gauges').classList.toggle('on', live);
  $('gauges').classList.toggle('off', !live);
  $('gauge-state').textContent = !live && state.statusAt ? t('gauge.old', { time: fmtTime(state.statusAt) }) : '';
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

// Råd -> kapittel i læreboka (laerebok/index.html)
const BOOK_ANCHOR = {
  'adv.v.coldShort': 'forste', 'adv.v.flies': 'fluer', 'adv.v.avg15': 'temp', 'adv.v.avg10': 'temp',
  'adv.v.condense': 'fukt', 'adv.v.done': 'lengde', 'adv.frost': 'dg',
  'adv.r.warm': 'restaurant', 'adv.r.wet': 'restaurant', 'adv.r.dry': 'restaurant',
};

// ---------- visning ----------
function render() {
  applyTexts();
  if (!connected()) renderConn('off');   // pilleteksten styres her, ikke av data-t
  const s = state.status;
  renderMeters();
  const per = period();
  const avg24 = L.avgTemp(per.records);

  // hvem
  const info = devInfo();
  $('who').hidden = !state.devId;
  $('who-name').textContent = info.name || (state.device ? state.device.name : '');
  $('who-id').textContent = info.name && state.devId ? state.devId : '';

  // målinger (tallene under instrumentene)
  $('temp').textContent = s && s.tempC !== null ? fmtT(s.tempC) : '–';
  $('rh').textContent = s && s.rh !== null ? fmtRh(s.rh) : '–';
  const lvl = s ? L.batteryLevel(s.vbatMv) : null;
  const dew = s ? L.dewPoint(s.tempC, s.rh) : null;
  $('dew').textContent = dew !== null ? fmtT(dew) : '–';
  // Bare det som krever handling vises på forsiden: sensorfeil og batteri
  const warn = !s ? '' : s.tempC === null ? t('adv.sensor')
    : lvl === 'replace' ? t('adv.batteryReplace') : lvl === 'low' ? t('adv.batteryLow') : '';
  $('hero-warn').textContent = warn;
  $('hero-warn').hidden = !warn;

  if (settings.use === 'restaurant') renderRestaurant(s, per); else renderVilt(s, per, avg24);
  $('front-note').hidden = !!s;

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
    const li = document.createElement('li');
    li.className = 'calm';
    li.textContent = t('adv.noData');
    ul.appendChild(li);
  } else {
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
      const anchor = BOOK_ANCHOR[a.key];
      if (anchor) {
        const link = document.createElement('a');
        link.href = `laerebok/?lang=${settings.lang}#${anchor}`;
        link.className = 'more';
        link.addEventListener('click', (e) => { e.preventDefault(); openReader(link.getAttribute('href')); });
        link.textContent = t('adv.more');
        li.append(' ', link);
      }
      ul.appendChild(li);
    }
  }
  setGauges();
  $('btn-refresh').hidden = !connected();
  // ny periode fra appen krever firmware 0.6.0
  $('btn-newp').hidden = !(connected() && state.chars.cmd && P.fwNum(state.fw) >= P.fwNum('0.6.0'));
  renderChart(per);
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
      // Værvarselet (under tannhjulet) gir et eget anslag når det er slått på
      const fe = forecastEta(s);
      if (fe && fe.at !== null) note += ' ' + t('fc.etaShort', { when: fmtWhen(new Date(fe.at)) });
    }
  }
  $('hero-note').textContent = note;
}

function renderRestaurant(s, per) {
  const target = settings.targetDays;

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
}

function renderChart(per) {
  const svg = $('chart');
  const all = state.history;
  if (!$('graph').open) return;     // tegnes når trekanten åpnes
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

// ---------- abonnement (kunderegister, skjult til license.js er satt opp) ----------
async function refreshLicense() {
  const cfg = LIC.config(), sec = $('lic-sec');
  sec.hidden = !cfg;
  if (!cfg) return;
  $('lic-minside').href = cfg.minside;
  const list = $('lic-list'), note = $('lic-note');
  list.innerHTML = '';
  if (!state.serial) { note.textContent = t('lic.noSerial'); return; }
  note.textContent = t('lic.loading');
  const serial = state.serial;
  let res;
  try { res = await LIC.load(serial); } catch (e) { res = null; }
  if (serial !== state.serial) return;    // byttet måler i mellomtiden
  if (!res || (!res.doc && res.verified !== false && res.offline)) { note.textContent = t('lic.error'); return; }
  if (res.verified === false) { note.textContent = t('lic.bad'); return; }
  const today = new Date().toISOString().slice(0, 10);
  const rows = LIC.view(res.doc, today);
  const esc = (v) => String(v).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  list.innerHTML = rows.map((r) => {
    const name = t('lic.f.' + r.feature) === 'lic.f.' + r.feature ? r.feature : t('lic.f.' + r.feature);
    const st = r.state === 'expired' ? t('lic.expired', { to: r.to })
      : r.state === 'cancelled' ? t('lic.cancelled', { to: r.to })
      : r.to ? t('lic.active', { to: r.to }) : t('lic.activeNoEnd');
    return `<dt>${esc(name)}</dt><dd class="${r.state === 'active' ? 'ok' : 'warn'}">${esc(st)}</dd>`;
  }).join('');
  note.textContent = [rows.length ? '' : t('lic.none'), res.offline ? t('lic.offline') : '', res.verified === null ? t('lic.unverified') : '']
    .filter(Boolean).join(' ');
}

function renderDebug() {
  const s = state.status, rows = [];
  if (state.device) rows.push([t('dbg.device'), state.device.name]);
  if (state.fw) rows.push([t('dbg.firmware'), state.fw]);
  if (state.model) rows.push([t('dbg.model'), state.model]);
  if (state.serial) rows.push([t('dbg.serial'), state.serial]);
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
    if (state.diagAt) rows.push([t('dbg.diagRead'), state.diagAt.toLocaleTimeString(locale())]);
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
const CONNECT_TIMEOUT_MS = 15000;
function withTimeout(p, ms, what) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(what)), ms))]);
}

// Målere nettleseren allerede har gitt tilgang til (getDevices), uten enhetslista.
// Ikke alle nettlesere har getDevices; da brukes lista som før. Venter på en
// reklame (watchAdvertisements) før tilkobling, fordi måleren må være i nærheten.
const KNOWN_WAIT_MS = 6000;
let forceChooser = false;
async function findKnownDevice(wantId) {
  if (forceChooser || !navigator.bluetooth.getDevices) return null;
  let list;
  try { list = await navigator.bluetooth.getDevices(); } catch (e) { return null; }
  const id = wantId || store.get('lastDevId', null);
  const dev = list.find((d) => L.deviceId(d.name) === id) || (list.length === 1 && !wantId ? list[0] : null);
  if (!dev) return null;
  if (!dev.watchAdvertisements) return dev;
  const ac = new AbortController();
  try {
    const seen = new Promise((resolve) => dev.addEventListener('advertisementreceived', resolve, { once: true }));
    await dev.watchAdvertisements({ signal: ac.signal });
    renderConn('wait');
    await withTimeout(seen, KNOWN_WAIT_MS, t('err.notNear', { name: dev.name }));
    return dev;
  } catch (e) {
    const x = new Error(e.message); x.name = 'NotNear'; throw x;
  } finally { ac.abort(); }
}

async function connect(wantId) {
  if (state.demo) return demoConnect();
  if (typeof wantId !== 'string') wantId = null;
  connMsg('');
  // Måleren fra sist prøves først. Går det ikke, glemmes den, og neste trykk
  // åpner lista der måleren velges (Chrome kan ha gammel informasjon etter OTA).
  const reused = !!(state.device && !state.device.gatt.connected && (!wantId || state.devId === wantId));
  let known = false;
  try {
    let device = reused ? state.device : null;
    if (!device) { device = await findKnownDevice(wantId); known = !!device; }
    if (!device) device = await navigator.bluetooth.requestDevice({
      // Windows husker gjerne gammelt navn for samme MAC (0.4: "Doegngrader")
      filters: [{ namePrefix: 'DG-' }, { namePrefix: 'Doegngrader' }, { manufacturerData: [{ companyIdentifier: 0xffff }] }],
      optionalServices: [P.UUID.service, 'device_information', P.OTA_SERVICE, P.SET_SERVICE],
    });
    forceChooser = false;
    state.device = device;
    state.devId = L.deviceId(device.name);
    store.set('lastDevId', state.devId);
    device.removeEventListener('gattserverdisconnected', onDisconnected);
    device.addEventListener('gattserverdisconnected', onDisconnected);
    renderConn('wait');
    log(`Kobler til ${device.name}`);
    const server = await withTimeout(device.gatt.connect(), CONNECT_TIMEOUT_MS, t('err.timeout'));
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
      await readDiag();
    } catch (e) { state.chars.diag = null; state.diag = null; }
    try {
      const ota = await server.getPrimaryService(P.OTA_SERVICE);
      state.chars.ota = await ota.getCharacteristic(P.OTA_CHAR);
    } catch (e) { state.chars.ota = null; }
    try {
      const set = await server.getPrimaryService(P.SET_SERVICE);
      state.chars.set = await set.getCharacteristic(P.SET_CHAR);
      try { state.chars.cmd = await set.getCharacteristic(P.CMD_CHAR); } catch (e) { state.chars.cmd = null; }
      try {
        state.serial = P.parseSerial(await (await set.getCharacteristic(P.SERIAL_CHAR)).readValue());
        setDevInfo({ serial: state.serial });
      } catch (e) { state.serial = null; }
    } catch (e) { state.chars.set = null; state.chars.cmd = null; }
    refreshLicense();                     // venter ikke, nettet kan være tregt
    state.chars.status.addEventListener('characteristicvaluechanged', (ev) => onStatus(ev.target.value));
    onStatus(await state.chars.status.readValue());
    await state.chars.status.startNotifications();
    renderConn('on');
    connMsg('');
    $('btn-hist').disabled = false;
    log('Tilkoblet');
    startDiagPoll();
    await syncSettingsOnConnect();
    fetchHistory();   // trengs for periode, anslag og graf
  } catch (e) {
    log(`Feil: ${e.message}`);
    try { if (state.device && state.device.gatt.connected) state.device.gatt.disconnect(); } catch (x) { /* ingen forbindelse */ }
    gattLock = Promise.resolve();
    if (e.name === 'NotFoundError') connMsg('');          // brukeren lukket lista
    else if (reused || known || e.name === 'NotNear') {
      // neste trykk åpner lista (her er brukerens trykk allerede brukt opp)
      connMsg(t('err.reconnect', { name: (state.device && state.device.name) || 'måleren', msg: e.message }), true);
      state.device = null; forceChooser = true;
    }
    else connMsg(t('err.connect', { msg: e.message }), true);
    renderConn('off');
  }
}

// Melding om tilkobling, synlig øverst på forsiden (ikke bare i loggen)
function connMsg(text, failed) {
  const el = $('conn-msg');
  el.textContent = text || '';
  el.hidden = !text;
  el.classList.toggle('failed', !!failed);
}

// ---------- jevnlig kontakt mens tilkoblet ----------
// Hvert DIAG_POLL_MS leses diagnosen (OTA-vindu m.m., kan bare leses), og fra
// firmware 0.6.3 sendes «hold forbindelsen» (måleren kobler fra etter 10 min
// uten aktivitet). Når siden er skjult, stopper dette, og måleren kobler fra.
// gattQ: én GATT-operasjon om gangen fra appen (Chrome avviser samtidige).
const DIAG_POLL_MS = 15000;
let gattLock = Promise.resolve();
let diagTimer = null;

function gattQ(fn) {
  const p = gattLock.then(fn);
  gattLock = p.catch(() => {});
  return p;
}

function readDiag() {
  if (!state.chars.diag || !connected()) return Promise.resolve(state.diag);
  return gattQ(async () => {
    state.diag = P.parseDiag(await state.chars.diag.readValue());
    state.diagAt = new Date();
    return state.diag;
  });
}

function writeCmd(code) {
  return gattQ(() => state.chars.cmd.writeValueWithResponse(new Uint8Array([code])));
}

function keepaliveSupported() { return !!state.chars.cmd && P.fwNum(state.fw) >= P.fwNum('0.6.3'); }

function startDiagPoll() {
  stopDiagPoll();
  if (!state.chars.diag && !keepaliveSupported()) return;
  diagTimer = setInterval(async () => {
    if (!connected()) { stopDiagPoll(); return; }
    if (state.otaRunning || state.histBusy || document.hidden) return;
    try {
      await readDiag();
      if (keepaliveSupported()) await writeCmd(P.CMD_KEEPALIVE);
    } catch (e) { log(`Kontakt: ${e.message}`); return; }
    renderDebug();
    updateOtaButton();
  }, DIAG_POLL_MS);
}

function stopDiagPoll() {
  if (diagTimer) clearInterval(diagTimer);
  diagTimer = null;
}

function onDisconnected() {
  log('Frakoblet');
  $('conn-pop').hidden = true;    // vinduet med «Koble fra» gjelder bare tilkoblet måler
  gattLock = Promise.resolve();   // en operasjon som aldri fikk svar skal ikke sperre neste tilkobling
  state.otaDisconnected = true;
  renderConn('off');
  toggleConnPop(false);
  $('btn-hist').disabled = true;
  // diagnosen gjelder bare mens måleren er tilkoblet
  stopDiagPoll();
  state.diag = null; state.diagAt = null;
  renderDebug();
  render();             // instrumentene slukkes (verdiene er nå gamle), knapper som krever tilkobling skjules
  // ny periode krever tilkobling: skjul knappen og lukk spørsmålet
  $('btn-newp').hidden = true;
  if ($('confirm-newp').open) $('confirm-newp').close('cancel');
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

function histMsg(text) { $('hist-note').textContent = text; $('hist-status').textContent = text; }

async function fetchHistory() {
  if (state.demo) return demoHistory();
  if (state.histBusy || !connected()) return;
  state.histBusy = true;
  $('btn-hist').disabled = true;
  try {
    const info = await gattQ(async () => P.parseHistInfo(await state.chars.histInfo.readValue()));
    const readAt = Date.now();
    const count = info.next - info.oldest;
    if (count <= 0) { state.histInfo = info; histMsg(t('hist.empty')); return; }
    const got = [];
    await new Promise((resolve, reject) => {
      const ch = state.chars.histData;
      const timer = setTimeout(() => { cleanup(); reject(new Error(`${got.length}/${count}`)); }, HIST_TIMEOUT_MS);
      const onData = (ev) => {
        const p = P.parseHistPacket(ev.target.value);
        if (p.done) { cleanup(); resolve(); return; }
        got.push(...p.records);
        histMsg(t('hist.fetching', { n: got.length, total: count }));
        // Sluttpakken (0 poster) kan gå tapt, varsler kvitteres ikke. Ferdig når alle er mottatt.
        if (got.length >= count) { cleanup(); resolve(); }
      };
      const cleanup = () => { clearTimeout(timer); ch.removeEventListener('characteristicvaluechanged', onData); };
      ch.addEventListener('characteristicvaluechanged', onData);
      ch.startNotifications()
        .then(() => gattQ(() => state.chars.histCtl.writeValueWithResponse(P.buildHistRequest(info.oldest, count))))
        .catch((e) => { cleanup(); reject(e); });
    });
    state.histInfo = info;
    state.histReadAt = readAt;
    state.history = got.map((r) => ({ ...r, time: P.hourToTimeMs(r.hour, info, readAt) }));
    log(`Historikk: ${got.length} poster`);
    $('btn-csv').disabled = !got.length;
    render();
    $('hist-status').textContent = t('hist.got', { n: got.length });
  } catch (e) {
    log(`Historikk feilet: ${e.message}`);
    histMsg(t('hist.failed', { msg: e.message }));
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
    await readDiag();
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
    b.addEventListener('click', () => connect(m.id));
    li.appendChild(b);
    ul.appendChild(li);
  }
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

// Anslag med værvarsel for hovedtallet, null hvis varselet ikke er i bruk eller ikke hentet
function forecastEta(s) {
  const fc = state.fc;
  if (!s || !settings.fcOn || settings.use !== 'vilt' || settings.fcLat === null || !fc || !fc.series) return null;
  const now = Date.now();
  const outNow = L.forecastAt(fc.series, now);
  const offset = s.tempC !== null && outNow !== null ? s.tempC - outNow : 0;
  return { ...L.etaWithForecast(s.dg, settings.targetVilt, fc.series, offset, now), offset };
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
  const place = placeText();
  notes.push(t('fc.source', { time: fmtTime(new Date(fc.fetchedAt)), place: place || `${settings.fcLat}, ${settings.fcLon}` }));
  if (!place) loadPlaceName();
  $('fc-note').textContent = notes.join(' ');
}

// Stedsnavn for posisjonen fra Kartverket (bare Norge). MET-varselet har ikke stedsnavn.
let placeTriedFor = '';
async function loadPlaceName() {
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

function placeText() {
  const p = settings.fcPlace;
  if (!p || p.lat !== settings.fcLat || p.lon !== settings.fcLon) return null;
  return p.sted && p.kommune && p.sted !== p.kommune ? t('fc.near', { sted: p.sted, kommune: p.kommune }) : (p.sted || p.kommune);
}

function renderFcSettings() {
  $('fc-on').checked = !!settings.fcOn;
  const place = placeText();
  $('fc-pos').textContent = settings.fcLat === null ? t('fc.noPos')
    : place ? `${place} (${settings.fcLat}, ${settings.fcLon})` : t('fc.pos', { lat: settings.fcLat, lon: settings.fcLon });
  if (settings.fcLat !== null && !place) loadPlaceName();
}

function askPosition() {
  if (!navigator.geolocation) { $('fc-pos').textContent = t('fc.posFailed', { msg: 'geolocation' }); return; }
  navigator.geolocation.getCurrentPosition((p) => {
    const r = L.roundPos(p.coords.latitude, p.coords.longitude);
    settings.fcLat = r.lat; settings.fcLon = r.lon; settings.fcOn = true; settings.fcPlace = null; placeTriedFor = '';
    saveSettings(); state.fc = null;
    renderFcSettings(); render();
  }, (err) => { $('fc-pos').textContent = t('fc.posFailed', { msg: err.message }); }, { maximumAge: 3600e3, timeout: 20000 });
}

// ---------- ny periode fra appen (0.6.0) ----------
function newpMsg(text, failed) {
  const el = $('newp-msg');
  el.textContent = text || '';
  el.hidden = !text;
  el.classList.toggle('failed', !!failed);
}

function askNewPeriod() {
  newpMsg('');
  if (!connected() || !state.chars.cmd) { newpMsg(t('newp.notConnected'), true); render(); return; }
  const dlg = $('confirm-newp');
  $('newp-text').textContent = t('newp.text', { name: devInfo().name || (state.device ? state.device.name : '') });
  dlg.returnValue = '';
  dlg.showModal();
}

async function doNewPeriod() {
  if (!connected() || !state.chars.cmd) { newpMsg(t('newp.notConnected'), true); log(t('newp.notConnected')); render(); return; }
  try {
    await writeCmd(P.CMD_NEW_PERIOD);
    await new Promise((r) => setTimeout(r, 800));   // måleren måler og lagrer først
    if (!state.demo) onStatus(await state.chars.status.readValue());
    log(t('newp.done'));
    newpMsg(t('newp.done'), false);
    state.history = []; state.histInfo = null;
    fetchHistory();
  } catch (e) {
    log(t('newp.failed', { msg: e.message }));
    newpMsg(t('newp.failed', { msg: e.message }), true);
  }
}

// ---------- byggeinfo ----------
// Bunnlinja viser versjonen som KJØRER (version.js), ikke den som er publisert.
// checkAppUpdate sammenligner med build.json på nettsiden og tilbyr oppdatering.
function fmtBuild(iso) {
  const d = new Date(iso), p2 = (n) => String(n).padStart(2, '0');
  // kort: yymmdd tt:mm (lokal tid, 24 timer)
  return `${p2(d.getFullYear() % 100)}${p2(d.getMonth() + 1)}${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

async function fetchPublished() {
  const res = await fetch('build.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function loadBuildInfo() {
  const el = $('build');
  const year = new Date().getFullYear();
  let b = BUILD.commit !== 'dev' ? BUILD : null;
  if (!b) { try { b = await fetchPublished(); } catch (e) { b = null; } }
  el.textContent = b && b.built
    ? t('foot.build', { commit: b.commit, when: fmtBuild(b.built), year: new Date(b.built).getFullYear() })
    : t('foot.copy', { year });
  $('build-menu').textContent = el.textContent;
}

const UPDATE_CHECK_MS = 10 * 60 * 1000;
async function checkAppUpdate() {
  if (BUILD.commit === 'dev') return;
  try {
    const pub = await fetchPublished();
    const newer = pub.commit && pub.commit !== BUILD.commit;
    $('update-bar').hidden = !newer;
    if (newer) $('update-text').textContent = t('upd.text', { commit: pub.commit, when: fmtBuild(pub.built) });
  } catch (e) { /* uten nett: prøv igjen senere */ }
}

// Tøm bufferen, be service workeren hente seg selv på nytt, og last siden.
async function updateApp() {
  $('btn-update').disabled = true;
  try {
    if (window.caches) for (const k of await caches.keys()) await caches.delete(k);
    const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
    if (reg) await reg.update().catch(() => {});
  } catch (e) { log(`Oppdatering: ${e.message}`); }
  location.reload();
}

// ---------- OTA ----------
async function sha256hex(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Fra publiseringen 2026-11-22 har latest.json «file»: et versjonert filnavn
// (doegngrader-<versjon>-<sha12>.bin) som aldri endrer innhold. Eldre
// publiseringer har bare doegngrader.bin.
async function fetchLatestBin(latest) {
  const name = latest.file || 'doegngrader.bin';
  const res = await fetch(`firmware/${name}?v=${latest.sha256.slice(0, 12)}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const fw = new Uint8Array(await res.arrayBuffer());
  const sha = await sha256hex(fw);
  if (fw.length !== latest.size || sha !== latest.sha256) {
    log(`OTA: nedlastet ${fw.length} B, sha ${sha.slice(0, 12)}; forventet ${latest.size} B, sha ${latest.sha256.slice(0, 12)} (${name})`);
    throw new Error(t('ota.mismatch'));
  }
  return fw;
}

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
    const L = state.latest;
    const kb = Math.round(L.size / 1024), cur = state.fw || '?';
    el.textContent = L.built
      ? t('ota.latestBuilt', { v: L.version, kb, cur, when: fmtWhen(new Date(L.built)) })
      : t('ota.latest', { v: L.version, kb, cur });
    $('btn-ota-latest').textContent = state.fw === state.latest.version ? t('ota.reinstall', { v: state.latest.version }) : t('ota.update', { v: state.latest.version });
  } else {
    el.textContent = t('ota.latestMissing');
  }
  $('btn-ota-latest').hidden = !state.latest;
  // oppdateringsvinduet
  const d = state.diag, win = $('ota-win');
  if (!connected() || !d) win.textContent = '';
  else if (d.otaMinutesLeft || d.otaBusy) win.textContent = t('ota.winOpen', { min: d.otaMinutesLeft });
  else win.textContent = state.chars.cmd ? t('ota.winClosed') : t('ota.winOld');
  $('btn-ota-open').hidden = !(connected() && state.chars.cmd && d && !d.otaMinutesLeft && !d.otaBusy);
  if (connected() && !state.chars.ota && !state.demo) $('ota-status').textContent = t('ota.noOta');
}

async function runOta(source) {
  const st = $('ota-status'), bar = $('ota-progress');
  let fw;
  st.classList.remove('failed');
  try {
    if (source === 'latest') {
      // Hent latest.json på nytt rett før nedlasting. Siden kan ha vært åpen
      // mens ny firmware ble publisert, og da peker gammel info på feil fil.
      await loadLatestFirmware();
      if (!state.latest) throw new Error(t('ota.latestMissing'));
      st.textContent = t('ota.fetching', { v: state.latest.version });
      fw = await fetchLatestBin(state.latest);
    } else {
      fw = new Uint8Array(await $('ota-file').files[0].arrayBuffer());
    }
    P.validateFirmware(fw);
  } catch (e) { st.textContent = t('ota.badFile', { msg: e.message }); st.classList.add('failed'); return; }

  if (state.chars.diag) {
    await readDiag();
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
  state.fw = '0.6.3';
  state.serial = 'A4C1389DDE40';
  refreshLicense();
  state.diag = { capFlash: null, capUsed: false, runningFrom: 0x40000, otaMinutesLeft: 0, otaBusy: false };
  state.chars.cmd = { async writeValueWithResponse(b) {
    if (b[0] === P.CMD_OTA_OPEN) state.diag.otaMinutesLeft = 3;
    if (b[0] === P.CMD_KEEPALIVE) return;
    if (b[0] === P.CMD_NEW_PERIOD) {   // demo: ny periode
      const v = new DataView(new Uint8Array(21).buffer);
      const o = state.status;
      v.setUint8(0, 1); v.setUint8(1, 0x60); v.setUint16(2, 0, true); v.setInt16(4, Math.round(o.tempC * 100), true);
      v.setUint8(6, o.rh); v.setUint16(7, o.vbatMv, true); v.setUint8(9, 0); v.setUint32(10, 0, true);
      v.setUint16(14, o.period + 1, true);
      onStatus(v);
    }
  } };
  state.model = 'LYWSD03MMC B1.1';
  // innstillinger i «måleren», samme bytes som firmwaren
  let demoSet = P.buildSettings({ use: settings.use, targetDg: settings.targetVilt, targetDays: settings.targetDays, restBy: settings.restBy, smiley: !!settings.smiley });
  state.chars.set = {
    async writeValueWithResponse(b) { demoSet = new Uint8Array(b); },
    async readValue() { return new DataView(demoSet.buffer.slice(0)); },
  };
  demoHistory(false);
  const b = new Uint8Array(21), v = new DataView(b.buffer);
  const sum = Math.round(L.dgFromRecords(L.currentPeriod(state.history, state.histInfo.psHour).records) * 28800);
  v.setUint8(0, 1); v.setUint8(1, 0x60); v.setUint16(2, Math.floor(sum / 2880), true); v.setInt16(4, 612, true);
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
// ---------- lærebok og bruksanvisning inne i appen ----------
// Siden forlates ikke, så Bluetooth-forbindelsen og verdiene står når den lukkes.
function openReader(href) {
  const sep = href.includes('?') ? '&' : '?';
  const [path, hash] = href.split('#');
  const url = path.includes('lang=') ? path : `${path}${sep}lang=${settings.lang}`;
  $('reader-frame').src = hash ? `${url}#${hash}` : url;
  $('reader').showModal();
}
function closeReader() { if ($('reader').open) $('reader').close(); }

function init() {
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

  $('btn-settings').addEventListener('click', openSettings);
  $('btn-refresh').addEventListener('click', refreshAll);
  $('btn-newp').addEventListener('click', askNewPeriod);
  $('confirm-newp').addEventListener('close', () => { if ($('confirm-newp').returnValue === 'ok') doNewPeriod(); });
  for (const r of document.querySelectorAll('#settings input[name=use]')) r.addEventListener('change', (e) => { settings.use = e.target.value; applyUse(); applyTargetFields(); settingChanged(); });
  for (const r of document.querySelectorAll('#settings input[name=restby]')) r.addEventListener('change', (e) => { settings.restBy = e.target.value; applyTargetFields(); settingChanged(); });
  for (const b of document.querySelectorAll('#settings [data-step]')) {
    b.addEventListener('click', () => setTarget(b.dataset.step, Number($(b.dataset.step).value) + Number(b.dataset.d)));
  }
  for (const id of ['target-vilt', 'target-days']) $(id).addEventListener('change', (e) => setTarget(id, Number(e.target.value)));
  for (const r of document.querySelectorAll('#settings input[name=lang]')) r.addEventListener('change', (e) => { settings.lang = e.target.value; saveSettings(); buildGauges(); render(); loadBuildInfo(); refreshSettingsTexts(); });
  $('smiley-on').addEventListener('change', (e) => { settings.smiley = e.target.checked; settingChanged(); });
  $('graph').addEventListener('toggle', () => renderChart(period()));
  for (const a of document.querySelectorAll('a[data-reader]')) a.addEventListener('click', (e) => { e.preventDefault(); openReader(a.getAttribute('href')); });
  $('btn-reader-close').addEventListener('click', closeReader);
  // «← Appen» inne i læreboka og bruksanvisningen lukker vinduet
  addEventListener('message', (e) => { if (e.origin === location.origin && e.data === 'dg-close-reader') closeReader(); });
  $('fc-on').addEventListener('change', (e) => {
    settings.fcOn = e.target.checked; saveSettings();
    if (settings.fcOn && settings.fcLat === null) askPosition(); else render();
  });
  $('btn-fc-pos').addEventListener('click', askPosition);
  // Menyen lukkes med krysset eller Esc. Enter i et felt skal ikke lukke den.
  $('settings').querySelector('form').addEventListener('submit', (e) => e.preventDefault());
  $('btn-menu-close').addEventListener('click', () => $('settings').close());
  $('btn-hist').addEventListener('click', fetchHistory);
  $('btn-csv').addEventListener('click', downloadCsv);
  $('btn-ota').addEventListener('click', () => runOta('file'));
  $('btn-ota-open').addEventListener('click', async () => {
    try {
      await writeCmd(P.CMD_OTA_OPEN);
      await new Promise((r) => setTimeout(r, 400));   // måleren utfører kommandoen i neste runde
      await readDiag();
      log('Oppdateringsvinduet åpnet fra appen');
    } catch (e) { log(`Åpne vindu feilet: ${e.message}`); }
    updateOtaButton();
    renderDebug();
  });
  $('btn-ota-latest').addEventListener('click', () => runOta('latest'));
  $('btn-ota-check').addEventListener('click', async () => {
    const el = $('ota-checked'), before = state.latest ? state.latest.sha256 : null;
    el.textContent = t('ota.checking');
    await loadLatestFirmware();
    const time = new Date().toLocaleTimeString(locale());
    if (!state.latest) el.textContent = t('ota.checkedNone', { time });
    else if (before && before !== state.latest.sha256) el.textContent = t('ota.checkedNew', { time, v: state.latest.version });
    else el.textContent = t('ota.checkedSame', { time, v: state.latest.version });
  });
  $('ota-file').addEventListener('change', updateOtaButton);

  let rt;
  addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(render, 150); });
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  $('btn-update').addEventListener('click', updateApp);
  checkAppUpdate();
  setInterval(checkAppUpdate, UPDATE_CHECK_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkAppUpdate(); });

  renderConn('off');
  render();
  loadLatestFirmware();
  loadBuildInfo();
  if (state.demo) demoConnect();
}

init();
