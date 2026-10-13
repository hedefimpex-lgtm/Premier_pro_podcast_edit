'use strict';
/**
 * Test için sentetik "konuşma" ve "takılma" sesi üretir (48 kHz stereo WAV).
 * Konuşma: hece hızında değişen perde ve ünlü tınısı; takılma: sabit perdeli, sabit tınılı uzun ünlü.
 */
const fs = require('fs');

const SR = 48000;
const VOWELS = [[700, 1200], [300, 2200], [450, 1800], [350, 900], [600, 1700], [300, 1500]];

function seeded(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function formantGain(freq, formants) {
  let g = 0;
  formants.forEach(F => { const x = (freq - F) / 120; g += 1 / (1 + x * x); });
  return g;
}

/** Bir sesli bölümü buffer'a ekler. f0At(t) ve formantsAt(t) zamana bağlı fonksiyonlar. */
function voiced(buf, t0, t1, amp, f0At, formantsAt) {
  let phase = 0;
  const a = Math.round(t0 * SR), b = Math.round(t1 * SR);
  const fade = Math.round(0.015 * SR);
  for (let i = a; i < b && i < buf.length; i++) {
    const t = (i - a) / SR;
    const f0 = f0At(t);
    phase += 2 * Math.PI * f0 / SR;
    const forms = formantsAt(t);
    let v = 0;
    for (let h = 1; h * f0 < 3800; h++) v += formantGain(h * f0, forms) * Math.sin(h * phase) / Math.sqrt(h);
    let env = 1;
    if (i - a < fade) env = (i - a) / fade;
    if (b - i < fade) env = Math.min(env, (b - i) / fade);
    buf[i] += amp * env * v * 0.25;
  }
}

/** Heceli konuşma: 150-220 ms heceler, her hecede farklı ünlü ve perde, aralarda kısa ünsüz gürültüsü */
function speech(buf, t0, t1, amp, seed) {
  const rnd = seeded(seed);
  let t = t0;
  while (t < t1 - 0.1) {
    const dur = Math.min(0.15 + rnd() * 0.07, t1 - t);
    const vowel = VOWELS[Math.floor(rnd() * VOWELS.length)];
    const f0a = 100 + rnd() * 90, f0b = 100 + rnd() * 90;
    voiced(buf, t, t + dur, amp * (0.6 + rnd() * 0.4), tt => f0a + (f0b - f0a) * (tt / dur), () => vowel);
    // ünsüz: kısa gürültü
    const na = Math.round((t + dur) * SR), nb = Math.round((t + dur + 0.03) * SR);
    for (let i = na; i < nb && i < buf.length; i++) buf[i] += (rnd() * 2 - 1) * amp * 0.12;
    t += dur + 0.03;
  }
}

/** Takılma: "ıııı" — sabit perde, sabit tını */
function filler(buf, t0, t1, amp) {
  voiced(buf, t0, t1, amp, tt => 118 + Math.sin(tt * 9) * 0.6, () => [320, 1650]);
}

function noise(buf, amp, seed) {
  const rnd = seeded(seed);
  for (let i = 0; i < buf.length; i++) buf[i] += (rnd() * 2 - 1) * amp;
}

function writeWav48(path, mono) {
  const n = mono.length;
  const data = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, mono[i]));
    const s = Math.round(v * 32767);
    data.writeInt16LE(s, i * 4);
    data.writeInt16LE(s, i * 4 + 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(SR, 24);
  h.writeUInt32LE(SR * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(path, Buffer.concat([h, data]));
}

function buffer(seconds) {
  return new Float32Array(Math.round(seconds * SR));
}

module.exports = { SR, speech, filler, noise, writeWav48, buffer };
