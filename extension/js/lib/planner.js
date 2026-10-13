'use strict';
/**
 * Planlama: analiz verisinden (ses zarfları, kelimeler, akustik özellikler) ve
 * ayarlardan kesim listesini, kalan bölümleri, kamera çekimlerini ve XML parçalarını üretir.
 * Hafif bir işlemdir; ayarlar değiştikçe anında yeniden çalıştırılır (ince ayar).
 */
var audio = require('./audio');
var timeline = require('./timeline');
var fillers = require('./fillers');
var multicam = require('./multicam');

var HOP = audio.HOP_SEC;

function msToFrames(ms) {
  return Math.max(0, Math.round((ms || 0) / 1000 / HOP));
}

function computeThreshold(analysis, s) {
  if (!s.autoThreshold) return s.thresholdDb;
  var lv = analysis.levels;
  var sens = s.sensitivity == null ? 0.35 : s.sensitivity;
  var range = lv.speech - lv.noise;
  // Belirgin bir sessizlik yoksa (sürekli konuşma/müzik) eşik konuşmanın epey altına konur
  var thr = range >= 12 ? lv.noise + range * sens : lv.speech - 15;
  return Math.max(-70, Math.min(-15, thr));
}

/** Konuşma maskesi: 1 = konuşma, 0 = sessizlik. Kısa ses patlamaları atılır. */
function speechMask(env, thr, minSpeechFrames) {
  var n = env.length;
  var mask = new Uint8Array(n);
  for (var i = 0; i < n; i++) mask[i] = env[i] > thr ? 1 : 0;
  if (minSpeechFrames > 1) {
    var i2 = 0;
    while (i2 < n) {
      if (!mask[i2]) { i2++; continue; }
      var s = i2;
      while (i2 < n && mask[i2]) i2++;
      if (i2 - s < minSpeechFrames) for (var k = s; k < i2; k++) mask[k] = 0;
    }
  }
  return mask;
}

/** Nefes adayları: kısa, sessize yakın, gürültü benzeri (yüksek sıfır geçişi) bölgeler. */
function findBreaths(analysis, mask, thr, s) {
  var env = analysis.envDb;
  var zcr = analysis.zcr;
  if (!zcr) return [];
  var islands = fillers.islandsFromMask(mask);
  var minF = msToFrames(150), maxF = msToFrames(900);
  var out = [];
  var V = analysis.features ? analysis.features.voicing : null;
  islands.forEach(function (I) {
    var len = I[1] - I[0];
    if (len < minF || len > maxF) return;
    var maxDb = -200, z = 0, v = 0;
    for (var f = I[0]; f < I[1]; f++) {
      if (env[f] > maxDb) maxDb = env[f];
      z += zcr[f];
      if (V) v += V[f];
    }
    z /= len;
    if (maxDb > thr + (s.breathMaxDb || 10)) return;
    if (z < 0.18 * audio.HOP) return; // düşük sıfır geçişi: sesli (ünlü) olabilir
    if (V && v / len > 0.6) return;
    out.push({ a: I[0], b: I[1] });
  });
  return out;
}

function fmtId(prefix, frame) {
  return prefix + ':' + frame;
}

/** Takılmanın çevresindeki kelimeler: "geldiniz. [Iıı,] konuğumuz" */
function wordContext(words, idx, span) {
  if (!words || idx == null) return '';
  span = span || 2;
  var a = Math.max(0, idx - span), b = Math.min(words.length, idx + span + 1);
  var parts = [];
  for (var i = a; i < b; i++) parts.push(i === idx ? '[' + words[i].text.trim() + ']' : words[i].text.trim());
  return (a > 0 ? '… ' : '') + parts.join(' ') + (b < words.length ? ' …' : '');
}

