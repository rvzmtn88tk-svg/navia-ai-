import test from "node:test";
import assert from "node:assert/strict";
import { isProtectiveShelter } from "../src/providers/NearbyPlacesProvider";

test("bus stops and picnic roofs are never shelters", () => {
  assert.equal(isProtectiveShelter({ amenity: "shelter", shelter_type: "public_transport" }), false);
  assert.equal(isProtectiveShelter({ amenity: "shelter", shelter_type: "picnic_shelter" }), false);
  assert.equal(isProtectiveShelter({ amenity: "shelter" }), false);
});

test("bomb shelters and bunkers are shelters", () => {
  assert.equal(isProtectiveShelter({ amenity: "shelter", shelter_type: "bomb_shelter" }), true);
  assert.equal(isProtectiveShelter({ building: "bunker" }), true);
});
