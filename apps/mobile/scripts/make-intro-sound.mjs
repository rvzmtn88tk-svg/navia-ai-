// Generates assets/navia-intro.wav: NAVIA's ~2 s startup chime.
// Original synthesis (no third-party samples): a rising three-note sine
// arpeggio with a soft FM shimmer, passed through a comb filter whose delay
// is swept (the "digital, futuristic" colour), then a light stereo echo tail.
// Run: node scripts/make-intro-sound.mjs
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SR = 44100;
const DURATION = 2.0;
const N = Math.round(SR * DURATION);

// E5, B5, E6 — an open fifth/octave: confident, not melodic "jingle".
const NOTES = [
  { f: 659.26, at: 0.0, amp: 0.55 },
  { f: 987.77, at: 0.11, amp: 0.45 },
  { f: 1318.51, at: 0.22, amp: 0.38 },
];

const dry = new Float64Array(N);
for (const { f, at, amp } of NOTES) {
  const start = Math.round(at * SR);
  for (let i = start; i < N; i++) {
    const t = (i - start) / SR;
    const attack = Math.min(1, t / 0.012);
    const env = attack * Math.exp(-t * 2.6);
    const shimmer = 0.35 * Math.exp(-t * 6) * Math.sin(2 * Math.PI * f * 2.005 * t);
    dry[i] += amp * env * Math.sin(2 * Math.PI * f * t + shimmer);
  }
}
// Low sub "boot" thump under the first note.
for (let i = 0; i < Math.round(0.5 * SR); i++) {
  const t = i / SR;
  dry[i] += 0.28 * Math.min(1, t / 0.02) * Math.exp(-t * 7) * Math.sin(2 * Math.PI * 82.4 * t);
}

// Comb filter with a slowly swept delay (1.2 → 4.5 ms) and feedback.
function comb(input, phase) {
  const out = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const delayS = 0.0012 + 0.0033 * (0.5 - 0.5 * Math.cos(2 * Math.PI * 0.45 * t + phase));
    const d = delayS * SR;
    const j = i - d;
    const j0 = Math.floor(j);
    const frac = j - j0;
    const past = j0 >= 1 ? out[j0] * (1 - frac) + out[j0 + 1] * frac : 0;
    out[i] = input[i] + 0.62 * past;
  }
  return out;
}

const left = comb(dry, 0);
const right = comb(dry, Math.PI / 2);

// Stereo ping-pong echo tail.
function echo(ch, other, delayS, gain) {
  const d = Math.round(delayS * SR);
  for (let i = N - 1; i >= d; i--) ch[i] += gain * other[i - d];
}
const l0 = Float64Array.from(left);
const r0 = Float64Array.from(right);
echo(left, r0, 0.19, 0.22);
echo(right, l0, 0.27, 0.2);

// Fade out the last 250 ms and normalise to -3 dBFS.
const fade = Math.round(0.25 * SR);
for (let i = N - fade; i < N; i++) {
  const g = (N - i) / fade;
  left[i] *= g;
  right[i] *= g;
}
let peak = 0;
for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
const norm = 0.708 / peak;

const data = Buffer.alloc(N * 4);
for (let i = 0; i < N; i++) {
  data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, left[i] * norm)) * 32767), i * 4);
  data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, right[i] * norm)) * 32767), i * 4 + 2);
}
const header = Buffer.alloc(44);
header.write("RIFF", 0);
header.writeUInt32LE(36 + data.length, 4);
header.write("WAVE", 8);
header.write("fmt ", 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(2, 22);
header.writeUInt32LE(SR, 24);
header.writeUInt32LE(SR * 4, 28);
header.writeUInt16LE(4, 32);
header.writeUInt16LE(16, 34);
header.write("data", 36);
header.writeUInt32LE(data.length, 40);

const out = fileURLToPath(new URL("../assets/navia-intro.wav", import.meta.url));
writeFileSync(out, Buffer.concat([header, data]));
console.log(`wrote ${out} (${DURATION}s, ${SR} Hz stereo)`);
