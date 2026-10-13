'use strict';
/**
 * Analiz akışı: sekanstaki ses kliplerini FFmpeg ile çözer, zarfları çıkarır,
 * gerekiyorsa akustik özellikleri hesaplar ve Whisper ile kelimeleri bulur.
 * Bu ağır adım bir kez yapılır; ince ayarlar planner.plan() ile anında uygulanır.
 */
var fs = require('fs');
var path = require('path');
var audio = require('./audio');
var ffmpeg = require('./ffmpeg');
var fillers = require('./fillers');
var whisper = require('./whisper');
var paths = require('./paths');

/**
 * ctx: {
 *   seq: Premiere'den gelen sekans bilgisi (getSequenceInfo),
 *   tracks: [{ index, channel }] — analiz edilecek ses kanalları,
 *   settings, ffmpegPath, whisperPath, modelPath,
 *   needWords, needAcoustic,
 *   dirs: paths.dirs(),
 *   onProgress(oran 0..1, mesaj), cancel: { cancelled, procs: [] }
 * }
 */
async function analyze(ctx) {
  var seq = ctx.seq;
  var duration = seq.duration;
  if (!(duration > 0)) throw new Error('Sekans boş görünüyor.');
  var nFrames = Math.ceil(duration / audio.HOP_SEC) + 1;
  var totalSamples = nFrames * audio.HOP;
  var needPcm = !!(ctx.needWords || ctx.needAcoustic);
  var mix = needPcm ? new Int16Array(totalSamples) : null;
  var progress = ctx.onProgress || function () {};
  var cancel = ctx.cancel || { cancelled: false, procs: [] };
  var warnings = [];

  // İş miktarı: çözülecek toplam süre
  var selected = [];
  ctx.tracks.forEach(function (sel) {
    var tr = null;
    seq.audioTracks.forEach(function (t) { if (t.index === sel.index) tr = t; });
    if (tr) selected.push({ info: tr, channel: sel.channel || 0 });
  });
  if (!selected.length) throw new Error('Analiz için en az bir ses kanalı seçin.');
  var totalWork = 0;
  selected.forEach(function (s) {
    s.info.clips.forEach(function (c) { if (c.path && !c.disabled) totalWork += c.end - c.start; });
  });
  if (totalWork <= 0) throw new Error('Seçilen kanallarda çözülebilir ses klibi yok.');

  var decodeShare = needPcm ? (ctx.needWords ? 0.35 : 0.6) : 0.95;
  var done = 0;
  var tracks = [];
  for (var t = 0; t < selected.length; t++) {
    var sel = selected[t];
    var acc = new audio.TrackAccumulator(nFrames, mix);
    for (var c = 0; c < sel.info.clips.length; c++) {
      var clip = sel.info.clips[c];
      if (cancel.cancelled) throw new Error('İptal edildi');
      if (clip.disabled) continue;
      if (!clip.path) {
        warnings.push('A' + (sel.info.index + 1) + ': "' + clip.name + '" çözülemedi (iç içe sekans ya da birleştirilmiş klip). Bu kanalı ayrı klip olarak kullanın.');
        continue;
      }
      if (!fs.existsSync(clip.path)) {
        warnings.push('Medya bulunamadı: ' + clip.path);
        continue;
      }
      if (clip.speed && Math.abs(clip.speed - 1) > 0.01) {
        warnings.push('"' + clip.name + '" hızı %' + Math.round(clip.speed * 100) + ' — analiz zamanlaması yaklaşık olacak.');
      }
      var len = clip.end - clip.start;
      var pos = Math.round(clip.start * audio.SAMPLE_RATE);
      var written = 0;
      var last = 0;
      var maxSamples = Math.round(len * audio.SAMPLE_RATE);
      var label = (sel.info.name || ('A' + (sel.info.index + 1))) + ' — ' + clip.name;
      /* eslint-disable no-loop-func */
      await ffmpeg.decodePcm(ctx.ffmpegPath, { path: clip.path, start: clip.inPoint, duration: len, channel: sel.channel }, function (samples) {
        if (written >= maxSamples) return;
        var s = samples.length + written > maxSamples ? samples.subarray(0, maxSamples - written) : samples;
        last = acc.add(s, pos + written, last);
        written += s.length;
        progress(decodeShare * (done + written / audio.SAMPLE_RATE) / totalWork, 'Ses çözülüyor: ' + label);
      }, cancel);
      /* eslint-enable no-loop-func */
      done += len;
    }
    var env = acc.toDb();
    tracks.push({
      index: sel.info.index,
      name: sel.info.name,
      channel: sel.channel,
      envDb: env,
      zc: acc.zc,
      levels: audio.estimateLevels(env)
    });
    await fillers.yieldUI();
  }

  var envDb = tracks.length === 1 ? tracks[0].envDb : audio.combineDb(tracks.map(function (x) { return x.envDb; }));
  var levels = audio.estimateLevels(envDb);

  // Kare başına sıfır geçişi: o karede en baskın kanalınki
  var zcr = new Float32Array(nFrames);
  for (var f = 0; f < nFrames; f++) {
    var best = -1e9, z = 0;
    for (var k = 0; k < tracks.length; k++) {
      if (tracks[k].envDb[f] > best) { best = tracks[k].envDb[f]; z = tracks[k].zc[f]; }
    }
    zcr[f] = z;
  }
  tracks.forEach(function (x) { delete x.zc; });

  var analysis = {
    version: 1,
    sequenceId: seq.id,
    sequenceName: seq.name,
    fps: seq.fps,
    duration: duration,
    nFrames: nFrames,
    tracks: tracks,
    envDb: envDb,
    zcr: zcr,
    levels: levels,
    features: null,
    words: null,
    warnings: warnings
  };

  var base = decodeShare;
  if (ctx.needAcoustic) {
    var share = ctx.needWords ? 0.1 : 0.35;
    progress(base, 'Akustik takılma analizi...');
    analysis.features = await fillers.computeAcousticFeatures(mix, envDb, levels.noise + 6, function (p) {
      progress(base + share * p, 'Akustik takılma analizi...');
    }, cancel);
    base += share;
  }

  if (ctx.needWords) {
    analysis.words = await transcribe(ctx, mix, selected, function (p, msg) {
      progress(base + (1 - base) * p, msg);
    }, cancel);
  }

  progress(1, 'Analiz tamamlandı');
  return analysis;
}

