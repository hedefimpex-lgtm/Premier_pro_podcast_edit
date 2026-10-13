'use strict';
/**
 * Uçtan uca test: gerçek FFmpeg ile ses çözme + sahte whisper.cpp + planlama + XML + SRT.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');

const pipeline = require('../extension/js/lib/pipeline');
const planner = require('../extension/js/lib/planner');
const paths = require('../extension/js/lib/paths');
const subtitles = require('../extension/js/lib/subtitles');
const timeline = require('../extension/js/lib/timeline');
const fillersLib = require('../extension/js/lib/fillers');
const synth = require('./synth');
const { settings } = require('./helpers');

const ffmpegPath = paths.findFfmpeg(null, { tools: '/nonexistent' });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-test-'));
const fakeWhisper = path.join(__dirname, 'fixtures', 'fake-whisper.js');

function buildMedia() {
  const host = synth.buffer(10);
  synth.noise(host, 0.001, 1);
  synth.speech(host, 0.2, 3.0, 0.5, 11);
  synth.filler(host, 4.5, 5.3, 0.35);
  synth.speech(host, 5.8, 9.0, 0.5, 12);
  const guest = synth.buffer(6);
  synth.noise(guest, 0.001, 2);
  synth.speech(guest, 1.5, 4.8, 0.4, 13);
  const hostPath = path.join(tmp, 'sunucu kaydı.wav');
  const guestPath = path.join(tmp, 'konuk.wav');
  synth.writeWav48(hostPath, host);
  synth.writeWav48(guestPath, guest);
  return { hostPath, guestPath };
}

const WORDS = [
  [0.2, 1.4, ' Merhaba'], [1.5, 3.0, ' arkadaşlar.'],
  [4.5, 5.3, ' Iıı,'],
  [5.8, 7.0, ' bugün'], [7.1, 9.0, ' konuşacağız.'],
  [10.5, 12.0, ' Evet,'], [12.1, 13.8, ' başlayalım.']
];

function seqInfo(media) {
  return {
    id: 'seq-test', name: 'Bölüm 1', fps: 25, duration: 14,
    videoTracks: [{ index: 0, name: 'V1', clips: 1 }],
    audioTracks: [
      { index: 0, name: 'Sunucu', clips: [{ name: 'sunucu', path: media.hostPath, start: 0, end: 10, inPoint: 0, outPoint: 10 }] },
      { index: 1, name: 'Konuk', clips: [{ name: 'konuk', path: media.guestPath, start: 10, end: 14, inPoint: 1, outPoint: 5 }] }
    ]
  };
}

const near = (a, b, eps) => Math.abs(a - b) <= eps;

test('uçtan uca analiz ve planlama', { skip: !ffmpegPath && 'ffmpeg bulunamadı' }, async () => {
  const media = buildMedia();
  const dirs = paths.dirs(path.join(tmp, 'root'));
  const modelPath = path.join(dirs.models, 'ggml-test.bin');
  fs.writeFileSync(modelPath, 'x');
  process.env.FAKE_WHISPER_WORDS = JSON.stringify(WORDS);
  const s = settings({ 'fillers.method': 'both', 'tasks.subtitles': true });
  const progress = [];
  const analysis = await pipeline.analyze({
    seq: seqInfo(media),
    tracks: [{ index: 0, channel: 0 }, { index: 1, channel: 0 }],
    settings: s,
    ffmpegPath,
    whisperPath: fakeWhisper,
    modelPath,
    needWords: true,
    needAcoustic: true,
    dirs,
    onProgress: (p, m) => progress.push([p, m]),
    cancel: { cancelled: false, procs: [] }
  });

  assert.strictEqual(analysis.words.length, WORDS.length);
  assert.ok(progress.length > 3 && progress[progress.length - 1][0] === 1);
  for (let i = 1; i < progress.length; i++) assert.ok(progress[i][0] >= progress[i - 1][0] - 1e-9, 'ilerleme geri gitmemeli');
  const args = JSON.parse(fs.readFileSync(fs.readdirSync(dirs.work).filter(f => f.endsWith('.args.json')).map(f => path.join(dirs.work, f))[0], 'utf8'));
  assert.ok(args.includes('--prompt') && args.includes('tr'));

  // konuk kanalı zaman çizelgesinde 10. saniyeden başlar (kaynakta 1 sn kaydırılmış)
  const guestEnv = analysis.tracks[1].envDb;
  assert.ok(guestEnv[Math.round(10.2 / 0.01)] < -50, 'konuk 10.2 sn sessiz olmalı');
  assert.ok(guestEnv[Math.round(11.0 / 0.01)] > -35, 'konuk 11 sn konuşuyor olmalı');

  const p = planner.plan(analysis, s, {});
  const cuts = p.rows.filter(r => r.enabled);
  const fill = cuts.filter(r => r.type === 'filler');
  const sil = cuts.filter(r => r.type === 'silence');
  assert.strictEqual(fill.length, 1, JSON.stringify(cuts));
  assert.strictEqual(fill[0].source, 'ai');
  // sentetik konuşmanın son hecesi 2.9-3.0 sn arasında biter (+120 ms pay)
  assert.ok(near(fill[0].start, 3.07, 0.1) && near(fill[0].end, 5.72, 0.08), JSON.stringify(fill[0]));
  assert.strictEqual(sil.length, 1, JSON.stringify(sil));
  assert.ok(near(sil[0].start, 9.07, 0.1) && near(sil[0].end, 10.42, 0.08), JSON.stringify(sil[0]));
  assert.ok(near(p.newDuration, 14 - 2.6 - 1.3, 0.2), String(p.newDuration));

  // Yalnız akustik yöntem de aynı takılmayı bulmalı, konuşmada yanlış alarm vermemeli
  const pa = planner.plan(analysis, settings({ 'fillers.method': 'acoustic' }), {});
  const af = pa.rows.filter(r => r.type === 'filler');
  assert.strictEqual(af.length, 1, JSON.stringify(af));
  assert.strictEqual(af[0].source, 'acoustic');
  assert.ok(near(af[0].start, fill[0].start, 0.05) && near(af[0].end, fill[0].end, 0.05), JSON.stringify(af[0]));

  // Altyazı: takılma çıkarılmış, zamanlar kurguya göre kaydırılmış
  const map = timeline.createTimeMap(p.keepSec);
  const cues = subtitles.buildCues(analysis.words, map, fillersLib.parseFillerList(s.fillers.words), s.subtitles);
  const textAll = cues.map(c => c.lines.join(' ')).join(' | ');
  assert.ok(!/ıı/i.test(textAll), textAll);
  assert.ok(textAll.includes('Evet, başlayalım.'), textAll);
  const evet = cues.find(c => c.lines.join(' ').startsWith('Evet'));
  assert.ok(near(evet.start, map.toEdited(10.5), 0.01));

  // Önbellek: ikinci analiz whisper'ı çalıştırmadan aynı kelimeleri döndürür
  process.env.FAKE_WHISPER_WORDS = '[]';
  const again = await pipeline.analyze({
    seq: seqInfo(media), tracks: [{ index: 0 }, { index: 1 }], settings: s, ffmpegPath,
    whisperPath: fakeWhisper, modelPath, needWords: true, needAcoustic: false, dirs
  });
  assert.strictEqual(again.words.length, WORDS.length);
});

test('kanal seçimi (pan) ve eksik medya uyarısı', { skip: !ffmpegPath && 'ffmpeg bulunamadı' }, async () => {
  const media = buildMedia();
  const seq = seqInfo(media);
  seq.audioTracks[1].clips.push({ name: 'kayıp', path: path.join(tmp, 'yok.wav'), start: 13, end: 14, inPoint: 0, outPoint: 1 });
  const an = await pipeline.analyze({
    seq, tracks: [{ index: 0, channel: 2 }, { index: 1, channel: 0 }], settings: settings(), ffmpegPath,
    needWords: false, needAcoustic: false, dirs: paths.dirs(path.join(tmp, 'root2'))
  });
  assert.ok(an.warnings.some(w => w.includes('yok.wav')));
  assert.ok(an.tracks[0].envDb[Math.round(1.0 / 0.01)] > -35);
});

test('analiz + XML dönüşümü birlikte çalışır', { skip: !ffmpegPath && 'ffmpeg bulunamadı' }, async () => {
  const fcpxml = require('../extension/js/lib/fcpxml');
  const src = fs.readFileSync(path.join(__dirname, 'fixtures', 'premiere_sequence.xml'), 'utf8');
  // fixture 29.97 fps, 900 kare (~30 sn): sentetik bir planı uygula
  const keep = timeline.secondsToFrames([[0, 3.12], [5.72, 9.12], [10.42, 30.03]], 30000 / 1001);
  const pieces = timeline.buildPieces(keep, null);
  const res = fcpxml.transform(src, pieces, { sequenceName: 'Bölüm 1 - Podcast Kurgu' }, { DOMParser, XMLSerializer });
  const d = fcpxml.describe(res.xml, { DOMParser, XMLSerializer });
  assert.strictEqual(d.name, 'Bölüm 1 - Podcast Kurgu');
  const total = timeline.totalLength(keep);
  [...d.video, ...d.audio].forEach(tr => assert.strictEqual(tr[tr.length - 1].end, total));
});

test.after(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* yoksay */ }
});
