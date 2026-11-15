/* Snowball Fight — GNOME Shell 42 extension.
 *
 * На рабочем столе (под окнами, над обоями) лежит горка снежков. Снежок можно
 * схватить мышью и бросить: скорость броска берётся из движения мыши, в
 * полёте действует гравитация. Ударившись о край экрана, снежок сплющивается
 * в «шлепок» на стене, разлетаются крошки; след медленно сползает и тает.
 * Горка сама пополняется.
 *
 * Нагрузка: пока ничего не летит, таймера нет вообще. Во время полёта —
 * 60 кадров/с, только для летящих снежков и крошек. Текстуры (снежок,
 * крошка, 4 варианта шлепка) рисуются один раз.
 */
'use strict';

const { GLib, Clutter, Meta, Shell } = imports.gi;
const Cairo = imports.cairo;

const Main = imports.ui.main;
const ExtensionUtils = imports.misc.extensionUtils;
const I18n = ExtensionUtils.getCurrentExtension().imports.i18n;
const T = I18n.T;
const Me = ExtensionUtils.getCurrentExtension();
const Festive = Me.imports.festive;

const TEX_BALL = 64;
const TEX_SPLAT = 160;
const TEX_CRUMB = 16;
const MAX_SPEED = 4000;
const REGEN_DELAY = 2500;   // мс до появления нового снежка в горке

function makeCanvas(size, draw) {
    const canvas = new Clutter.Canvas();
    canvas.set_size(size, size);
    canvas.connect('draw', (c, cr, w, h) => {
        cr.save();
        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.restore();
        draw(cr, w, h);
        cr.$dispose();
        return true;
    });
    canvas.invalidate();
    return canvas;
}

// Снежок: шар с бликом слева сверху, голубоватой тенью и ямками.
function drawBall(cr, w) {
    const r = w / 2 - 1;
    const c = w / 2;
    const g = new Cairo.RadialGradient(c - r * 0.35, c - r * 0.4, r * 0.05, c, c, r);
    g.addColorStopRGBA(0, 1, 1, 1, 1);
    g.addColorStopRGBA(0.55, 0.92, 0.95, 0.99, 1);
    g.addColorStopRGBA(1, 0.7, 0.78, 0.9, 1);
    cr.setSource(g);
    cr.arc(c, c, r, 0, 2 * Math.PI);
    cr.fill();
    // ямки и комочки
    let seed = 11;
    const rnd = () => {
        seed = (seed * 16807) % 2147483647;
        return seed / 2147483647;
    };
    for (let i = 0; i < 14; i++) {
        const a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * r * 0.85;
        const x = c + Math.cos(a) * d, y = c + Math.sin(a) * d;
        cr.setSourceRGBA(0.55, 0.65, 0.8, 0.18 + rnd() * 0.15);
        cr.arc(x, y, r * (0.05 + rnd() * 0.07), 0, 2 * Math.PI);
        cr.fill();
    }
    cr.setSourceRGBA(0.55, 0.65, 0.82, 0.5);
    cr.setLineWidth(1);
    cr.arc(c, c, r - 0.5, 0, 2 * Math.PI);
    cr.stroke();
}

function drawCrumb(cr, w) {
    const g = new Cairo.RadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    g.addColorStopRGBA(0, 1, 1, 1, 1);
    g.addColorStopRGBA(0.6, 0.93, 0.96, 1, 0.9);
    g.addColorStopRGBA(1, 0.85, 0.9, 1, 0);
    cr.setSource(g);
    cr.arc(w / 2, w / 2, w / 2, 0, 2 * Math.PI);
    cr.fill();
}