async function transcribe(ctx, mix, selected, progress, cancel) {
  var w = ctx.settings.whisper;
  var key = whisper.cacheKey({
    v: 2,
    model: path.basename(ctx.modelPath),
    lang: w.language,
    prompt: w.prompt,
    extra: w.extraArgs,
    tracks: selected.map(function (s) {
      return {
        ch: s.channel,
        clips: s.info.clips.filter(function (c) { return !c.disabled && c.path; }).map(function (c) {
          var mtime = 0;
          try { mtime = fs.statSync(c.path).mtimeMs; } catch (e) { /* yoksay */ }
          return [c.path, mtime, +c.start.toFixed(3), +c.end.toFixed(3), +c.inPoint.toFixed(3)];
        })
      };
    })
  });
  var cacheFile = path.join(ctx.dirs.cache, 'words-' + key + '.json');
  if (fs.existsSync(cacheFile)) {
    try {
      progress(1, 'Transkripsiyon önbellekten alındı');
      return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    } catch (e) { /* yeniden çalıştır */ }
  }
  progress(0, 'Ses Whisper için hazırlanıyor...');
  var wav = path.join(ctx.dirs.work, 'mix-' + key + '.wav');
  audio.writeWav(wav, mix, audio.SAMPLE_RATE);
  var outBase = path.join(ctx.dirs.work, 'whisper-' + key);
  try {
    var words = await whisper.run({
      exe: ctx.whisperPath,
      model: ctx.modelPath,
      wav: wav,
      outBase: outBase,
      language: w.language === 'auto' ? 'auto' : w.language,
      prompt: w.prompt,
      threads: w.threads,
      extraArgs: w.extraArgs
    }, function (p) {
      progress(p, 'Konuşma tanınıyor (Whisper) %' + Math.round(p * 100));
    }, cancel);
    fs.writeFileSync(cacheFile, JSON.stringify(words));
    return words;
  } finally {
    try { fs.unlinkSync(wav); } catch (e) { /* yoksay */ }
    try { fs.unlinkSync(outBase + '.json'); } catch (e) { /* yoksay */ }
  }
}

module.exports = {
  analyze: analyze,
  paths: paths
};
