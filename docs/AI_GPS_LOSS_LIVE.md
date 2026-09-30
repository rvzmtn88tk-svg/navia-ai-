# Live check: GPS loss → locate by what the driver sees

Run 2026-09-30T20:25:11.846Z · real model through the NAVIA proxy · real OSM data of Kyiv (fixtures) · NavigationEngine route dead reckoning.
**Result: 20/20 checks pass.**


## S1 GPS lost: «Пропал навигатор» → honest state + asks what the driver sees

**Водій:** Пропал навигатор, что делать?

**NAVIA:** GPS временно потерян, NAVIA ведёт по датчикам движения — скоро будет левый поворот на E 40, следите за дорогой; скажите, что видите вокруг, чтобы уточнить позицию.

Tools: none · 2.9 s

- PASS no position fix without evidence
- PASS asks what the driver sees
- PASS no exact metres

## S2 metro + Дніпро-М opposite, estimate near Kharkivska → locate, fix, guide

**Водій:** Вижу станцию метро, хз какая, а напротив магазин Днипро-М

**NAVIA:** Вы у метро «Харківська», через 80 метров плавный левый на Е 40.

Tools: locate_by_description→unique, confirm_position→done · 6.0 s

- PASS locate_by_description called
- PASS position fixed
- PASS names Kharkivska
- PASS does not name Pozniaky

**Водій:** Нет, я не там

**NAVIA:** Хорошо, отменено — что видите сейчас рядом?

Tools: undo_position_fix→undone · 3.4 s

- PASS undo_position_fix called

## S3 same words between the stations → one question (Pozniaky or Kharkivska), then the answer fixes it

**Водій:** Вижу станцию метро, хз какая, а напротив магазин Днипро-М

**NAVIA:** Уточните, пожалуйста: на табличке метро написано «Позняки» или «Харківська»?

Tools: locate_by_description→ambiguous · 4.8 s

- PASS locate_by_description called
- PASS no fix while ambiguous
- PASS asks Pozniaky or Kharkivska

**Водій:** Харьковская

**NAVIA:** Вы возле метро «Харківська» и «Дніпро-М». Через примерно 80 метров — небольшой поворот налево, на E 40.

Tools: locate_by_description→unique, confirm_position→done · 6.4 s

- PASS fixed after the answer

## S4 a landmark the map does not have → says so, asks for another, invents nothing

**Водій:** Вижу справа Икею

**NAVIA:** На карте рядом Икею не нашлось. Подскажите, может видите ещё что-то — заправку, остановку или название улицы?

Tools: locate_by_description→none · 4.7 s

- PASS locate_by_description called
- PASS no fix
- PASS asks for something else

## S5 two Fora stores (Russian) → asks the side of the road

**Водій:** Вижу Фору, а за ней перекрёсток

**NAVIA:** С какой стороны от вас Фора — слева или справа?

Tools: locate_by_description→ambiguous · 4.7 s

- PASS locate_by_description called
- PASS no fix while ambiguous
- PASS asks left or right

## S6 driver's words while GPS is gone → dead-reckoning evidence

**Водій:** стою в пробке

**NAVIA:** Зрозуміло, позиція зафіксована, не рухається.

Tools: report_driver_observation→applied · 3.7 s

- PASS report_driver_observation(stopped)

**Водій:** поехали, еду где-то 40

**NAVIA:** Принято, скорость учтена.

Tools: report_driver_observation→applied · 3.4 s

- PASS report_driver_observation(speed)
