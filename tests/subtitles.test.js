'use strict';
const test = require('node:test');
const assert = require('node:assert');
const subs = require('../extension/js/lib/subtitles');
const fillers = require('../extension/js/lib/fillers');
const tl = require('../extension/js/lib/timeline');

function words(text, start, step) {
  return text.split(' ').map((w, i) => ({ start: start + i * step, end: start + i * step + step * 0.9, text: ' ' + w }));
}

test('normalizeWord Türkçe takılmaları tanır', () => {
  const set = fillers.parseFillerList('ı, ımm, hmm, eee, ah');
  ['Iıı', 'ııııı', 'Hmmm', 'hmm...', 'Eee,', 'IMMM', 'ımm'].forEach(w => assert.ok(fillers.isFiller(w, set), w));
  ['ile', 'merhaba', 'evet', 'şey', 'İyi'].forEach(w => assert.ok(!fillers.isFiller(w, set), w));
  assert.strictEqual(fillers.normalizeWord('İSTANBUL'), 'istanbul');
  assert.strictEqual(fillers.normalizeWord('IŞIK'), 'ışık');
});

test('cümle sonu ve karakter sınırına göre bölünür, satırlar dengelenir', () => {
  const w = words('Merhaba arkadaşlar. Bugün çok güzel bir konuğumuz var ve onunla yapay zeka hakkında konuşacağız.', 0, 0.4);
  const cues = subs.buildCues(w, null, null, { maxChars: 32, maxLines: 2 });
  assert.deepStrictEqual(cues[0].lines, ['Merhaba arkadaşlar.']);
  cues.forEach(c => {
    assert.ok(c.lines.length <= 2);
    c.lines.forEach(l => assert.ok(l.length <= 32, l));
  });
  for (let i = 1; i < cues.length; i++) assert.ok(cues[i].start >= cues[i - 1].end);
});

test('takılmalar altyazıdan çıkarılır, kesilen yerler atlanır ve zaman kaydırılır', () => {
  const w = [
    { start: 0, end: 0.5, text: ' Evet' },
    { start: 0.6, end: 1.0, text: ' ııı,' },
    { start: 1.1, end: 1.6, text: ' başlayalım.' },
    { start: 3.0, end: 3.5, text: ' Kesilen' },
    { start: 5.0, end: 5.5, text: ' Devam' }
  ];
  const map = tl.createTimeMap([[0, 2], [4, 6]]);
  const set = fillers.parseFillerList('ı');
  const cues = subs.buildCues(w, map, set, { removeFillers: true, minDurationMs: 0 });
  assert.deepStrictEqual(cues.map(c => c.lines.join(' ')), ['Evet başlayalım.', 'Devam']);
  assert.ok(Math.abs(cues[1].start - 3.0) < 1e-9, String(cues[1].start)); // 5.0 -> 3.0
});

test('kelime sınırı, büyük harf ve noktalama seçenekleri', () => {
  const w = words('bir iki üç dört beş altı', 0, 0.3);
  const cues = subs.buildCues(w, null, null, { maxWords: 2, uppercase: true });
  assert.deepStrictEqual(cues.map(c => c.lines.join(' ')), ['BİR İKİ', 'ÜÇ DÖRT', 'BEŞ ALTI']);
  const c2 = subs.buildCues([{ start: 0, end: 1, text: 'Merhaba,' }, { start: 1, end: 2, text: 'dünya.' }], null, null, { removePunctuation: true });
  assert.strictEqual(c2[0].lines.join(' '), 'Merhaba dünya');
});

test('minimum süre uzatılır ama sonraki altyazıya taşmaz', () => {
  const w = [{ start: 0, end: 0.2, text: 'Evet.' }, { start: 0.5, end: 1.5, text: 'Tamam.' }];
  const cues = subs.buildCues(w, null, null, { minDurationMs: 1000, minGapMs: 40 });
  assert.ok(Math.abs(cues[0].end - 0.46) < 1e-9, String(cues[0].end));
});

test('SRT biçimi', () => {
  const srt = subs.toSrt([{ start: 1.5, end: 3.25, lines: ['Merhaba', 'dünya'] }, { start: 3661.001, end: 3662, lines: ['Son'] }]);
  assert.ok(srt.startsWith('﻿1\r\n00:00:01,500 --> 00:00:03,250\r\nMerhaba\r\ndünya\r\n'));
  assert.ok(srt.includes('2\r\n01:01:01,001 --> 01:01:02,000\r\nSon\r\n'));
});
