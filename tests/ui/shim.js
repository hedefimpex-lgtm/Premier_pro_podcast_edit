/*
 * Tarayıcı içinde CEP + Node ortamını taklit eden test katmanı.
 * window.__PK_SOURCES__ (modül kaynakları) ve window.__PK_FIXTURE__ (Premiere XML) önceden enjekte edilir.
 */
(function () {
  'use strict';
  var calls = window.__PK_CALLS__ = [];
  var files = {};
  var dirs = { '/': true };

  function norm(p) {
    var out = [];
    String(p).replace(/\\/g, '/').split('/').forEach(function (seg, i) {
      if (seg === '..') out.pop();
      else if (seg !== '.' && (seg || i === 0)) out.push(seg);
    });
    return out.join('/') || '/';
  }
  var pathMod = {
    sep: '/',
    join: function () { return norm(Array.prototype.slice.call(arguments).join('/')).replace(/\/$/, '') || '/'; },
    basename: function (p) { return norm(p).split('/').pop(); },
    dirname: function (p) { var a = norm(p).split('/'); a.pop(); return a.join('/') || '/'; }
  };
  function mkdirs(p) { var parts = norm(p).split('/'); var cur = ''; parts.forEach(function (x) { if (!x) return; cur += '/' + x; dirs[cur] = true; }); }
  function stat(p) {
    p = norm(p);
    if (files[p] !== undefined) return { isFile: function () { return true; }, isDirectory: function () { return false; }, size: files[p].length, mtimeMs: 1 };
    if (dirs[p]) return { isFile: function () { return false; }, isDirectory: function () { return true; }, size: 0, mtimeMs: 1 };
    var e = new Error('ENOENT: ' + p); e.code = 'ENOENT'; throw e;
  }
  var fsMod = {
    existsSync: function (p) { p = norm(p); return files[p] !== undefined || !!dirs[p]; },
    statSync: stat,
    mkdirSync: function (p) { mkdirs(p); },
    readdirSync: function (p) {
      p = norm(p).replace(/\/$/, '');
      if (!dirs[p]) { var e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      var out = {};
      Object.keys(files).concat(Object.keys(dirs)).forEach(function (f) {
        if (f.indexOf(p + '/') === 0) out[f.slice(p.length + 1).split('/')[0]] = true;
      });
      return Object.keys(out);
    },
    readFileSync: function (p) { p = norm(p); if (files[p] === undefined) throw new Error('ENOENT ' + p); return files[p]; },
    writeFileSync: function (p, data) { p = norm(p); mkdirs(pathMod.dirname(p)); files[p] = String(data); },
    unlinkSync: function (p) { delete files[norm(p)]; }
  };
  window.__PK_FS__ = files;

  var HOME = '/home/test';
  var builtins = {
    path: pathMod,
    fs: fsMod,
    os: { homedir: function () { return HOME; }, cpus: function () { return [1, 2, 3, 4]; }, tmpdir: function () { return '/tmp'; } },
    child_process: {
      execSync: function () { throw new Error('yok'); },
      execFile: function (cmd, args, opts, cb) { setTimeout(function () { cb(null, 'ffmpeg version 7.1-test'); }, 0); },
      spawn: function () { throw new Error('spawn test ortamında yok'); }
    },
    https: {}, http: {}, crypto: {}
  };
  window.process = { platform: 'linux', env: {} };

  // Araçlar "kurulu" görünsün
  fsMod.writeFileSync(HOME + '/.podcastkurgu/tools/ffmpeg/bin/ffmpeg', 'bin');
  fsMod.writeFileSync(HOME + '/.podcastkurgu/tools/whisper/whisper-cli', 'bin');
  fsMod.writeFileSync(HOME + '/.podcastkurgu/models/ggml-small.bin', 'model');

  var cache = {};
  function makeRequire(base) {
    return function (name) {
      if (builtins[name]) return builtins[name];
      var full = name.charAt(0) === '.' ? pathMod.join(pathMod.dirname(base), name) : name;
      if (!/\.js$/.test(full)) full += '.js';
      full = norm(full);
      if (cache[full]) return cache[full].exports;
      var key = full.split('/js/lib/')[1];
      var src = window.__PK_SOURCES__[key];
      if (!src) throw new Error('Modül yok: ' + full);
      var mod = { exports: {} };
      cache[full] = mod;
      new Function('module', 'exports', 'require', src)(mod, mod.exports, makeRequire(full));
      return mod.exports;
    };
  }
  window.PK_DEV_ROOT = '/ext';
  window.cep_node = { require: makeRequire('/ext/index.html') };

  // ---- Premiere (ExtendScript) taklidi
  var SEQ = {
    id: 'seq-1', name: 'Bölüm 12 — Konuk', fps: 30000 / 1001, duration: 900 * 1001 / 30000,
    videoTracks: [{ index: 0, name: 'Geniş', clips: 2 }, { index: 1, name: 'Kamera A', clips: 1 }, { index: 2, name: 'Kamera B', clips: 1 }],
    audioTracks: [
      { index: 0, name: 'Sunucu Mik', muted: false, clips: [{ name: 'sunucu.wav', path: '/m/sunucu.wav', start: 0, end: 30, inPoint: 0, outPoint: 30 }] },
      { index: 1, name: 'Konuk Mik', muted: false, clips: [{ name: 'konuk.wav', path: '/m/konuk.wav', start: 0, end: 30, inPoint: 0, outPoint: 30 }] },
      { index: 2, name: 'Müzik', muted: true, clips: [] }
    ]
  };
  var PK = {
    ping: function () { return { ok: true, version: '1.0.0', app: '25.5.0' }; },
    getSequenceInfo: function () { return { ok: true, sequence: SEQ }; },
    activeSequenceId: function () { return { ok: true, id: SEQ.id, name: SEQ.name }; },
    exportXml: function (id, p) { fsMod.writeFileSync(p, window.__PK_FIXTURE__); return { ok: true, path: p }; },
    importXml: function (p, name) { window.__PK_IMPORTED_XML__ = fsMod.readFileSync(p); return { ok: true, id: 'seq-new', name: name }; },
    importCaptions: function (id, p) { window.__PK_SRT__ = { seq: id, text: fsMod.readFileSync(p) }; return { ok: true, created: true }; },
    addMarkers: function (id, m) { window.__PK_MARKERS__ = m; return { ok: true, count: m.length }; },
    clearMarkers: function () { return { ok: true, removed: 3 }; },
    setPlayhead: function (id, t) { window.__PK_PLAYHEAD__ = t; return { ok: true }; }
  };
  window.__adobe_cep__ = {
    evalScript: function (script, cb) {
      calls.push(script);
      var res;
      try { res = JSON.stringify(new Function('PK', 'return ' + script)(PK)); } catch (e) { res = 'EvalScript error.'; }
      setTimeout(function () { cb(res); }, 5);
    },
    getSystemPath: function () { return 'file:///ext'; },
    getHostEnvironment: function () { return '{}'; }
  };
}());
