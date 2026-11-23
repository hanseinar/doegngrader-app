// license.js - lisens per måler fra admin/ (svar versjon 3, 2026-11-23).
//
// Appen er betalt. Med lisens (prøveperiode eller lisens til en dato) er alt åpent;
// uten lisens viser appen bare demo, men firmwareoppdatering er åpen.
// Bestilling og forlengelse skjer på e-post (ORDER_EMAIL), ikke i appen.
// På fra 2026-11-23 (SERVER og PUBKEY satt). Tomme verdier slår lisens av. For test kan
// localStorage 'dg.licServer' og 'dg.licPubkey' overstyre.
// Svaret er signert med Ed25519 og lagres per måler. Uten nett gjelder lagret svar
// til den første av: prøveperiodens slutt eller abonnementets siste dag, og exp.

export const SERVER = 'https://kunde.modna.info-web.no';          // admin/ (lisens-API)
export const PUBKEY = 'bBamFqNVzzlK_R5MTa9whwL8RYDSG3jJL_zl4z8V0F8';  // fra /api/v1/pubkey (base64url, 32 byte)
export const ORDER_EMAIL = 'hans.einar.steinsland@gmail.com';   // bestilling og forlengelse

function ls(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* privat modus */ } }

export function config() {
  const server = (ls('dg.licServer') || SERVER).replace(/\/+$/, '');
  const pubkey = ls('dg.licPubkey') || PUBKEY;
  return server ? { server, pubkey } : null;
}

// Samme byteform som serveren signerer (Python json.dumps, sort_keys, uten mellomrom, ensure_ascii=False).
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v === undefined ? null : v);
}

function unb64(s) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

// true/false, eller null når nettleseren ikke kan Ed25519 eller nøkkel mangler.
export async function verify(doc, pubkey) {
  if (!pubkey || !doc || typeof doc.sig !== 'string') return null;
  const body = { ...doc };
  delete body.sig;
  let key;
  try {
    key = await crypto.subtle.importKey('raw', unb64(pubkey), { name: 'Ed25519' }, false, ['verify']);
  } catch (e) { return null; }
  try {
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, unb64(doc.sig), new TextEncoder().encode(canonical(body)));
  } catch (e) { return false; }
}

// Dato i norsk tid (YYYY-MM-DD). Abonnementets siste dag (sub_to) er en norsk dato.
export function osloDate(d = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Oslo' }).format(d);
}

// Tilgang ut fra et (kontrollert) svar på tidspunktet now. Regnes i appen, så
// tilgangen stopper til riktig tid også uten nett.
// Gir { ok, kind: 'sub'|'trial'|null, until (Date eller 'YYYY-MM-DD'), status }.
export function access(doc, now = new Date()) {
  if (!doc || expired(doc, now)) return { ok: false, kind: null, until: null, status: doc ? doc.status : null };
  if (doc.sub_to && osloDate(now) <= doc.sub_to) return { ok: true, kind: 'sub', until: doc.sub_to, status: doc.status };
  if (doc.trial_until && now < new Date(doc.trial_until)) return { ok: true, kind: 'trial', until: new Date(doc.trial_until), status: doc.status };
  return { ok: false, kind: null, until: null, status: doc.status === 'prove' || doc.status === 'aktiv' ? 'utlopt' : doc.status };
}

// E-post til ORDER_EMAIL. subject og body er ferdig tekst (oversatt i appen).
export function orderMail(subject, body) {
  return `mailto:${ORDER_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

// Sist lagrede svar for måleren (bare til visning i målerlista; tilgang avgjøres i load).
export function stored(serial) {
  if (!serial) return null;
  try {
    const doc = JSON.parse(ls(`dg.lic.${serial}`) || 'null');
    return doc && doc.serial === serial ? doc : null;
  } catch (e) { return null; }
}

// Har måleren hatt tilgang på denne telefonen? Brukes til tilbakestilling ved utløp.
export function hadAccess(serial) { return ls(`dg.licHad.${serial}`) === '1'; }
export function markAccess(serial) { lsSet(`dg.licHad.${serial}`, '1'); lsSet(`dg.licReset.${serial}`, ''); }
export function resetDone(serial) { return ls(`dg.licReset.${serial}`) === '1'; }
export function markReset(serial) { lsSet(`dg.licReset.${serial}`, '1'); }

export function expired(doc, now = new Date()) {
  return !doc || !doc.exp || new Date(doc.exp) < now;
}

// Henter svar for måleren; faller tilbake til lagret svar uten nett.
// Gir { doc, verified, offline } eller null.
export async function load(serial, fw = '', fetchFn = fetch) {
  if (typeof fw === 'function') { fetchFn = fw; fw = ''; }
  const cfg = config();
  if (!cfg || !serial) return null;
  const key = `dg.lic.${serial}`;
  let doc = null, offline = false;
  try {
    const q = fw ? `?fw=${encodeURIComponent(fw)}` : '';
    const r = await fetchFn(`${cfg.server}/api/v1/lisens/${encodeURIComponent(serial)}${q}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    doc = await r.json();
  } catch (e) {
    offline = true;
    try { doc = JSON.parse(ls(key) || 'null'); } catch (e2) { doc = null; }
    if (expired(doc)) doc = null;
  }
  if (doc && doc.serial !== serial) doc = null;
  if (!doc) return { doc: null, verified: null, offline };
  const verified = await verify(doc, cfg.pubkey);
  if (verified === false) return { doc: null, verified, offline };
  // Lagret svar uten nett brukes bare når signaturen er kontrollert. Uten Ed25519
  // i nettleseren (eldre Chrome/Edge) kreves derfor nett ved hver tilkobling.
  if (offline && verified !== true) return { doc: null, verified, offline };
  if (!offline) lsSet(key, JSON.stringify(doc));
  return { doc, verified, offline };
}
