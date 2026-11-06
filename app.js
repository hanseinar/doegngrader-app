// app.js - nettside for døgngrader-måleren (Web Bluetooth)
import * as P from './protocol.js';

const TARGET_DG = 40;            // første mål, fra docs/spesifikasjon-v1.md
const SCALE_MAX = 60;
const HIST_TIMEOUT_MS = 60000;

const $ = (id) => document.getElementById(id);
const nf1 = new Intl.NumberFormat('nb-NO', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat('nb-NO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dtf = new Intl.DateTimeFormat('nb-NO', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

const state = {
  device: null,
  chars: {},
  status: null,
  statusAt: null,
  histInfo: null,
  histReadAt: null,
  history: [],
  fw: null,
  model: null,
  demo: new URLSearchParams(location.search).has('demo'),
};

function log(msg) {
  const t = new Date().toLocaleTimeString('nb-NO');
  const el = $('log');
  el.textContent = `${t} ${msg}\n` + el.textContent.slice(0, 20000);
}

function setConn(text, on) {
  const el = $('conn');
  el.textContent = text;
  el.classList.toggle('on', !!on);
}

function warn(text) {
  const el = $('warn');
  el.hidden = !text;
  el.textContent = text || '';
}

// ---------- skala ----------
function drawScale(dg) {
  const svg = $('scale');
  const W = Math.max(280, Math.round(svg.getBoundingClientRect().width) || 360);
  const x0 = 2, x1 = W - 2, yTrack = 8, hTrack = 18;
  const x = (v) => x0 + (Math.min(v, SCALE_MAX) / SCALE_MAX) * (x1 - x0);
  let s = `<rect class="track" x="${x0}" y="${yTrack}" width="${x1 - x0}" height="${hTrack}"/>`;
  if (dg !== null) s += `<rect class="fill" x="${x0}" y="${yTrack}" width="${Math.max(0, x(dg) - x0)}" height="${hTrack}"/>`;
  for (let v = 0; v <= SCALE_MAX; v += 5) {
    const major = v % 10 === 0;
    const isTarget = v === TARGET_DG;
    s += `<line class="tick${major ? ' major' : ''}" x1="${x(v)}" x2="${x(v)}" y1="${isTarget ? 0 : yTrack + hTrack}" y2="${yTrack + hTrack + (major ? 12 : 6)}"/>`;
    if (major) s += `<text x="${x(v)}" y="${yTrack + hTrack + 28}" text-anchor="${v === 0 ? 'start' : v === SCALE_MAX ? 'end' : 'middle'}"${isTarget ? ' class="target"' : ''}>${isTarget ? `mål ${v}` : v}</text>`;
  }
  svg.setAttribute('viewBox', `0 0 ${W} 64`);
  svg.setAttribute('height', 64);
  svg.innerHTML = s;
}

// ---------- anslag ----------
function avgLast24h() {
  const recs = state.history.slice(-24).filter((r) => r.tempC !== null);
  if (recs.length < 6) return null;
  return recs.reduce((a, r) => a + r.tempC, 0) / recs.length;
}

function heroNote(s) {
  if (!s) return 'Koble til måleren for å lese av.';
  const left = TARGET_DG - s.dg;
  if (left <= 0) return `Målet på ${TARGET_DG} døgngrader er nådd.`;
  const avg = avgLast24h();
  const t = avg ?? s.tempC;
  const basis = avg !== null ? `snitt siste døgn, ${nf1.format(avg)} °C` : `temperaturen nå, ${nf1.format(t ?? 0)} °C`;
  if (t === null || t <= 0.5) return `${nf1.format(left)} døgngrader igjen til ${TARGET_DG}. Det er for kaldt til å anslå når.`;
  const days = left / t;
  const when = new Date(Date.now() + days * 86400e3);
  return `${nf1.format(left)} døgngrader igjen til ${TARGET_DG}. Ved ${basis}: ${dtf.format(when)}.`;
}

// ---------- visning ----------
function renderStatus() {
  const s = state.status;
  $('dg-value').textContent = s ? nf1.format(Math.floor(s.dg * 10) / 10) : '–';
  drawScale(s ? s.dg : null);
  $('hero-note').textContent = heroNote(s);
  $('temp').textContent = s && s.tempC !== null ? `${nf1.format(s.tempC)} °C` : '–';
  $('rh').textContent = s && s.rh !== null ? `${s.rh} %` : '–';
  $('bat').textContent = s ? `${nf2.format(s.vbatMv / 1000)} V` : '–';
  warn(s && s.flagNames.length ? s.flagNames.join('. ') + '.' : '');
  renderDebug();
}

function renderDebug() {
  const s = state.status;
  const rows = [];
  if (state.device) rows.push(['Måler', state.device.name || '?']);
  if (state.fw) rows.push(['Firmware', state.fw]);
  if (state.model) rows.push(['Modell', state.model]);
  if (s) {
    rows.push(['Lest', state.statusAt.toLocaleTimeString('nb-NO')]);
    rows.push(['Periode', s.period]);
    rows.push(['Rå sum', `${s.sum} (${nf2.format(s.dg)} døgngrader)`]);
    rows.push(['Måleteller', s.measCounter]);
    rows.push(['Oppetid', `${s.uptimeMin} min`]);
    rows.push(['Dvaler', `${s.sleepCount} (ca. 6 per minutt er normalt)`]);
    rows.push(['Batteri', `${s.vbatMv} mV`]);
    rows.push(['Statusbiter', `0x${s.flags.toString(16).padStart(2, '0')}`]);
    rows.push(['Rådata', state.statusHex]);
  }
  if (state.diag) {
    const d = state.diag;
    rows.push(['Kalibrering', d.capFlash === null ? 'ingen i flash' : `0x${d.capFlash.toString(16)} (${d.capUsed ? 'i bruk' : 'ikke i bruk'})`]);
    rows.push(['Kjører fra', `0x${d.runningFrom.toString(16).padStart(5, '0')}`]);
    rows.push(['OTA-vindu', d.otaBusy ? 'OTA pågår' : d.otaMinutesLeft ? `åpent, ${d.otaMinutesLeft} min igjen` : 'stengt']);
  }
  if (state.histInfo) {
    const i = state.histInfo;
    rows.push(['Historikk', `time ${i.oldest} til ${i.next - 1}, siste lagret for ${Math.round(i.secsSinceLast / 60)} min siden`]);
  }
  $('debug-list').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${String(v)}</dd>`).join('');
}

function renderChart() {
  const svg = $('chart');
  const recs = state.history;
  const W = Math.max(280, Math.round(svg.getBoundingClientRect().width) || 360), H = 240, L = 30, R = 6, T = 10, B = 28;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('height', H);
  if (!recs.length) { svg.innerHTML = ''; return; }
  const temps = recs.map((r) => r.tempC).filter((t) => t !== null);
  let lo = Math.min(0, ...temps), hi = Math.max(5, ...temps);
  lo = Math.floor(lo / 5) * 5; hi = Math.ceil(hi / 5) * 5;
  const t0 = recs[0].time, t1 = recs[recs.length - 1].time;
  const span = Math.max(t1 - t0, 3600e3);
  const x = (t) => L + ((t - t0) / span) * (W - L - R);
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  let s = '';
  for (let v = lo; v <= hi; v += 5) {
    s += `<line class="${v === 0 ? 'zero' : 'grid'}" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/>`;
    s += `<text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
  }
  // dagsmerker
  const day = new Date(t0); day.setHours(24, 0, 0, 0);
  const dayFmt = new Intl.DateTimeFormat('nb-NO', { weekday: 'short', day: 'numeric' });
  const days = Math.round(span / 86400e3);
  const step = days > 14 ? 7 : days > 6 ? 2 : 1;
  for (let d = day.getTime(), k = 0; d <= t1; d += 86400e3, k++) {
    if (k % step) continue;
    s += `<line class="grid" x1="${x(d)}" x2="${x(d)}" y1="${T}" y2="${H - B}"/>`;
    s += `<text x="${x(d) + 3}" y="${H - 8}">${dayFmt.format(d)}</text>`;
  }
  // linje og areal over 0 (det som teller som døgngrader)
  let path = '', area = '', open = false;
  for (const r of recs) {
    if (r.tempC === null) { open = false; continue; }
    path += `${open ? 'L' : 'M'}${x(r.time).toFixed(1)},${y(r.tempC).toFixed(1)}`;
    open = true;
  }
  // areal mellom kurven (avgrenset til over 0) og 0-linjen, én sammenhengende flate
  const y0 = y(0);
  let seg = [];
  const flush = () => {
    if (seg.length > 1) area += `<path class="warmarea" d="M${seg[0][0]},${y0}${seg.map(([px, py]) => `L${px},${py}`).join('')}L${seg[seg.length - 1][0]},${y0}Z"/>`;
    seg = [];
  };
  for (const r of recs) {
    if (r.tempC === null) { flush(); continue; }
    seg.push([x(r.time).toFixed(1), y(Math.max(0, r.tempC)).toFixed(1)]);
  }
  flush();
  for (const r of recs) {
    if (r.flags & 0x03) s += `<line class="mark" x1="${x(r.time)}" x2="${x(r.time)}" y1="${T}" y2="${H - B}"><title>${P.flagNames(r.flags, P.HIST_FLAGS).join(', ')}</title></line>`;
  }
  svg.innerHTML = area + s + `<path class="temp" d="${path}"/>`;
  const dg = P.dgFromHistory(recs);
  $('hist-note').textContent = `${recs.length} timer. Arealet over 0 °C er det som gir døgngrader, ${nf1.format(dg)} i perioden som vises. Stiplet linje: oppstart eller ny periode.`;
}

// ---------- Bluetooth ----------
async function connect() {
  if (state.demo) return demoConnect();
  try {
    warn('');
    const device = state.device && !state.device.gatt.connected ? state.device : await navigator.bluetooth.requestDevice({
      // Windows husker gjerne gammelt navn for samme MAC (0.4: "Doegngrader"),
      // derfor også eldre navn og produsentdata (firma-ID 0xFFFF) som filter.
      filters: [{ namePrefix: 'DG-' }, { namePrefix: 'Doegngrader' }, { manufacturerData: [{ companyIdentifier: 0xffff }] }],
      optionalServices: [P.UUID.service, 'device_information', P.OTA_SERVICE],
    });
    state.device = device;
    device.removeEventListener('gattserverdisconnected', onDisconnected);
    device.addEventListener('gattserverdisconnected', onDisconnected);
    setConn(`Kobler til ${device.name}…`);
    log(`Kobler til ${device.name}`);
    const server = await device.gatt.connect();
    const svc = await server.getPrimaryService(P.UUID.service);
    for (const k of ['status', 'histInfo', 'histCtl', 'histData']) state.chars[k] = await svc.getCharacteristic(P.UUID[k]);
    try {
      const dis = await server.getPrimaryService('device_information');
      const dec = new TextDecoder();
      state.fw = dec.decode(await (await dis.getCharacteristic('firmware_revision_string')).readValue());
      state.model = dec.decode(await (await dis.getCharacteristic('model_number_string')).readValue());
    } catch (e) { log(`Enhetsinfo: ${e.message}`); }
    try {
      state.chars.diag = await svc.getCharacteristic(P.DIAG_UUID);
      state.diag = P.parseDiag(await state.chars.diag.readValue());
      log(`Diagnose: kalibrering ${state.diag.capFlash === null ? 'ingen' : '0x' + state.diag.capFlash.toString(16)}, OTA-vindu ${state.diag.otaMinutesLeft} min`);
    } catch (e) { state.chars.diag = null; state.diag = null; log('Diagnose finnes ikke (firmware før 0.5.1)'); }
    try {
      const ota = await server.getPrimaryService(P.OTA_SERVICE);
      state.chars.ota = await ota.getCharacteristic(P.OTA_CHAR);
    } catch (e) { state.chars.ota = null; }
    updateOtaButton();
    state.chars.status.addEventListener('characteristicvaluechanged', (ev) => onStatus(ev.target.value));
    onStatus(await state.chars.status.readValue());
    await state.chars.status.startNotifications();
    setConn(`${device.name} tilkoblet`, true);
    $('btn-hist').disabled = false;
    $('btn-connect').textContent = 'Koble fra';
    log('Tilkoblet, abonnerer på status');
  } catch (e) {
    log(`Feil: ${e.message}`);
    if (e.name !== 'NotFoundError') warn(`Kunne ikke koble til: ${e.message}`);
    setConn('Ikke tilkoblet');
  }
}

function onDisconnected() {
  log('Frakoblet');
  state.otaDisconnected = true;
  updateOtaButton();
  setConn(state.status ? `Frakoblet. Sist lest ${state.statusAt.toLocaleTimeString('nb-NO')}` : 'Ikke tilkoblet');
  $('btn-hist').disabled = true;
  $('btn-connect').textContent = 'Koble til igjen';
}

function onStatus(dv) {
  state.status = P.parseStatus(dv);
  state.statusHex = P.hex(dv);
  state.statusAt = new Date();
  log(`Status ${state.statusHex}`);
  renderStatus();
}

async function fetchHistory() {
  if (state.demo) return demoHistory();
  const btn = $('btn-hist');
  btn.disabled = true;
  try {
    const info = P.parseHistInfo(await state.chars.histInfo.readValue());
    state.histInfo = info;
    state.histReadAt = Date.now();
    const count = info.next - info.oldest;
    log(`Historikk-info: eldste ${info.oldest}, neste ${info.next}, ${info.secsSinceLast} s siden siste`);
    if (count <= 0) { $('hist-note').textContent = 'Måleren har ingen timeposter ennå. Første post lagres etter én time.'; return; }
    const got = [];
    await new Promise(async (resolve, reject) => {
      const ch = state.chars.histData;
      const timer = setTimeout(() => { cleanup(); reject(new Error(`tidsavbrudd etter ${got.length} av ${count} poster`)); }, HIST_TIMEOUT_MS);
      const onData = (ev) => {
        const p = P.parseHistPacket(ev.target.value);
        if (p.done) { cleanup(); resolve(); return; }
        got.push(...p.records);
        $('hist-note').textContent = `Henter historikk: ${got.length} av ${count} timer…`;
      };
      const cleanup = () => { clearTimeout(timer); ch.removeEventListener('characteristicvaluechanged', onData); };
      ch.addEventListener('characteristicvaluechanged', onData);
      try {
        await ch.startNotifications();
        await state.chars.histCtl.writeValueWithResponse(P.buildHistRequest(info.oldest, count));
      } catch (e) { cleanup(); reject(e); }
    });
    state.history = got.map((r) => ({ ...r, time: P.hourToTimeMs(r.hour, info, state.histReadAt) }));
    log(`Historikk: ${got.length} poster`);
    $('btn-csv').disabled = !got.length;
    renderChart();
    renderStatus();
  } catch (e) {
    log(`Historikk feilet: ${e.message}`);
    warn(`Historikk feilet: ${e.message}`);
  } finally {
    btn.disabled = !(state.device && state.device.gatt.connected) && !state.demo;
  }
}

function downloadCsv() {
  const lines = ['tid;time_nr;temperatur_c;fuktighet_pst;status'];
  for (const r of state.history) {
    lines.push([new Date(r.time).toISOString(), r.hour, r.tempC ?? '', r.rh ?? '', P.flagNames(r.flags, P.HIST_FLAGS).join(',')].join(';'));
  }
  const blob = new Blob([lines.join('\r\n') + '\r\n'], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${state.device?.name || 'dg'}-historikk.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- byggeinfo ----------
async function loadBuildInfo() {
  const el = $('build');
  try {
    const res = await fetch('build.json', { cache: 'no-store' });
    if (!res.ok) throw new Error();
    const b = await res.json();
    const d = new Date(b.built);
    const when = new Intl.DateTimeFormat('nb-NO', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d);
    el.textContent = `Versjon ${b.commit}, bygget ${when}. © ${d.getFullYear()} Hans Einar Steinsland`;
  } catch (e) {
    el.textContent = `© ${new Date().getFullYear()} Hans Einar Steinsland`;
  }
}

// ---------- OTA ----------
async function loadLatestFirmware() {
  const el = $('ota-latest');
  try {
    const res = await fetch('firmware/latest.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.latest = await res.json();
    el.textContent = `Nyeste firmware: ${state.latest.version} (${Math.round(state.latest.size / 1024)} KB).`;
  } catch (e) {
    state.latest = null;
    el.textContent = 'Fant ikke nyeste firmware på nettsiden. Bruk egen fil.';
  }
  updateOtaButton();
}

function updateOtaButton() {
  const connected = !!(state.device && state.device.gatt && state.device.gatt.connected);
  const ready = connected && state.chars.ota && !state.otaRunning;
  $('btn-ota').disabled = !(ready && $('ota-file').files.length);
  $('btn-ota-latest').disabled = !(ready && state.latest);
  if (state.latest) {
    const same = state.fw && state.fw.trim() === state.latest.version;
    $('btn-ota-latest').textContent = same ? `Installer ${state.latest.version} på nytt` : `Oppdater til ${state.latest.version}`;
  }
  if (connected && !state.chars.ota) $('ota-status').textContent = 'Måleren har ikke OTA. Den må ha firmware 0.5.1 eller nyere, flashet over UART første gang.';
}

async function runOta(source) {
  const st = $('ota-status');
  const bar = $('ota-progress');
  let fw;
  try {
    if (source === 'latest') {
      st.textContent = `Henter firmware ${state.latest.version}…`;
      const res = await fetch(`firmware/doegngrader.bin?v=${state.latest.sha256.slice(0, 12)}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fw = new Uint8Array(await res.arrayBuffer());
      if (fw.length !== state.latest.size) throw new Error('feil størrelse på nedlastet fil');
    } else {
      fw = new Uint8Array(await $('ota-file').files[0].arrayBuffer());
    }
    const info = P.validateFirmware(fw);
    log(`OTA: fil OK, ${info.size} byte, ${info.packets} pakker`);
  } catch (e) { st.textContent = `Fila kan ikke brukes: ${e.message}`; return; }

  if (state.chars.diag) {
    state.diag = P.parseDiag(await state.chars.diag.readValue());
    renderDebug();
    if (!state.diag.otaMinutesLeft && !state.diag.otaBusy) {
      st.textContent = 'OTA-vinduet er stengt. Ta ut batteriet, sett det inn igjen og koble til innen 3 minutter.';
      return;
    }
  }

  const ch = state.chars.ota;
  const n = Math.ceil(fw.length / 16);
  state.otaRunning = true;
  state.otaDisconnected = false;
  updateOtaButton();
  bar.hidden = false; bar.max = n; bar.value = 0;
  let result = null;
  const onNotify = (ev) => {
    const r = P.parseOtaNotify(ev.target.value);
    log(`OTA-varsling: ${r.type === 'result' ? r.text : r.hex}`);
    if (r.type === 'result') result = r;
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
        await ch.readValue();   // venter til måleren har tatt imot (flytkontroll)
        bar.value = i + 1;
        st.textContent = `Sender ${Math.round(((i + 1) / n) * 100)} % (${i + 1} av ${n} pakker)`;
      }
    }
    await ch.readValue();
    await ch.writeValueWithoutResponse(P.otaEndCmd(n - 1));
    bar.value = n;
    st.textContent = 'Alt sendt. Venter på svar fra måleren…';
    for (let k = 0; k < 100 && !result && !state.otaDisconnected; k++) await new Promise((r) => setTimeout(r, 100));
    const secs = Math.round((Date.now() - t0) / 1000);
    if (result && result.code !== 0) throw new Error(result.text);
    st.textContent = result
      ? `Ferdig på ${secs} s. Måleren starter på nytt med ny firmware. Koble til igjen om et halvt minutt og sjekk versjonen.`
      : `Sendt på ${secs} s, men måleren svarte ikke. Den kan ha startet på nytt. Koble til igjen og sjekk versjonen.`;
    log(`OTA ferdig: ${result ? result.text : 'ingen svar'}`);
  } catch (e) {
    st.textContent = `Oppdatering feilet: ${e.message}. Den gamle firmwaren er fortsatt i bruk.`;
    log(`OTA feilet: ${e.message}`);
  } finally {
    ch.removeEventListener('characteristicvaluechanged', onNotify);
    state.otaRunning = false;
    updateOtaButton();
  }
}

// ---------- demo (?demo) ----------
function demoConnect() {
  state.device = { name: 'DG-DEMO', gatt: { connected: true } };
  state.fw = '0.5.0 (demo)';
  state.model = 'LYWSD03MMC B1.1';
  const b = new Uint8Array(21); const v = new DataView(b.buffer);
  const sum = Math.round(23.6 * 28800);
  v.setUint8(0, 1); v.setUint8(1, 0x50); v.setUint16(2, Math.floor(sum / 2880), true); v.setInt16(4, 412, true);
  v.setUint8(6, 82); v.setUint16(7, 2931, true); v.setUint8(9, 61); v.setUint32(10, sum, true);
  v.setUint16(14, 14, true); v.setUint16(16, 7843, true); v.setUint16(18, 47012, true);
  onStatus(v);
  setConn('DG-DEMO tilkoblet (demo)', true);
  $('btn-hist').disabled = false;
}

function demoHistory() {
  const now = Date.now();
  const n = 24 * 6;
  state.histInfo = { oldest: 0, next: n, secsSinceLast: 1200 };
  state.history = Array.from({ length: n }, (_, h) => {
    const day = Math.sin(((h % 24) - 8) / 24 * 2 * Math.PI);
    const t = 3.5 + 0.3 * day + (h < 30 ? 2.5 - h / 12 : 0) + (h === 70 ? 6 : 0);
    return { hour: h, tempC: Math.round(t * 10) / 10, rh: 80, flags: h === 0 ? 0x03 : 0, time: P.hourToTimeMs(h, state.histInfo, now) };
  });
  $('btn-csv').disabled = false;
  renderChart();
  renderStatus();
}

// ---------- oppstart ----------
function init() {
  drawScale(null);
  if (!state.demo && !('bluetooth' in navigator)) {
    $('nosupport').hidden = false;
    $('btn-connect').disabled = true;
  }
  $('btn-connect').addEventListener('click', () => {
    if (!state.demo && state.device?.gatt.connected) { state.device.gatt.disconnect(); return; }
    connect();
  });
  $('btn-hist').addEventListener('click', fetchHistory);
  $('btn-csv').addEventListener('click', downloadCsv);
  $('btn-ota').addEventListener('click', () => runOta('file'));
  $('btn-ota-latest').addEventListener('click', () => runOta('latest'));
  loadLatestFirmware();
  loadBuildInfo();
  $('ota-file').addEventListener('change', updateOtaButton);
  let rt;
  addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { drawScale(state.status ? state.status.dg : null); renderChart(); }, 150); });
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  if (state.demo) { setConn('Demo'); }
}

init();
