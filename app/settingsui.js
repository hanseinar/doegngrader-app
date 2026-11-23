// settingsui.js - innstillinger: dialog og lagring i måleren (fra firmware 0.5.5)
// Del av appen (app.js). Delt ut fra app.js 2026-11-22, funksjonene er uendret.
import * as P from './protocol.js';
import { gattQ } from './ble.js';
import { $, devInfo, connected, log, saveSettings, settings, state, t } from './core.js';
import { renderFcSettings } from './forecast.js';
import { buildGauges, render } from './view.js';

export function applyUse() {
  document.body.dataset.use = settings.use;
  // samme farger for vilt og restaurant (fra 2.4), skalaene følger bruken
  buildGauges();
}

// Smilefjes ved mål finnes fra firmware 0.6.3. Ukjent firmware (ikke tilkoblet): tillatt.
export const SMILEY_FW = '0.6.3';
export function smileySupported() { return !state.fw || P.fwNum(state.fw) >= P.fwNum(SMILEY_FW); }

// ---------- innstillinger: dialog og lagring i måleren (fra firmware 0.5.5) ----------
export const LIMITS = { 'target-vilt': P.SET_LIMITS.dg, 'target-days': P.SET_LIMITS.days };
export const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, Math.round(v)));

export function renderSync() {
  const el = $('set-sync');
  el.classList.toggle('bad', state.setState === 'failed');
  // «Lagret i måleren» vises ikke (2026-11-22), bare det brukeren må vite
  el.textContent = {
    saving: t('settings.saving'),
    pending: t('settings.pending'),
    old: t('settings.old'),
    failed: t('settings.failed', { msg: state.setError }),
  }[state.setState] || '';
}

// Fyll feltene i dialogen fra innstillingene (ved åpning og når måleren er endret)
function fillSettingsFields() {
  const dlg = $('settings');
  for (const r of dlg.querySelectorAll('input[name=use]')) r.checked = r.value === settings.use;
  for (const r of dlg.querySelectorAll('input[name=lang]')) r.checked = r.value === settings.lang;
  for (const r of dlg.querySelectorAll('input[name=restby]')) r.checked = r.value === settings.restBy;
  $('smiley-on').checked = !!settings.smiley;
  $('target-vilt').value = settings.targetVilt;
  $('target-days').value = settings.targetDays;
  refreshSettingsTexts();
}

export function openSettings() {
  fillSettingsFields();
  // navnet gjelder måleren som er valgt (lagres også på serveren, sync.js)
  $('name-field').hidden = !state.devId;
  $('dev-name').value = devInfo().name || '';
  renderFcSettings();
  $('settings').showModal();
}

// Leses jevnlig mens tilkoblet: modus kan være byttet med binderset (0.6.4).
// Ikke mens en endring fra appen venter på å bli skrevet.
export async function pollSettings() {
  if (!state.chars.set || settings.pendingSync || syncTimer || state.setState === 'saving') return;
  const m = await gattQ(async () => P.parseSettings(await state.chars.set.readValue()));
  if (syncTimer || state.setState === 'saving') return;          // brukeren endret noe i mellomtiden
  const smiley = smileySupported() ? m.smiley : settings.smiley;
  if (m.use === settings.use && m.targetDg === settings.targetVilt && m.targetDays === settings.targetDays
      && m.restBy === settings.restBy && smiley === settings.smiley) return;
  const useChanged = m.use !== settings.use;
  Object.assign(settings, { use: m.use, targetVilt: m.targetDg, targetDays: m.targetDays, restBy: m.restBy, smiley });
  saveSettings();
  if (useChanged) applyUse();
  if ($('settings').open) fillSettingsFields();
  log(`Innstillinger endret på måleren: ${m.use}, ${m.targetDg} dg, ${m.targetDays} dager`);
  render();
}

// Tekster i dialogen som avhenger av språk og firmware
export function refreshSettingsTexts() {
  $('smiley-on').disabled = !smileySupported();
  $('smiley-help').textContent = smileySupported() ? t('settings.smileyHelp') : t('settings.smileyOld', { v: SMILEY_FW });
  applyTargetFields();
  renderSync();
}

// Hvilket mål som vises: døgngrader for vilt og for restaurant med døgngrader, ellers dager.
// Målet i døgngrader er det samme feltet i måleren for vilt og restaurant.
export function applyTargetFields() {
  const byDays = settings.use === 'restaurant' && settings.restBy !== 'dg';
  $('fs-dg').hidden = byDays;
  $('fs-days').hidden = !byDays;
  $('help-dg').textContent = t(settings.use === 'restaurant' ? 'settings.targetHelpRestDg' : 'settings.targetHelpVilt');
}

// Endring i dialogen: lagres her med en gang, i måleren litt etter (samler raske trykk).
export let syncTimer = 0;
export function settingChanged() {
  saveSettings();
  render();
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { syncTimer = 0; writeMeterSettings(); }, 700);
}

export function setTarget(id, v) {
  const val = clamp(v, LIMITS[id]);
  if (!Number.isFinite(val)) return;
  $(id).value = val;
  if (id === 'target-vilt') settings.targetVilt = val; else settings.targetDays = val;
  settingChanged();
}

export async function writeMeterSettings() {
  if (state.locked) return;                // uten lisens skriver appen ingen innstillinger
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
export async function syncSettingsOnConnect() {
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
