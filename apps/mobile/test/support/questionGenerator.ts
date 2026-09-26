// Question generator for the navigator mass test. It only invents HOW a
// driver may ask (wording, slang, surzhyk, typos, emotions, cut-off
// phrases) — never what the right answer is. The answer is judged against
// the engine snapshot by the test.
// Deterministic (seeded), so a failure is reproducible.

export type Category = {
  key: string;
  name: string;
  /** Intents that answer this need correctly. */
  accept: string[];
  base: string[];
};

export const CATEGORIES: Category[] = [
  { key: "signal_lost", name: "Сигнал зник — що робити", accept: ["signalLost"], base: [
    "Що робити, пропав сигнал?", "Сигнал зник, що тепер?", "глушать gps що робити", "gps пропав", "нема сигналу", "що робити без GPS", "пропал сигнал что делать", "gps не работает", "джипиес сдох", "сигнал відвалився", "нет сигнала gps", "втратили сигнал, як їхати далі", "реб глушить, що робити?", "no gps what now", "gps lost", "не ловить gps", "сигнал GPS втрачено?", "спутники пропали", "навігація не бачить супутників", "gps не працює, куди їхати",
  ] },
  { key: "signal_if", name: "А якщо сигнал зникне", accept: ["signalLost"], base: [
    "а якщо сигнал зникне?", "а если сигнал совсем пропадёт?", "що буде якщо gps пропаде", "что будет если пропадет gps", "якщо глушитимуть, ти поведеш?", "а если глушить начнут?", "what if gps drops", "а раптом сигнал пропаде", "коли сигнал зникне, що робити", "если gps отвалится что делать",
  ] },
  { key: "gps_status", name: "Стан GPS", accept: ["gpsStatus", "signalLost"], base: [
    "Що з GPS?", "як сигнал?", "что с gps", "какая точность", "яка точність gps", "gps працює?", "gps нормальный?", "стан gps", "статус gps", "сигнал стабільний?", "як там супутники", "is gps ok", "gps accuracy", "що з сигналом", "как сигнал спутников",
  ] },
  { key: "next_turn", name: "Наступний маневр", accept: ["routeNext"], base: [
    "Куди далі?", "що далі", "шо дальше", "куда дальше", "куди повертати?", "куда поворачивать", "наступний поворот?", "следующий поворот где", "де поворот", "куди мені зараз", "куда мне сейчас ехать", "what's next", "next turn?", "куди звертати", "где сворачивать",
  ] },
  { key: "turn_distance", name: "Скільки до повороту", accept: ["routeNext"], base: [
    "Через скільки поворот?", "скільки до повороту", "сколько до поворота", "через сколько поворот", "коли поворот?", "когда поворачивать", "далеко до повороту?", "поворот скоро?", "how far to the turn", "скоро повертати?",
  ] },
  { key: "eta", name: "Скільки лишилось / коли приїдемо", accept: ["eta"], base: [
    "Коли приїдемо?", "далеко ще?", "далеко ещё?", "скільки лишилось", "сколько осталось ехать", "скільки їхати", "когда будем на месте", "скільки кілометрів лишилось", "сколько км осталось", "how long", "how far is it", "довго ще?", "долго еще ехать", "о котрій будемо", "во сколько приедем",
  ] },
  { key: "on_route", name: "Чи правильно їду", accept: ["onRoute", "reroute"], base: [
    "Я правильно їду?", "я на правильній дорозі?", "правильно еду?", "я туди їду?", "я туда еду?", "ми не збилися?", "мы не сбились?", "am i on track", "right way?", "я по маршруту еду?", "я на маршруті?", "верно еду?",
  ] },
  { key: "off_route", name: "Звернув не туди", accept: ["reroute"], base: [
    "Здається, я звернув не туди", "я свернул не туда", "я пропустив поворот", "пропустил поворот", "перебудуй маршрут", "перестрой маршрут", "я збився з маршруту", "я сбился", "wrong turn", "missed the turn", "я з'їхав з маршруту", "проехал поворот что делать",
  ] },
  { key: "off_route_if", name: "А якщо зіб'юсь", accept: ["reroute"], base: [
    "а если я собьюсь с пути, что будет?", "а якщо я зіб'юсь з маршруту?", "що буде якщо я заблукаю", "что будет если я заблужусь", "а якщо звернути не туди", "если я пропущу поворот что будет", "what if i take a wrong turn", "а если я съеду с маршрута",
  ] },
  { key: "where", name: "Де я", accept: ["whereAmI"], base: [
    "Де я?", "где я", "де я зараз?", "где мы сейчас", "на якій я вулиці", "на какой улице я", "where am i", "я заблукав", "я заблудился", "моя позиція?", "де ми знаходимось", "мои координаты",
  ] },
  { key: "shelter", name: "Укриття", accept: ["shelter"], base: [
    "Де найближче укриття?", "куди ховатися?", "где укрытие", "де сховатися", "куда прятаться", "найближче укриття", "бомбосховище рядом?", "де метро щоб сховатись", "where to hide", "nearest shelter", "укриття поруч є?", "куди бігти?",
  ] },
  { key: "alert", name: "Тривога", accept: ["alert", "status"], base: [
    "Що з тривогою?", "тривога є?", "тревога есть?", "є тривога зараз?", "сирена?", "шахеди летять?", "ракети є?", "air alert?", "чи безпечно зараз?", "тревогу объявили?", "відбій тривоги був?",
  ] },
  { key: "status", name: "Загальна обстановка", accept: ["status"], base: [
    "Статус", "що відбувається?", "что вообще происходит?", "яка обстановка", "какая ситуация", "шо там", "все нормально?", "як ми?", "дай звіт", "что там вообще", "situation report", "що взагалі коїться",
  ] },
  { key: "repeat", name: "Повтори", accept: ["repeat"], base: [
    "повтори", "повтори будь ласка", "ще раз", "еще раз", "не розчув", "не расслышал", "що?", "шо?", "repeat", "say again",
  ] },
  { key: "explain", name: "Чому ти так відповів", accept: ["explain"], base: [
    "почему ты сейчас так ответил?", "чому ти так відповів?", "звідки ти знаєш?", "откуда ты знаешь", "на основі чого відповідь?", "поясни чому так", "why did you say that", "з чого ти взяв?",
  ] },
  { key: "traffic", name: "Пробки (даних немає)", accept: ["noData"], base: [
    "які пробки попереду?", "какие пробки впереди?", "є затори?", "пробка на мосту?", "traffic ahead?", "там корок?", "какой трафик", "дтп на трасі є?", "перекрили дорогу?", "блокпост попереду?",
  ] },
  { key: "weather", name: "Погода (даних немає)", accept: ["noData"], base: [
    "яка погода в Борисполі?", "какая погода", "буде дощ?", "дождь будет?", "ожеледиця на дорозі?", "гололед есть?", "weather?", "туман на трасі?", "яка температура",
  ] },
  { key: "smalltalk", name: "Розмова", accept: ["smalltalk"], base: [
    "як справи?", "как дела", "дякую", "спасибо", "ок", "понял", "зрозумів", "привіт", "привет", "ти хто?", "who are you", "thanks",
  ] },
  { key: "places", name: "Місця поруч", accept: ["place"], base: [
    "де аптека?", "где заправка", "найближча АЗС", "пункт незламності поруч?", "де зарядити телефон", "где банкомат", "треба ліки", "где поесть", "де магазин", "fuel station nearby",
  ] },
  { key: "emergency", name: "Екстрене", accept: ["emergency"], base: [
    "людина поранена", "потрібна швидка", "нужна скорая", "кровотеча, що робити", "авария, есть раненые", "допоможіть, людині погано", "sos",
  ] },
];

