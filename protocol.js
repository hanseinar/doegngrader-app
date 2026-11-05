// protocol.js - tolking av data fra døgngrader-måleren (firmware 0.5.0)
// Formatene er beskrevet i docs/spesifikasjon-v1.md og firmware/src/{advdata,gatt,hist}.h.
// Ingen avhengigheter til nettleser, testes med node (app/tests).

export const UUID_BASE = '-7f3b-4c2e-9a51-3e8f2b6c4d10';
export const UUID = {
  service: 'd6a10001' + UUID_BASE,
  status: 'd6a10002' + UUID_BASE,
  histInfo: 'd6a10003' + UUID_BASE,
  histCtl: 'd6a10004' + UUID_BASE,
  histData: 'd6a10005' + UUID_BASE,
};

export const DG_SUM_PER_DEGREE_DAY = 28800;
export const STATUS_LEN = 21;
export const HIST_REC_SIZE = 4;

const STATUS_FLAGS = [
  [0x01, 'Sensorfeil'],
  [0x02, 'Lavt batteri'],
  [0x04, 'Padden holdt over 10 s'],
  [0x08, 'For lav spenning til lagring'],
];

export const HIST_FLAGS = [
  [0x01, 'Oppstart'],
  [0x02, 'Ny periode'],
  [0x04, 'Sensorfeil'],
  [0x08, 'Lavt batteri'],
  [0x10, 'Ufullstendig time'],
];

function view(buf) {
  if (buf instanceof DataView) return buf;
  if (buf instanceof ArrayBuffer) return new DataView(buf);
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
}

export function fwVersionString(b) {
  return `0.${b >> 4}.${b & 0x0f}`;
}

export function flagNames(flags, table) {
  return table.filter(([bit]) => flags & bit).map(([, name]) => name);
}

// Status-karakteristikken og produsentdata (21 byte).
export function parseStatus(buf) {
  const v = view(buf);
  if (v.byteLength < STATUS_LEN) throw new Error(`Status: ${v.byteLength} byte, ventet ${STATUS_LEN}`);
  const tempRaw = v.getInt16(4, true);
  const rh = v.getUint8(6);
  const sum = v.getUint32(10, true);
  const flags = v.getUint8(20);
  return {
    format: v.getUint8(0),
    fwVersion: fwVersionString(v.getUint8(1)),
    dgTenths: v.getUint16(2, true),
    dg: sum / DG_SUM_PER_DEGREE_DAY,
    tempC: tempRaw === -32768 ? null : tempRaw / 100,
    rh: rh === 0xff ? null : rh,
    vbatMv: v.getUint16(7, true),
    measCounter: v.getUint8(9),
    sum,
    period: v.getUint16(14, true),
    uptimeMin: v.getUint16(16, true),
    sleepCount: v.getUint16(18, true),
    flags,
    flagNames: flagNames(flags, STATUS_FLAGS),
  };
}

// Historikk-info (12 byte).
export function parseHistInfo(buf) {
  const v = view(buf);
  if (v.byteLength < 12) throw new Error(`Historikk-info: ${v.byteLength} byte, ventet 12`);
  return {
    oldest: v.getUint32(0, true),
    next: v.getUint32(4, true),
    secsSinceLast: v.getUint32(8, true),
  };
}

// Historikk-ønske (6 byte).
export function buildHistRequest(first, count) {
  const b = new Uint8Array(6);
  const v = new DataView(b.buffer);
  v.setUint32(0, first >>> 0, true);
  v.setUint16(4, Math.min(count, 0xffff), true);
  return b;
}

// Én post (4 byte).
export function parseHistRecord(v, ofs) {
  const t = v.getInt16(ofs, true);
  const rh = v.getUint8(ofs + 2);
  const flags = v.getUint8(ofs + 3);
  return {
    tempC: t === -32768 ? null : t / 10,
    rh: rh === 0xff ? null : rh,
    flags,
  };
}

// Historikk-data: timenummer + 0..4 poster. done = true for pakken uten poster.
export function parseHistPacket(buf) {
  const v = view(buf);
  if (v.byteLength < 4) throw new Error(`Historikk-data: ${v.byteLength} byte`);
  const first = v.getUint32(0, true);
  const n = Math.floor((v.byteLength - 4) / HIST_REC_SIZE);
  const records = [];
  for (let i = 0; i < n; i++) records.push({ hour: first + i, ...parseHistRecord(v, 4 + i * HIST_REC_SIZE) });
  return { first, records, done: n === 0 };
}

// Tidspunkt (ms) for slutten av time `hour`, regnet bakover fra lesetidspunktet.
// Posten for time `next - 1` ble lagret `secsSinceLast` sekunder før `readAtMs`.
export function hourToTimeMs(hour, info, readAtMs) {
  return readAtMs - info.secsSinceLast * 1000 - (info.next - 1 - hour) * 3600 * 1000;
}

// Døgngrader fra historikken: hver time bidrar med max(0, T) / 24.
export function dgFromHistory(records) {
  let dg = 0;
  for (const r of records) if (r.tempC !== null && r.tempC > 0) dg += r.tempC / 24;
  return dg;
}

export function hex(buf) {
  const v = view(buf);
  const out = [];
  for (let i = 0; i < v.byteLength; i++) out.push(v.getUint8(i).toString(16).padStart(2, '0'));
  return out.join(' ');
}
