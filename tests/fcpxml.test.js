'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');
const fcpxml = require('../extension/js/lib/fcpxml');
const tl = require('../extension/js/lib/timeline');

const impl = { DOMParser, XMLSerializer };
const SRC = fs.readFileSync(path.join(__dirname, 'fixtures', 'premiere_sequence.xml'), 'utf8');
const TPF = 8475667200;

test('kesimler tüm kanallara senkron uygulanır', () => {
  // 0-100 kalsın, 100-200 kesilsin, 200-500 kalsın, 500-600 kesilsin, 600-900 kalsın
  const keep = [[0, 100], [200, 500], [600, 900]];
  const pieces = tl.buildPieces(keep, null);
  const res = fcpxml.transform(SRC, pieces, { sequenceName: 'Yeni Sekans', fps: 30000 / 1001 }, impl);
  assert.strictEqual(res.durationFrames, 700);
  assert.strictEqual(res.stats.transitionsRemoved, 1);

  const d = fcpxml.describe(res.xml, impl);
  assert.strictEqual(d.name, 'Yeni Sekans');
  assert.strictEqual(d.duration, 700);

  // V2 (kamera A): kaynak in 100'den başlıyor
  assert.deepStrictEqual(d.video[1].map(c => [c.start, c.end, c.in, c.out]), [
    [0, 100, 100, 200],
    [100, 400, 300, 600],
    [400, 700, 700, 1000]
  ]);
  // A1 aynı kesimlere sahip (senkron)
  assert.deepStrictEqual(d.audio[0].map(c => [c.start, c.end, c.in, c.out]), d.video[1].map(c => [c.start, c.end, c.in, c.out]));

  // V1 iki klipten oluşuyordu: [0,450) in 0 ve [450,900) in 600
  assert.deepStrictEqual(d.video[0].map(c => [c.start, c.end, c.in, c.out]), [
    [0, 100, 0, 100],
    [100, 350, 200, 450],
    [350, 400, 600, 650],
    [400, 700, 750, 1050]
  ]);

  // Toplam süre her kanalda aynı
  [...d.video, ...d.audio].forEach(track => {
    assert.strictEqual(track[track.length - 1].end, 700);
    for (let i = 1; i < track.length; i++) assert.strictEqual(track[i].start, track[i - 1].end);
  });
});

test('pproTicks değerleri yeni giriş/çıkışla güncellenir', () => {
  const pieces = tl.buildPieces([[0, 100], [200, 900]], null);
  const res = fcpxml.transform(SRC, pieces, {}, impl);
  const doc = new DOMParser().parseFromString(res.xml, 'text/xml');
  const items = Array.from(doc.getElementsByTagName('clipitem'));
  items.forEach(ci => {
    const get = tag => Number(ci.getElementsByTagName(tag)[0].textContent);
    assert.strictEqual(get('pproTicksIn'), get('in') * TPF, 'ticksIn ' + ci.getAttribute('id'));
    assert.strictEqual(get('pproTicksOut'), get('out') * TPF, 'ticksOut ' + ci.getAttribute('id'));
  });
});

test('dosya tanımları: ilk geçişte tam, sonrakilerde referans', () => {
  const pieces = tl.buildPieces([[0, 100], [200, 900]], null);
  const res = fcpxml.transform(SRC, pieces, {}, impl);
  const doc = new DOMParser().parseFromString(res.xml, 'text/xml');
  const files = Array.from(doc.getElementsByTagName('file'));
  const seen = {};
  files.forEach(f => {
    const id = f.getAttribute('id');
    const full = Array.from(f.childNodes).some(n => n.nodeType === 1);
    if (!seen[id]) {
      assert.ok(full, id + ' ilk geçişte tam tanımlı olmalı');
      seen[id] = true;
    } else {
      assert.ok(!full, id + ' sonraki geçişlerde referans olmalı');
    }
  });
  assert.deepStrictEqual(Object.keys(seen).sort(), ['file-1', 'file-2', 'file-3']);
});

test('ilk parça tamamen kesilse bile dosya tanımı korunur', () => {
  // V1'in ilk klibi (tam tanımlı) tamamen kesiliyor
  const pieces = tl.buildPieces([[450, 900]], null);
  const res = fcpxml.transform(SRC, pieces, {}, impl);
  const d = fcpxml.describe(res.xml, impl);
  assert.strictEqual(d.video[0].length, 1);
  assert.strictEqual(d.video[0][0].fileId, 'file-1');
  assert.ok(d.video[0][0].fullFile, 'kalan klip tam tanımı almalı');
});

