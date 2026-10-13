'use strict';
/**
 * FFmpeg ile medya dosyalarından 16 kHz mono PCM ses çözme.
 */
var childProcess = require('child_process');

/**
 * Bir klibin sesini çözer ve parça parça Int16Array olarak onChunk'a verir.
 * opts: { path, start (sn), duration (sn), channel (0 = tümünün karışımı, 1..n = tek kanal) }
 * cancel: { cancelled: bool, procs: [] } — iptal için süreç listesi tutulur.
 */
function decodePcm(ffmpegPath, opts, onChunk, cancel) {
  return new Promise(function (resolve, reject) {
    var args = ['-hide_banner', '-nostdin', '-v', 'error'];
    if (opts.start > 0) args.push('-ss', opts.start.toFixed(3));
    args.push('-i', opts.path);
    if (opts.duration > 0) args.push('-t', opts.duration.toFixed(3));
    args.push('-vn', '-sn', '-dn');
    if (opts.channel && opts.channel > 0) {
      args.push('-af', 'pan=mono|c0=c' + (opts.channel - 1));
    } else {
      args.push('-ac', '1');
    }
    args.push('-ar', '16000', '-acodec', 'pcm_s16le', '-f', 's16le', 'pipe:1');

    var proc;
    try {
      proc = childProcess.spawn(ffmpegPath, args, { windowsHide: true });
    } catch (e) {
      reject(e);
      return;
    }
    if (cancel && cancel.procs) cancel.procs.push(proc);

    var leftover = null;
    var stderr = '';
    var total = 0;

    proc.stdout.on('data', function (buf) {
      if (leftover) {
        buf = Buffer.concat([leftover, buf]);
        leftover = null;
      }
      var usable = buf.length & ~1;
      if (usable < buf.length) leftover = Buffer.from(buf.subarray(usable));
      if (!usable) return;
      var aligned = (buf.byteOffset & 1) === 0 ? buf : Buffer.from(buf);
      var samples = new Int16Array(aligned.buffer, aligned.byteOffset, usable >> 1);
      total += samples.length;
      onChunk(samples);
    });
    proc.stderr.on('data', function (d) {
      stderr += d.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    proc.on('error', function (err) {
      reject(new Error('FFmpeg çalıştırılamadı: ' + err.message));
    });
    proc.on('close', function (code) {
      if (cancel && cancel.procs) {
        var i = cancel.procs.indexOf(proc);
        if (i >= 0) cancel.procs.splice(i, 1);
      }
      if (cancel && cancel.cancelled) {
        reject(new Error('İptal edildi'));
      } else if (code !== 0 && total === 0) {
        reject(new Error('FFmpeg hata verdi (' + code + '): ' + stderr.trim().split('\n').slice(-3).join(' ')));
      } else {
        resolve({ samples: total, warnings: stderr.trim() });
      }
    });
  });
}

/** FFmpeg sürümünü döndürür (çalışıyorsa). */
function version(ffmpegPath) {
  return new Promise(function (resolve) {
    try {
      childProcess.execFile(ffmpegPath, ['-version'], { windowsHide: true, timeout: 15000 }, function (err, stdout) {
        if (err) { resolve(null); return; }
        var m = /ffmpeg version (\S+)/.exec(stdout || '');
        resolve(m ? m[1] : 'bilinmiyor');
      });
    } catch (e) {
      resolve(null);
    }
  });
}

module.exports = {
  decodePcm: decodePcm,
  version: version
};
