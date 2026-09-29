// NAVIA navigator — LAYER 2, step 1: text normalisation before intent
// classification. Corrects typos and wrong keyboard layout in words that are
// not known, towards the navigator's vocabulary (vocabulary.ts, built from
// the question bank):
//   - a word typed in the Latin layout by mistake ("cbuyfk" → "сигнал");
//   - Damerau–Levenshtein distance with a safe threshold by word length:
//     4 letters — only two neighbouring letters swapped; 5–7 — 1 edit;
//     8+ — 2 edits; words under 4 letters are never touched;
//   - a correction is made only when ONE vocabulary word is the closest
//     (a tie between different words = no guess).
// Known words (in the vocabulary, or starting a vocabulary word / started by
// one — inflections) are left alone. Pure; unit-tested.
import { fold } from "../copilotBrain";
import { VOCABULARY } from "./vocabulary";

const VOCAB = new Set(VOCABULARY);
const byLength = new Map<number, string[]>();
for (const w of VOCABULARY) { const l = byLength.get(w.length); if (l) l.push(w); else byLength.set(w.length, [w]); }
/** Common words that must never be "corrected" into a keyword. */
const KEEP = new Set(["мене", "мени", "тебе", "тоби", "йому", "вона", "воно", "вони", "наша", "ваша", "який", "яка", "якщо", "коли", "тому", "треба", "можна", "будь", "ласка", "дуже", "тепер", "зараз", "сейчас", "теперь", "очень", "есть", "нету", "тоже", "также", "этот", "этой", "этом", "цей", "цього", "там", "тут", "then", "that", "this", "what", "with", "have", "your", "from", "about"].map(fold));

/** Optimal string alignment distance (Damerau–Levenshtein with adjacent swaps), capped. */
export function editDistance(a: string, b: string, cap = 3): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const m = a.length, n = b.length;
  let prev2 = new Array<number>(n + 1).fill(0);
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = new Array<number>(n + 1);
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2]! + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > cap) return cap + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[n]!;
}

const EN = "qwertyuiop[]asdfghjkl;'zxcvbnm,.";
const UK = "йцукенгшщзхїфівапролджєячсмитьбю";
const RU = "йцукенгшщзхъфывапролджэячсмитьбю";
function fromLayout(word: string, target: string): string {
  return [...word.toLowerCase()].map((ch) => { const i = EN.indexOf(ch); return i >= 0 ? target[i]! : ch; }).join("");
}

function known(w: string): boolean {
  if (VOCAB.has(w) || KEEP.has(w)) return true;
  // An inflection of a known word: shares all but the last 1–3 letters.
  for (let cut = 1; cut <= 3 && w.length - cut >= 4; cut++) {
    const stem = w.slice(0, w.length - cut);
    for (const v of byLength.get(w.length) ?? []) if (v.startsWith(stem)) return true;
    for (let d = -3; d <= 3; d++) for (const v of byLength.get(w.length + d) ?? []) if (v.startsWith(stem) && Math.abs(v.length - w.length) <= 3) return true;
  }
  return false;
}

function allowedEdits(len: number): number {
  return len < 4 ? 0 : len === 4 ? 1 : len <= 7 ? 1 : 2;
}

/** The single closest vocabulary word within the threshold, or null. */
function closest(w: string): string | null {
  const limit = allowedEdits(w.length);
  if (limit === 0) return null;
  let best: string | null = null, bestD = limit + 1, tie = false;
  for (let d = -limit; d <= limit; d++) {
    for (const v of byLength.get(w.length + d) ?? []) {
      const dist = editDistance(w, v, limit);
      if (dist > limit) continue;
      // 4-letter words: only a swap of neighbours (distance 1 with same letters).
      if (w.length === 4 && [...w].sort().join("") !== [...v].sort().join("")) continue;
      if (dist < bestD) { best = v; bestD = dist; tie = false; }
      else if (dist === bestD && v !== best && v.slice(0, 4) !== best?.slice(0, 4)) tie = true;
    }
  }
  return tie ? null : best;
}

export type Normalized = { text: string; fixes: { from: string; to: string; how: "layout" | "typo" }[] };

export function normalizeQuestion(question: string): Normalized {
  const fixes: Normalized["fixes"] = [];
  // Raw tokens first: a wrong-layout word keeps its , . ; [ ] ' (they are letters there).
  const tokens = question.toLocaleLowerCase("uk-UA").split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (const raw of tokens) {
    const f = fold(raw);
    if (!f) continue;
    if (/\d/.test(f) || known(f)) { out.push(f); continue; }
    const core = raw.replace(/^[?!]+|[?!]+$/g, "");
    if (/^[a-z\[\];',.`]+$/.test(core) && core.replace(/[^a-z]/g, "").length >= 2 && core.length >= 3) {
      let fixed: string | null = null;
      for (const target of [UK, RU]) {
        const c = fold(fromLayout(core, target));
        if (c.length >= 3 && (known(c) || closest(c))) { fixed = known(c) ? c : closest(c)!; break; }
      }
      if (fixed) { fixes.push({ from: core, to: fixed, how: "layout" }); out.push(fixed); continue; }
    }
    const parts = f.split(" ");
    for (const w of parts) {
      if (/\d/.test(w) || known(w)) { out.push(w); continue; }
      const c = closest(w);
      if (c) { fixes.push({ from: w, to: c, how: "typo" }); out.push(c); } else out.push(w);
    }
  }
  return { text: out.join(" "), fixes };
}
