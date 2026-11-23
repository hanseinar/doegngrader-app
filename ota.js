// ota.js - firmwareoppdatering (OTA) og versjon av appen
// Del av appen (app.js). Delt ut fra app.js 2026-11-22, funksjonene er uendret.
import * as P from './protocol.js';
import { BUILD } from './version.js';
import { readDiag } from './ble.js';
import { $, connected, fmtWhen, log, state, t } from './core.js';
import { renderDebug } from './view.js';

// ---------- byggeinfo ----------
// Bunnlinja viser versjonen som KJØRER (version.js), ikke den som er publisert.
// checkAppUpdate sammenligner med build.json på nettsiden og tilbyr oppdatering.
export function fmtBuild(iso) {
  const d = new Date(iso), p2 = (n) => String(n).padStart(2, '0');
  // kort: yymmdd tt:mm (lokal tid, 24 timer)
  return `${p2(d.getFullYear() % 100)}${p2(d.getMonth() + 1)}${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

export async function fetchPublished() {
  const res = await fetch('build.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function loadBuildInfo() {
  const el = $('build');
  const year = new Date().getFullYear();
  let b = BUILD.commit !== 'dev' ? BUILD : null;
  if (!b) { try { b = await fetchPublished(); } catch (e) { b = null; } }
  el.textContent = b && b.built
    ? t('foot.build', { commit: b.commit, when: fmtBuild(b.built), year: new Date(b.built).getFullYear() })
    : t('foot.copy', { year });
  $('build-menu').textContent = el.textContent;
}

export const UPDATE_CHECK_MS = 10 * 60 * 1000;
export async function checkAppUpdate() {
  if (BUILD.commit === 'dev') return;
  try {
    const pub = await fetchPublished();
    const newer = pub.commit && pub.commit !== BUILD.commit;
    $('update-bar').hidden = !newer;
    if (newer) $('update-text').textContent = t('upd.text', { commit: pub.commit, when: fmtBuild(pub.built) });
  } catch (e) { /* uten nett: prøv igjen senere */ }
}

// Tøm bufferen, be service workeren hente seg selv på nytt, og last siden.
export async function updateApp() {
  $('btn-update').disabled = true;
  try {
    if (window.caches) for (const k of await caches.keys()) await caches.delete(k);
    const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
    if (reg) await reg.update().catch(() => {});
  } catch (e) { log(`Oppdatering: ${e.message}`); }
  location.reload();
}

// ---------- OTA ----------
export async function sha256hex(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Fra publiseringen 2026-11-22 har latest.json «file»: et versjonert filnavn
// (doegngrader-<versjon>-<sha12>.bin) som aldri endrer innhold. Eldre
// publiseringer har bare doegngrader.bin.
export async function fetchLatestBin(latest) {
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

export async function loadLatestFirmware() {
  try {
    const res = await fetch('firmware/latest.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.latest = await res.json();
  } catch (e) { state.latest = null; }
  updateOtaButton();
}

export function updateOtaButton() {
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

export async function runOta(source) {
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
