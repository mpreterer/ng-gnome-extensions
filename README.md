# ❄ ng-gnome-extensions

New Year extensions for the GNOME desktop: snow you can make snowmen from, a garland, Ded Moroz on a sleigh, snowballs, fireworks you light with a lighter, and a Christmas tree to decorate.
Новогодние расширения для рабочего стола GNOME: снег, из которого лепятся снеговики, гирлянда, Дед Мороз на санях, снежки, фейерверк с зажигалкой и ёлка, которую можно нарядить.

![Desktop](screenshots/desktop.png)

**[English](#english) · [Русский](#русский)**

---

## English

### Install

Open a terminal and run:

```bash
git clone https://github.com/mpreterer/ng-gnome-extensions.git
cd ng-gnome-extensions
./install.sh
```

Then restart GNOME Shell:

- **X11** (default on Ubuntu 22.04 with NVIDIA, or if you chose “Ubuntu on Xorg”): press `Alt+F2`, type `r`, press `Enter`.
- **Wayland**: log out and log back in.

That’s it. Six icons appear on the top bar — click any of them to control it or open **Settings…**

**Already installed an older version?** Update the same way:

```bash
cd ng-gnome-extensions
git pull
./install.sh
```

### What you get

| | Extension | What it does | Hotkey |
|---|---|---|---|
| ❄ | **Snowfall Physics** | Snow falls and piles up into thick drifts on window title bars and at the bottom of the screen. Roll snowballs with the pointer and stack them into snowmen | `Super+Alt+X` |
| 💡 | **Garland Lights** | A blinking garland along the top of the screen; pull the cord on the right to switch the lights | `Super+Alt+G` |
| 🛷 | **Ded Moroz Sleigh** | Ded Moroz on a reindeer sleigh rides along the bottom of the screen every few hours. Hits a snowball — the sleigh flips over | `Super+Alt+D` — ride now |
| ⚪ | **Snowball Fight** | A pile of snowballs on the desktop: grab one with the mouse and throw it at the screen edge | `Super+Alt+B` |
| 🎆 | **Fireworks** | Put rockets, firework cakes and fountains on the screen and light them with the mouse like a lighter | `Super+Alt+F` — show now |
| 🎄 | **Christmas Tree** | A tree and a box of toys: hang the toys with the mouse, put the star on top. The decorations are kept after a reboot | — |

Each one can be shown **above windows**, **only on an empty desktop**, or **below windows**.
The language (English / Russian) follows your system; you can change it in **Settings…**

### How to play

#### ❄ Snow, snowballs and snowmen

![Snow](screenshots/snow.png)

- Snow piles up into a thick cap on the top edge of windows and at the bottom of the screen. Want it right now? Snow icon → **Pile up snow now**.
- Shake or drag a window and the snow falls off; close or minimize it and everything on it falls down.
- **Roll a snowball:** move the pointer along a drift (no click). The snow rolls into a ball that grows and leaves a clean track.
- **Make a snowman:** grab a ball with the mouse and drop it onto another ball. 2–5 balls make a snowman with a hat, a scarf, a carrot nose and branch arms; 4 balls add mittens and a broom, 5 add a star on the hat.
- Grab a snowman by the head to take the head off; by the bottom ball to move the whole snowman.

#### 💡 Garland

![Garland](screenshots/garland.png)

Pull the cord on the right down with the mouse to switch the lights on or off. Blink mode, colors and wire color are in the menu and settings.

#### 🛷 Ded Moroz

![Ded Moroz](screenshots/sleigh.png)

Rides by itself every 3 hours (change it in the menu), or press `Super+Alt+D`. Snow flies up from under the runners.
**Put a snowball in his way** (roll one along the bottom drift): the sleigh crashes into it, the ball bursts into snow, the sleigh flips upside down and Ded Moroz waves his arms — then it flips back and rides on.

![Sleigh crash](screenshots/sleigh-crash.png)

#### ⚪ Snowballs

![Snowballs](screenshots/snowballs.png)

Grab a snowball from the pile in the corner and throw it — it splats on the screen edge and slowly slides down. By default the pile is visible on an empty desktop.

#### 🎆 Fireworks

![Fireworks](screenshots/fireworks.png)

1. Firework icon → **Place a rocket / Place a firework cake / Place a fountain**, then click on the screen (right click or Esc when done).
2. Point at a firework — the pointer turns into a lighter. **Hold the mouse button** until the fuse catches.
3. A rocket shoots up and bursts, a cake fires 12 shots, a fountain sprays sparks. Right click a firework to remove it.

**Fireworks now!** (`Super+Alt+F`) launches a show without any setup.

![Lighter](screenshots/fireworks-lighter.png)

#### 🎄 Christmas tree

![Christmas tree](screenshots/tree.png)

- Take a toy from the box next to the tree and release it over a branch — it hangs right there and sways. The big star goes on the top.
- Drag a toy off the tree to remove it. **Decorate automatically** and **Take all toys off** are in the menu.
- The toy box can be hidden once the tree is decorated.
- While the Snowfall extension is snowing, a little snow piles up on the branches and slowly melts afterwards.

![Menus](screenshots/menus.png)

### Uninstall

```bash
cd ng-gnome-extensions
./uninstall.sh
```

### Requirements

GNOME Shell **42** (Ubuntu 22.04). Other versions are not tested.

If something goes wrong, turn off one extension:

```bash
gnome-extensions disable snowfall-physics@local
```

(the others: `garland-lights@local`, `ded-moroz-sleigh@local`, `snowball-fight@local`, `fireworks@local`, `christmas-tree@local`)

---

## Русский

### Установка

Откройте терминал и выполните:

```bash
git clone https://github.com/mpreterer/ng-gnome-extensions.git
cd ng-gnome-extensions
./install.sh
```

Затем перезапустите GNOME Shell:

- **X11** (по умолчанию в Ubuntu 22.04 с видеокартой NVIDIA или если выбран «Ubuntu on Xorg»): нажмите `Alt+F2`, введите `r`, нажмите `Enter`.
- **Wayland**: выйдите из системы и войдите снова.

Всё. На верхней панели появятся шесть значков — нажмите на любой, чтобы управлять им или открыть **Настройки…**

**Уже стояла старая версия?** Обновление — так же:

```bash
cd ng-gnome-extensions
git pull
./install.sh
```

### Что внутри

| | Расширение | Что делает | Клавиши |
|---|---|---|---|
| ❄ | **Снег** | Падает и копится плотными сугробами на заголовках окон и внизу экрана. Курсором скатываются снежки, из них складываются снеговики | `Super+Alt+X` |
| 💡 | **Гирлянда** | Мигающая гирлянда вдоль верха экрана; потяните шнурок справа, чтобы включить или выключить свет | `Super+Alt+G` |
| 🛷 | **Дед Мороз** | Раз в несколько часов проезжает на санях с оленями по низу экрана. Врезался в снежный шар — сани переворачиваются | `Super+Alt+D` — проехать сейчас |
| ⚪ | **Снежки** | Горка снежков на рабочем столе: хватайте мышью и бросайте в край экрана | `Super+Alt+B` |
| 🎆 | **Фейерверк** | Ставьте на экран ракеты, батареи салютов и фонтаны и поджигайте их мышкой, как зажигалкой | `Super+Alt+F` — салют сейчас |
| 🎄 | **Ёлка** | Ёлка и ящик игрушек: вешайте игрушки мышью, ставьте звезду на макушку. Наряд сохраняется после перезагрузки | — |

Каждое можно показывать **поверх окон**, **только на пустом рабочем столе** или **под окнами**.
Язык (русский / английский) берётся из системы, его можно поменять в **Настройках…**

### Как играть

#### ❄ Снег, снежки и снеговики

![Снег](screenshots/snow.png)

- Снег копится плотной шапкой на верхней кромке окон и внизу экрана. Хотите сразу — значок снега → **Намести сугробы**.
- Потрясите или сдвиньте окно — снег осыплется; закройте или сверните — всё, что на нём, упадёт вниз.
- **Скатать снежок:** проведите курсором вдоль сугроба (без нажатия). Снег скатывается в шар, шар растёт и оставляет чистую колею.
- **Слепить снеговика:** возьмите шар мышью и отпустите над другим шаром. Из 2–5 шаров получается снеговик в шапке и шарфе, с носом-морковкой и руками-ветками; с 4 шаров — варежки и метла, с 5 — звезда на шапке.
- Схватите снеговика за голову — снимете голову; за нижний шар — перенесёте целиком.

#### 💡 Гирлянда

![Гирлянда](screenshots/garland.png)

Потяните мышью шнурок справа вниз — свет включится или выключится. Режим мигания, цвета лампочек и цвет провода — в меню и настройках.

#### 🛷 Дед Мороз

![Дед Мороз](screenshots/sleigh.png)

Проезжает сам раз в 3 часа (меняется в меню) или по `Super+Alt+D`. Из-под полозьев летит снег.
**Поставьте у него на пути снежный шар** (скатайте его по нижнему сугробу): сани врезаются, шар разлетается снегом, сани переворачиваются вверх полозьями, Дед Мороз машет руками — потом кувырок обратно, и упряжка едет дальше.

![Сани перевернулись](screenshots/sleigh-crash.png)

#### ⚪ Снежки

![Снежки](screenshots/snowballs.png)

Возьмите снежок из горки в углу и бросьте — он разобьётся о край экрана и медленно сползёт. По умолчанию горка видна на пустом рабочем столе.

#### 🎆 Фейерверк

![Фейерверк](screenshots/fireworks.png)

1. Значок салюта → **Поставить ракету / батарею салютов / фонтан**, затем щёлкайте по экрану (правая кнопка или Esc — готово).
2. Наведите курсор на фейерверк — он станет зажигалкой. **Зажмите кнопку мыши**, пока не загорится фитиль.
3. Ракета взлетает и взрывается, батарея даёт 12 залпов, фонтан бьёт искрами. Правая кнопка по фейерверку — убрать его.

**Салют сейчас!** (`Super+Alt+F`) — залп без подготовки.

![Зажигалка](screenshots/fireworks-lighter.png)

#### 🎄 Ёлка

![Ёлка](screenshots/tree.png)

- Возьмите игрушку из ящика у ёлки и отпустите над веткой — она повиснет там и покачается. Большая звезда ставится на макушку.
- Утащите игрушку с ёлки — снимете её. В меню есть **Нарядить автоматически** и **Снять все игрушки**.
- Ящик с игрушками можно убрать, когда ёлка наряжена.
- Пока идёт снег из расширения «Снег», на ветках понемногу копится снег, потом медленно тает.

![Меню](screenshots/menus.png)

### Удаление

```bash
cd ng-gnome-extensions
./uninstall.sh
```

### Требования

GNOME Shell **42** (Ubuntu 22.04). На других версиях не проверялось.

Если что-то пошло не так, выключите одно расширение:

```bash
gnome-extensions disable snowfall-physics@local
```

(остальные: `garland-lights@local`, `ded-moroz-sleigh@local`, `snowball-fight@local`, `fireworks@local`, `christmas-tree@local`)
