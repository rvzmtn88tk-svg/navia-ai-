# Live check: one brain (situation questions → the co-pilot)

Run 2026-09-30T20:25:52.891Z · real model through the NAVIA proxy · real Kyiv data (Bazhana Ave: OSM tiles, Valhalla route, Nominatim reverse, KMDA shelters).
**Result: 24/24 checks pass** · p50 2.9 s


## де я (GPS ok)

**Водій:** де я зараз?

**NAVIA:** Ви на проспекті Миколи Бажана в районі Осокорки. Зліва від вас магазин Стайер, далі IStudio і Brocard.

Tools: where_am_i · 2.4 s · mode llm

- PASS where_am_i called
- PASS names the real street
- PASS no coordinates

## що з GPS (ok)

**Водій:** що з GPS?

**NAVIA:** GPS у нормі, сигнал стійкий. NAVIA навігує точно.

Tools: none · 1.3 s · mode llm

- PASS does not claim GPS is lost
- PASS short (≤ 35 words)

## скільки ще (route)

**Водій:** скільки ще їхати?

**NAVIA:** Залишилося 5 кілометрів, близько 8 хвилин. Приїдете приблизно о 23:33.

Tools: none · 1.2 s · mode llm

- PASS gives distance or time
- PASS short (≤ 35 words)

## укриття

**Водій:** де найближче укриття?

**NAVIA:** Найближче укриття — на відстані близько 160 метрів: підземні автопаркінги на вулиці Олександра Мишуги. Поточно повітряне сповіщення відсутнє.

Tools: get_safety_info · 2.9 s · mode llm

- PASS get_safety_info called
- PASS never says safe
- PASS no coordinates

## тривога

**Водій:** що з тривогою?

**NAVIA:** Тривога в Київі активна з 12 хвилин тому. Найближчі укриття — підземні автопаркінги на вул. Олександра Мишуги за 160 метрів, паркінг там же за 210 метрів, вхід в метро за 220 метрів від вас.

Tools: get_safety_info · 3.1 s · mode llm

- PASS get_safety_info called
- PASS says it is active
- PASS never says safe

## мені страшно

**Водій:** мені страшно

**NAVIA:** Ви їдете по дорозі, GPS працює нормально. Якщо потрібно - можу допомогти з місцем, де зупинитися. Розкажіть, що вас хвилює - чи це стан дороги, або щось інше?

Tools: get_safety_info · 3.5 s · mode llm

- PASS short (≤ 40 words)
- PASS never says safe

## аптека поруч

**Водій:** де найближча аптека?

**NAVIA:** Найближча — «Біла Ромашка» за 150 метрів. Також поруч «Подорожник» та «АНЦ» по 250 метрів.

Tools: search_near · 2.6 s · mode llm

- PASS searches the map
- PASS no coordinates

## анекдот

**Водій:** расскажи анекдот

**NAVIA:** Я NAVIA, навигационный помощник — я помогаю с маршрутом, местами и навигацией, а не развлекаю анекдотами. Впереди лёгкий поворот влево через 760 метров, и вы прибудете на место через 8 минут.

Tools: none · 1.7 s · mode llm

- PASS short (≤ 45 words)
- PASS answers in Russian

## де я (GPS lost)

**Водій:** где я сейчас?

**NAVIA:** GPS сейчас потерян, положение оценивается по датчикам — примерно в районе Осокорки, точность около ±197 м. Рядом, по картам, есть магазины IStudio, Brocard и отделение Monobank. Подскажите, что видите вокруг — это поможет уточнить позицию точнее.

Tools: where_am_i · 4.3 s · mode llm

- PASS where_am_i called
- PASS says it is approximate
- PASS no coordinates

## де я (±90 m only)

**Водій:** де я?

**NAVIA:** Зараз ви приблизно на проспекті Миколи Бажана, район Осокорки — GPS втрачено, позиція орієнтовна (±90 м). Поруч, здається, магазини «Стайєр», «IStudio», «Brocard».

Tools: where_am_i · 4.2 s · mode llm

- PASS where_am_i called
- PASS says it is approximate
