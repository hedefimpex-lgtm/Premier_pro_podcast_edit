'use strict';
/**
 * Araç (FFmpeg, whisper.cpp, modeller) ve çalışma klasörlerinin yerleri.
 */
var fs = require('fs');
var os = require('os');
var path = require('path');
var childProcess = require('child_process');

var APP = 'PodcastKurgu';
var isWin = process.platform === 'win32';

function isAscii(p) {
  return /^[\x20-\x7e]*$/.test(p);
}

/**
 * Araç kök klasörü. whisper.cpp bazı Windows sürümlerinde ASCII dışı yolları açamadığı için
 * kullanıcı adı Türkçe karakter içeriyorsa C:\Users\Public altına düşülür.
 * (Kurulum programı da aynı kuralı uygular.)
 */
function toolsRoot() {
  if (isWin) {
    var candidates = [];
    if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, APP));
    if (process.env.PUBLIC) candidates.push(path.join(process.env.PUBLIC, APP));
    candidates.push('C:\\' + APP);
    for (var i = 0; i < candidates.length; i++) if (isAscii(candidates[i])) return candidates[i];
    return candidates[0];
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', APP);
  return path.join(os.homedir(), '.' + APP.toLowerCase());
}

function mkdirp(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function dirs(root) {
  root = root || toolsRoot();
  return {
    root: mkdirp(root),
    tools: mkdirp(path.join(root, 'tools')),
    models: mkdirp(path.join(root, 'models')),
    work: mkdirp(path.join(root, 'work')),
    cache: mkdirp(path.join(root, 'cache'))
  };
}

function exists(p) {
  try { return !!p && fs.statSync(p).isFile(); } catch (e) { return false; }
}

/** Klasörde (en fazla `depth` seviye) verilen adlardan birine sahip ilk dosyayı bulur. */
function findFile(dir, names, depth) {
  if (depth == null) depth = 4;
  var lower = names.map(function (n) { return n.toLowerCase(); });
  var entries;
  try { entries = fs.readdirSync(dir); } catch (e) { return null; }
  var subdirs = [];
  for (var pass = 0; pass < lower.length; pass++) {
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].toLowerCase() === lower[pass]) {
        var full = path.join(dir, entries[i]);
        if (exists(full)) return full;
      }
    }
  }
  if (depth <= 0) return null;
  entries.forEach(function (e) {
    var full = path.join(dir, e);
    try { if (fs.statSync(full).isDirectory()) subdirs.push(full); } catch (err) { /* yoksay */ }
  });
  for (i = 0; i < subdirs.length; i++) {
    var r = findFile(subdirs[i], names, depth - 1);
    if (r) return r;
  }
  return null;
}

function whichSync(cmd) {
  try {
    var out = childProcess.execSync((isWin ? 'where ' : 'command -v ') + cmd, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 5000 });
    var first = String(out).split(/\r?\n/)[0].trim();
    return exists(first) ? first : null;
  } catch (e) {
    return null;
  }
}

function exe(name) {
  return isWin ? name + '.exe' : name;
}

function findFfmpeg(custom, d) {
  if (exists(custom)) return custom;
  d = d || dirs();
  return findFile(path.join(d.tools, 'ffmpeg'), [exe('ffmpeg')]) || whichSync('ffmpeg');
}

function findWhisper(custom, d) {
  if (exists(custom)) return custom;
  d = d || dirs();
  return findFile(path.join(d.tools, 'whisper'), [exe('whisper-cli'), exe('main')]) ||
    whichSync('whisper-cli') || whichSync('whisper-cpp');
}

function listModels(d) {
  d = d || dirs();
  try {
    return fs.readdirSync(d.models).filter(function (f) { return /^ggml-.*\.bin$/i.test(f); }).map(function (f) {
      var full = path.join(d.models, f);
      return { name: f, path: full, size: fs.statSync(full).size };
    });
  } catch (e) {
    return [];
  }
}

/** Çalışma klasöründeki eski geçici dosyaları temizler. */
function cleanWork(d, maxAgeHours) {
  d = d || dirs();
  var limit = Date.now() - (maxAgeHours == null ? 24 : maxAgeHours) * 3600 * 1000;
  try {
    fs.readdirSync(d.work).forEach(function (f) {
      var full = path.join(d.work, f);
      try {
        var st = fs.statSync(full);
        if (st.isFile() && st.mtimeMs < limit) fs.unlinkSync(full);
      } catch (e) { /* yoksay */ }
    });
  } catch (e) { /* yoksay */ }
}

function safeName(name) {
  return String(name || 'sekans').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'sekans';
}

module.exports = {
  APP: APP,
  toolsRoot: toolsRoot,
  dirs: dirs,
  mkdirp: mkdirp,
  exists: exists,
  findFile: findFile,
  findFfmpeg: findFfmpeg,
  findWhisper: findWhisper,
  listModels: listModels,
  cleanWork: cleanWork,
  safeName: safeName,
  isAscii: isAscii
};
