/* Garland Lights — GNOME Shell 42 extension.
 *
 * Новогодняя гирлянда провисает цепной линией вдоль верха главного экрана,
 * от левого края до правого, сразу под верхней панелью.
 *
 * Нагрузка минимальная: провод рисуется один раз (St.DrawingArea), текстуры
 * лампочек — по одной на цвет (Clutter.Canvas, общие для всех лампочек),
 * а мигание — это только смена opacity двух акторов на лампочку 20 раз в
 * секунду. Все акторы reactive=false — клики проходят насквозь.
 */
'use strict';

const { GLib, Clutter, St, Meta, Shell } = imports.gi;
const Cairo = imports.cairo;

const Main = imports.ui.main;
const ExtensionUtils = imports.misc.extensionUtils;
const I18n = ExtensionUtils.getCurrentExtension().imports.i18n;
const T = I18n.T;
const Me = ExtensionUtils.getCurrentExtension();
const Festive = Me.imports.festive;

const FPS = 20;
const BULB_W = 8;   // базовые размеры лампочки при масштабе 1
const BULB_H = 15;
const GLOW = 40;

// готовые цвета провода для меню
function wireColors() {
    return [
        ['#14381a', T('зелёный', 'green')],
        ['#111111', T('чёрный', 'black')],
        ['#f2f2f2', T('белый', 'white')],
        ['#c9a227', T('золотой', 'gold')],
        ['#b3121c', T('красный', 'red')],
        ['#a8adb5', T('серебряный', 'silver')],
    ];
}

const PALETTES = {
    multicolor: ['#ff3b30', '#34c759', '#0a84ff', '#ffd60a', '#ff2d92', '#ff9f0a'],
    warm: ['#ffcf70', '#ffb347', '#ffe4a8', '#ffc04d'],
    cold: ['#8fd3ff', '#4aa8ff', '#e0f4ff', '#6fb8ff'],
};

function parseColor(hex) {
    return [1, 3, 5].map(i => parseInt(hex.substr(i, 2), 16) / 255);
}

