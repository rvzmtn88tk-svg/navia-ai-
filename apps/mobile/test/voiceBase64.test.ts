// Downloaded neural-voice audio is written to a file as base64.
import test from "node:test";
import assert from "node:assert/strict";
import { bytesToBase64 } from "../src/voice/base64";

test("bytes → base64 matches the standard encoding for every tail length", () => {
  for (let n = 0; n < 40; n++) {
    const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 97 + n * 13) & 255);
    assert.equal(bytesToBase64(bytes), Buffer.from(bytes).toString("base64"), `length ${n}`);
  }
});
