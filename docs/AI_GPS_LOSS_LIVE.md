# Live check: GPS loss → locate by what the driver sees

Run 2026-09-30T13:43:54.518Z · real model through the NAVIA proxy · real OSM data of Kyiv (fixtures) · NavigationEngine route dead reckoning.
**Result: 18/18 checks pass.**


## S1 GPS lost: «Пропал навигатор» → honest state + asks what the driver sees

**Водій:** Пропал навигатор, что делать?

**NAVIA:** GPS потерян, но навигация работает по датчикам движения — NAVIA вас отслеживает. Что вы видите прямо сейчас на дороге?

Tools: none · 2.2 s

- PASS no position fix without evidence
- PASS asks what the driver sees
- PASS no exact metres

## S2 metro + Дніпро-М opposite, estimate near Kharkivska → locate, fix, guide

**Водій:** Вижу станцию метро, хз какая, а напротив магазин Днипро-М

**NAVIA:** Понял, вы у станции Харківська. Через примерно 80 метров — небольшой поворот левее на E 40.

Tools: locate_by_description→unique, confirm_position→done · 7.7 s

- PASS locate_by_description called
- PASS position fixed
- PASS names Kharkivska
- PASS does not name Pozniaky

**Водій:** Нет, я не там

**NAVIA:** Хорошо, вернулся к предыдущей позиции. Опишите, что видите — магазин, остановку, название улицы, что-нибудь ещё?

Tools: undo_position_fix→undone · 3.2 s

- PASS undo_position_fix called

## S3 same words between the stations → one question (Pozniaky or Kharkivska), then the answer fixes it

**Водій:** Вижу станцию метро, хз какая, а напротив магазин Днипро-М

**NAVIA:** Вижу, что рядом две станции. Какая это станция — Позняки или Харківська?

Tools: locate_by_description→ambiguous · 3.8 s

- PASS locate_by_description called
- PASS no fix while ambiguous
- PASS asks Pozniaky or Kharkivska

**Водій:** Харьковская

**NAVIA:** Впереди примерно через 80 метров легкий поворот влево на Е 40. Осталось 4 км.

Tools: locate_by_description→unique, confirm_position→done · 4.4 s

- PASS fixed after the answer

## S4 a landmark the map does not have → says so, asks for another, invents nothing

**Водій:** Вижу справа Икею

**NAVIA:** На карте рядом с вами ИКЕЮ не нашлось. Видите ещё что-то — заправку, остановку, название улицы?

Tools: check_landmark→position_uncertain_use_locate (refused), locate_by_description→none · 8.1 s

- PASS locate_by_description called
- PASS no fix
- PASS asks for something else

## S5 two Fora stores (Russian) → asks the side of the road

**Водій:** Вижу Фору, а за ней перекрёсток

**NAVIA:** С какой стороны от вас "Фора" — слева или справа?

Tools: check_landmark→position_uncertain_use_locate (refused), locate_by_description→ambiguous · 5.6 s

- PASS locate_by_description called
- PASS no fix while ambiguous
- PASS asks left or right
