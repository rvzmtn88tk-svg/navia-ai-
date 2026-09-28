// The 12 control questions of the navigator programme (part 1.2), each in
// the situation it belongs to. Run on the code before and after a change to
// compare answers word for word (test/navigatorControl.test.ts).
export const CONTROL: { n: number; q: string; sit: string }[] = [
  { n: 1, q: "Где я?", sit: "driving" },
  { n: 2, q: "Куда дальше?", sit: "driving" },
  { n: 3, q: "Через сколько поворот?", sit: "driving" },
  { n: 4, q: "У меня пропал сигнал, что делать?", sit: "lost" },
  { n: 5, q: "Насколько ты уверен в моей позиции?", sit: "degraded" },
  { n: 6, q: "Объявлена тревога, где ближайшее укрытие?", sit: "alert" },
  { n: 7, q: "Я сбился с маршрута?", sit: "offroute" },
  { n: 8, q: "Какая сейчас пробка на дороге?", sit: "driving" },
  { n: 9, q: "Почему ты так ответил?", sit: "driving" }, // right after question 8
  { n: 10, q: "Скока ещё пилить", sit: "driving" },
  { n: 11, q: "мене страшно шо робити", sit: "alert" },
  { n: 12, q: "повтори", sit: "alert" }, // right after question 11
];
