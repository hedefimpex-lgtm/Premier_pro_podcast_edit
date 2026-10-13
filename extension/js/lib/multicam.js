'use strict';
/**
 * Çoklu kamera kurgusu: her konuşmacının mikrofonundan kimin konuştuğunu bulur
 * ve kurgulanmış zaman çizelgesi üzerinde kamera çekimlerini planlar.
 */
var audio = require('./audio');

var SILENT = -1;
var OVERLAP = -2;

/** dB zarfını güç ortalamasıyla yumuşatır (pencere: w kare). */
function smoothDb(env, w) {
  var n = env.length;
  var pre = new Float64Array(n + 1);
  for (var i = 0; i < n; i++) pre[i + 1] = pre[i] + Math.pow(10, env[i] / 10);
  var out = new Float32Array(n);
  var h = Math.max(0, Math.floor(w / 2));
  for (i = 0; i < n; i++) {
    var a = Math.max(0, i - h), b = Math.min(n, i + h + 1);
    var avg = (pre[b] - pre[a]) / (b - a);
    out[i] = avg > 0 ? 10 * Math.log10(avg) : audio.FLOOR_DB;
  }
  return out;
}

/**
 * Her konuşmacı için yumuşatılmış seviye, otomatik kazanç eşitleme ofseti ve aktiflik eşiği.
 * Referans seviye: kanalın en yüksek %3'lük dilimi (kişinin kendi konuşması). Eşitleme,
 * yalnızca dinleyen (sadece sızıntı alan) mikrofonların şişirilmemesi için 12 dB ile sınırlıdır.
 */
function prepareSpeakers(analysis, speakers, settings) {
  var w = Math.max(1, Math.round((settings.smoothMs || 300) / 1000 / audio.HOP_SEC));
  var list = speakers.map(function (sp) {
    var tr = null;
    for (var i = 0; i < analysis.tracks.length; i++) if (analysis.tracks[i].index === sp.track) tr = analysis.tracks[i];
    if (!tr) return null;
    // Ağır hesaplar analiz nesnesinde önbelleğe alınır (ince ayar sırasında tekrar hesaplanmaz)
    if (tr._peak == null) tr._peak = audio.percentiles(tr.envDb, [0.97])[0];
    if (!tr._smooth || tr._smooth.w !== w) tr._smooth = { w: w, data: smoothDb(tr.envDb, w) };
    var peak = tr._peak;
    return { track: sp.track, cam: sp.cam, level: tr._smooth.data, peak: peak, gate: peak - 20, offset: 0 };
  }).filter(Boolean);
  if (settings.autoGain !== false && list.length) {
    var maxPeak = Math.max.apply(null, list.map(function (x) { return x.peak; }));
    list.forEach(function (x) { x.offset = Math.min(12, maxPeak - x.peak); });
  }
  return list;
}

/** Kurgu zamanındaki her 10 ms kare için orijinal kare indeksini üretir. */
function editedFrameIndex(keepSec, nFrames) {
  var hop = audio.HOP_SEC;
  var bounds = keepSec.map(function (r) {
    return [Math.round(r[0] / hop), Math.min(nFrames, Math.round(r[1] / hop))];
  });
  var total = 0;
  bounds.forEach(function (b) { if (b[1] > b[0]) total += b[1] - b[0]; });
  var idx = new Int32Array(total);
  var j = 0;
  bounds.forEach(function (b) { for (var f = b[0]; f < b[1]; f++) idx[j++] = f; });
  return idx;
}

function labelFrames(idx, sp, marginDb, speechMask) {
  var m = idx.length;
  var labels = new Int16Array(m);
  for (var j = 0; j < m; j++) {
    var o = idx[j];
    if (speechMask && !speechMask[o]) { labels[j] = SILENT; continue; }
    var best = -1, bestL = -1e9, second = -1e9, active = 0;
    for (var s = 0; s < sp.length; s++) {
      var lv = sp[s].level[o];
      if (lv < sp[s].gate) continue;
      active++;
      var L = lv + sp[s].offset;
      if (L > bestL) { second = bestL; bestL = L; best = s; } else if (L > second) { second = L; }
    }
    if (!active) labels[j] = SILENT;
    else if (active >= 2 && bestL - second < marginDb) labels[j] = OVERLAP;
    else labels[j] = sp[best].cam;
  }
  return labels;
}

function runs(labels) {
  var out = [];
  var i = 0, n = labels.length;
  while (i < n) {
    var s = i, v = labels[i];
    while (i < n && labels[i] === v) i++;
    out.push({ lab: v, s: s, e: i });
  }
  return out;
}

function mergeSame(shots) {
  var out = [];
  for (var i = 0; i < shots.length; i++) {
    var last = out[out.length - 1];
    if (last && last.cam === shots[i].cam) last.e = shots[i].e;
    else out.push({ cam: shots[i].cam, s: shots[i].s, e: shots[i].e });
  }
  return out;
}

/**
 * Kamera çekimlerini planlar.
 * analysis: analiz sonucu, keepSec: kalan aralıklar (sn),
 * settings: multicam ayarları, speakers: [{track, cam}],
 * speechMask: (isteğe bağlı) genel konuşma maskesi — sessiz karelerde kamera değişmez
 * Dönüş: [{start, end, cam}] kurgu zamanında (sn)
 */
