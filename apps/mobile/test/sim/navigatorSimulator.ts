// "Navigator simulator" (programme part 5): an engineering harness, not the
// user's Demo Mode. For each of 7 base situations (real DemoEngine states) it
// draws random but realistic values (accuracy, time since fix, dead-reckoning
// error, speed, distances, ETA, shelters, network, offline package), builds
// the Snapshot exactly as the app does (buildSnapshot on engine state + world),
// asks every generated question (questionBank.ts) through layers 2 → 5, and
// judges each answer against that snapshot:
//   grounded  — the right kind of answer, built from snapshot fields;
//   honest    — the right kind of answer that says, with the reason, what is
//               not known (or asks back offering the right topic);
//   fail      — misunderstood / contradicts the snapshot / a number that is
//               not in the snapshot / empty or generic.
import type { NavigationState } from "@navia/core";
import { haversineMeters, initialBearing } from "@navia/core";
import { Navigator } from "../../src/ai/navigator/navigator";
import { buildSnapshot, type Snapshot } from "../../src/ai/navigator/snapshot";
import type { WorldPlace } from "../../src/ai/copilotBrain";
import { formatClock, formatDistance, formatDuration } from "../../src/i18n/format";
import { NOW, sevenSituations, worldFrom, type Scenario } from "../support/navigatorScenarios";
import { SIM_CATEGORIES, simQuestions, type SimQuestion } from "./questionBank";

export type Outcome = "grounded" | "honest" | "misunderstood" | "contradiction" | "invented" | "generic";
export type SimRow = {
  id: number; situation: string; category: string; letter: string; form: string; question: string; answer: string; intent: string;
  sourceField: string | null; honest: boolean; fail: boolean; outcome: Outcome; reason: string; latencyMs: number; sentences: number; tone: string;
};

function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
}

/** A situation with random numeric fields in realistic ranges. */
function randomize(base: Scenario, r: () => number): Snapshot {
  const between = (a: number, b: number) => a + r() * (b - a);
  const st: NavigationState = JSON.parse(JSON.stringify(base.state));
  const lost = st.gnss === "LOST";
  const degraded = st.gnss === "DEGRADED";
  // Signal
  if (st.position) {
    st.position.position.accuracyM = lost ? st.position.position.accuracyM : degraded ? Math.round(between(15, 70)) : Math.round(between(3, 14));
    st.position.confidence = lost ? between(0.15, 0.6) : degraded ? between(0.4, 0.8) : between(0.8, 0.99);
  }
  st.confidence = st.position?.confidence ?? st.confidence;
  const age = lost ? between(4, 400) : degraded ? between(1, 25) : between(0, 2);
  st.lastTrustedFixAt = st.updatedAt - Math.round(age * 1000);
  if (st.positionUncertaintyM != null || lost) st.positionUncertaintyM = Math.round(between(20, 700));
  st.speedMps = r() < 0.15 ? null : between(0, 30);
  // Route numbers
  const remaining = Math.round(between(300, 60_000));
  st.routeRemainingM = remaining;
  st.routeProgressM = Math.round(between(0, 20_000));
  if (st.nextStepDistanceM != null) st.nextStepDistanceM = Math.round(between(30, Math.min(5000, remaining)));
  st.etaSeconds = r() < 0.1 ? null : Math.round(remaining / between(5, 25));
  // World: shelters random (sometimes none), network, package
  const alertActive = base.key === "alert";
  const x = { route: base.key !== "normal", ...(alertActive ? { alert: { active: true as const, scope: "district" as const, since: NOW - Math.round(between(1, 90)) * 60_000, reasons: ["Повітряна тривога"] } } : {}) };
  const world = worldFrom(st, x);
  const here = st.position?.position;
  const nShelters = r() < 0.12 ? 0 : 1 + Math.floor(r() * 4);
  const shelters: WorldPlace[] = here ? Array.from({ length: nShelters }, (_, i) => {
    const d = between(40, 6000);
    const b = between(0, 360) * Math.PI / 180;
    const loc = { lat: here.lat + (d * Math.cos(b)) / 111_320, lon: here.lon + (d * Math.sin(b)) / (111_320 * Math.cos(here.lat * Math.PI / 180)) };
    return { id: `s${i}`, name: `Укриття №${10 + i}`, kind: "shelter" as const, location: loc, distanceM: haversineMeters(here, loc), bearingDeg: initialBearing(here, loc), origin: "online" as const, source: "Kyiv City open data" };
  }).sort((a, b) => a.distanceM - b.distanceM) : [];
  world.places = { ...world.places, shelter: shelters };
  world.placeStates = { ...world.placeStates, shelter: nShelters === 0 && r() < 0.5 ? "error" : "ready" };
  const online = r() < 0.8;
  const pkgRoll = r();
  return buildSnapshot({ state: st, world, online, now: NOW, isDemo: false, offlinePackageAvailable: pkgRoll < 0.45 ? true : pkgRoll < 0.9 ? false : null, rerouting: st.offRoute && r() < 0.5 });
}

