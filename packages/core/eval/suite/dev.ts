// DEVELOPMENT evaluation suite for the NAVIA co-pilot (run live with a real
// model: `npm run eval:ai -- --suite dev`). It may be looked at while
// improving prompts and tools; generalisation is measured on the HOLDOUT
// suite (holdout.ts), which must not be used for tuning.
//
// Trip world (eval/world.ts): the car is 2 km from Maidan on the way to
// Boryspil, ~31 km / 48 min left, Tuesday 14:00. Ahead: Фора 4.3 km,
// Пузата Хата 5.2 km, Aroma Kava 6 km, ОККО 9 km, McDonald's 14 km (0.7 km
// off), WOG 18 km, Нічний Гриль 19.5 km (closed now), Козак 20 km,
// McDonald's 22 km (2.6 km off), Кава Кофі 25 km, SOCAR 27 km (0.9 km off);
// parkings near the destination. No pharmacies, hospitals, toilets, EV
// chargers, prices, ratings, weather or live traffic in the data.
//
// Checks are behavioural (tool kind, constraints, propose vs. execute, ask
// vs. act, grounded numbers, length, language) — any wording that behaves
// correctly passes. Nothing in the co-pilot's code refers to these phrases.

import type { Scenario } from "../scenarios";
import { WORLD_SAVED_HOME } from "../world";
import { PreferenceStore } from "../../src/copilot/preferences";
import {
  SEARCH, ACTIONS, find, info, proposes, clarifies, one, dialog, searchedFor, detourAtMost, aheadWindowAround, rangeGiven, both,
} from "./helpers";

const FUEL = ["fuel"];
const FOOD = ["restaurant", "fast_food", "cafe"];
const COFFEE = ["cafe"];
const SHOP = ["supermarket"];
const PARKING = ["parking"];
const home = { savedPlaces: [WORLD_SAVED_HOME] };

const normal: Scenario[] = [
  one("n-fuel-way", "normal", "Знайди заправку по дорозі.", find(FUEL)),
  one("n-fuel-detour5", "normal", "Заправка по маршруту, щоб гак був не більше 5 хвилин.", find(FUEL, { expectCall: detourAtMost(5, FUEL) })),
  one("n-coffee-way", "normal", "Де можна випити кави по дорозі?", find(COFFEE)),
  one("n-coffee-3min", "normal", "Кава по дорозі, максимум 3 хвилини відхилення.", find(COFFEE, { expectCall: detourAtMost(3, COFFEE) })),
  one("n-restaurant-30", "normal", "Знайди ресторан приблизно через 30 хвилин їзди.", find(["restaurant"], { expectCall: aheadWindowAround(30, 5), mustNotMatch: [/Нічний Гриль/] })),
  one("n-mcd-way", "normal", "Є McDonald's по дорозі?", find(["fast_food"], {}, /McDonald|Макдон/i)),
  one("n-parking-dest", "normal", "Де припаркуватися біля місця призначення?", find(PARKING, { expectCall: { description: "search_near anchored at destination", test: (c) => c.some((x) => x.tool === "search_near" && x.input.anchor === "destination") } })),
  one("n-supermarket", "normal", "Треба заїхати в супермаркет по дорозі.", find(SHOP)),
  one("n-eta", "normal", "О котрій ми будемо на місці?", info({ mustMatch: [/\d{1,2}[:.]\d{2}|\d+\s*хв/] })),
  one("n-remaining", "normal", "Скільки ще кілометрів?", info({ mustMatch: [/31|км/] })),
  one("n-next-turn", "normal", "Який наступний поворот?", info()),
  one("n-current-road", "normal", "По якій дорозі ми зараз їдемо?", info()),
  one("n-why-route", "normal", "Чому саме цей маршрут?", info({ expectAnyTool: ["get_route_overview", "compare_routes"] })),
  one("n-alternatives", "normal", "Є інші варіанти маршруту?", info({ expectTools: ["compare_routes"] })),
  one("n-traffic", "normal", "Є затори попереду?", info({ expectTools: ["get_traffic_ahead"], mustMatch: [/немає|не маю|недоступн|нема/i] })),
  one("n-landmarks", "normal", "Які орієнтири будуть на шляху?", info({ expectTools: ["get_landmarks_ahead"] })),
  one("n-see-fora", "normal", "Я бачу Фору, куди далі?", info({ expectTools: ["check_landmark"] })),
  one("n-see-wog", "normal", "Бачу WOG праворуч — це наш поворот?", info({ expectTools: ["check_landmark"] })),
  one("n-open-now", "normal", "Знайди ресторан, який зараз відкритий, по маршруту.", find(["restaurant"], { mustNotMatch: [/Нічний Гриль/] })),
  one("n-fastfood", "normal", "Щось швидке перекусити по дорозі.", find(["fast_food", "cafe"])),
  one("n-fuel-okko", "normal", "Знайди ОККО по дорозі.", find(FUEL, {}, /OKKO|ОККО/i)),
  one("n-wog-or-okko", "normal", "Мені WOG або ОККО, що ближче?", find(FUEL, {}, /WOG|OKKO|ОККО/i)),
  one("n-home", "route_change", "Відвези мене додому.", proposes("set_destination", { expectTools: ["find_destination"] }), home),
  one("n-airport", "route_change", "Змінимо маршрут на аеропорт Бориспіль.", proposes("set_destination", { expectTools: ["find_destination"] })),
  one("n-avoid-unpaved", "route_change", "Не хочу їхати поганими дорогами.", { expectTools: ["set_route_preferences"], expectCall: { description: "avoid_unpaved true", test: (c) => c.some((x) => x.tool === "set_route_preferences" && x.input.avoid_unpaved === true) } }),
];

