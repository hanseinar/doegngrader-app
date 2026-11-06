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

// Historikk-info (12 byte, fra 0.5.5: 17 byte med periodestart).
export function parseHistInfo(buf) {
  const v = view(buf);
  if (v.byteLength < 12) throw new Error(`Historikk-info: ${v.byteLength} byte, ventet 12`);
  const ps = v.byteLength >= 17 ? v.getUint32(12, true) : 0xffffffff;
  return {
    oldest: v.getUint32(0, true),
    next: v.getUint32(4, true),
    secsSinceLast: v.getUint32(8, true),
    psHour: ps === 0xffffffff ? null : ps,
    psSample: v.byteLength >= 17 ? v.getUint8(16) : 0,
  };
}

// Tidspunkt (ms) da perioden startet, ut fra periodestart i hist-info. null hvis ukjent.
// Timen `psHour` begynte da timen før sluttet (hourToTimeMs(psHour - 1)).
export function periodStartMs(info, readAtMs) {
  if (!info || info.psHour === null || info.psHour === undefined) return null;
  if (info.psHour > info.next) return null;
  return hourToTimeMs(info.psHour - 1, info, readAtMs) + info.psSample * 300e3;
}

// ---------- innstillinger (fra 0.5.5) ----------
export const SET_SERVICE = 'd6a10007' + UUID_BASE;
export const SET_CHAR = 'd6a10008' + UUID_BASE;
export const SET_LIMITS = { dg: [1, 999], days: [1, 99] };
export const USE_CODES = ['vilt', 'restaurant'];

export function parseSettings(buf) {
  const v = view(buf);
  if (v.byteLength < 5) throw new Error(`Innstillinger: ${v.byteLength} byte, ventet 8`);
  if (v.getUint8(0) !== 1) throw new Error(`Innstillinger: ukjent format ${v.getUint8(0)}`);
  return {
    use: USE_CODES[v.getUint8(1)] ?? 'vilt',
    targetDg: v.getUint16(2, true),
    targetDays: v.getUint8(4),
  };
}

export function buildSettings({ use, targetDg, targetDays }) {
  const u = USE_CODES.indexOf(use);
  if (u < 0) throw new Error(`Ukjent bruk: ${use}`);
  const dg = Math.round(targetDg), days = Math.round(targetDays);
  if (!(dg >= SET_LIMITS.dg[0] && dg <= SET_LIMITS.dg[1])) throw new Error(`Mål utenfor ${SET_LIMITS.dg.join('..')}: ${targetDg}`);
  if (!(days >= SET_LIMITS.days[0] && days <= SET_LIMITS.days[1])) throw new Error(`Dager utenfor ${SET_LIMITS.days.join('..')}: ${targetDays}`);
  const b = new Uint8Array(8);
  b[0] = 1; b[1] = u; b[2] = dg & 0xff; b[3] = dg >> 8; b[4] = days;
  return b;
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

// ---------- diagnose (fra firmware 0.5.1) ----------
export const DIAG_UUID = 'd6a10006' + UUID_BASE;
export function parseDiag(buf) {
  const v = view(buf);
  if (v.byteLength < 8) throw new Error(`Diag: ${v.byteLength} byte, ventet 8`);
  const cap = v.getUint8(0);
  const otaAddr = v.getUint32(2, true);
  return {
    capFlash: cap === 0xff ? null : cap,
    capUsed: v.getUint8(1) === 1,
    otaAddr,
    runningFrom: otaAddr === 0x40000 ? 0x00000 : 0x40000,
    otaMinutesLeft: v.getUint8(6),
    otaBusy: v.getUint8(7) === 1,
  };
}

// ---------- OTA (Telink, tc_ble_sdk stack/ble/service/ota) ----------
export const OTA_SERVICE = '00010203-0405-0607-0809-0a0b0c0d1912';
export const OTA_CHAR = '00010203-0405-0607-0809-0a0b0c0d2b12';
export const OTA_MAX_SIZE = 124 * 1024;    // 128 KB-område, siste 4 KB brukes ikke
export const OTA_RESULTS = [
  'OK', 'feil pakkerekkefølge', 'ugyldig pakke', 'CRC-feil i pakke', 'skrivefeil i flash',
  'pakker mangler', 'feil rekkefølge på kommandoer', 'CRC-feil i firmware', 'versjon for lav',
  'feil pakkelengde', 'ikke Telink-firmware', 'feil størrelse', 'tidsavbrudd mellom pakker',
  'tidsavbrudd', 'tilkoblingen falt ut', 'ikke støttet', 'logikkfeil',
];

// CRC-16 som Telinks crc16() (polynom 0xA001, start 0xFFFF)
export function crc16(bytes) {
  let crc = 0xffff;
  for (const b of bytes) {
    let d = b;
    for (let i = 0; i < 8; i++) {
      crc = (crc >>> 1) ^ (((crc ^ d) & 1) ? 0xa001 : 0);
      d >>>= 1;
    }
  }
  return crc & 0xffff;
}

let crcTable = null;
export function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Sjekker at fila er laget av byggejobben (firmware/tools/fw_ota.py).
export function validateFirmware(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length < 64) throw new Error('Fila er for liten');
  if (String.fromCharCode(b[8], b[9], b[10], b[11]) !== 'KNLT') throw new Error('Ikke Telink-firmware (mangler KNLT)');
  if (b[6] !== 0x5d || b[7] !== 0x02) throw new Error('Mangler OTA-merke. Bruk fila fra firmware/bin');
  const size = v.getUint32(0x18, true);
  if (size !== b.length) throw new Error(`Størrelsen i fila (${size}) stemmer ikke med fillengden (${b.length})`);
  if (b.length > OTA_MAX_SIZE) throw new Error(`Fila er for stor (${b.length} byte, maks ${OTA_MAX_SIZE})`);
  const want = v.getUint32(b.length - 4, true);
  const got = (crc32(b.subarray(0, b.length - 4)) ^ 0xffffffff) >>> 0;
  if (want !== got) throw new Error('CRC stemmer ikke, fila er skadet');
  return { size: b.length, packets: Math.ceil(b.length / 16) };
}

export const OTA_CMD_START = new Uint8Array([0x01, 0xff]);

export function otaEndCmd(lastIndex) {
  const b = new Uint8Array(6);
  const v = new DataView(b.buffer);
  v.setUint16(0, 0xff02, true);
  v.setUint16(2, lastIndex, true);
  v.setUint16(4, ~lastIndex & 0xffff, true);
  return b;
}

// Datapakke: indeks (u16) + 16 byte (fylt med 0xFF) + CRC-16 over de 18 første.
export function otaPacket(fw, index) {
  const p = new Uint8Array(20);
  p[0] = index & 0xff;
  p[1] = (index >> 8) & 0xff;
  for (let i = 0; i < 16; i++) {
    const k = index * 16 + i;
    p[2 + i] = k < fw.length ? fw[k] : 0xff;
  }
  const c = crc16(p.subarray(0, 18));
  p[18] = c & 0xff;
  p[19] = c >> 8;
  return p;
}

// Varsling fra OTA-karakteristikken. Resultat: 06 FF <kode> 00.
export function parseOtaNotify(buf) {
  const v = view(buf);
  if (v.byteLength >= 3 && v.getUint16(0, true) === 0xff06) {
    const code = v.getUint8(2);
    return { type: 'result', code, text: OTA_RESULTS[code] ?? `kode ${code}` };
  }
  return { type: 'other', hex: hex(buf) };
}
