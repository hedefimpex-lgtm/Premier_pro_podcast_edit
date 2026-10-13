'use strict';
/**
 * Ses analizi yardımcıları. Tüm analiz 16 kHz mono 16-bit PCM üzerinde,
 * 10 ms'lik (160 örnek) kareler halinde yapılır.
 */
var fs = require('fs');

var SAMPLE_RATE = 16000;
var HOP = 160;             // 10 ms
var HOP_SEC = HOP / SAMPLE_RATE;
var FLOOR_DB = -100;
var FULL_SCALE_SQ = 32768 * 32768;

/**
 * Bir ses kanalının zarfını (kare başına enerji) ve sıfır geçiş sayısını biriktirir,
 * istenirse örnekleri ortak karışıma (mix) ekler.
 */
function TrackAccumulator(nFrames, mix) {
  this.nFrames = nFrames;
  this.sumSq = new Float32Array(nFrames);
  this.zc = new Uint8Array(nFrames);
  this.mix = mix || null;
  this.totalSamples = nFrames * HOP;
}

/**
 * samples: Int16Array, pos: zaman çizelgesindeki başlangıç örnek indeksi.
 * prev: bir önceki örnek (sıfır geçişi için), dönüş: son örnek.
 */
TrackAccumulator.prototype.add = function (samples, pos, prev) {
  var sumSq = this.sumSq, zc = this.zc, mix = this.mix;
  var limit = Math.min(samples.length, this.totalSamples - pos);
  var last = prev || 0;
  for (var i = 0; i < limit; i++) {
    var p = pos + i;
    if (p < 0) continue;
    var s = samples[i];
    var f = (p / HOP) | 0;
    sumSq[f] += s * s;
    if ((s >= 0) !== (last >= 0)) zc[f]++;
    last = s;
    if (mix) {
      var m = mix[p] + s;
      mix[p] = m > 32767 ? 32767 : (m < -32768 ? -32768 : m);
    }
  }
  return last;
};

TrackAccumulator.prototype.toDb = function () {
  return energyToDb(this.sumSq, HOP);
};

function energyToDb(sumSq, hop) {
  var n = sumSq.length;
  var out = new Float32Array(n);
  for (var i = 0; i < n; i++) {
    var v = sumSq[i] / hop / FULL_SCALE_SQ;
    var db = v > 0 ? 10 * Math.log10(v) : FLOOR_DB;
    out[i] = db < FLOOR_DB ? FLOOR_DB : db;
  }
  return out;
}

/** Birden fazla dB zarfını güç toplamıyla birleştirir. */
function combineDb(envs) {
  if (!envs.length) return new Float32Array(0);
  var n = envs[0].length;
  var out = new Float32Array(n);
  for (var i = 0; i < n; i++) {
    var p = 0;
    for (var k = 0; k < envs.length; k++) p += Math.pow(10, envs[k][i] / 10);
    var db = p > 0 ? 10 * Math.log10(p) : FLOOR_DB;
    out[i] = db < FLOOR_DB ? FLOOR_DB : db;
  }
  return out;
}

/** Sıralanmış bir kopyadan yüzdelik değer (dijital sessizlik hariç). */
function percentiles(env, ps) {
  var step = Math.max(1, Math.floor(env.length / 200000)); // büyük dosyalarda örnekleme
  var tmp = new Float32Array(Math.ceil(env.length / step));
  var count = 0;
  for (var i = 0; i < env.length; i += step) if (env[i] > FLOOR_DB + 5) tmp[count++] = env[i];
  if (!count) return ps.map(function () { return FLOOR_DB; });
  var vals = tmp.subarray(0, count).sort(); // tür dizisi sıralaması sayısaldır ve hızlıdır
  return ps.map(function (p) {
    var idx = Math.min(vals.length - 1, Math.max(0, Math.round(p * (vals.length - 1))));
    return vals[idx];
  });
}

/** Gürültü tabanı ve tipik konuşma seviyesini tahmin eder. */
function estimateLevels(env) {
  var p = percentiles(env, [0.08, 0.5, 0.93]);
  return { noise: p[0], median: p[1], speech: p[2] };
}

/** Karışık sesi 16 kHz mono 16-bit WAV olarak yazar. */
function writeWav(filePath, int16, sampleRate) {
  sampleRate = sampleRate || SAMPLE_RATE;
  var dataBytes = int16.length * 2;
  var header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);            // PCM
  header.writeUInt16LE(1, 22);            // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);
  var fd = fs.openSync(filePath, 'w');
  try {
    fs.writeSync(fd, header, 0, 44);
    var chunk = 1 << 20; // 1M örnek
    for (var i = 0; i < int16.length; i += chunk) {
      var part = int16.subarray(i, Math.min(int16.length, i + chunk));
      var buf = Buffer.from(part.buffer, part.byteOffset, part.byteLength);
      fs.writeSync(fd, buf, 0, buf.length);
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** Test ve hata ayıklama için: WAV dosyasını Int16Array olarak okur (yalnızca 16-bit PCM). */
function readWav(filePath) {
  var buf = fs.readFileSync(filePath);
  var pos = 12;
  var sampleRate = 0, channels = 1;
  while (pos + 8 <= buf.length) {
    var id = buf.toString('ascii', pos, pos + 4);
    var size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(pos + 10);
      sampleRate = buf.readUInt32LE(pos + 12);
    } else if (id === 'data') {
      var data = Buffer.from(buf.subarray(pos + 8, pos + 8 + size));
      return { sampleRate: sampleRate, channels: channels, samples: new Int16Array(data.buffer, data.byteOffset, data.length >> 1) };
    }
    pos += 8 + size + (size & 1);
  }
  throw new Error('WAV verisi bulunamadı');
}

module.exports = {
  SAMPLE_RATE: SAMPLE_RATE,
  HOP: HOP,
  HOP_SEC: HOP_SEC,
  FLOOR_DB: FLOOR_DB,
  TrackAccumulator: TrackAccumulator,
  energyToDb: energyToDb,
  combineDb: combineDb,
  percentiles: percentiles,
  estimateLevels: estimateLevels,
  writeWav: writeWav,
  readWav: readWav
};
