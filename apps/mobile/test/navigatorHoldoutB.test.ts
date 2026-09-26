// Hold-out B: written after hold-out A was seen and the example bank was
// added — the clean estimate. Never tune on these; add new hold-out sets.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classify } from "../src/ai/navigator/intents";

const HOLDOUT_B: [string, string[]][] = [
  ["навігатор показує що я в полі, а я на трасі", ["signalLost", "gpsStatus", "whereAmI"]],
  ["супутники не підхоплюються вже хвилину", ["signalLost", "gpsStatus"]],
  ["если связь со спутником оборвется ты справишься", ["signalLost"]],
  ["чи можна їхати далі якщо нема gps", ["signalLost"]],
  ["наскільки зараз можна довіряти позиції", ["gpsStatus"]],
  ["стрілка не рухається, в чому справа", ["gpsStatus", "signalLost"]],
  ["наступний маневр через скільки", ["routeNext"]],
  ["на кільці який виїзд брати", ["routeNext"]],
  ["після заправки куди", ["routeNext"]],
  ["мне сейчас перестраиваться вправо?", ["routeNext"]],
  ["скільки нам ще пилити", ["eta"]],
  ["коли будемо в борисполі", ["eta"]],
  ["сколько по времени еще", ["eta"]],
  ["чи ми вже близько", ["eta"]],
  ["це та дорога що треба?", ["onRoute"]],
  ["ми не звернули випадково не туди?", ["onRoute", "reroute"]],
  ["я поворот проскочив", ["reroute"]],
  ["построй маршрут заново", ["reroute"]],
  ["якщо я звернув не там, ти скажеш?", ["reroute"]],
  ["в якому я місті зараз", ["whereAmI"]],
  ["опиши де ми", ["whereAmI"]],
  ["де найближчий підвал сховатися", ["shelter"]],
  ["куди йти під час сирени", ["shelter", "alert"]],
  ["зараз повітряна небезпека?", ["alert"]],
  ["загроза балістики є?", ["alert"]],
  ["поясни коротко як у нас все", ["status"]],
  ["що важливого зараз", ["status"]],
  ["давай ще раз те саме", ["repeat"]],
  ["не почув що ти сказав", ["repeat"]],
  ["це ти звідки взяв", ["explain"]],
  ["на чому базується твоя відповідь", ["explain"]],
  ["чи є затори на виїзді з міста", ["noData"]],
  ["холодно на вулиці?", ["noData"]],
  ["де пости поліції", ["noData"]],
  ["дякую тобі", ["smalltalk"]],
  ["ну добре", ["smalltalk"]],
  ["де купити воду", ["place"]],
  ["найближчий банкомат", ["place"]],
  ["де можна зарядити телефон", ["place"]],
  ["у пасажира кров з голови", ["emergency"]],
  ["людина не дихає", ["emergency"]],
];

test("hold-out B (clean): recognition rate", () => {
  const rows = HOLDOUT_B.map(([q, accept]) => { const got = classify(q); return { q, accept, got, ok: accept.includes(got) }; });
  const ok = rows.filter((r) => r.ok).length;
  const rate = (100 * ok) / rows.length;
  const dir = join(__dirname, "reports");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "navigator-holdout-b.md"), ["# Hold-out B (clean)", "", `Recognised: ${ok} of ${rows.length} (${rate.toFixed(1)} %)`, "", "| Question | Expected | Got | OK |", "|---|---|---|---|", ...rows.map((r) => `| ${r.q} | ${r.accept.join("/")} | ${r.got} | ${r.ok ? "✓" : "✗"} |`), ""].join("\n"));
  console.log(`hold-out B: ${ok}/${rows.length} (${rate.toFixed(1)} %)`);
  for (const r of rows.filter((x) => !x.ok)) console.log(`  ✗ «${r.q}» → ${r.got} (want ${r.accept.join("/")})`);
  assert.ok(rows.length >= 40);
});