const paraphrase: Scenario[] = [
  one("p-hungry", "paraphrase", "Щось я зголоднів.", find(FOOD, { asksClarification: false })),
  one("p-hungry2", "paraphrase", "Живіт бурчить, треба б щось з'їсти.", find(FOOD)),
  one("p-fuel-low", "paraphrase", "Бензину вже небагато.", find(FUEL)),
  one("p-fuel-light", "paraphrase", "Загорілась лампочка пального.", find(FUEL)),
  one("p-half-tank", "paraphrase", "У мене пів бака, чи варто заправитися по дорозі?", info({ expectAnyTool: SEARCH })),
  one("p-sleepy", "paraphrase", "Мене хилить у сон, треба взбадьоритися.", find(COFFEE)),
  one("p-coffee-want", "paraphrase", "Кави б зараз.", find(COFFEE)),
  one("p-water", "paraphrase", "Треба купити води.", find(SHOP.concat(FUEL))),
  one("p-snack", "paraphrase", "Хочу щось солоденьке, де взяти?", find(["supermarket", "cafe", "fuel"])),
  one("p-rest", "paraphrase", "Втомився, хочу десь зупинитись на пару хвилин.", info({ expectAnyTool: SEARCH })),
  one("p-arrive-park", "paraphrase", "Де я залишу машину, коли приїдемо?", find(PARKING)),
  one("p-lunch-later", "paraphrase", "Пообідати хочеться, але не прямо зараз, хвилин за двадцять.", find(["restaurant", "fast_food", "cafe"], { expectCall: aheadWindowAround(20, 8) })),
  one("p-far", "paraphrase", "Далеко ще нам?", info()),
  one("p-when", "paraphrase", "Встигнемо до третьої?", info({ mustMatch: [/так|ні|встигн|прибуття|\d{1,2}[:.]\d{2}/i] })),
  one("p-jam", "paraphrase", "Тут якась жесть з пробкою.", info({ expectAnyTool: ["get_traffic_ahead", "compare_routes"] })),
  one("p-better-road", "paraphrase", "Може є дорога краща?", info({ expectTools: ["compare_routes"] })),
  one("p-stop-hour", "paraphrase", "Десь через годину зупинимось.", { expectAnyTool: ["set_reminder", "search_along_route"], expectPending: null }),
  one("p-coffee-no-loop", "paraphrase", "Знайди, де кави взяти, але щоб не петляти.", find(COFFEE, { expectCall: both(searchedFor(COFFEE), { description: "small detour limit", test: (c) => c.some((x) => x.tool === "search_along_route" && Number(x.input.max_detour_minutes) <= 5) }) })),
  one("p-normal-food", "paraphrase", "Що-небудь нормальне поїсти попереду.", find(FOOD)),
  one("p-lost", "paraphrase", "Я здається проїхав поворот.", info()),
  one("p-right-way", "paraphrase", "Я правильно їду?", info()),
  one("p-slow", "paraphrase", "Ми якось повільно їдемо, скільки часу втрачаємо?", info()),
  one("p-kids-toilet", "paraphrase", "Дитина хоче в туалет.", find(["toilets", "fuel", "cafe", "fast_food"])),
  one("p-cash", "paraphrase", "Мені треба зняти готівку.", find(["atm"])),
  one("p-wash", "paraphrase", "Машина брудна, де помити?", find(["car_wash"])),
  one("p-tire", "paraphrase", "Колесо спускає, де шиномонтаж?", find(["car_repair"])),
  one("p-meds", "paraphrase", "Голова болить, де купити таблетки?", find(["pharmacy"])),
  one("p-charge", "paraphrase", "Батарея електрокара сідає, де зарядка?", find(["ev_charging"])),
  one("p-hotel", "paraphrase", "Де можна переночувати поблизу пункту призначення?", find(["hotel"])),
  one("p-mall", "paraphrase", "Хочу по дорозі заскочити в торговий центр.", find(["shopping_centre", "supermarket"])),
];

const slang: Scenario[] = [
  one("s-zapravka-ru", "slang", "Слышь, где тут заправиться можно по пути?", find(FUEL, { expectLanguage: "ru" })),
  one("s-pozhrat", "slang", "Где б пожрать по-быстрому?", find(FOOD, { expectLanguage: "ru" })),
  one("s-kofeek", "slang", "Кофеёк бы по дороге", find(COFFEE)),
  one("s-surzhyk-fuel", "slang", "Шо там по заправках, є шось по дорозі?", find(FUEL)),
  one("s-surzhyk-far", "slang", "Скока ще пилить?", info()),
  one("s-makdak", "slang", "Мак по дорозі є?", find(["fast_food"], {}, /McDonald|Макдон/i)),
  one("s-mak-ru", "slang", "Макдак по пути есть?", find(["fast_food"], { expectLanguage: "ru" }, /McDonald|Макдон/i)),
  one("s-probka", "slang", "Шо там з пробками, брат?", info({ expectTools: ["get_traffic_ahead"] })),
  one("s-parkovka", "slang", "Де там кинути тачку біля місця?", find(PARKING)),
  one("s-bystrey", "slang", "Давай якось швидше доберемось", info({ expectAnyTool: ["compare_routes", "get_route_overview"] })),
  one("s-kava-plz", "slang", "каву плз", find(COFFEE)),
  one("s-zhrat-uk", "slang", "Шось пожерти б", find(FOOD)),
  one("s-benz", "slang", "Бенз на нулі майже", find(FUEL)),
  one("s-dizel", "slang", "Де соляру залити?", find(FUEL)),
  one("s-shaurma", "slang", "Шаурмичку б десь", find(["fast_food", "cafe", "restaurant"])),
  one("s-vtykaiu", "slang", "Шось я втикаю, де ми?", info()),
  one("s-ru-home", "slang", "Погнали домой", proposes("set_destination", { expectTools: ["find_destination"] }), home),
  one("s-ru-eta", "slang", "Когда приедем то?", info({ expectLanguage: "ru" })),
  one("s-en-mixed", "slang", "Бро, coffee по дорозі є?", find(COFFEE)),
  one("s-ru-toilet", "slang", "Где тут отлить можно?", find(["toilets", "fuel", "cafe", "fast_food"])),
];

