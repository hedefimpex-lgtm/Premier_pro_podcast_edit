'use strict';
/* Test: FFmpeg/Whisper yerine sentetik analiz üretir (iki konuşmacı, boşluklar, takılmalar). */
var audio = require('./audio');

function env(n, segs, floor) {
  var e = new Float32Array(n).fill(floor);
  segs.forEach(function (s) { for (var f = Math.round(s[0] / 0.01); f < Math.round(s[1] / 0.01) && f < n; f++) e[f] = s[2]; });
  return e;
}

async function analyze(ctx) {
  var dur = ctx.seq.duration, n = Math.ceil(dur / 0.01) + 1;
  for (var i = 1; i <= 5; i++) {
    ctx.onProgress(i / 5, 'Ses çözülüyor… ' + i);
    await new Promise(function (r) { setTimeout(r, 30); });
  }
  var host = env(n, [[0.5, 6, -18], [6.3, 6.9, -24], [7.4, 12, -18], [21, 26, -18]], -62);
  var guest = env(n, [[12.8, 19.5, -20], [27, 29.5, -20]], -64);
  // sızıntı
  for (var f = 0; f < n; f++) { if (host[f] > -30) guest[f] = Math.max(guest[f], host[f] - 20); if (guest[f] > -30) host[f] = Math.max(host[f], guest[f] - 20); }
  var tracks = [
    { index: 0, name: 'Sunucu Mik', envDb: host, levels: audio.estimateLevels(host) },
    { index: 1, name: 'Konuk Mik', envDb: guest, levels: audio.estimateLevels(guest) }
  ];
  var envDb = audio.combineDb([host, guest]);
  var words = [
    [0.5, 1.5, ' Herkese'], [1.6, 3, ' merhaba,'], [3.1, 6, ' bugün podcastimize hoş geldiniz.'],
    [6.3, 6.9, ' Iıı,'], [7.4, 9, ' konuğumuz'], [9.1, 12, ' çok değerli bir isim.'],
    [12.8, 14, ' Teşekkürler,'], [14.1, 16, ' davetiniz için'], [16.1, 19.5, ' çok mutluyum.'],
    [21, 23, ' Hmm,'], [23.1, 26, ' ilk sorumuz şu.'], [27, 29.5, ' Tabii, buyurun.']
  ].map(function (w) { return { start: w[0], end: w[1], text: w[2] }; });
  return {
    version: 1, sequenceId: ctx.seq.id, sequenceName: ctx.seq.name, fps: ctx.seq.fps, duration: dur, nFrames: n,
    tracks: tracks, envDb: envDb, zcr: new Float32Array(n), levels: audio.estimateLevels(envDb),
    features: null, words: ctx.needWords ? words : null, warnings: ['Örnek uyarı: test verisi kullanılıyor.']
  };
}

module.exports = { analyze: analyze };
