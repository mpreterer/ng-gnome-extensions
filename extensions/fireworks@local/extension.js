/* Fireworks — GNOME Shell 42 extension.
 *
 * Фейерверк на рабочем столе: из меню ставите ракету, батарею салютов или
 * фонтан (щелчком в нужное место), подносите к ним курсор — он становится
 * зажигалкой — и зажимаете кнопку мыши: фитиль загорается, искра бежит
 * к заряду, и начинается салют. «Салют сейчас» (Super+Alt+F) запускает
 * залп без подготовки.
 *
 * Нагрузка: пока ничего не горит, таймера нет. Во время салюта — 60 кадров/с;
 * искры — акторы из пула с общими текстурами (по одной на цвет), двигаются
 * через translation/scale без пересчёта раскладки. Число искр ограничено.
 * Поставленные фейерверки ловят мышь только в своём маленьком прямоугольнике
 * и только когда их не закрывает окно.
 */
'use strict';

const { GLib, Clutter, St, Meta, Shell } = imports.gi;
const Cairo = imports.cairo;

const Main = imports.ui.main;
const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const I18n = Me.imports.i18n;
const T = I18n.T;
const Festive = Me.imports.festive;
const Art = Me.imports.art;

const TEX = 32;
const MARGIN = 16;          // запас вокруг изделия — легче попасть зажигалкой
const FUSE_TIME = 1.1;      // сколько горит фитиль, с
const HOLD_TIME = 0.3;      // сколько держать зажигалку у фитиля, с
const MAX_PARTICLES = 1400;
const MAX_ITEMS = 30;
const FUSE_BASE = { rocket: [2, -41], battery: [28, -12], fountain: [0, -48] };
const PALETTE = ['red', 'orange', 'gold', 'green', 'cyan', 'blue', 'purple', 'pink', 'silver'];
const BURSTS = ['peony', 'peony', 'ring', 'willow', 'crackle', 'double', 'strobe', 'heart'];

function pick(a) {
    return a[(Math.random() * a.length) | 0];
}

function rand(a, b) {
    return a + Math.random() * (b - a);
}

function makeCanvas(w, h, draw) {
    const canvas = new Clutter.Canvas();
    canvas.set_size(w, h);
    canvas.connect('draw', (c, cr, cw, ch) => {
        cr.save();
        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.restore();
        draw(cr, cw, ch);
        cr.$dispose();
        return true;
    });
    canvas.invalidate();
    return canvas;
}

class Fireworks {
    constructor(settings) {
        this._settings = settings;
        this._running = false;
    }

    start() {
        if (this._running)
            return;
        this._running = true;
        this._signals = [];
        this._timers = new Set();
        this._items = [];
        this._particles = [];
        this._pool = [];
        this._shells = [];
        this._emitters = [];
        this._hold = null;
        this._time = 0;

        this._tex = {};
        for (const [name, rgb] of Object.entries(Art.COLORS))
            this._tex[name] = makeCanvas(TEX, TEX, (cr, w) => Art.drawGlow(cr, w, rgb));

        this._layer = new Clutter.Actor({ name: 'fireworks-layer', reactive: false });
        this._fl = new Festive.FestiveLayer('fireworks', this._settings, () => {
            if (!this._fl || !this._fl.shown)
                this._cancelPlace();
            this._syncInput();
        });
        this._fl.actor.add_child(this._layer);
        this._itemBox = new Clutter.Actor({ reactive: false });
        this._fxBox = new Clutter.Actor({ reactive: false });
        this._layer.add_child(this._itemBox);
        this._layer.add_child(this._fxBox);

        this._buildLighter();

        this._connect(Main.overview, 'showing', () => {
            this._cancelPlace();
            this._hideLighter();
            this._layer.hide();
            this._syncInput();
        });
        this._connect(Main.overview, 'hidden', () => {
            this._layer.show();
            this._syncInput();
        });
        // окна сдвинули/перекрыли — пересчитать, какие фейерверки ловят мышь
        this._connect(global.display, 'restacked', () => this._syncInput());
        this._connect(global.display, 'grab-op-end', () => this._syncInput());
        this._connect(global.workspace_manager, 'active-workspace-changed', () => this._syncInput());

        this._loadItems();
    }

