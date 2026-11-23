// view.js - visning: forside, instrumenter, graf, detaljer, oversikt over målere
// Del av appen (app.js). Delt ut fra app.js 2026-11-22, funksjonene er uendret.
import * as P from './protocol.js';
import * as L from './logic.js';
import { connect } from './ble.js';
import { $, applyTexts, connected, devInfo, fmt, fmtDay, fmtRh, fmtT, fmtTime, fmtWhen, locale, settings, state, store, t } from './core.js';
import { forecastEta, renderForecast } from './forecast.js';
import { updateOtaButton } from './ota.js';
import * as LIC from './license.js';
import { licEnabled, licStatus, openOrder, orderTextFor } from './order.js';
import { renderPeriods } from './sync.js';

export function renderConn(phase) {
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

export function toggleConnPop(show) {
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

// ---------- instrumenter: temperatur, fuktighet, duggpunkt ----------
// Børstet aluminium. Opplyst når måleren er tilkoblet, mørke ellers (gamle verdier).
// Vilt: rødt fra 15 °C (insekter) og fra 90 % (kondens). Restaurant: grønne bånd for målområdet.
export const G_TEMP = [-10, 30], G_DEW = [-10, 20];
export const frac = ([lo, hi], v) => (v - lo) / (hi - lo);
export let gauges = null;
export function buildGauges() {
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
export function setGauges() {
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
export function period() {
  const info = state.histInfo;
  const p = L.currentPeriod(state.history, info ? info.psHour : null);
  let start = P.periodStartMs(info, state.histReadAt);
  if (start === null && info && p.complete && p.records.length) start = p.records[0].time - 3600e3;
  const hours = start !== null ? Math.max(0, (Date.now() - start) / 3600e3) : null;
  return { ...p, hours, start };
}

// Råd -> kapittel i læreboka (laerebok/index.html)
export const BOOK_ANCHOR = {
  'adv.v.coldShort': 'forste', 'adv.v.flies': 'fluer', 'adv.v.avg15': 'temp', 'adv.v.avg10': 'temp',
  'adv.v.condense': 'fukt', 'adv.v.done': 'lengde', 'adv.frost': 'dg',
  'adv.r.warm': 'restaurant', 'adv.r.wet': 'restaurant', 'adv.r.dry': 'restaurant',
};

// ---------- visning ----------
export function render() {
  applyTexts();
  if (!connected()) renderConn('off');   // pilleteksten styres her, ikke av data-t
  const s = state.status;
  renderMeters();
  renderPeriods();
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

export function renderVilt(s, per, avg24) {
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

export function renderRestaurant(s, per) {
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

export function renderChart(per) {
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
    // rett etter ny periode kan den nye delen være tom (timen er ikke lagret ennå)
    if (newR.length) s += `<line class="mark" x1="${x(newR[0].time)}" x2="${x(newR[0].time)}" y1="${T}" y2="${H - B}"/>`;
  }
  s += `<path class="h" d="${line(newR, (r) => r.rh, yh)}"/><path class="t" d="${line(newR, (r) => r.tempC, y)}"/>`;
  svg.innerHTML = s;
  $('hist-note').textContent = t('hist.summary', { hours: per.records.length, dg: fmt(L.dgFromRecords(per.records)) });
}

export function renderDebug() {
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

// ---------- oversikt over målere (lagret i nettleseren) ----------
export function knownMeters() {
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      const m = /^dg\.dev\.([0-9A-F]{4})$/.exec(k || '');
      if (m) out.push({ id: m[1], ...store.get('dev.' + m[1], {}) });
    }
  } catch (e) { /* ingen lagring */ }
  // Uten lisens slettes verdiene (subscription.js), men måleren vises med status når lisens er på.
  const lic = licEnabled();
  return out.filter((m) => m.last || (lic && m.serial))
    .sort((a, b) => (b.last ? b.last.at : 0) - (a.last ? a.last.at : 0));
}

export function renderMeters() {
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
    b.append(L1, L2);
    if (m.last) {
      const L3 = document.createElement('span'); L3.className = 'mc-vals';
      L3.textContent = [`${fmt(Math.floor(m.last.dg * 10) / 10)} dg`, m.last.tempC !== null ? fmtT(m.last.tempC) : null, m.last.rh !== null ? fmtRh(m.last.rh) : null].filter(Boolean).join('  ·  ');
      const L4 = document.createElement('span'); L4.className = 'mc-when'; L4.textContent = t('meters.last', { when: fmtWhen(new Date(m.last.at)) });
      b.append(L3, L4);
    }
    const st = licEnabled() ? licStatus(LIC.stored(m.serial)) : null;
    if (st) { const L5 = document.createElement('span'); L5.className = `mc-lic ${st.cls}`; L5.textContent = st.text; b.append(L5); }
    b.addEventListener('click', () => connect(m.id));
    li.appendChild(b);
    ul.appendChild(li);
  }
  // Bestill eller forleng for alle målerne telefonen kjenner (én e-post)
  $('meters-order').hidden = !(licEnabled() && orderTextFor(list));
  $('meters-order').onclick = () => openOrder(list);
}

// ---------- oppstart ----------
// ---------- lærebok og bruksanvisning inne i appen ----------
// Siden forlates ikke, så Bluetooth-forbindelsen og verdiene står når den lukkes.
export function openReader(href) {
  const sep = href.includes('?') ? '&' : '?';
  const [path, hash] = href.split('#');
  const url = path.includes('lang=') ? path : `${path}${sep}lang=${settings.lang}`;
  $('reader-frame').src = hash ? `${url}#${hash}` : url;
  $('reader').showModal();
}
export function closeReader() { if ($('reader').open) $('reader').close(); }
