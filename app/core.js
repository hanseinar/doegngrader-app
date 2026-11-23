// core.js - felles tilstand, lagring, tekst og tall, logg
// Del av appen (app.js). Delt ut fra app.js 2026-11-22, funksjonene er uendret.
import { translate, pickLang } from './i18n.js';

export const HIST_TIMEOUT_MS = 60000;
export const $ = (id) => document.getElementById(id);

// ---------- lagring i nettleseren ----------
export const store = {
  get(k, d) { try { const v = localStorage.getItem('dg.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('dg.' + k, JSON.stringify(v)); } catch (e) { /* privat modus o.l. */ } },
};

export const settings = Object.assign(
  { use: 'vilt', lang: null, targetVilt: 40, targetDays: 28, restBy: 'days', smiley: false, pendingSync: false,
    fcOn: false, fcLat: null, fcLon: null, fcPlace: null },
  store.get('settings', {}),
);
settings.lang = pickLang(settings.lang, navigator.languages || [navigator.language]);

export const state = {
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
  // ?demo&demolic: demo med lisenssjekk, for test av abonnement uten Bluetooth
  demoLic: new URLSearchParams(location.search).has('demolic'),
};

// ---------- tekst og tall ----------
export const t = (key, vars) => translate(settings.lang, key, vars);
export const locale = () => (settings.lang === 'nb' ? 'nb-NO' : 'en-GB');
export const fmt = (v, d = 1) => new Intl.NumberFormat(locale(), { minimumFractionDigits: d, maximumFractionDigits: d }).format(v);
export const fmtT = (v) => `${fmt(v)} °C`;
export const fmtRh = (v) => `${Math.round(v)} %`;
export const fmtWhen = (d) => new Intl.DateTimeFormat(locale(), { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(d);
export const fmtDay = (d) => new Intl.DateTimeFormat(locale(), { weekday: 'long', day: 'numeric', month: 'long' }).format(d);
export const fmtTime = (d) => d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });

export function applyTexts() {
  document.documentElement.lang = settings.lang === 'nb' ? 'nb' : 'en';
  document.title = t('app.title');
  for (const el of document.querySelectorAll('[data-t]')) el.textContent = t(el.dataset.t);
  for (const el of document.querySelectorAll('[data-t-label]')) el.setAttribute('aria-label', t(el.dataset.tLabel));
  for (const el of document.querySelectorAll('[data-t-ph]')) el.setAttribute('placeholder', t(el.dataset.tPh));
}

export function log(msg) {
  const el = $('log');
  el.textContent = `${new Date().toLocaleTimeString(locale())} ${msg}\n` + el.textContent.slice(0, 20000);
}

// ---------- innstillinger og modus ----------
export function saveSettings() { store.set('settings', settings); }

// ---------- tilkoblingspille ----------
export function connected() { return !!(state.device && state.device.gatt && state.device.gatt.connected); }

export function devInfo() { return state.devId ? store.get('dev.' + state.devId, {}) : {}; }
export function setDevInfo(patch) { if (state.devId) store.set('dev.' + state.devId, Object.assign(devInfo(), patch)); }

export function withTimeout(p, ms, what) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(what)), ms))]);
}