function cleanLabel(t) {
  return String(t || '').replace(/^[\s"'“(]+|[\s.,!?;:…"'”)]+$/g, '') || String(t || '');
}

/**
 * analysis: pipeline.analyze() sonucu
 * settings: tüm ayarlar
 * disabled: { id: true } — kullanıcının kapattığı tespitler
 */
function plan(analysis, settings, disabled) {
  disabled = disabled || {};
  var n = analysis.nFrames;
  var duration = analysis.duration;
  var fps = analysis.fps;
  var tasks = settings.tasks;
  var ss = settings.silence;
  var fs = settings.fillers;

  var thr = computeThreshold(analysis, ss);
  var mask = speechMask(analysis.envDb, thr, msToFrames(ss.minSpeechMs));
  var baseMask = tasks.multicam ? mask.slice() : null; // kamera kararı için ham konuşma maskesi
  var rows = [];

  // --- Nefesler (boşluk sayılır)
  var breathMark = new Uint8Array(n);
  if (tasks.silence && ss.removeBreaths) {
    findBreaths(analysis, mask, thr, ss).forEach(function (b) {
      for (var f = b.a; f < b.b; f++) { mask[f] = 0; breathMark[f] = 1; }
    });
  }

  // --- Takılmalar
  var fillerMark = new Uint8Array(n);
  var fillerDetections = [];
  if (tasks.fillers) {
    var method = fs.method || 'auto';
    var useAi = analysis.words && (method === 'ai' || method === 'both' || method === 'auto');
    var useAc = analysis.features && (method === 'acoustic' || method === 'both' || (method === 'auto' && !analysis.words));
    var set = fillers.parseFillerList(fs.words);
    var found = [];
    if (useAi) found = found.concat(fillers.findAsrFillers(analysis.words, set, mask, fs));
    if (useAc) {
      found = found.concat(fillers.findAcousticFillers(analysis.features, mask, {
        sensitivity: fs.acousticSensitivity, minMs: fs.acousticMinMs, maxMs: fs.maxMs, isolatedOnly: fs.acousticIsolatedOnly
      }));
    }
    found.sort(function (x, y) { return x.a - y.a; });
    // çakışanları birleştir (yapay zeka etiketini koru)
    var merged = [];
    found.forEach(function (d) {
      var last = merged[merged.length - 1];
      if (last && d.a <= last.b) {
        last.b = Math.max(last.b, d.b);
        if (last.source !== 'ai' && d.source === 'ai') { last.text = d.text; last.source = 'ai'; last.wordIndex = d.wordIndex; }
      } else {
        merged.push({ a: d.a, b: d.b, text: d.text, source: d.source, wordIndex: d.wordIndex });
      }
    });
    merged.forEach(function (d) {
      var id = fmtId('f', d.a);
      d.id = id;
      d.enabled = !disabled[id];
      fillerDetections.push(d);
      if (!d.enabled) {
        rows.push({ id: id, type: 'filler', start: d.a * HOP, end: d.b * HOP, enabled: false, label: cleanLabel(d.text), source: d.source, context: wordContext(analysis.words, d.wordIndex) });
        return;
      }
      for (var f = d.a; f < d.b; f++) { fillerMark[f] = 1; mask[f] = 0; }
    });
  }

  // --- Kesilecek bölgeler (sessizlik ∪ takılma)
  var cuts = [];
  var minSil = msToFrames(ss.minSilenceMs);
  var keepAfter = (ss.keepAfterMs || 0) / 1000;
  var keepBefore = (ss.keepBeforeMs || 0) / 1000;
  var edgePad = (fs.edgePadMs || 0) / 1000;
  var minCut = (ss.minCutMs || 0) / 1000;
  var i = 0;
  while (i < n) {
    if (mask[i]) { i++; continue; }
    var a = i;
    var hasFiller = false, hasBreath = false;
    while (i < n && !mask[i]) {
      if (fillerMark[i]) hasFiller = true;
      if (breathMark[i]) hasBreath = true;
      i++;
    }
    var b = i;
    var isSilence = tasks.silence && (b - a) >= minSil;
    if (!hasFiller && !isSilence) continue;
    var padL = a === 0 ? 0 : (fillerMark[a] ? edgePad : keepAfter);
    var padR = b >= n ? 0 : (fillerMark[b - 1] ? edgePad : keepBefore);
    var cs = a * HOP + padL;
    var ce = Math.min(duration, b * HOP) - padR;
    if (ce - cs < minCut) continue;
    var type = hasFiller ? 'filler' : 'silence';
    var det = null;
    if (hasFiller) {
      for (var d = 0; d < fillerDetections.length; d++) {
        var fd = fillerDetections[d];
        if (fd.enabled && fd.b > a && fd.a < b) { det = fd; break; }
      }
    }
    var id = det ? det.id : fmtId('s', a);
    if (!det && disabled[id]) {
      rows.push({ id: id, type: type, start: cs, end: ce, enabled: false, label: hasBreath ? 'Boşluk + nefes' : 'Boşluk' });
      continue;
    }
    var row = {
      id: id, type: type, start: cs, end: ce, enabled: true,
      label: det ? cleanLabel(det.text) : (hasBreath ? 'Boşluk + nefes' : 'Boşluk'),
      source: det ? det.source : null,
      context: det ? wordContext(analysis.words, det.wordIndex) : ''
    };
    rows.push(row);
    cuts.push([cs, ce]);
  }

  rows.sort(function (x, y) { return x.start - y.start; });

  var keepSec = timeline.invertRanges(cuts, duration);
  var keepFrames = timeline.secondsToFrames(keepSec, fps);
  if (!keepFrames.length) keepFrames = [[0, Math.max(1, Math.round(duration * fps))]];
  var snappedKeep = timeline.framesToSeconds(keepFrames, fps);
  var totalFrames = timeline.totalLength(keepFrames);

  // --- Çoklu kamera
  var shots = [];
  var shotsFrames = null;
  if (tasks.multicam) {
    var mc = settings.multicam;
    var speakers = Object.keys(mc.speakers || {}).map(function (k) {
      return { track: parseInt(k, 10), cam: parseInt(mc.speakers[k], 10) };
    }).filter(function (s) { return s.cam >= 0 && !isNaN(s.cam); });
    if (speakers.length) {
      shots = multicam.planShots(analysis, snappedKeep, speakers, mc, baseMask);
      shotsFrames = multicam.shotsToFrames(shots, fps, totalFrames);
    }
  }

  var pieces = timeline.buildPieces(keepFrames, shotsFrames);

  // --- İstatistikler
  var stats = { silence: { count: 0, total: 0 }, filler: { count: 0, total: 0 } };
  rows.forEach(function (r) {
    if (!r.enabled) return;
    var st = stats[r.type];
    st.count++;
    st.total += r.end - r.start;
  });

  return {
    threshold: thr,
    levels: analysis.levels,
    rows: rows,
    keepSec: snappedKeep,
    keepFrames: keepFrames,
    pieces: pieces,
    shots: shotsFrames ? shotsFrames.map(function (s) { return { start: s.start / fps, end: s.end / fps, cam: s.cam }; }) : [],
    fps: fps,
    originalDuration: duration,
    newDuration: totalFrames / fps,
    stats: stats,
    cameraSwitches: shotsFrames ? Math.max(0, shotsFrames.length - 1) : 0,
    hasCuts: keepFrames.length > 1 || (keepFrames[0] && (keepFrames[0][0] > 0 || keepFrames[0][1] < Math.round(duration * fps)))
  };
}

module.exports = {
  plan: plan,
  computeThreshold: computeThreshold,
  speechMask: speechMask
};
