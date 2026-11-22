// subscription.js - abonnement: lisenssjekk, låsing og tilbakestilling (license.js, versjon 2)
// Del av appen (app.js). Delt ut fra app.js 2026-11-22, funksjonene er uendret.
import * as P from './protocol.js';
import * as LIC from './license.js';
import { gattQ } from './ble.js';
import { $, connected, fmtWhen, log, saveSettings, settings, state, t, withTimeout } from './core.js';
import { fetchHistory } from './history.js';
import { applyUse } from './settingsui.js';
import { render } from './view.js';

// ---------- abonnement (license.js, versjon 2) ----------
// Appen er betalt: med prøveperiode eller abonnement er alt åpent. Uten lisens
// (body.locked) skjules målingene; demo og firmwareoppdatering er åpne.
// Av til SERVER og PUBKEY er satt i license.js; da er appen åpen som før.
export const LIC_FETCH_MS = 8000;
export function licEnabled() { return !!LIC.config() && (!state.demo || state.demoLic); }
export function licAccess() { return state.lic && state.lic.doc ? LIC.access(state.lic.doc) : null; }

export function applyLock() {
  const acc = licAccess();
  const wasLocked = !!state.locked;
  state.locked = licEnabled() && !!state.device && !(acc && acc.ok);
  document.body.classList.toggle('locked', state.locked);
  if (state.serial && acc && acc.ok) LIC.markAccess(state.serial);
  renderLock(acc);
  if (wasLocked && !state.locked) { render(); if (connected()) fetchHistory(); }
}

export function renderLock(acc) {
  const dg = state.devId ? `DG\u2011${state.devId}` : t('lock.thisMeter');   // hindrer linjeskift i DG-ID
  const st = state.lic && state.lic.doc ? state.lic.doc.status : null;
  let text;
  if (!state.serial) text = t('lock.noSerial');
  else if (!state.lic || (!state.lic.doc && state.lic.offline)) text = t('lock.noData', { dg });
  else if (st === 'bestilt') text = t('lock.pending', { dg });
  else text = t('lock.need', { dg });
  $('lock-text').textContent = text;
  const url = state.serial ? LIC.orderUrl(state.serial) : null;
  $('lock-order').hidden = !url || st === 'bestilt';
  if (url) $('lock-order').href = url;
  // prøveperiode: én linje på forsiden med lenke til bestilling
  const line = $('lic-line');
  if (acc && acc.ok && acc.kind === 'trial' && url) {
    line.innerHTML = '';
    line.append(t('lic.trialLine', { when: fmtWhen(acc.until) }) + ' ');
    const a = document.createElement('a');
    a.href = url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = t('lic.order');
    line.append(a);
    line.hidden = false;
  } else line.hidden = true;
}

// Etter tilkobling: hent lisens (eller lagret svar uten nett), lås eller åpne.
export async function checkLicense() {
  const cfg = LIC.config(), sec = $('lic-sec');
  sec.hidden = !licEnabled();
  if (!licEnabled()) { state.lic = null; applyLock(); return; }
  $('lic-minside').href = cfg.minside;
  const serial = state.serial;
  let res = null;
  if (serial) {
    const fetchT = (u, o) => withTimeout(fetch(u, o), LIC_FETCH_MS, 'tidsavbrudd');
    try { res = await LIC.load(serial, state.fw || '', fetchT); } catch (e) { res = null; }
    if (serial !== state.serial) return;    // byttet måler i mellomtiden
  }
  state.lic = res;
  applyLock();
  renderLicense();
}

export function renderLicense() {
  const list = $('lic-list'), note = $('lic-note');
  const url = state.serial ? LIC.orderUrl(state.serial) : null;
  $('lic-order').hidden = !url;
  if (url) $('lic-order').href = url;
  list.innerHTML = '';
  if (!state.serial) { note.textContent = t('lic.noSerial'); return; }
  const res = state.lic;
  if (!res || (!res.doc && res.offline)) { note.textContent = t('lic.error'); return; }
  if (res.verified === false) { note.textContent = t('lic.bad'); return; }
  const d = res.doc, acc = licAccess();
  const rows = [[t('lic.status'), acc && acc.ok ? t('lic.st.' + (acc.kind === 'sub' ? 'aktiv' : 'prove')) : t('lic.st.' + (d.status === 'bestilt' ? 'bestilt' : 'utlopt'))]];
  if (acc && acc.kind === 'trial') rows.push([t('lic.until'), fmtWhen(acc.until)]);
  if (d.sub_to) rows.push([t('lic.subTo'), d.sub_to]);
  if (acc && acc.kind === 'sub') rows.push([t('lic.renew'), d.renew ? t('lic.yes') : t('lic.no')]);
  const esc = (v) => String(v).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  list.innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  note.textContent = [res.offline ? t('lic.offline') : '', res.verified === null ? t('lic.unverified') : ''].filter(Boolean).join(' ');
}

// Første tilkobling etter at tilgangen er ute: kunden velger modus uten app.
// Fabrikkmål, telling i dager, smilefjes av. Perioden nullstilles ikke.
export async function maybeResetAfterExpiry() {
  if (!state.locked || !state.serial || !state.chars.set) return;
  if (!LIC.hadAccess(state.serial) || LIC.resetDone(state.serial)) return;
  if (state.lic && state.lic.doc && state.lic.doc.status === 'bestilt') return;   // venter på godkjenning
  $('reset-text').textContent = t('reset.text', { dg: `DG-${state.devId}` });
  const dlg = $('expired-reset');
  const use = await new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue), { once: true });
    dlg.showModal();
  });
  if (use !== 'vilt' && use !== 'restaurant') return;        // lukket: spør igjen neste gang
  const want = { use, targetDg: 40, targetDays: 28, restBy: 'days', smiley: false };
  try {
    await gattQ(() => state.chars.set.writeValueWithResponse(P.buildSettings(want)));
    LIC.markReset(state.serial);
    Object.assign(settings, { use, targetVilt: 40, targetDays: 28, restBy: 'days', smiley: false, pendingSync: false });
    saveSettings();
    applyUse();
    log(`Tilbakestilt etter utløp: ${use}, fabrikkmål, smilefjes av`);
  } catch (e) { log(`Tilbakestilling feilet: ${e.message}`); }
}