function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
}

export type Variant = { text: string; kind: string };

const FILLERS = ["слухай, ", "скажи, ", "ну ", "короче ", "бро, ", "слушай, ", "підкажи, "];
const PANIC = [["швидко! ", "!!!"], ["срочно, ", "?!"], ["допоможи! ", ""], ["", " терміново"]];
const ANGRY = [["блін, ", ""], ["да блин, ", ""], ["", ", ну скільки можна"], ["ну ", " вже"]];
const CALM = [["підкажи будь ласка, ", ""], ["скажи пожалуйста, ", ""], ["", ", дякую"]];
const LETTERS = "абвгдежзиклмнопрстуфхцчшіоуеяю";

function typo(text: string, r: () => number): string {
  const words = text.split(" ");
  const idx = words.map((w, i) => (w.replace(/[^\p{L}]/gu, "").length >= 6 ? i : -1)).filter((i) => i >= 0);
  if (idx.length === 0) return text;
  const wi = idx[Math.floor(r() * idx.length)]!;
  const w = words[wi]!;
  const p = 1 + Math.floor(r() * (w.length - 2));
  const op = Math.floor(r() * 3);
  words[wi] = op === 0 ? w.slice(0, p) + w.slice(p + 1) // drop a letter
    : op === 1 ? w.slice(0, p) + w[p + 1] + w[p] + w.slice(p + 2) // swap two
      : w.slice(0, p) + LETTERS[Math.floor(r() * LETTERS.length)] + w.slice(p + 1); // wrong letter
  return words.join(" ");
}

/** Every base phrasing in 9 forms: as is, plain, filler, panic, angry, calm, typo, typo+plain, cut off. */
export function variants(base: string, seed: number): Variant[] {
  const r = rng(seed);
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)]!;
  const plain = base.toLowerCase().replace(/[?!.,]/g, "").trim();
  const [pp, ps] = pick(PANIC), [ap, as] = pick(ANGRY), [cp, cs] = pick(CALM);
  const out: Variant[] = [
    { text: base, kind: "як є" },
    { text: plain, kind: "без розділових" },
    { text: pick(FILLERS) + plain, kind: "розмовне" },
    { text: `${pp}${plain}${ps}`, kind: "паніка" },
    { text: `${ap}${plain}${as}`, kind: "роздратування" },
    { text: `${cp}${plain}${cs}`, kind: "спокійно" },
    { text: typo(base, r), kind: "опечатка" },
    { text: typo(plain, r), kind: "опечатка без розділових" },
  ];
  const words = plain.split(" ");
  if (words.length >= 3) out.push({ text: words.slice(0, -1).join(" "), kind: "обірване" });
  return out;
}

export function allQuestions(): { category: Category; text: string; kind: string }[] {
  const out: { category: Category; text: string; kind: string }[] = [];
  let seed = 7;
  for (const category of CATEGORIES) for (const base of category.base) for (const v of variants(base, seed++)) out.push({ category, text: v.text, kind: v.kind });
  return out;
}
