# Live check: GPS loss → locate by what the driver sees

Run 2026-09-30T19:42:48.209Z · real model through the NAVIA proxy · real OSM data of Kyiv (fixtures) · NavigationEngine route dead reckoning.
**Result: 18/18 checks pass.**


## S1 GPS lost: «Пропал навигатор» → honest state + asks what the driver sees

**Водій:** Пропал навигатор, что делать?

**NAVIA:** GPS пропал, но NAVIA продолжает вести по карте и датчикам движения — сейчас держитесь на E 40, скоро потребуется небольшой поворот налево, смотрите на дорогу. Что видите вокруг — может, заправку, ТЦ или название улицы?

Tools: none · 3.3 s

- PASS no position fix without evidence
- PASS asks what the driver sees
- PASS no exact metres

## S2 metro + Дніпро-М opposite, estimate near Kharkivska → locate, fix, guide

**Водій:** Вижу станцию метро, хз какая, а напротив магазин Днипро-М

**NAVIA:** Это метро «Харківська». Через примерно 80 метров плавный поворот налево на E 40.

Tools: locate_by_description→unique, confirm_position→done · 6.4 s

- PASS locate_by_description called
- PASS position fixed
- PASS names Kharkivska
- PASS does not name Pozniaky

**Водій:** Нет, я не там

**NAVIA:** Хорошо, вернулись к прежней оценке позиции — что видите сейчас рядом?

Tools: undo_position_fix→undone · 4.9 s

- PASS undo_position_fix called

## S3 same words between the stations → one question (Pozniaky or Kharkivska), then the answer fixes it

**Водій:** Вижу станцию метро, хз какая, а напротив магазин Днипро-М

**NAVIA:** Это метро «Позняки» или «Харківська»?

Tools: locate_by_description→ambiguous · 5.4 s

- PASS locate_by_description called
- PASS no fix while ambiguous
- PASS asks Pozniaky or Kharkivska

**Водій:** Харьковская

**NAVIA:** Вы у метро «Харківська», рядом «Дніпро-М». Через примерно 80 метров — небольшой поворот налево, на E 40.

Tools: locate_by_description→unique, confirm_position→done · 6.2 s

- PASS fixed after the answer

## S4 a landmark the map does not have → says so, asks for another, invents nothing

**Водій:** Вижу справа Икею

**NAVIA:** На карте рядом с оценённой позицией IKEA не находится. Подскажите, видите ли поблизости ещё что-то — заправку, остановку или название улицы?

Tools: locate_by_description→none · 5.5 s

- PASS locate_by_description called
- PASS no fix
- PASS asks for something else

## S5 two Fora stores (Russian) → asks the side of the road

**Водій:** Вижу Фору, а за ней перекрёсток

**NAVIA:** С какой стороны Фора — слева или справа?

Tools: locate_by_description→ambiguous · 6.1 s

- PASS locate_by_description called
- PASS no fix while ambiguous
- PASS asks left or right