function planShots(analysis, keepSec, speakers, settings, speechMask) {
  var hop = audio.HOP_SEC;
  var sp = prepareSpeakers(analysis, speakers, settings);
  var idx = editedFrameIndex(keepSec, analysis.nFrames);
  var m = idx.length;
  if (!m || !sp.length) return [];
  var wide = settings.wideTrack == null ? -1 : settings.wideTrack;
  var toF = function (ms) { return Math.max(0, Math.round((ms || 0) / 1000 / hop)); };
  var hold = toF(settings.holdMs);
  var minShot = Math.max(1, toF(settings.minShotMs));
  var anticipate = toF(settings.anticipateMs);

  var labels = labelFrames(idx, sp, settings.marginDb == null ? 6 : settings.marginDb, speechMask);
  var rl = runs(labels);

  // 1) Sessizlikleri ve kısa konuşmaları mevcut çekime kat
  var shots = [];
  for (var i = 0; i < rl.length; i++) {
    var r = rl[i];
    if (r.lab === SILENT) continue;
    var cam = r.lab;
    if (cam === OVERLAP) cam = (settings.overlapToWide !== false && wide >= 0) ? wide : null;
    if (cam === null) continue;
    if (r.e - r.s < hold && shots.length) continue;
    var last = shots[shots.length - 1];
    if (last && last.cam === cam) continue;
    var start = r.s - anticipate;
    if (last) start = Math.max(start, last.s + 1);
    shots.push({ cam: cam, s: Math.max(0, start) });
  }
  if (!shots.length) shots.push({ cam: wide >= 0 ? wide : sp[0].cam, s: 0 });
  shots[0].s = 0;
  for (i = 0; i < shots.length; i++) shots[i].e = i + 1 < shots.length ? shots[i + 1].s : m;
  shots = mergeSame(shots);

  // 2) Minimum çekim süresi
  var changed = true;
  var guard = 0;
  while (changed && guard++ < 1000) {
    changed = false;
    for (i = 0; i < shots.length; i++) {
      if (shots.length < 2) break;
      if (shots[i].e - shots[i].s >= minShot) continue;
      if (i > 0) shots[i - 1].e = shots[i].e;
      else shots[i + 1].s = shots[i].s;
      shots.splice(i, 1);
      shots = mergeSame(shots);
      changed = true;
      break;
    }
  }

  // 3) Uzun çekimlerde ara plan (geniş açı ya da dinleyen kişi)
  var maxShot = toF(settings.maxShotMs);
  var cut = toF(settings.cutawayMs || 2500);
  if (maxShot > 0 && cut > 0) {
    var res = [];
    shots.forEach(function (sh) {
      var dur = sh.e - sh.s;
      var target = cutawayCam(sh, sp, idx, wide, settings.cutawayTarget);
      if (target === null || target === sh.cam || dur <= maxShot) { res.push(sh); return; }
      var count = Math.floor(dur / maxShot);
      while (count > 0 && (dur - count * cut) / (count + 1) < minShot) count--;
      if (!count) { res.push(sh); return; }
      var t = sh.s;
      for (var k = 1; k <= count; k++) {
        var center = sh.s + Math.round(k * dur / (count + 1));
        var a = center - (cut >> 1);
        res.push({ cam: sh.cam, s: t, e: a });
        var tgt = cutawayCam({ s: a, e: a + cut, cam: sh.cam }, sp, idx, wide, settings.cutawayTarget);
        res.push({ cam: tgt === null ? target : tgt, s: a, e: a + cut });
        t = a + cut;
      }
      res.push({ cam: sh.cam, s: t, e: sh.e });
    });
    shots = mergeSame(res.filter(function (s) { return s.e > s.s; }));
  }

  return shots.map(function (s) { return { start: s.s * hop, end: s.e * hop, cam: s.cam }; });
}

function cutawayCam(shot, sp, idx, wide, mode) {
  if (mode !== 'listener') return wide >= 0 ? wide : null;
  // en sessiz (dinleyen) konuşmacının kamerası
  var best = null, bestVal = 1e9;
  for (var s = 0; s < sp.length; s++) {
    if (sp[s].cam === shot.cam) continue;
    var acc = 0, cnt = 0;
    for (var j = shot.s; j < shot.e && j < idx.length; j += 5) { acc += sp[s].level[idx[j]] + sp[s].offset; cnt++; }
    var v = cnt ? acc / cnt : 0;
    if (v < bestVal) { bestVal = v; best = sp[s].cam; }
  }
  if (best === null && wide >= 0) return wide;
  return best;
}

/** Çekimleri (sn) video karelerine oturtur; 0..totalFrames aralığını eksiksiz kaplar. */
function shotsToFrames(shots, fps, totalFrames) {
  if (!shots.length) return [];
  var out = [];
  for (var i = 0; i < shots.length; i++) {
    var s = i === 0 ? 0 : Math.round(shots[i].start * fps);
    var e = i === shots.length - 1 ? totalFrames : Math.round(shots[i].end * fps);
    if (out.length) s = out[out.length - 1].end;
    if (e <= s) continue;
    var last = out[out.length - 1];
    if (last && last.cam === shots[i].cam) last.end = e;
    else out.push({ start: s, end: e, cam: shots[i].cam });
  }
  if (out.length) out[out.length - 1].end = totalFrames;
  return out;
}

module.exports = {
  SILENT: SILENT,
  OVERLAP: OVERLAP,
  smoothDb: smoothDb,
  planShots: planShots,
  shotsToFrames: shotsToFrames,
  editedFrameIndex: editedFrameIndex
};
