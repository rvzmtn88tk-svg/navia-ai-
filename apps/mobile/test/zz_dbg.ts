import { scores, similarIntent, understand } from "../src/ai/navigator/intents";
for (const q of process.argv.slice(2)) console.log(q, JSON.stringify(scores(q)), JSON.stringify(similarIntent(q)), JSON.stringify(understand(q)));
