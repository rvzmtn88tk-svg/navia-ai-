# Hold-out B (clean)

Recognised: 26 of 41 (63.4 %)

| Question | Expected | Got | OK |
|---|---|---|---|
| навігатор показує що я в полі, а я на трасі | signalLost/gpsStatus/whereAmI | noData | ✗ |
| супутники не підхоплюються вже хвилину | signalLost/gpsStatus | gpsStatus | ✓ |
| если связь со спутником оборвется ты справишься | signalLost | signalLost | ✓ |
| чи можна їхати далі якщо нема gps | signalLost | signalLost | ✓ |
| наскільки зараз можна довіряти позиції | gpsStatus | whereAmI | ✗ |
| стрілка не рухається, в чому справа | gpsStatus/signalLost | unknown | ✗ |
| наступний маневр через скільки | routeNext | routeNext | ✓ |
| на кільці який виїзд брати | routeNext | unknown | ✗ |
| після заправки куди | routeNext | place | ✗ |
| мне сейчас перестраиваться вправо? | routeNext | reroute | ✗ |
| скільки нам ще пилити | eta | unknown | ✗ |
| коли будемо в борисполі | eta | eta | ✓ |
| сколько по времени еще | eta | eta | ✓ |
| чи ми вже близько | eta | unknown | ✗ |
| це та дорога що треба? | onRoute | unknown | ✗ |
| ми не звернули випадково не туди? | onRoute/reroute | reroute | ✓ |
| я поворот проскочив | reroute | noData | ✗ |
| построй маршрут заново | reroute | reroute | ✓ |
| якщо я звернув не там, ти скажеш? | reroute | reroute | ✓ |
| в якому я місті зараз | whereAmI | unknown | ✗ |
| опиши де ми | whereAmI | whereAmI | ✓ |
| де найближчий підвал сховатися | shelter | shelter | ✓ |
| куди йти під час сирени | shelter/alert | alert | ✓ |
| зараз повітряна небезпека? | alert | alert | ✓ |
| загроза балістики є? | alert | alert | ✓ |
| поясни коротко як у нас все | status | unknown | ✗ |
| що важливого зараз | status | unknown | ✗ |
| давай ще раз те саме | repeat | repeat | ✓ |
| не почув що ти сказав | repeat | repeat | ✓ |
| це ти звідки взяв | explain | explain | ✓ |
| на чому базується твоя відповідь | explain | explain | ✓ |
| чи є затори на виїзді з міста | noData | noData | ✓ |
| холодно на вулиці? | noData | whereAmI | ✗ |
| де пости поліції | noData | place | ✗ |
| дякую тобі | smalltalk | smalltalk | ✓ |
| ну добре | smalltalk | smalltalk | ✓ |
| де купити воду | place | place | ✓ |
| найближчий банкомат | place | place | ✓ |
| де можна зарядити телефон | place | place | ✓ |
| у пасажира кров з голови | emergency | emergency | ✓ |
| людина не дихає | emergency | emergency | ✓ |
