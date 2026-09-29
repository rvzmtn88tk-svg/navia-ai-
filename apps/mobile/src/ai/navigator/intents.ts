// NAVIA navigator — LAYER 2: intent classifier (by meaning, not by phrase).
// The question is folded (uk/ru letter variants, case, punctuation), split
// into words, and every intent collects a score from its cues: word stems
// and short phrases in Ukrainian, Russian, surzhyk and English, matched with
// tolerance for one typo in longer words ("сигнл", "поворт", "укритя").
// Combinations add meaning ("сигнал" + "пропав" = the signal is gone,
// "якщо" + "сигнал" = what if it drops). The best-scoring intent wins; no
// score → the classic co-pilot or an honest "can't tell".
// Deterministic, no network, < 1 ms. Pure; unit-tested.
import { detectIntent, detectKind, fold, type PlaceKind } from "../copilotBrain";
import { EXAMPLES } from "./examples";
import { normalizeQuestion } from "./normalize";

export type NavigatorIntent =
  | "repeat"          // "повтори"
  | "explain"         // "чому ти так відповів?"
  | "emergency"       // injured, 112
  | "signalLost"      // GPS is gone / jammed / what if it drops
  | "gpsStatus"       // what's with GPS / accuracy / why the dot jumps
  | "confidence"      // how sure is NAVIA about my position
  | "routeWhy"        // why this route / is it the shortest
  | "shelterWhy"      // is it really the nearest shelter
  | "emotion"         // "I'm scared", panic
  | "offline"         // no internet — what works now
  | "clarify"         // not sure what is asked: a short question back
  | "general"         // any other question the language model answers from general knowledge
  | "onRoute"         // am I on the right road
  | "reroute"         // I left the route / what if I get lost off it
  | "routeNext"       // what next / how far to the turn
  | "eta"             // how far / how long / when do we arrive
  | "whereAmI"        // where am I / I'm lost
  | "shelter"         // nearest shelter
  | "alert"           // air alert status
  | "status"          // overall situation
  | "place"           // other place categories (fuel, pharmacy, resilience point…)
  | "noData"          // traffic, weather, cameras… — data NAVIA does not have
  | "smalltalk"       // "як справи", "дякую", "ок"
  | "speed"           // how fast am I going / am I speeding
  | "dataSource"      // real data or demo, is it up to date
  | "frustration"     // "ти тупий", "навіщо ти потрібен" — short, to the point
  | "classic"         // describe / navigate to / landmarks / help — the classic co-pilot
  | "unknown";

type Cue = [stem: string, weight: number];
const cue = (w: number, ...stems: string[]): Cue[] => stems.map((s) => [fold(s), w]);
/** Cues matched only exactly (no typo tolerance): short everyday words that
 * a typo would turn into something else ("корок" ≠ "короче"). */
const exact = (w: number, ...stems: string[]): Cue[] => stems.map((s) => [`=${fold(s)}`, w]);

