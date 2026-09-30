// Which questions go to the tool-calling trip co-pilot (packages/core/src/copilot,
// the cloud branch): requests to DO something with the trip — a stop on the
// way, road preferences, "take me home", reminders, remembered habits, undo —
// and, while a route is active, needs on the way ("coffee", "fuel", "food").
// Questions about the situation ("where am I", "what about GPS", "where is
// the nearest shelter") stay with the on-device navigator: instant, grounded
// in the snapshot, work offline. Pure (tests).

const ACTION = new RegExp([
  // a stop / something on the way
  "по дороз|по дороге|по пути|по маршрут|на маршрут|дорогою|along the (way|route)|on (the|my) way",
  "(^|\\s)(додай|додати|добав|заїд|заїх|заед|заскоч|заверн|зупинись|остановись|stop at|add)",
  "зупинк|остановк",
  // road preferences
  "платн|toll|уника|избега|avoid|без трас|без автобан|без ґрунт|без грунт|без паром|ferr",
  // destination shortcuts and route changes
  "додому|до дому|домой|take me home|на роботу|на работу|to work",
  "маршрут через|через .* (поїд|їхат|поед|ехат)|інший маршрут|другой маршрут|альтернатив|швидш.* маршрут|быстрее.* маршрут|змін.* маршрут|измени.* маршрут",
  // undo, reminders, long-term preferences
  "скасуй|отмени|прибери|убери|поверни як|верни как|undo|cancel",
  "нагадай|напомни|remind",
  "запам.?ятай|запомни|remember|забудь|forget",
].join("|"), "i");

/** A need that is best met along the route while one is active. */
const NEED_ON_THE_WAY = /(кав|кофе|coffee|поїсти|поесть|їжа|еда|перекус|голодн|туалет|wc|заправ|бензин|пальн|дизел|газ(\s|$)|зарядк|charg|паркув|паркінг|парковк|parking|аптек|pharmacy)/i;
/** "Where is the nearest …" is a question about what is around, not a trip change. */
const NEAREST_AROUND = /(де|где|where).*(найближч|ближайш|nearest|поруч|рядом|nearby)/i;

export function wantsTripCopilot(text: string, routeActive: boolean): boolean {
  const t = text.trim();
  if (!t) return false;
  if (ACTION.test(t)) return true;
  return routeActive && NEED_ON_THE_WAY.test(t) && !NEAREST_AROUND.test(t);
}

const YES = /^(так|да|ага|угу|yes|yeah|ok|ок|окей|добре|давай|додай|додавай|згоден|згодна|згодне|підтверджую|go|do it)([\s,.!]|$)/i;
const NO = /^(ні|нет|no|не треба|не надо|не потрібно|відміна|скасуй|отмена|отмени|cancel)([\s,.!]|$)/i;

/** An answer to a pending yes/no proposal ("додати зупинку?"), or null. */
export function yesNo(text: string): "yes" | "no" | null {
  const t = text.trim();
  if (YES.test(t)) return "yes";
  if (NO.test(t)) return "no";
  return null;
}
