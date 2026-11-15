/* Snowfall Physics — GNOME Shell 42 extension.
 *
 * Снег падает поверх окон, оседает на верхней кромке окон и внизу экрана,
 * осыпается при тряске/перемещении окна и падает вниз при закрытии или
 * сворачивании окна.
 *
 * Архитектура (ради низкой нагрузки; узкое место — главный поток gnome-shell):
 *  - падающая снежинка — Clutter.Actor с ОДНОЙ общей текстурой; акторы берутся
 *    из пула и двигаются через set_translation (без пересчёта раскладки);
 *  - осевший снег — только данные; каждый сугроб (низ экрана, верх каждого
 *    окна) рисуется ОДНОЙ картинкой St.DrawingArea и перерисовывается не чаще
 *    4 раз в секунду — вместо сотен акторов;
 *  - сугроб окна стоит в window_group сразу над окном (перекрывается вместе
 *    с ним) и едет за окном по сигналу position-changed;
 *  - физика — таймер (рекомендуется 30 кадров/с); настройки читаются при
 *    изменении, а не каждый кадр;
 *  - все акторы reactive=false и не входят в input region — клики проходят.
 */
'use strict';

const { GLib, GObject, Clutter, St, Meta, Shell } = imports.gi;
const Cairo = imports.cairo;

const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const Slider = imports.ui.slider;
const ExtensionUtils = imports.misc.extensionUtils;
const I18n = ExtensionUtils.getCurrentExtension().imports.i18n;
const T = I18n.T;
const Festive = ExtensionUtils.getCurrentExtension().imports.festive;

const BIN = 4;            // ширина столбика сугроба, px
const GRAVITY = 600;      // px/с²
const WINDOW_CAP = 16;    // максимальная высота сугроба на окне, px
const GROUND_CAP = 46;    // максимальная высота сугроба внизу экрана, px
const REPOSE = 3.2;       // макс. перепад высот соседних столбиков (угол откоса)
const EDGE_HEIGHT = -0.5; // «высота» за краем окна: снег у края скатывается
const TELEPORT = 400;     // скачок окна за кадр, после которого снег падает целиком
const TEX = 16;
const FLUSH_INTERVAL = 0.25; // как часто перерисовывать сугробы, с

const SURFACE_TYPES = [
    Meta.WindowType.NORMAL,
    Meta.WindowType.DIALOG,
    Meta.WindowType.MODAL_DIALOG,
    Meta.WindowType.UTILITY,
];

function makeFlakeContent() {
    const canvas = new Clutter.Canvas();
    canvas.set_size(TEX, TEX);
    canvas.connect('draw', (c, cr, w, h) => {
        cr.save();
        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.restore();
        const g = new Cairo.RadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
        g.addColorStopRGBA(0, 1, 1, 1, 1);
        g.addColorStopRGBA(0.5, 1, 1, 1, 0.85);
        g.addColorStopRGBA(1, 0.92, 0.96, 1, 0);
        cr.setSource(g);
        cr.arc(w / 2, h / 2, w / 2, 0, 2 * Math.PI);
        cr.fill();
        cr.$dispose();
        return true;
    });
    canvas.invalidate();
    return canvas;
}

/* Сугроб: столбики шириной BIN, в каждом — стопка снежинок (только данные).
 * Рисуется одной картинкой (St.DrawingArea) — вместо сотен акторов. */
class Surface {
    constructor(nbins, cap, isGround) {
        this.cap = cap;
        this.isGround = isGround;
        this.bins = [];
        this.heights = [];
        this.baseY = [];
        this.count = 0;
        this.dirty = false;
        this.pending = [];   // акторы только что упавших снежинок — до перерисовки
        this.painter = null;
        this.ox = 0;         // положение системы координат сугроба на экране
        this.oy = 0;
        this.paintY = 0;     // где (в координатах сугроба) верх картинки
        this.resize(nbins);
    }

    get n() {
        return this.bins.length;
    }

    resize(nbins) {
        while (this.bins.length < nbins) {
            this.bins.push([]);
            this.heights.push(0);
            this.baseY.push(0);
        }
        this.bins.length = nbins;
        this.heights.length = nbins;
        this.baseY.length = nbins;
    }

    hasFloor(i) {
        return i >= 0 && i < this.n && this.baseY[i] !== Infinity;
    }

    neighbour(i) {
        if (i < 0 || i >= this.n)
            return this.isGround ? Infinity : EDGE_HEIGHT;
        if (this.baseY[i] === Infinity)
            return EDGE_HEIGHT;
        return this.heights[i];
    }

