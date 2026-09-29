// Typo set for the normalisation layer (programme follow-up, item 2): every
// base phrasing of the simulator bank with a deliberate typo IN A KEY WORD
// (the word that carries the meaning: "сигнал", "маршрут", "укриття",
// "тривога", "поворот"…) — dropped, swapped, replaced or doubled letter, or
// the word typed in the wrong keyboard layout. Deterministic.
import { SIM_CATEGORIES } from "../sim/questionBank";

const KEY = /^(сигнал|gps|джипіес|супутник|спутник|навігац|навигац|маршрут|дорог|поворот|повернув|свернул|проехал|пропустив|перебуд|перестро|укритт|укрыт|бомбоуб|сховищ|тривог|тревог|обстріл|безпечн|пробк|затор|погод|дощ|дожд|камер|ожеледиц|блокпост|страшн|боюс|панік|паник|нервую|інтернет|интернет|мережі|зв'язк|связ|аптек|заправ|банкомат|незламн|лікарн|магазин|далеко|їхати|ехать|скільки|сколько|приїд|приед|куди|куда|далі|дальше|точн|позиц|впевнен|уверен|глуш|пропа|втрат|потер|зник|повтори|чому|почему|звідки|откуда|анекдот|вірш|shelter|route|turn|signal|traffic|weather|scared|internet|pharmacy|charge|joke)/i;

const LETTERS = "абвгдежзиклмнопрстуфхцчшіоуеяю";
const UK_TO_EN: Record<string, string> = { й: "q", ц: "w", у: "e", к: "r", е: "t", н: "y", г: "u", ш: "i", щ: "o", з: "p", х: "[", ї: "]", ф: "a", і: "s", ы: "s", в: "d", а: "f", п: "g", р: "h", о: "j", л: "k", д: "l", ж: ";", є: "'", э: "'", я: "z", ч: "x", с: "c", м: "v", и: "b", т: "n", ь: "m", б: ",", ю: "." };

function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
}

export type TypoCase = { text: string; accept: string[]; kind: string; word: string };

export function typoCases(perBase = 3): TypoCase[] {
  const out: TypoCase[] = [];
  let seed = 4242;
  const ops = ["drop", "swap", "replace", "double", "layout"];
  for (const cat of SIM_CATEGORIES) {
    for (const [base, accept] of cat.bases) {
      const words = base.split(" ");
      const keyIdx = words.map((w, i) => (KEY.test(w.replace(/[^\p{L}']/gu, "")) && w.replace(/[^\p{L}]/gu, "").length >= 4 ? i : -1)).filter((i) => i >= 0);
      if (keyIdx.length === 0) continue;
      for (let k = 0; k < perBase; k++) {
        const r = rng(seed++);
        const wi = keyIdx[Math.floor(r() * keyIdx.length)]!;
        const raw = words[wi]!;
        const w = raw.replace(/[^\p{L}']/gu, "");
        const op = ops[(k + Math.floor(r() * ops.length)) % ops.length]!;
        const p = 1 + Math.floor(r() * (w.length - 2));
        let t: string;
        if (op === "drop") t = w.slice(0, p) + w.slice(p + 1);
        else if (op === "swap") t = w.slice(0, p) + w[p + 1] + w[p] + w.slice(p + 2);
        else if (op === "replace") t = w.slice(0, p) + LETTERS[Math.floor(r() * LETTERS.length)] + w.slice(p + 1);
        else if (op === "double") t = w.slice(0, p) + w[p] + w.slice(p);
        else t = /[а-яіїєґ]/i.test(w) ? [...w.toLowerCase()].map((ch) => UK_TO_EN[ch] ?? ch).join("") : w.slice(0, p) + w.slice(p + 1);
        if (t.toLowerCase() === w.toLowerCase()) continue;
        const copy = [...words];
        copy[wi] = raw.replace(w, t);
        out.push({ text: copy.join(" "), accept, kind: op, word: `${w}→${t}` });
      }
    }
  }
  return out;
}
