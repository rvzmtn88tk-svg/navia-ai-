// Hands-free mode: after one tap, the driver talks to NAVIA by name, gets an
// answer and continues by voice without touching the screen.
import test from "node:test";
import assert from "node:assert/strict";
import { afterWake, HandsFree, type Recognizer } from "../src/voice/handsFree";

class FakeRec implements Recognizer {
  running = false; starts = 0;
  private cb: { final: (t: string) => void; end: () => void; err: (m: string) => void } | null = null;
  start(onFinal: (t: string) => void, onEnd: () => void, onError: (m: string) => void) { this.running = true; this.starts++; this.cb = { final: onFinal, end: onEnd, err: onError }; }
  stop() { this.running = false; }
  say(t: string) { assert.ok(this.running, `not listening when «${t}» was said`); this.cb!.final(t); }
  end() { this.running = false; this.cb!.end(); }
  error(m: string) { this.running = false; this.cb!.err(m); }
}
function timers() {
  const q: { fn: () => void; at: number }[] = [];
  let now = 0;
  return { t: { set: (fn: () => void, ms: number) => { const x = { fn, at: now + ms }; q.push(x); return x as unknown as ReturnType<typeof setTimeout>; }, clear: (x: ReturnType<typeof setTimeout>) => { const i = q.indexOf(x as unknown as { fn: () => void; at: number }); if (i >= 0) q.splice(i, 1); } },
    advance: (ms: number) => { now += ms; for (const x of q.filter((y) => y.at <= now)) { q.splice(q.indexOf(x), 1); x.fn(); } } };
}

test("wake phrase: the name is found, the question after it is taken", () => {
  assert.equal(afterWake("NAVIA, куди далі?"), "куди далі?");
  assert.equal(afterWake("навіа де укриття"), "де укриття");
  assert.equal(afterWake("Навия"), "");
  assert.equal(afterWake("штурмане, що з GPS"), "що з GPS");
  assert.equal(afterWake("куди далі"), null, "not addressed to NAVIA");
  assert.equal(afterWake("навігація не працює"), null, "«навігація» is not the name");
});

test("scenario: one tap on, then a conversation without hands", () => {
  const rec = new FakeRec();
  const tm = timers();
  const asked: string[] = [], prompts: string[] = [];
  const hf = new HandsFree(rec, { onQuestion: (q) => asked.push(q), onPrompt: (p) => prompts.push(p) }, tm.t);
  hf.enable();
  assert.equal(hf.current, "wake");
  rec.say("радіо грає, треба купити хліба"); // not addressed: ignored
  assert.deepEqual(asked, []);
  rec.say("NAVIA, куди далі?");
  assert.deepEqual(asked, ["куди далі?"]);
  hf.speaking(); // NAVIA answers — the mic is paused
  assert.equal(rec.running, false, "NAVIA does not hear itself");
  hf.doneSpeaking(true);
  assert.equal(hf.current, "followUp");
  rec.say("а скільки ще їхати"); // no name needed right after an answer
  assert.deepEqual(asked, ["куди далі?", "а скільки ще їхати"]);
  hf.speaking(); hf.doneSpeaking(true);
  tm.advance(9000); // silence: back to waiting for the name
  assert.equal(hf.current, "wake");
  rec.say("так от");
  assert.equal(asked.length, 2);
  rec.say("Навіа"); // only the name
  assert.deepEqual(prompts, ["Слухаю"]);
  hf.speaking(); hf.doneSpeaking(false);
  assert.equal(hf.current, "command");
  rec.say("де найближче укриття");
  assert.equal(asked.at(-1), "де найближче укриття");
});

test("sessions that end are restarted; repeated errors stop the mode with a message", () => {
  const rec = new FakeRec();
  const tm = timers();
  const errors: string[] = [];
  const hf = new HandsFree(rec, { onQuestion: () => {}, onPrompt: () => {}, onError: (m) => errors.push(m) }, tm.t);
  hf.enable();
  rec.end(); // iOS time limit
  assert.equal(rec.running, true, "listening again");
  rec.error("network"); tm.advance(1000);
  rec.error("network"); tm.advance(1000);
  rec.error("network");
  assert.equal(hf.current, "off");
  assert.deepEqual(errors, ["network"]);
});
