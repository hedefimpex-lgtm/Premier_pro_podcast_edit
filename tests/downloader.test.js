'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const downloader = require('../extension/js/lib/downloader');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-dl-'));
let server, base;

test.before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/file' }); res.end(); return; }
    if (req.url === '/file') { res.writeHead(200, { 'Content-Length': 5 }); res.end('merhb'); return; }
    if (req.url === '/slow') {
      res.writeHead(200, { 'Content-Length': 10 * 1024 * 1024 });
      const iv = setInterval(() => res.write(Buffer.alloc(64 * 1024)), 5);
      res.on('close', () => clearInterval(iv));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port;
});

test.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('yönlendirmeyi takip eder ve dosyayı yazar', async () => {
  const dest = path.join(tmp, 'a.bin');
  const seen = [];
  await downloader.download(base + '/redirect', dest, (g, t) => seen.push([g, t]));
  assert.strictEqual(fs.readFileSync(dest, 'utf8'), 'merhb');
  assert.deepStrictEqual(seen[seen.length - 1], [5, 5]);
  assert.ok(!fs.existsSync(dest + '.part'));
});

test('HTTP hatasında anlaşılır hata verir', async () => {
  await assert.rejects(downloader.download(base + '/yok', path.join(tmp, 'b.bin')), /HTTP 404/);
});

test('iptal edilince takılmadan reddeder ve yarım dosyayı siler', async () => {
  const dest = path.join(tmp, 'c.bin');
  const cancel = { cancelled: false };
  const p = downloader.download(base + '/slow', dest, (g) => { if (g > 200 * 1024) cancel.cancelled = true; }, cancel);
  await assert.rejects(p, /İptal/);
  await new Promise(r => setTimeout(r, 50));
  assert.ok(!fs.existsSync(dest) && !fs.existsSync(dest + '.part'));
});