    // Куда скатится снежинка, упавшая в столбик i. -1 — скатилась с края.
    findRest(i) {
        for (let iter = 0; iter < 8; iter++) {
            const h = this.heights[i];
            const l = this.neighbour(i - 1);
            const r = this.neighbour(i + 1);
            let target = null;
            let best = h - REPOSE;
            if (l < best) {
                best = l;
                target = i - 1;
            }
            if (r < best || (r === best && target !== null && Math.random() < 0.5)) {
                best = r;
                target = i + 1;
            }
            if (target === null)
                break;
            if (!this.hasFloor(target))
                return -1;
            i = target;
        }
        if (this.heights[i] >= this.cap)
            return -1;
        return i;
    }

    randomNonEmptyBin() {
        const n = this.n;
        if (this.count === 0 || n === 0)
            return -1;
        for (let t = 0; t < 8; t++) {
            const i = (Math.random() * n) | 0;
            if (this.bins[i].length)
                return i;
        }
        const start = (Math.random() * n) | 0;
        for (let k = 0; k < n; k++) {
            const i = (start + k) % n;
            if (this.bins[i].length)
                return i;
        }
        return -1;
    }
}

function paintSurface(surf, area) {
    const cr = area.get_context();
    const py = surf.paintY;
    // сначала голубоватые «тени» снизу — объём, потом белые снежинки
    for (const stack of surf.bins) {
        for (const f of stack) {
            const r = f.size * 0.5;
            cr.setSourceRGBA(0.7, 0.78, 0.92, 0.32 * f.a);
            cr.arc(f.x, f.y - py + r * 0.35, r * 1.05, 0, 2 * Math.PI);
            cr.fill();
        }
    }
    for (const stack of surf.bins) {
        for (const f of stack) {
            const r = f.size * 0.5;
            cr.setSourceRGBA(1, 1, 1, 0.88 * f.a);
            cr.arc(f.x, f.y - py, r, 0, 2 * Math.PI);
            cr.fill();
        }
    }
    cr.$dispose();
}

class SnowEngine {
    constructor(settings) {
        this._settings = settings;
        this._running = false;
    }

    start() {
        if (this._running)
            return;
        this._running = true;
        this._signals = [];
        this._free = [];
        this._pool = [];
        this._trackers = new Map();
        this._settledCount = 0;
        this._time = 0;
        this._flushT = 0;
        this._paused = false;

        this._content = makeFlakeContent();
        this._layer = new Clutter.Actor({ name: 'snowfall-layer', reactive: false });
        // где показывать: поверх окон / только на пустом столе / под окнами
        this._fl = new Festive.FestiveLayer('snowfall', this._settings, () => this._updatePaused());
        this._fl.actor.add_child(this._layer);
        this._groundBox = new Clutter.Actor({ reactive: false });
        this._fallBox = new Clutter.Actor({ reactive: false });
        this._layer.add_child(this._groundBox);
        this._layer.add_child(this._fallBox);

        // настройки читаем не каждый кадр, а при изменении
        this._readCfg();
        this._connect(this._settings, 'changed', () => this._readCfg());

        this._buildGround();

        this._connect(Main.layoutManager, 'monitors-changed', () => this._buildGround());
        this._connect(global.stage, 'notify::width', () => this._buildGround());
        this._connect(global.stage, 'notify::height', () => this._buildGround());
        if (Main.layoutManager._startingUp)
            this._connect(Main.layoutManager, 'startup-complete', () => this._buildGround());
        this._connect(Main.overview, 'showing', () => this._updatePaused());
        this._connect(Main.overview, 'hidden', () => this._updatePaused());
        this._connect(global.display, 'in-fullscreen-changed', () => this._updatePaused());
        this._connect(global.display, 'restacked', () => this._restack());
        this._connect(this._settings, 'changed::flake-count', () => this._syncFlakeCount(false));
        this._connect(this._settings, 'changed::fps', () => this._startTimer());
        this._connect(this._settings, 'changed::hide-in-fullscreen', () => this._updatePaused());
        this._connect(this._settings, 'changed::settle-on-windows', () => {
            if (!this._settings.get_boolean('settle-on-windows'))
                this.shakeAll();
        });
        this._connect(this._settings, 'changed::settle-on-ground', () => {
            if (!this._settings.get_boolean('settle-on-ground'))
                this._meltSurface(this._ground, this._ground.count);
        });

        this._syncFlakeCount(true);
        this._updatePaused();
        this._startTimer();
    }

    stop() {
        if (!this._running)
            return;
        this._running = false;
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
        for (const [obj, id] of this._signals)
            obj.disconnect(id);
        this._signals = [];
        for (const t of [...this._trackers.values()])
            this._destroyTracker(t);
        this._trackers.clear();
        this._layer.destroy();
        this._layer = null;
        this._fl.destroy();
        this._fl = null;
        this._free = [];
        this._pool = [];
        this._ground = null;
        this._content = null;
    }

    _connect(obj, signal, cb) {
        this._signals.push([obj, obj.connect(signal, cb)]);
    }

