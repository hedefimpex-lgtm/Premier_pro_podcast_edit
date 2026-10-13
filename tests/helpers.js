'use strict';
/** Testler için sentetik analiz verisi üretimi. */
const audio = require('../extension/js/lib/audio');
const settingsLib = require('../extension/js/lib/settings');

const HOP = audio.HOP_SEC;

/**
 * segments: [[başSn, bitSn, dB], ...] — belirtilmeyen yerler gürültü tabanında (-65 dB)
 */
function envFrom(duration, segments, floor) {
  const n = Math.ceil(duration / HOP) + 1;
  const env = new Float32Array(n).fill(floor == null ? -65 : floor);
  segments.forEach(([a, b, db]) => {
    for (let f = Math.round(a / HOP); f < Math.round(b / HOP) && f < n; f++) env[f] = db;
  });
  return env;
}

function makeAnalysis(duration, tracksSegs, extra) {
  const tracks = tracksSegs.map((segs, i) => {
    const env = envFrom(duration, segs);
    return { index: i, name: 'A' + (i + 1), envDb: env, levels: audio.estimateLevels(env) };
  });
  const envDb = tracks.length === 1 ? tracks[0].envDb : audio.combineDb(tracks.map(t => t.envDb));
  return Object.assign({
    version: 1,
    sequenceId: 'seq-1',
    sequenceName: 'Test',
    fps: 30,
    duration,
    nFrames: envDb.length,
    tracks,
    envDb,
    zcr: new Float32Array(envDb.length),
    levels: audio.estimateLevels(envDb),
    features: null,
    words: null
  }, extra || {});
}

function settings(overrides) {
  let s = settingsLib.defaults();
  Object.keys(overrides || {}).forEach(k => settingsLib.setPath(s, k, overrides[k]));
  return s;
}

module.exports = { envFrom, makeAnalysis, settings, HOP };