const typos: Scenario[] = [
  one("t-zapravka", "typos", "знайди заправлку по дорозі", find(FUEL)),
  one("t-kava", "typos", "кавв по дорози", find(COFFEE)),
  one("t-restoran", "typos", "ресторн через пивгодини", find(["restaurant"], { expectCall: aheadWindowAround(30, 8) })),
  one("t-mcd", "typos", "макдональс по дорозі", find(["fast_food"], {}, /McDonald|Макдон/i)),
  one("t-okko", "typos", "окко запрвка", find(FUEL, {}, /OKKO|ОККО/i)),
  one("t-parking", "typos", "паркінк біля кінцевої", find(PARKING)),
  one("t-skilky", "typos", "скільуи ще їхати", info()),
  one("t-kudy", "typos", "куди далі повертати", info()),
  one("t-probky", "typos", "пробкы є?", info({ expectTools: ["get_traffic_ahead"] })),
  one("t-dodomu", "typos", "додмоу", proposes("set_destination", { expectTools: ["find_destination"] }), home),
  one("t-zapravka-ru", "typos", "заправкв по пути", find(FUEL)),
  one("t-supermarket", "typos", "супермаркт по дорогі", find(SHOP)),
  one("t-landmark", "typos", "які оріетири попереду", info({ expectTools: ["get_landmarks_ahead"] })),
  one("t-gps", "typos", "шо з джипиес", info()),
  one("t-kofe-ru", "typos", "кофе по дароге", find(COFFEE)),
  one("t-bez-platnyh", "typos", "без платнх доріг", { expectTools: ["set_route_preferences"] }),
  one("t-eda", "typos", "поесть гдето через 20 минт", find(FOOD, { expectCall: aheadWindowAround(20, 8) })),
  one("t-wog", "typos", "вог чи окко", find(FUEL, {}, /WOG|OKKO|ОККО|ВОГ/i)),
  one("t-alt", "typos", "альтернатвний маршут", info({ expectTools: ["compare_routes"] })),
  one("t-chas", "typos", "скільки часу щеее", info()),
];

const short: Scenario[] = [
  one("sh-kava", "short", "Кава.", find(COFFEE)),
  one("sh-zapravka", "short", "Заправка", find(FUEL)),
  one("sh-yisty", "short", "Їсти", find(FOOD)),
  one("sh-dalеko", "short", "Далеко?", info()),
  one("sh-koly", "short", "Коли?", info()),
  one("sh-probky", "short", "Пробки?", info({ expectTools: ["get_traffic_ahead"] })),
  one("sh-gps", "short", "GPS?", info()),
  one("sh-dodomu", "short", "Додому.", proposes("set_destination"), home),
  one("sh-parking", "short", "Парковка?", find(PARKING)),
  one("sh-kudy", "short", "Куди?", info()),
  one("sh-mak", "short", "Мак?", find(["fast_food"], {}, /McDonald|Макдон/i)),
  one("sh-toilet", "short", "Туалет", find(["toilets", "fuel", "cafe", "fast_food"])),
  one("sh-shvydshe", "short", "Швидше?", info({ expectAnyTool: ["compare_routes", "get_route_overview"] })),
  one("sh-oriientyry", "short", "Орієнтири", info({ expectTools: ["get_landmarks_ahead"] })),
  one("sh-eta", "short", "ETA", info()),
  one("sh-voda", "short", "Вода", find(["supermarket", "fuel"])),
  one("sh-thanks", "short", "Дякую!", info({ maxWords: 15 })),
  one("sh-ok", "short", "Ок", info({ maxWords: 15 })),
  one("sh-what", "short", "Що?", info({ maxWords: 40 })),
  one("sh-ru-benz", "short", "Бенз", find(FUEL)),
];

