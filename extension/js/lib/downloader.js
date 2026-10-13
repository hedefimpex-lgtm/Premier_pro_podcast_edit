'use strict';
/**
 * Bileşen indirici: FFmpeg, whisper.cpp ve Whisper modelleri.
 * Kurulum programı da aynı adresleri kullanır; panel, eksik olanları sonradan indirebilir.
 */
var fs = require('fs');
var path = require('path');
var https = require('https');
var http = require('http');
var childProcess = require('child_process');
var paths = require('./paths');

var WHISPER_VERSION = 'v1.7.6';

var COMPONENTS = {
  ffmpeg: {
    label: 'FFmpeg',
    urls: [
      'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
      'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip'
    ],
    zip: true,
    dir: 'ffmpeg'
  },
  whisper: {
    label: 'Whisper (whisper.cpp)',
    urls: [
      'https://github.com/ggml-org/whisper.cpp/releases/download/' + WHISPER_VERSION + '/whisper-bin-x64.zip',
      'https://github.com/ggml-org/whisper.cpp/releases/latest/download/whisper-bin-x64.zip'
    ],
    zip: true,
    dir: 'whisper'
  }
};

var MODEL_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/';

var MODELS = [
  { file: 'ggml-base.bin', label: 'Base — hızlı, orta doğruluk', size: '142 MB' },
  { file: 'ggml-small.bin', label: 'Small — önerilen denge', size: '466 MB' },
  { file: 'ggml-large-v3-turbo-q5_0.bin', label: 'Large v3 Turbo (Q5) — en iyi Türkçe, hızlı', size: '547 MB' },
  { file: 'ggml-medium.bin', label: 'Medium — yüksek doğruluk, yavaş', size: '1.5 GB' },
  { file: 'ggml-large-v3-turbo.bin', label: 'Large v3 Turbo — en iyi doğruluk', size: '1.6 GB' }
];

/** Yönlendirmeleri takip ederek dosya indirir. onProgress(alınan, toplam) */
function download(url, dest, onProgress, cancel, redirects) {
  redirects = redirects || 0;
  return new Promise(function (resolve, reject) {
    if (redirects > 8) { reject(new Error('Çok fazla yönlendirme')); return; }
    var lib = url.indexOf('https:') === 0 ? https : http;
    var req = lib.get(url, { headers: { 'User-Agent': 'PodcastKurgu/1.0' } }, function (res) {
      if ([301, 302, 303, 307, 308].indexOf(res.statusCode) >= 0 && res.headers.location) {
        res.resume();
        var next = new URL(res.headers.location, url).href;
        download(next, dest, onProgress, cancel, redirects + 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error('İndirme başarısız (HTTP ' + res.statusCode + '): ' + url));
        return;
      }
      var total = parseInt(res.headers['content-length'] || '0', 10);
      var got = 0;
      var tmp = dest + '.part';
      var file = fs.createWriteStream(tmp);
      res.on('data', function (chunk) {
        got += chunk.length;
        if (onProgress) onProgress(got, total);
        if (cancel && cancel.cancelled) {
          req.abort();
          file.close();
        }
      });
      res.pipe(file);
      file.on('finish', function () {
        file.close(function () {
          if (cancel && cancel.cancelled) { safeUnlink(tmp); reject(new Error('İptal edildi')); return; }
          if (total && got < total) { safeUnlink(tmp); reject(new Error('İndirme yarıda kaldı')); return; }
          try {
            safeUnlink(dest);
            fs.renameSync(tmp, dest);
            resolve(dest);
          } catch (e) { reject(e); }
        });
      });
      file.on('error', function (e) { safeUnlink(tmp); reject(e); });
      res.on('error', function (e) { safeUnlink(tmp); reject(e); });
    });
    req.on('error', function (e) { reject(new Error('Bağlantı hatası: ' + e.message)); });
    req.setTimeout(60000, function () { req.abort(); });
  });
}

function safeUnlink(p) {
  try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) { /* yoksay */ }
}

function run(cmd, args) {
  return new Promise(function (resolve, reject) {
    var p = childProcess.spawn(cmd, args, { windowsHide: true });
    var err = '';
    p.stderr.on('data', function (d) { err += d; });
    p.on('error', reject);
    p.on('close', function (code) { if (code === 0) resolve(); else reject(new Error(err.trim() || ('çıkış kodu ' + code))); });
  });
}

/** ZIP açma: Windows 10+ içindeki tar.exe, olmazsa PowerShell Expand-Archive. */
function extractZip(zip, destDir) {
  paths.mkdirp(destDir);
  var tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'unzip';
  if (process.platform !== 'win32') return run('unzip', ['-o', '-q', zip, '-d', destDir]);
  return run(tar, ['-xf', zip, '-C', destDir]).catch(function () {
    var ps = "Expand-Archive -LiteralPath '" + zip.replace(/'/g, "''") + "' -DestinationPath '" + destDir.replace(/'/g, "''") + "' -Force";
    return run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps]);
  });
}

async function tryUrls(urls, dest, onProgress, cancel) {
  var lastErr = null;
  for (var i = 0; i < urls.length; i++) {
    try {
      return await download(urls[i], dest, onProgress, cancel);
    } catch (e) {
      lastErr = e;
      if (cancel && cancel.cancelled) throw e;
    }
  }
  throw lastErr || new Error('İndirilemedi');
}

/** FFmpeg ya da whisper.cpp'yi indirip kurar. Dönüş: çalıştırılabilir dosya yolu */
async function installTool(name, onProgress, cancel) {
  var c = COMPONENTS[name];
  if (!c) throw new Error('Bilinmeyen bileşen: ' + name);
  var d = paths.dirs();
  var zip = path.join(d.work, name + '.zip');
  await tryUrls(c.urls, zip, onProgress, cancel);
  var dest = path.join(d.tools, c.dir);
  await extractZip(zip, dest);
  safeUnlink(zip);
  var found = name === 'ffmpeg' ? paths.findFfmpeg(null, d) : paths.findWhisper(null, d);
  if (!found) throw new Error(c.label + ' arşivden çıkarıldı ama çalıştırılabilir dosya bulunamadı.');
  return found;
}

async function installModel(file, onProgress, cancel) {
  var d = paths.dirs();
  var dest = path.join(d.models, file);
  await download(MODEL_BASE + file, dest, onProgress, cancel);
  return dest;
}

module.exports = {
  COMPONENTS: COMPONENTS,
  MODELS: MODELS,
  MODEL_BASE: MODEL_BASE,
  download: download,
  extractZip: extractZip,
  installTool: installTool,
  installModel: installModel
};