/** Every distance / time / percent the answer may state, formatted as the navigator formats them. */
function allowed(s: Snapshot): Set<string> {
  const out = new Set<string>();
  const add = (v: string) => out.add(v.replace(/\s/g, " "));
  const dist = (m: number | null | undefined) => { if (m != null && Number.isFinite(m)) add(formatDistance(m, s.lang)); };
  dist(s.route?.remainingM); dist(s.route?.next?.distanceM);
  for (const list of Object.values(s.places)) for (const p of list ?? []) { dist(p.distanceM); add(`${Math.round(p.distanceM)} м`); }
  const plain = (v: number | null | undefined, unit: string) => { if (v != null && Number.isFinite(v)) { add(`±${Math.max(1, Math.round(v))} ${unit}`); add(`${Math.max(1, Math.round(v))} ${unit}`); } };
  plain(s.gnss.accuracyM, "м"); plain(s.position.uncertaintyM, "м"); plain(s.fields.drErrorGrowthMPerMin, "м");
  if (s.gnss.sinceFixS != null) { add(`${Math.max(1, Math.round(s.gnss.sinceFixS))} с`); add(`${Math.max(1, Math.round(s.gnss.sinceFixS / 60))} хв`); }
  if (s.route?.etaS != null) { add(formatDuration(s.route.etaS, s.lang)); for (const tok of formatDuration(s.route.etaS, s.lang).split(/(?<=хв|год|с)\s/)) add(tok); }
  if (s.motion.speedKmh != null) add(`${s.motion.speedKmh} км/год`);
  add(`${Math.round(s.fields.positionConfidence * 100)} %`);
  return out;
}

/** Values an answer of this intent must state when the snapshot has them. */
function mustSay(s: Snapshot, intent: string): string[] {
  const d = (m: number) => formatDistance(m, s.lang);
  const r = s.route;
  switch (intent) {
    case "routeNext": return r && !r.offRoute && r.next?.distanceM != null ? [d(r.next.distanceM)] : [];
    case "eta": return r ? [d(r.remainingM)] : [];
    case "shelter": case "shelterWhy": { const p = s.places.shelter?.[0]; return p ? [p.name, d(p.distanceM)] : []; }
    case "gpsStatus": return s.gnss.mode !== "navigator" && s.gnss.accuracyM != null ? [`±${Math.max(1, Math.round(s.gnss.accuracyM))} м`] : [];
    case "confidence": return s.position.known ? [`${Math.round(s.fields.positionConfidence * 100)} %`] : [];
    case "signalLost": return s.gnss.mode === "navigator" && s.gnss.sinceFixS != null && s.gnss.sinceFixS >= 1.5 ? [] : [];
    default: return [];
  }
}

const NUM = /±?\d+(?:,\d+)?\s(?:км|м|с|хв|год|%)(?![а-яіїє])/g;