const long: Scenario[] = [
  one("l-fuel-coffee", "long", "Слухай, нам ще їхати хвилин сорок, бензину вистачить кілометрів на сорок, але я б хотів заправитися заздалегідь і заодно взяти каву, тільки щоб не з'їжджати далеко з траси, бо ми поспішаємо.", find(FUEL, { expectAnyTool: SEARCH, maxWords: 60 })),
  one("l-lunch-plan", "long", "Ми виїхали без обіду, діти голодні, знайди щось нормальне поїсти не пізніше ніж через пів години, бажано не фастфуд, і щоб заїзд був не довше десяти хвилин.", find(["restaurant"], { expectCall: detourAtMost(10), maxWords: 60 })),
  one("l-route-question", "long", "Поясни мені, будь ласка, чому ми їдемо саме цим маршрутом, а не якось інакше, і чи є сенс зараз щось змінювати, бо мені здається що можна швидше.", info({ expectAnyTool: ["compare_routes", "get_route_overview"], maxWords: 60 })),
  one("l-meeting", "long", "У мене зустріч о пів на третю в Борисполі, ми встигаємо чи треба щось робити з маршрутом?", info({ maxWords: 50 })),
  one("l-parking-walk", "long", "Коли доїдемо, мені треба буде залишити машину десь поруч, щоб пішки було не більше п'яти хвилин до місця, знайдеш?", find(PARKING)),
  one("l-gps-worry", "long", "Я чув, що тут часто глушать GPS, що ти будеш робити, якщо сигнал пропаде посеред дороги, і чи зможеш довезти мене до кінця?", info({ maxWords: 60 })),
  one("l-kids", "long", "Ми їдемо з дітьми, їм треба буде в туалет і перекусити, знайди місце десь по дорозі, де можна зробити і те, і те, без великого гаку.", info({ expectAnyTool: SEARCH, maxWords: 60 })),
  one("l-okko-only", "long", "Я заправляюсь тільки на ОККО, бо там у мене карта лояльності, тож знайди мені найближчу ОККО по маршруту, і скажи скільки часу це додасть.", find(FUEL, {}, /OKKO|ОККО/i)),
  one("l-evening", "long", "Ввечері я повертатимусь назад і хочу знати, де по дорозі можна буде повечеряти, щоб заклад працював і пізно ввечері.", info({ expectAnyTool: SEARCH })),
  one("l-avoid-all", "long", "Налаштуй маршрут так, щоб не було платних доріг і ґрунтовок, бо машина низька і я не хочу платити за проїзд.", { expectTools: ["set_route_preferences"], expectCall: { description: "avoid_tolls and avoid_unpaved", test: (c) => c.some((x) => x.tool === "set_route_preferences" && x.input.avoid_tolls === true && x.input.avoid_unpaved === true) } }),
  one("l-coffee-then", "long", "Спочатку хочу заїхати за кавою, а потім поїдемо додому, а не туди, куди зараз.", { expectAnyTool: ["add_stop", "set_destination"], expectPending: "add_stop+set_destination" }, home),
  one("l-compare-detail", "long", "Порівняй, будь ласка, поточний маршрут з альтернативами і скажи, яка різниця в часі та якими дорогами вони йдуть.", info({ expectTools: ["compare_routes"], maxWords: 70 })),
  one("l-range", "long", "Пального лишилось кілометрів на дванадцять, я боюсь не доїхати, що мені робити, знайди найближчу заправку до якої я точно дотягну.", find(FUEL, { expectCall: rangeGiven(15) })),
  one("l-landmark-turn", "long", "Я погано бачу таблички, підкажи по яких будівлях чи магазинах мені зрозуміти, де наступний поворот.", info({ expectTools: ["get_landmarks_ahead"] })),
  one("l-dinner-reservation", "long", "Забронюй мені столик у ресторані Козак на восьму вечора, будь ласка, і додай його як зупинку.", { expectPending: "add_stop", mustMatch: [/не можу|немає можливості|не вмію|не бронюю|бронюв/i] }),
];

const multiStep: Scenario[] = [
  dialog("m-mcd-10-add", "multi_step", "McDonald's within +10 min, then add", [
    { user: "Знайди McDonald's, щоб заїзд додав не більше 10 хвилин.", ...find(["fast_food"], { expectCall: detourAtMost(10) }, /McDonald|Макдон/i) },
    { user: "Добре, додай його.", expectAnyTool: ["add_stop"] },
  ]),
  one("m-rest-40-10", "multi_step", "Знайди хороший ресторан приблизно через 40 хвилин, щоб крюк був максимум 10 хвилин.", find(["restaurant"], { expectCall: both(aheadWindowAround(40, 10), detourAtMost(10)) })),
  one("m-fuel-range", "multi_step", "Бензину на 15 кілометрів, знайди заправку, до якої дотягну.", find(FUEL, { expectCall: rangeGiven(20), mustNotMatch: [/SOCAR/] })),
  one("m-coffee-home", "multi_step", "Заїдь спочатку за кавою, потім продовжимо додому.", { expectPending: "add_stop+set_destination", expectAnyTool: SEARCH }, home),
  one("m-rest-10-trip", "multi_step", "Знайди ресторан, який додасть максимум 10 хвилин до поїздки.", find(["restaurant"], { expectCall: detourAtMost(10) })),
  one("m-eat-30-near", "multi_step", "Хочу поїсти десь хвилин через 30, але не з'їжджати далеко з маршруту.", find(FOOD, { expectCall: aheadWindowAround(30, 8) })),
  dialog("m-alt-switch", "multi_step", "Compare then switch", [
    { user: "Порівняй маршрути.", ...info({ expectTools: ["compare_routes"] }) },
    { user: "Давай другий варіант.", expectAnyTool: ["switch_route"] },
  ]),
  one("m-fuel-and-coffee", "multi_step", "Знайди одне місце, де можна і заправитись, і випити кави.", info({ expectAnyTool: SEARCH })),
  one("m-parking-walk", "multi_step", "Знайди парковку біля кінцевої і скажи, скільки йти пішки.", find(PARKING, { mustMatch: [/хв|хвилин/] })),
  dialog("m-stop-then-eta", "multi_step", "Add stop then ask arrival", [
    { user: "Знайди Aroma Kava по дорозі.", ...find(COFFEE, {}, /Aroma/i) },
    { user: "Додай її.", expectAnyTool: ["add_stop"] },
    { user: "Так.", expectWaypoints: 1 },
    { user: "О котрій тепер будемо на місці?", ...info({ mustMatch: [/\d{1,2}[:.]\d{2}/] }) },
  ]),
  one("m-two-stops", "multi_step", "Додай зупинку на заправці ОККО і потім на McDonald's.", { expectPending: "add_stop+add_stop" }),
  one("m-closed-filter", "multi_step", "Знайди ресторан, який точно зараз працює, і не далі ніж 25 кілометрів.", find(["restaurant"], { mustNotMatch: [/Нічний Гриль/] })),
  one("m-detour-compare", "multi_step", "Що вийде швидше: ОККО чи WOG, враховуючи заїзд?", find(FUEL, {}, /OKKO|ОККО|WOG/i)),
  one("m-dest-then-parking", "multi_step", "Поїхали в аеропорт і одразу знайди там парковку.", { expectPending: "set_destination", expectTools: ["find_destination"] }),
  one("m-landmark-then-turn", "multi_step", "Бачу Фору зліва, а мені куди?", info({ expectTools: ["check_landmark"] })),
];

