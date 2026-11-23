// order.js - lisensstatus per måler og bestilling/forlengelse på e-post (2026-11-23).
// Bruker bare core.js og license.js, så både visningen og abonnementet kan bruke den.
import * as LIC from './license.js';
import { $, fmtDay, fmtWhen, state, t } from './core.js';

// Lisens er på når SERVER er satt (license.js). Demo uten lisens: ?demo, med: ?demo&demolic.
export function licEnabled() { return !!LIC.config() && (!state.demo || state.demoLic); }

const day = (iso) => fmtDay(new Date(`${iso}T12:00:00`));

// Kort status for en måler ut fra lagret svar: { text, cls } eller null.
export function licStatus(doc, now = new Date()) {
  if (!doc) return null;
  const acc = LIC.access(doc, now);
  if (acc.ok && acc.kind === 'sub') return { text: t('meters.lic', { date: day(acc.until) }), cls: 'lic-ok' };
  if (acc.ok) return { text: t('meters.trial', { when: fmtWhen(acc.until) }), cls: 'lic-trial' };
  return { text: t('meters.noLic'), cls: 'lic-none' };
}

// Bestillingstekst for én eller flere målere: [{ serial, id, name }], eller null.
// Ingen e-postlenke (2026-11-23): adressen vises som tekst og kan kopieres.
export function orderTextFor(meters) {
  const lines = meters.filter((m) => m.serial).map((m) => {
    const st = licStatus(LIC.stored(m.serial));
    const name = m.name ? `${m.name} (DG-${m.id})` : `DG-${m.id}`;
    return `- ${name}, ${t('order.serial')} ${m.serial}${st ? `, ${st.text}` : ''}`;
  });
  if (!lines.length) return null;
  return `${t('order.subject')}\n\n${t('order.body', { list: lines.join('\n') })}`;
}

async function copy(text, el) {
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch { /* faller tilbake til markering */ }
  if (!ok) {
    const ta = $('order-text');
    if (el === ta) { ta.focus(); ta.select(); }
    else { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
  }
  $('order-copied').textContent = ok ? t('order.copied') : t('order.copyManual');
}

// Vinduet med adresse, ferdig tekst og kontaktinformasjon.
export function openOrder(meters) {
  const text = orderTextFor(meters);
  if (!text) return;
  $('order-addr').textContent = LIC.ORDER_EMAIL;
  $('order-text').value = text;
  $('order-copied').textContent = '';
  $('order-copy-addr').onclick = () => copy(LIC.ORDER_EMAIL, $('order-addr'));
  $('order-copy-text').onclick = () => copy(text, $('order-text'));
  $('order-dlg').showModal();
}
