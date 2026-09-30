// HOLDOUT evaluation suite — measures GENERALISATION.
//
// Written after the co-pilot (prompt, tools, state) was implemented, with
// situations and wordings that appear nowhere in the code, the prompt, the
// dev suite or the recorded transcripts. Rule: do not change prompts or
// tools to make a holdout scenario pass; if one fails, fix the general cause
// and add a NEW, different case to the dev suite. Report holdout results
// separately from dev results.
//
// Same trip world as the dev suite (see dev.ts header).

import type { Scenario } from "../scenarios";
import { WORLD_SAVED_HOME } from "../world";
import { PreferenceStore } from "../../src/copilot/preferences";
import { SEARCH, ACTIONS, find, info, proposes, clarifies, one, dialog, detourAtMost, aheadWindowAround, rangeGiven } from "./helpers";

const FUEL = ["fuel"];
const FOOD = ["restaurant", "fast_food", "cafe"];
const COFFEE = ["cafe"];
const home = { savedPlaces: [WORLD_SAVED_HOME] };
const prefs = () => ({ preferences: new PreferenceStore() });

export const HOLDOUT_SUITE: Scenario[] = [
  // --- implicit needs, new wording ---
  one("h-tank-empty-far", "paraphrase", "Слухай, бак майже порожній, а до Борисполя ще пиляти — що робимо?", find(FUEL)),
  one("h-yawn", "paraphrase", "Я вже позіхаю кожні п'ять хвилин.", find(COFFEE)),
  one("h-stretch", "paraphrase", "Хочеться розім'яти ноги десь по дорозі.", info({ expectAnyTool: SEARCH })),
  one("h-picnic", "paraphrase", "Треба купити щось на пікнік, хліб, сир, воду.", find(["supermarket"])),
  one("h-dog", "paraphrase", "Собака скиглить, треба зупинитись вигуляти її.", info({ expectAnyTool: SEARCH.concat(["get_landmarks_ahead"]) })),
  one("h-late-meeting", "paraphrase", "Боюсь запізнитись, скажи чесно, коли ми будемо?", info()),
  one("h-kid-sick", "paraphrase", "Малого закачало, треба терміново десь стати.", info({ expectAnyTool: SEARCH })),
  one("h-hot-dog", "paraphrase", "Хот-дог на заправці — це було б ідеально.", find(FUEL)),
  one("h-quiet-place", "paraphrase", "Мені треба 10 хвилин тиші для дзвінка, де можна зупинитись?", info({ expectAnyTool: SEARCH })),
  one("h-no-cash", "paraphrase", "Готівки нема зовсім, а там треба платити налом.", find(["atm"])),
  // --- slang / mixed / typos ---
  one("h-ru-slang-fuel", "slang", "Братан, горючки бы плеснуть где-нить по трассе", find(FUEL)),
  one("h-uk-slang-food", "slang", "Шо б такого точнуть по дорозі, га?", find(FOOD)),
  one("h-typo-coffee", "typos", "кава нада срчно", find(COFFEE)),
  one("h-typo-eta", "typos", "коли будемо на місцы", info()),
  one("h-en-mix", "slang", "Окей, find me a gas station, але тільки не SOCAR", find(FUEL)),
  one("h-voice-garble", "typos", "знайди мені кав' по дор", find(COFFEE)),
  // --- constraints expressed differently ---
  one("h-detour-words", "multi_step", "Поїсти, але так, щоб це нас майже не затримало.", find(FOOD, { expectCall: detourAtMost(6) })),
  one("h-window-words", "multi_step", "Заправитися не зараз, а десь на півдорозі.", find(FUEL, { expectAnyTool: ["search_along_route"] })),
  one("h-range-words", "multi_step", "Бортовий комп'ютер каже, що пального на 10 км. Куди?", find(FUEL, { expectCall: rangeGiven(12) })),
  one("h-hour-food", "multi_step", "Десь за три чверті години хочу пообідати, ресторан, без великого гаку.", find(["restaurant"], { expectCall: aheadWindowAround(45, 12) })),
  one("h-open-late", "multi_step", "Треба ресторан, що працює, коли ми до нього доїдемо.", find(["restaurant"], { mustNotMatch: [/Нічний Гриль/] })),
  // --- multi-turn references, never seen ---
  dialog("h-ref-cheaper", "reference", "which adds less", [
    { user: "Кава і заправка по дорозі — що є?", ...info({ expectAnyTool: SEARCH }) },
    { user: "А що з цього менше затримає?", ...info() },
  ]),
  dialog("h-ref-last-one", "reference", "the last one on the list", [
    { user: "Перелічи заправки по маршруту.", ...find(FUEL) },
    { user: "Остання в списку — вона далеко від траси?", ...info() },
  ]),
  dialog("h-ref-add-then-when", "reference", "add then arrival", [
    { user: "Що по кав'ярнях?", ...find(COFFEE) },
    { user: "Беремо ту, що ближче, і скажи, на скільки пізніше приїдемо.", expectAnyTool: ["add_stop", "get_place_details"] },
  ]),
  dialog("h-ref-swap", "reference", "swap the stop", [
    { user: "Додай зупинку на ОККО.", expectAnyTool: ["add_stop", "search_along_route"] },
    { user: "Так.", expectWaypoints: 1 },
    { user: "Заміни її на WOG.", expectAnyTool: ["remove_stop", "add_stop", "search_along_route"] },
  ]),
  dialog("h-ref-that-place-parking", "reference", "parking at that place", [
    { user: "Знайди Пузату Хату.", ...find(["restaurant"], {}, /Пузата/i) },
    { user: "Там є де стати машиною?", expectAnyTool: ["search_near", "get_place_details"] },
  ]),
  dialog("h-ref-ru-first", "reference", "ru the first one", [
    { user: "Кафешки по пути покажи", ...find(COFFEE) },
    { user: "Первое — во сколько там будем?", ...info() },
  ]),
  // --- changing mind / cancel ---
  dialog("h-cm-not-hungry", "change_mind", "not hungry anymore", [
    { user: "Знайди де поїсти.", ...find(FOOD) },
    { user: "Та вже нічого, перехотілося.", ...info() },
  ]),
  dialog("h-cm-plan-no", "change_mind", "reject a plan", [
    { user: "Заїдемо за кавою, а потім додому.", expectPending: "add_stop+set_destination" },
    { user: "Ні, лишаємо все як є.", expectPending: null, expectWaypoints: 0 },
  ], home),
  dialog("h-cm-undo-remove", "change_mind", "put the stop back", [
    { user: "Додай зупинку на Aroma Kava.", expectAnyTool: ["add_stop", "search_along_route"] },
    { user: "Так.", expectWaypoints: 1 },
    { user: "Прибери.", expectTools: ["remove_stop"] },
    { user: "Ой, ні, поверни назад.", expectAnyTool: ["add_stop"] },
  ]),
  // --- ambiguity ---
  one("h-amb-eat", "clarify", "Знайди, де поїсти нормально.", { expectPending: null, forbidTools: ACTIONS }),
  one("h-amb-that-one", "clarify", "Вона сьогодні працює?", clarifies()),
  one("h-amb-go-back", "clarify", "Повернись.", { expectPending: null, forbidTools: ["add_stop", "set_destination"] }),
  one("h-amb-cheap", "clarify", "Знайди де дешевше.", { expectPending: null, forbidTools: ACTIONS, mustNotMatch: [/\d+[.,]\d+\s*грн/] }),
  // --- missing data / honesty ---
  one("h-nd-diesel-price", "no_results", "Де найдешевший дизель по дорозі?", info({ mustNotMatch: [/\d+[.,]\d+\s*(грн|₴)/], mustMatch: [/цін|не маю|немає/i] })),
  one("h-nd-reviews", "no_results", "Відгуки про Пузату Хату хороші?", info({ mustMatch: [/відгук|рейтинг|оцін/i] })),
  one("h-nd-wifi", "no_results", "В якій кав'ярні по дорозі є Wi-Fi?", info({ mustMatch: [/немає|не маю|даних|невідомо/i] })),
  one("h-nd-vet", "no_results", "Ветклініка є поруч з маршрутом?", info({ mustMatch: [/немає|не знайш|не знайд|не маю|не можу/i] })),
  one("h-nd-queue", "no_results", "Чи велика черга на ОККО зараз?", info({ mustMatch: [/не маю|немає|даних|не знаю/i] })),
  one("h-nd-toll-price", "no_results", "Скільки коштує платна дорога, якщо поїдемо нею?", info({ mustNotMatch: [/\d+\s*грн/] })),
  // --- errors ---
  one("h-err-overpass", "api_error", "Знайди McDonald's по дорозі.", info({ mustMatch: [/недоступн|не вдалося|помилк|не можу/i] }), { places: "failing" }),
  one("h-err-route-pref", "api_error", "Уникай ґрунтових доріг.", { mustNotMatch: [/готово|зроблено/i] }, { routingFails: true }),
  one("h-err-offline-eta", "offline", "Інтернет пропав, а ми доїдемо?", info(), { network: false }),
  // --- route change, new wording ---
  one("h-rc-scrap", "route_change", "Забудь Бориспіль, їдемо до мене додому.", proposes("set_destination"), home),
  one("h-rc-scenic", "route_change", "Хочу їхати не трасою, а якось спокійніше.", { expectAnyTool: ["set_route_preferences", "compare_routes"] }),
  one("h-rc-reverse-stops", "route_change", "Порядок зупинок навпаки, будь ласка.", { expectPending: null }),
  // --- preferences ---
  one("h-pr-hate-mcd", "preferences", "Фастфуд мені більше ніколи не пропонуй.", { expectTools: ["remember_preference"] }, prefs()),
  one("h-pr-short", "preferences", "Відповідай коротше, мене це відволікає.", { expectTools: ["remember_preference"], expectPreferenceKeys: ["reply_length"] }, prefs()),
  one("h-pr-not-pref", "preferences", "Сьогодні хочу саме WOG.", { ...find(FUEL, {}, /WOG|ВОГ/i), forbidTools: ["remember_preference"] }, prefs()),
  // --- reminders ---
  one("h-rm-rest-km", "reminder", "Кілометрів через 15 нагадай, що треба перепочити.", { expectTools: ["set_reminder"], expectReminders: 1 }),
  one("h-rm-coffee-later", "reminder", "Кава зараз не треба, але через хвилин сорок — так.", { expectAnyTool: ["set_reminder", "search_along_route"], expectPending: null }),
  // --- GPS / position ---
  one("h-gps-tunnel", "gps", "Ми в тунелі, ти ще знаєш, де ми?", info(), { band: "LOW", gnss: "LOST" }),
  one("h-gps-jump", "gps", "Карта показує, що я в полі, а я на трасі!", info()),
  // --- unexpected ---
  one("h-u-sing", "unexpected", "Заспівай щось.", info({ maxWords: 50 })),
  one("h-u-sleep", "unexpected", "Я дуже хочу спати, але мені треба доїхати, що порадиш?", info({ expectAnyTool: SEARCH.concat(["get_route_overview"]) })),
  one("h-u-tip", "unexpected", "Як краще проїхати перехрестя з круговим рухом?", info({ maxWords: 60 })),
  one("h-u-en-joke", "language", "Tell me something funny, I'm bored.", info({ expectLanguage: "en", maxWords: 50 })),
  // --- long, multi-goal ---
  one("h-long-mixed", "long", "Нам треба: заправитись на ОККО, купити води в супермаркеті і потім біля кінцевої знайти стоянку — розплануй, будь ласка, щоб було якнайменше гаків.", info({ expectAnyTool: SEARCH, maxWords: 70 })),
  one("h-long-explain", "long", "Поясни простими словами, як ти визначаєш, де я, коли GPS зникає, і наскільки тобі тоді можна вірити.", info({ maxWords: 70 })),
];