const reference: Scenario[] = [
  dialog("r-second-add", "reference", "second one → how much → add → remove", [
    { user: "Знайди заправку по дорозі.", ...find(FUEL) },
    { user: "Друга норм. Скільки втратимо?", ...info({ expectAnyTool: ["get_place_details", "search_along_route"] }) },
    { user: "Добре, додавай.", expectAnyTool: ["add_stop"] },
    { user: "Так.", expectWaypoints: 1 },
    { user: "Хоча ні, прибери її.", expectTools: ["remove_stop"], expectWaypoints: 0 },
  ]),
  dialog("r-not-this-next", "reference", "not this, the next", [
    { user: "Знайди каву по дорозі.", ...find(COFFEE) },
    { user: "Не цю, наступну.", ...info({ expectAnyTool: SEARCH.concat(["get_place_details"]) }) },
  ]),
  dialog("r-first-open", "reference", "is the first one open", [
    { user: "Ресторани по маршруту?", ...find(["restaurant"]) },
    { user: "А перший зараз відкритий?", ...info() },
  ]),
  dialog("r-which-side", "reference", "which side is it on", [
    { user: "Де найближча заправка?", ...find(FUEL) },
    { user: "З якого вона боку?", ...info() },
  ]),
  dialog("r-that-one-add", "reference", "add that one", [
    { user: "Знайди McDonald's.", ...find(["fast_food"], {}, /McDonald|Макдон/i) },
    { user: "Додай той, що ближче до дороги.", expectAnyTool: ["add_stop"] },
  ]),
  dialog("r-previous-list", "reference", "back to the previous list", [
    { user: "Знайди заправку.", ...find(FUEL) },
    { user: "А кава де?", ...find(COFFEE) },
    { user: "Повернімось до заправок — перша підійде.", expectAnyTool: ["add_stop", "get_place_details"] },
  ]),
  dialog("r-how-far-it", "reference", "how far is it", [
    { user: "Де там Пузата Хата по дорозі?", ...find(["restaurant"], {}, /Пузата/i) },
    { user: "А скільки до неї їхати?", ...info() },
  ]),
  dialog("r-undo-pref", "reference", "undo road preference", [
    { user: "Уникай платних доріг.", expectTools: ["set_route_preferences"] },
    { user: "Ні, поверни як було.", expectTools: ["set_route_preferences"] },
  ]),
  dialog("r-third", "reference", "the third one", [
    { user: "Покажи три заправки по дорозі.", ...find(FUEL) },
    { user: "Третя — скільки до неї?", ...info() },
  ]),
  dialog("r-both", "reference", "compare both", [
    { user: "Знайди дві кав'ярні по маршруту.", ...find(COFFEE) },
    { user: "Яка з них швидше по заїзду?", ...info() },
  ]),
  dialog("r-it-hours", "reference", "its hours", [
    { user: "Кава Кофі по дорозі є?", ...find(COFFEE, {}, /Кава Кофі|Kava/i) },
    { user: "До котрої вона працює?", ...info() },
  ]),
  dialog("r-yes-after-proposal", "reference", "yes after proposal", [
    { user: "Додай зупинку на найближчій заправці.", expectAnyTool: ["add_stop", "search_along_route"] },
    { user: "Так, давай.", expectWaypoints: 1 },
  ]),
  dialog("r-remove-last", "reference", "remove the stop just added", [
    { user: "Знайди каву по дорозі.", ...find(COFFEE) },
    { user: "Першу додай.", expectAnyTool: ["add_stop"] },
    { user: "Так.", expectWaypoints: 1 },
    { user: "Прибери зупинку.", expectTools: ["remove_stop"], expectWaypoints: 0 },
  ]),
  dialog("r-same-brand-further", "reference", "same brand further", [
    { user: "McDonald's десь по маршруту є?", ...find(["fast_food"], {}, /McDonald|Макдон/i) },
    { user: "А є ще один далі?", ...info({ expectAnyTool: SEARCH }) },
  ]),
  dialog("r-cheaper-detour", "reference", "less detour", [
    { user: "Ресторан по дорозі.", ...find(["restaurant"]) },
    { user: "А щось з меншим гаком?", ...info({ expectAnyTool: SEARCH }) },
  ]),
  dialog("r-go-there", "reference", "go there instead", [
    { user: "Знайди аеропорт Бориспіль.", expectTools: ["find_destination"] },
    { user: "Туди й поїхали.", expectPending: "set_destination" },
  ]),
  dialog("r-earlier-question", "reference", "what did you say before", [
    { user: "Скільки ще їхати?", ...info() },
    { user: "Повтори, скільки ти сказав?", ...info() },
  ]),
  dialog("r-it-parking", "reference", "parking near it", [
    { user: "Знайди ресторан Козак.", ...find(["restaurant"], {}, /Козак/i) },
    { user: "А біля нього можна припаркуватись?", expectAnyTool: ["search_near"] },
  ]),
  dialog("r-that-time", "reference", "time for that", [
    { user: "Знайди WOG.", ...find(FUEL, {}, /WOG|ВОГ/i) },
    { user: "Скільки часу займе заїзд туди?", ...info() },
  ]),
  dialog("r-ru-second", "reference", "ru second", [
    { user: "Найди кафе по пути.", ...find(COFFEE) },
    { user: "Второе подходит, сколько потеряем?", ...info({ expectLanguage: "ru" }) },
  ]),
];