function makeCanvas(w, h, draw) {
    const canvas = new Clutter.Canvas();
    canvas.set_size(Math.ceil(w), Math.ceil(h));
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

// Лампочка: цоколь сверху + стеклянная «капля». lit=true — светящаяся.
function drawBulb(cr, w, h, rgb, lit) {
    const [r, g, b] = rgb;
    const capH = h * 0.24;
    // цоколь
    cr.setSourceRGBA(0.22, 0.24, 0.22, 1);
    cr.rectangle(w * 0.28, 0, w * 0.44, capH);
    cr.fill();
    cr.setSourceRGBA(0.45, 0.47, 0.45, 1);
    cr.rectangle(w * 0.28, capH * 0.35, w * 0.44, capH * 0.18);
    cr.fill();
    // стекло — вытянутый эллипс
    const cx = w / 2, cy = capH + (h - capH) / 2;
    const rx = w / 2 - 0.5, ry = (h - capH) / 2 - 0.2;
    cr.save();
    cr.translate(cx, cy);
    cr.scale(rx, ry);
    cr.arc(0, 0, 1, 0, 2 * Math.PI);
    cr.restore();
    if (lit) {
        const grad = new Cairo.RadialGradient(cx - rx * 0.25, cy - ry * 0.3, 0, cx, cy, Math.max(rx, ry));
        grad.addColorStopRGBA(0, 1, 1, 1, 1);
        grad.addColorStopRGBA(0.35, Math.min(1, r * 1.1 + 0.25), Math.min(1, g * 1.1 + 0.25), Math.min(1, b * 1.1 + 0.25), 1);
        grad.addColorStopRGBA(1, r, g, b, 1);
        cr.setSource(grad);
    } else {
        cr.setSourceRGBA(r * 0.35, g * 0.35, b * 0.35, 0.95);
    }
    cr.fill();
    // блик
    cr.setSourceRGBA(1, 1, 1, lit ? 0.7 : 0.25);
    cr.save();
    cr.translate(cx - rx * 0.35, cy - ry * 0.35);
    cr.scale(rx * 0.22, ry * 0.3);
    cr.arc(0, 0, 1, 0, 2 * Math.PI);
    cr.restore();
    cr.fill();
}

function drawGlow(cr, w, h, rgb) {
    const [r, g, b] = rgb;
    const grad = new Cairo.RadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    grad.addColorStopRGBA(0, r, g, b, 0.55);
    grad.addColorStopRGBA(0.35, r, g, b, 0.22);
    grad.addColorStopRGBA(1, r, g, b, 0);
    cr.setSource(grad);
    cr.arc(w / 2, h / 2, w / 2, 0, 2 * Math.PI);
    cr.fill();
}

// Параметр цепной линии a: a*cosh(half/a) - a = sag
function catenaryA(half, sag) {
    let lo = 1e-3, hi = 1e7;
    for (let i = 0; i < 100; i++) {
        const mid = (lo + hi) / 2;
        const s = mid * (Math.cosh(half / mid) - 1);
        if (!isFinite(s) || s > sag)
            lo = mid;
        else
            hi = mid;
    }
    return (lo + hi) / 2;
}

class Garland {
    constructor(settings) {
        this._settings = settings;
        this._running = false;
    }

    start() {
        if (this._running)
            return;
        this._running = true;
        this._signals = [];
        this._bulbs = [];
        this._time = 0;

        this._layer = new Clutter.Actor({ name: 'garland-layer', reactive: false });
        // где показывать: поверх окон / только на пустом столе / под окнами
        this._mode = this._settings.get_string('visibility');
        this._fl = new Festive.FestiveLayer('garland', this._settings, () => {
            const mode = this._settings.get_string('visibility');
            if (mode !== this._mode) {
                // шнурок ловит клики над окнами только в режиме «поверх окон»
                this._mode = mode;
                this._endPullDrag(false);
                this._queueRebuild();
            }
        });
        this._fl.actor.add_child(this._layer);

        const rebuild = () => this._queueRebuild();
        this._connect(Main.layoutManager, 'monitors-changed', rebuild);
        this._connect(global.display, 'workareas-changed', rebuild);
        this._connect(global.stage, 'notify::width', rebuild);
        if (Main.layoutManager._startingUp)
            this._connect(Main.layoutManager, 'startup-complete', rebuild);
        this._connect(this._settings, 'changed::lights-on', () => this._applyBrightness());
        for (const key of ['bulb-count', 'sag', 'bulb-scale', 'palette', 'show-pull', 'wire-color'])
            this._connect(this._settings, `changed::${key}`, rebuild);
        this._connect(Main.overview, 'showing', () => this._updateVisible());
        this._connect(Main.overview, 'hidden', () => this._updateVisible());
        this._connect(global.display, 'in-fullscreen-changed', () => this._updateVisible());
        this._connect(this._settings, 'changed::hide-in-fullscreen', () => this._updateVisible());

        this._build();
        this._updateVisible();
        this._last = GLib.get_monotonic_time() / 1e6;
        this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.round(1000 / FPS), () => {
            try {
                this._tick();
            } catch (e) {
                logError(e, 'garland-lights: tick failed, stopping animation');
                this._timerId = 0;
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
        GLib.Source.set_name_by_id(this._timerId, '[garland-lights] tick');
    }

    stop() {
        if (!this._running)
            return;
        this._running = false;
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
        if (this._rebuildId) {
            GLib.source_remove(this._rebuildId);
            this._rebuildId = 0;
        }
        for (const [obj, id] of this._signals)
            obj.disconnect(id);
        this._signals = [];
        this._destroyPull();
        this._layer.destroy();
        this._layer = null;
        this._fl.destroy();
        this._fl = null;
        this._bulbs = [];
    }

    _connect(obj, signal, cb) {
        this._signals.push([obj, obj.connect(signal, cb)]);
    }

    _queueRebuild() {
        if (this._rebuildId)
            return;
        this._rebuildId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            this._rebuildId = 0;
            if (this._running)
                this._build();
            return GLib.SOURCE_REMOVE;
        });
    }

    _updateVisible() {
        const fullscreen = this._settings.get_boolean('hide-in-fullscreen') &&
            Main.layoutManager.primaryMonitor?.inFullscreen;
        this._visible = !Main.overview.visible && !fullscreen;
        this._layer.visible = this._visible;
        if (this._pull)
            this._pull.box.visible = this._visible;
    }

    _destroyPull() {
        if (!this._pull)
            return;
        this._endPullDrag(false);
        if (this._pullHover)
            global.display.set_cursor(Meta.Cursor.DEFAULT);
        this._pullHover = false;
        if (this._pullTracked)
            Main.layoutManager.untrackChrome(this._pull.knob);
        this._pullTracked = false;
        this._pull.box.destroy();
        this._pull = null;
    }

    /* Шнурок-выключатель. Бусину можно тянуть мышью вниз: шнур растягивается,
     * отпустили — пружинит обратно, лампочки переключаются. Простой клик тоже
     * переключает (шнурок сам дёргается). Ловит клики только бусина. */
    _buildPull(x, y, scale) {
        const cordLen = Math.round(46 * scale);
        const w = Math.round(22 * scale);
        const knobRx = 4.5 * scale;
        const knobRy = 8 * scale;
        const knobH = Math.round(knobRy * 2 + 5 * scale);
        const maxStretch = Math.round(70 * scale);

        const box = new Clutter.Actor({ reactive: false, width: w, height: cordLen + knobH });
        box.set_position(Math.round(x - w / 2), Math.round(y));
        box.set_pivot_point(0.5, 0);
        const cord = new Clutter.Actor({
            reactive: false,
            background_color: new Clutter.Color({ red: 26, green: 26, blue: 26, alpha: 235 }),
            width: Math.max(1, 1.2 * scale),
            height: cordLen,
        });
        cord.set_position(Math.round(w / 2 - cord.width / 2), 0);
        const knob = new St.DrawingArea({
            reactive: true,
            track_hover: true,
            accessible_name: T('Гирлянда: потяните, чтобы включить или выключить лампочки', 'Garland: pull to turn the lights on or off'),
            width: w,
            height: knobH,
        });
        knob.set_position(0, cordLen);
        knob.connect('repaint', a => {
            const cr = a.get_context();
            const cx = w / 2;
            const knobY = knobH - knobRy - 1;
            cr.setSourceRGBA(0.18, 0.18, 0.18, 1);
            cr.rectangle(cx - 2 * scale, 0, 4 * scale, 4 * scale);
            cr.fill();
            cr.save();
            cr.translate(cx, knobY);
            cr.scale(knobRx, knobRy);
            const g = new Cairo.RadialGradient(-0.35, -0.4, 0, 0, 0, 1);
            g.addColorStopRGBA(0, 0.55, 0.55, 0.55, 1);
            g.addColorStopRGBA(0.35, 0.12, 0.12, 0.12, 1);
            g.addColorStopRGBA(1, 0.02, 0.02, 0.02, 1);
            cr.setSource(g);
            cr.arc(0, 0, 1, 0, 2 * Math.PI);
            cr.fill();
            cr.restore();
            cr.$dispose();
        });
        box.add_child(cord);
        box.add_child(knob);
        this._pull = { box, cord, knob, cordLen, maxStretch, scale };

        knob.connect('notify::hover', () => {
            if (this._pullDrag)
                return;
            this._pullHover = knob.hover;
            global.display.set_cursor(knob.hover ? Meta.Cursor.POINTING_HAND : Meta.Cursor.DEFAULT);
            box.ease({
                rotation_angle_z: knob.hover ? 5 : 0,
                duration: 200,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        });
        knob.connect('button-press-event', (a, ev) => {
            if (ev.get_button() !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_PROPAGATE;
            this._startPullDrag(ev);
            return Clutter.EVENT_STOP;
        });

        this._layer.add_child(box);
        if (this._settings.get_string('visibility') === 'above') {
            Main.layoutManager.trackChrome(knob, { affectsInputRegion: true });
            this._pullTracked = true;
        }
        box.visible = this._visible !== false;
    }

    _setStretch(px) {
        const p = this._pull;
        p.cord.height = p.cordLen + px;
        p.knob.translation_y = px;
    }

    _startPullDrag(ev) {
        const p = this._pull;
        if (!p || this._pullDrag)
            return;
        p.cord.remove_all_transitions();
        p.knob.remove_all_transitions();
        p.box.remove_all_transitions();
        p.box.rotation_angle_z = 0;
        const [, y0] = ev.get_coords();
        const grab = Main.pushModal(p.knob, { actionMode: Shell.ActionMode.NORMAL });
        this._pullDrag = { grab, y0, moved: 0, stretch: 0 };
        global.display.set_cursor(Meta.Cursor.DND_IN_DRAG);
        this._pullDragId = p.knob.connect('captured-event', (a, e) => {
            const t = e.type();
            if (t === Clutter.EventType.MOTION) {
                const [, y] = e.get_coords();
                const dy = Math.max(0, y - this._pullDrag.y0);
                this._pullDrag.moved = Math.max(this._pullDrag.moved, Math.abs(y - this._pullDrag.y0));
                // резиновая растяжка: чем дальше тянешь, тем туже
                const s = p.maxStretch * (1 - Math.exp(-dy / p.maxStretch));
                this._pullDrag.stretch = s;
                this._setStretch(s);
                return Clutter.EVENT_STOP;
            }
            if (t === Clutter.EventType.BUTTON_RELEASE) {
                this._endPullDrag(true);
                return Clutter.EVENT_STOP;
            }
            if (t === Clutter.EventType.KEY_PRESS && e.get_key_symbol() === Clutter.KEY_Escape) {
                this._endPullDrag(false);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_STOP;
        });
    }

    _endPullDrag(commit) {
        const d = this._pullDrag;
        if (!d)
            return;
        this._pullDrag = null;
        const p = this._pull;
        if (this._pullDragId) {
            p.knob.disconnect(this._pullDragId);
            this._pullDragId = 0;
        }
        try {
            Main.popModal(d.grab);
        } catch (e) {
            logError(e, 'garland-lights: popModal');
        }
        global.display.set_cursor(p.knob.hover ? Meta.Cursor.POINTING_HAND : Meta.Cursor.DEFAULT);
        const click = d.moved < 4;
        const pulled = d.stretch > 10 * p.scale;
        if (commit && (click || pulled))
            this._settings.set_boolean('lights-on', !this._settings.get_boolean('lights-on'));
        const springBack = () => {
            p.cord.ease({ height: p.cordLen, duration: 550, mode: Clutter.AnimationMode.EASE_OUT_ELASTIC });
            p.knob.ease({ translation_y: 0, duration: 550, mode: Clutter.AnimationMode.EASE_OUT_ELASTIC });
        };
        if (commit && click) {
            // простой клик: шнурок сам дёргается вниз и пружинит
            const s = 14 * p.scale;
            p.cord.ease({ height: p.cordLen + s, duration: 90, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
            p.knob.ease({
                translation_y: s,
                duration: 90,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: springBack,
            });
        } else {
            springBack();
        }
    }

    _build() {
        this._destroyPull();
        this._layer.destroy_all_children();
        this._bulbs = [];
        const mon = Main.layoutManager.primaryMonitor;
        if (!mon)
            return;
        const wa = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
        const top = Math.max(mon.y, wa.y) - 3;   // крепим чуть под край панели
        const x0 = mon.x - 6;
        const span = mon.width + 12;
        const sag = this._settings.get_int('sag');
        const half = span / 2;
        const a = catenaryA(half, sag);
        // цепная линия: края на высоте top, середина ниже на sag
        const wireY = x => top + sag - a * (Math.cosh((x - x0 - half) / a) - 1);

        // провод: цвет из настроек, вторая жилка чуть светлее/темнее для объёма
        let wireRgb = parseColor('#14381a');
        const wc = this._settings.get_string('wire-color');
        if (/^#[0-9a-fA-F]{6}$/.test(wc))
            wireRgb = parseColor(wc);
        const lum = 0.3 * wireRgb[0] + 0.59 * wireRgb[1] + 0.11 * wireRgb[2];
        const shade = lum > 0.5 ? 0.78 : 1.6;
        const wireRgb2 = wireRgb.map(c => Math.min(1, c * shade + (lum > 0.5 ? 0 : 0.04)));
        const wire = new St.DrawingArea({ reactive: false, width: span, height: sag + 16 });
        wire.set_position(x0, top - 6);
        wire.connect('repaint', area => {
            const cr = area.get_context();
            const steps = Math.max(40, Math.round(span / 8));
            const strand = (offset, alpha, rgb) => {
                cr.newPath();
                for (let k = 0; k <= steps; k++) {
                    const lx = span * k / steps;
                    const ly = wireY(x0 + lx) - top + 6 + offset * Math.sin(lx / 7);
                    if (k === 0)
                        cr.moveTo(lx, ly);
                    else
                        cr.lineTo(lx, ly);
                }
                cr.setSourceRGBA(rgb[0], rgb[1], rgb[2], alpha);
                cr.setLineWidth(1);
                cr.stroke();
            };
            strand(0.6, 0.95, wireRgb);
            strand(-0.6, 0.85, wireRgb2);
            cr.$dispose();
        });
        this._layer.add_child(wire);

        // лампочки: равномерно по длине дуги
        const n = this._settings.get_int('bulb-count');
        const scale = this._settings.get_double('bulb-scale');
        const bw = BULB_W * scale, bh = BULB_H * scale, gs = GLOW * scale;
        const colors = PALETTES[this._settings.get_string('palette')] || PALETTES.multicolor;
        const textures = colors.map(hex => {
            const rgb = parseColor(hex);
            return {
                off: makeCanvas(bw, bh, (cr, w, h) => drawBulb(cr, w, h, rgb, false)),
                on: makeCanvas(bw, bh, (cr, w, h) => drawBulb(cr, w, h, rgb, true)),
                glow: makeCanvas(gs, gs, (cr, w, h) => drawGlow(cr, w, h, rgb)),
            };
        });

        const samples = [];
        let len = 0;
        let px = x0, py = wireY(x0);
        const steps = 2000;
        samples.push([0, px, py]);
        for (let k = 1; k <= steps; k++) {
            const x = x0 + span * k / steps;
            const y = wireY(x);
            len += Math.hypot(x - px, y - py);
            samples.push([len, x, y]);
            px = x;
            py = y;
        }
        let si = 0;
        for (let i = 0; i < n; i++) {
            const target = len * (i + 0.5) / n;
            while (si < samples.length - 1 && samples[si + 1][0] < target)
                si++;
            const [, bx, by] = samples[si];
            const tex = textures[i % textures.length];

            const holder = new Clutter.Actor({ reactive: false });
            holder.set_position(bx - gs / 2, by - 2);
            const glow = new Clutter.Actor({ content: tex.glow, width: gs, height: gs, reactive: false });
            glow.set_position(0, bh * 0.6 - gs / 2);
            const bulbBox = new Clutter.Actor({ reactive: false });
            bulbBox.set_position((gs - bw) / 2, 0);
            bulbBox.set_size(bw, bh);
            bulbBox.set_pivot_point(0.5, 0);
            bulbBox.rotation_angle_z = (Math.random() - 0.5) * 30;
            const off = new Clutter.Actor({ content: tex.off, width: bw, height: bh, reactive: false });
            const on = new Clutter.Actor({ content: tex.on, width: bw, height: bh, reactive: false });
            bulbBox.add_child(off);
            bulbBox.add_child(on);
            holder.add_child(glow);
            holder.add_child(bulbBox);
            this._layer.add_child(holder);
            this._bulbs.push({
                on, glow, i,
                phase: Math.random() * Math.PI * 2,
                freq: 0.5 + Math.random() * 1.1,
            });
        }
        if (this._settings.get_boolean('show-pull')) {
            const pxPos = x0 + span - Math.max(40, span * 0.03);
            this._buildPull(pxPos, wireY(pxPos) - 1, Math.max(0.8, scale));
        }
        this._applyBrightness();
    }

    _brightness(bulb, n, t, mode) {
        switch (mode) {
        case 'chase': {
            const c = Math.cos(2 * Math.PI * (bulb.i / 6 - t * 0.6));
            return Math.pow(Math.max(0, c), 3);
        }
        case 'alternate': {
            const s = 0.5 + 0.5 * Math.sin(t * Math.PI * 0.8 + (bulb.i % 2) * Math.PI);
            return s * s * (3 - 2 * s);
        }
        case 'steady':
            return 0.88 + 0.12 * Math.sin(t * 0.7 * bulb.freq + bulb.phase);
        case 'twinkle':
        default: {
            const s = 0.5 + 0.5 * Math.sin(t * bulb.freq * Math.PI + bulb.phase);
            return s * s;
        }
        }
    }

    _applyBrightness() {
        const mode = this._settings.get_string('mode');
        const n = this._bulbs.length;
        if (!this._settings.get_boolean('lights-on')) {
            for (const bulb of this._bulbs) {
                bulb.on.opacity = 0;
                bulb.glow.opacity = 0;
            }
            return;
        }
        for (const bulb of this._bulbs) {
            const b = Math.max(0, Math.min(1, this._brightness(bulb, n, this._time, mode)));
            bulb.on.opacity = Math.round(255 * (0.1 + 0.9 * b));
            bulb.glow.opacity = Math.round(255 * b);
        }
    }

    _tick() {
        const now = GLib.get_monotonic_time() / 1e6;
        const dt = Math.min(0.2, now - this._last);
        this._last = now;
        if (!this._visible || !this._fl.shown || !this._settings.get_boolean('lights-on'))
            return;
        this._time += dt * this._settings.get_double('speed');
        this._applyBrightness();
    }
}

class Extension {
    enable() {
        this._settings = ExtensionUtils.getSettings();
        I18n.bindSettings(this._settings);
        this._garland = new Garland(this._settings);
        this._enabledId = this._settings.connect('changed::enabled', () => this._sync());
        Main.wm.addKeybinding('toggle-key', this._settings, Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._settings.set_boolean('enabled', !this._settings.get_boolean('enabled')));
        this._sync();
        this._indicator = new Festive.IndicatorManager('garland-lights', () => T('Гирлянда', 'Garland'),
            `${Me.path}/icons/garland-symbolic.svg`, this._settings, ind => {
                ind.addSwitch(T('Гирлянда', 'Garland'), 'enabled');
                ind.addSwitch(T('Лампочки горят', 'Lights on'), 'lights-on');
                ind.addVisibility();
                ind.addChoice(T('Режим', 'Mode'), 'mode', [
                    ['twinkle', T('Мерцание', 'Twinkle')], ['chase', T('Бегущие огни', 'Chase')],
                    ['alternate', T('Попеременно', 'Alternate')], ['steady', T('Ровный свет', 'Steady')],
                ]);
                ind.addChoice(T('Цвет провода', 'Wire color'), 'wire-color', wireColors());
                ind.addChoice(T('Цвета лампочек', 'Bulb colors'), 'palette', [
                    ['multicolor', T('Разноцветные', 'Multicolor')], ['warm', T('Тёплые', 'Warm')], ['cold', T('Холодные', 'Cold')],
                ]);
                ind.addSlider(T('Скорость мигания', 'Blink speed'), 'speed', 0.2, 4, false, v => v.toFixed(1));
                ind.addSeparator();
                ind.addPrefs();
            });
    }

    disable() {
        this._indicator.destroy();
        this._indicator = null;
        Main.wm.removeKeybinding('toggle-key');
        this._settings.disconnect(this._enabledId);
        this._garland.stop();
        this._garland = null;
        this._settings = null;
    }

    _sync() {
        if (this._settings.get_boolean('enabled'))
            this._garland.start();
        else
            this._garland.stop();
    }
}

function init() {
    return new Extension();
}
