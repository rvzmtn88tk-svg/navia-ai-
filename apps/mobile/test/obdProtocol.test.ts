// OBD-II over BLE (ELM327): recognising adapters, the serial characteristics,
// and reading the vehicle speed (PID 0D).
import test from "node:test";
import assert from "node:assert/strict";
import { asciiToBase64, base64ToAscii, isObdName, parseSpeedKmh, pickSerialCharacteristics } from "../src/vehicle/obdProtocol";

test("speed from ELM327 answers (with or without spaces/echo); NO DATA is null", () => {
  assert.equal(parseSpeedKmh("41 0D 3C \r\r>"), 60);
  assert.equal(parseSpeedKmh("010D\r410D00\r>"), 0);
  assert.equal(parseSpeedKmh("41 0D FF>"), 255);
  assert.equal(parseSpeedKmh("NO DATA\r>"), null);
  assert.equal(parseSpeedKmh("SEARCHING...\r>"), null);
});

test("adapter names and the notify/write pair of its serial service", () => {
  for (const n of ["OBDII", "V-LINK", "IOS-Vlink", "Veepeak", "vLinker MC-IOS", "KONNWEI"]) assert.ok(isObdName(n), n);
  assert.ok(!isObdName("AirPods Pro") && !isObdName(null));
  const chars = [
    { serviceUUID: "0000180a-0000-1000-8000-00805f9b34fb", uuid: "2a29", isNotifiable: false, isIndicatable: false, isWritableWithResponse: false, isWritableWithoutResponse: false },
    { serviceUUID: "0000fff0-0000-1000-8000-00805f9b34fb", uuid: "fff1", isNotifiable: true, isIndicatable: false, isWritableWithResponse: false, isWritableWithoutResponse: false },
    { serviceUUID: "0000fff0-0000-1000-8000-00805f9b34fb", uuid: "fff2", isNotifiable: false, isIndicatable: false, isWritableWithResponse: false, isWritableWithoutResponse: true },
  ];
  const pair = pickSerialCharacteristics(chars)!;
  assert.equal(pair.notify.uuid, "fff1");
  assert.equal(pair.write.uuid, "fff2");
});

test("BLE values are base64 of ASCII", () => {
  assert.equal(asciiToBase64("010D\r"), Buffer.from("010D\r").toString("base64"));
  assert.equal(base64ToAscii(Buffer.from("41 0D 3C\r>").toString("base64")), "41 0D 3C\r>");
});