function judge(s: Snapshot, q: SimQuestion, intent: string, text: string, used: string[], missing: string[], honestFlag: boolean, options: string[]): { outcome: Outcome; reason: string } {
  if (!text.trim()) return { outcome: "generic", reason: "порожня відповідь" };
  const lower = text.toLowerCase();
  // Contradictions with the snapshot.
  if (s.gnss.mode === "navigator" && /gps у нормі|позиція достовірна/i.test(text)) return { outcome: "contradiction", reason: "каже «у нормі / достовірна», а GPS втрачено" };
  if (s.gnss.mode === "normal" && !["explain", "repeat"].includes(intent) && /сигнал gps втрачено|режимі штурмана|gps немає/i.test(text)) return { outcome: "contradiction", reason: "каже «GPS втрачено», а він у нормі" };
  if (s.alert?.active !== true && /тривога у вашому районі|^тривога\.|повітряна тривога у вашому/im.test(text)) return { outcome: "contradiction", reason: "каже про тривогу, якої немає" };
  if (s.alert?.active && ["alert", "status", "shelter", "emotion"].includes(intent) && !/тривог/i.test(lower)) return { outcome: "contradiction", reason: "тривога активна, а відповідь про неї мовчить" };
  if (!s.route && /до «/.test(text) && !["explain", "repeat"].includes(intent)) return { outcome: "contradiction", reason: "говорить про маршрут, якого немає" };
  if (s.route && !s.route.offRoute && /так, ви зійшли з маршруту/i.test(text)) return { outcome: "contradiction", reason: "каже «зійшли», а offRoute = false" };
  if (s.route?.offRoute && /ні, ви на маршруті|так, ви на маршруті/i.test(text)) return { outcome: "contradiction", reason: "каже «на маршруті», а offRoute = true" };
  if (s.online && /інтернету немає/i.test(text) && intent === "offline") return { outcome: "contradiction", reason: "каже «інтернету немає», а він є" };
  if (!s.online && /інтернет зараз є/i.test(text)) return { outcome: "contradiction", reason: "каже «інтернет є», а його немає" };
  if (s.fields.offlinePackageAvailable === false && /офлайн-пакет «київ \+ область» є/i.test(text)) return { outcome: "contradiction", reason: "каже, що офлайн-пакет є, а його немає" };
  const nearest = s.places.shelter?.[0];
  if (nearest && /найближче укриття[:—-]? ?—? ?([^,—]+)/i.test(text)) {
    const named = text.match(/найближче укриття[:\s—-]+([^,—\n]+?)(?: —|,)/i)?.[1]?.trim();
    if (named && named !== nearest.name) return { outcome: "contradiction", reason: `назвала «${named}» найближчим, а найближче — «${nearest.name}»` };
  }
  // Numbers that are not in the snapshot.
  const ok = allowed(s);
  for (const m of text.matchAll(NUM)) {
    const token = m[0].replace(/\s/g, " ");
    if (!ok.has(token) && !ok.has(token.replace(/^±/, "")) && !/хв$|год$/.test(token)) return { outcome: "invented", reason: `число «${token}» не з даних` };
  }
  if (intent === "clarify") {
    return options.some((o) => q.accept.includes(o))
      ? { outcome: "honest", reason: `перепитала, запропонувавши правильну тему (${options.join("/")})` }
      : { outcome: "misunderstood", reason: `перепитала не про те (${options.join("/") || "—"}), треба ${q.accept.join("/")}` };
  }
  if (!q.accept.includes(intent)) return { outcome: intent === "unknown" ? "generic" : "misunderstood", reason: `розпізнано як «${intent}», треба ${q.accept.join("/")}` };
  if (honestFlag || missing.length > 0 || intent === "noData" || intent === "unknown") return { outcome: "honest", reason: `чесно: ${missing.join(", ") || "таких даних немає"}` };
  // Traceability: the key value of the snapshot must be in the answer, as said.
  for (const need of mustSay(s, intent)) {
    if (!text.replace(/\s/g, " ").includes(need.replace(/\s/g, " "))) return { outcome: "generic", reason: `не назвало значення з даних: «${need}»` };
  }
  if (used.length === 0 && intent !== "repeat") return { outcome: "generic", reason: "відповідь без даних" };
  return { outcome: "grounded", reason: `з даних: ${used.slice(0, 3).join(", ")}` };
}

