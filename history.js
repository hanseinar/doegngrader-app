// history.js - historikk per time: henting, CSV, les på nytt
// Del av appen (app.js). Delt ut fra app.js 2026-11-22, funksjonene er uendret.
import * as P from './protocol.js';
import { gattQ, onStatus, readDiag } from './ble.js';
import { $, connected, HIST_TIMEOUT_MS, log, settings, state, t } from './core.js';
import { demoHistory } from './demo.js';
import { syncSettingsOnConnect } from './settingsui.js';
import { render } from './view.js';

export function histMsg(text) { $('hist-note').textContent = text; $('hist-status').textContent = text; }

export async function fetchHistory() {
  if (state.locked) return;
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

export function downloadCsv() {
  const lines = ['tid;time_nr;temperatur_c;fuktighet_pst;status'];
  for (const r of state.history) lines.push([new Date(r.time).toISOString(), r.hour, r.tempC ?? '', r.rh ?? '', P.flagNames(r.flags, P.HIST_FLAGS).join(',')].join(';'));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([lines.join('\r\n') + '\r\n'], { type: 'text/csv' }));
  a.download = `${state.device?.name || 'dg'}-historikk.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// «Les på nytt» erstatter sveip ned (som laster siden på nytt og kobler fra).
export async function refreshAll() {
  if (state.demo) { demoHistory(); return; }
  if (!connected()) return;
  try {
    onStatus(await state.chars.status.readValue());
    await readDiag();
    if (state.chars.set && !settings.pendingSync) await syncSettingsOnConnect();
  } catch (e) { log(`Les på nytt: ${e.message}`); }
  fetchHistory();
}
