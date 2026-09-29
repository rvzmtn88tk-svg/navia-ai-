# Hold-out phrasings

Recognised: 39 of 52 (75.0 %)

| Question | Expected | Got | OK |
|---|---|---|---|
| у меня тут навигация сломалась, спутников ноль | signalLost | gpsStatus | ✗ |
| телефон перестав бачити де я, це глушилка? | signalLost/whereAmI | signalLost | ✓ |
| чувак, связи со спутником нет, веди как-нибудь | signalLost | signalLost | ✓ |
| що мені робити, якщо навігація зовсім вимкнеться | signalLost | signalLost | ✓ |
| точка на карті стрибає, це нормально? | gpsStatus/signalLost | gpsStatus | ✓ |
| наскільки точно ти зараз знаєш де я | gpsStatus/whereAmI | confidence | ✗ |
| джипіес живий? | gpsStatus | gpsStatus | ✓ |
| ловит нормально спутники? | gpsStatus | gpsStatus | ✓ |
| наступним що буде, ліво чи право? | routeNext | clarify | ✗ |
| мені прямо чи повертати? | routeNext | routeNext | ✓ |
| на світлофорі куди? | routeNext | routeNext | ✓ |
| где мне съезжать с трассы | routeNext | unknown | ✗ |
| скільки ще метрів до маневру | routeNext | routeNext | ✓ |
| ще довго їхати до кінця? | eta | eta | ✓ |
| встигнемо до восьмої? | eta | eta | ✓ |
| какое расстояние до конца маршрута | eta | unknown | ✗ |
| скільки хвилин лишилось | eta | eta | ✓ |
| я ж по правильній їду? | onRoute | onRoute | ✓ |
| ми точно в той бік їдемо? | onRoute | clarify | ✗ |
| не проскочили ми часом? | onRoute/reroute | noData | ✗ |
| здається я не туди завернув | reroute | reroute | ✓ |
| я заехал куда-то не туда | reroute | reroute | ✓ |
| поверни мене на маршрут | reroute | onRoute | ✗ |
| що буде якщо я пропущу з'їзд | reroute | reroute | ✓ |
| підкажи адресу, де я зараз стою | whereAmI | whereAmI | ✓ |
| я вообще где нахожусь | whereAmI | whereAmI | ✓ |
| який це район? | whereAmI | whereAmI | ✓ |
| де тут можна перечекати обстріл | shelter | alert | ✗ |
| найближче бомбосховище пішки | shelter | shelter | ✓ |
| куди бігти якщо зараз прилетить | shelter | shelter | ✓ |
| оголосили тривогу чи ні? | alert | alert | ✓ |
| чути вибухи, що відбувається | alert/status | status | ✓ |
| в області зараз неспокійно? | alert/status | alert | ✓ |
| дай короткий огляд ситуації | status | status | ✓ |
| розкажи що зараз з усім | status | status | ✓ |
| як там у нас справи з дорогою і сигналом | status/gpsStatus | clarify | ✗ |
| скажи це ще раз | repeat | repeat | ✓ |
| не зрозумів, повтори повільніше | repeat | repeat | ✓ |
| а звідки такі цифри? | explain | explain | ✓ |
| чому ти вирішив що я на маршруті? | explain | routeWhy | ✗ |
| на трасі затор? | noData | noData | ✓ |
| чи йде зараз сніг у Броварах | noData | noData | ✓ |
| де стоять камери швидкості | noData | noData | ✓ |
| поліція на дорозі є? | noData | noData | ✓ |
| дякую друже | smalltalk | smalltalk | ✓ |
| ти молодець | smalltalk | smalltalk | ✓ |
| доброго вечора | smalltalk | unknown | ✗ |
| де тут заправитися | place | place | ✓ |
| потрібна аптека терміново | place | place | ✓ |
| де пункт незламності поблизу | place | place | ✓ |
| водій знепритомнів | emergency | unknown | ✗ |
| збили пішохода, що робити | emergency | emergency | ✓ |
