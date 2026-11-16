/* Christmas Tree — GNOME Shell 42 extension.
 *
 * На рабочем столе стоит ёлка, рядом — ящик с игрушками. Игрушку берут из
 * ящика мышью и отпускают над ёлкой — она повисает на этом месте (крючок там,
 * где отпустили). Большая звезда ставится на макушку. Повешенную игрушку
 * можно перевесить или снять: утащить с ёлки — упадёт и исчезнет.
 * Наряд и снег на ветках сохраняются в настройках — после перезагрузки ёлка
 * такая же. Снег на ветках копится, пока идёт снег из расширения «Снег»
 * (оно отмечает globalThis.__festiveSnowStamp), и медленно тает без него.
 *
 * Нагрузка: ёлка — одна картинка, перерисовывается только при изменении
 * снега. Постоянных таймеров анимации нет (покачивание игрушек — Clutter ease).
 */
'use strict';

const { GLib, Clutter, St, Meta, Shell } = imports.gi;

const Main = imports.ui.main;
const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const I18n = Me.imports.i18n;
const T = I18n.T;
const Festive = Me.imports.festive;
const Art = Me.imports.art;

const MAX_TOYS = 90;
const SNOW_STEP = 10;          // как часто проверять снегопад, с
const SNOW_FILL = 1200;        // за сколько секунд снегопада ветки покрываются полностью
const SNOW_MELT = 3600;        // за сколько секунд без снега тает
const SNOW_MAX = 0.85;         // «немного»: шапки не превращаются в сугробы
const SLOTS = [
    ['ball', 'red'], ['ball', 'blue'], ['ball', 'gold'], ['star'], ['bell'], ['cane'], ['top'],
    ['ball', 'silver'], ['ball', 'green'], ['ball', 'purple'], ['ball', 'pink'], ['icicle'], ['cone'], ['flake'],
];

function rand(a, b) {
    return a + Math.random() * (b - a);
}

class Tree {
    constructor(settings) {
        this._settings = settings;
        this._running = false;
    }