    _readCfg() {
        const s = this._settings;
        this._cfg = {
            count: s.get_int('flake-count'),
            maxSettled: s.get_int('max-settled'),
            settleWin: s.get_boolean('settle-on-windows'),
            settleGround: s.get_boolean('settle-on-ground'),
            wind: s.get_double('wind'),
            meltTime: s.get_int('melt-time'),
            sens: s.get_int('shake-sensitivity'),
        };
    }

    _startTimer() {
        if (this._timerId)
            GLib.source_remove(this._timerId);
        const fps = this._settings.get_int('fps');
        this._last = GLib.get_monotonic_time() / 1e6;
        this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.round(1000 / fps), () => {
            try {
                this._tick();
            } catch (e) {
                logError(e, 'snowfall-physics: tick failed, stopping animation');
                this._timerId = 0;
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
        GLib.Source.set_name_by_id(this._timerId, '[snowfall-physics] tick');
    }

    _updatePaused() {
        const fullscreen = this._settings.get_boolean('hide-in-fullscreen') &&
            Main.layoutManager.monitors.some(m => m.inFullscreen);
        // в режиме «только на пустом столе» при открытых окнах снег на паузе
        this._paused = Main.overview.visible || fullscreen || (this._fl && !this._fl.shown);
        this._layer.visible = !this._paused;
        for (const t of this._trackers.values())
            this._syncTrackerVisibility(t);
    }

    // ---------- пул акторов падающих снежинок ----------

    _takeActor(size, opacity) {
        let a = this._pool.pop();
        if (!a) {
            a = new Clutter.Actor({ content: this._content, reactive: false });
            this._fallBox.add_child(a);
        }
        a.set_size(size, size);
        a.opacity = opacity;
        a.show();
        return a;
    }

    _giveActor(a) {
        a.hide();
        if (this._pool.length < 200)
            this._pool.push(a);
        else
            a.destroy();
    }

    _place(f) {
        f.actor.set_translation(f.x - f.size / 2, f.y - f.size / 2, 0);
    }

    // ---------- земля ----------

    _buildGround() {
        if (this._ground) {
            for (const a of this._ground.pending)
                this._giveActor(a);
            this._settledCount -= this._ground.count;
            this._ground.painter.destroy();
        }
        // Размер берём по мониторам: при старте Shell global.stage ещё может
        // иметь временный маленький размер.
        let W = global.stage.width, H = global.stage.height;
        for (const m of Main.layoutManager.monitors) {
            W = Math.max(W, m.x + m.width);
            H = Math.max(H, m.y + m.height);
        }
        this._W = W;
        this._H = H;
        const n = Math.ceil(W / BIN);
        const g = new Surface(n, GROUND_CAP, true);
        const monitors = Main.layoutManager.monitors;
        let minBottom = Infinity, maxBottom = 0;
        for (let i = 0; i < n; i++) {
            const cx = i * BIN + BIN / 2;
            let y = Infinity;
            for (const m of monitors) {
                if (cx >= m.x && cx < m.x + m.width) {
                    const bottom = m.y + m.height;
                    y = y === Infinity ? bottom : Math.max(y, bottom);
                }
            }
            g.baseY[i] = y;
            if (y !== Infinity) {
                minBottom = Math.min(minBottom, y);
                maxBottom = Math.max(maxBottom, y);
            }
        }
        if (minBottom === Infinity)
            minBottom = maxBottom = H;
        g.paintY = minBottom - GROUND_CAP - 14;
        g.painter = new St.DrawingArea({ reactive: false, width: W, height: maxBottom - g.paintY + 2 });
        g.painter.set_position(0, g.paintY);
        g.painter.connect('repaint', a => paintSurface(g, a));
        this._groundBox.add_child(g.painter);
        this._ground = g;
        // раскидать уже падающие снежинки по новой ширине экрана
        if (this._free)
            for (const f of this._free)
                if (f.k === f.k0)
                    this._respawn(f, true);
    }

    // ---------- снежинки ----------

    _flakeProps(size) {
        const k0 = GRAVITY / (35 + size * 9);
        return {
            size, k0, k: k0,
            x: 0, y: 0, vx: 0, vy: 0,
            phase: Math.random() * Math.PI * 2,
            swayAmp: 8 + Math.random() * 22,
            swayFreq: 0.4 + Math.random() * 1.2,
            grip: 0.5 + Math.random() * 2.5,
            h: size * 0.42,
            delay: 0,
            ignoreWin: null, ignoreUntil: 0,
        };
    }

    _newFlake(initial) {
        const r = Math.random();
        const size = 3 + r * r * 7;
        const f = this._flakeProps(size);
        f.opacity = Math.round(140 + (size - 3) / 7 * 115);
        f.actor = this._takeActor(size, f.opacity);
        this._respawn(f, initial);
        this._free.push(f);
        return f;
    }

    _respawn(f, initial) {
        const wind = this._cfg.wind;
        const margin = Math.min(400, Math.abs(wind) * 12) + 40;
        f.x = -margin + Math.random() * (this._W + 2 * margin);
        f.y = initial ? Math.random() * this._H : -10 - Math.random() * 60;
        f.k = f.k0;
        f.vx = 0;
        f.vy = GRAVITY / f.k;
        f.delay = 0;
        f.ignoreWin = null;
        this._place(f);
    }

    _syncFlakeCount(initial) {
        const target = this._cfg.count;
        while (this._free.length < target)
            this._newFlake(initial);
        while (this._free.length > target)
            this._giveActor(this._free.pop().actor);
    }

    // ---------- окна ----------

    _collectWindows() {
        const out = [];
        const ws = global.workspace_manager.get_active_workspace();
        const actors = global.get_window_actors();
        for (let i = actors.length - 1; i >= 0; i--) {
            const actor = actors[i];
            const win = actor.meta_window;
            if (!win || !actor.visible || win.minimized || win.is_override_redirect())
                continue;
            if (!win.located_on_workspace(ws))
                continue;
            const type = win.get_window_type();
            if (!SURFACE_TYPES.includes(type))
                continue;
            if (type === Meta.WindowType.NORMAL && win.skip_taskbar)
                continue;
            const r = win.get_frame_rect();
            let surface = !win.is_fullscreen();
            if (surface) {
                // Верх развёрнутого окна прячется под панелью — туда не сыплем.
                const wa = win.get_work_area_current_monitor();
                if (r.y <= wa.y + 1)
                    surface = false;
            }
            out.push({ win, actor, x: r.x, y: r.y, w: r.width, h: r.height, surface });
        }
        return out;
    }

    _getTracker(info) {
        let t = this._trackers.get(info.win);
        if (t)
            return t;
        const container = new Clutter.Actor({ reactive: false, name: 'snowfall-pile' });
        global.window_group.insert_child_above(container, info.actor);
        container.set_position(info.x, info.y);
        const surf = new Surface(Math.ceil(info.w / BIN), WINDOW_CAP, false);
        surf.paintY = -(WINDOW_CAP + 14);
        surf.ox = info.x;
        surf.oy = info.y;
        surf.painter = new St.DrawingArea({ reactive: false, width: info.w, height: WINDOW_CAP + 16 });
        surf.painter.set_position(0, surf.paintY);
        surf.painter.connect('repaint', a => paintSurface(surf, a));
        container.add_child(surf.painter);
        t = {
            win: info.win,
            actor: info.actor,
            container,
            surf,
            px: info.x, py: info.y, width: info.w,
            vx: 0, vy: 0,
            emptySince: 0,
            ids: [],
        };
        const w = info.win;
        t.ids.push([w, w.connect('position-changed', () => this._syncTrackerPos(t))]);
        t.ids.push([w, w.connect('size-changed', () => this._syncTrackerPos(t))]);
        t.ids.push([w, w.connect('notify::minimized', () => {
            if (w.minimized)
                this._dropAll(t, 0, 0);
        })]);
        t.ids.push([w, w.connect('unmanaged', () => {
            this._dropAll(t, 0, 0);
            this._destroyTracker(t);
        })]);
        // начало анимации закрытия — снег срывается сразу, а не после неё
        t.ids.push([global.window_manager, global.window_manager.connect('destroy', (wm, actor) => {
            if (actor === t.actor)
                this._dropAll(t, 0, 0);
        })]);
        // окно может исчезнуть и без unmanaged (порядок сигналов разный в X11/Wayland):
        // снег в любом случае осыпается, а не пропадает
        t.ids.push([info.actor, info.actor.connect('destroy', () => {
            this._dropAll(t, 0, 0);
            this._destroyTracker(t);
        })]);
        this._trackers.set(info.win, t);
        return t;
    }

    _syncTrackerPos(t) {
        if (t.destroyed)
            return;
        const r = t.win.get_frame_rect();
        if (r.x !== t.surf.ox || r.y !== t.surf.oy) {
            t.container.set_position(r.x, r.y);
            t.surf.ox = r.x;
            t.surf.oy = r.y;
            // только что упавшие снежинки — сразу в картинку, чтобы ехали с окном
            if (t.surf.pending.length)
                this._flushSurface(t.surf);
        }
    }

    _syncTrackerVisibility(t) {
        const v = !this._paused && t.actor.visible && !t.win.minimized;
        if (t.container.visible !== v)
            t.container.visible = v;
    }

    _destroyTracker(t) {
        if (t.destroyed)
            return;
        t.destroyed = true;
        for (const [obj, id] of t.ids)
            obj.disconnect(id);
        t.ids = [];
        this._settledCount -= t.surf.count;
        t.surf.count = 0;
        for (const a of t.surf.pending)
            this._giveActor(a);
        t.surf.pending = [];
        t.container.destroy();
        this._trackers.delete(t.win);
    }

    _restack() {
        for (const t of this._trackers.values()) {
            if (t.actor.get_parent() === global.window_group &&
                t.container.get_parent() === global.window_group &&
                t.actor.get_next_sibling() !== t.container)
                global.window_group.set_child_above_sibling(t.container, t.actor);
        }
    }

    _resizeTracker(t, width) {
        const n = Math.ceil(width / BIN);
        const s = t.surf;
        for (let i = n; i < s.n; i++)
            if (s.bins[i].length)
                this._releaseFrom(s, i, 0, { vx: 0, vy: 0, k: 0.8 }, t.win, false);
        s.resize(n);
        s.painter.width = width;
        this._flushSurface(s);
        t.width = width;
    }

    _updateTracker(t, dt) {
        const win = t.win;
        const r = win.get_frame_rect();
        this._syncTrackerVisibility(t);
        if (r.width !== t.width)
            this._resizeTracker(t, r.width);
        const dx = r.x - t.px;
        const dy = r.y - t.py;
        t.px = r.x;
        t.py = r.y;
        this._syncTrackerPos(t);
        if (!t.container.visible) {
            t.vx = t.vy = 0;
            return;
        }
        if (Math.abs(dx) + Math.abs(dy) > TELEPORT) {
            // развернули/перекинули на другой монитор: снег не удержался
            this._dropAll(t, 0, 0);
            t.vx = t.vy = 0;
            return;
        }
        const pvx = t.vx, pvy = t.vy;
        // сглаживаем скорость — движения мыши приходят неравномерно
        const vx = pvx + (dx / dt - pvx) * 0.6;
        const vy = pvy + (dy / dt - pvy) * 0.6;
        t.vx = vx;
        t.vy = vy;
        if (t.surf.count === 0)
            return;
        const ax = (vx - pvx) / dt;
        const ay = (vy - pvy) / dt;
        // Снег держится трением: срывает горизонтальное ускорение и
        // ускорение окна вниз (окно «уходит из-под» снега).
        const a = Math.hypot(ax, Math.max(0, ay));
        const gripBase = 6000 * Math.pow(2, (5 - this._cfg.sens) / 2);
        if (a < gripBase * 0.5)
            return;
        const s = t.surf;
        const cap = v => Math.max(-1500, Math.min(1500, v));
        let released = false;
        // срывается кусками: соседние столбики — одним комом
        let chunk = null, chunkLeft = 0;
        for (let i = 0; i < s.n; i++) {
            if (chunkLeft-- <= 0) {
                chunkLeft = 2 + ((Math.random() * 5) | 0);
                chunk = {
                    vx: cap(pvx) + (Math.random() - 0.5) * 120,
                    vy: cap(pvy) - Math.random() * 60,
                    k: 0.45 + Math.random() * 0.8,
                    jitter: 25,
                };
            }
            const stack = s.bins[i];
            for (let k = 0; k < stack.length; k++) {
                if (stack[k].grip * gripBase < a) {
                    this._releaseFrom(s, i, k, chunk, win, false);
                    released = true;
                    break;
                }
            }
        }
        if (released)
            this._flushSurface(s);
    }

    // ---------- осевший снег ----------

    _flushSurface(surf) {
        surf.dirty = false;
        surf.painter.queue_repaint();
        for (const a of surf.pending)
            this._giveActor(a);
        surf.pending = [];
    }

    _settle(f, surf, i, idx) {
        const hBefore = surf.heights[i];
        const lx = i * BIN + Math.random() * BIN;
        const cy = surf.baseY[i] - hBefore - f.size * 0.65 + f.size / 2;
        surf.bins[i].push({ size: f.size, h: f.h, x: lx, y: cy, grip: f.grip, a: (f.opacity ?? 230) / 255 });
        surf.heights[i] += f.h;
        surf.count++;
        surf.dirty = true;
        this._settledCount++;
        // снежинка видна на месте посадки, пока сугроб не перерисуется
        f.x = surf.ox + lx;
        f.y = surf.oy + cy;
        this._place(f);
        surf.pending.push(f.actor);

        // убираем из падающих (swap-remove) и выпускаем новую сверху
        const last = this._free.pop();
        if (last !== f)
            this._free[idx] = last;
        if (this._free.length < this._cfg.count)
            this._newFlake(false);
    }

    /* Отпускает снежинки столбика i начиная с k-й (и всё, что выше).
     * opts: {vx, vy, k, delay, jitter} — общий «ком» для соседних столбиков. */
    _releaseFrom(surf, i, k, opts, ignoreWin, flush = true) {
        const stack = surf.bins[i];
        if (k >= stack.length)
            return;
        const removed = stack.splice(k);
        const now = this._time;
        const jit = opts.jitter ?? 20;
        for (const d of removed) {
            surf.heights[i] -= d.h;
            surf.count--;
            this._settledCount--;
            const f = this._flakeProps(d.size);
            f.opacity = Math.round(d.a * 255);
            f.actor = this._takeActor(d.size, f.opacity);
            f.x = surf.ox + d.x;
            f.y = surf.oy + d.y;
            f.vx = opts.vx + (Math.random() - 0.5) * jit;
            f.vy = opts.vy - Math.random() * jit * 0.6;
            f.k = (opts.k ?? 0.8) * (0.85 + Math.random() * 0.3);
            f.delay = (opts.delay ?? 0) + Math.random() * 0.04;
            f.ignoreWin = ignoreWin;
            f.ignoreUntil = now + 0.8 + f.delay;
            this._place(f);
            this._free.push(f);
        }
        if (surf.heights[i] < 0.01)
            surf.heights[i] = 0;
        surf.dirty = true;
        if (flush)
            this._flushSurface(surf);
    }

    /* Окно закрыли/свернули/развернули: снег срывается кусками, не ровной
     * простынёй — у каждого куска свои скорость, тяжесть и задержка. */
    _dropAll(t, vx, vy) {
        if (t.destroyed)
            return;
        const s = t.surf;
        let i = 0;
        while (i < s.n) {
            const len = 2 + ((Math.random() * 6) | 0);
            const chunk = {
                vx: vx + (Math.random() - 0.5) * 160,
                vy: vy + Math.random() * 90,
                k: 0.35 + Math.random() * 0.75,
                delay: Math.random() * 0.28,
                jitter: 18,
            };
            for (let j = i; j < Math.min(s.n, i + len); j++) {
                if (s.bins[j].length)
                    this._releaseFrom(s, j, 0, chunk, t.win, false);
            }
            i += len;
        }
        this._flushSurface(s);
    }

    shakeAll() {
        if (!this._running)
            return;
        for (const t of this._trackers.values())
            this._dropAll(t, (Math.random() - 0.5) * 200, -80);
        this._meltSurface(this._ground, this._ground.count);
    }

    _meltSurface(surf, n) {
        for (let m = 0; m < n; m++) {
            const i = surf.randomNonEmptyBin();
            if (i < 0)
                break;
            const d = surf.bins[i].pop();
            surf.heights[i] -= d.h;
            if (surf.heights[i] < 0.01)
                surf.heights[i] = 0;
            surf.count--;
            this._settledCount--;
            surf.dirty = true;
        }
    }

    _meltTick(dt) {
        const meltTime = this._cfg.meltTime;
        const surfaces = [this._ground];
        for (const t of this._trackers.values())
            surfaces.push(t.surf);
        for (const s of surfaces) {
            if (!s.count)
                continue;
            const expected = s.count * dt / meltTime;
            const n = Math.floor(expected) + (Math.random() < expected % 1 ? 1 : 0);
            if (n)
                this._meltSurface(s, n);
        }
        // Перебор лимита — тает быстрее, но в первую очередь нижний сугроб:
        // маленькие сугробы на окнах иначе «съедались» бы так же быстро.
        let over = Math.min(40, this._settledCount - this._cfg.maxSettled);
        if (over > 0) {
            const take = Math.min(over, this._ground.count);
            this._meltSurface(this._ground, take);
            over -= take;
            if (over > 0) {
                const biggest = surfaces.reduce((m, x) => (x.count > m.count ? x : m), surfaces[0]);
                this._meltSurface(biggest, over);
            }
        }
        return surfaces;
    }

    _applyObstacles(obstacles, dt) {
        // Падающий снег сани не трогают (он идёт за упряжкой, не поверх неё),
        // а сугроб под санями выбрасывается назад и вверх — из-под полозьев.
        const ground = this._ground;
        for (const o of obstacles) {
            if (!ground || !ground.count)
                continue;
            const dir = Math.sign(o.vx) || 1;
            const b0 = Math.max(0, Math.floor(o.x / BIN));
            const b1 = Math.min(ground.n - 1, Math.floor((o.x + o.w) / BIN));
            if (b1 < b0)
                continue;
            let budget = Math.ceil(300 * dt);
            for (let tries = 0; tries < budget * 4 && budget > 0; tries++) {
                const i = b0 + ((Math.random() * (b1 - b0 + 1)) | 0);
                const stack = ground.bins[i];
                if (!stack.length)
                    continue;
                this._releaseFrom(ground, i, stack.length - 1, {
                    vx: -dir * (50 + Math.random() * 200),
                    vy: -(120 + Math.random() * 240),
                    k: 1.2 + Math.random(),
                    jitter: 20,
                }, null, false);
                budget--;
            }
            ground.dirty = true;
        }
    }

    // ---------- кадр ----------

    _tick() {
        const nowAbs = GLib.get_monotonic_time() / 1e6;
        let dt = nowAbs - this._last;
        this._last = nowAbs;
        if (this._paused || dt <= 0)
            return;
        if (dt > 0.1)
            dt = 0.1;
        this._time += dt;
        const now = this._time;
        const cfg = this._cfg;

        for (const t of [...this._trackers.values()]) {
            if (t.destroyed)
                continue;
            this._updateTracker(t, dt);
            if (t.surf.count === 0 && t.surf.pending.length === 0) {
                if (!t.emptySince)
                    t.emptySince = now;
                else if (now - t.emptySince > 4)
                    this._destroyTracker(t);
            } else {
                t.emptySince = 0;
            }
        }
        this._restack();

        // Другие праздничные расширения (сани Деда Мороза) кладут сюда
        // свои прямоугольники {x, y, w, h, vx}: снег под ними взметается.
        const obstacles = globalThis.__festiveObstacles;
        if (obstacles && obstacles.size)
            this._applyObstacles(obstacles, dt);

        const canSettle = cfg.maxSettled > 0;
        const wins = canSettle && cfg.settleWin ? this._collectWindows() : [];
        const ground = this._ground;
        const gust = cfg.wind + Math.sin(now * 0.11) * (6 + Math.abs(cfg.wind) * 0.5) +
            Math.sin(now * 0.37 + 1.3) * 4;
        const target = cfg.count;
        const W = this._W, H = this._H;

        const free = this._free;
        for (let idx = free.length - 1; idx >= 0; idx--) {
            const f = free[idx];
            if (f.delay > 0) {
                // кусок ещё держится — срывается чуть позже соседних
                f.delay -= dt;
                continue;
            }
            const prevY = f.y;
            const decay = Math.exp(-f.k * dt);
            const windX = gust + f.swayAmp * Math.sin(now * f.swayFreq + f.phase);
            f.vx = windX + (f.vx - windX) * decay;
            const vt = GRAVITY / f.k;
            f.vy = vt + (f.vy - vt) * decay;
            f.x += f.vx * dt;
            f.y += f.vy * dt;

            let settled = false;
            if (f.vy > 0 && canSettle) {
                // окна — сверху вниз по стеку
                for (let j = 0; j < wins.length && !settled; j++) {
                    const w = wins[j];
                    if (f.x < w.x || f.x >= w.x + w.w)
                        continue;
                    if (!w.surface || (f.ignoreWin === w.win && now < f.ignoreUntil))
                        continue;
                    const t = this._trackers.get(w.win);
                    const bin = Math.floor((f.x - w.x) / BIN);
                    const surfY = w.y - (t && bin < t.surf.n ? t.surf.heights[bin] : 0);
                    if (!(prevY < surfY && f.y >= surfY))
                        continue;
                    let occluded = false;
                    for (let m = 0; m < j; m++) {
                        const o = wins[m];
                        if (f.x >= o.x && f.x < o.x + o.w && surfY >= o.y && surfY < o.y + o.h) {
                            occluded = true;
                            break;
                        }
                    }
                    if (occluded)
                        continue;
                    const tr = t || this._getTracker(w);
                    const rest = bin < tr.surf.n ? tr.surf.findRest(bin) : -1;
                    if (rest >= 0) {
                        this._settle(f, tr.surf, rest, idx);
                        settled = true;
                    } else {
                        // скатилась с края — летит дальше
                        f.ignoreWin = w.win;
                        f.ignoreUntil = now + 1;
                        f.vx += (bin < tr.surf.n / 2 ? -1 : 1) * 30;
                    }
                    break;
                }
                if (!settled && cfg.settleGround) {
                    const bin = Math.floor(f.x / BIN);
                    if (ground.hasFloor(bin) && f.y >= ground.baseY[bin] - ground.heights[bin] &&
                        prevY < ground.baseY[bin]) {
                        const rest = ground.findRest(bin);
                        if (rest >= 0) {
                            this._settle(f, ground, rest, idx);
                            settled = true;
                        }
                    }
                }
            }
            if (settled)
                continue;

            if (f.y > H + 20 || f.x < -500 || f.x > W + 500) {
                if (free.length > target) {
                    this._giveActor(f.actor);
                    const last = free.pop();
                    if (last !== f)
                        free[idx] = last;
                } else {
                    this._respawn(f, false);
                }
                continue;
            }
            this._place(f);
        }

        const surfaces = this._meltTick(dt);
        // перерисовка сугробов — не чаще 4 раз в секунду
        this._flushT += dt;
        if (this._flushT >= FLUSH_INTERVAL) {
            this._flushT = 0;
            for (const s of surfaces) {
                if (s.dirty || s.pending.length)
                    this._flushSurface(s);
            }
        }
    }
}

// подпись ползунка с подсказкой о нагрузке
function countLabel(count) {
    if (count <= 150)
        return T(`Снежинок: ${count} — рекомендуется`, `Snowflakes: ${count} — recommended`);
    if (count <= 250)
        return T(`Снежинок: ${count} — повышенная нагрузка`, `Snowflakes: ${count} — higher load`);
    return T(`Снежинок: ${count} — ⚡ высокая нагрузка`, `Snowflakes: ${count} — ⚡ high load`);
}

const SnowIndicator = GObject.registerClass(
class SnowIndicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.0, 'Snowfall Physics');
        this.style = '-natural-hpadding: 5px; -minimum-hpadding: 3px;';
        this._ext = ext;
        const settings = ext._settings;
        this._settings = settings;

        this.add_child(new St.Icon({
            icon_name: 'weather-snow-symbolic',
            style_class: 'system-status-icon',
            style: 'margin: 0; padding: 4px 2px;',
        }));

        this._switch = new PopupMenu.PopupSwitchMenuItem(T('Снег', 'Snow'), settings.get_boolean('enabled'));
        this._switch.connect('toggled', (item, state) => settings.set_boolean('enabled', state));
        this.menu.addMenuItem(this._switch);

        this._countLabel = new PopupMenu.PopupMenuItem('', { reactive: false });
        this.menu.addMenuItem(this._countLabel);
        const sliderItem = new PopupMenu.PopupBaseMenuItem({ activate: false });
        this._slider = new Slider.Slider(0);
        this._slider.x_expand = true;
        this._slider.accessible_name = T('Количество снежинок', 'Number of snowflakes');
        sliderItem.add_child(this._slider);
        this.menu.addMenuItem(sliderItem);
        this._syncSlider();
        this._slider.connect('notify::value', () => {
            const count = Math.round(10 + this._slider.value * 390);
            this._countLabel.label.text = countLabel(count);
            if (this._debounce)
                GLib.source_remove(this._debounce);
            this._debounce = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                this._debounce = 0;
                settings.set_int('flake-count', count);
                return GLib.SOURCE_REMOVE;
            });
        });

        this._visIds = [];
        Festive.addChoiceMenu(this.menu, settings, T('Показывать', 'Show'), 'visibility', Festive.visibilityChoices(),
            cb => this._visIds.push(settings.connect('changed::visibility', cb)));

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const shake = new PopupMenu.PopupMenuItem(T('Стряхнуть весь снег', 'Shake off all snow'));
        shake.connect('activate', () => ext.shakeAll());
        this.menu.addMenuItem(shake);
        const prefs = new PopupMenu.PopupMenuItem(T('Настройки…', 'Settings…'));
        prefs.connect('activate', () => ExtensionUtils.openPrefs());
        this.menu.addMenuItem(prefs);

        this._ids = [
            settings.connect('changed::enabled',
                () => this._switch.setToggleState(settings.get_boolean('enabled'))),
            settings.connect('changed::flake-count', () => this._syncSlider()),
            ...this._visIds,
        ];
        this.connect('destroy', () => {
            for (const id of this._ids)
                settings.disconnect(id);
            if (this._debounce)
                GLib.source_remove(this._debounce);
        });
    }

    _syncSlider() {
        const count = this._settings.get_int('flake-count');
        this._countLabel.label.text = countLabel(count);
        if (!this._debounce)
            this._slider.value = (count - 10) / 390;
    }
});

