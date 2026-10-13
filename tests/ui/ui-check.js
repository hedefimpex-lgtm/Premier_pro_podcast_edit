'use strict';
/**
 * Panel arayüz testi (Playwright + Chromium). Premiere ve Node API'leri taklit edilir.
 * Çalıştırma: node tests/ui/ui-check.js [ekran-görüntüsü-klasörü]
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) {
  try { ({ chromium } = require(path.join(require('child_process').execSync('npm root -g').toString().trim(), 'playwright'))); } catch (e2) {
    console.log('playwright bulunamadı, arayüz testi atlandı'); process.exit(0);
  }
}
const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');
const fcpxml = require('../../extension/js/lib/fcpxml');

const ROOT = path.join(__dirname, '..', '..');
const EXT = path.join(ROOT, 'extension');
const OUT = process.argv[2] || path.join(ROOT, 'tests', 'ui', 'shots');
fs.mkdirSync(OUT, { recursive: true });

const sources = {};
fs.readdirSync(path.join(EXT, 'js', 'lib')).forEach(f => { sources[f] = fs.readFileSync(path.join(EXT, 'js', 'lib', f), 'utf8'); });
sources['pipeline.js'] = fs.readFileSync(path.join(__dirname, 'mock-pipeline.js'), 'utf8');
const fixture = fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'premiere_sequence.xml'), 'utf8');
const shim = fs.readFileSync(path.join(__dirname, 'shim.js'), 'utf8');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 420, height: 980 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.addInitScript(({ sources, fixture, shim }) => {
    window.__PK_SOURCES__ = sources;
    window.__PK_FIXTURE__ = fixture;
    new Function(shim)();
  }, { sources, fixture, shim });
  await page.goto('file://' + path.join(EXT, 'index.html'));
  await page.waitForFunction(() => document.querySelector('#seqLabel').textContent.includes('Bölüm 12'));
  assert.strictEqual(await page.locator('#trackList .trk').count(), 3);
  await page.screenshot({ path: path.join(OUT, '01-baslangic.png') });

  // Görevler: altyazı + çoklu kamera
  await page.check('[data-k="tasks.subtitles"]');
  await page.check('[data-k="tasks.multicam"]');
  await page.click('[data-tab="cams"]');
  await page.selectOption('[data-spk="0"]', '1');
  await page.selectOption('[data-spk="1"]', '2');
  await page.selectOption('#wideSelect', '0');
  await page.screenshot({ path: path.join(OUT, '05-kamera.png'), fullPage: true });
  await page.click('[data-tab="main"]');

  await page.click('#btnAnalyze');
  await page.waitForSelector('#resultCard:not(.hidden)');
  const stNew = await page.textContent('#stNew');
  const stOrig = await page.textContent('#stOrig');
  assert.ok(stOrig === '0:30', stOrig);
  const plan = await page.evaluate(() => {
    const p = window.PKApp.state.plan;
    return { rows: p.rows.map(r => ({ id: r.id, type: r.type, enabled: r.enabled, start: r.start, end: r.end, label: r.label })), shots: p.shots, newDuration: p.newDuration };
  });
  console.log('Kesimler:', plan.rows.map(r => `${r.type}:${r.start.toFixed(2)}-${r.end.toFixed(2)}${r.label !== 'Boşluk' ? ' ' + r.label : ''}`).join(', '));
  console.log('Çekimler:', plan.shots.map(s => `V${s.cam + 1}@${s.start.toFixed(2)}`).join(' '));
  assert.ok(plan.rows.some(r => r.type === 'filler' && /Iıı/.test(r.label)), 'ııı takılması bulunmalı');
  assert.ok(plan.rows.some(r => r.type === 'filler' && /Hmm/.test(r.label)), 'hmm takılması bulunmalı');
  assert.ok(plan.shots.length >= 2 && plan.shots[0].cam === 1, 'ilk çekim sunucu kamerası olmalı');
  assert.ok(plan.shots.some(s => s.cam === 2), 'konuk kamerası kullanılmalı');
  console.log('Yeni süre:', stNew);
  await page.screenshot({ path: path.join(OUT, '02-sonuc.png'), fullPage: true });

  // İnce ayar: en kısa boşluk kaydırıcısı
  const before = await page.evaluate(() => window.PKApp.state.plan.rows.length);
  await page.evaluate(() => {
    const el = document.querySelector('[data-k="silence.minSilenceMs"]');
    el.value = '2500';
    el.dispatchEvent(new Event('input'));
  });
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => window.PKApp.state.plan.rows.length);
  assert.ok(after < before, `kaydırıcı plana yansımalı (${before} -> ${after})`);
  await page.evaluate(() => {
    const el = document.querySelector('[data-k="silence.minSilenceMs"]');
    el.value = '450';
    el.dispatchEvent(new Event('input'));
  });
  await page.waitForTimeout(300);

  // Bir satırı kapat
  const enabledBefore = await page.evaluate(() => window.PKApp.state.plan.rows.filter(r => r.enabled).length);
  await page.locator('#rows .rowi input').first().uncheck();
  await page.waitForTimeout(100);
  const enabledAfter = await page.evaluate(() => window.PKApp.state.plan.rows.filter(r => r.enabled).length);
  assert.strictEqual(enabledAfter, enabledBefore - 1);
  await page.locator('#rows .rowi input').first().check();

  // Oynatma kafası
  await page.locator('#rows .rowi button').nth(1).click();
  await page.waitForFunction(() => window.__PK_PLAYHEAD__ !== undefined);

  // Uygula: yeni sekans + altyazı
  await page.click('#btnApply');
  await page.waitForFunction(() => window.__PK_IMPORTED_XML__ && window.__PK_SRT__, null, { timeout: 5000 });
  const xml = await page.evaluate(() => window.__PK_IMPORTED_XML__);
  const srt = await page.evaluate(() => window.__PK_SRT__);
  const d = fcpxml.describe(xml, { DOMParser, XMLSerializer });
  const fps = 30000 / 1001;
  const expectFrames = Math.round(plan.newDuration * fps);
  assert.ok(Math.abs(d.duration - expectFrames) <= 1, `${d.duration} vs ${expectFrames}`);
  assert.ok(d.name.endsWith(' - Podcast Kurgu'), d.name);
  [...d.video, ...d.audio].forEach(tr => {
    for (let i = 1; i < tr.length; i++) assert.ok(tr[i].start >= tr[i - 1].end, 'çakışan klip');
  });
  // her an tek bir kamera kanalı etkin olmalı (V1 geniş, V2 sunucu, V3 konuk)
  for (let f = 0; f < d.duration; f += 7) {
    const on = [0, 1, 2].filter(v => d.video[v].some(c => c.enabled && c.start <= f && f < c.end));
    assert.strictEqual(on.length, 1, `kare ${f}: etkin kameralar ${on}`);
  }
  assert.strictEqual(srt.seq, 'seq-new');
  assert.ok(srt.text.includes('-->') && !/Iıı|Hmm/.test(srt.text), 'altyazı takılmasız olmalı');
  console.log('Altyazı:\n' + srt.text.replace(/\r/g, '').split('\n').slice(0, 12).join('\n'));
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT, '03-uygulandi.png'), fullPage: true });

  // İşaretçi modu
  await page.check('input[name=outMode][value=markers]');
  await page.click('#btnApply');
  await page.waitForFunction(() => window.__PK_MARKERS__);
  const markers = await page.evaluate(() => window.__PK_MARKERS__);
  assert.ok(markers.length >= plan.rows.filter(r => r.enabled).length);

  // Diğer düğmeler: SRT/transkript kaydet, hazır ayar, yeniden analiz uyarısı, sıfırlama
  await page.check('input[name=outMode][value=sequence]');
  await page.click('#btnSaveSrt');
  await page.click('#btnSaveTxt');
  const saved = await page.evaluate(() => Object.keys(window.__PK_FS__).filter(f => /\.(srt|txt)$/.test(f)));
  assert.ok(saved.some(f => f.endsWith('.srt')) && saved.some(f => f.endsWith('-transkript.txt')), saved.join(','));
  await page.selectOption('#presetSelect', 'agresif');
  assert.strictEqual(await page.evaluate(() => window.PKApp.state.settings.silence.minSilenceMs), 200);
  await page.click('[data-tab="fillers"]');
  await page.selectOption('[data-k="fillers.method"]', 'acoustic');
  await page.click('[data-tab="main"]');
  assert.ok(await page.isVisible('#needReanalyze'), 'akustik yöntem yeniden analiz uyarısı göstermeli');
  await page.selectOption('[data-k="fillers.method"]', 'auto').catch(() => {});
  await page.evaluate(() => { const el = document.querySelector('[data-k="fillers.method"]'); el.value = 'auto'; el.dispatchEvent(new Event('change')); });
  assert.ok(!(await page.isVisible('#needReanalyze')));
  await page.click('#btnClearMarkers');
  await page.click('[data-tab="setup"]');
  await page.click('#btnReset');
  assert.strictEqual(await page.evaluate(() => window.PKApp.state.settings.silence.minSilenceMs), 450);
  await page.click('[data-tab="main"]');
  await page.screenshot({ path: path.join(OUT, '09-son.png'), fullPage: true });

  for (const [tab, file] of [['silence', '04-bosluk'], ['fillers', '06-takilma'], ['subs', '07-altyazi'], ['setup', '08-ayarlar']]) {
    await page.click(`[data-tab="${tab}"]`);
    await page.screenshot({ path: path.join(OUT, file + '.png'), fullPage: true });
  }

  await browser.close();
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exit(1);
  }
  console.log('Arayüz testi başarılı. Ekran görüntüleri: ' + OUT);
})().catch(e => { console.error(e); process.exit(1); });
