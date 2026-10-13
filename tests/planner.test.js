'use strict';
const test = require('node:test');
const assert = require('node:assert');
const planner = require('../extension/js/lib/planner');
const { makeAnalysis, settings } = require('./helpers');

const near = (a, b, eps = 0.011) => Math.abs(a - b) <= eps;

// Konuşma: 0-2, 3-5 (1 sn boşluk), 5.3-7 (0.3 sn doğal duraklama), 9-10 (2 sn boşluk), sonra 10-12 sessiz
const SPEECH = [[0, 2, -20], [3, 5, -20], [5.3, 7, -20], [9, 10, -20]];

test('boşluklar paylarla birlikte kesilir, kısa duraklamalar korunur', () => {
  const an = makeAnalysis(12, [SPEECH]);
  const s = settings({
    'tasks.fillers': false, 'silence.autoThreshold': false, 'silence.thresholdDb': -40,
    'silence.minSilenceMs': 450, 'silence.keepAfterMs': 100, 'silence.keepBeforeMs': 50, 'silence.minCutMs': 100
  });
  const p = planner.plan(an, s, {});
  const cuts = p.rows.filter(r => r.enabled).map(r => [r.start, r.end]);
  assert.strictEqual(cuts.length, 3);
  assert.ok(near(cuts[0][0], 2.1) && near(cuts[0][1], 2.95), JSON.stringify(cuts[0]));
  assert.ok(near(cuts[1][0], 7.1) && near(cuts[1][1], 8.95), JSON.stringify(cuts[1]));
  // sondaki sessizlik: konuşmadan sonra pay bırakılır, sona kadar kesilir
  assert.ok(near(cuts[2][0], 10.1) && cuts[2][1] >= 12, JSON.stringify(cuts[2]));
  // yeni süre ≈ 12 - (0.85 + 1.85 + 1.9+)
  assert.ok(p.newDuration > 7.2 && p.newDuration < 7.5, String(p.newDuration));
  // kalan bölümler kare sınırlarında
  p.keepFrames.forEach(r => { assert.ok(Number.isInteger(r[0]) && Number.isInteger(r[1])); });
});

test('kapatılan (disabled) boşluk kesilmez', () => {
  const an = makeAnalysis(12, [SPEECH]);
  const s = settings({ 'tasks.fillers': false, 'silence.autoThreshold': false, 'silence.thresholdDb': -40 });
  const p1 = planner.plan(an, s, {});
  const first = p1.rows[0];
  const p2 = planner.plan(an, s, { [first.id]: true });
  assert.strictEqual(p2.rows.find(r => r.id === first.id).enabled, false);
  assert.strictEqual(p2.rows.filter(r => r.enabled).length, p1.rows.length - 1);
  assert.ok(p2.newDuration > p1.newDuration);
});

test('otomatik eşik gürültü ile konuşma arasında kalır', () => {
  const an = makeAnalysis(12, [SPEECH]);
  const thr = planner.computeThreshold(an, settings().silence);
  assert.ok(thr > -65 && thr < -20, String(thr));
});

test('yapay zeka takılması (ııı) çevresindeki boşlukla birlikte kesilir', () => {
  // "merhaba [0.3 sn] ııı [0.3 sn] bugün": takılma 2.3-2.8 arası ayrı bir ses adası
  const segs = [[0, 2, -20], [2.3, 2.8, -24], [3.1, 5, -20]];
  const words = [
    { start: 0.1, end: 1.9, text: ' merhaba' },
    { start: 2.32, end: 2.75, text: ' Iıı,' },
    { start: 3.1, end: 4.9, text: ' bugün' }
  ];
  const an = makeAnalysis(5, [segs], { words });
  const s = settings({
    'silence.autoThreshold': false, 'silence.thresholdDb': -40, 'silence.keepAfterMs': 100, 'silence.keepBeforeMs': 80
  });
  const p = planner.plan(an, s, {});
  const fill = p.rows.filter(r => r.type === 'filler');
  assert.strictEqual(fill.length, 1);
  assert.ok(near(fill[0].start, 2.1) && near(fill[0].end, 3.02), JSON.stringify(fill[0]));
  assert.ok(fill[0].context.includes('[Iıı,]'));
  // Takılma görevi kapalıyken aynı bölge kesilmez (boşluklar < minSilence)
  const p2 = planner.plan(an, settings({ 'tasks.fillers': false, 'silence.autoThreshold': false, 'silence.thresholdDb': -40 }), {});
  assert.strictEqual(p2.rows.length, 0);
});

