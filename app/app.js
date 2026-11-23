// app.js - nettside for døgngrader-måleren, versjon 3 (Web Bluetooth)
//
// Versjon 3 (2026-11-22): ingen Enkel/Avansert. Forsiden har hovedtall, tre
// instrumenter (temperatur, fuktighet, duggpunkt) som er opplyst bare når
// måleren er tilkoblet, og grafen bak en trekant. Resten ligger under
// tannhjulet. Notat og vekt er tatt ut (lå bare i nettleseren).
//
// Oppbygging (delt i moduler 2026-11-22):
//   core.js, view.js, settingsui.js, ble.js, history.js, forecast.js,
//   subscription.js, ota.js, demo.js: se toppen av hver fil
//   protocol.js  tolking av data fra måleren
//   logic.js     regler: periode, anslag, batterinivå, duggpunkt, råd
//   i18n.js      all tekst, norsk og engelsk
//   ameter.js    analogt instrument (fra webrig-vhf)
// Innstillinger og navn på målere lagres i nettleseren (localStorage).
import * as P from './protocol.js';
import { askNewPeriod, connect, doNewPeriod, readDiag, writeCmd } from './ble.js';
import { $, connected, locale, log, saveSettings, setDevInfo, settings, state, t } from './core.js';
import { demoConnect } from './demo.js';
import { askPosition } from './forecast.js';
import { downloadCsv, fetchHistory, refreshAll } from './history.js';
import { checkAppUpdate, loadBuildInfo, loadLatestFirmware, runOta, UPDATE_CHECK_MS, updateApp, updateOtaButton } from './ota.js';
import { applyTargetFields, applyUse, openSettings, refreshSettingsTexts, setTarget, settingChanged } from './settingsui.js';
import { buildGauges, closeReader, openReader, period, render, renderChart, renderConn, renderDebug, toggleConnPop } from './view.js';

function init() {
  applyUse();
  if (!state.demo && !('bluetooth' in navigator)) $('nosupport').hidden = false;

  $('conn').addEventListener('click', (e) => {
    e.stopPropagation();
    if (connected()) toggleConnPop();
    else connect();
  });
  $('btn-disconnect').addEventListener('click', () => { if (state.device) state.device.gatt.disconnect(); toggleConnPop(false); });
  $('dev-name').addEventListener('input', (e) => { setDevInfo({ name: e.target.value.trim() }); render(); });
  document.addEventListener('click', (e) => { if (!$('conn-pop').hidden && !$('conn-pop').contains(e.target)) toggleConnPop(false); });

  $('btn-settings').addEventListener('click', openSettings);
  $('btn-refresh').addEventListener('click', refreshAll);
  $('btn-newp').addEventListener('click', askNewPeriod);
  $('confirm-newp').addEventListener('close', () => { if ($('confirm-newp').returnValue === 'ok') doNewPeriod(); });
  for (const r of document.querySelectorAll('#settings input[name=use]')) r.addEventListener('change', (e) => { settings.use = e.target.value; applyUse(); applyTargetFields(); settingChanged(); });
  for (const r of document.querySelectorAll('#settings input[name=restby]')) r.addEventListener('change', (e) => { settings.restBy = e.target.value; applyTargetFields(); settingChanged(); });
  for (const b of document.querySelectorAll('#settings [data-step]')) {
    b.addEventListener('click', () => setTarget(b.dataset.step, Number($(b.dataset.step).value) + Number(b.dataset.d)));
  }
  for (const id of ['target-vilt', 'target-days']) $(id).addEventListener('change', (e) => setTarget(id, Number(e.target.value)));
  for (const r of document.querySelectorAll('#settings input[name=lang]')) r.addEventListener('change', (e) => { settings.lang = e.target.value; saveSettings(); buildGauges(); render(); loadBuildInfo(); refreshSettingsTexts(); });
  $('smiley-on').addEventListener('change', (e) => { settings.smiley = e.target.checked; settingChanged(); });
  $('graph').addEventListener('toggle', () => renderChart(period()));
  for (const a of document.querySelectorAll('a[data-reader]')) a.addEventListener('click', (e) => { e.preventDefault(); openReader(a.getAttribute('href')); });
  $('btn-reader-close').addEventListener('click', closeReader);
  // «← Appen» inne i læreboka og bruksanvisningen lukker vinduet
  addEventListener('message', (e) => { if (e.origin === location.origin && e.data === 'dg-close-reader') closeReader(); });
  $('fc-on').addEventListener('change', (e) => {
    settings.fcOn = e.target.checked; saveSettings();
    if (settings.fcOn && settings.fcLat === null) askPosition(); else render();
  });
  $('btn-fc-pos').addEventListener('click', askPosition);
  // Menyen lukkes med krysset eller Esc. Enter i et felt skal ikke lukke den.
  $('settings').querySelector('form').addEventListener('submit', (e) => e.preventDefault());
  $('btn-menu-close').addEventListener('click', () => $('settings').close());
  $('btn-hist').addEventListener('click', fetchHistory);
  $('btn-csv').addEventListener('click', downloadCsv);
  $('btn-ota').addEventListener('click', () => runOta('file'));
  $('btn-ota-open').addEventListener('click', async () => {
    try {
      await writeCmd(P.CMD_OTA_OPEN);
      await new Promise((r) => setTimeout(r, 400));   // måleren utfører kommandoen i neste runde
      await readDiag();
      log('Oppdateringsvinduet åpnet fra appen');
    } catch (e) { log(`Åpne vindu feilet: ${e.message}`); }
    updateOtaButton();
    renderDebug();
  });
  $('btn-ota-latest').addEventListener('click', () => runOta('latest'));
  $('btn-ota-check').addEventListener('click', async () => {
    const el = $('ota-checked'), before = state.latest ? state.latest.sha256 : null;
    el.textContent = t('ota.checking');
    await loadLatestFirmware();
    const time = new Date().toLocaleTimeString(locale());
    if (!state.latest) el.textContent = t('ota.checkedNone', { time });
    else if (before && before !== state.latest.sha256) el.textContent = t('ota.checkedNew', { time, v: state.latest.version });
    else el.textContent = t('ota.checkedSame', { time, v: state.latest.version });
  });
  $('ota-file').addEventListener('change', updateOtaButton);

  let rt;
  addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(render, 150); });
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  $('btn-update').addEventListener('click', updateApp);
  checkAppUpdate();
  setInterval(checkAppUpdate, UPDATE_CHECK_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkAppUpdate(); });

  renderConn('off');
  render();
  loadLatestFirmware();
  loadBuildInfo();
  if (state.demo) demoConnect();
}

init();
