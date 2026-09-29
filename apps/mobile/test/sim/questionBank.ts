// "Navigator simulator" question bank (programme part 5.1 b): for each of the
// 11 categories, base phrasings a driver may say (Ukrainian, Russian,
// surzhyk, English), each with the intents that correctly answer it. The
// variant generator turns every base into forms: as typed, no punctuation,
// fillers, emotion, typos, mixed uk/ru words, speech-to-text noise, cut off —
// 40–60 distinct texts per category. Deterministic (seeded).
//
// These phrasings are a TRAINING/regression set: failures here are used to
// improve the classifier. The honest estimate on unseen wording comes from
// the hold-out sets (test/navigatorHoldout*.test.ts, test/support/holdoutC.ts).

export type SimCategory = { key: string; letter: string; name: string; bases: [text: string, accept: string[]][] };

export const SIM_CATEGORIES: SimCategory[] = [
  { key: "signal_status", letter: "А", name: "Статус сигналу", bases: [
    ["Який зараз сигнал?", ["gpsStatus"]], ["Что с GPS сейчас?", ["gpsStatus"]], ["Як там супутники ловлять?", ["gpsStatus"]],
    ["Ти взагалі знаєш, де я?", ["confidence", "whereAmI"]], ["Ты вообще понимаешь где я?", ["confidence", "whereAmI"]],
    ["Чому карта смикається?", ["gpsStatus", "signalLost"]], ["Почему точка дёргается на карте?", ["gpsStatus", "signalLost"]],
    ["Наскільки точна моя позиція?", ["confidence", "gpsStatus"]], ["Насколько ты уверен в моём местоположении?", ["confidence"]],
    ["Is the GPS signal good?", ["gpsStatus"]], ["How sure are you where I am?", ["confidence"]],
    ["Джипіес нормально працює?", ["gpsStatus"]], ["Яка точність геолокації?", ["gpsStatus", "confidence"]],
  ] },
  { key: "signal_loss", letter: "Б", name: "Втрата / погіршення сигналу", bases: [
    ["Пропав сигнал, що робити?", ["signalLost"]], ["Сигнал пропал, что делать?", ["signalLost"]], ["GPS зник, як їхати?", ["signalLost"]],
    ["А якщо сигнал зовсім пропаде надовго?", ["signalLost"]], ["А если связь со спутниками пропадёт надолго?", ["signalLost"]],
    ["Сигнал поганий, але ще є", ["signalLost", "gpsStatus"]], ["Сигнал слабый но пока есть", ["signalLost", "gpsStatus"]],
    ["Глушать GPS, веди мене", ["signalLost"]], ["РЭБ работает, навигация пропала", ["signalLost"]],
    ["Lost GPS, what should I do?", ["signalLost"]], ["What if the signal is gone for a long time?", ["signalLost"]],
    ["Навігатор втратив супутники", ["signalLost"]], ["Телефон не бачить GPS, що далі?", ["signalLost"]],
  ] },
  { key: "route", letter: "В", name: "Маршрут і рух", bases: [
    ["Куди далі?", ["routeNext"]], ["Куда поворачивать дальше?", ["routeNext"]], ["Через скільки поворот?", ["routeNext"]],
    ["Далеко ще?", ["eta"]], ["Сколько ещё ехать?", ["eta"]], ["Коли будемо на місці?", ["eta"]], ["Скільки кілометрів лишилось?", ["eta"]],
    ["Чому ти мене ведеш цією дорогою?", ["routeWhy"]], ["Почему маршрут именно такой?", ["routeWhy"]], ["Це найшвидший шлях?", ["routeWhy"]],
    ["What's the next turn?", ["routeNext"]], ["How long until we arrive?", ["eta"]], ["Why this route?", ["routeWhy"]],
    ["Я правильно їду?", ["onRoute", "reroute"]],
  ] },
  { key: "safety", letter: "Г", name: "Безпека і тривога", bases: [
    ["Тривога, що робити?", ["shelter", "alert", "status"]], ["Тревога, куда бежать?", ["shelter", "alert"]], ["Де найближче укриття?", ["shelter"]],
    ["Где ближайшее бомбоубежище?", ["shelter"]], ["Це точно найближче укриття?", ["shelterWhy"]], ["Это точно самое близкое укрытие?", ["shelterWhy"]],
    ["А ближчого укриття немає?", ["shelterWhy", "shelter"]], ["Є зараз тривога?", ["alert", "status"]], ["Воздушная тревога объявлена?", ["alert", "status"]],
    ["Where is the nearest shelter?", ["shelter"]], ["Is there an air alert now?", ["alert", "status"]], ["Куди ховатися від обстрілу?", ["shelter"]],
    ["Чи безпечно зараз їхати?", ["alert", "status"]],
  ] },
  { key: "off_route", letter: "Д", name: "Відхилення від маршруту", bases: [
    ["Я збився з дороги?", ["reroute", "onRoute"]], ["Я сбился с пути?", ["reroute", "onRoute"]], ["Здається, я не туди повернув", ["reroute"]],
    ["Кажется, я свернул не туда", ["reroute"]], ["Я пропустив поворот", ["reroute"]], ["Я проехал свой поворот", ["reroute"]],
    ["Перебудуй маршрут", ["reroute"]], ["Перестрой дорогу", ["reroute"]], ["Did I miss the turn?", ["reroute", "onRoute"]],
    ["Am I still on the route?", ["onRoute", "reroute"]], ["Я з'їхав з маршруту", ["reroute"]], ["Ми не туди їдемо?", ["onRoute", "reroute"]],
  ] },
  { key: "meta", letter: "Е", name: "Мета-питання", bases: [
    ["Чому ти так відповів?", ["explain"]], ["Почему ты так ответил?", ["explain"]], ["Звідки ти це знаєш?", ["explain"]],
    ["Откуда такие данные?", ["explain"]], ["На основі чого така відповідь?", ["explain"]], ["Why did you say that?", ["explain"]],
    ["Повтори", ["repeat"]], ["Повтори ще раз", ["repeat"]], ["Повтори пожалуйста", ["repeat"]], ["Не розчув", ["repeat"]],
    ["Say that again", ["repeat"]], ["Що ти сказав?", ["repeat"]],
  ] },
  { key: "no_data", letter: "Ж", name: "Питання без даних", bases: [
    ["Яка зараз пробка на дорозі?", ["noData"]], ["Какие пробки впереди?", ["noData"]], ["Є затор на мосту?", ["noData"]],
    ["Яка погода буде ввечері?", ["noData"]], ["Будет ли дождь?", ["noData"]], ["Де камери контролю швидкості?", ["noData"]],
    ["Есть ли ДТП на трассе?", ["noData"]], ["Дорогу перекрили?", ["noData"]], ["Is there traffic ahead?", ["noData"]],
    ["What's the weather like?", ["noData"]], ["Ожеледиця на трасі є?", ["noData"]], ["Блокпост попереду є?", ["noData"]],
  ] },
  { key: "emotion", letter: "З", name: "Емоції і криза", bases: [
    ["Мені страшно, що робити", ["emotion"]], ["Мне страшно", ["emotion"]], ["Я боюся", ["emotion"]], ["Я панікую", ["emotion"]],
    ["У меня паника", ["emotion"]], ["Руки трусяться, не можу їхати", ["emotion"]], ["Мне очень страшно, помоги", ["emotion"]],
    ["I'm scared", ["emotion"]], ["I'm panicking, what do I do", ["emotion"]], ["Мені лячно", ["emotion"]],
    ["Боюсь ехать дальше", ["emotion"]], ["Я дуже нервую", ["emotion"]],
  ] },
  { key: "offline", letter: "И", name: "Офлайн", bases: [
    ["Немає інтернету, що тепер?", ["offline"]], ["Нет интернета, что теперь", ["offline"]], ["Інтернет пропав, карта буде працювати?", ["offline"]],
    ["Без интернета навигация работает?", ["offline"]], ["Зник мобільний інтернет", ["offline"]], ["Нет связи с интернетом", ["offline"]],
    ["No internet, will the map work?", ["offline"]], ["Offline mode — what works?", ["offline"]], ["Мережі немає, маршрут збережено?", ["offline"]],
    ["Чи працює NAVIA без інтернету?", ["offline"]], ["Інтернету нема, що робити?", ["offline"]], ["Wi-Fi пропал, что с картой?", ["offline"]],
  ] },
  { key: "other", letter: "К", name: "Інше (чесна відмова)", bases: [
    ["Розкажи анекдот", ["noData", "unknown"]], ["Хто виграв футбол?", ["noData", "unknown"]], ["Скільки буде два плюс два?", ["unknown", "noData"]],
    ["Напиши вірш", ["unknown", "noData"]], ["Какой курс доллара?", ["noData", "unknown"]], ["Кто президент Франции?", ["unknown", "noData"]],
    ["Сколько тебе лет?", ["unknown", "noData", "smalltalk"]], ["Порадь фільм", ["unknown", "noData"]], ["Tell me a joke", ["noData", "unknown"]],
    ["What's the capital of Spain?", ["unknown", "noData"]], ["Заказати піцу", ["unknown", "noData"]], ["Включи музику", ["noData", "unknown"]],
  ] },
  { key: "places", letter: "Л", name: "Місця поруч", bases: [
    ["Де найближча аптека?", ["place"]], ["Где заправка рядом?", ["place"]], ["Треба заправитися", ["place"]], ["Де банкомат?", ["place"]],
    ["Де пункт незламності?", ["place"]], ["Где поесть поблизости?", ["place"]], ["Де лікарня?", ["place"]], ["Магазин поруч є?", ["place"]],
    ["Nearest pharmacy?", ["place"]], ["Where can I charge the car?", ["place"]], ["Де купити воду?", ["place"]], ["Где погреться и зарядить телефон?", ["place"]],
  ] },
];

