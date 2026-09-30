// "The navigator keeps talking after I left the route": leaving a trip must
// silence everything queued, and off the route the old turns are not read.
import test from "node:test";
import assert from "node:assert/strict";
import { SpeechQueue, PRIORITY } from "../src/voice/speechQueue";
import { turnPromptsAllowed } from "../src/voice/voiceGate";

test("stop: phrases still waiting are dropped, nothing is spoken after leaving", async () => {
  const spoken: string[] = [];
  let finishCurrent: () => void = () => {};
  const q = new SpeechQueue((text) => { spoken.push(text); return new Promise<void>((r) => { finishCurrent = r; }); });
  void q.say("Через 300 метрів праворуч", PRIORITY.guidance, "turn");
  void q.say("GPS нестабільний", PRIORITY.proactive);
  void q.say("Через 800 метрів ліворуч", PRIORITY.guidance, "turn");
  assert.deepEqual(spoken, ["Через 300 метрів праворуч"]);
  q.clear(); // what stopSpeaking() now does on leaving the trip
  finishCurrent();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(spoken, ["Через 300 метрів праворуч"], "nothing after the stop");
});

test("turn prompts only during a trip and never off the route", () => {
  assert.equal(turnPromptsAllowed("navigating", false), true);
  assert.equal(turnPromptsAllowed("navigating", true), false);
  assert.equal(turnPromptsAllowed("overview", false), false);
  assert.equal(turnPromptsAllowed("ended", false), false);
});
