// sync.js - lagring på serveren per måler (2026-11-23): navn, perioder, notater og historikk.
// Serveren: admin/dgadmin/data.py. Tilgang med koden på måleren (siste fire tegn i
// serienummeret). Uten nett legges endringer i en kø i nettleseren og sendes senere.
// Nettleseren er bare en buffer: det som står på serveren og i måleren, gjelder.
import * as LIC from './license.js';
import * as P from './protocol.js';
import { $, devInfo, fmt, fmtDay, log, setDevInfo, settings, state, store, t } from './core.js';

const QKEY = 'sync.q';
const BATCH = 2000;
let flushing = false;
let noteTimer = 0, nameTimer = 0;

const base = (serial) => { const c = LIC.config(); return c ? `${c.server}/api/v1/data/${serial}` : null; };
const kode = (serial) => serial.slice(-4);
export const syncOn = () => !!(LIC.config() && state.serial && !state.demo);

// ---------- kø ----------
function queue() { return store.get(QKEY, []); }
function enqueue(serial, path, body, key) {
  let q = queue();
  if (key) q = q.filter((x) => x.key !== `${serial}:${key}`);   // bare siste versjon av navn og notat
  q.push({ serial, path, body, key: key ? `${serial}:${key}` : null });
  store.set(QKEY, q);
  flush();
}

export async function flush() {
  if (flushing || !navigator.onLine) return;
  flushing = true;
  try {
    let q = queue();
    while (q.length) {
      const it = q[0], url = base(it.serial);
      if (!url) break;
      let res;
      try {
        res = await fetch(url + it.path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kode: kode(it.serial), ...it.body }) });
      } catch (e) { break; }                       // uten nett: prøv igjen senere
      if (res.status === 429 || res.status >= 500) break;
      if (!res.ok) log(`Lagring på serveren avvist (${res.status}) ${it.path}`);
      q = queue().slice(1);                        // sendt eller avvist for godt
      store.set(QKEY, q);
    }
  } finally { flushing = false; }
}
window.addEventListener('online', () => flush());

// ---------- etter tilkobling: hent navn, perioder og notater ----------
export async function pullOverview() {
  if (!syncOn()) return;
  const serial = state.serial;
  try {
    const res = await fetch(`${base(serial)}?kode=${kode(serial)}`, { cache: 'no-store' });
    if (!res.ok) { log(`Henting fra serveren: ${res.status}`); return; }
    const d = await res.json();
    if (state.serial !== serial) return;          // byttet måler i mellomtiden
    state.server = d;
    const local = devInfo().name || '';
    if (d.name && d.name !== local) { setDevInfo({ name: d.name }); $('dev-name').value = d.name; }
    else if (!d.name && local) pushName(local);
    renderPeriods();
  } catch (e) { log(`Henting fra serveren feilet: ${e.message}`); }
}

// ---------- navn ----------
export function pushName(name) {
  if (!syncOn()) return;
  const serial = state.serial;
  clearTimeout(nameTimer);
  nameTimer = setTimeout(() => enqueue(serial, '/navn', { name }, 'navn'), 1000);
}

// ---------- periode og historikk, etter at historikken er hentet ----------
const isoHour = (ms) => new Date(Math.floor(ms / 3600e3) * 3600e3).toISOString().replace(/\.\d{3}Z$/, 'Z');

export function currentPeriodBody() {
  const st = state.status;
  if (!st) return null;
  const byDays = settings.use === 'restaurant' && settings.restBy !== 'dg';
  const startMs = P.periodStartMs(state.histInfo, state.histReadAt);
  return {
    period: st.period,
    started_at: startMs ? new Date(startMs).toISOString().replace(/\.\d{3}Z$/, 'Z') : null,
    mode: settings.use === 'restaurant' ? 'restaurant' : 'vilt',
    target: byDays ? settings.targetDays : settings.targetVilt,
    unit: byDays ? 'dager' : 'dg',
    value: Math.round(st.dg * 100) / 100,
  };
}