function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
}

const FILLERS = ["слухай, ", "скажи, ", "ну ", "короче, ", "бро, ", "слушай, ", "підкажи, ", "эй, ", "так, "];
const EMO = [["блін, ", ""], ["швидко, ", "!!"], ["", " терміново"], ["да блин, ", ""], ["", "?!"], ["ой, ", ""]];
const LETTERS = "абвгдежзиклмнопрстуфхцчшіоуеяю";
// uk ↔ ru everyday word swaps (mixed speech)
const MIX: [RegExp, string][] = [[/\bщо\b/g, "шо"], [/\bчто\b/g, "шо"], [/\bзараз\b/g, "щас"], [/\bсейчас\b/g, "щас"], [/\bде\b/g, "где"], [/\bгде\b/g, "де"], [/\bтепер\b/g, "теперь"], [/\bробити\b/g, "делать"], [/\bделать\b/g, "робити"], [/\bдалі\b/g, "дальше"], [/\bдальше\b/g, "далі"], [/\bнемає\b/g, "нет"], [/\bнет\b/g, "нема"], [/\bскільки\b/g, "скока"], [/\bсколько\b/g, "скоко"], [/\bмені\b/g, "мне"], [/\bмне\b/g, "мені"]];
// speech-to-text noise: merged words, lost endings, homophones
const STT: [RegExp, string][] = [[/\bце\b/g, "те"], [/\bне\s/g, "не"], [/\bщо\b/g, "шо"], [/ться\b/g, "ця"], [/ться\b/g, "тся"], [/\bчи\b/g, "чі"], [/gps/gi, "джипіес"], [/\bи\b/g, "і"], [/ий\b/g, "і"]];

