// Trip recording on the phone (Settings → «Записувати поїздки»): raw GPS
// fixes, motion sensors at 10 Hz and the route go to files, so real drives
// can be replayed through the navigator with GPS cut (npm run replay:trips).
// Written in 15-second chunk files (the file API has no append), joined into
// one .jsonl when shared. Nothing leaves the phone unless the driver shares it.
import * as FileSystem from "expo-file-system";
import Storage from "expo-sqlite/kv-store";
import { Share } from "react-native";
import { TripRecorder, type GNSSRawSample, type IMUSample, type Route } from "@navia/core";

const ROOT = `${FileSystem.documentDirectory ?? ""}trips/`;
const SETTING_KEY = "navia.recordTrips.v1";
const FLUSH_MS = 15_000;
const MAX_TRIPS = 40;

export function recordingEnabled(): boolean {
  try { return Storage.getItemSync(SETTING_KEY) === "1"; } catch { return false; }
}

export function setRecordingEnabled(on: boolean): void {
  try { Storage.setItemSync(SETTING_KEY, on ? "1" : "0"); } catch { /* storage unavailable */ }
}

export type TripSession = {
  gnss(s: GNSSRawSample): void;
  imu(s: IMUSample): void;
  route(r: Route): void;
  stop(): Promise<void>;
};

function tripId(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Starts recording this trip, or null when recording is off / storage is unavailable. */
export function startTripRecording(): TripSession | null {
  if (!recordingEnabled() || !FileSystem.documentDirectory) return null;
  const dir = `${ROOT}${tripId()}/`;
  const rec = new TripRecorder({ device: "iphone", app: "navia" });
  let n = 0;
  let writing: Promise<void> = FileSystem.makeDirectoryAsync(dir, { intermediates: true })
    .then(() => FileSystem.writeAsStringAsync(`${dir}00000.jsonl`, rec.headerLine() + "\n"))
    .catch(() => {});
  const flush = () => {
    const chunk = rec.takeChunk();
    if (!chunk) return writing;
    const name = String(++n).padStart(5, "0");
    writing = writing.then(() => FileSystem.writeAsStringAsync(`${dir}${name}.jsonl`, chunk)).catch(() => {});
    return writing;
  };
  const timer = setInterval(() => { void flush(); }, FLUSH_MS);
  return {
    gnss: (s) => rec.gnss(s),
    imu: (s) => rec.imu(s),
    route: (r) => rec.route(r),
    stop: async () => {
      clearInterval(timer);
      await flush();
      // A trip with no fixes (cancelled at once) is not worth keeping.
      if (rec.stats().gnss < 10) await FileSystem.deleteAsync(dir, { idempotent: true }).catch(() => {});
      await prune();
    },
  };
}

export type SavedTrip = { id: string; label: string };

export async function listTrips(): Promise<SavedTrip[]> {
  const ids = await FileSystem.readDirectoryAsync(ROOT).catch(() => [] as string[]);
  return ids.filter((id) => /^\d{8}-\d{6}$/.test(id)).sort().reverse().map((id) => ({
    id,
    label: `${id.slice(6, 8)}.${id.slice(4, 6)}.${id.slice(0, 4)} ${id.slice(9, 11)}:${id.slice(11, 13)}`,
  }));
}

async function prune(): Promise<void> {
  const trips = await listTrips();
  for (const t of trips.slice(MAX_TRIPS)) await FileSystem.deleteAsync(`${ROOT}${t.id}/`, { idempotent: true }).catch(() => {});
}

/** Joins the trip into one file and opens the share sheet (AirDrop, Files, Telegram…). */
export async function shareTrip(id: string): Promise<boolean> {
  const dir = `${ROOT}${id}/`;
  const parts = (await FileSystem.readDirectoryAsync(dir).catch(() => [] as string[])).filter((f) => f.endsWith(".jsonl")).sort();
  if (parts.length === 0) return false;
  let text = "";
  for (const p of parts) text += await FileSystem.readAsStringAsync(dir + p);
  const out = `${FileSystem.cacheDirectory}navia-trip-${id}.jsonl`;
  await FileSystem.writeAsStringAsync(out, text);
  await Share.share({ url: out, title: `NAVIA trip ${id}` });
  return true;
}

export async function deleteAllTrips(): Promise<void> {
  await FileSystem.deleteAsync(ROOT, { idempotent: true }).catch(() => {});
}