    stop() {
        if (!this._running)
            return;
        this._running = false;
        this._cancelPlace();
        this._stopTick();
        for (const id of this._timers)
            GLib.source_remove(id);
        this._timers.clear();
        for (const [obj, id] of this._signals)
            obj.disconnect(id);
        this._signals = [];
        for (const it of this._items)
            this._untrack(it);
        this._hideLighter();
        this._lighter.destroy();
        this._lighter = null;
        this._layer.destroy();
        this._layer = null;
        this._fl.destroy();
        this._fl = null;
        this._items = [];
        this._particles = [];
        this._pool = [];
        this._shells = [];
        this._emitters = [];
        this._tex = null;
    }

    _connect(obj, signal, cb) {
        this._signals.push([obj, obj.connect(signal, cb)]);
    }

    _later(sec, cb) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.round(sec * 1000), () => {
            this._timers.delete(id);
            if (this._running)
                cb();
            return GLib.SOURCE_REMOVE;
        });
        this._timers.add(id);
    }

    _screen() {
        let W = global.stage.width, H = global.stage.height;
        for (const m of Main.layoutManager.monitors) {
            W = Math.max(W, m.x + m.width);
            H = Math.max(H, m.y + m.height);
        }
        return [W, H];
    }

    // ---------- поставленные фейерверки ----------

    _loadItems() {
        let list = [];
        try {
            list = JSON.parse(this._settings.get_string('placed'));
        } catch (e) {
            list = [];
        }
        const [W, H] = this._screen();
        for (const d of Array.isArray(list) ? list : []) {
            if (Art.KINDS[d.k] && d.x >= 0 && d.x <= W && d.y >= 0 && d.y <= H + 5)
                this._addItem(d.k, d.x, d.y, false, false);
        }
    }

    _save() {
        const list = this._items.filter(it => it.state === 'idle').map(it => ({ k: it.kind, x: Math.round(it.x), y: Math.round(it.y) }));
        this._settings.set_string('placed', JSON.stringify(list));
    }

    _addItem(kind, x, y, save = true, animate = true) {
        if (this._items.filter(it => it.state === 'idle').length >= MAX_ITEMS)
            return null;
        const K = Art.KINDS[kind];
        const w = K.w + 2 * MARGIN, h = K.h + 2 * MARGIN;
        const a = new St.DrawingArea({ reactive: true, width: w, height: h, name: 'fireworks-item' });
        const it = { kind, x, y, actor: a, w, h, state: 'idle', burnt: false, tracked: false, fuseLeft: 1 };
        a.connect('repaint', area => {
            const cr = area.get_context();
            cr.translate(w / 2, h - MARGIN);
            Art.drawItem(cr, kind, it.burnt);
            cr.$dispose();
        });
        a.set_position(Math.round(x - w / 2), Math.round(y - h + MARGIN));
        a.set_pivot_point(0.5, (h - MARGIN) / h);
        a.connect('enter-event', (actor, ev) => {
            if (it.state === 'idle' && !this._place)
                this._showLighter(...ev.get_coords());
            return Clutter.EVENT_PROPAGATE;
        });
        a.connect('motion-event', (actor, ev) => {
            if (this._lighterOn)
                this._moveLighter(...ev.get_coords());
            return Clutter.EVENT_PROPAGATE;
        });
        a.connect('leave-event', () => {
            if (this._hold && this._hold.item === it)
                this._hold = null;
            this._hideLighter();
            return Clutter.EVENT_PROPAGATE;
        });
        a.connect('button-press-event', (actor, ev) => {
            if (it.state !== 'idle')
                return Clutter.EVENT_PROPAGATE;
            if (ev.get_button() === Clutter.BUTTON_SECONDARY) {
                // правая кнопка — убрать фейерверк
                this._removeItem(it, true);
                this._hideLighter();
                return Clutter.EVENT_STOP;
            }
            if (ev.get_button() !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_PROPAGATE;
            this._showLighter(...ev.get_coords());
            this._hold = { item: it, t: 0 };
            this._ensureTick();
            return Clutter.EVENT_STOP;
        });
        a.connect('button-release-event', () => {
            if (this._hold && this._hold.item === it)
                this._hold = null;
            return Clutter.EVENT_STOP;
        });
        this._itemBox.add_child(a);
        this._items.push(it);
        if (animate) {
            a.scale_x = a.scale_y = 0.4;
            a.ease({ scale_x: 1, scale_y: 1, duration: 320, mode: Clutter.AnimationMode.EASE_OUT_BACK });
        }
        if (save)
            this._save();
        this._syncInput();
        return it;
    }

    _removeItem(it, save) {
        const i = this._items.indexOf(it);
        if (i >= 0)
            this._items.splice(i, 1);
        this._untrack(it);
        it.actor.destroy();
        if (save)
            this._save();
    }

    clearAll() {
        if (!this._running)
            return;
        for (const it of [...this._items]) {
            if (it.state === 'idle')
                this._removeItem(it, false);
        }
        this._save();
    }

    _track(it) {
        if (!it.tracked) {
            Main.layoutManager.trackChrome(it.actor, { affectsInputRegion: true });
            it.tracked = true;
        }
    }

    _untrack(it) {
        if (it.tracked) {
            Main.layoutManager.untrackChrome(it.actor);
            it.tracked = false;
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

    // Мышь ловят только видимые фейерверки: под окном клики уходят окну.
    _syncInput() {
        if (!this._running)
            return;
        const shown = this._fl && this._fl.shown && !Main.overview.visible;
        const above = this._fl && this._fl.mode === 'above';
        let rects = null;
        for (const it of this._items) {
            let want = shown && it.state === 'idle';
            if (want && !above) {
                rects = rects || this._windowRects();
                const cy = it.y - Art.KINDS[it.kind].h / 2;
                want = !rects.some(r => it.x >= r.x && it.x < r.x + r.width && cy >= r.y && cy < r.y + r.height);
            }
            if (want)
                this._track(it);
            else
                this._untrack(it);
        }
    }

    // ---------- установка: щелчок по экрану ставит фейерверк ----------

    beginPlace(kind) {
        if (!this._running)
            return;
        this._cancelPlace();
        if (this._fl.mode === 'desktop' && !this._fl.shown)
            return;
        const [W, H] = this._screen();
        const catcher = new Clutter.Actor({ reactive: true, x: 0, y: 0, width: W, height: H, name: 'fireworks-place' });
        Main.layoutManager.uiGroup.add_child(catcher);
        const K = Art.KINDS[kind];
        const gw = K.w + 2 * MARGIN, gh = K.h + 2 * MARGIN;
        const ghost = new St.DrawingArea({ width: gw, height: gh, opacity: 170, reactive: false });
        ghost.connect('repaint', area => {
            const cr = area.get_context();
            cr.translate(gw / 2, gh - MARGIN);
            Art.drawItem(cr, kind, false);
            cr.$dispose();
        });
        catcher.add_child(ghost);
        const hint = new St.Label({
            text: T('Щёлкните, куда поставить. Правая кнопка или Esc — готово',
                'Click where to put it. Right click or Esc — done'),
            style: 'background-color: rgba(0,0,0,0.72); color: white; padding: 8px 14px; border-radius: 10px; font-size: 13px;',
        });
        catcher.add_child(hint);
        const mon = Main.layoutManager.primaryMonitor;
        hint.set_position(Math.round(mon.x + mon.width / 2 - 220), mon.y + Main.panel.height + 16);

        const grab = Main.pushModal(catcher, { actionMode: Shell.ActionMode.NORMAL });
        global.display.set_cursor(Meta.Cursor.CROSSHAIR);
        const [px, py] = global.get_pointer();
        const moveGhost = (x, y) => ghost.set_position(Math.round(x - gw / 2), Math.round(y - gh + MARGIN));
        moveGhost(px, py);
        this._place = { catcher, grab, kind };
        this._place.id = catcher.connect('captured-event', (a, ev) => {
            const type = ev.type();
            if (type === Clutter.EventType.ENTER || type === Clutter.EventType.LEAVE)
                return Clutter.EVENT_PROPAGATE;
            if (type === Clutter.EventType.MOTION) {
                moveGhost(...ev.get_coords());
            } else if (type === Clutter.EventType.BUTTON_PRESS) {
                if (ev.get_button() === Clutter.BUTTON_PRIMARY) {
                    const [x, y] = ev.get_coords();
                    this._addItem(kind, Math.max(0, Math.min(W, x)), Math.max(0, Math.min(H, y)));
                } else {
                    this._cancelPlace();
                }
            } else if (type === Clutter.EventType.KEY_PRESS) {
                const key = ev.get_key_symbol();
                if (key === Clutter.KEY_Escape || key === Clutter.KEY_Return)
                    this._cancelPlace();
            }
            return Clutter.EVENT_STOP;
        });
    }

    _cancelPlace() {
        const p = this._place;
        if (!p)
            return;
        this._place = null;
        p.catcher.disconnect(p.id);
        try {
            Main.popModal(p.grab);
        } catch (e) {
            logError(e, 'fireworks: popModal');
        }
        p.catcher.destroy();
        global.display.set_cursor(Meta.Cursor.DEFAULT);
    }

    // ---------- зажигалка ----------

    _buildLighter() {
        const L = new Clutter.Actor({ reactive: false, visible: false, name: 'fireworks-lighter' });
        const body = new Clutter.Actor({
            width: Art.LIGHTER_W, height: Art.LIGHTER_H,
            content: makeCanvas(Art.LIGHTER_W, Art.LIGHTER_H, (cr, w) => Art.drawLighterBody(cr, w)),
        });
        const flame = new Clutter.Actor({
            width: 12, height: 22,
            content: makeCanvas(12, 22, (cr, w, h) => Art.drawFlame(cr, w, h)),
        });
        // кончик пламени — точка курсора; фитиль зажигалки над ветрозащитой
        const bx = (Art.LIGHTER_W - 20) / 2;
        body.set_position(-(bx + 9), 22);
        flame.set_position(-6, 0);
        flame.set_pivot_point(0.5, 1);
        L.add_child(body);
        L.add_child(flame);
        this._lighter = L;
        this._flame = flame;
        this._lighterOn = false;
    }

    _showLighter(x, y) {
        if (!this._lighter)
            return;
        if (this._lighter.get_parent() !== Main.layoutManager.uiGroup) {
            this._lighter.get_parent()?.remove_child(this._lighter);
            Main.layoutManager.uiGroup.add_child(this._lighter);
        } else {
            Main.layoutManager.uiGroup.set_child_above_sibling(this._lighter, null);
        }
        this._lighterOn = true;
        this._lighter.show();
        this._moveLighter(x, y);
        global.display.set_cursor(Meta.Cursor.BLANK);
        this._ensureTick();
    }

    _moveLighter(x, y) {
        this._lighter.set_position(Math.round(x), Math.round(y));
    }

    _hideLighter() {
        if (!this._lighterOn)
            return;
        this._lighterOn = false;
        this._lighter.hide();
        if (!this._place)
            global.display.set_cursor(Meta.Cursor.DEFAULT);
    }

    // ---------- поджиг ----------

    _ignite(it) {
        it.state = 'lit';
        it.litAt = this._time;
        this._untrack(it);
        this._save();
        this._hideLighter();
        const [fx, fy] = Art.KINDS[it.kind].fuse;
        const [bx, by] = FUSE_BASE[it.kind];
        // искра бежит по фитилю от кончика к заряду
        this._emitters.push({
            until: this._time + FUSE_TIME,
            rate: 70,
            acc: 0,
            pos: () => {
                const p = Math.min(1, (this._time - it.litAt) / FUSE_TIME);
                return [it.x + fx + (bx - fx) * p, it.y + fy + (by - fy) * p];
            },
            spawn: (x, y) => this._spark(x, y, pick(['gold', 'white', 'orange']), {
                vx: rand(-90, 90), vy: rand(-140, 20), life: rand(0.15, 0.35), size: rand(5, 8), drag: 3, g: 300,
            }),
            done: () => this._launch(it),
        });
        this._ensureTick();
    }

    _launch(it) {
        if (!this._running || !this._items.includes(it))
            return;
        it.burnt = true;
        it.actor.queue_repaint();
        const scale = this._burstScale();
        if (it.kind === 'rocket') {
            // ракета улетает вместе с палочкой — на месте ничего не остаётся
            this._removeItem(it, false);
            this._shell(it.x, it.y - 70, rand(-40, 40), null, { scale: scale * 1.15 });
        } else if (it.kind === 'battery') {
            const shots = 12;
            let t = 0;
            for (let i = 0; i < shots; i++) {
                this._later(t, () => {
                    // выстрел из трубки: вспышка над коробкой и снаряд
                    this._spark(it.x + rand(-20, 20), it.y - 46, 'gold', { life: 0.12, size: 22, drag: 0, g: 0 });
                    this._shell(it.x + rand(-20, 20), it.y - 46, rand(-160, 160), null, { scale: scale * rand(0.6, 0.85), apexFrac: rand(0.25, 0.55) });
                });
                t += rand(0.28, 0.5);
            }
            this._later(t, () => this._retire(it, 0.8));
        } else {
            const color = pick(['gold', 'silver']);
            this._emitters.push({
                until: this._time + 5.5,
                rate: 150,
                acc: 0,
                pos: () => [it.x, it.y - 50],
                spawn: (x, y) => {
                    const a = -Math.PI / 2 + rand(-0.32, 0.32);
                    const sp = rand(320, 640);
                    this._spark(x, y, Math.random() < 0.8 ? color : 'white', {
                        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rand(0.7, 1.25), size: rand(6, 10), drag: 0.9, g: 520,
                    });
                },
                done: () => this._retire(it, 0.4),
            });
        }
        this._ensureTick();
    }

    // отработавший фейерверк гаснет и исчезает
    _retire(it, sec) {
        this._later(sec, () => {
            if (!this._items.includes(it))
                return;
            it.actor.ease({
                opacity: 0,
                duration: 900,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onComplete: () => this._removeItem(it, false),
            });
        });
    }

    _burstScale() {
        return this._settings.get_int('burst-size') / 100;
    }

    // ---------- залп без подготовки ----------

    show() {
        if (!this._running)
            return;
        if (this._fl.mode === 'desktop' && !this._fl.shown)
            return;
        const mon = Main.layoutManager.primaryMonitor;
        let t = 0;
        for (let i = 0; i < 9; i++) {
            this._later(t, () => {
                const x = mon.x + mon.width * rand(0.12, 0.88);
                this._shell(x, mon.y + mon.height, rand(-60, 60), null, { scale: this._burstScale() * rand(0.85, 1.15) });
            });
            t += rand(0.35, 0.8);
        }
    }

    // ---------- снаряды и взрывы ----------

    _shell(x, y, vx, burst, opts = {}) {
        const mon = Main.layoutManager.monitors.find(m => x >= m.x && x < m.x + m.width) || Main.layoutManager.primaryMonitor;
        const frac = opts.apexFrac ?? rand(0.15, 0.4);
        const apexY = mon.y + mon.height * frac;
        const dist = Math.max(80, y - apexY);
        // скорость, чтобы долететь почти до верхней точки при «гравитации» 380
        const vy = -Math.sqrt(2 * 380 * dist) * 1.05;
        const head = this._spark(x, y, 'gold', { life: 99, size: 9, drag: 0, g: 0, keep: true });
        if (!head)
            return;
        this._shells.push({
            x, y, vx, vy, apexY, head,
            burst: burst || pick(BURSTS),
            colors: [pick(PALETTE), pick(PALETTE)],
            scale: opts.scale ?? 1,
            trail: 0,
        });
        this._ensureTick();
    }

    _burst(s) {
        const [, H] = this._screen();
        const scale = s.scale;
        const N = Math.round(this._settings.get_int('burst-size') * Math.min(1.3, Math.max(0.5, scale)));
        const S = H * 0.5 * Math.max(0.5, scale);
        const [c1, c2] = s.colors;
        this._spark(s.x, s.y, 'white', { life: 0.16, size: 90 * scale, drag: 0, g: 0, fadeFast: true });
        const add = (ang, sp, color, o = {}) => this._spark(s.x, s.y, color, Object.assign({
            vx: Math.cos(ang) * sp + s.vx * 0.3, vy: Math.sin(ang) * sp + s.vy * 0.2,
            life: rand(1.2, 1.8), size: rand(9, 13), drag: 1.6, g: 95,
        }, o));
        switch (s.burst) {
        case 'ring':
            for (let i = 0; i < N; i++)
                add(i / N * Math.PI * 2, S * rand(0.88, 0.95), i % 2 ? c1 : c2, { life: rand(1.2, 1.5) });
            break;
        case 'willow':
            for (let i = 0; i < N; i++)
                add(Math.random() * Math.PI * 2, S * 0.8 * Math.sqrt(Math.random()), 'gold', { life: rand(2.6, 3.4), size: rand(8, 11), drag: 2.2, g: 70, trail: true });
            break;
        case 'crackle':
            for (let i = 0; i < N; i++)
                add(Math.random() * Math.PI * 2, S * rand(0.4, 1), pick(['gold', 'silver']), { crackle: true, life: rand(1.0, 1.5) });
            break;
        case 'double':
            for (let i = 0; i < N; i++) {
                const inner = i % 2 === 0;
                add(Math.random() * Math.PI * 2, S * (inner ? rand(0.45, 0.55) : rand(0.85, 1)), inner ? c2 : c1);
            }
            break;
        case 'strobe':
            for (let i = 0; i < N; i++)
                add(Math.random() * Math.PI * 2, S * rand(0.5, 1), pick(['white', 'silver']), { strobe: true, life: rand(1.4, 2) });
            break;
        case 'heart':
            // сердечко (праздник же)
            for (let i = 0; i < N; i++) {
                const t = i / N * Math.PI * 2;
                const hx = 16 * Math.pow(Math.sin(t), 3);
                const hy = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
                const k = S / 17 * 0.85;
                this._spark(s.x, s.y, i % 3 ? 'pink' : 'red', {
                    vx: hx * k, vy: -hy * k, life: rand(1.3, 1.6), size: rand(9, 12), drag: 1.6, g: 40,
                });
            }
            break;
        default: // peony — шар искр
            for (let i = 0; i < N; i++)
                add(Math.random() * Math.PI * 2, S * Math.sqrt(1 - Math.pow(Math.random(), 2)), i % 4 === 0 ? c2 : c1);
        }
    }

    // ---------- искры ----------

    _spark(x, y, color, o) {
        if (this._particles.length >= MAX_PARTICLES && !o.keep)
            return null;
        let a = this._pool.pop();
        if (!a) {
            a = new Clutter.Actor({ reactive: false });
            a.set_pivot_point(0.5, 0.5);
            this._fxBox.add_child(a);
        }
        a.content = this._tex[color] || this._tex.white;
        const size = o.size ?? 10;
        a.set_size(size, size);
        a.set_scale(1, 1);
        a.opacity = 255;
        a.show();
        const p = {
            a, x, y, size,
            vx: o.vx ?? 0, vy: o.vy ?? 0,
            life: o.life ?? 1, max: o.life ?? 1,
            drag: o.drag ?? 1.5, g: o.g ?? 90,
            trail: o.trail, crackle: o.crackle, strobe: o.strobe, fadeFast: o.fadeFast,
            keep: o.keep, trailT: 0,
        };
        a.set_translation(x - size / 2, y - size / 2, 0);
        this._particles.push(p);
        this._ensureTick();
        return p;
    }

    _freeSpark(p) {
        p.dead = true;
        p.a.hide();
        if (this._pool.length < 600)
            this._pool.push(p.a);
        else
            p.a.destroy();
    }

    // ---------- кадр ----------

    _ensureTick() {
        if (this._tickId || !this._running)
            return;
        this._last = GLib.get_monotonic_time() / 1e6;
        this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            let more = false;
            try {
                more = this._tick();
            } catch (e) {
                logError(e, 'fireworks: tick failed');
            }
            if (!more)
                this._tickId = 0;
            return more ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
        });
        GLib.Source.set_name_by_id(this._tickId, '[fireworks] tick');
    }

    _stopTick() {
        if (this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
    }

    _tick() {
        const now = GLib.get_monotonic_time() / 1e6;
        const dt = Math.min(0.05, Math.max(0.001, now - this._last));
        this._last = now;
        this._time += dt;
        const time = this._time;

        // зажигалка: пламя дрожит, у фитиля — разгорается
        if (this._lighterOn) {
            const big = this._hold ? 1.45 : 1;
            this._flame.set_scale(big * rand(0.85, 1.05), big * rand(0.85, 1.15));
        }
        if (this._hold) {
            this._hold.t += dt;
            if (this._hold.t >= HOLD_TIME) {
                const it = this._hold.item;
                this._hold = null;
                this._ignite(it);
            }
        }

        // фитили и фонтаны
        for (const e of [...this._emitters]) {
            if (time >= e.until) {
                this._emitters.splice(this._emitters.indexOf(e), 1);
                e.done?.();
                continue;
            }
            e.acc += e.rate * dt;
            const [x, y] = e.pos();
            while (e.acc >= 1) {
                e.acc -= 1;
                e.spawn(x, y);
            }
        }

        // летящие снаряды
        for (const s of [...this._shells]) {
            s.vy += 380 * dt;
            s.vx *= Math.exp(-0.4 * dt);
            s.x += s.vx * dt;
            s.y += s.vy * dt;
            const h = s.head;
            h.x = s.x;
            h.y = s.y;
            s.trail += dt;
            while (s.trail > 0.012) {
                s.trail -= 0.012;
                this._spark(s.x + rand(-1.5, 1.5), s.y + 4, pick(['gold', 'orange']), {
                    vx: rand(-25, 25), vy: rand(30, 110), life: rand(0.25, 0.5), size: rand(4, 7), drag: 2.5, g: 120,
                });
            }
            if (s.y <= s.apexY || s.vy >= -60) {
                this._shells.splice(this._shells.indexOf(s), 1);
                h.life = 0;
                this._burst(s);
            }
        }

        // искры
        const parts = this._particles;
        const born = [];
        for (let i = parts.length - 1; i >= 0; i--) {
            const p = parts[i];
            p.life -= dt;
            if (p.life <= 0) {
                if (p.crackle && parts.length < MAX_PARTICLES) {
                    // треск: каждая искра лопается белыми вспышками
                    for (let k = 0; k < 2; k++)
                        born.push([p.x, p.y, 'white', { vx: rand(-80, 80), vy: rand(-80, 80), life: rand(0.08, 0.16), size: rand(6, 10), drag: 2, g: 0, fadeFast: true }]);
                }
                this._freeSpark(p);
                parts[i] = parts[parts.length - 1];
                parts.pop();
                continue;
            }
            if (!p.keep) {
                const d = Math.exp(-p.drag * dt);
                p.vx *= d;
                p.vy = p.vy * d + p.g * dt;
                p.x += p.vx * dt;
                p.y += p.vy * dt;
            }
            const t = p.life / p.max;
            let alpha = p.fadeFast ? t : (t < 0.35 ? t / 0.35 : 1);
            if (p.strobe)
                alpha *= Math.random() < 0.45 ? 1 : 0.12;
            p.a.opacity = Math.round(255 * Math.max(0, Math.min(1, alpha)));
            const sc = p.keep ? rand(0.85, 1.1) : 0.55 + 0.45 * t;
            p.a.set_scale(sc, sc);
            p.a.set_translation(p.x - p.size / 2, p.y - p.size / 2, 0);
            if (p.trail) {
                p.trailT += dt;
                if (p.trailT > 0.05 && parts.length < MAX_PARTICLES * 0.8) {
                    p.trailT = 0;
                    born.push([p.x, p.y, 'gold', { vx: 0, vy: 10, life: rand(0.4, 0.7), size: rand(4, 6), drag: 3, g: 30 }]);
                }
            }
        }
        for (const [x, y, color, o] of born)
            this._spark(x, y, color, o);

        return parts.length > 0 || this._shells.length > 0 || this._emitters.length > 0 ||
            this._lighterOn || this._hold !== null;
    }
}

class Extension {
    enable() {
        this._settings = ExtensionUtils.getSettings();
        I18n.bindSettings(this._settings);
        this._fw = new Fireworks(this._settings);
        this._id = this._settings.connect('changed::enabled', () => this._sync());
        Main.wm.addKeybinding('show-key', this._settings, Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => {
                if (Main.overview.visible)
                    Main.overview.hide();
                this._settings.set_boolean('enabled', true);
                this._fw.show();
            });
        this._sync();
        this._indicator = new Festive.IndicatorManager('fireworks', () => T('Фейерверк', 'Fireworks'),
            `${Me.path}/icons/fireworks-symbolic.svg`, this._settings, ind => {
                ind.addSwitch(T('Фейерверк', 'Fireworks'), 'enabled');
                ind.addAction(T('Салют сейчас!', 'Fireworks now!'), () => this._fw.show());
                ind.addSeparator();
                ind.addAction(T('Поставить ракету', 'Place a rocket'), () => this._place('rocket'));
                ind.addAction(T('Поставить батарею салютов', 'Place a firework cake'), () => this._place('battery'));
                ind.addAction(T('Поставить фонтан', 'Place a fountain'), () => this._place('fountain'));
                ind.addAction(T('Убрать все фейерверки', 'Remove all fireworks'), () => this._fw.clearAll());
                ind.addSeparator();
                ind.addVisibility();
                ind.addSlider(T('Размер взрыва', 'Burst size'), 'burst-size', 30, 250, true, v => `${Math.round(v)}`);
                ind.addSeparator();
                ind.addPrefs();
            });
    }

    disable() {
        this._indicator.destroy();
        this._indicator = null;
        Main.wm.removeKeybinding('show-key');
        this._settings.disconnect(this._id);
        this._fw.stop();
        this._fw = null;
        this._settings = null;
    }

    _place(kind) {
        this._settings.set_boolean('enabled', true);
        // меню закрывается — ставим после этого, чтобы захват ввода не конфликтовал
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            this._fw?.beginPlace(kind);
            return GLib.SOURCE_REMOVE;
        });
    }

    _sync() {
        if (this._settings.get_boolean('enabled'))
            this._fw.start();
        else
            this._fw.stop();
    }
}

function init() {
    return new Extension();
}
