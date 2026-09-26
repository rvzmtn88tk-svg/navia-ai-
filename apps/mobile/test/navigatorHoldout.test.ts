// Hold-out set: phrasings written AFTER the classifier was tuned on the
// generator, never used for tuning. Their accuracy is the honest estimate of
// how the navigator copes with wording it has not seen. This test does not
// fail on misses — it records the rate (the report says it); change the
// classifier, then re-run and compare. Do NOT tune on these phrasings; add
// new hold-out phrasings instead.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classify } from "../src/ai/navigator/intents";

export const HOLDOUT: [string, string[]][] = [
  ["у меня тут навигация сломалась, спутников ноль", ["signalLost"]],
  ["телефон перестав бачити де я, це глушилка?", ["signalLost", "whereAmI"]],
  ["чувак, связи со спутником нет, веди как-нибудь", ["signalLost"]],
  ["що мені робити, якщо навігація зовсім вимкнеться", ["signalLost"]],
  ["точка на карті стрибає, це нормально?", ["gpsStatus", "signalLost"]],
  ["наскільки точно ти зараз знаєш де я", ["gpsStatus", "whereAmI"]],
  ["джипіес живий?", ["gpsStatus"]],
  ["ловит нормально спутники?", ["gpsStatus"]],
  ["наступним що буде, ліво чи право?", ["routeNext"]],
  ["мені прямо чи повертати?", ["routeNext"]],
  ["на світлофорі куди?", ["routeNext"]],
  ["где мне съезжать с трассы", ["routeNext"]],
  ["скільки ще метрів до маневру", ["routeNext"]],
  ["ще довго їхати до кінця?", ["eta"]],
  ["встигнемо до восьмої?", ["eta"]],
  ["какое расстояние до конца маршрута", ["eta"]],
  ["скільки хвилин лишилось", ["eta"]],
  ["я ж по правильній їду?", ["onRoute"]],
  ["ми точно в той бік їдемо?", ["onRoute"]],
  ["не проскочили ми часом?", ["onRoute", "reroute"]],
  ["здається я не туди завернув", ["reroute"]],
  ["я заехал куда-то не туда", ["reroute"]],
  ["поверни мене на маршрут", ["reroute"]],
  ["що буде якщо я пропущу з'їзд", ["reroute"]],
  ["підкажи адресу, де я зараз стою", ["whereAmI"]],
  ["я вообще где нахожусь", ["whereAmI"]],
  ["який це район?", ["whereAmI"]],
  ["де тут можна перечекати обстріл", ["shelter"]],
  ["найближче бомбосховище пішки", ["shelter"]],
  ["куди бігти якщо зараз прилетить", ["shelter"]],
  ["оголосили тривогу чи ні?", ["alert"]],
  ["чути вибухи, що відбувається", ["alert", "status"]],
  ["в області зараз неспокійно?", ["alert", "status"]],
  ["дай короткий огляд ситуації", ["status"]],
  ["розкажи що зараз з усім", ["status"]],
  ["як там у нас справи з дорогою і сигналом", ["status", "gpsStatus"]],
  ["скажи це ще раз", ["repeat"]],
  ["не зрозумів, повтори повільніше", ["repeat"]],
  ["а звідки такі цифри?", ["explain"]],
  ["чому ти вирішив що я на маршруті?", ["explain"]],
  ["на трасі затор?", ["noData"]],
  ["чи йде зараз сніг у Броварах", ["noData"]],
  ["де стоять камери швидкості", ["noData"]],
  ["поліція на дорозі є?", ["noData"]],
  ["дякую друже", ["smalltalk"]],
  ["ти молодець", ["smalltalk"]],
  ["доброго вечора", ["smalltalk"]],
  ["де тут заправитися", ["place"]],
  ["потрібна аптека терміново", ["place"]],
  ["де пункт незламності поблизу", ["place"]],
  ["водій знепритомнів", ["emergency"]],
  ["збили пішохода, що робити", ["emergency"]],
];

test("hold-out phrasings (not used for tuning): recognition rate", () => {
  const rows = HOLDOUT.map(([q, accept]) => { const got = classify(q); return { q, accept, got, ok: accept.includes(got) }; });
  const ok = rows.filter((r) => r.ok).length;
  const rate = (100 * ok) / rows.length;
  const dir = join(__dirname, "reports");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "navigator-holdout.md"), ["# Hold-out phrasings", "", `Recognised: ${ok} of ${rows.length} (${rate.toFixed(1)} %)`, "", "| Question | Expected | Got | OK |", "|---|---|---|---|", ...rows.map((r) => `| ${r.q} | ${r.accept.join("/")} | ${r.got} | ${r.ok ? "✓" : "✗"} |`), ""].join("\n"));
  console.log(`hold-out: ${ok}/${rows.length} (${rate.toFixed(1)} %)`);
  for (const r of rows.filter((x) => !x.ok)) console.log(`  ✗ «${r.q}» → ${r.got} (want ${r.accept.join("/")})`);
  assert.ok(rows.length >= 50);
});