const CUES: Partial<Record<NavigatorIntent, Cue[]>> = {
  confidence: [
    ...cue(8, "наскільки точн", "насколько точн", "how accurate", "точна моя позиц", "точная моя позиц", "наскільки впевнен", "насколько уверен", "наскільки точно ти", "насколько точно ты", "наскільки ти впевнен", "насколько ты уверен", "how sure", "how confident", "знаєш де я", "знаешь где я", "в курсе где я", "в курсі де я", "вірити позиц", "верить позиц", "довіряти позиц", "доверять позиц", "можна вірити", "можно верить", "точно знаєш", "точно знаешь", "бачиш мене", "видишь меня"),
    ...cue(4, "впевнен", "уверен", "confiden", "похибк", "погрешн", "достовірн", "достоверн"),
  ],
  routeWhy: [
    ...cue(8, "чому ця дорог", "почему эта дорог", "чому цією дорог", "почему этой дорог", "почему по этой", "чому по цій", "чого ти мене повів", "почему ты меня ведешь", "почему ты меня повел", "чому ти мене ведеш", "навіщо ця дорог", "зачем эта дорог", "why this route", "why this way", "why this road", "чому маршрут", "почему маршрут", "чому туди ведеш", "почему туда ведешь", "чому через", "почему через"),
    ...cue(6, "найкоротш", "кратчайш", "найшвидш", "быстрейш", "самый быстрый", "самый короткий", "shortest", "fastest", "інший маршрут", "другой маршрут", "альтернатив", "объезд", "об'їзд", "обїзд", "об'їзн", "обїзн", "объездн"),
    ...cue(8, "коротш", "коротк шлях", "короткий путь", "платн", "найкращ", "лучший маршрут", "кращий маршрут", "маршрут найкращ", "маршрут лучш", "швидше через", "быстрее через", "via the bypass", "toll", "better route", "shorter"),
  ],
  shelterWhy: cue(9, "точно найближч", "точно ближайш", "точно самое близк", "ближчого нема", "ближчого немає", "ближче нема", "ближе нет", "ближе нету", "а ближче", "а ближе", "is it the nearest", "closer shelter", "nearer shelter", "інші укриття", "другие укрытия", "ще укриття", "еще укрытия"),
  emotion: [
    ...cue(9, "страшно", "мені страшно", "мне страшно", "боюсь", "боюся", "я боюс", "панік", "паник", "паніку", "нервую", "нервничаю", "трусять", "трясутся", "трусит", "трясет", "плачу", "не можу заспокоїт", "не могу успокоит", "scared", "afraid", "panic", "terrified", "жах який", "ужас какой", "все погано", "все плохо", "мені погано від страху", "розгубив", "розгубил", "растерял", "не знаю що робити", "не знаю шо робити", "не знаю что делать", "заспокой", "успокой", "calm me", "i don't know what to do", "i dont know what to do"),
    ...cue(4, "тривожно", "тревожно", "моторошно", "жутко", "лячно", "стрьомно", "стремно"),
  ],
  offline: [
    ...cue(8, "без інтернет", "без интернет", "нема інтернет", "немає інтернет", "нет интернет", "інтернет зник", "интернет пропал", "інтернету нема", "интернета нет", "інтернет пропав", "интернет исчез", "без мережі", "без сети", "мережі нема", "сети нет", "немає мережі", "нет связи", "нема зв'язку", "немає зв'язку", "зв'язку нема", "связи нет", "no internet", "offline", "офлайн", "оффлайн", "без мобільн", "без мобильн", "мобільний інтернет", "мобильный интернет", "wi fi пропа", "wifi пропа", "вайфай пропа", "wi fi зник", "wifi зник", "без зв'язку", "без звязку", "без связи", "інтернет є", "интернет есть", "є інтернет", "есть интернет", "ти онлайн", "ты онлайн", "ти зараз онлайн", "ты сейчас онлайн", "онлайн", "online"),
    ...cue(3, "інтернет", "интернет", "internet", "мережа", "мережі", "зв'язок", "связь", "wifi", "wi fi", "вайфай"),
  ],
  repeat: [...exact(7, "повтори", "повтор", "ще раз", "еще раз", "не розчув", "не расслишал", "не почув", "не услишал", "say again", "repeat")],
  explain: cue(6, "чому ти", "почему ты", "чого ти", "чего ты", "why did you", "why do you", "звідки ти знаєш", "откуда ты знаешь", "звідки знаєш", "откуда знаешь", "how do you know", "на основі чого", "на основе чего", "звідки дані", "откуда данные", "чому так", "почему так", "поясни відповід", "объясни ответ", "поясни чому", "объясни почему", "звідки інформац", "откуда информац", "з чого ти взяв", "с чего ты взял", "можеш помил", "можешь ошиб", "ти помиляєш", "ты ошибаешь", "розумієш що я", "понимаешь что я", "розумієш мене", "понимаешь меня", "що це значить", "що це означає", "что это значит", "что это означает", "поясни детальн", "поясни докладн", "объясни подробн", "детальніше", "подробнее", "what does that mean", "explain more"),
  signalLost: cue(6, "без gps", "без сигнал", "без джипиес", "без жпс", "без спутник", "без супутник", "реб", "рэб", "глуш", "заглуш", "jamming", "jammed", "no gps", "no signal", "lost signal", "signal lost", "gps lost", "спуф", "spoof", "підмін", "подмен", "не ловит", "не ловить"),
  gpsStatus: [
    ...cue(8, "який сигнал", "какой сигнал", "який зараз сигнал", "какой сейчас сигнал", "що з сигналом", "шо з сигналом", "что с сигналом", "там з сигнал", "там с сигнал", "з точністю", "с точностью", "сигнал поган", "сигнал плох", "поганий сигнал", "плохой сигнал", "сигнал слаб", "слабкий сигнал", "слабый сигнал", "статус gps", "стан gps", "статус gnss", "стан сигналу", "состояние gps", "gps ok", "is gps ok", "gps нормальн", "gps працює", "gps работает"),
    ...cue(3, "gps", "джипиес", "джіпіес", "жпс", "gnss", "глонас", "точніст", "точност", "accuracy", "геолокац", "геопозиц"),
    ...cue(2, "сигнал", "signal", "спутник", "супутник", "satellit"),
    ...cue(5, "дергает", "дергаєт", "дёргает", "смикаєт", "скаче", "скачет", "прыгает", "стрибає", "jumps", "jumping", "jittery"),
  ],
  routeNext: [
    ...cue(8, "на яку вулицю", "на какую улицу", "яка наступна вулиц", "какая следующая улиц", "onto which street"),
    ...cue(6, "to the turn", "до повороту", "до поворота", "до наступного повороту", "до следующего поворота"),
    ...cue(5, "що далі", "шо далі", "что дальше", "шо дальше", "что дальше будет", "куди далі", "куда дальше", "куд далі", "куд дальше", "далі куди", "дальше куда", "what next", "whats next", "next turn", "наступний поворот", "следующий поворот", "наступн маневр", "следующ маневр", "де поворот", "где поворот", "коли поворот", "когда поворот", "через скільки поворот", "через сколько поворот", "скільки до повороту", "сколько до поворота", "куди повертат", "куда поворачив", "куди звертат", "куда сворачив", "куди їхати", "куда ехать", "куди йти", "куда идти", "куди зараз", "куда сейчас", "де звертат", "где сворачив", "куди мені", "куда мне"),
    ...cue(3, "поворот", "повернут", "повертат", "поворачив", "звернут", "свернут", "звертат", "сворачив", "маневр", "развязк", "розвязк", "turn", "exit", "налево", "направо", "ліворуч", "праворуч", "прямо"),
    ...cue(1, "далі", "дальше", "next"),
    ...cue(2, "куди", "куда", "where to"),
  ],
  eta: [
    ...cue(5, "коли приїд", "когда приед", "коли будем", "когда будем", "скільки їхати", "сколько ехать", "скільки йти", "сколько идти", "скільки залиш", "сколько остал", "далеко ще", "далеко еще", "ще далеко", "еще далеко", "how long", "how far", "скоро приїд", "скоро приед", "довго ще", "долго еще", "скільки км", "сколько км", "скільки кілометр", "сколько километр", "скільки часу", "сколько времени", "коли доїд", "когда доед", "о котрій", "во сколько", "скільки лишил", "скоко остал", "скок остал", "скока еще", "скока ещё", "скоко еще", "скільки ще їхати", "сколько еще ехать", "долго ли", "далеко ли", "пилить", "пилити", "тащиться", "тащитися", "чапати", "чапать", "тягнутися", "доберемо", "доберемся"),
    ...cue(8, "скільки часу в дороз", "сколько времени в пути", "час у дорозі", "время в пути", "якщо їхати так", "если ехать так"),
    ...cue(3, "приїд", "приед", "доїд", "доед", "arrive", "arrival", "eta", "далеко", "залишил", "осталос", "хвилин", "минут", "кілометр", "километр"),
  ],
  onRoute: [
    ...cue(6, "не збилис", "не сбилис", "не збилися", "не заблукали", "не заблудились"),
    ...cue(5, "правильно їду", "правильно еду", "правильно йду", "правильно иду", "правильно рухаюсь", "правильно двигаюсь", "правильн дорог", "правильн дороз", "правильн шлях", "правильн напрям", "правильн направлен", "верн дорог", "верно еду", "туди їду", "туда еду", "туди йду", "туда иду", "on track", "right way", "right road", "on the route", "still on route", "on route", "по маршруту", "за маршрутом", "на маршруті", "на маршруте", "не збився", "не сбился", "не заблукав", "не заблудился", "туди їдемо", "туда едем"),
    ...cue(2, "правильн", "верно", "вірно", "correct"),
  ],
  reroute: cue(6, "пропуст поворот", "пропущ поворот", "пропущу", "пропущ", "звернути не туди", "свернуть не туда", "съеду", "з'їду", "зїду", "не туди", "не туда", "збився", "сбился", "зіб'юсь", "собьюсь", "звернув не", "свернул не", "не там звернув", "не там свернул", "пропустив поворот", "пропустил поворот", "проїхав поворот", "проехал поворот", "перебуд", "перестро", "перерах", "пересчит", "новий маршрут", "новый маршрут", "з'їхав з маршрут", "съехал с маршрут", "зійшов з маршрут", "сошел с маршрут", "off route", "wrong turn", "wrong way", "missed the turn", "miss the turn", "missed my turn", "missed a turn", "проехал поворот", "проїхав поворот", "проскочив поворот", "проскочил поворот", "reroute", "recalculat", "відхилив", "отклонил", "збитися", "сбиться", "злетів з маршрут", "слетел с маршрут"),
  whereAmI: [
    ...cue(8, "який це район", "какой это район", "що за район", "что за район", "в якому я район", "в каком я район", "який район", "какой район", "від центр", "от центр", "which district", "what district"),
    ...cue(6, "якій я вулиц", "какой я улиц", "на якій я", "на какой я", "що це за місце", "что это за место"),
    ...cue(6, "де я", "где я", "where am i", "де ми", "где мы", "моє місце", "мое место", "моя позиц", "my location", "де знаходж", "где нахож", "на якій вулиці", "на какой улице", "що це за вулиц", "что за улиц", "мої координат", "мои координат", "заблук", "заблуд", "загубив", "потерялся", "i am lost", "im lost", "де зараз", "где сейчас"),
    ...cue(2, "позиц", "координат", "location", "місцезнаход", "местонахож"),
  ],
  shelter: [
    ...cue(6, "укритт", "укрит", "укрыт", "сховищ", "бомбосхов", "бомбоубеж", "shelter", "куди ховат", "куда прятат", "куди бігти", "куда бежать", "де сховатис", "где спрятат", "where to hide", "take cover"),
    ...cue(3, "ховат", "сховат", "прятат", "спрятат", "hide", "підвал", "подвал", "метро", "subway"),
  ],
  alert: [
    ...cue(5, "безпечн", "безопасн", "небезпечн", "опасн", "is it safe", "safe now"),
    ...cue(5, "тривог", "тревог", "air alert", "alert", "сирен", "siren", "повітрян", "воздушн"),
    ...cue(3, "ракет", "шахед", "дрон", "бпла", "обстріл", "обстрел", "вибух", "взрыв", "missile", "drone", "баліст", "баллист", "прильот", "прилет", "бомб"),
  ],
  status: [
    ...cue(8, "справи з поїздк", "дела с поездк", "в цілому справи", "в целом дела", "щось критичн", "что-то критич", "что то критич", "что нибудь критич", "під контролем", "под контролем", "все під контрол", "all under control", "anything critical"),
    ...cue(5, "статус", "обстановк", "ситуац", "що відбуваєт", "что происход", "що коїться", "что творится", "як ми", "как мы", "все гаразд", "все ок", "все нормально", "усе добре", "status", "situation", "whats going on", "what s going on", "how are we", "звіт", "отчет", "доповідь", "доклад", "огляд", "обзор", "що там", "что там", "шо там"),
    ...cue(3, "загалом", "в целом", "происход", "відбуваєт"),
  ],
  noData: [...exact(6, "корок", "курс", "черг", "дтп", "камер", "news", "rain", "snow", "joke", "music"), ...cue(6, "перекри", "пробк", "затор", "трафік", "трафик", "traffic", "погод", "дощ", "дожд", "сніг", "снег", "ожеледиц", "гололед", "туман", "weather", "rain", "snow", "температур", "радар", "speed camera", "штраф", "ціна бензин", "цена бензин", "ціни на пальне", "цены на топливо", "аварі", "авари", "accident", "ремонт дорог", "roadworks", "перекрит", "перекрыт", "блокпост", "checkpoint", "очеред", "новин", "новост", "news", "футбол", "анекдот", "жарт", "шутк", "joke", "пісн", "песн", "music", "музик", "рецепт", "гороскоп", "виграв", "выиграл", "видиміст", "видимост", "visibility", "вітер", "ветер", "wind", "комендантськ", "комендантск", "curfew"),
    ...cue(8, "скільки коштує", "сколько стоит", "ціна на", "цена на", "ціни на", "цены на", "how much is", "price of", "prices")],
  speed: [
    ...cue(8, "з якою швидкіст", "с какой скорост", "яка швидкіст", "какая скорост", "яка в мене швидкіст", "какая у меня скорост", "моя швидкіст", "моя скорост", "перевищу", "превыша", "how fast", "my speed", "speed limit", "обмеження швидкост", "ограничение скорост", "швидкість зараз", "скорость сейчас", "скільки км/год", "сколько км/ч", "з якою їду", "с какой еду"),
    ...cue(4, "швидкіст", "скорост", "speed"),
  ],
  dataSource: [
    ...cue(8, "демо режим", "демо-режим", "демо чи", "демо или", "чи демо", "или демо", "реальні дані", "реальные данные", "справжні дані", "настоящие данные", "дані актуальн", "данные актуальн", "актуальні дані", "актуальные данные", "застарілі", "устаревш", "demo mode", "real data", "is this real", "навчальн режим", "тестов режим", "тестовый режим"),
    ...cue(4, "демо", "demo", "актуальн"),
  ],
  frustration: cue(8, "тупий", "тупой", "тупа", "дурний", "дурной", "нічого не вмієш", "ничего не умеешь", "нічого не можеш", "ничего не можешь", "корисний", "полезный", "навіщо ти", "зачем ты", "нащо ти", "елементарн", "элементарн", "бесполезн", "марний", "никчемн", "нікчемн", "useless", "stupid", "dumb", "бісиш", "бесишь", "дратуєш", "раздражаешь"),
  smalltalk: [...cue(5, "як справи", "как дела", "спасибі", "спасибо", "дякую", "зрозумів", "понял", "привіт", "привет", "здрастуй", "здравству", "добрий день", "добрый день", "thanks", "thank you", "hello"), ...exact(5, "як справи", "как дела", "як ти", "как ты", "how are you", "ти хто", "ты кто", "who are you", "дякую", "спасибі", "спасибо", "thanks", "thank you", "добре", "хорошо", "зрозумів", "понял", "окей", "ok", "ок", "ясно", "мерси", "привіт", "привет", "hello", "hi", "здрастуй", "здравству", "добрий день", "добрый день", "доброго ранку", "доброе утро", "добрий вечір", "добрый вечер"), ...cue(6, "тобі років", "тебе лет", "скільки тобі", "сколько тебе", "how old are you", "як тебе звати", "как тебя зовут", "ти бот", "ты бот", "ти робот", "ты робот", "what is your name", "whats your name")],
};

