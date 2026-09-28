// Hold-out set C — written BEFORE the navigator rebuild (programme part 1),
// never used to tune the classifier. Covers the categories of the programme
// (part 2.3), including the new ones: position confidence, why this route,
// is it really the nearest shelter, emotion, offline. Accepted intents per
// phrase; "unknown" counts only where the phrase is out of scope.
export const HOLDOUT_C: [string, string[]][] = [
  // А. signal status
  ["а як там зараз зі супутниками, все ок?", ["gpsStatus"]],
  ["чого точка на мапі туди-сюди скаче", ["gpsStatus", "signalLost"]],
  ["який зараз сигнал у телефона", ["gpsStatus"]],
  ["ты вообще в курсе где я нахожусь?", ["confidence", "whereAmI"]],
  ["наскільки точно ти мене бачиш", ["confidence", "gpsStatus"]],
  ["можна вірити позиції на екрані?", ["confidence"]],
  // Б. signal loss / degradation
  ["жпс відвалився, шо тепер робити", ["signalLost"]],
  ["если надолго пропадёт спутник, ты справишься?", ["signalLost"]],
  ["сигнал ще є але слабенький", ["signalLost", "gpsStatus"]],
  ["навігація без супутників взагалі працює?", ["signalLost"]],
  ["глушилку включили походу", ["signalLost"]],
  // В. route
  ["а шо там по поворотах наступних", ["routeNext"]],
  ["скоко ще тащитися до кінця", ["eta"]],
  ["о котрій ми доберемось", ["eta"]],
  ["чого ти мене повів саме цією дорогою", ["routeWhy"]],
  ["почему маршрут через этот мост", ["routeWhy"]],
  ["це найкоротший шлях?", ["routeWhy"]],
  // Г. safety / alert
  ["тривогу дали? куди мені йти", ["shelter", "alert"]],
  ["де тут сховатись від ракет", ["shelter"]],
  ["це точно найближче укриття?", ["shelterWhy"]],
  ["а ближчого сховища нема?", ["shelterWhy", "shelter"]],
  ["зараз безпечно їхати далі?", ["alert", "status"]],
  // Д. off route
  ["здається я не там з'їхав", ["reroute"]],
  ["я точно ще на маршруті?", ["onRoute", "reroute"]],
  ["ми не проскочили потрібний поворот?", ["reroute", "onRoute"]],
  ["перерахуй дорогу", ["reroute"]],
  // Е. meta
  ["а на якій підставі така відповідь", ["explain"]],
  ["звідки ти це береш", ["explain"]],
  ["ще разок можна?", ["repeat"]],
  ["не почув, скажи ще", ["repeat"]],
  // Ж. no data
  ["на мосту зараз корок?", ["noData"]],
  ["чи буде сьогодні дощ", ["noData"]],
  ["де пости поліції на трасі", ["noData"]],
  ["скільки коштує бензин на wog", ["noData", "place"]],
  // З. emotion
  ["мені дуже страшно", ["emotion"]],
  ["я панікую що робити", ["emotion"]],
  ["боюсь, руки трусяться", ["emotion"]],
  ["мне страшно, помоги", ["emotion"]],
  ["я не знаю що робити, все погано", ["emotion"]],
  // И. offline
  ["інтернет зник, що тепер", ["offline"]],
  ["нет связи с интернетом, карта будет работать?", ["offline"]],
  ["без мобільного інтернету ти працюєш?", ["offline"]],
  ["мобілка без мережі, маршрут збережеться?", ["offline"]],
  // К. out of scope
  ["розкажи вірш", ["noData", "unknown"]],
  ["скільки буде два плюс два", ["unknown", "noData"]],
  ["хто виграв вчора матч", ["noData", "unknown"]],
  // Л. places nearby
  ["де тут найближча аптека", ["place"]],
  ["треба заправитись терміново", ["place"]],
  ["де погрітися і зарядити телефон", ["place"]],
  ["банкомат поруч є?", ["place"]],
];
