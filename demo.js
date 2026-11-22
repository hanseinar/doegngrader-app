// demo.js - demo (?demo, nevnes i bruksanvisningen; ?demo&demolic tester abonnement)
// Del av appen (app.js). Delt ut fra app.js 2026-11-22, funksjonene er uendret.
import * as P from './protocol.js';
import * as L from './logic.js';
import { onDisconnected, onStatus } from './ble.js';
import { $, connected, settings, state } from './core.js';
import { syncSettingsOnConnect } from './settingsui.js';
import { checkLicense, maybeResetAfterExpiry } from './subscription.js';
import { render, renderConn } from './view.js';

// ---------- demo (?demo, nevnes i bruksanvisningen) ----------
export function demoConnect() {
  state.device = { name: 'DG-DE40', gatt: { connected: true, disconnect() { this.connected = false; onDisconnected(); } } };
  state.devId = 'DE40';
  state.fw = '0.6.5';
  state.serial = 'A4C1389DDE40';
  state.diag = { capFlash: null, capUsed: false, runningFrom: 0x40000, otaMinutesLeft: 0, otaBusy: false };
  state.chars.cmd = { async writeValueWithResponse(b) {
    if (b[0] === P.CMD_OTA_OPEN) state.diag.otaMinutesLeft = 3;
    if (b[0] === P.CMD_KEEPALIVE) return;
    if (b[0] === P.CMD_NEW_PERIOD) {   // demo: ny periode
      const v = new DataView(new Uint8Array(21).buffer);
      const o = state.status;
      v.setUint8(0, 1); v.setUint8(1, 0x65); v.setUint16(2, 0, true); v.setInt16(4, Math.round(o.tempC * 100), true);
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
  v.setUint8(0, 1); v.setUint8(1, 0x65); v.setUint16(2, Math.floor(sum / 2880), true); v.setInt16(4, 612, true);
  v.setUint8(6, 82); v.setUint16(7, 2931, true); v.setUint8(9, 61); v.setUint32(10, sum, true);
  v.setUint16(14, 14, true); v.setUint16(16, 7843, true); v.setUint16(18, 47012, true);
  renderConn('on');
  $('btn-hist').disabled = false;
  onStatus(v);
  checkLicense().then(async () => {
    if (state.locked) { await maybeResetAfterExpiry(); render(); return; }
    await syncSettingsOnConnect();
    render();
  });
}

export function demoHistory(draw = true) {
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
