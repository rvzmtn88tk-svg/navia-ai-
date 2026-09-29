// Layer 4 timing: a proactive message never cuts the phrase being spoken,
// and plays right after it — before answers that were already waiting.
import test from "node:test";
import assert from "node:assert/strict";
import { PRIORITY, SpeechQueue } from "../src/voice/speechQueue";

function fakePlayer() {
  const log: string[] = [];
  const pending: (() => void)[] = [];
  const play = (text: string) => new Promise<void>((resolve) => { log.push(`start:${text}`); pending.push(() => { log.push(`end:${text}`); resolve(); }); });
  const finishCurrent = async () => { pending.shift()?.(); await new Promise((r) => setTimeout(r, 0)); };
  return { log, play, finishCurrent };
}

test("proactive message waits for the current phrase, then goes before queued answers", async () => {
  const p = fakePlayer();
  const q = new SpeechQueue(p.play);
  q.say("відповідь 1", PRIORITY.answer);
  q.say("відповідь 2", PRIORITY.answer);
  q.say("Увага! Тривога.", PRIORITY.proactiveCritical);
  assert.deepEqual(p.log, ["start:відповідь 1"], "the phrase being spoken is not interrupted");
  await p.finishCurrent();
  assert.equal(p.log.at(-1), "start:Увага! Тривога.", "right after it: the proactive message");
  await p.finishCurrent();
  assert.equal(p.log.at(-1), "start:відповідь 2");
  await p.finishCurrent();
  assert.equal(q.speaking, null);
});

test("a stale turn prompt of the same slot is replaced, not spoken twice", async () => {
  const p = fakePlayer();
  const q = new SpeechQueue(p.play);
  q.say("відповідь", PRIORITY.answer);
  q.say("через 300 м праворуч", PRIORITY.guidance, "turn");
  q.say("через 100 м праворуч", PRIORITY.guidance, "turn");
  await p.finishCurrent();
  await p.finishCurrent();
  assert.deepEqual(p.log.filter((l) => l.startsWith("start")), ["start:відповідь", "start:через 100 м праворуч"]);
});