function typo(text: string, r: () => number): string {
  const words = text.split(" ");
  const idx = words.map((w, i) => (w.replace(/[^\p{L}]/gu, "").length >= 6 ? i : -1)).filter((i) => i >= 0);
  if (idx.length === 0) return text;
  const wi = idx[Math.floor(r() * idx.length)]!;
  const w = words[wi]!;
  const p = 1 + Math.floor(r() * (w.length - 2));
  const op = Math.floor(r() * 3);
  words[wi] = op === 0 ? w.slice(0, p) + w.slice(p + 1) : op === 1 ? w.slice(0, p) + w[p + 1] + w[p] + w.slice(p + 2) : w.slice(0, p) + LETTERS[Math.floor(r() * LETTERS.length)] + w.slice(p + 1);
  return words.join(" ");
}

export type SimQuestion = { category: SimCategory; text: string; form: string; accept: string[] };

/** 40–60 distinct texts per category (programme 5.1 b). */
export function simQuestions(): SimQuestion[] {
  const out: SimQuestion[] = [];
  let seed = 101;
  for (const category of SIM_CATEGORIES) {
    const seen = new Set<string>();
    const add = (text: string, form: string, accept: string[]) => {
      const t = text.replace(/\s+/g, " ").trim();
      const key = t.toLowerCase();
      if (!t || seen.has(key) || seen.size >= 60) return;
      seen.add(key);
      out.push({ category, text: t, form, accept });
    };
    // Round-robin over the forms so every base gets several.
    const forms: ((b: string, r: () => number) => [string, string])[] = [
      (b) => [b, "як є"],
      (b) => [b.toLowerCase().replace(/[?!.,—]/g, ""), "без розділових"],
      (b, r) => [FILLERS[Math.floor(r() * FILLERS.length)] + b.toLowerCase(), "розмовне"],
      (b, r) => { const [p, s] = EMO[Math.floor(r() * EMO.length)]!; return [`${p}${b.toLowerCase().replace(/[?!.]$/, "")}${s}`, "емоція"]; },
      (b, r) => [typo(b, r), "опечатка"],
      (b) => [MIX.reduce((t, [re, to]) => t.replace(re, to), b.toLowerCase()), "суржик"],
      (b, r) => [typo(STT.reduce((t, [re, to]) => t.replace(re, to), b.toLowerCase().replace(/[?!.,—]/g, "")), r), "голос (шум)"],
      (b) => { const w = b.replace(/[?!.,]/g, "").split(" "); return [w.length >= 3 ? w.slice(0, -1).join(" ") : b, "обірване"]; },
    ];
    for (let round = 0; round < forms.length && seen.size < 60; round++) {
      for (const [base, accept] of category.bases) {
        const r = rng(seed++);
        const [text, form] = forms[round]!(base, r);
        add(text, form, accept);
      }
    }
  }
  return out;
}