const changeMind: Scenario[] = [
  dialog("c-no-after-propose", "change_mind", "no after proposal", [
    { user: "Постав зупинку на ОККО, будь ласка.", expectAnyTool: ["add_stop", "search_along_route"] },
    { user: "Ні, не треба.", expectPending: null, expectWaypoints: 0 },
  ]),
  dialog("c-other-instead", "change_mind", "the other one instead", [
    { user: "Знайди заправку.", ...find(FUEL) },
    { user: "Додай першу.", expectAnyTool: ["add_stop"] },
    { user: "Хоча ні, краще другу.", expectAnyTool: ["add_stop", "cancel_pending_action", "remove_stop"] },
  ]),
  dialog("c-cancel-dest", "change_mind", "cancel destination change", [
    { user: "Поїхали додому.", ...proposes("set_destination") },
    { user: "Стоп, скасуй, їдемо як їхали.", expectPending: null },
  ], home),
  dialog("c-new-request-instead", "change_mind", "new request instead of answering", [
    { user: "Додай зупинку на McDonald's.", expectAnyTool: ["add_stop", "search_along_route"] },
    { user: "А взагалі, знайди краще каву.", ...find(COFFEE) },
  ]),
  dialog("c-undo-avoid", "change_mind", "undo avoid", [
    { user: "Не їдь по трасах.", expectTools: ["set_route_preferences"] },
    { user: "Ні, це довго, поверни траси.", expectTools: ["set_route_preferences"] },
  ]),
  dialog("c-remove-stop", "change_mind", "remove stop after add", [
    { user: "Зроби зупинку в Aroma Kava.", expectAnyTool: ["add_stop", "search_along_route"] },
    { user: "Так.", expectWaypoints: 1 },
    { user: "Передумав, кава не потрібна.", expectTools: ["remove_stop"], expectWaypoints: 0 },
  ]),
  dialog("c-back-original", "change_mind", "back to original destination", [
    { user: "Поїхали в аеропорт.", ...proposes("set_destination") },
    { user: "Так.", expectPending: null },
    { user: "Ні, повертай на старий маршрут у Бориспіль-центр.", expectAnyTool: ["set_destination", "find_destination"] },
  ]),
  dialog("c-maybe-later", "change_mind", "maybe later", [
    { user: "Знайди ресторан по дорозі.", ...find(["restaurant"]) },
    { user: "Не зараз, може пізніше.", ...info() },
  ]),
  dialog("c-cheaper", "change_mind", "different constraint", [
    { user: "Знайди кафе з гаком до 10 хвилин.", ...find(COFFEE, { expectCall: detourAtMost(10) }) },
    { user: "Ні, максимум дві хвилини.", ...find(COFFEE, { expectCall: detourAtMost(2) }) },
  ]),
  dialog("c-restore-removed", "change_mind", "restore a removed stop without a second yes", [
    { user: "Додай зупинку на WOG.", expectAnyTool: ["add_stop", "search_along_route"] },
    { user: "Так.", expectWaypoints: 1 },
    { user: "Прибери WOG.", expectTools: ["remove_stop"], expectWaypoints: 0 },
    { user: "Ні, все-таки залиш WOG у маршруті.", expectAnyTool: ["add_stop"], expectWaypoints: 1 },
  ]),
  dialog("c-ru-cancel", "change_mind", "ru cancel", [
    { user: "Добавь остановку на заправке.", expectAnyTool: ["add_stop", "search_along_route"] },
    { user: "Отмена.", expectPending: null, expectWaypoints: 0 },
  ]),
];

const ambiguous: Scenario[] = [
  one("a-restaurant", "clarify", "Знайди ресторан.", { expectPending: null, forbidTools: ACTIONS }),
  one("a-go-there", "clarify", "Поїхали туди.", clarifies()),
  one("a-add-it", "clarify", "Додай це.", clarifies()),
  one("a-center", "clarify", "Відвези в центр.", { expectPending: null, forbidTools: ["add_stop", "switch_route"] }),
  one("a-stop", "clarify", "Зупинка.", { forbidTools: ACTIONS, expectPending: null }),
  one("a-remove", "clarify", "Прибери.", clarifies()),
  one("a-nearest", "clarify", "Найближча заправка.", find(FUEL, { asksClarification: false })),
  one("a-there", "clarify", "Скільки туди?", info()),
  one("a-change", "clarify", "Зміни маршрут.", { expectPending: null, forbidTools: ["add_stop", "set_destination", "reorder_stops"] }),
  one("a-something", "clarify", "Знайди щось.", clarifies()),
  one("a-he", "clarify", "А він відкритий?", clarifies()),
  one("a-brovary", "clarify", "Давай через Бровари.", { expectPending: null, forbidTools: ["add_stop", "switch_route"] }),
];

const noData: Scenario[] = [
  one("d-pharmacy", "no_results", "Є аптека по дорозі?", find(["pharmacy"], { mustMatch: [/немає|не знайш|не знайд|нема/i] })),
  one("d-hospital", "no_results", "Де найближча лікарня?", info({ expectAnyTool: SEARCH, mustMatch: [/немає|не знайш|не знайд|нема|103/i] })),
  one("d-ev", "no_results", "Зарядка для електромобіля по маршруту є?", find(["ev_charging"], { mustMatch: [/немає|не знайш|не знайд|нема/i] })),
  one("d-price", "no_results", "Скільки коштує бензин на ОККО?", info({ mustNotMatch: [/\d+[.,]\d+\s*(грн|₴)/], mustMatch: [/немає|не маю|не знаю|недоступ|ціни/i] })),
  one("d-rating", "no_results", "Який рейтинг у ресторану Козак?", info({ mustNotMatch: [/\d[.,]\d\s*(з|\/)\s*5|зір/i], mustMatch: [/рейтинг|оцін|відгук/i] })),
  one("d-weather", "no_results", "Яка погода в Борисполі?", info({ mustMatch: [/не маю|немає|недоступ|не знаю|не можу/i] })),
  one("d-traffic-live", "no_results", "Скільки хвилин стоїмо в пробці попереду?", info({ expectTools: ["get_traffic_ahead"], mustMatch: [/немає|не маю|недоступ/i] })),
  one("d-kfc", "no_results", "Знайди KFC по дорозі.", find(["fast_food"], {}, /KFC/i)),
  one("d-sushi", "no_results", "Суші по дорозі є?", find(["restaurant", "fast_food"])),
  one("d-toilets", "no_results", "Громадський туалет по дорозі?", find(["toilets"])),
  one("d-hotel-way", "no_results", "Готель по дорозі?", find(["hotel"])),
  one("d-bank", "no_results", "Банкомат Приватбанку по дорозі?", find(["atm"], {}, /Приват|Privat/i)),
  one("d-potholes", "no_results", "Де на маршруті ями на дорозі?", info({ mustMatch: [/немає|не маю|даних/i] })),
  one("d-police", "no_results", "Де стоять поліцейські радари?", info({ mustMatch: [/немає|не маю|даних|не можу/i] })),
  one("d-open-hours-unknown", "no_results", "До котрої працює Фора?", info({ expectAnyTool: SEARCH.concat(["get_place_details", "check_landmark"]) })),
];