test('kelimeye bitişik takılma küçük kenar payıyla kesilir', () => {
  // "ve-eee" — takılma konuşmaya bitişik (araya sessizlik yok)
  const segs = [[0, 3, -20]];
  const words = [
    { start: 0.0, end: 1.0, text: ' ve' },
    { start: 1.0, end: 1.6, text: ' eee' },
    { start: 1.6, end: 3.0, text: ' sonra' }
  ];
  const an = makeAnalysis(3, [segs], { words });
  const s = settings({ 'silence.autoThreshold': false, 'silence.thresholdDb': -40, 'fillers.edgePadMs': 20 });
  const p = planner.plan(an, s, {});
  const f = p.rows.filter(r => r.type === 'filler');
  assert.strictEqual(f.length, 1);
  assert.ok(near(f[0].start, 1.02) && near(f[0].end, 1.58), JSON.stringify(f[0]));
});

test('takılma listesinde olmayan kelimeler kesilmez', () => {
  const segs = [[0, 1, -20], [1.3, 1.8, -20], [2.1, 3, -20]];
  const words = [{ start: 0, end: 1, text: 'bir' }, { start: 1.3, end: 1.8, text: 'evet' }, { start: 2.1, end: 3, text: 'iki' }];
  const an = makeAnalysis(3, [segs], { words });
  const p = planner.plan(an, settings({ 'silence.autoThreshold': false, 'silence.thresholdDb': -40 }), {});
  assert.strictEqual(p.rows.filter(r => r.type === 'filler').length, 0);
});

test('çoklu kamera: konuşan kişinin kamerası seçilir', () => {
  // A1 (konuşmacı 1) 0-6 sn, A2 (konuşmacı 2) 6-12 sn konuşuyor; karşı mikrofona -18 dB sızıntı
  const t1 = [[0, 6, -20], [6, 12, -38]];
  const t2 = [[0, 6, -38], [6, 12, -20]];
  const an = makeAnalysis(12, [t1, t2]);
  const s = settings({
    'tasks.silence': false, 'tasks.fillers': false, 'tasks.multicam': true,
    'multicam.speakers': { 0: 1, 1: 2 }, 'multicam.wideTrack': 0, 'multicam.anticipateMs': 0, 'multicam.minShotMs': 1000
  });
  const p = planner.plan(an, s, {});
  assert.strictEqual(p.shots.length, 2, JSON.stringify(p.shots));
  assert.strictEqual(p.shots[0].cam, 1);
  assert.strictEqual(p.shots[1].cam, 2);
  assert.ok(Math.abs(p.shots[1].start - 6) < 0.3, JSON.stringify(p.shots));
  assert.strictEqual(p.cameraSwitches, 1);
  // parçalar kamera bilgisini taşır
  assert.deepStrictEqual(p.pieces.map(x => x.cam), [1, 2]);
});

test('çoklu kamera: kısa araya girmeler kamera değiştirmez, örtüşmede geniş açı', () => {
  // konuşmacı 2, 3. saniyede 0.3 sn "evet" diyor; 8-10 arası ikisi birden konuşuyor
  const t1 = [[0, 12, -20]];
  const t2 = [[3, 3.3, -19], [8, 10, -20]];
  const an = makeAnalysis(12, [t1, t2]);
  const s = settings({
    'tasks.silence': false, 'tasks.fillers': false, 'tasks.multicam': true,
    'multicam.speakers': { 0: 1, 1: 2 }, 'multicam.wideTrack': 0, 'multicam.holdMs': 700,
    'multicam.minShotMs': 1000, 'multicam.anticipateMs': 0
  });
  const p = planner.plan(an, s, {});
  const cams = p.shots.map(x => x.cam);
  assert.deepStrictEqual(cams, [1, 0, 1], JSON.stringify(p.shots));
  assert.ok(Math.abs(p.shots[1].start - 8) < 0.3);
});

test('çoklu kamera: uzun çekimlere ara plan eklenir', () => {
  const an = makeAnalysis(40, [[[0, 40, -20]], [[0, 40, -45]]]);
  const s = settings({
    'tasks.silence': false, 'tasks.fillers': false, 'tasks.multicam': true,
    'multicam.speakers': { 0: 1, 1: 2 }, 'multicam.wideTrack': 0,
    'multicam.maxShotMs': 15000, 'multicam.cutawayMs': 3000, 'multicam.minShotMs': 2000
  });
  const p = planner.plan(an, s, {});
  assert.deepStrictEqual(p.shots.map(x => x.cam), [1, 0, 1, 0, 1]);
  p.shots.forEach(sh => assert.ok(sh.end - sh.start >= 2.9));
  const s2 = settings({
    'tasks.silence': false, 'tasks.fillers': false, 'tasks.multicam': true,
    'multicam.speakers': { 0: 1, 1: 2 }, 'multicam.wideTrack': -1, 'multicam.cutawayTarget': 'listener',
    'multicam.maxShotMs': 15000, 'multicam.cutawayMs': 3000
  });
  assert.deepStrictEqual(planner.plan(an, s2, {}).shots.map(x => x.cam), [1, 2, 1, 2, 1]);
});
