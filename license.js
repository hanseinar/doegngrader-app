// license.js - abonnementsstatus fra kunderegisteret (admin/), vist under Detaljer.
//
// Skjult til SERVER og PUBKEY er satt. For test kan localStorage 'dg.licServer'
// og 'dg.licPubkey' overstyre. Svaret er signert med Ed25519 og lagres per måler,
// så statusen vises også uten nett til svaret går ut (exp).

export const SERVER = '';     // f.eks. 'https://kunder.info-web.no'
export const PUBKEY = '';     // fra /api/v1/pubkey (base64url, 32 byte)

function ls(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* privat modus */ } }

export function config() {
  const server = (ls('dg.licServer') || SERVER).replace(/\/+$/, '');
  const pubkey = ls('dg.licPubkey') || PUBKEY;
  return server ? { server, pubkey, minside: `${server}/min-side/` } : null;
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

// Rader til visning. today: 'YYYY-MM-DD'.
export function view(doc, today) {
  if (!doc) return [];
  const items = Array.isArray(doc.items) && doc.items.length ? doc.items
    : (doc.features || []).map((f) => ({ f, to: doc.valid_to ?? null, renew: true }));
  return items.map((i) => ({
    feature: i.f,
    to: i.to,
    state: i.to && i.to < today ? 'expired' : i.renew === false ? 'cancelled' : 'active',
  }));
}

export function expired(doc, now = new Date()) {
  return !doc || !doc.exp || new Date(doc.exp) < now;
}

// Henter svar for måleren; faller tilbake til lagret svar uten nett.
// Gir { doc, verified, offline } eller null.
export async function load(serial, fetchFn = fetch) {
  const cfg = config();
  if (!cfg || !serial) return null;
  const key = `dg.lic.${serial}`;
  let doc = null, offline = false;
  try {
    const r = await fetchFn(`${cfg.server}/api/v1/lisens/${encodeURIComponent(serial)}`, { cache: 'no-store' });
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
  if (!offline) lsSet(key, JSON.stringify(doc));
  return { doc, verified, offline };
}