const apiErrors: Scenario[] = [
  one("e-places-fail", "api_error", "Знайди заправку по дорозі.", info({ expectAnyTool: SEARCH, mustMatch: [/недоступн|не вдалося|помилк|не працює|зараз не можу/i] }), { places: "failing" }),
  one("e-places-none", "api_error", "Кава по дорозі?", info({ mustMatch: [/недоступн|немає|не можу/i] }), { places: "none" }),
  one("e-routing-fails-add", "api_error", "Хочу зупинитись на ОККО — додай у маршрут.", { expectWaypoints: 0, mustNotMatch: [/додала|додав зупинку/i] }, { routingFails: true }),
  one("e-routing-fails-alt", "api_error", "Є швидший маршрут?", info({ expectTools: ["compare_routes"], mustMatch: [/не вдалося|недоступн|помилк|не можу/i] }), { routingFails: true }),
  one("e-offline-search", "api_error", "Знайди ресторан по дорозі.", info({ mustMatch: [/недоступн|немає|інтернет|мереж|не можу/i] }), { network: false, places: "none" }),
  one("e-no-route-search", "api_error", "Кава по дорозі?", info({ mustMatch: [/маршрут/i] }), { noRoute: true }),
  one("e-no-route-eta", "api_error", "Скільки ще їхати?", info({ mustMatch: [/маршрут|не прокладен|немає/i] }), { noRoute: true }),
  one("e-no-home", "api_error", "Додому.", { expectPending: null, mustMatch: [/адрес|не збережен|немає/i] }),
  one("e-routing-fails-dest", "api_error", "Поїхали в аеропорт.", { mustNotMatch: [/побудувала маршрут/i] }, { routingFails: true }),
  one("e-places-empty", "api_error", "Знайди McDonald's.", info({ mustMatch: [/не знайш|не знайд|немає|нема/i] }), { places: "empty" }),
];

const routeChange: Scenario[] = [
  one("rc-avoid-tolls", "route_change", "Уникай платних доріг.", { expectTools: ["set_route_preferences"] }),
  one("rc-avoid-highways", "route_change", "Без автомагістралей, будь ласка.", { expectTools: ["set_route_preferences"] }),
  one("rc-allow-back", "route_change", "Можна знову по трасах.", { expectTools: ["set_route_preferences"] }),
  one("rc-work", "route_change", "Поїхали на роботу.", { expectAnyTool: ["find_destination"], expectPending: null }),
  one("rc-brovary", "route_change", "Змінимо ціль: центр Броварів.", proposes("set_destination", { expectTools: ["find_destination"] })),
  one("rc-reorder", "route_change", "Спочатку WOG, потім ОККО — поміняй порядок зупинок.", { expectPending: null }),
  one("rc-switch-fastest", "route_change", "Переведи на найшвидший маршрут.", { expectTools: ["compare_routes"] }),
  one("rc-keep-stops", "route_change", "Поїхали в аеропорт, але заправку залиш у маршруті.", proposes("set_destination")),
  one("rc-add-home-stop", "route_change", "Додай дім як проміжну зупинку.", { expectPending: null, forbidTools: ["set_destination"] }, home),
  one("rc-bad-roads", "route_change", "Об'їжджай ґрунтовки.", { expectTools: ["set_route_preferences"] }),
];

const prefs = () => ({ preferences: new PreferenceStore() });
const preferences: Scenario[] = [
  one("pr-okko-always", "preferences", "Запам'ятай: я завжди заправляюсь тільки на ОККО.", { expectTools: ["remember_preference"], expectPreferenceKeys: ["preferred_fuel_brands"] }, prefs()),
  one("pr-no-tolls", "preferences", "Я ніколи не їжджу платними дорогами, врахуй на майбутнє.", { expectTools: ["remember_preference"], expectPreferenceKeys: ["avoid_tolls"] }, prefs()),
  one("pr-veg", "preferences", "Я вегетаріанець, запам'ятай.", { expectTools: ["remember_preference"], expectPreferenceKeys: ["dietary"] }, prefs()),
  one("pr-detour", "preferences", "Надалі пропонуй тільки те, що додає до 5 хвилин.", { expectTools: ["remember_preference"], expectPreferenceKeys: ["max_detour_minutes"] }, prefs()),
  one("pr-quiet", "preferences", "Не відволікай мене пропозиціями, тільки якщо щось важливе.", { expectTools: ["remember_preference"], expectPreferenceKeys: ["proactive_suggestions"] }, prefs()),
  one("pr-one-off", "preferences", "Знайди ОККО по дорозі.", { ...find(FUEL, {}, /OKKO|ОККО/i), forbidTools: ["remember_preference"] }, prefs()),
  dialog("pr-use-it", "preferences", "saved brand preference is used", [
    { user: "Запам'ятай, що я заправляюсь на WOG.", expectTools: ["remember_preference"] },
    { user: "Знайди заправку.", ...find(FUEL), mustMatch: [/WOG/] },
  ], prefs()),
  dialog("pr-forget", "preferences", "forget a preference", [
    { user: "Запам'ятай: максимум 5 хвилин на заїзд.", expectTools: ["remember_preference"] },
    { user: "Забудь про обмеження заїзду.", expectTools: ["forget_preference"] },
  ], prefs()),
];