class Extension {
    enable() {
        this._settings = ExtensionUtils.getSettings();
        I18n.bindSettings(this._settings);
        this._engine = new SnowEngine(this._settings);
        this._ids = [
            this._settings.connect('changed::enabled', () => this._syncEnabled()),
            this._settings.connect('changed::show-indicator', () => this._syncIndicator()),
            // сменили язык — пересобираем значок и меню
            this._settings.connect('changed::language', () => {
                I18n.bindSettings(this._settings);
                if (this._indicator) {
                    this._indicator.destroy();
                    this._indicator = null;
                }
                this._syncIndicator();
            }),
        ];
        Main.wm.addKeybinding('toggle-key', this._settings, Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._settings.set_boolean('enabled', !this._settings.get_boolean('enabled')));
        this._syncEnabled();
        this._syncIndicator();
    }

    disable() {
        Main.wm.removeKeybinding('toggle-key');
        for (const id of this._ids)
            this._settings.disconnect(id);
        this._ids = [];
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
        this._engine.stop();
        this._engine = null;
        this._settings = null;
    }

    shakeAll() {
        this._engine?.shakeAll();
    }

    _syncEnabled() {
        if (this._settings.get_boolean('enabled'))
            this._engine.start();
        else
            this._engine.stop();
    }

    _syncIndicator() {
        const show = this._settings.get_boolean('show-indicator');
        if (show && !this._indicator) {
            this._indicator = new SnowIndicator(this);
            Main.panel.addToStatusArea('snowfall-physics', this._indicator);
        } else if (!show && this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}

function init() {
    return new Extension();
}
