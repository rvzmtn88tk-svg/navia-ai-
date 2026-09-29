import { understand } from "../src/ai/navigator/intents";
import { typoCases } from "./support/typoSet";
const cases = typoCases();
let ok = 0, clar = 0;
const byKind: Record<string, [number, number]> = {};
for (const c of cases) { const u = understand(c.text); const good = c.accept.includes(u.intent); if (good) ok++; else if (u.intent === "clarify" && u.options.some((o) => c.accept.includes(o))) clar++; const b = (byKind[c.kind] ??= [0, 0]); b[1]++; if (good) b[0]++; }
console.log(`typo set: ${cases.length} cases; right ${ok} (${(100 * ok / cases.length).toFixed(1)} %), asked back right ${clar}`);
console.log(Object.entries(byKind).map(([k, [a, b]]) => `${k} ${a}/${b}`).join(", "));