const reminders: Scenario[] = [
  one("rm-coffee-30", "reminder", "Нагадай про каву за пів години.", { expectTools: ["set_reminder"], expectReminders: 1, expectPending: null }),
  one("rm-stop-hour", "reminder", "Через годину треба зупинитись відпочити, нагадай.", { expectTools: ["set_reminder"], expectReminders: 1 }),
  one("rm-fuel-50km", "reminder", "Нагадай заправитися кілометрів через 20.", { expectTools: ["set_reminder"], expectReminders: 1 }),
  dialog("rm-cancel", "reminder", "cancel reminder", [
    { user: "Нагадай про каву через 15 хвилин.", expectTools: ["set_reminder"] },
    { user: "Скасуй нагадування.", expectTools: ["cancel_reminder"], expectReminders: 0 },
  ]),
  one("rm-ru", "reminder", "Напомни через 10 минут позвонить маме.", { expectTools: ["set_reminder"], expectLanguage: "ru" }),
  one("rm-vague", "reminder", "Нагадай мені потім.", { expectReminders: 0, asksClarification: true }),
];

const gps: Scenario[] = [
  one("g-what-gps", "gps", "Що робити без GPS?", info()),
  one("g-low-next", "gps", "Скільки до повороту?", info({ mustNotMatch: [/через \d+ метр/] }), { band: "LOW", gnss: "LOST" }),
  one("g-where-low", "gps", "Де ми зараз?", info({ mustMatch: [/неточн|невідом|не можу точно|приблизно|GPS/i] }), { band: "UNKNOWN", gnss: "LOST" }),
  one("g-lost-status", "gps", "GPS пропав, ти мене доведеш?", info(), { band: "LOW", gnss: "LOST" }),
  one("g-normal-status", "gps", "Як там з GPS?", info()),
  one("g-jam-worry", "gps", "Кажуть тут глушать GPS, що будеш робити?", info()),
  one("g-search-low", "gps", "Кава по дорозі?", find(COFFEE), { band: "LOW", gnss: "DEGRADED" }),
  one("g-spoof-question", "gps", "Мені здається GPS бреше, я не там де показує.", info()),
];

const unexpected: Scenario[] = [
  one("u-joke", "unexpected", "Розкажи анекдот.", info({ maxWords: 60 })),
  one("u-music", "unexpected", "Увімкни музику.", info({ mustMatch: [/не можу|не вмію|немає|недоступ/i] })),
  one("u-call", "unexpected", "Подзвони дружині.", info({ mustMatch: [/не можу|не вмію|немає|недоступ/i] })),
  one("u-who", "unexpected", "Хто ти?", info({ maxWords: 40 })),
  one("u-alert", "unexpected", "Зараз тривога, куди мені їхати, щоб було безпечно?", info({ mustNotMatch: [/безпечн(ий|о) маршрут|тут безпечно/i] })),
  one("u-politics", "unexpected", "Що думаєш про вибори?", info({ maxWords: 40 })),
  one("u-translate", "unexpected", "Як англійською буде «заправка»?", info({ maxWords: 30 })),
  one("u-speed-limit", "unexpected", "Яке тут обмеження швидкості?", info({ mustMatch: [/не маю|немає|даних|не знаю/i] })),
  one("u-math", "unexpected", "Скільки буде 17 на 23?", info({ maxWords: 30 })),
  one("u-sms", "unexpected", "Напиши СМС шефу, що я запізнюсь.", info({ mustMatch: [/не можу|не вмію|немає|недоступ/i] })),
  one("u-fast-drive", "unexpected", "Як доїхати швидше, якщо гнати 150?", info({ mustNotMatch: [/гоніть|їдьте 150/i] })),
  one("u-accident", "unexpected", "Тут аварія попереду!", info({ maxWords: 50 })),
];

const language: Scenario[] = [
  one("lg-en-coffee", "language", "Where can I get coffee on the way?", find(COFFEE, { expectLanguage: "en" })),
  one("lg-en-eta", "language", "How long until we arrive?", info({ expectLanguage: "en" })),
  one("lg-ru-fuel", "language", "Найди заправку по дороге.", find(FUEL, { expectLanguage: "ru" })),
  one("lg-ru-eta", "language", "Сколько ещё ехать?", info({ expectLanguage: "ru" })),
  one("lg-uk-default", "language", "Кава?", find(COFFEE, { expectLanguage: "uk" })),
  one("lg-en-parking", "language", "Find parking near the destination.", find(PARKING, { expectLanguage: "en" })),
];

const longDialog: Scenario[] = [
  dialog("ld-trip", "long_dialog", "a long trip conversation", [
    { user: "Скільки ще їхати?", ...info() },
    { user: "Знайди каву по дорозі.", ...find(COFFEE) },
    { user: "Першу додай.", expectAnyTool: ["add_stop"] },
    { user: "Так.", expectWaypoints: 1 },
    { user: "А тепер коли будемо на місці?", ...info() },
    { user: "І парковку біля кінцевої знайди.", ...find(PARKING) },
    { user: "Дякую.", ...info({ maxWords: 20 }) },
  ]),
  dialog("ld-switch-topics", "long_dialog", "topic switches keep context", [
    { user: "Знайди заправку.", ...find(FUEL) },
    { user: "Що там з пробками?", ...info({ expectTools: ["get_traffic_ahead"] }) },
    { user: "Ок, друга заправка — скільки до неї?", ...info() },
  ]),
];

export const DEV_SUITE: Scenario[] = [
  ...normal, ...paraphrase, ...slang, ...typos, ...short, ...long, ...multiStep, ...reference,
  ...changeMind, ...ambiguous, ...noData, ...apiErrors, ...routeChange, ...preferences, ...reminders, ...gps, ...unexpected, ...language, ...longDialog,
];
