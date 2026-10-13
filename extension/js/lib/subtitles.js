'use strict';
/**
 * Kelime zaman damgalarından altyazı (SRT) üretimi.
 */
var fillers = require('./fillers');

var SENTENCE_END = /[.!?…]["'”’)]*$/;
var CLAUSE_END = /[,;:]["'”’)]*$/;

function turkishUpper(s) {
  return s.replace(/i/g, 'İ').replace(/ı/g, 'I').toUpperCase();
}

function cleanText(t) {
  return String(t || '').replace(/�/g, '').replace(/\s+/g, ' ').trim();
}

/** Metni en fazla maxLines satıra, satır uzunluklarını dengeleyerek böler. */
function layoutLines(words, maxChars, maxLines) {
  var text = words.join(' ');
  if (maxLines <= 1 || text.length <= maxChars) return [text];
  if (maxLines === 2 || words.length < 3) {
    var best = null, bestScore = 1e9;
    for (var i = 1; i < words.length; i++) {
      var a = words.slice(0, i).join(' ');
      var b = words.slice(i).join(' ');
      var over = Math.max(0, a.length - maxChars) + Math.max(0, b.length - maxChars);
      // taşmayı çok ağır cezalandır, sonra dengeyi; alt satırın biraz uzun olması tercih edilir
      var score = over * 1000 + Math.abs(a.length - b.length) + (a.length > b.length ? 1 : 0);
      if (score < bestScore) { bestScore = score; best = [a, b]; }
    }
    return best || [text];
  }
  // 3+ satır: açgözlü doldurma
  var lines = [];
  var cur = '';
  words.forEach(function (w) {
    if (cur && (cur + ' ' + w).length > maxChars && lines.length < maxLines - 1) {
      lines.push(cur);
      cur = w;
    } else {
      cur = cur ? cur + ' ' + w : w;
    }
  });
  if (cur) lines.push(cur);
  return lines;
}

/**
 * Altyazı ipuçlarını (cue) oluşturur.
 * words: [{start, end, text}] orijinal zamanda (sn)
 * timeMap: timeline.createTimeMap(keep) — kesilen yerlerdeki kelimeler atılır
 * fillerSet: normalize edilmiş takılma kümesi (removeFillers için)
 * opts: altyazı ayarları
 * Dönüş: [{start, end, lines: [..]}]
 */
function buildCues(words, timeMap, fillerSet, opts) {
  opts = opts || {};
  var maxChars = opts.maxChars || 42;
  var maxLines = opts.maxLines || 2;
  var capacity = maxChars * maxLines;
  function fits(ws) {
    if (ws.join(' ').length > capacity) return false;
    if (ws.length === 1) return true; // tek uzun kelime her durumda sığmak zorunda
    var lines = layoutLines(ws, maxChars, maxLines);
    return lines.length <= maxLines && lines.every(function (l) { return l.length <= maxChars; });
  }
  var maxWords = opts.maxWords || 0;
  var minDur = (opts.minDurationMs == null ? 900 : opts.minDurationMs) / 1000;
  var maxDur = (opts.maxDurationMs || 6000) / 1000;
  var maxGap = (opts.maxGapMs == null ? 900 : opts.maxGapMs) / 1000;
  var minGap = (opts.minGapMs == null ? 40 : opts.minGapMs) / 1000;
  var offset = (opts.offsetMs || 0) / 1000;

  // 1) Kelimeleri temizle, eşle
  var list = [];
  for (var i = 0; i < words.length; i++) {
    var w = words[i];
    var text = cleanText(w.text);
    if (!text) continue;
    if (/^[\[(].*[\])]$/.test(text)) continue; // [MÜZİK], (gülüşmeler)
    if (/^[.,!?;:…-]+$/.test(text)) {
      if (list.length) list[list.length - 1].text += text;
      continue;
    }
    if (opts.removeFillers && fillerSet && fillers.isFiller(text, fillerSet)) {
      // takılmanın noktalamasını önceki kelimeye taşı
      var punct = (/[.!?…]+$/.exec(text) || [''])[0];
      if (punct && list.length && !SENTENCE_END.test(list[list.length - 1].text)) list[list.length - 1].text += punct;
      continue;
    }
    var mid = (w.start + w.end) / 2;
    if (timeMap && !timeMap.isKept(mid)) continue;
    var s = timeMap ? timeMap.toEdited(w.start) : w.start;
    var e = timeMap ? timeMap.toEdited(w.end) : w.end;
    if (e < s) e = s;
    list.push({ start: s, end: e, text: text });
  }

  // 2) Gruplama
  var cues = [];
  var cur = null;
  function flush() {
    if (cur && cur.words.length) cues.push(cur);
    cur = null;
  }
  for (i = 0; i < list.length; i++) {
    var word = list[i];
    if (cur) {
      var prev = cur.words[cur.words.length - 1];
      var breakIt =
        !fits(cur.words.concat([word.text])) ||
        word.start - cur.end > maxGap ||
        word.end - cur.start > maxDur ||
        (maxWords && cur.words.length >= maxWords) ||
        SENTENCE_END.test(prev) ||
        (CLAUSE_END.test(prev) && cur.words.join(' ').length >= capacity * 0.55);
      if (breakIt) flush();
    }
    if (!cur) cur = { start: word.start, end: word.end, words: [] };
    cur.words.push(word.text);
    cur.end = Math.max(cur.end, word.end);
  }
  flush();

  // 3) Zamanlama düzeltmeleri ve metin dönüşümleri
  var out = [];
  for (i = 0; i < cues.length; i++) {
    var c = cues[i];
    var next = cues[i + 1];
    var start = c.start;
    var end = c.end;
    if (end - start < minDur) {
      end = start + minDur;
      if (next && end > next.start - minGap) end = Math.max(c.end, next.start - minGap);
    }
    if (next && end > next.start - minGap) end = Math.max(start + 0.05, next.start - minGap);
    var ws = c.words.slice();
    if (opts.removePunctuation) {
      ws = ws.map(function (t) { return t.replace(/[.,;:]+(["'”’)]*)$/, '$1'); });
    }
    if (opts.uppercase) ws = ws.map(turkishUpper);
    out.push({
      start: Math.max(0, start + offset),
      end: Math.max(0, end + offset),
      lines: layoutLines(ws, maxChars, maxLines)
    });
  }
  return out;
}

function pad(n, w) {
  var s = String(n);
  while (s.length < w) s = '0' + s;
  return s;
}

function srtTime(t) {
  var ms = Math.max(0, Math.round(t * 1000));
  var h = Math.floor(ms / 3600000);
  var m = Math.floor((ms % 3600000) / 60000);
  var s = Math.floor((ms % 60000) / 1000);
  return pad(h, 2) + ':' + pad(m, 2) + ':' + pad(s, 2) + ',' + pad(ms % 1000, 3);
}

/** SRT metni (UTF-8 BOM ve CRLF ile — Premiere Pro'da Türkçe karakterler için güvenli). */
function toSrt(cues) {
  var parts = cues.map(function (c, i) {
    return (i + 1) + '\r\n' + srtTime(c.start) + ' --> ' + srtTime(c.end) + '\r\n' + c.lines.join('\r\n') + '\r\n';
  });
  return '﻿' + parts.join('\r\n');
}

/** Düz metin transkript (zaman damgalı). */
function toTranscript(cues) {
  return cues.map(function (c) {
    return '[' + srtTime(c.start).replace(',', '.') + '] ' + c.lines.join(' ');
  }).join('\r\n');
}

module.exports = {
  buildCues: buildCues,
  layoutLines: layoutLines,
  toSrt: toSrt,
  toTranscript: toTranscript,
  srtTime: srtTime,
  turkishUpper: turkishUpper
};