export type SimStats = { total: number; grounded: number; honest: number; fail: number; byOutcome: Record<Outcome, number>; latency: { avg: number; p95: number; max: number } };
export type SimResult = {
  runs: number; formula: string; perCategory: { letter: string; key: string; name: string; variants: number; stats: SimStats }[]; all: SimStats;
  worst: (SimRow & { why: string })[]; lengthOk: number; lengthChecked: number; clarifyShare: number;
};

function stats(rows: SimRow[]): SimStats {
  const byOutcome = { grounded: 0, honest: 0, misunderstood: 0, contradiction: 0, invented: 0, generic: 0 } as Record<Outcome, number>;
  for (const r of rows) byOutcome[r.outcome]++;
  const lat = rows.map((r) => r.latencyMs).sort((a, b) => a - b);
  return {
    total: rows.length, grounded: byOutcome.grounded, honest: byOutcome.honest, fail: rows.length - byOutcome.grounded - byOutcome.honest, byOutcome,
    latency: { avg: lat.reduce((a, b) => a + b, 0) / Math.max(1, lat.length), p95: lat[Math.floor(0.95 * (lat.length - 1))] ?? 0, max: lat.at(-1) ?? 0 },
  };
}

const now = (): number => (globalThis as { performance?: { now(): number } }).performance?.now() ?? Date.now();

/** numericSets: random value sets per situation. rows: called for every run (CSV). */
export async function runSimulation(opts: { numericSets: number; seed?: number; onRow?: (row: SimRow) => void; keepWorst?: number }): Promise<SimResult> {
  const situations = await sevenSituations();
  const questions = simQuestions();
  const r = rng(opts.seed ?? 20260929);
  const rows: SimRow[] = [];
  const failures: { row: SimRow; snap: Snapshot; q: SimQuestion }[] = [];
  let id = 0;
  let lengthOk = 0, lengthChecked = 0, clarify = 0;
  for (const sit of situations) {
    for (let k = 0; k < opts.numericSets; k++) {
      const snap = randomize(sit, r);
      for (const q of questions) {
        const nav = new Navigator();
        if (q.category.key === "meta") nav.ask("Куди далі?", snap);
        const t0 = now();
        const rep = nav.ask(q.text, snap);
        const latencyMs = now() - t0;
        const opts2 = (rep as { options?: string[] }).options ?? [];
        const j = judge(snap, q, rep.intent, rep.text, rep.used, rep.missing, rep.honest, rep.intent === "clarify" ? clarifyOptions(rep.actions) : opts2);
        const sentences = rep.speech.split(/(?<=[.!?])\s+/).filter(Boolean).length;
        if (rep.tone !== "critical" && rep.intent !== "explain") { lengthChecked++; if (sentences <= 3) lengthOk++; }
        if (rep.intent === "clarify") clarify++;
        const row: SimRow = {
          id: ++id, situation: sit.name, category: q.category.key, letter: q.category.letter, form: q.form, question: q.text, answer: rep.text.replace(/\n/g, " "), intent: rep.intent,
          sourceField: rep.used[0] ?? null, honest: j.outcome === "honest", fail: j.outcome !== "grounded" && j.outcome !== "honest", outcome: j.outcome, reason: j.reason, latencyMs, sentences, tone: rep.tone,
        };
        opts.onRow?.(row);
        rows.push(row);
        if (row.fail) failures.push({ row, snap, q });
      }
    }
  }
  const perCategory = SIM_CATEGORIES.map((c) => ({ letter: c.letter, key: c.key, name: c.name, variants: questions.filter((q) => q.category.key === c.key).length, stats: stats(rows.filter((x) => x.category === c.key)) }));
  // Worst: contradictions and invented facts first, spread over categories and questions.
  const rank: Record<Outcome, number> = { contradiction: 0, invented: 1, misunderstood: 2, generic: 3, honest: 9, grounded: 9 };
  failures.sort((a, b) => rank[a.row.outcome] - rank[b.row.outcome]);
  const picked: typeof failures = [];
  const seenQ = new Set<string>();
  for (const f of failures) { const key = `${f.row.category}|${f.row.question}|${f.row.outcome}`; if (seenQ.has(key)) continue; seenQ.add(key); picked.push(f); if (picked.length >= (opts.keepWorst ?? 150)) break; }
  for (const f of failures) { if (picked.length >= (opts.keepWorst ?? 150)) break; if (!picked.includes(f)) picked.push(f); }
  const worst = picked.map(({ row, snap }) => {
    const nav = new Navigator();
    nav.ask(row.question, snap);
    return { ...row, why: nav.ask("чому ти так відповів?", snap).text.replace(/\n/g, " ") };
  });
  const perSit = situations.length, variants = questions.length;
  return {
    runs: rows.length,
    formula: `${perSit} ситуацій × ${variants} формулювань (11 категорій × ${SIM_CATEGORIES.map((c) => questions.filter((q) => q.category.key === c.key).length).join("/")}) × ${opts.numericSets} випадкових наборів чисел = ${perSit * variants * opts.numericSets}`,
    perCategory, all: stats(rows), worst, lengthOk, lengthChecked, clarifyShare: clarify / Math.max(1, rows.length),
  };
}

