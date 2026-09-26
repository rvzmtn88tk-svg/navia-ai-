import { scores, classify } from "../src/ai/navigator/intents";
for (const q of ["що буде якщо я заблукаю", "короче что с gps", "як согнал?"]) console.log(q, JSON.stringify(scores(q)), classify(q));
