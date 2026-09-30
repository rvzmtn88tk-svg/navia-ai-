// The proxy's neural voice route: request checks, voice choice, SSML escaping.
import test from "node:test";
import assert from "node:assert/strict";
import { parseTtsRequest, ssml, voiceFor } from "../../../server/navia-proxy/src/tts";

test("male and female neural voices per language; Russian text gets a Russian voice", () => {
  assert.equal(voiceFor("Через 300 метрів поверніть праворуч", "uk", "male").name, "uk-UA-OstapNeural");
  assert.equal(voiceFor("Через 300 метрів поверніть праворуч", "uk", "female").name, "uk-UA-PolinaNeural");
  assert.equal(voiceFor("Через 300 метров поверните направо, вы на месте", "uk", "male").name, "ru-RU-DmitryNeural");
  assert.equal(voiceFor("Turn right", "en", "female").locale, "en-US");
});

test("text is escaped inside SSML", () => {
  const x = ssml(`АЗС "ОККО" <A&B>`, voiceFor("x", "uk", "male"));
  assert.ok(x.includes("АЗС &quot;ОККО&quot; &lt;A&amp;B&gt;"));
  assert.ok(x.includes('xml:lang="uk-UA"'));
});

test("request validation", () => {
  assert.equal(parseTtsRequest({}), "text is required");
  assert.equal(parseTtsRequest({ text: "x".repeat(601) }), "text too long");
  assert.deepEqual(parseTtsRequest({ text: " Привіт ", gender: "male" }), { text: "Привіт", lang: "uk", gender: "male" });
});
