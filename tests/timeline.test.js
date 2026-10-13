'use strict';
const test = require('node:test');
const assert = require('node:assert');
const tl = require('../extension/js/lib/timeline');

test('mergeRanges birleştirir ve sıralar', () => {
  assert.deepStrictEqual(tl.mergeRanges([[5, 6], [1, 2], [1.5, 3], [6, 7]]), [[1, 3], [5, 7]]);
  assert.deepStrictEqual(tl.mergeRanges([[1, 2], [2.05, 3]], 0.1), [[1, 3]]);
  assert.deepStrictEqual(tl.mergeRanges([[3, 3]]), []);
});

test('invertRanges kalan bölümleri üretir', () => {
  assert.deepStrictEqual(tl.invertRanges([[1, 2], [4, 5]], 6), [[0, 1], [2, 4], [5, 6]]);
  assert.deepStrictEqual(tl.invertRanges([[0, 1], [5, 7]], 6), [[1, 5]]);
  assert.deepStrictEqual(tl.invertRanges([], 3), [[0, 3]]);
});

test('secondsToFrames yuvarlar ve boşları atar', () => {
  assert.deepStrictEqual(tl.secondsToFrames([[0, 1], [1.001, 1.01], [2, 3]], 30), [[0, 30], [60, 90]]);
});

test('createTimeMap orijinal <-> kurgu eşlemesi', () => {
  const m = tl.createTimeMap([[0, 1], [2, 4], [5, 6]]);
  assert.strictEqual(m.duration, 4);
  assert.strictEqual(m.toEdited(0.5), 0.5);
  assert.strictEqual(m.toEdited(1.5), 1);      // kesilen bölge -> sonraki başlangıç
  assert.strictEqual(m.toEdited(3), 2);
  assert.strictEqual(m.toEdited(5.5), 3.5);
  assert.strictEqual(m.toOrig(2), 3);
  assert.strictEqual(m.toOrig(3.5), 5.5);
  assert.ok(m.isKept(2.5));
  assert.ok(!m.isKept(4.5));
});

test('buildPieces kamera çekimlerine göre böler', () => {
  const keep = [[0, 100], [200, 300]];
  const shots = [{ start: 0, end: 50, cam: 1 }, { start: 50, end: 150, cam: 2 }, { start: 150, end: 200, cam: 1 }];
  const p = tl.buildPieces(keep, shots);
  assert.deepStrictEqual(p, [
    { origStart: 0, origEnd: 50, outStart: 0, cam: 1 },
    { origStart: 50, origEnd: 100, outStart: 50, cam: 2 },
    { origStart: 200, origEnd: 250, outStart: 100, cam: 2 },
    { origStart: 250, origEnd: 300, outStart: 150, cam: 1 }
  ]);
  const plain = tl.buildPieces(keep, null);
  assert.deepStrictEqual(plain.map(x => [x.origStart, x.origEnd, x.outStart, x.cam]), [[0, 100, 0, -1], [200, 300, 100, -1]]);
});
