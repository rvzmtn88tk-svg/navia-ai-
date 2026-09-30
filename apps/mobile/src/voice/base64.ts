// Bytes → base64 (writing downloaded audio to a file; no Buffer in React Native).
const ABC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += ABC[(n >> 18) & 63]! + ABC[(n >> 12) & 63]! + ABC[(n >> 6) & 63]! + ABC[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += ABC[(n >> 18) & 63]! + ABC[(n >> 12) & 63]! + "==";
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += ABC[(n >> 18) & 63]! + ABC[(n >> 12) & 63]! + ABC[(n >> 6) & 63]! + "=";
  }
  return out;
}
