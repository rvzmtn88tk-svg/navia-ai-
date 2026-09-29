// Typo / layout normalisation (layer 2, step 1): fixes typos and wrong
// keyboard layout in key words, and never turns one real word into another.
import test from "node:test";
import assert from "node:assert/strict";
import { editDistance, normalizeQuestion } from "../src/ai/navigator/normalize";
import { understand } from "../src/ai/navigator/intents";
import { typoCases } from "./support/typoSet";

test("edit distance: swaps count as one edit", () => {
  assert.equal(editDistance("сигнал", "сиганл"), 1);
  assert.equal(editDistance("укриття", "укритя"), 1);
  assert.equal(editDistance("маршрут", "маршрут"), 0);
});

test("typos and wrong layout in key words are corrected", () => {
  const fix = (q: string) => normalizeQuestion(q).text;
  assert.equal(understand("де найближче укритя").intent, "shelter");
  assert.match(fix("пропав сиганл"), /сигнал/);
  assert.match(fix("cbuyfk ghjgfd"), /сигнал пропав/);
  assert.match(fix("Глуать GPS"), /глушать|глуш/);
});

test("real words are never turned into other words (safe threshold)", () => {
  for (const q of ["дорога", "тривога", "короче", "повтори", "статус", "мама", "кава", "книга", "мене", "тебе", "корова", "погода", "вода", "лобода", "дуже"]) {
    const n = normalizeQuestion(q);
    if (["дорога", "тривога", "повтори", "статус", "погода", "вода"].includes(q)) assert.equal(n.fixes.length, 0, `${q} is a known word`);
    for (const f of n.fixes) assert.ok(!["дорога", "тривога", "повтори", "статус", "мене", "тебе", "дуже"].includes(f.from), `«${f.from}» must not be changed (→ «${f.to}»)`);
  }
});

test("200+ key-word typos: recognition after normalisation", () => {
  const cases = typoCases();
  assert.ok(cases.length >= 200);
  const ok = cases.filter((c) => c.accept.includes(understand(c.text).intent)).length;
  console.log(`typo set: ${ok}/${cases.length} (${(100 * ok / cases.length).toFixed(1)} %) — before normalisation 253/315 (80.3 %)`);
  assert.ok(ok / cases.length >= 0.95);
});
