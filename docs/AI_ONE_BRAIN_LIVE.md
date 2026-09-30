# Live check: one brain (situation questions → the co-pilot)

Run 2026-09-30T19:42:21.763Z · real model through the NAVIA proxy · real Kyiv data (Bazhana Ave: OSM tiles, Valhalla route, Nominatim reverse, KMDA shelters).
**Result: 24/24 checks pass** · p50 2.8 s


## де я (GPS ok)

**Водій:** де я зараз?

**NAVIA:** Ви на проспекті Миколи Бажана, район Осокорки. GPS сильний. До пункту призначення залишилось 5 кілометрів, їхати близько 8 хвилин.

Tools: where_am_i · 2.7 s · mode llm

- PASS where_am_i called
- PASS names the real street
- PASS no coordinates

## що з GPS (ok)

**Водій:** що з GPS?

**NAVIA:** GPS в нормі, NAVIA в зв'язку. Ви їдете по E 40, до цілі залишилося 5 кілометрів і близько 8 хвилин.

Tools: none · 1.4 s · mode llm

- PASS does not claim GPS is lost
- PASS short (≤ 35 words)

## скільки ще (route)

**Водій:** скільки ще їхати?

**NAVIA:** Залишилось 5 кілометрів, приблизно 8 хвилин. Приїдете о 22:50.

Tools: none · 1.2 s · mode llm

- PASS gives distance or time
- PASS short (≤ 35 words)

## укриття

**Водій:** де найближче укриття?

**NAVIA:** Найближче укриття — підземні автопаркінги на вулиці Олександра Мишуги на відстані 160 метрів. Також метро на 220 метрів звідси. Повітряних тривог на Київ зараз немає.

Tools: get_safety_info · 2.8 s · mode llm

- PASS get_safety_info called
- PASS never says safe
- PASS no coordinates

## тривога

**Водій:** що з тривогою?

**NAVIA:** Повітряна тривога активна. Поблизу є укриття: на відстані 160 м — підземні автопаркінги на вулиці Олександра Мишуги, далі паркінг та вхід в метро.

Tools: get_safety_info · 3.5 s · mode llm

- PASS get_safety_info called
- PASS says it is active
- PASS never says safe

## мені страшно

**Водій:** мені страшно

**NAVIA:** Розумію. Де вам страшно — на цій дорозі, у темряві чи взагалі? Можу допомогти знайти місце для зупинки неподалік — парковку, заправку чи кафе, щоб ви відпочили. Або якщо це стосується повітряної тривоги — перевірю найближчі укриття.

Tools: none · 2.4 s · mode llm

- PASS short (≤ 40 words)
- PASS never says safe

## аптека поруч

**Водій:** де найближча аптека?

**NAVIA:** «Біла Ромашка» за 150 метрів, «Подорожник» і АНЦ — за 250 метрів. Статус невідомий.

Tools: search_near · 2.9 s · mode llm

- PASS searches the map
- PASS no coordinates

## анекдот

**Водій:** расскажи анекдот

**NAVIA:** Извините, рассказывать анекдоты — не мое дело. Я помогаю с навигацией: поиск мест, маршруты, остановки в пути. Вы едете по E 40, осталось около 8 минут до пункта назначения.

Tools: none · 1.6 s · mode llm

- PASS short (≤ 45 words)
- PASS answers in Russian

## де я (GPS lost)

**Водій:** где я сейчас?

**NAVIA:** GPS сейчас потерян, позиция примерная — где-то в районе Осокорків, с точностью около 150 метров. Подскажите, что видите рядом — вывеску магазина, остановку, название улицы — чтобы уточнить положение?

Tools: where_am_i · 3.4 s · mode llm

- PASS where_am_i called
- PASS says it is approximate
- PASS no coordinates

## де я (±90 m only)

**Водій:** де я?

**NAVIA:** Ви приблизно на проспекті Миколи Бажана, район Осокорки (точність ±90 м, GPS втрачено). Поруч — магазини «Стайєр», IStudio, Brocard.

Tools: where_am_i · 3.6 s · mode llm

- PASS where_am_i called
- PASS says it is approximate
