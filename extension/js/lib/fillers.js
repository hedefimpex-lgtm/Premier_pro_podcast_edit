'use strict';
/**
 * Takılma (ıı, mmm, eee, hmm...) tespiti.
 *  1) Yapay zeka (Whisper) kelimelerinin takılma listesiyle eşlenmesi
 *  2) Akustik yöntem: sabit perdeli, sabit tınılı uzun ünlüleri (ıııı, mmmm) bulma
 */
var audio = require('./audio');

var LETTERS = /[^a-zçğıöşüâêîôûäëïéèáàíóúñ]/g;

/** Türkçe'ye uygun küçük harf + noktalama temizliği + tekrar eden harfleri tekleştirme. */
function normalizeWord(word) {
  if (!word) return '';
  var w = String(word).replace(/I/g, 'ı').replace(/İ/g, 'i').toLowerCase();
  w = w.replace(LETTERS, '');
  return w.replace(/(.)\1+/g, '$1');
}

/** "ıı, hmm, eee" gibi bir listeyi normalize edilmiş kümeye çevirir. */
function parseFillerList(text) {
  var set = {};
  String(text || '').split(/[,;\n]+/).forEach(function (part) {
    var n = normalizeWord(part.trim());
    if (n) set[n] = true;
  });
  return set;
}

function isFiller(word, set) {
  var n = normalizeWord(word);
  return !!(n && set[n]);
}

/**
 * Konuşma maskesinden "konuşma adacıklarını" (kesintisiz konuşma bölgeleri) çıkarır.
 * Dönüş: [[başKare, bitişKare), ...]
 */
function islandsFromMask(mask) {
  var out = [];
  var n = mask.length;
  var i = 0;
  while (i < n) {
    if (!mask[i]) { i++; continue; }
    var s = i;
    while (i < n && mask[i]) i++;
    out.push([s, i]);
  }
  return out;
}

/** Aralığı kapsayan/kesen adacıkları bulur (ikili arama). */
function islandsOverlapping(islands, a, b) {
  var lo = 0, hi = islands.length - 1, first = islands.length;
  while (lo <= hi) {
    var mid = (lo + hi) >> 1;
    if (islands[mid][1] > a) { first = mid; hi = mid - 1; } else { lo = mid + 1; }
  }
  var res = [];
  for (var i = first; i < islands.length && islands[i][0] < b; i++) res.push(islands[i]);
  return res;
}

/**
 * Whisper kelimelerinden takılmaları bulur.
 * words: [{start, end, text}] (sn), mask: konuşma maskesi (10 ms kareler)
 * Dönüş: [{a, b, text, source:'ai'}] (kare)
 */
function findAsrFillers(words, fillerSet, mask, opts) {
  var hop = audio.HOP_SEC;
  var islands = islandsFromMask(mask);
  var minF = Math.round((opts.minMs || 0) / 1000 / hop);
  var maxF = Math.round((opts.maxMs || 2500) / 1000 / hop);
  var out = [];
  for (var i = 0; i < words.length; i++) {
    var w = words[i];
    if (!isFiller(w.text, fillerSet)) continue;
    var a = Math.max(0, Math.floor(w.start / hop));
    var b = Math.min(mask.length, Math.ceil(w.end / hop));
    if (b <= a) continue;
    // Kelimenin kapladığı konuşma adacıklarını kontrol et: takılma bir adacığın çoğunu
    // kaplıyorsa sınırları adacığa (sessizlik kenarlarına) oturt.
    var isl = islandsOverlapping(islands, a, b);
    var ra = a, rb = b;
    if (isl.length === 1) {
      var I = isl[0];
      var ov = Math.min(b, I[1]) - Math.max(a, I[0]);
      if (ov >= 0.5 * (I[1] - I[0]) && (I[1] - I[0]) <= maxF) {
        ra = I[0];
        rb = I[1];
      } else {
        ra = Math.max(a, I[0]);
        rb = Math.min(b, I[1]);
      }
    } else if (isl.length === 0) {
      continue; // sessizliğe denk gelen "takılma": zaten boşluk olarak işlenir
    }
    var len = rb - ra;
    if (len < minF || len > maxF) continue;
    out.push({ a: ra, b: rb, text: (w.text || '').trim(), source: 'ai', wordIndex: i });
  }
  return out;
}

/** Bir sonraki olay döngüsüne kadar bekler (arayüz donmasın). */
function yieldUI() {
  return new Promise(function (r) { setTimeout(r, 0); });
}

var SHAPE_LAGS = 12;

/**
 * Akustik özellikleri hesaplar (yalnızca gateDb üstündeki karelerde, 20 ms adımla).
 * pcm: 16 kHz Int16Array, env: kare başına dB.
 * Dönüş: { voicing, pitch, shapeDist } — her biri env uzunluğunda Float32Array
 */