test('bağlantılar (link) yeni kimliklere taşınır ve tutarlıdır', () => {
  const pieces = tl.buildPieces([[0, 100], [200, 900]], null);
  const res = fcpxml.transform(SRC, pieces, {}, impl);
  const d = fcpxml.describe(res.xml, impl);
  const all = {};
  [...d.video, ...d.audio].forEach(tr => tr.forEach(c => { all[c.id] = c; }));
  d.video[1].forEach((v, i) => {
    const a = d.audio[0][i];
    assert.deepStrictEqual(v.links.slice().sort(), [v.id, a.id].sort());
    assert.deepStrictEqual(a.links.slice().sort(), [v.id, a.id].sort());
  });
  Object.values(all).forEach(c => c.links.forEach(l => assert.ok(all[l], 'eksik link hedefi ' + l)));
});

test('sekans işaretçileri yeniden zamanlanır, kesilenler silinir', () => {
  const pieces = tl.buildPieces([[0, 100], [200, 900]], null);
  const res = fcpxml.transform(SRC, pieces, {}, impl);
  const doc = new DOMParser().parseFromString(res.xml, 'text/xml');
  const markers = Array.from(doc.getElementsByTagName('marker'));
  assert.strictEqual(markers.length, 1);
  assert.strictEqual(markers[0].getElementsByTagName('in')[0].textContent, '200');
  assert.ok(!res.xml.includes('<uuid>'));
  assert.ok(res.xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>'));
});

test('çoklu kamera: pasif açılar devre dışı bırakılır', () => {
  // kurgu zamanında: 0-300 kamera V2 (index 1), 300-900 kamera V3 (index 2)
  const pieces = tl.buildPieces([[0, 900]], [{ start: 0, end: 300, cam: 1 }, { start: 300, end: 900, cam: 2 }]);
  const res = fcpxml.transform(SRC, pieces, { cameraTracks: [1, 2], inactiveMode: 'disable' }, impl);
  const d = fcpxml.describe(res.xml, impl);
  assert.deepStrictEqual(d.video[1].map(c => [c.start, c.end, c.enabled]), [[0, 300, true], [300, 900, false]]);
  assert.deepStrictEqual(d.video[2].map(c => [c.start, c.end, c.enabled]), [[0, 300, false], [300, 900, true]]);
  // V1 kamera kanalı değil: dokunulmaz (iki klip, geçiş silinmiş)
  assert.deepStrictEqual(d.video[0].map(c => [c.start, c.end, c.enabled]), [[0, 450, true], [450, 900, true]]);
  // Ses kesintisiz kalır
  assert.deepStrictEqual(d.audio[0].map(c => [c.start, c.end]), [[0, 900]]);
  const all = {};
  [...d.video, ...d.audio].forEach(tr => tr.forEach(c => { all[c.id] = c; }));
  Object.values(all).forEach(c => c.links.forEach(l => {
    assert.ok(all[l], 'eksik link hedefi ' + l);
    assert.deepStrictEqual(all[l].links.slice().sort(), c.links.slice().sort(), 'tutarsız link grubu');
  }));
});

test('çoklu kamera: pasif açılar silinebilir', () => {
  const pieces = tl.buildPieces([[0, 900]], [{ start: 0, end: 300, cam: 1 }, { start: 300, end: 900, cam: 2 }]);
  const res = fcpxml.transform(SRC, pieces, { cameraTracks: [1, 2], inactiveMode: 'remove' }, impl);
  const d = fcpxml.describe(res.xml, impl);
  assert.deepStrictEqual(d.video[1].map(c => [c.start, c.end]), [[0, 300]]);
  assert.deepStrictEqual(d.video[2].map(c => [c.start, c.end]), [[300, 900]]);
  assert.ok(d.video[2][0].fullFile, 'file-3 tanımı silinen kliple kaybolmamalı');
});

test('geçersiz XML anlaşılır hata verir', () => {
  assert.throws(() => fcpxml.transform('<foo/>', [], {}, impl), /XML/);
});