// Шлепок: неровное пятно с брызгами вокруг. Каждый вариант — свой seed.
function drawSplat(cr, w, variant) {
    let seed = 1234 + variant * 977;
    const rnd = () => {
        seed = (seed * 16807) % 2147483647;
        return seed / 2147483647;
    };
    const c = w / 2;
    const R = w * 0.28;
    const waves = [];
    for (let k = 0; k < 5; k++)
        waves.push([2 + Math.floor(rnd() * 7), rnd() * Math.PI * 2, 0.04 + rnd() * 0.1]);
    const radius = a => {
        let f = 1;
        for (const [n, ph, amp] of waves)
            f += amp * Math.sin(n * a + ph);
        return R * f;
    };
    // основное пятно
    cr.newPath();
    const steps = 90;
    for (let i = 0; i <= steps; i++) {
        const a = i / steps * Math.PI * 2;
        const rr = radius(a);
        const x = c + Math.cos(a) * rr, y = c + Math.sin(a) * rr;
        if (i === 0)
            cr.moveTo(x, y);
        else
            cr.lineTo(x, y);
    }
    cr.closePath();
    const g = new Cairo.RadialGradient(c - R * 0.25, c - R * 0.25, R * 0.1, c, c, R * 1.25);
    g.addColorStopRGBA(0, 1, 1, 1, 0.98);
    g.addColorStopRGBA(0.7, 0.93, 0.96, 1, 0.95);
    g.addColorStopRGBA(1, 0.78, 0.85, 0.95, 0.9);
    cr.setSource(g);
    cr.fillPreserve();
    cr.setSourceRGBA(0.6, 0.7, 0.85, 0.45);
    cr.setLineWidth(1.2);
    cr.stroke();
    // лучи-брызги и капли
    const rays = 5 + Math.floor(rnd() * 5);
    for (let i = 0; i < rays; i++) {
        const a = rnd() * Math.PI * 2;
        const r0 = radius(a) * 0.9;
        const len = R * (0.12 + rnd() * 0.3);
        const wid = R * (0.14 + rnd() * 0.12);
        const x0 = c + Math.cos(a) * r0, y0 = c + Math.sin(a) * r0;
        const x1 = c + Math.cos(a) * (r0 + len), y1 = c + Math.sin(a) * (r0 + len);
        cr.setSourceRGBA(0.95, 0.97, 1, 0.95);
        cr.setLineWidth(wid);
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.moveTo(x0, y0);
        cr.lineTo(x1, y1);
        cr.stroke();
        cr.arc(x1 + Math.cos(a) * wid, y1 + Math.sin(a) * wid, wid * (0.6 + rnd() * 0.6), 0, 2 * Math.PI);
        cr.fill();
    }
    for (let i = 0; i < 18; i++) {
        const a = rnd() * Math.PI * 2;
        const d = R * (1.15 + rnd() * 0.55);
        cr.setSourceRGBA(0.95, 0.97, 1, 0.6 + rnd() * 0.35);
        cr.arc(c + Math.cos(a) * d, c + Math.sin(a) * d, R * (0.03 + rnd() * 0.07), 0, 2 * Math.PI);
        cr.fill();
    }
}

class SnowballGame {
    constructor(settings) {
        this._settings = settings;
        this._running = false;
    }

    start() {
        if (this._running)
            return;
        this._running = true;
        this._signals = [];
        this._slots = [];
        this._flying = [];
        this._crumbs = [];
        this._timers = new Set();

        this._texBall = makeCanvas(TEX_BALL, drawBall);
        this._texCrumb = makeCanvas(TEX_CRUMB, drawCrumb);
        this._texSplat = [0, 1, 2, 3].map(v => makeCanvas(TEX_SPLAT, (cr, w) => drawSplat(cr, w, v)));

        // слой на рабочем столе: над обоями, под всеми окнами
        this._layer = new Clutter.Actor({ name: 'snowball-layer', reactive: false });
        // где показывать: поверх окон / только на пустом столе / под окнами
        this._above = this._settings.get_string('visibility') === 'above';
        this._fl = new Festive.FestiveLayer('snowball', this._settings, shown => {
            if (!shown)
                this._endDrag(false);
            const above = this._settings.get_string('visibility') === 'above';
            if (above !== this._above) {
                // поверх окон снежки ловят клики и над окнами
                this._untrackAll();
                this._above = above;
                for (const slot of this._slots) {
                    if (slot.ball)
                        this._track(slot.ball);
                }
            }
        });
        this._fl.actor.add_child(this._layer);
        this._splatBox = new Clutter.Actor({ reactive: false });
        this._pileBox = new Clutter.Actor({ reactive: false });
        this._flyBox = new Clutter.Actor({ reactive: false });
        this._layer.add_child(this._splatBox);
        this._layer.add_child(this._pileBox);
        this._layer.add_child(this._flyBox);

        const rebuild = () => this._queueRebuild();
        this._connect(Main.layoutManager, 'monitors-changed', rebuild);
        this._connect(global.display, 'workareas-changed', rebuild);
        if (Main.layoutManager._startingUp)
            this._connect(Main.layoutManager, 'startup-complete', rebuild);
        for (const key of ['pile-size', 'ball-size', 'corner'])
            this._connect(this._settings, `changed::${key}`, rebuild);

        this._connect(Main.overview, 'showing', () => {
            this._endDrag(false);
            this._layer.hide();
        });
        this._connect(Main.overview, 'hidden', () => this._layer.show());

        this._buildPile();
    }

