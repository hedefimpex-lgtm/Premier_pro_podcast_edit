'use strict';
/**
 * Varsayılan ayarlar ve hazır ön ayarlar (preset).
 * Tüm süreler milisaniye (ms) cinsindendir, aksi belirtilmedikçe.
 */

var DEFAULTS = {
  tasks: {
    silence: true,      // konuşma boşluklarını kes
    fillers: true,      // ıı / mmm gibi takılmaları kes
    multicam: false,    // çoklu kamera kurgusu
    subtitles: false    // altyazı ekle
  },
  silence: {
    autoThreshold: true,
    sensitivity: 0.35,     // otomatik eşik: gürültü tabanı (0) ile konuşma seviyesi (1) arası
    thresholdDb: -42,      // elle eşik (autoThreshold kapalıyken)
    minSilenceMs: 450,     // bu süreden kısa sessizlikler doğal duraklama sayılır
    keepAfterMs: 120,      // konuşma bittikten sonra bırakılan pay
    keepBeforeMs: 80,      // konuşma başlamadan önce bırakılan pay
    minSpeechMs: 80,       // bundan kısa ses patlamaları (tık, çarpma) yok sayılır
    minCutMs: 150,         // bundan kısa kesimler yapılmaz
    removeBreaths: false,  // nefes seslerini de boşluk say
    breathMaxDb: 10        // nefes, eşiğin en fazla bu kadar dB üstünde olabilir
  },
  fillers: {
    method: 'auto',        // auto | ai | acoustic | both
    words: 'ı, ıı, ıh, ım, ımm, hı, hm, hmm, mm, mmm, e, ee, eh, ö, öm, ah, uh, um, umm',
    edgePadMs: 20,         // takılma kelimeye bitişikse bırakılan pay
    minMs: 120,            // yapay zekanın bulduğu takılma için minimum süre
    maxMs: 2500,           // bundan uzun "takılmalar" kesilmez (güvenlik)
    acousticSensitivity: 0.5,
    acousticMinMs: 350,
    acousticIsolatedOnly: true
  },
  subtitles: {
    maxChars: 42,
    maxLines: 2,
    maxWords: 0,           // 0 = sınırsız (kısa video tarzı için 2-4)
    minDurationMs: 900,
    maxDurationMs: 6000,
    maxGapMs: 900,         // kelimeler arası bu kadar boşluk olursa yeni altyazı
    minGapMs: 40,
    offsetMs: 0,
    removeFillers: true,
    uppercase: false,
    removePunctuation: false
  },
  multicam: {
    speakers: {},          // { "<ses kanalı indeksi>": <video kanalı indeksi> }
    wideTrack: -1,         // geniş açı video kanalı (-1 = yok)
    marginDb: 6,           // konuşmacının diğerlerinden bu kadar baskın olması gerekir
    smoothMs: 300,
    holdMs: 700,           // bu süreden kısa konuşmalar (evet, hı hı) kamera değiştirmez
    minShotMs: 2000,
    maxShotMs: 0,          // 0 = kapalı; aksi halde uzun çekimlerde ara plan
    cutawayMs: 2500,
    cutawayTarget: 'wide', // wide | listener
    anticipateMs: 200,     // konuşma başlamadan biraz önce kameraya geç
    overlapToWide: true,
    autoGain: true,        // mikrofon seviyelerini otomatik eşitle
    inactiveMode: 'disable' // disable | remove
  },
  whisper: {
    model: 'ggml-small.bin',
    language: 'tr',
    threads: 0,            // 0 = otomatik
    prompt: 'Eee, hmm, mmm... Iıı, şey, yani ee, ımm, evet.',
    extraArgs: ''
  },
  output: {
    mode: 'sequence',      // sequence | markers
    suffix: ' - Podcast Kurgu'
  },
  paths: {
    ffmpeg: '',
    whisper: ''
  },
  tracks: {}               // { "<ses kanalı indeksi>": { analyze: bool, channel: 0 } }
};

var PRESETS = {
  dogal: {
    label: 'Doğal (rahat)',
    values: {
      'silence.minSilenceMs': 700, 'silence.keepAfterMs': 200, 'silence.keepBeforeMs': 150,
      'silence.minCutMs': 250, 'fillers.edgePadMs': 40, 'multicam.minShotMs': 3000, 'multicam.holdMs': 900
    }
  },
  dengeli: {
    label: 'Dengeli (önerilen)',
    values: {
      'silence.minSilenceMs': 450, 'silence.keepAfterMs': 120, 'silence.keepBeforeMs': 80,
      'silence.minCutMs': 150, 'fillers.edgePadMs': 20, 'multicam.minShotMs': 2000, 'multicam.holdMs': 700
    }
  },
  dinamik: {
    label: 'Dinamik (YouTube)',
    values: {
      'silence.minSilenceMs': 300, 'silence.keepAfterMs': 70, 'silence.keepBeforeMs': 50,
      'silence.minCutMs': 100, 'fillers.edgePadMs': 10, 'multicam.minShotMs': 1500, 'multicam.holdMs': 500
    }
  },
  agresif: {
    label: 'Agresif (jump-cut)',
    values: {
      'silence.minSilenceMs': 200, 'silence.keepAfterMs': 40, 'silence.keepBeforeMs': 30,
      'silence.minCutMs': 80, 'fillers.edgePadMs': 5, 'multicam.minShotMs': 1200, 'multicam.holdMs': 400
    }
  }
};

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/** Kaydedilmiş ayarları varsayılanlarla derinlemesine birleştirir (yeni anahtarlar korunur). */
function mergeDeep(base, extra) {
  var out = clone(base);
  if (!extra || typeof extra !== 'object') return out;
  Object.keys(extra).forEach(function (k) {
    var v = extra[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = mergeDeep(out[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  });
  return out;
}

function getPath(obj, path) {
  var parts = path.split('.');
  var cur = obj;
  for (var i = 0; i < parts.length; i++) {
    if (cur == null) return undefined;
    cur = cur[parts[i]];
  }
  return cur;
}

function setPath(obj, path, value) {
  var parts = path.split('.');
  var cur = obj;
  for (var i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function applyPreset(settings, name) {
  var p = PRESETS[name];
  if (!p) return settings;
  var out = clone(settings);
  Object.keys(p.values).forEach(function (k) { setPath(out, k, p.values[k]); });
  return out;
}

function defaults() {
  return clone(DEFAULTS);
}

module.exports = {
  DEFAULTS: DEFAULTS,
  PRESETS: PRESETS,
  defaults: defaults,
  mergeDeep: mergeDeep,
  getPath: getPath,
  setPath: setPath,
  applyPreset: applyPreset,
  clone: clone
};
