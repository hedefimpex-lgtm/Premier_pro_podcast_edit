'use strict';
/**
 * whisper.cpp ile konuşma tanıma (kelime düzeyinde zaman damgaları).
 */
var childProcess = require('child_process');
var fs = require('fs');
var os = require('os');
var crypto = require('crypto');

var TR_ASCII = { 'ı': 'i', 'İ': 'I', 'ş': 's', 'Ş': 'S', 'ğ': 'g', 'Ğ': 'G', 'ü': 'u', 'Ü': 'U', 'ö': 'o', 'Ö': 'O', 'ç': 'c', 'Ç': 'C' };

/**
 * Windows'ta bazı whisper.cpp sürümleri komut satırındaki UTF-8 karakterleri bozabildiği için
 * istem (prompt) metni ASCII'ye çevrilir.
 */
function asciiPrompt(text) {
  return String(text || '').replace(/[ıİşŞğĞüÜöÖçÇ]/g, function (c) { return TR_ASCII[c]; }).replace(/[^\x20-\x7e]/g, '');
}

/** "a b 'c d'" biçimindeki ek parametreleri ayrıştırır. */
function splitArgs(str) {
  var out = [];
  var re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  var m;
  while ((m = re.exec(str || ''))) out.push(m[1] != null ? m[1] : (m[2] != null ? m[2] : m[3]));
  return out;
}

function buildArgs(o) {
  var threads = o.threads > 0 ? o.threads : Math.max(1, Math.min(8, os.cpus().length));
  var args = ['-m', o.model, '-f', o.wav, '-of', o.outBase, '-oj', '-ml', '1', '-sow', '-pp', '-t', String(threads)];
  if (o.language) args.push('-l', o.language);
  var prompt = process.platform === 'win32' ? asciiPrompt(o.prompt) : String(o.prompt || '');
  if (prompt.trim()) args.push('--prompt', prompt.trim());
  return args.concat(splitArgs(o.extraArgs));
}

function parseTimestamp(ts) {
  var m = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(ts || '');
  if (!m) return null;
  return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000;
}

/**
 * whisper.cpp JSON çıktısını kelime listesine çevirir.
 * Dönüş: [{start, end, text}] (sn)
 */
function parseOutput(jsonText) {
  var data = JSON.parse(jsonText);
  var segs = data.transcription || [];
  var words = [];
  segs.forEach(function (s) {
    var t = String(s.text || '').replace(/�/g, '').trim();
    if (!t) return;
    var a, b;
    if (s.offsets && typeof s.offsets.from === 'number') {
      a = s.offsets.from / 1000;
      b = s.offsets.to / 1000;
    } else if (s.timestamps) {
      a = parseTimestamp(s.timestamps.from);
      b = parseTimestamp(s.timestamps.to);
    }
    if (a == null || b == null) return;
    if (/^[.,!?;:…]+$/.test(t) && words.length) {
      words[words.length - 1].text += t;
      return;
    }
    words.push({ start: a, end: Math.max(a, b), text: t });
  });
  return words;
}

/**
 * whisper.cpp'yi çalıştırır.
 * o: { exe, model, wav, outBase, language, prompt, threads, extraArgs }
 */
function run(o, onProgress, cancel) {
  return new Promise(function (resolve, reject) {
    var args = buildArgs(o);
    var proc;
    try {
      proc = childProcess.spawn(o.exe, args, { windowsHide: true });
    } catch (e) {
      reject(e);
      return;
    }
    if (cancel && cancel.procs) cancel.procs.push(proc);
    var log = '';
    function onData(d) {
      var s = d.toString();
      log += s;
      if (log.length > 20000) log = log.slice(-20000);
      var re = /progress\s*=\s*(\d+)%/g;
      var m, last = null;
      while ((m = re.exec(s))) last = m;
      if (last && onProgress) onProgress(Math.min(1, (+last[1]) / 100));
    }
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', function (err) { reject(new Error('Whisper çalıştırılamadı: ' + err.message)); });
    proc.on('close', function (code) {
      if (cancel && cancel.procs) {
        var i = cancel.procs.indexOf(proc);
        if (i >= 0) cancel.procs.splice(i, 1);
      }
      if (cancel && cancel.cancelled) { reject(new Error('İptal edildi')); return; }
      var jsonPath = o.outBase + '.json';
      if (code !== 0 || !fs.existsSync(jsonPath)) {
        var tail = log.trim().split(/\r?\n/).slice(-4).join(' | ');
        reject(new Error('Whisper hata verdi (' + code + '): ' + tail));
        return;
      }
      try {
        var words = parseOutput(fs.readFileSync(jsonPath, 'utf8'));
        resolve(words);
      } catch (e) {
        reject(new Error('Whisper çıktısı okunamadı: ' + e.message));
      }
    });
  });
}

/** Önbellek anahtarı: aynı ses + aynı model/dil/istem için transkripsiyon tekrarlanmaz. */
function cacheKey(parts) {
  return crypto.createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 20);
}

module.exports = {
  run: run,
  parseOutput: parseOutput,
  buildArgs: buildArgs,
  asciiPrompt: asciiPrompt,
  splitArgs: splitArgs,
  cacheKey: cacheKey
};
