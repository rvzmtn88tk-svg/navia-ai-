// ELM327 (OBD-II) over Bluetooth LE — the pure parts: which adapter, which
// characteristics, how to read the vehicle speed. Speed = service 01, PID 0D:
// the adapter answers "41 0D XX" with XX the speed in km/h (hex).

/** Names the common ELM327 BLE adapters advertise (Vgate iCar, vLinker, Veepeak, Konnwei, generic "OBDII"…). */
export const OBD_NAME = /(obd|elm|vlink|v-link|veepeak|icar|konnwei|viecar|carista|obdlink|ios-vlink|android-vlink)/i;
/** GATT services these adapters use for their serial link. */
export const OBD_SERVICES = ["fff0", "ffe0", "18f0", "e7810a71-73ae-499d-8c15-faa9aef0c3f2", "0000fff0-0000-1000-8000-00805f9b34fb", "0000ffe0-0000-1000-8000-00805f9b34fb", "000018f0-0000-1000-8000-00805f9b34fb"];

export function isObdName(name: string | null | undefined): boolean {
  return !!name && OBD_NAME.test(name);
}

export type CharInfo = { serviceUUID: string; uuid: string; isNotifiable: boolean; isIndicatable: boolean; isWritableWithResponse: boolean; isWritableWithoutResponse: boolean };

/** The notify + write pair of the adapter's serial link (same service), preferring the known services. */
export function pickSerialCharacteristics(chars: CharInfo[]): { notify: CharInfo; write: CharInfo } | null {
  const short = (u: string) => u.toLowerCase().replace(/^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/, "$1");
  const byService = new Map<string, CharInfo[]>();
  for (const c of chars) byService.set(c.serviceUUID, [...(byService.get(c.serviceUUID) ?? []), c]);
  const services = [...byService.keys()].sort((a, b) => Number(!OBD_SERVICES.includes(short(a))) - Number(!OBD_SERVICES.includes(short(b))));
  for (const s of services) {
    const cs = byService.get(s)!;
    const notify = cs.find((c) => c.isNotifiable || c.isIndicatable);
    const write = cs.find((c) => c.isWritableWithoutResponse || c.isWritableWithResponse);
    if (notify && write) return { notify, write };
  }
  return null;
}

/** Init: reset, no echo, no linefeeds, no spaces, no headers, automatic protocol. */
export const OBD_INIT = ["ATZ", "ATE0", "ATL0", "ATS0", "ATH0", "ATSP0"];
export const OBD_SPEED = "010D";

/** Vehicle speed in km/h from an adapter answer ("41 0D 3C\\r>" → 60), or null (NO DATA, SEARCHING…). */
export function parseSpeedKmh(answer: string): number | null {
  const hex = answer.toUpperCase().replace(/[^0-9A-F]/g, "");
  const i = hex.indexOf("410D");
  if (i < 0 || hex.length < i + 6) return null;
  const v = parseInt(hex.slice(i + 4, i + 6), 16);
  return Number.isFinite(v) ? v : null;
}

export function asciiToBase64(s: string): string {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const b = Array.from(s, (ch) => ch.charCodeAt(0) & 0xff);
  let out = "";
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i]! << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    out += abc[(n >> 18) & 63]! + abc[(n >> 12) & 63]! + (i + 1 < b.length ? abc[(n >> 6) & 63]! : "=") + (i + 2 < b.length ? abc[n & 63]! : "=");
  }
  return out;
}

export function base64ToAscii(b64: string): string {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, "");
  let out = "";
  for (let i = 0; i < clean.length; i += 4) {
    const n = (abc.indexOf(clean[i]!) << 18) | (abc.indexOf(clean[i + 1] ?? "A") << 12) | ((clean[i + 2] ? abc.indexOf(clean[i + 2]!) : 0) << 6) | (clean[i + 3] ? abc.indexOf(clean[i + 3]!) : 0);
    out += String.fromCharCode((n >> 16) & 255);
    if (clean[i + 2]) out += String.fromCharCode((n >> 8) & 255);
    if (clean[i + 3]) out += String.fromCharCode(n & 255);
  }
  return out;
}
