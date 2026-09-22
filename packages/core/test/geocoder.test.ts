// Spec section 14 ("ADDRESS SEARCH"). DemoGeocoderProvider is the only
// geocoder implemented in core itself (Online/Offline live in apps/mobile,
// since they need fetch/native storage); this just confirms the shared
// GeocoderProvider contract and that demo results are honestly tagged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DemoGeocoderProvider } from "../src/geocoder";

test("DemoGeocoderProvider: matches by label substring, tags source as demo", async () => {
  const provider = new DemoGeocoderProvider([
    { label: "Київ, Майдан Незалежності", location: { lat: 50.4501, lon: 30.5234 } },
    { label: "Бориспіль", location: { lat: 50.345, lon: 30.9526 } },
  ]);
  const results = await provider.search("майдан");
  assert.equal(results.length, 1);
  assert.equal(results[0]!.source, "demo");
  assert.match(results[0]!.label, /Майдан/);
});

test("DemoGeocoderProvider: empty query returns no results, not everything", async () => {
  const provider = new DemoGeocoderProvider([{ label: "Київ", location: { lat: 50.45, lon: 30.52 } }]);
  assert.deepEqual(await provider.search(""), []);
});

test("DemoGeocoderProvider: respects limit", async () => {
  const provider = new DemoGeocoderProvider(
    Array.from({ length: 10 }, (_, i) => ({ label: `Вулиця ${i}`, location: { lat: 50.45, lon: 30.5 + i * 0.001 } }))
  );
  const results = await provider.search("вулиця", { limit: 3 });
  assert.equal(results.length, 3);
});