async function computeAcousticFeatures(pcm, env, gateDb, onProgress, cancel) {
  var n = env.length;
  var voicing = new Float32Array(n);
  var pitch = new Float32Array(n);
  var shapeDist = new Float32Array(n).fill(1);
  var W = 200;          // 25 ms @ 8 kHz
  var KMIN = 20;        // 400 Hz
  var KMAX = 110;       // ~73 Hz
  var buf = new Float32Array(W + KMAX);
  var r = new Float32Array(KMAX + 1);
  var pre = new Float32Array(W + 1);
  var shape = new Float32Array(SHAPE_LAGS);
  var lastShape = new Float32Array(SHAPE_LAGS);
  var hasPrev = false;

  for (var i = 0; i < n; i += 2) {
    if (cancel && cancel.cancelled) throw new Error('İptal edildi');
    if ((i & 8191) === 0) {
      if (onProgress) onProgress(i / n);
      await yieldUI();
    }
    if (env[i] < gateDb) { hasPrev = false; continue; }
    // 8 kHz'e indir (ikili ortalama) ve DC'yi çıkar
    var base = i * audio.HOP; // 16 kHz örnek indeksi
    var mean = 0;
    for (var j = 0; j < W; j++) {
      var p = base + 2 * j;
      var v = p + 1 < pcm.length ? (pcm[p] + pcm[p + 1]) * 0.5 : 0;
      buf[j] = v;
      mean += v;
    }
    mean /= W;
    pre[0] = 0;
    for (j = 0; j < W; j++) {
      buf[j] -= mean;
      pre[j + 1] = pre[j] + buf[j] * buf[j];
    }
    var e0 = pre[W];
    if (e0 <= 1e-3) { hasPrev = false; continue; }
    // Otokorelasyon: tını için düşük gecikmeler, perde için KMIN..KMAX
    for (var k = 0; k <= KMAX; k++) {
      if (k > SHAPE_LAGS && k < KMIN) continue;
      var s = 0;
      for (j = 0; j < W - k; j++) s += buf[j] * buf[j + k];
      r[k] = s;
    }
    var best = -1, bestVal = 0;
    for (k = KMIN; k <= KMAX; k++) {
      var ea = pre[W - k];
      var eb = pre[W] - pre[k];
      var den = Math.sqrt(ea * eb);
      var c = den > 0 ? r[k] / den : 0;
      if (c > bestVal) { bestVal = c; best = k; }
    }
    var f0 = 0;
    if (best > KMIN && best < KMAX) {
      // parabolik iyileştirme
      var y0 = r[best - 1], y1 = r[best], y2 = r[best + 1];
      var d = (y0 - 2 * y1 + y2);
      var shift = d !== 0 ? 0.5 * (y0 - y2) / d : 0;
      if (shift > 1 || shift < -1) shift = 0;
      f0 = 8000 / (best + shift);
    } else if (best > 0) {
      f0 = 8000 / best;
    }
    for (k = 0; k < SHAPE_LAGS; k++) shape[k] = r[k + 1] / r[0];
    var dist = 1;
    if (hasPrev) {
      var acc = 0;
      for (k = 0; k < SHAPE_LAGS; k++) {
        var dd = shape[k] - lastShape[k];
        acc += dd * dd;
      }
      dist = Math.sqrt(acc / SHAPE_LAGS);
    }
    lastShape.set(shape);
    hasPrev = true;
    voicing[i] = bestVal;
    pitch[i] = f0;
    shapeDist[i] = dist;
    if (i + 1 < n) {
      voicing[i + 1] = bestVal;
      pitch[i + 1] = f0;
      shapeDist[i + 1] = dist;
    }
  }
  if (onProgress) onProgress(1);
  return { voicing: voicing, pitch: pitch, shapeDist: shapeDist };
}

/**
 * Akustik özelliklerden takılma adaylarını bulur.
 * Dönüş: [{a, b, text, source:'acoustic'}] (kare)
 */
function findAcousticFillers(features, mask, opts) {
  var hop = audio.HOP_SEC;
  var s = Math.max(0, Math.min(1, opts.sensitivity == null ? 0.5 : opts.sensitivity));
  var voicedMin = 0.78 - 0.2 * s;
  var shapeTol = 0.035 + 0.07 * s;
  var pitchTol = 1.0 + 2.0 * s; // yarım ton
  var minF = Math.max(5, Math.round((opts.minMs || 350) / 1000 / hop));
  var maxF = Math.round((opts.maxMs || 2500) / 1000 / hop);
  var islands = islandsFromMask(mask);
  var out = [];
  var n = mask.length;
  var V = features.voicing, P = features.pitch, D = features.shapeDist;

  var i = 0;
  while (i < n) {
    if (!mask[i] || V[i] < voicedMin || P[i] <= 0) { i++; continue; }
    var start = i;
    var logSum = Math.log2(P[i]);
    var count = 1;
    i++;
    while (i < n && mask[i] && V[i] >= voicedMin && P[i] > 0 && D[i] <= shapeTol) {
      var lp = Math.log2(P[i]);
      if (Math.abs(lp - logSum / count) * 12 > pitchTol) break;
      logSum += lp;
      count++;
      i++;
    }
    var end = i;
    var len = end - start;
    if (len < minF || len > maxF) continue;
    if (opts.isolatedOnly) {
      var isl = islandsOverlapping(islands, start, end);
      if (isl.length !== 1) continue;
      var I = isl[0];
      if (len < 0.7 * (I[1] - I[0])) continue;
      // tüm adacığı kes (sessizlik kenarlarına oturt)
      start = I[0];
      end = I[1];
      if (end - start > maxF) continue;
    }
    out.push({ a: start, b: end, text: '(uzatma)', source: 'acoustic' });
  }
  return out;
}

module.exports = {
  normalizeWord: normalizeWord,
  parseFillerList: parseFillerList,
  isFiller: isFiller,
  islandsFromMask: islandsFromMask,
  islandsOverlapping: islandsOverlapping,
  findAsrFillers: findAsrFillers,
  computeAcousticFeatures: computeAcousticFeatures,
  findAcousticFillers: findAcousticFillers,
  yieldUI: yieldUI
};