function clarifyOptions(actions: { kind: string; label?: string }[]): string[] {
  // The clarify handler offers one "ask" button per candidate topic; map labels back.
  const map: Record<string, string> = { "Чому ти так відповів?": "explain", "Що робити без GPS?": "signalLost", "Що з GPS?": "gpsStatus", "Наскільки точна моя позиція?": "confidence", "Куди далі?": "routeNext", "Скільки лишилось?": "eta", "Я правильно їду?": "onRoute", "Я з'їхав з маршруту?": "reroute", "Чому цей маршрут?": "routeWhy", "Де я?": "whereAmI", "Де укриття?": "shelter", "Це точно найближче укриття?": "shelterWhy", "Що з тривогою?": "alert", "Статус": "status", "Що працює без інтернету?": "offline", "Мені страшно": "emotion", "Які є дані?": "noData", "Що є поруч?": "place" };
  return actions.map((a) => map[a.label ?? ""]).filter((x): x is string => !!x);
}

export const CRITERIA = { okShare: 0.97, failShare: 0.03, categoryFail: 0.08, p95Ms: 1500 };

export function checkCriteria(res: SimResult): { name: string; value: string; ok: boolean }[] {
  const a = res.all;
  const worstCat = [...res.perCategory].sort((x, y) => y.stats.fail / y.stats.total - x.stats.fail / x.stats.total)[0]!;
  return [
    { name: "обґрунтовані + чесні відмови ≥ 97 %", value: `${(100 * (a.grounded + a.honest) / a.total).toFixed(2)} %`, ok: (a.grounded + a.honest) / a.total >= CRITERIA.okShare },
    { name: "провали ≤ 3 %", value: `${(100 * a.fail / a.total).toFixed(2)} %`, ok: a.fail / a.total <= CRITERIA.failShare },
    { name: "жодна категорія з провалами > 8 %", value: `найгірша: ${worstCat.letter} ${worstCat.name} — ${(100 * worstCat.stats.fail / worstCat.stats.total).toFixed(2)} %`, ok: res.perCategory.every((c) => c.stats.fail / c.stats.total <= CRITERIA.categoryFail) },
    { name: "p95 затримки ≤ 1,5 с", value: `${a.latency.p95.toFixed(3)} мс`, ok: a.latency.p95 <= CRITERIA.p95Ms },
    { name: "жодної суперечності зі станом і жодного вигаданого числа", value: `суперечностей ${a.byOutcome.contradiction}, вигаданих чисел ${a.byOutcome.invented}`, ok: a.byOutcome.contradiction === 0 && a.byOutcome.invented === 0 },
  ];
}

export { formatClock };