export function pushAfterHistory() {
  if (!syncOn() || state.locked) return;
  const serial = state.serial;
  let done = devInfo().syncedHour ?? -1;
  // timetelleren i måleren startet på nytt (tømt flash): last opp alt igjen
  if (state.histInfo && state.histInfo.next - 1 < done) done = -1;
  const rows = state.history.filter((r) => r.hour > done).map((r) => [r.hour, isoHour(r.time),
    r.tempC === null ? null : Math.round(r.tempC * 10), r.rh === null ? null : r.rh, r.flags & 127]);
  for (let i = 0; i < rows.length; i += BATCH) enqueue(serial, '/historikk', { rows: rows.slice(i, i + BATCH) });
  if (rows.length) setDevInfo({ syncedHour: rows[rows.length - 1][0] });
  const p = currentPeriodBody();
  if (p) enqueue(serial, '/periode', p, `periode${p.period}`);
}

// ---------- notat og vekt for perioden som pågår ----------
function curPeriodData() {
  const n = state.status ? state.status.period : null;
  return (state.server && state.server.periods || []).find((p) => p.period === n) || null;
}

function num(id) { const v = parseFloat($(id).value.replace(',', '.')); return Number.isFinite(v) && v >= 0 ? v : null; }

function noteChanged() {
  if (!syncOn() || !state.status) return;
  const serial = state.serial, period = state.status.period;
  const body = { period, note: $('per-note').value, weight_in: num('per-win'), weight_out: num('per-wout') };
  if (state.server) {
    const p = curPeriodData();
    if (p) Object.assign(p, body); else (state.server.periods = state.server.periods || []).unshift({ ...body, ended: false });
  }
  renderShrink();
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => enqueue(serial, '/notat', body, `notat${period}`), 800);
}

function shrinkText(win, wout) {
  if (!win || wout === null || wout === undefined) return '';
  return t('per.shrink', { pct: fmt((win - wout) / win * 100) });
}

function renderShrink() { $('per-shrink').textContent = shrinkText(num('per-win'), num('per-wout')); }

export function initSync() {
  for (const id of ['per-note', 'per-win', 'per-wout']) $(id).addEventListener('input', noteChanged);
}

// Notatfeltene og lista over tidligere perioder (under «Perioden» i menyen)
export function renderPeriods() {
  const on = syncOn() && !state.locked && state.status;
  $('per-store').hidden = !on;
  if (!on) return;
  const p = curPeriodData();
  // ikke overskriv det brukeren skriver
  if (document.activeElement !== $('per-note')) $('per-note').value = p ? p.note || '' : '';
  if (document.activeElement !== $('per-win')) $('per-win').value = p && p.weight_in !== null && p.weight_in !== undefined ? String(p.weight_in).replace('.', ',') : '';
  if (document.activeElement !== $('per-wout')) $('per-wout').value = p && p.weight_out !== null && p.weight_out !== undefined ? String(p.weight_out).replace('.', ',') : '';
  renderShrink();
  const old = (state.server && state.server.periods || []).filter((x) => x.ended);
  const ul = $('per-old');
  ul.innerHTML = '';
  $('per-old-h').hidden = !old.length;
  for (const x of old) {
    const li = document.createElement('li');
    const head = document.createElement('strong');
    head.textContent = x.started_at ? fmtDay(new Date(x.started_at)) : t('per.unknownStart');
    const val = document.createElement('span');
    const parts = [];
    if (x.value !== null && x.value !== undefined) parts.push(`${fmt(x.value)} ${t('per.dg')}`);
    if (x.mode) parts.push(t(x.mode === 'restaurant' ? 'per.rest' : 'per.vilt'));
    const sh = shrinkText(x.weight_in, x.weight_out);
    if (sh) parts.push(sh);
    val.textContent = parts.join(' · ');
    li.append(head, val);
    if (x.note) { const n = document.createElement('p'); n.textContent = x.note; li.append(n); }
    ul.append(li);
  }
}