    stop() {
        if (!this._running)
            return;
        this._running = false;
        this._endDrag(false);
        for (const id of this._timers)
            GLib.source_remove(id);
        this._timers.clear();
        if (this._rebuildId) {
            GLib.source_remove(this._rebuildId);
            this._rebuildId = 0;
        }
        this._stopTick();
        this._untrackAll();
        for (const [obj, id] of this._signals)
            obj.disconnect(id);
        this._signals = [];
        if (this._hover) {
            global.display.set_cursor(Meta.Cursor.DEFAULT);
            this._hover = false;
        }
        this._layer.destroy();
        this._layer = null;
        this._fl.destroy();
        this._fl = null;
        this._slots = [];
        this._flying = [];
        this._crumbs = [];
    }

    _connect(obj, signal, cb) {
        this._signals.push([obj, obj.connect(signal, cb)]);
    }

    _later(ms, cb) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timers.delete(id);
            cb();
            return GLib.SOURCE_REMOVE;
        });
        this._timers.add(id);
    }

    _queueRebuild() {
        if (this._rebuildId)
            return;
        this._rebuildId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            this._rebuildId = 0;
            if (this._running)
                this._buildPile();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Стены — рабочая область главного монитора (без панели и дока).
    _walls() {
        const i = Main.layoutManager.primaryIndex;
        const wa = Main.layoutManager.getWorkAreaForMonitor(i);
        return { l: wa.x, t: wa.y, r: wa.x + wa.width, b: wa.y + wa.height };
    }

    // ---------- горка ----------

    // Поверх окон снежки в горке должны ловить клики и над окнами (X11):
    // для этого добавляем их в область ввода Shell.
    _track(ball) {
        if (!this._above || ball._tracked)
            return;
        Main.layoutManager.trackChrome(ball, { affectsInputRegion: true });
        ball._tracked = true;
    }

    _untrack(ball) {
        if (!ball._tracked)
            return;
        Main.layoutManager.untrackChrome(ball);
        ball._tracked = false;
    }

    _untrackAll() {
        for (const slot of this._slots || []) {
            if (slot.ball)
                this._untrack(slot.ball);
        }
    }

    clearSplats() {
        if (!this._running)
            return;
        for (const s of this._splatBox.get_children()) {
            s.remove_all_transitions();
            s.ease({ opacity: 0, duration: 600, onComplete: () => s.destroy() });
        }
    }

    _buildPile() {
        this._untrackAll();
        this._pileBox.destroy_all_children();
        this._slots = [];
        if (!Main.layoutManager.primaryMonitor)
            return;
        const n = this._settings.get_int('pile-size');
        const d = this._settings.get_int('ball-size');
        const r = d / 2;
        const w = this._walls();
        const right = this._settings.get_string('corner') !== 'bottom-left';
        // пирамида: нижний ряд шире
        let rows = 1;
        while (rows * (rows + 1) / 2 < n)
            rows++;
        const baseX = right ? w.r - 40 - rows * d : w.l + 40;
        let placed = 0;
        for (let row = 0; row < rows && placed < n; row++) {
            const count = rows - row;
            for (let k = 0; k < count && placed < n; k++, placed++) {
                const cx = baseX + r + row * r + k * d * 0.96;
                const cy = w.b - r - 2 - row * d * 0.84;
                this._slots.push({ x: cx, y: cy, ball: null });
            }
        }
        for (const slot of this._slots)
            this._fillSlot(slot, false);
    }

    _newBall() {
        const d = this._settings.get_int('ball-size');
        const ball = new Clutter.Actor({
            content: this._texBall,
            width: d,
            height: d,
            reactive: true,
        });
        ball.set_pivot_point(0.5, 0.5);
        ball.connect('enter-event', () => {
            if (!this._drag) {
                this._hover = true;
                global.display.set_cursor(Meta.Cursor.POINTING_HAND);
            }
            return Clutter.EVENT_PROPAGATE;
        });
        ball.connect('leave-event', () => {
            if (!this._drag && this._hover) {
                this._hover = false;
                global.display.set_cursor(Meta.Cursor.DEFAULT);
            }
            return Clutter.EVENT_PROPAGATE;
        });
        ball.connect('button-press-event', (a, event) => {
            if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_PROPAGATE;
            this._startDrag(ball, event);
            return Clutter.EVENT_STOP;
        });
        return ball;
    }

    _fillSlot(slot, animate) {
        if (slot.ball || !this._running)
            return;
        const ball = this._newBall();
        const d = ball.width;
        ball.set_position(slot.x - d / 2, slot.y - d / 2);
        ball.rotation_angle_z = Math.random() * 360;
        slot.ball = ball;
        ball._slot = slot;
        this._pileBox.add_child(ball);
        this._track(ball);
        if (animate) {
            ball.scale_x = ball.scale_y = 0.1;
            ball.ease({
                scale_x: 1,
                scale_y: 1,
                duration: 350,
                mode: Clutter.AnimationMode.EASE_OUT_BACK,
            });
        }
    }

    // ---------- бросок ----------

    _startDrag(ball, event) {
        if (this._drag)
            return;
        const slot = ball._slot;
        if (slot) {
            slot.ball = null;
            ball._slot = null;
            this._later(REGEN_DELAY, () => this._fillSlot(slot, true));
        }
        const [x, y] = event.get_coords();
        this._untrack(ball);
        ball.reactive = false;
        this._pileBox.remove_child(ball);
        this._flyBox.add_child(ball);
        ball.remove_all_transitions();
        ball.scale_x = ball.scale_y = 1.12;   // «взяли в руку»

        const grab = Main.pushModal(this._layer, { actionMode: Shell.ActionMode.NORMAL });
        this._drag = {
            ball, grab,
            samples: [[GLib.get_monotonic_time() / 1e6, x, y]],
            x, y,
        };
        global.display.set_cursor(Meta.Cursor.DND_IN_DRAG);
        this._dragId = this._layer.connect('captured-event', (a, ev) => this._onDragEvent(ev));
        this._moveBall(ball, x, y);
    }

    _moveBall(ball, x, y) {
        ball.set_position(x - ball.width / 2, y - ball.height / 2);
    }

    _onDragEvent(ev) {
        const drag = this._drag;
        if (!drag)
            return Clutter.EVENT_PROPAGATE;
        const type = ev.type();
        if (type === Clutter.EventType.MOTION) {
            const [x, y] = ev.get_coords();
            drag.x = x;
            drag.y = y;
            const now = GLib.get_monotonic_time() / 1e6;
            drag.samples.push([now, x, y]);
            while (drag.samples.length > 2 && now - drag.samples[0][0] > 0.1)
                drag.samples.shift();
            this._moveBall(drag.ball, x, y);
            return Clutter.EVENT_STOP;
        }
        if (type === Clutter.EventType.BUTTON_RELEASE) {
            this._endDrag(true);
            return Clutter.EVENT_STOP;
        }
        if (type === Clutter.EventType.KEY_PRESS && ev.get_key_symbol() === Clutter.KEY_Escape) {
            this._endDrag(false);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_STOP;
    }

    _endDrag(throwIt) {
        const drag = this._drag;
        if (!drag)
            return;
        this._drag = null;
        if (this._dragId) {
            this._layer.disconnect(this._dragId);
            this._dragId = 0;
        }
        try {
            Main.popModal(drag.grab);
        } catch (e) {
            logError(e, 'snowball-fight: popModal');
        }
        global.display.set_cursor(Meta.Cursor.DEFAULT);
        this._hover = false;

        const ball = drag.ball;
        if (!this._running) {
            ball.destroy();
            return;
        }
        // скорость — по движению мыши за последние ~0.1 с
        let vx = 0, vy = 0;
        const now = GLib.get_monotonic_time() / 1e6;
        const recent = drag.samples.filter(s => now - s[0] < 0.12);
        if (throwIt && recent.length >= 2) {
            const [t0, x0, y0] = recent[0];
            const [t1, x1, y1] = recent[recent.length - 1];
            const dt = Math.max(0.016, t1 - t0);
            const power = this._settings.get_double('throw-power');
            vx = (x1 - x0) / dt * power;
            vy = (y1 - y0) / dt * power;
            const sp = Math.hypot(vx, vy);
            if (sp > MAX_SPEED) {
                vx *= MAX_SPEED / sp;
                vy *= MAX_SPEED / sp;
            }
        }
        ball.scale_x = ball.scale_y = 1;
        const r = ball.width / 2;
        this._flying.push({ ball, x: drag.x, y: drag.y, vx, vy, r, spin: vx * 0.3 });
        this._startTick();
    }

    // ---------- полёт, удар, крошки ----------

    _startTick() {
        if (this._tickId)
            return;
        this._last = GLib.get_monotonic_time() / 1e6;
        this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            try {
                return this._tick() ? GLib.SOURCE_CONTINUE : this._tickDone();
            } catch (e) {
                logError(e, 'snowball-fight: tick failed');
                return this._tickDone();
            }
        });
    }

    _tickDone() {
        this._tickId = 0;
        return GLib.SOURCE_REMOVE;
    }

    _stopTick() {
        if (this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
    }

    _tick() {
        const now = GLib.get_monotonic_time() / 1e6;
        const dt = Math.min(0.033, now - this._last);
        this._last = now;
        const g = this._settings.get_int('gravity');
        const w = this._walls();

        for (let i = this._flying.length - 1; i >= 0; i--) {
            const f = this._flying[i];
            f.vy += g * dt;
            const drag = Math.exp(-0.15 * dt);
            f.vx *= drag;
            f.vy *= drag;
            f.x += f.vx * dt;
            f.y += f.vy * dt;
            f.ball.rotation_angle_z += f.spin * dt;
            let hit = null;
            if (f.x - f.r <= w.l)
                hit = { side: 'left', x: w.l, y: f.y };
            else if (f.x + f.r >= w.r)
                hit = { side: 'right', x: w.r, y: f.y };
            else if (f.y - f.r <= w.t)
                hit = { side: 'top', x: f.x, y: w.t };
            else if (f.y + f.r >= w.b)
                hit = { side: 'bottom', x: f.x, y: w.b };
            if (hit) {
                this._flying.splice(i, 1);
                this._splat(f, hit);
                continue;
            }
            f.ball.set_position(f.x - f.r, f.y - f.r);
        }

        for (let i = this._crumbs.length - 1; i >= 0; i--) {
            const c = this._crumbs[i];
            c.age += dt;
            if (c.age >= c.life) {
                c.actor.destroy();
                this._crumbs.splice(i, 1);
                continue;
            }
            c.vy += g * 0.9 * dt;
            c.vx *= Math.exp(-1.5 * dt);
            c.x += c.vx * dt;
            c.y += c.vy * dt;
            // крошки не вылетают за стены
            if (c.x < w.l) {
                c.x = w.l;
                c.vx = Math.abs(c.vx) * 0.3;
            } else if (c.x > w.r) {
                c.x = w.r;
                c.vx = -Math.abs(c.vx) * 0.3;
            }
            if (c.y > w.b - c.size / 2) {
                c.y = w.b - c.size / 2;
                c.vy = -Math.abs(c.vy) * 0.25;
                c.vx *= 0.6;
            }
            c.actor.set_position(c.x - c.size / 2, c.y - c.size / 2);
            c.actor.opacity = Math.round(255 * Math.min(1, (c.life - c.age) / (c.life * 0.4)));
        }
        return this._flying.length > 0 || this._crumbs.length > 0;
    }

    _splat(f, hit) {
        const speed = Math.hypot(f.vx, f.vy);
        const strength = Math.max(0.35, Math.min(1.3, speed / 1400));
        f.ball.destroy();

        // нормаль стены (внутрь экрана) и касательная
        const N = { left: [1, 0], right: [-1, 0], top: [0, 1], bottom: [0, -1] }[hit.side];
        const T = [-N[1], N[0]];
        const d = f.r * 2;

        // пятно на стене: сплющено вдоль нормали, растёт «шлепком»
        const size = d * (1.5 + strength * 0.9);
        const splat = new Clutter.Actor({
            content: this._texSplat[(Math.random() * 4) | 0],
            width: size, height: size, reactive: false,
        });
        splat.set_pivot_point(0.5, 0.5);
        const cx = hit.x + N[0] * size * 0.12;
        const cy = hit.y + N[1] * size * 0.12;
        splat.set_position(cx - size / 2, cy - size / 2);
        splat.rotation_angle_z = (Math.random() - 0.5) * 40;
        const flat = 0.68 + 0.12 * (1 - strength);
        const sx = N[0] !== 0 ? flat : 1, sy = N[1] !== 0 ? flat : 1;
        splat.scale_x = sx * 0.3;
        splat.scale_y = sy * 0.3;
        this._splatBox.add_child(splat);
        splat.ease({
            scale_x: sx,
            scale_y: sy,
            duration: 90,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        // след на вертикальной стене медленно сползает, потом тает
        const lifetime = this._settings.get_int('splat-lifetime') * 1000;
        if (hit.side === 'left' || hit.side === 'right') {
            splat.ease({
                translation_y: 6 + Math.random() * 18,
                duration: Math.min(lifetime, 12000),
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
        splat.connect('destroy', () => {
            splat._dead = true;
        });
        this._later(lifetime, () => {
            if (!this._running || splat._dead)
                return;
            splat.ease({
                opacity: 0,
                duration: 2500,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onComplete: () => splat.destroy(),
            });
        });
        // не копим бесконечно: максимум 60 следов
        const splats = this._splatBox.get_children();
        if (splats.length > 60)
            splats[0].destroy();

        // крошки отлетают от стены, с частью касательной скорости снежка
        const vt = f.vx * T[0] + f.vy * T[1];
        const n = Math.round(14 + 26 * strength);
        for (let i = 0; i < n; i++) {
            const big = Math.random() < 0.25;
            const csize = big ? 6 + Math.random() * 6 : 2.5 + Math.random() * 3.5;
            const actor = new Clutter.Actor({
                content: this._texCrumb, width: csize, height: csize, reactive: false,
            });
            this._flyBox.add_child(actor);
            const out = (80 + Math.random() * 420) * strength;
            const side = (Math.random() - 0.5) * 520 * strength + vt * 0.35;
            const crumb = {
                actor, size: csize,
                x: hit.x + N[0] * (f.r * 0.6) + T[0] * (Math.random() - 0.5) * d,
                y: hit.y + N[1] * (f.r * 0.6) + T[1] * (Math.random() - 0.5) * d,
                vx: N[0] * out + T[0] * side,
                vy: N[1] * out + T[1] * side - (hit.side === 'bottom' ? 0 : Math.random() * 120),
                age: 0,
                life: 0.5 + Math.random() * 0.8,
            };
            actor.set_position(crumb.x - csize / 2, crumb.y - csize / 2);
            this._crumbs.push(crumb);
        }
        this._startTick();
    }
}

class Extension {
    enable() {
        this._settings = ExtensionUtils.getSettings();
        I18n.bindSettings(this._settings);
        this._game = new SnowballGame(this._settings);
        this._id = this._settings.connect('changed::enabled', () => this._sync());
        Main.wm.addKeybinding('toggle-key', this._settings, Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._settings.set_boolean('enabled', !this._settings.get_boolean('enabled')));
        this._sync();
        this._indicator = new Festive.IndicatorManager('snowball-fight', () => T('Снежки', 'Snowballs'),
            `${Me.path}/icons/snowball-symbolic.svg`, this._settings, ind => {
                ind.addSwitch(T('Снежки', 'Snowballs'), 'enabled');
                ind.addVisibility();
                ind.addChoice(T('Горка', 'Pile'), 'corner', [['bottom-right', T('справа внизу', 'bottom right')], ['bottom-left', T('слева внизу', 'bottom left')]]);
                ind.addSlider(T('Сила броска', 'Throw power'), 'throw-power', 0.3, 3, false, v => v.toFixed(1));
                ind.addAction(T('Убрать следы со стен', 'Clear splats from the walls'), () => this._game.clearSplats());
                ind.addSeparator();
                ind.addPrefs();
            });
    }

    disable() {
        this._indicator.destroy();
        this._indicator = null;
        Main.wm.removeKeybinding('toggle-key');
        this._settings.disconnect(this._id);
        this._game.stop();
        this._game = null;
        this._settings = null;
    }

    _sync() {
        if (this._settings.get_boolean('enabled'))
            this._game.start();
        else
            this._game.stop();
    }
}

function init() {
    return new Extension();
}
