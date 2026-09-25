// Community shelters shipped with the app (data.gov.ua) — strict radius,
// real published coordinates, explicit offline origin.
import test from "node:test";
import assert from "node:assert/strict";
import { haversineMeters } from "@navia/core";
import { bundledShelters, bundledSheltersInfo } from "../src/providers/openDataShelters";

const bucha = { lat: 50.5433, lon: 30.2120 };

test("bundled community shelters: real data, strict radius, offline origin", () => {
  const info = bundledSheltersInfo();
  assert.ok(info.count > 300 && info.datasets >= 15, `${info.count} shelters from ${info.datasets} datasets`);
  const r = bundledShelters(bucha, 3000);
  assert.ok(r.length > 10, `${r.length} shelters within 3 km of Bucha`);
  for (const p of r) {
    assert.ok(haversineMeters(bucha, p.location) <= 3000 + 1e-6);
    assert.equal(p.origin, "offline");
    assert.equal(p.source, "data.gov.ua");
    assert.match(p.sourceDetail ?? "", /Бучанська міська рада/);
  }
  const wider = bundledShelters(bucha, 10_000);
  assert.ok(wider.length >= r.length);
  assert.equal(bundledShelters({ lat: 46.48, lon: 30.73 }, 5000).length, 0, "nothing near Odesa: only Kyiv-oblast data is shipped");
});
