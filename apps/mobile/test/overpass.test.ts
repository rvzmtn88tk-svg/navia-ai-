import test from "node:test";
import assert from "node:assert/strict";
import { OVERPASS_ENDPOINTS, overpass, resetOverpassPreference } from "../src/providers/overpass";

function reply(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

test("overpass: a busy main server (504) falls back to a mirror", async () => {
  resetOverpassPreference();
  const asked: string[] = [];
  const elements = await overpass("q", {
    fetchImpl: async (url) => {
      asked.push(url);
      return url === OVERPASS_ENDPOINTS[1] ? reply(200, { elements: [{ type: "node", id: 1 }] }) : reply(504, {});
    },
  });
  assert.equal(elements.length, 1);
  assert.ok(asked.includes(OVERPASS_ENDPOINTS[1]!));
});

test("overpass: the mirror that answered is asked first next time", async () => {
  const asked: string[] = [];
  await overpass("q", { fetchImpl: async (url) => { asked.push(url); return reply(200, { elements: [] }); } });
  assert.equal(asked[0], OVERPASS_ENDPOINTS[1]);
});

test("overpass: a runtime error reported inside a 200 answer counts as failure", async () => {
  resetOverpassPreference();
  await assert.rejects(overpass("q", { fetchImpl: async () => reply(200, { elements: [], remark: "runtime error: Query timed out" }) }));
});