/** One edit (insert, delete, replace) at most. */
function within1(a: string, b: string): boolean {
  if (a === b) return true;
  // Two neighbouring letters swapped ("сиганл", "повроот") = one typo.
  if (a.length === b.length) {
    const d = [...a].map((ch, i) => (ch !== b[i] ? i : -1)).filter((i) => i >= 0);
    if (d.length === 2 && d[1] === d[0]! + 1 && a[d[0]!] === b[d[1]!] && a[d[1]!] === b[d[0]!]) return true;
  }
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (a.length < b.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/** How well a word matches a stem: 1 exact/prefix, 0.6 with one typo (stems ≥ 5 letters), 0 no. */
function wordHit(word: string, stem: string): number {
  if (stem.length < 4) return word === stem ? 1 : 0;
  if (word.startsWith(stem)) return 1;
  if (stem.length < 5 || word.length < stem.length - 1) return 0;
  const typo = within1(word.slice(0, stem.length), stem) || within1(word.slice(0, stem.length + 1), stem) || within1(word.slice(0, stem.length - 1), stem);
  return typo ? 0.6 : 0;
}

/** Best match strength of a (multi-word) stem anywhere in the words. */
function phraseHit(words: string[], stem: string): number {
  const parts = stem.split(" ").filter(Boolean);
  if (parts.length === 0) return 0;
  let best = 0;
  for (let i = 0; i + parts.length <= words.length; i++) {
    let strength = 1;
    for (let k = 0; k < parts.length && strength > 0; k++) strength = Math.min(strength, wordHit(words[i + k]!, parts[k]!));
    best = Math.max(best, strength);
    if (best === 1) break;
  }
  // Two-word phrases also with one word between ("проїхав свій поворот",
  // "missed the turn"), a little weaker.
  if (best < 1 && parts.length === 2) {
    for (let i = 0; i + 2 < words.length; i++) best = Math.max(best, 0.9 * Math.min(wordHit(words[i]!, parts[0]!), wordHit(words[i + 2]!, parts[1]!)));
  }
  return best;
}
/** Exact prefix only (no typo tolerance) — for short marker words. */
const strictHit = (words: string[], stems: string[]) => stems.some((st) => words.some((w) => w.startsWith(st)));
const phraseHits = (words: string[], stem: string) => phraseHit(words, stem) > 0;

const list = (...stems: string[]) => stems.map(fold);
const FILLER = new Set(list("ну", "короче", "слухай", "слушай", "скажи", "бро", "підкажи", "подскажи", "швидко", "срочно", "блін", "блин", "да", "будь", "ласка", "пожалуйста", "вже", "уже", "дякую", "спасибо", "допоможи", "терміново", "ну скільки можна", "скільки", "можна"));
// Life-threatening only ("швидко!" or "допоможи" alone are not an emergency).
const EMERGENCY = list("швидка", "раненые", "раненых", "поранені", "поранених", "нужна скорая", "потрібна швидка", "поранен", "ранен", "ранил", "кров", "кровотеч", "без свідом", "без сознан", "не дихає", "не дышит", "швидку", "швидка допомог", "швидкої", "скорую", "скорая", "103", "112", "sos", "пожеж", "пожар", "emergency", "injured", "bleeding", "ambulance", "людині погано", "человеку плохо", "серцем", "сердцем", "інсульт", "инсульт", "інфаркт", "инфаркт", "дтп з постраждал", "есть раненые", "є поранені");
const SIGNAL = list("сигнал", "gps", "джипиес", "джіпіес", "жпс", "gnss", "навігац", "навигац", "спутник", "супутник", "signal", "геолокац", "зв'язок зі супутн");
const GONE = list("не бачить", "не видит", "не бачу", "не вижу", "не находит", "не знаходить", "пропа", "зник", "исчез", "нема", "немає", "нет", "нету", "втрат", "потер", "lost", "gone", "dropped", "died", "глуш", "jam", "відвал", "отвал", "вмер", "сдох", "впав", "упал", "слаб", "погір", "ухудш", "не працю", "не работ", "не ловит", "не ловить", "зникне", "пропаде", "пропадет");
const IF = list("якщо", "если", "раптом", "вдруг", "if", "what if", "коли зникне", "когда пропадет");
const LOST_ROUTE = list("маршрут", "дорог", "шлях", "путь", "пути", "route", "way", "заблук", "заблуд", "зіб", "собью", "собьюс", "збиюс");

const KIND_CUES: [kind: PlaceKind, canonical: string, stems: string[]][] = [
  ["resilience", "пункт незламності", list("незламн", "несокруш", "обігрів", "обогрев", "зарядити телефон", "зарядить телефон", "зарядка для телефон", "зарядку для телефон", "зарядка телефон", "phone charg", "де світло", "где свет", "resilience", "warming")],
  ["charger", "зарядна станція", list("електрозаряд", "электрозаряд", "зарядна станц", "зарядная станц", "charging", "зарядка для авто", "charge the car", "charge my car", "charge the ev", "зарядити авто", "зарядить машину", "зарядити машину", "зарядить авто")],
  ["fuel", "АЗС", list("заправ", "азс", "пальн", "бензин", "дизел", "fuel", "petrol", "gas station", "топлив")],
  ["pharmacy", "аптека", list("аптек", "ліки", "лекарств", "pharmacy", "drugstore", "chemist")],
  ["hospital", "лікарня", list("лікарн", "больниц", "травмпункт", "поликлин", "поліклін", "hospital", "clinic")],
  ["atm", "банкомат", list("банкомат", "банк", "готівк", "наличн", "atm", "cash")],
  ["water", "питна вода", list("питн", "попити", "попить", "drinking water")],
  ["food", "кафе", list("поїсти", "поесть", "їжа", "кафе", "ресторан", "перекус", "food", "eat", "cafe")],
  ["shop", "магазин", list("магазин", "продукт", "супермаркет", "shop", "store", "grocery")],
];

/** Place category of a question, tolerant to one typo; with a canonical word. */
export function placeKindOf(question: string): { kind: PlaceKind; canonical: string } | null {
  const words = fold(question).split(" ").filter(Boolean);
  let best: { kind: PlaceKind; canonical: string; hit: number } | null = null;
  for (const [kind, canonical, stems] of KIND_CUES) {
    const hit = Math.max(...stems.map((st) => phraseHit(words, st)));
    if (hit > (best?.hit ?? 0)) best = { kind, canonical, hit };
  }
  return best ? { kind: best.kind, canonical: best.canonical } : null;
}

/** understand() and classifyRaw() score the same question: the last result is reused (a copy — callers may edit it). */
let lastScores: { q: string; out: Partial<Record<NavigatorIntent, number>> } | null = null;
/** Scores for every intent (exported for the tests). */
export function scores(question: string): Partial<Record<NavigatorIntent, number>> {
  if (lastScores?.q === question) return { ...lastScores.out };
  const out = computeScores(question);
  lastScores = { q: question, out: { ...out } };
  return out;
}

function computeScores(question: string): Partial<Record<NavigatorIntent, number>> {
  const words = fold(question).split(" ").filter(Boolean);
  const out: Partial<Record<NavigatorIntent, number>> = {};
  for (const [intent, cues] of Object.entries(CUES) as [NavigatorIntent, Cue[]][]) {
    // A word counts once per intent: "укрит" and "укритт" both match
    // "укриття" — only the longer (more specific) stem scores.
    const hits: { stem: string; score: number }[] = [];
    for (const [raw, w] of cues) {
      const stem = raw.startsWith("=") ? raw.slice(1) : raw;
      const h = raw.startsWith("=") ? (phraseHit(words, stem) === 1 ? 1 : 0) : phraseHit(words, stem);
      if (h > 0) hits.push({ stem, score: w * h });
    }
    hits.sort((a, b) => b.stem.length - a.stem.length);
    let total = 0;
    const counted: string[] = [];
    for (const hit of hits) {
      if (counted.some((longer) => longer.startsWith(hit.stem))) continue;
      counted.push(hit.stem);
      total += hit.score;
    }
    if (total > 0) out[intent] = total;
  }
  const hasAny = (l: string[]) => l.some((s) => phraseHits(words, s));
  // The signal is (or may get) gone: a signal word with a loss word or a "what if".
  if (hasAny(SIGNAL) && (hasAny(GONE) || hasAny(IF))) out.signalLost = (out.signalLost ?? 0) + 7;
  // "What if I get lost / leave the route".
  // A "what if" about getting lost is about the plan, not about where I am now.
  if (hasAny(IF) && hasAny(LOST_ROUTE) && !hasAny(SIGNAL)) { out.reroute = (out.reroute ?? 0) + 10; delete out.whereAmI; }
  // "Where am I" beats a lone "on the route".
  if ((out.whereAmI ?? 0) >= 6 && (out.onRoute ?? 0) < 5) delete out.onRoute;
  // "Як ти"/"как ты" inside a "why did you" question is not small talk.
  if ((out.explain ?? 0) > 0) delete out.smalltalk;
  // "No connection WITH THE SATELLITES" is the GPS, not the internet.
  if ((out.offline ?? 0) > 0 && hasAny(SIGNAL) && !hasAny(list("інтернет", "интернет", "internet", "мереж", "сети", "wifi"))) delete out.offline;
  // A shelter + "really / closer" = is it really the nearest.
  if ((out.shelter ?? 0) > 0 && strictHit(words, list("точно", "ближч", "ближе", "closer", "nearer", "really"))) out.shelterWhy = (out.shelterWhy ?? 0) + 8;
  else if ((out.shelterWhy ?? 0) > 0 && !strictHit(words, list("точно", "ближч", "ближе", "closer", "nearer", "really", "інш", "друг", "ще ", "еще"))) delete out.shelterWhy;
  // "How accurate is my position" is about confidence, not "where am I".
  if ((out.whereAmI ?? 0) > 0 && strictHit(words, list("наскільки", "насколько", "how", "точна", "точная", "точно"))) { out.confidence = (out.confidence ?? 0) + 8; delete out.whereAmI; }
  // Fear + a question about what to do = emotion first (the answer includes the situation).
  if ((out.emotion ?? 0) > 0 && (out.alert ?? 0) > 0 && (out.emotion ?? 0) >= 9) out.alert = Math.min(out.alert!, 4);
  // "Why" + guiding / route / road = why this route, not "why did you answer so".
  if (hasAny(list("чому", "почему", "чого", "чего", "навіщо", "зачем", "why")) && strictHit(words, list("веде", "ведеш", "повів", "повел", "маршрут", "дорог", "шлях", "route", "road", "way"))) out.routeWhy = (out.routeWhy ?? 0) + 8;
  if ((out.routeWhy ?? 0) >= 8) delete out.explain;
  // "Чому ти такий тупий" is irritation, not "why did you answer so".
  if ((out.frustration ?? 0) >= 8) { delete out.explain; delete out.status; }
  // A bridge ahead ("міст", not "місто"): road events NAVIA has no data on.
  if (words.some((w) => /^(мист|мосту?|мости|bridge)$/.test(w))) out.noData = (out.noData ?? 0) + 6;
  // A lone "що взагалі?" is about the overall situation; next to a real question it is a filler.
  if (!Object.entries(out).some(([k, v]) => k !== "status" && (v ?? 0) >= 2) && hasAny(list("взагалі", "вообще"))) out.status = (out.status ?? 0) + 3;
  // "Почому / почём" (how much) — whole words only: "почему" is "why".
  if (words.some((w) => /^(почому|почем|почем)$/.test(w))) out.noData = (out.noData ?? 0) + 8;
  // "Допоможи мені" with nothing else asked: the calm crisis answer (not with "допоможи знайти аптеку").
  if (hasAny(list("допоможи мені", "допоможіть мені", "допоможи нам", "помоги мне", "помогите мне", "help me")) && !Object.entries(out).some(([k, v]) => k !== "emotion" && (v ?? 0) >= 3) && !placeKindOf(question)) out.emotion = (out.emotion ?? 0) + 8;
  // Speed + "is it safe / on time": still about the speed.
  if ((out.speed ?? 0) >= 8) delete out.status;
  return out;
}

// ——— similarity layer: character trigrams against the example bank ———

type Vec = Map<string, number>;
function trigrams(text: string): Vec {
  const v: Vec = new Map();
  for (const w of fold(text).split(" ").filter((x) => x.length > 1 && !FILLER.has(x))) {
    const t = ` ${w} `;
    for (let i = 0; i + 3 <= t.length; i++) { const g = t.slice(i, i + 3); v.set(g, (v.get(g) ?? 0) + 1); }
  }
  return v;
}
function norm(v: Vec): number { let s = 0; for (const x of v.values()) s += x * x; return Math.sqrt(s); }
// Inverted index: trigram → examples containing it, so a question is
// compared only with examples that share something with it.
type Bank = { intents: NavigatorIntent[]; norms: number[]; index: Map<string, { i: number; w: number }[]> };
let bank: Bank | null = null;
export function exampleBank(): Bank {
  if (bank) return bank;
  const intents: NavigatorIntent[] = [];
  const norms: number[] = [];
  const index = new Map<string, { i: number; w: number }[]>();
  for (const [intent, examples] of Object.entries(EXAMPLES) as [NavigatorIntent, string[]][]) {
    for (const e of examples) {
      const v = trigrams(e);
      const i = intents.length;
      intents.push(intent);
      norms.push(norm(v));
      for (const [g, w] of v) { const list = index.get(g); if (list) list.push({ i, w }); else index.set(g, [{ i, w }]); }
    }
  }
  bank = { intents, norms, index };
  return bank;
}

let lastSimilar: { q: string; r: { intent: NavigatorIntent; score: number } | null } | null = null;
/** Most similar intent by example (0.6 × best + 0.4 × mean of the 3 best per intent). */
export function similarIntent(question: string): { intent: NavigatorIntent; score: number } | null {
  if (lastSimilar?.q === question) return lastSimilar.r;
  const r = computeSimilar(question);
  lastSimilar = { q: question, r };
  return r;
}

function computeSimilar(question: string): { intent: NavigatorIntent; score: number } | null {
  const q = trigrams(question);
  const nq = norm(q);
  if (!nq) return null;
  const b = exampleBank();
  const dot = new Map<number, number>();
  for (const [g, x] of q) for (const { i, w } of b.index.get(g) ?? []) dot.set(i, (dot.get(i) ?? 0) + x * w);
  const per = new Map<NavigatorIntent, number[]>();
  for (const [i, d] of dot) {
    const c = d / (nq * b.norms[i]!);
    const intent = b.intents[i]!;
    const list = per.get(intent);
    if (list) list.push(c); else per.set(intent, [c]);
  }
  let best: { intent: NavigatorIntent; score: number } | null = null;
  for (const [intent, list] of per) {
    const top = list.sort((a, c) => c - a).slice(0, 3);
    const score = 0.6 * top[0]! + 0.4 * (top.reduce((a, c) => a + c, 0) / top.length);
    if (!best || score > best.score) best = { intent, score };
  }
  return best;
}

// Ties: the more urgent / more specific first.
const ORDER: NavigatorIntent[] = ["repeat", "explain", "emotion", "shelterWhy", "signalLost", "shelter", "alert", "offline", "routeWhy", "reroute", "onRoute", "confidence", "routeNext", "eta", "whereAmI", "gpsStatus", "speed", "dataSource", "noData", "status", "frustration", "smalltalk"];

/** Below this confidence the navigator asks back instead of guessing (programme 2.2, step 3). */
export const CLARIFY_BELOW = 0.55;

export type Understanding = {
  /** The intent to answer ("clarify" = ask which of `options` is meant). */
  intent: NavigatorIntent;
  /** The best guess before the clarify rule. */
  guess: NavigatorIntent;
  confidence: number;
  /** Candidates for a clarifying question (best first). */
  options: NavigatorIntent[];
  /** The question after typo / layout normalisation (what was classified). */
  normalized?: string;
};

const ASKABLE: NavigatorIntent[] = ["explain", "signalLost", "gpsStatus", "confidence", "routeNext", "eta", "onRoute", "reroute", "routeWhy", "whereAmI", "shelter", "shelterWhy", "alert", "status", "offline", "emotion", "noData", "place", "speed", "dataSource"];

/** Layer 2: normalise → classify → confidence → clarify when unsure. */
export function understand(original: string): Understanding {
  // Step 1: typo and keyboard-layout normalisation (normalize.ts).
  const question = normalizeQuestion(original).text || original;
  const guess = classifyRaw(question);
  const sc = scores(question);
  const sim = similarIntent(question);
  const f = fold(question);
  let confidence: number;
  if (guess === "repeat" || guess === "emergency") confidence = 1;
  else if (guess === "unknown") confidence = 0;
  else {
    const v = sc[guess] ?? 0;
    const rule = v >= 8 ? 0.95 : v >= 6 ? 0.85 : v >= 5 ? 0.8 : v >= 3 ? 0.62 : v >= 2 ? 0.5 : v > 0 ? 0.4 : 0;
    const bySim = sim && sim.intent === guess ? (sim.score >= 0.6 ? 0.9 : sim.score >= 0.5 ? 0.75 : sim.score >= 0.42 ? 0.6 : sim.score) : 0;
    const byKind = guess === "place" || guess === "classic" || guess === "smalltalk" ? 0.8 : 0;
    confidence = Math.max(rule, bySim, byKind);
    // Another meaning scores as high: less sure.
    const rival = Object.entries(sc).filter(([k, x]) => k !== guess && !(guess === "place" && (k === "eta" || k === "routeNext")) && (x ?? 0) >= Math.max(3, v)).length;
    if (rival > 0) confidence *= 0.8;
  }
  // Candidates for asking back: the best rule scores and the most similar example.
  const ranked = (Object.entries(sc) as [NavigatorIntent, number][])
    .filter(([k, x]) => ASKABLE.includes(k) && x >= 2)
    .sort((a, b) => b[1] - a[1]).map(([k]) => k);
  if (sim && sim.score >= 0.42 && ASKABLE.includes(sim.intent) && !ranked.includes(sim.intent)) ranked.push(sim.intent);
  const options = [...new Set([...(guess !== "unknown" && ASKABLE.includes(guess) ? [guess] : []), ...ranked])].slice(0, 2);
  const short = f.split(" ").filter(Boolean).length;
  if (guess !== "unknown" && confidence < CLARIFY_BELOW && options.length === 2) return { intent: "clarify", guess, confidence, options, normalized: question };
  // Nothing matched, but there is a weak lead: ask rather than refuse.
  if (guess === "unknown" && options.length >= 1 && short >= 2) return { intent: "clarify", guess, confidence, options, normalized: question };
  return { intent: guess, guess, confidence, options, normalized: question };
}

export function classify(question: string): NavigatorIntent {
  return understand(question).intent;
}

function classifyRaw(question: string): NavigatorIntent {
  const f = fold(question);
  if (!f) return "unknown";
  if (/^(ну |слушай |слухай |скажи |будь ласка |пожалуйста )?(повтори\S*|ще раз|еще раз|що ти сказав\S*|что ты сказал\S*|не розчув\S*|не расслишал\S*|не расслышал\S*|не почув\S*|не услишал\S*|не услышал\S*|repeat|say again|say that again|again)( |$)/.test(f) && f.split(" ").length <= 4) return "repeat";
  // A lone "що?" / "шо?" / "что?" / "га?" = "say that again" (fillers and emotions around it don't matter).
  const core = f.split(" ").filter((w) => !FILLER.has(w)).join(" ");
  if (/^(що|шо|что|чо|га|а|what)$/.test(core)) return "repeat";
  const classic = detectIntent(question);
  // Exact, or one typo in a long word ("кровотча", "скроая" stays unmatched below 6 letters).
  if (EMERGENCY.some((e) => { const h = phraseHit(f.split(" "), e); return h === 1 || (h > 0 && e.replace(/ /g, "").length >= 8); })) return "emergency";
  const sc = scores(question);
  let best: NavigatorIntent | null = null;
  let bestScore = 0;
  for (const intent of ORDER) {
    const v = sc[intent] ?? 0;
    if (v > bestScore) { best = intent; bestScore = v; }
  }
  // Places other than shelters (fuel, pharmacy, resilience point, …).
  const kind = detectKind(question) ?? placeKindOf(question)?.kind ?? null;
  if (kind && kind !== "shelter" && bestScore < 5) return "place";
  // "Далеко до АЗС?", "скільки йти до пункту незламності" — the place answer has the distance.
  if (kind && kind !== "shelter" && (best === "eta" || best === "routeNext") && bestScore < 8) return "place";
  // A bare call for help ("допоможи мені", "помоги пожалуйста"): the calm crisis answer.
  // Strong rule evidence wins; otherwise the example bank decides when it is
  // clearly similar; weak rule evidence is the last resort.
  const sim = similarIntent(question);
  // With no rule evidence at all, similarity alone must be clear (≥ 0.5);
  // weaker similarity leads to a clarifying question instead (understand()).
  if ((!best || bestScore < 5) && sim && (best ? sim.score >= 0.42 : sim.score >= 0.5) && (!best || sim.score >= 0.5 || sim.intent === best)) {
    if (sim.intent === "emergency" || sim.intent === "repeat" || sim.intent === "explain" || sim.intent === "noData" || sim.intent === "smalltalk" || (sc[sim.intent] ?? 0) > 0 || !best || bestScore < 3) return sim.intent;
  }
  if (best && bestScore >= 1) {
    // "Hi" or "thanks" around a real question does not make it small talk.
    if (best === "smalltalk") {
      const other = ORDER.find((i) => i !== "smalltalk" && (sc[i] ?? 0) >= 2);
      if (other) return other;
      if (kind) return kind === "shelter" ? "shelter" : "place";
    }
    return best;
  }
  if (kind) return kind === "shelter" ? "shelter" : "place";
  // A short "повтори" with a typo (only when nothing else matched).
  if (f.split(" ").length <= 4 && f.split(" ").some((w) => ["повтори", "розчув", "расслишал", "repeat"].some((st) => wordHit(w, st) > 0))) return "repeat";
  if (classic === "greet" || classic === "thanks") return "smalltalk";
  if (classic !== "unknown") return "classic";
  return "unknown";
}
