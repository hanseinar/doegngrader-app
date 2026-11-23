// ble.js - Bluetooth: tilkobling, GATT-kø, jevnlig kontakt, status, ny periode
// Del av appen (app.js). Delt ut fra app.js 2026-11-22, funksjonene er uendret.
import * as P from './protocol.js';
import * as L from './logic.js';
import { $, connected, devInfo, log, setDevInfo, state, store, t, withTimeout } from './core.js';
import { demoConnect } from './demo.js';
import { fetchHistory } from './history.js';
import { updateOtaButton } from './ota.js';
import { pollSettings, syncSettingsOnConnect } from './settingsui.js';
import { applyLock, checkLicense, licEnabled, maybeResetAfterExpiry } from './subscription.js';
import { render, renderConn, renderDebug, toggleConnPop } from './view.js';
import { pullOverview } from './sync.js';

// ---------- Bluetooth ----------
export const CONNECT_TIMEOUT_MS = 25000;   // 2026-11-23: var 15 s; måleren sender hvert 3. (0.6.6) eller 5. sekund
export const CONNECT_TRIES = 2;            // ett nytt forsøk før feilmelding

// gatt.connect() med frist og ett nytt forsøk. Første forsøk bommer av og til
// når måleren sender sjelden; det andre lykkes som regel med en gang.
export async function gattConnect(device) {
  for (let i = 1; ; i++) {
    try {
      return await withTimeout(device.gatt.connect(), CONNECT_TIMEOUT_MS, t('err.timeout'));
    } catch (e) {
      try { device.gatt.disconnect(); } catch (x) { /* ikke tilkoblet */ }
      if (i >= CONNECT_TRIES) throw e;
      log(`Tilkobling forsøk ${i} feilet (${e.message}), prøver igjen`);
      connMsg(t('conn.retry', { name: device.name }));
    }
  }
}
// Målere nettleseren allerede har gitt tilgang til (getDevices), uten enhetslista.
// Ikke alle nettlesere har getDevices; da brukes lista som før. Venter på en
// reklame (watchAdvertisements) før tilkobling, fordi måleren må være i nærheten.
export const KNOWN_WAIT_MS = 6000;
export let forceChooser = false;
export async function findKnownDevice(wantId) {
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

export async function connect(wantId) {
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
    const newId = L.deviceId(device.name);
    if (newId !== state.devId) {
      // annen måler: ingenting fra forrige måler skal brukes (graf, anslag, lisens)
      Object.assign(state, { status: null, statusAt: null, statusHex: '', history: [], histInfo: null, histReadAt: null,
        serial: null, fw: null, model: null, diag: null, lic: null, server: null });
    }
    state.device = device;
    state.devId = newId;
    store.set('lastDevId', state.devId);
    device.removeEventListener('gattserverdisconnected', onDisconnected);
    device.addEventListener('gattserverdisconnected', onDisconnected);
    renderConn('wait');
    log(`Kobler til ${device.name}`);
    connMsg(t('conn.waiting', { name: device.name }));
    const server = await gattConnect(device);
    connMsg('');
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
    await checkLicense();                 // før målingene vises (låst uten lisens)
    state.chars.status.addEventListener('characteristicvaluechanged', (ev) => onStatus(ev.target.value));
    onStatus(await state.chars.status.readValue());
    await state.chars.status.startNotifications();
    renderConn('on');
    connMsg('');
    log('Tilkoblet');
    startDiagPoll();
    if (state.locked) { await maybeResetAfterExpiry(); return; }
    await syncSettingsOnConnect();
    pullOverview();   // navn, perioder og notater fra serveren
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
export function connMsg(text, failed) {
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
export const DIAG_POLL_MS = 15000;
const SETTINGS_POLL_TICKS = 4;      // innstillinger leses hvert minutt (modus kan byttes med binders)
export let gattLock = Promise.resolve();
export let diagTimer = null;

export function gattQ(fn) {
  const p = gattLock.then(fn);
  gattLock = p.catch(() => {});
  return p;
}

export function readDiag() {
  if (!state.chars.diag || !connected()) return Promise.resolve(state.diag);
  return gattQ(async () => {
    state.diag = P.parseDiag(await state.chars.diag.readValue());
    state.diagAt = new Date();
    return state.diag;
  });
}

export function writeCmd(code) {
  return gattQ(() => state.chars.cmd.writeValueWithResponse(new Uint8Array([code])));
}

export function keepaliveSupported() { return !!state.chars.cmd && P.fwNum(state.fw) >= P.fwNum('0.6.3'); }

export function startDiagPoll() {
  stopDiagPoll();
  if (!state.chars.diag && !keepaliveSupported()) return;
  let tick = 0;
  diagTimer = setInterval(async () => {
    if (!connected()) { stopDiagPoll(); return; }
    if (state.otaRunning || state.histBusy || document.hidden) return;
    try {
      await readDiag();
      if (keepaliveSupported()) await writeCmd(P.CMD_KEEPALIVE);
      if (++tick % SETTINGS_POLL_TICKS === 0 && !state.locked) await pollSettings();
    } catch (e) { log(`Kontakt: ${e.message}`); return; }
    // prøveperiode eller abonnement kan gå ut mens appen er åpen
    if (licEnabled()) { const before = state.locked; applyLock(); if (!before && state.locked) maybeResetAfterExpiry(); }
    renderDebug();
    updateOtaButton();
  }, DIAG_POLL_MS);
}

export function stopDiagPoll() {
  if (diagTimer) clearInterval(diagTimer);
  diagTimer = null;
}

export function onDisconnected() {
  log('Frakoblet');
  $('conn-pop').hidden = true;    // vinduet med «Koble fra» gjelder bare tilkoblet måler
  gattLock = Promise.resolve();   // en operasjon som aldri fikk svar skal ikke sperre neste tilkobling
  state.otaDisconnected = true;
  renderConn('off');
  toggleConnPop(false);
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

export function onStatus(dv) {
  state.status = P.parseStatus(dv);
  state.statusHex = P.hex(dv);
  state.statusAt = new Date();
  const st = state.status;
  // uten lisens lagres eller logges ingen målinger (de vises heller ikke)
  if (!state.locked) {
    setDevInfo({ last: { dg: st.dg, tempC: st.tempC, rh: st.rh, mv: st.vbatMv, at: Date.now() } });
    log(`Status ${state.statusHex}`);
  }
  render();
}

// ---------- ny periode fra appen (0.6.0) ----------
export function newpMsg(text, failed) {
  const el = $('newp-msg');
  el.textContent = text || '';
  el.hidden = !text;
  el.classList.toggle('failed', !!failed);
}

export function askNewPeriod() {
  newpMsg('');
  if (!connected() || !state.chars.cmd) { newpMsg(t('newp.notConnected'), true); render(); return; }
  const dlg = $('confirm-newp');
  $('newp-text').textContent = t('newp.text', { name: devInfo().name || (state.device ? state.device.name : '') });
  dlg.returnValue = '';
  dlg.showModal();
}

export async function doNewPeriod() {
  if (!connected() || !state.chars.cmd) { newpMsg(t('newp.notConnected'), true); log(t('newp.notConnected')); render(); return; }
  try {
    await writeCmd(P.CMD_NEW_PERIOD);
    await new Promise((r) => setTimeout(r, 800));   // måleren måler og lagrer først
    if (!state.demo) onStatus(await gattQ(() => state.chars.status.readValue()));
    log(t('newp.done'));
    newpMsg(t('newp.done'), false);
    state.history = []; state.histInfo = null;
    fetchHistory();
  } catch (e) {
    log(t('newp.failed', { msg: e.message }));
    newpMsg(t('newp.failed', { msg: e.message }), true);
  }
}
