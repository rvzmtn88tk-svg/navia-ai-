// OBD-II adapter link (Bluetooth LE, ELM327): the car's real speed for
// guidance without GPS. Off unless the driver switches it on in Settings; the
// Bluetooth permission prompt appears only then. Status is shown honestly
// (scanning / not found / connected, km/h).
import { create } from "zustand";
import { BleManager, State, type Device, type Subscription } from "react-native-ble-plx";
import { OBD_INIT, OBD_SPEED, asciiToBase64, base64ToAscii, isObdName, parseSpeedKmh, pickSerialCharacteristics } from "./obdProtocol";

export type ObdStatus = { state: "off" | "bluetooth_off" | "scanning" | "connecting" | "connected" | "not_found" | "error"; device?: string; speedKmh?: number | null; message?: string };
export const useObdStore = create<{ status: ObdStatus; set: (s: ObdStatus) => void }>((set) => ({ status: { state: "off" }, set: (status) => set({ status }) }));

let manager: BleManager | null = null;
let device: Device | null = null;
let notifySub: Subscription | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let buffer = "";
let waiter: ((answer: string) => void) | null = null;
let onSpeedCb: ((mps: number | null) => void) | null = null;
let running = false;

const status = (s: ObdStatus) => useObdStore.getState().set(s);
const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(() => r(), ms); });

async function send(cmd: string, writeChar: { serviceUUID: string; uuid: string; isWritableWithResponse: boolean }, timeoutMs = 2500): Promise<string> {
  if (!device) throw new Error("not connected");
  buffer = "";
  const answer = new Promise<string>((resolve) => { waiter = resolve; setTimeout(() => { if (waiter === resolve) { waiter = null; resolve(buffer); } }, timeoutMs); });
  const v = asciiToBase64(`${cmd}\r`);
  if (writeChar.isWritableWithResponse) await device.writeCharacteristicWithResponseForService(writeChar.serviceUUID, writeChar.uuid, v);
  else await device.writeCharacteristicWithoutResponseForService(writeChar.serviceUUID, writeChar.uuid, v);
  return answer;
}

/** Starts looking for the adapter and, once connected, reports the speed (m/s) every ~0.5 s; null when lost. */
export async function startObd(onSpeed: (mps: number | null) => void): Promise<void> {
  if (running) return;
  running = true;
  onSpeedCb = onSpeed;
  manager ??= new BleManager();
  try {
    const st = await manager.state();
    if (st !== State.PoweredOn) { status({ state: "bluetooth_off" }); running = false; return; }
    status({ state: "scanning" });
    const found = await new Promise<Device | null>((resolve) => {
      const t = setTimeout(() => { manager!.stopDeviceScan(); resolve(null); }, 15_000);
      void manager!.startDeviceScan(null, { allowDuplicates: false }, (error, d) => {
        if (error) { clearTimeout(t); manager!.stopDeviceScan(); resolve(null); return; }
        if (d && (isObdName(d.name) || isObdName(d.localName))) { clearTimeout(t); manager!.stopDeviceScan(); resolve(d); }
      });
    });
    if (!found || !running) { status({ state: found ? "off" : "not_found" }); running = false; return; }
    status({ state: "connecting", device: found.name ?? found.localName ?? "OBD" });
    device = await found.connect({ timeout: 10_000 });
    await device.discoverAllServicesAndCharacteristics();
    const chars = [];
    for (const s of await device.services()) for (const c of await s.characteristics()) chars.push(c);
    const pair = pickSerialCharacteristics(chars);
    if (!pair) throw new Error("no serial link on this adapter");
    notifySub = device.monitorCharacteristicForService(pair.notify.serviceUUID, pair.notify.uuid, (e, c) => {
      if (e || !c?.value) return;
      buffer += base64ToAscii(c.value);
      if (buffer.includes(">") && waiter) { const w = waiter; waiter = null; w(buffer); }
    });
    device.onDisconnected(() => { onSpeedCb?.(null); status({ state: "error", message: "disconnected" }); void stopObd(false); });
    await send(OBD_INIT[0]!, pair.write, 3000);
    await sleep(500);
    for (const c of OBD_INIT.slice(1)) await send(c, pair.write);
    status({ state: "connected", device: device.name ?? "OBD", speedKmh: null });
    let busy = false;
    pollTimer = setInterval(() => {
      if (busy || !running) return;
      busy = true;
      void send(OBD_SPEED, pair.write, 1500).then((ans) => {
        const kmh = parseSpeedKmh(ans);
        onSpeedCb?.(kmh == null ? null : kmh / 3.6);
        status({ state: "connected", device: device?.name ?? "OBD", speedKmh: kmh });
      }).catch(() => onSpeedCb?.(null)).finally(() => { busy = false; });
    }, 500);
  } catch (e) {
    status({ state: "error", message: (e as Error).message });
    await stopObd(false);
  }
}

export async function stopObd(setOff = true): Promise<void> {
  running = false;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  notifySub?.remove();
  notifySub = null;
  const d = device;
  device = null;
  if (d) await d.cancelConnection().catch(() => {});
  onSpeedCb?.(null);
  if (setOff) status({ state: "off" });
}

// ——— the driver's choice, kept on the phone ———
const KEY = "navia.obd.enabled.v1";
function kv(): { getItemSync(k: string): string | null; setItemSync(k: string, v: string): void } | null {
  try { return (require("expo-sqlite/kv-store") as { default: { getItemSync(k: string): string | null; setItemSync(k: string, v: string): void } }).default; } catch { return null; }
}
export function obdEnabled(): boolean { try { return kv()?.getItemSync(KEY) === "1"; } catch { return false; } }
export function setObdEnabled(on: boolean): void { try { kv()?.setItemSync(KEY, on ? "1" : "0"); } catch { /* no storage */ } }
