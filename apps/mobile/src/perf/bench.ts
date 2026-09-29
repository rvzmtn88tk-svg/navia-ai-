// On-device benchmark (dev aid): launched with `-NaviaBench YES`, the app
// measures real UI-thread frame rates (perf.ts / NaviaFrameMeter) for the
// category wheel and for the tilted 3D map (standard and satellite, with
// relief shading and 3D buildings), and saves them to the phone
// ("navia.bench.v1") so they can be read from the app container.
import { NativeModules, Platform, Dimensions } from "react-native";
import { fpsEnd, fpsLog, fpsStart } from "./perf";
import type { MapLayer } from "../settings/AppSettings";

export const benchHooks: {
  openWheel?: () => void;
  closeWheel?: () => void;
  orbit?: (ms: number, pitch: number, zoom: number) => void;
  setLayer?: (layer: MapLayer) => void;
  restyle?: () => void;
  openAssistant?: () => void;
  /** Home screen: the air-targets map. */
  openTargets?: () => void;
  closeTargets?: () => void;
  /** Co-pilot screen: send a question / set the text being typed. */
  assistantAsk?: (q: string) => void;
  assistantType?: (text: string) => void;
} = {};

export function benchMode(): boolean {
  try { return !!(NativeModules.NaviaFrameMeter as { benchMode?: () => boolean } | undefined)?.benchMode?.(); } catch { return false; }
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let running = false;
/** While the benchmark runs, it does the measuring (components must not start their own). */
export function benchRunning(): boolean {
  return running;
}
export async function runBench(layerBefore: MapLayer): Promise<void> {
  if (running) return;
  running = true;
  fpsLog.length = 0;
  fpsStart(); await wait(1500); await fpsEnd("idle: standard map, nothing moving");
  // The wheel once before anything else (a clean home map), then again after the targets map below.
  fpsStart(); benchHooks.openWheel?.(); await wait(700); await fpsEnd("first: category wheel open");
  await wait(500);
  fpsStart(); benchHooks.closeWheel?.(); await wait(450); await fpsEnd("first: category wheel close");
  await wait(1500);
  const home = await benchHome();
  for (let k = 0; k < 4; k++) {
    fpsStart(); benchHooks.openWheel?.(); await wait(700); await fpsEnd("category wheel: open (animation 420 ms)");
    await wait(500);
    fpsStart(); benchHooks.closeWheel?.(); await wait(450); await fpsEnd("category wheel: close (animation 200 ms)");
    await wait(600);
  }
  const { setBenchDepth } = require("../map/mapStyles") as typeof import("../map/mapStyles");
  for (const layer of ["standard", "satellite", "terrain"] as MapLayer[]) {
    for (const d of layer === "terrain" ? ["full"] as const : ["none", "full"] as const) {
      setBenchDepth(d); benchHooks.setLayer?.(layer); benchHooks.restyle?.(); await wait(7000);
      // Warm the tiles of the tilted view, then measure the next turn.
      benchHooks.orbit?.(2500, 55, 16); await wait(4000);
      fpsStart(); benchHooks.orbit?.(3000, 55, 16); await wait(3100);
      await fpsEnd(`3D orbit (pitch 55°, z16): ${layer}, ${d === "none" ? "WITHOUT relief/3D buildings/light (baseline)" : "with relief + 3D buildings + light"}`);
    }
  }
  setBenchDepth("full"); benchHooks.restyle?.();
  benchHooks.setLayer?.(layerBefore);
  const navigator = benchNavigator();
  const assistant = await benchAssistant();
  const tts = await benchTts();
  const { width, height } = Dimensions.get("window");
  const report = { at: new Date().toISOString(), platform: Platform.OS, version: Platform.Version, model: (Platform.constants as { systemName?: string; interfaceIdiom?: string }).interfaceIdiom, window: `${width}x${height}`, results: [...fpsLog], home, navigator, tts, assistant };
  try {
    const kv = (require("expo-sqlite/kv-store") as { default: { setItemAsync(k: string, v: string): Promise<void> } }).default;
    await kv.setItemAsync("navia.bench.v1", JSON.stringify(report));
  } catch { /* storage unavailable */ }
  console.log("[bench]", JSON.stringify(report));
  running = false;
}

type HomeRun = { renders: number; avgRenderMs: number; p95RenderMs: number; maxRenderMs: number; jsBusyPct: number; maxStallMs: number; stallsOver100: number; fps: number | null; maxFrameMs: number | null };

/** The home screen as it is used: idle with live GPS, then the targets map, then turning the map with targets on it. */
async function benchHome(): Promise<Record<string, HomeRun>> {
  const { renderLog, jsLagStart } = require("./perf") as typeof import("./perf");
  const out: Record<string, HomeRun> = {};
  const measure = async (name: string, ms: number, during?: () => void) => {
    renderLog.length = 0;
    const lag = jsLagStart();
    fpsStart();
    during?.();
    await wait(ms);
    const f = await fpsEnd(`home: ${name}`);
    const l = lag();
    const r = renderLog.filter((x) => x.id === "home").map((x) => x.ms).sort((a, b) => a - b);
    out[name] = { renders: r.length, avgRenderMs: r.reduce((a, b) => a + b, 0) / Math.max(1, r.length), p95RenderMs: r[Math.floor(0.95 * (r.length - 1))] ?? 0, maxRenderMs: r[r.length - 1] ?? 0, jsBusyPct: l.busyPct, maxStallMs: l.maxStallMs, stallsOver100: l.stallsOver100, fps: f?.fps ?? null, maxFrameMs: f?.maxGapMs ?? null };
  };
  // Every step starts once the map has settled (tiles loaded), so one step's loading does not leak into the next.
  await wait(4000);
  await measure("idle 6 s (live GPS)", 6000);
  await measure("open targets map (fly-out + card)", 3000, () => benchHooks.openTargets?.());
  await wait(5000);
  await measure("targets map idle 6 s", 6000);
  await measure("targets map: turning 3 s", 3200, () => benchHooks.orbit?.(3000, 0, 5));
  benchHooks.closeTargets?.();
  await wait(8000);
  return out;
}

/** Layers 2–5 on the phone: every question answered 20 times from a live snapshot. */
function benchNavigator(): { questions: number; runs: number; avgMs: number; p95Ms: number; maxMs: number } {
  const { Navigator } = require("../ai/navigator/navigator") as typeof import("../ai/navigator/navigator");
  const { buildSnapshot } = require("../ai/navigator/snapshot") as typeof import("../ai/navigator/snapshot");
  const { worldGps } = require("../ai/worldGps") as typeof import("../ai/worldGps");
  const { useNaviaStore } = require("../engine/naviaController") as typeof import("../engine/naviaController");
  const state = useNaviaStore.getState().state;
  const world = { lang: "uk" as const, now: Date.now(), remote: false, landmarks: [], gps: worldGps(state, { hasPosition: !!state.position }), alert: { active: false }, places: {}, placeStates: {} };
  const snap = buildSnapshot({ state, world });
  const qs = ["Где я?", "Куда дальше?", "Через сколько поворот?", "У меня пропал сигнал, что делать?", "Насколько ты уверен в моей позиции?", "Объявлена тревога, где ближайшее укрытие?", "Я сбился с маршрута?", "Какая сейчас пробка на дороге?", "Почему ты так ответил?", "Скока ещё пилить", "мене страшно шо робити", "повтори", "що з gps", "де аптека", "нема інтернету що тепер", "це точно найближче укриття?", "чому цей маршрут", "розкажи анекдот"];
  const times: number[] = [];
  const clock = () => (globalThis as { performance?: { now(): number } }).performance?.now() ?? Date.now();
  for (let k = 0; k < 20; k++) {
    const nav = new Navigator();
    for (const q of qs) { const t0 = clock(); nav.ask(q, snap); times.push(clock() - t0); }
  }
  times.sort((a, b) => a - b);
  return { questions: qs.length, runs: times.length, avgMs: times.reduce((a, b) => a + b, 0) / times.length, p95Ms: times[Math.floor(0.95 * (times.length - 1))]!, maxMs: times[times.length - 1]! };
}

/** Speech: from the speak call to the first sound, three short phrases. */
async function benchTts(): Promise<number[]> {
  const { speak, nextTtsStart } = require("../voice/VoiceGuide") as typeof import("../voice/VoiceGuide");
  const out: number[] = [];
  for (const phrase of ["Перевірка голосу NAVIA.", "Через триста метрів праворуч.", "GPS у нормі."]) {
    const started = nextTtsStart();
    const done = speak(phrase, { lang: "uk", gender: "female", interrupt: false });
    out.push(await Promise.race([started, new Promise<number>((r) => setTimeout(() => r(-1), 5000))]));
    await done;
  }
  return out;
}

/** The co-pilot screen under 10 state updates a second (GPS at 1 Hz in real
 * life): frame rate and React render time of each update. */
async function benchAssistant(): Promise<{ updates: number; renders: number; avgRenderMs: number; p95RenderMs: number; maxRenderMs: number; fps: number | null; maxFrameMs: number | null } | null> {
  if (!benchHooks.openAssistant) return null;
  const { renderLog } = require("./perf") as typeof import("./perf");
  const { useNaviaStore } = require("../engine/naviaController") as typeof import("../engine/naviaController");
  benchHooks.openAssistant();
  await wait(3500);
  // A real conversation first: 20 messages on screen.
  for (const q of ["де я", "куди далі", "що з gps", "де укриття", "скільки лишилось", "нема інтернету що тепер", "мені страшно", "що з тривогою", "де аптека", "статус"]) { benchHooks.assistantAsk?.(q); await wait(250); }
  await wait(1500);
  renderLog.length = 0;
  fpsStart();
  let updates = 0;
  const phrase = "де найближче укриття пішки";
  // State updates 10 / s and typing 8 letters / s at the same time.
  const id = setInterval(() => { const st = useNaviaStore.getState(); useNaviaStore.setState({ state: { ...st.state, updatedAt: Date.now() } }); updates++; }, 100);
  const typing = setInterval(() => { const n = (updates % phrase.length) + 1; benchHooks.assistantType?.(phrase.slice(0, n)); }, 125);
  await wait(5000);
  clearInterval(id);
  clearInterval(typing);
  benchHooks.assistantType?.("");
  const f = await fpsEnd("co-pilot screen: 20 messages, 10 state updates / s + typing 8 letters / s");
  const ms = renderLog.filter((r) => r.id === "assistant").map((r) => r.ms).sort((a, b) => a - b);
  return { updates, renders: ms.length, avgRenderMs: ms.reduce((a, b) => a + b, 0) / Math.max(1, ms.length), p95RenderMs: ms[Math.floor(0.95 * (ms.length - 1))] ?? 0, maxRenderMs: ms[ms.length - 1] ?? 0, fps: f?.fps ?? null, maxFrameMs: f?.maxGapMs ?? null };
}
