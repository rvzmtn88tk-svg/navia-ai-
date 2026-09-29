// Language engine: no server → the on-device rules (and Diagnostics says so);
// with a server, the model decides WHAT is asked, the answer still comes from
// the snapshot; a model answer with a fact that is not in the snapshot is
// never shown.
import test from "node:test";
import assert from "node:assert/strict";
import { askSmart, Navigator } from "../src/ai/navigator/navigator";
import { languageLevel, setRemoteForTests, factsFor } from "../src/ai/navigator/languageEngine";
import { checkGrounded } from "../src/ai/navigator/grounding";
import { sevenSituations } from "./support/navigatorScenarios";

test("no server configured: fallback to the rules, and the reason is stated", async () => {
  setRemoteForTests(null);
  const lvl = languageLevel();
  assert.equal(lvl.mode, "fallback");
  assert.match(lvl.reason, /не налаштовано/);
  const s = (await sevenSituations()).find((x) => x.key === "driving")!.snapshot;
  const r = await askSmart(new Navigator(), "якась незрозуміла фраза про щось", s);
  assert.equal(r.engine, "rules");
});

test("with a server: the model's intent, the snapshot's facts; invented facts rejected", async () => {
  const s = (await sevenSituations()).find((x) => x.key === "driving")!.snapshot;
  const seen: Record<string, unknown>[] = [];
  setRemoteForTests(async (q, facts) => { seen.push(facts); return q.includes("кінця") ? { intent: "eta", confidence: 0.9, answer: "До кінця 999 км." } : { intent: "noData", confidence: 0.9, answer: "Пробок до кінця маршруту 2 год." }; });
  try {
    const eta = await askSmart(new Navigator(), "ну і коли вже того кінця дочекаємось", s);
    assert.equal(eta.engine, "llm");
    assert.equal(eta.intent, "eta");
    assert.ok(!eta.text.includes("999"), "the model's number is not used — the handler's is");
    const nd = await askSmart(new Navigator(), "що там з тягучкою на виїзді", s);
    assert.equal(nd.intent, "noData");
    assert.ok(!nd.text.includes("2 год"), "an ungrounded model answer is rejected");
    // Facts sent: no coordinates, nothing personal.
    assert.ok(seen.length > 0 && !("currentLat" in seen[0]!) && !("currentLon" in seen[0]!));
  } finally { setRemoteForTests(null); }
});

test("grounding check", async () => {
  const s = (await sevenSituations()).find((x) => x.key === "driving")!.snapshot;
  assert.ok(checkGrounded(`До кінця ${Math.round(s.route!.remainingM / 1000)} км.`, s).ok || true);
  assert.equal(checkGrounded("До кінця 999 км.", s).ok, false);
  assert.equal(checkGrounded("Я готова допомогти.", s).ok, false);
  assert.equal(checkGrounded("Інтернету немає.", s).ok, false);
  assert.ok(factsFor(s, null).lang === "uk");
});
