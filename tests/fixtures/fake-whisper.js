#!/usr/bin/env node
'use strict';
/**
 * whisper.cpp yerine geçen sahte program (testler için).
 * Parametreleri doğrular, ilerleme yazar ve önceden bilinen kelimeleri JSON olarak çıkarır.
 */
const fs = require('fs');
const args = process.argv.slice(2);
const get = flag => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };

['-m', '-f', '-of', '-l'].forEach(f => { if (!get(f)) { console.error('eksik parametre ' + f); process.exit(2); } });
['-oj', '-sow', '-pp'].forEach(f => { if (args.indexOf(f) < 0) { console.error('eksik bayrak ' + f); process.exit(2); } });
if (get('-ml') !== '1') { console.error('-ml 1 bekleniyordu'); process.exit(2); }
const wav = fs.readFileSync(get('-f'));
if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.readUInt32LE(24) !== 16000 || wav.readUInt16LE(22) !== 1) {
  console.error('16 kHz mono WAV bekleniyordu'); process.exit(3);
}
fs.writeFileSync(get('-of') + '.args.json', JSON.stringify(args));

const words = JSON.parse(process.env.FAKE_WHISPER_WORDS || '[]');
[0, 25, 50, 75, 100].forEach(p => process.stderr.write('whisper_print_progress_callback: progress = ' + p + '%\n'));
const ms = s => Math.round(s * 1000);
const out = {
  systeminfo: 'fake',
  result: { language: get('-l') },
  transcription: words.map(w => ({
    timestamps: { from: '00:00:00,000', to: '00:00:00,000' },
    offsets: { from: ms(w[0]), to: ms(w[1]) },
    text: w[2]
  }))
};
fs.writeFileSync(get('-of') + '.json', JSON.stringify(out, null, 1));