    start() {
        if (this._running)
            return;
        this._running = true;
        this._signals = [];
        this._toys = [];      // повешенные: {t, c, x, y, actor}
        this._slots = [];
        this._drag = null;
        this._s = undefined;   // при повторном включении всё строится заново

        this._layer = new Clutter.Actor({ name: 'christmas-tree-layer', reactive: false });
        this._fl = new Festive.FestiveLayer('christmas-tree', this._settings, () => {
            if (this._fl && !this._fl.shown)
                this._endDrag(false);
            this._syncInput();
        });
        this._fl.actor.add_child(this._layer);

        this._snow = this._settings.get_double('snow-amount');
        this._treeArea = new St.DrawingArea({ reactive: false });
        this._treeArea.connect('repaint', a => {
            const cr = a.get_context();
            cr.scale(this._s, this._s);
            cr.translate(Art.TREE_W / 2, Art.TREE_H);
            Art.drawTree(cr, this._shownSnow());
            cr.$dispose();
        });
        this._hangBox = new Clutter.Actor({ reactive: false });
        this._boxBack = new St.DrawingArea({ reactive: false });
        this._boxBack.connect('repaint', a => {
            const cr = a.get_context();
            cr.scale(this._s, this._s);
            Art.drawBoxBack(cr);
            cr.$dispose();
        });
        this._slotBox = new Clutter.Actor({ reactive: false });
        this._boxFront = new St.DrawingArea({ reactive: false });
        this._boxFront.connect('repaint', a => {
            const cr = a.get_context();
            cr.scale(this._s, this._s);
            Art.drawBoxFront(cr);
            cr.$dispose();
        });
        for (const a of [this._treeArea, this._hangBox, this._boxBack, this._slotBox, this._boxFront])
            this._layer.add_child(a);

        const relayout = () => this._layout();
        this._connect(Main.layoutManager, 'monitors-changed', relayout);
        this._connect(global.display, 'workareas-changed', relayout);
        if (Main.layoutManager._startingUp)
            this._connect(Main.layoutManager, 'startup-complete', relayout);
        for (const key of ['position', 'tree-size'])
            this._connect(this._settings, `changed::${key}`, relayout);
        this._connect(this._settings, 'changed::show-box', () => this._syncBox());
        this._connect(this._settings, 'changed::tree-snow', () => this._snowTick());
        this._connect(Main.overview, 'showing', () => {
            this._endDrag(false);
            this._syncInput();
        });
        this._connect(Main.overview, 'hidden', () => this._syncInput());
        this._connect(global.display, 'restacked', () => this._syncInput());
        this._connect(global.display, 'grab-op-end', () => this._syncInput());
        this._connect(global.workspace_manager, 'active-workspace-changed', () => this._syncInput());

        this._layout();
        this._syncBox();
        this._snowId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, SNOW_STEP, () => {
            this._snowTick();
            return GLib.SOURCE_CONTINUE;
        });
    }

    stop() {
        if (!this._running)
            return;
        this._running = false;
        this._endDrag(false);
        if (this._snowId) {
            GLib.source_remove(this._snowId);
            this._snowId = 0;
        }
        this._settings.set_double('snow-amount', this._snow);
        for (const [obj, id] of this._signals)
            obj.disconnect(id);
        this._signals = [];
        for (const a of this._inputActors())
            this._untrack(a);
        this._layer.destroy();
        this._layer = null;
        this._fl.destroy();
        this._fl = null;
        this._toys = [];
        this._slots = [];
    }

    _connect(obj, signal, cb) {
        this._signals.push([obj, obj.connect(signal, cb)]);
    }

    // ---------- раскладка ----------

    _layout() {
        if (!this._running)
            return;
        const s = this._settings.get_double('tree-size');
        const sizeChanged = s !== this._s;
        this._s = s;
        const mon = Main.layoutManager.primaryMonitor;
        if (!mon)
            return;
        const wa = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
        const ground = wa.y + wa.height - 6;
        const half = Art.TREE_W / 2 * s;
        const boxW = Art.BOX_W * s;
        const pos = this._settings.get_string('position');
        let tx, bx;
        if (pos === 'left') {
            tx = wa.x + half + 10;
            bx = tx + half * 0.85;
        } else if (pos === 'center') {
            tx = wa.x + wa.width / 2;
            bx = tx + half * 0.85;
        } else {
            tx = wa.x + wa.width - half - 10;
            bx = tx - half * 0.85 - boxW;
        }
        this._tx = tx;
        this._ty = ground;
        this._treeArea.set_size(Math.ceil(Art.TREE_W * s), Math.ceil((Art.TREE_H + Art.FOOT) * s));
        this._treeArea.set_position(Math.round(tx - half), Math.round(ground - Art.TREE_H * s));
        this._hangBox.set_position(Math.round(tx), Math.round(ground));
        // ящик стоит на полу рядом с ёлкой
        const boxTop = ground - Art.BOX_H * s;
        this._boxBack.set_size(Math.ceil(boxW), Math.ceil(Art.BOX_H * s));
        this._boxBack.set_position(Math.round(bx), Math.round(boxTop));
        this._boxFront.set_size(Math.ceil(boxW), Math.ceil(30 * s));
        this._boxFront.set_position(Math.round(bx), Math.round(ground - 30 * s));
        this._bx = bx;
        this._boxTop = boxTop;
        if (sizeChanged) {
            this._treeArea.queue_repaint();
            this._boxBack.queue_repaint();
            this._boxFront.queue_repaint();
            this._buildSlots();
            this._loadDecor();
        } else {
            this._placeSlots();
            for (const toy of this._toys)
                this._placeHung(toy);
        }
        this._syncInput();
    }

    // ящик с игрушками можно убрать (игрушки на ёлке остаются)
    _syncBox() {
        const show = this._settings.get_boolean('show-box');
        for (const a of [this._boxBack, this._slotBox, this._boxFront])
            a.visible = show;
        this._syncInput();
    }

    // ---------- игрушки ----------

    _makeToy(t, c, scale = 1) {
        const [w, h] = Art.TOY_SIZE[t];
        const s = this._s * scale;
        const a = new St.DrawingArea({ reactive: true, width: Math.ceil(w * s), height: Math.ceil(h * s), name: 'christmas-toy' });
        a.connect('repaint', area => {
            const cr = area.get_context();
            cr.scale(s, s);
            Art.drawToy(cr, t, c);
            cr.$dispose();
        });
        // вращение (покачивание) — вокруг крючка; у звезды на макушке — вокруг низа
        a.set_pivot_point(0.5, t === 'top' ? 1 : 3 / h);
        a._hook = t === 'top' ? [w * s / 2, h * s] : [w * s / 2, 3 * s];
        return a;
    }

    _buildSlots() {
        for (const sl of this._slots)
            sl.actor.destroy();
        this._slots = [];
        SLOTS.forEach(([t, c], i) => {
            const small = t === 'top' ? 0.6 : 1;
            const a = this._makeToy(t, c, small);
            const slot = { t, c, actor: a, i };
            a.connect('button-press-event', (actor, ev) => {
                if (ev.get_button() !== Clutter.BUTTON_PRIMARY)
                    return Clutter.EVENT_PROPAGATE;
                this._startDrag({ t, c, fromSlot: true }, ev, a);
                return Clutter.EVENT_STOP;
            });
            this._hoverCursor(a);
            this._slotBox.add_child(a);
            this._slots.push(slot);
        });
        this._placeSlots();
    }

    // два ряда в ящике: задний повыше, передний пониже
    _placeSlots() {
        const s = this._s;
        const perRow = 7;
        for (const sl of this._slots) {
            const row = Math.floor(sl.i / perRow), col = sl.i % perRow;
            const step = (Art.BOX_W - 24) / perRow;
            const cx = this._bx + (12 + step * (col + 0.5) + (row ? step * 0.3 : 0)) * s;
            const top = this._boxTop + (row ? 2 : -14) * s;
            sl.actor.set_position(Math.round(cx - sl.actor.width / 2), Math.round(top));
        }
        // задний ряд за передним
        for (const sl of this._slots) {
            if (sl.i < perRow)
                this._slotBox.set_child_below_sibling(sl.actor, null);
        }
    }

    _hoverCursor(a) {
        a.connect('enter-event', () => {
            if (!this._drag)
                global.display.set_cursor(Meta.Cursor.POINTING_HAND);
            return Clutter.EVENT_PROPAGATE;
        });
        a.connect('leave-event', () => {
            if (!this._drag)
                global.display.set_cursor(Meta.Cursor.DEFAULT);
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _swing(a, deg) {
        a.remove_transition('rotation-angle-z');
        a.rotation_angle_z = deg;
        a.ease({ rotation_angle_z: 0, duration: 1600, mode: Clutter.AnimationMode.EASE_OUT_ELASTIC });
    }

    _hang(toy, save = true, swing = true) {
        const a = toy.actor || this._makeToy(toy.t, toy.c);
        toy.actor = a;
        if (a.get_parent())
            a.get_parent().remove_child(a);
        this._hangBox.add_child(a);
        if (!a._hangWired) {
            a._hangWired = true;
            a.connect('button-press-event', (actor, ev) => {
                if (ev.get_button() !== Clutter.BUTTON_PRIMARY || !this._toys.includes(toy))
                    return Clutter.EVENT_PROPAGATE;
                this._startDrag(toy, ev, a);
                return Clutter.EVENT_STOP;
            });
            a.connect('enter-event', () => {
                if (!this._drag && toy.t !== 'top' && this._toys.includes(toy))
                    this._swing(a, rand(-10, 10));
                return Clutter.EVENT_PROPAGATE;
            });
            this._hoverCursor(a);
        }
        if (toy.t === 'top') {
            // одна звезда на макушке
            for (const o of [...this._toys]) {
                if (o.t === 'top' && o !== toy)
                    this._dropToy(o);
            }
        }
        if (!this._toys.includes(toy))
            this._toys.push(toy);
        this._placeHung(toy);
        if (swing && toy.t !== 'top')
            this._swing(a, rand(-18, 18));
        if (save)
            this._save();
        this._syncInput();
    }

    _placeHung(toy) {
        const s = this._s;
        const a = toy.actor;
        const [hx, hy] = a._hook;
        a.set_position(Math.round(toy.x * s - hx), Math.round(toy.y * s - hy));
    }

    // игрушка падает и исчезает
    _dropToy(toy) {
        const i = this._toys.indexOf(toy);
        if (i >= 0)
            this._toys.splice(i, 1);
        this._fall(toy.actor);
    }

    _fall(a) {
        this._untrack(a);
        a.reactive = false;
        a.ease({
            translation_y: 60,
            opacity: 0,
            duration: 500,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => a.destroy(),
        });
    }

    _save() {
        const list = this._toys.map(o => ({ t: o.t, c: o.c, x: Math.round(o.x * 10) / 10, y: Math.round(o.y * 10) / 10 }));
        this._settings.set_string('decor', JSON.stringify(list));
    }

    _loadDecor() {
        for (const o of this._toys)
            o.actor?.destroy();
        this._toys = [];
        let list = [];
        try {
            list = JSON.parse(this._settings.get_string('decor'));
        } catch (e) {
            list = [];
        }
        for (const d of Array.isArray(list) ? list : []) {
            if (!Art.TOY_SIZE[d.t] || typeof d.x !== 'number' || typeof d.y !== 'number')
                continue;
            this._hang({ t: d.t, c: d.c, x: d.t === 'top' ? 0 : d.x, y: d.t === 'top' ? Art.APEX + 6 : d.y }, false, false);
        }
    }

    // можно ли повесить крючок в точку (x, y) (в координатах ёлки)
    _onTree(x, y) {
        if (y > -52)
            return false;
        const hw = Art.halfWidthAt(y);
        return hw > 0 && Math.abs(x) <= hw - 3;
    }

    decorate() {
        if (!this._running)
            return;
        const types = ['ball', 'ball', 'ball', 'ball', 'ball', 'bell', 'cane', 'icicle', 'cone', 'flake', 'star'];
        const colors = Object.keys(Art.BALL_COLORS);
        let added = 0;
        for (let tries = 0; tries < 2000 && added < 24 && this._toys.length < MAX_TOYS; tries++) {
            const y = rand(Art.APEX + 30, -60);
            const hw = Art.halfWidthAt(y);
            if (hw <= 10)
                continue;
            const x = rand(-hw + 8, hw - 8);
            if (this._toys.some(o => Math.hypot(o.x - x, o.y - y) < 30))
                continue;
            const t = types[(Math.random() * types.length) | 0];
            this._hang({ t, c: colors[(Math.random() * colors.length) | 0], x, y }, false, true);
            added++;
        }
        if (!this._toys.some(o => o.t === 'top'))
            this._hang({ t: 'top', c: null, x: 0, y: Art.APEX + 6 }, false, false);
        this._save();
    }

    undecorate() {
        if (!this._running)
            return;
        for (const o of [...this._toys])
            this._dropToy(o);
        this._save();
    }

    // ---------- перенос мышью ----------

    _startDrag(toy, ev, srcActor) {
        if (this._drag || !this._running)
            return;
        const [x, y] = ev.get_coords();
        let a, fromTree = false;
        if (toy.fromSlot) {
            if (this._toys.length >= MAX_TOYS)
                return;
            a = this._makeToy(toy.t, toy.c);
            toy = { t: toy.t, c: toy.c, x: 0, y: 0 };
        } else {
            fromTree = true;
            a = srcActor;
            this._untrack(a);
            this._toys.splice(this._toys.indexOf(toy), 1);
            a.get_parent()?.remove_child(a);
        }
        a.remove_all_transitions();
        a.rotation_angle_z = 0;
        Main.layoutManager.uiGroup.add_child(a);
        // за что взяли — относительно крючка
        let offX = 0, offY = -a._hook[1] - 4;
        if (fromTree) {
            const [ok, lx, ly] = srcActor.transform_stage_point(x, y);
            if (ok) {
                offX = a._hook[0] - lx;
                offY = a._hook[1] - ly;
            }
        }
        toy.actor = a;
        const grab = Main.pushModal(a, { actionMode: Shell.ActionMode.NORMAL });
        this._drag = { toy, a, grab, offX, offY, fromTree, orig: fromTree ? [toy.x, toy.y] : null, lastX: x };
        global.display.set_cursor(Meta.Cursor.DND_IN_DRAG);
        this._drag.id = a.connect('captured-event', (actor, e) => this._onDragEvent(e));
        this._moveDrag(x, y);
    }

    _moveDrag(x, y) {
        const d = this._drag;
        const hx = x + d.offX, hy = y + d.offY;
        d.a.set_position(Math.round(hx - d.a._hook[0]), Math.round(hy - d.a._hook[1]));
        // игрушка на ниточке чуть отклоняется при движении
        const v = Math.max(-25, Math.min(25, (x - d.lastX) * 1.5));
        d.lastX = x;
        if (d.toy.t !== 'top')
            d.a.rotation_angle_z = d.a.rotation_angle_z * 0.6 - v * 0.4;
    }

    _onDragEvent(ev) {
        const d = this._drag;
        if (!d)
            return Clutter.EVENT_PROPAGATE;
        const type = ev.type();
        // пересечения границ акторов Clutter требует пропускать дальше
        if (type === Clutter.EventType.ENTER || type === Clutter.EventType.LEAVE)
            return Clutter.EVENT_PROPAGATE;
        if (type === Clutter.EventType.MOTION) {
            this._moveDrag(...ev.get_coords());
        } else if (type === Clutter.EventType.BUTTON_RELEASE) {
            this._endDrag(true, ev.get_coords());
        } else if (type === Clutter.EventType.KEY_PRESS && ev.get_key_symbol() === Clutter.KEY_Escape) {
            this._endDrag(false);
        }
        return Clutter.EVENT_STOP;
    }

    _endDrag(drop, coords) {
        const d = this._drag;
        if (!d)
            return;
        this._drag = null;
        d.a.disconnect(d.id);
        try {
            Main.popModal(d.grab);
        } catch (e) {
            logError(e, 'christmas-tree: popModal');
        }
        global.display.set_cursor(Meta.Cursor.DEFAULT);
        const toy = d.toy;
        if (!this._running) {
            d.a.destroy();
            return;
        }
        if (drop && coords) {
            const s = this._s;
            const hx = (coords[0] + d.offX - this._tx) / s;
            const hy = (coords[1] + d.offY - this._ty) / s;
            const apexDist = Math.hypot(hx, hy - (Art.APEX + 6));
            if (toy.t === 'top') {
                // большая звезда встаёт только на макушку
                if (apexDist < 60) {
                    toy.x = 0;
                    toy.y = Art.APEX + 6;
                    this._hang(toy);
                    return;
                }
            } else if (this._onTree(hx, hy)) {
                toy.x = hx;
                toy.y = hy;
                this._hang(toy);
                return;
            }
        } else if (!drop && d.fromTree) {
            // Esc — вернуть на прежнее место
            [toy.x, toy.y] = d.orig;
            this._hang(toy, true, false);
            return;
        }
        // мимо ёлки — падает и исчезает
        this._fall(d.a);
        if (d.fromTree)
            this._save();
    }

    // ---------- область ввода ----------

    _inputActors() {
        const slots = this._settings.get_boolean('show-box') ? this._slots.map(sl => sl.actor) : [];
        return [...slots, ...this._toys.map(o => o.actor)].filter(a => a);
    }

    _track(a) {
        if (!a._tracked) {
            Main.layoutManager.trackChrome(a, { affectsInputRegion: true });
            a._tracked = true;
        }
    }

    _untrack(a) {
        if (a._tracked) {
            Main.layoutManager.untrackChrome(a);
            a._tracked = false;
        }
    }

    _windowRects() {
        const ws = global.workspace_manager.get_active_workspace();
        const out = [];
        for (const actor of global.get_window_actors()) {
            const w = actor.meta_window;
            if (!w || !actor.visible || w.minimized || !w.located_on_workspace(ws))
                continue;
            const type = w.get_window_type();
            if (type === Meta.WindowType.DESKTOP || type === Meta.WindowType.DOCK)
                continue;
            out.push(w.get_frame_rect());
        }
        return out;
    }

    // Игрушки ловят мышь, только когда их видно (окно сверху — клики окну).
    _syncInput() {
        if (!this._running)
            return;
        const shown = this._fl && this._fl.shown && !Main.overview.visible;
        const above = this._fl && this._fl.mode === 'above';
        const rects = shown && !above ? this._windowRects() : [];
        // убранный ящик мышь не ловит
        for (const sl of this._slots) {
            if (!this._settings.get_boolean('show-box'))
                this._untrack(sl.actor);
        }
        for (const a of this._inputActors()) {
            let want = shown;
            if (want && !above) {
                const [x, y] = a.get_transformed_position();
                const cx = x + a.width / 2, cy = y + a.height / 2;
                want = !rects.some(r => cx >= r.x && cx < r.x + r.width && cy >= r.y && cy < r.y + r.height);
            }
            if (want)
                this._track(a);
            else
                this._untrack(a);
        }
    }

    // ---------- снег на ветках ----------

    _shownSnow() {
        const mode = this._settings.get_string('tree-snow');
        if (mode === 'never')
            return 0;
        if (mode === 'always')
            return 0.65;
        return this._snow;
    }

    _snowTick() {
        if (!this._running)
            return;
        const before = this._shownSnow();
        if (this._settings.get_string('tree-snow') === 'snowfall') {
            const stamp = globalThis.__festiveSnowStamp || 0;
            const snowing = GLib.get_monotonic_time() / 1e6 - stamp < 3;
            const prev = this._snow;
            if (snowing)
                this._snow = Math.min(SNOW_MAX, this._snow + SNOW_STEP / SNOW_FILL);
            else
                this._snow = Math.max(0, this._snow - SNOW_STEP / SNOW_MELT);
            // в настройки — не каждый раз, а заметными шагами
            if (Math.abs(this._snow - this._savedSnow) >= 0.05 || (this._snow === 0 && prev > 0) ||
                this._savedSnow === undefined) {
                this._savedSnow = this._snow;
                this._settings.set_double('snow-amount', this._snow);
            }
        }
        if (Math.abs(this._shownSnow() - before) > 0.001 || this._lastPainted === undefined ||
            Math.abs(this._shownSnow() - this._lastPainted) >= 0.01) {
            this._lastPainted = this._shownSnow();
            this._treeArea.queue_repaint();
        }
    }
}

class Extension {
    enable() {
        this._settings = ExtensionUtils.getSettings();
        I18n.bindSettings(this._settings);
        this._tree = new Tree(this._settings);
        this._id = this._settings.connect('changed::enabled', () => this._sync());
        this._sync();
        this._indicator = new Festive.IndicatorManager('christmas-tree', () => T('Ёлка', 'Christmas tree'),
            `${Me.path}/icons/tree-symbolic.svg`, this._settings, ind => {
                ind.addSwitch(T('Ёлка', 'Christmas tree'), 'enabled');
                ind.addLabel(() => T('Игрушки — в ящике рядом: тащите мышью на ёлку', 'Toys are in the box: drag them onto the tree'));
                ind.addSwitch(T('Ящик с игрушками', 'Toy box'), 'show-box');
                ind.addAction(T('Нарядить автоматически', 'Decorate automatically'), () => this._tree.decorate());
                ind.addAction(T('Снять все игрушки', 'Take all toys off'), () => this._tree.undecorate());
                ind.addSeparator();
                ind.addChoice(T('Где стоит', 'Position'), 'position', [
                    ['right', T('справа', 'right')], ['center', T('по центру', 'center')], ['left', T('слева', 'left')],
                ]);
                ind.addChoice(T('Снег на ветках', 'Snow on branches'), 'tree-snow', [
                    ['snowfall', T('копится в снегопад', 'piles up while it snows')],
                    ['always', T('всегда', 'always')], ['never', T('нет', 'none')],
                ]);
                ind.addVisibility();
                ind.addSlider(T('Размер', 'Size'), 'tree-size', 0.5, 1.6, false, v => `${Math.round(v * 100)}%`);
                ind.addSeparator();
                ind.addPrefs();
            });
    }

    disable() {
        this._indicator.destroy();
        this._indicator = null;
        this._settings.disconnect(this._id);
        this._tree.stop();
        this._tree = null;
        this._settings = null;
    }

    _sync() {
        if (this._settings.get_boolean('enabled'))
            this._tree.start();
        else
            this._tree.stop();
    }
}

function init() {
    return new Extension();
}
