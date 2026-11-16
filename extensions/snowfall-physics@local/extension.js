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
 *  - все акторы снега reactive=false и не входят в input region — клики
 *    проходят; ловят мышь только слепленные снежки/снеговики (маленькие
 *    области, и только когда их не закрывает другое окно);
 *  - снежок катается без нажатия: курсор ведут вдоль сугроба (опрос
 *    положения курсора раз в кадр, без перехвата ввода).
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
const Snowman = ExtensionUtils.getCurrentExtension().imports.snowman;

const BIN = 4;            // ширина столбика сугроба, px
const GRAVITY = 600;      // px/с²
const GROUND_CAP = 46;    // максимальная высота сугроба внизу экрана, px
const REPOSE = 3.2;       // макс. перепад высот соседних столбиков (угол откоса)
const EDGE_HEIGHT = -0.5; // «высота» за краем окна: снег у края скатывается
const TELEPORT = 400;     // скачок окна за кадр, после которого снег падает целиком
const TEX = 16;
const FLUSH_INTERVAL = 0.25; // как часто перерисовывать сугробы, с
const LIP = 4;            // снег чуть свисает на заголовок окна, px
const MAX_STACKS = 14;    // снежков и снеговиков одновременно
const START_R = 6;        // радиус нового снежка
const MAX_R = 38;         // больше снежок не растёт
const ROLL_START = 26;    // сколько провести курсором по сугробу, чтобы начать катать, px
const BALL_GRAVITY = 1500;

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
        this.padX = 0;       // запас картинки слева/справа под свес снега
        this.edge = EDGE_HEIGHT; // «высота» за краем окна (снег держится у края)
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
            return this.isGround ? Infinity : this.edge;
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

// путь контура сугроба на участке столбиков i..j (сглаженный, со свесами по краям окна)
function surfacePath(cr, surf, hs, i, j) {
    const n = surf.n;
    const base = k => surf.baseY[k];
    const isWin = !surf.isGround;
    const left = i * BIN, right = (j + 1) * BIN;
    const hl = hs[i], hr = hs[j];
    const ovL = isWin && i === 0 && hl > 4 ? Math.min(surf.padX - 2, hl * 0.45) : 0;
    const ovR = isWin && j === n - 1 && hr > 4 ? Math.min(surf.padX - 2, hr * 0.45) : 0;
    const lip = isWin ? Math.min(LIP, hl * 0.3) : 0;
    cr.newPath();
    if (ovL) {
        // снежная «шапка» свисает за край окна округлым комом
        cr.moveTo(left + 2, base(i) + lip);
        cr.curveTo(left - ovL * 0.6, base(i) + Math.min(hl * 0.35, 9),
            left - ovL * 1.25, base(i) - hl * 0.55, left + 1, base(i) - hl);
    } else {
        cr.moveTo(left, base(i) + lip);
        cr.lineTo(left, base(i) - hl);
    }
    // верх: квадратичное сглаживание по центрам столбиков
    const pts = [[left, base(i) - hl]];
    for (let k = i; k <= j; k++)
        pts.push([k * BIN + BIN / 2, base(k) - hs[k]]);
    pts.push([right, base(j) - hr]);
    let [sx, sy] = pts[0];
    for (let k = 1; k < pts.length - 1; k++) {
        const [cx, cy] = pts[k];
        const ex = (cx + pts[k + 1][0]) / 2, ey = (cy + pts[k + 1][1]) / 2;
        cr.curveTo(sx + (cx - sx) * 2 / 3, sy + (cy - sy) * 2 / 3, ex + (cx - ex) * 2 / 3, ey + (cy - ey) * 2 / 3, ex, ey);
        sx = ex;
        sy = ey;
    }
    cr.lineTo(right - (ovR ? 1 : 0), base(j) - hr);
    const lipR = isWin ? Math.min(LIP, hr * 0.3) : 0;
    if (ovR) {
        cr.curveTo(right + ovR * 1.25, base(j) - hr * 0.55,
            right + ovR * 0.6, base(j) + Math.min(hr * 0.35, 9), right - 2, base(j) + lipR);
    } else {
        cr.lineTo(right, base(j) + lipR);
    }
    // низ — вдоль опоры
    for (let k = j; k >= i; k--) {
        const l = isWin ? Math.min(LIP, hs[k] * 0.3) : 0;
        cr.lineTo(k * BIN + BIN / 2, base(k) + l);
    }
    cr.closePath();
}

/* Сугроб рисуется сплошной снежной массой: сглаженный контур по высотам
 * столбиков, объём градиентом, тень на окне, комочки сверху. */
function paintSurface(surf, area) {
    const cr = area.get_context();
    const n = surf.n;
    if (!surf.count || !n) {
        cr.$dispose();
        return;
    }
    cr.translate(surf.padX, -surf.paintY);
    // Широкое сглаживание: отдельная снежинка не торчит точкой, а растекается
    // по соседним столбикам — снег сразу ложится ровным слоем в сугроб.
    let hs = surf.heights.slice();
    for (let pass = 0; pass < 3; pass++) {
        const out = new Array(n);
        for (let k = 0; k < n; k++) {
            if (surf.baseY[k] === Infinity) {
                out[k] = 0;
                continue;
            }
            let sum = 0, w = 0;
            for (let d = -3; d <= 3; d++) {
                const m = k + d;
                if (m < 0 || m >= n || surf.baseY[m] === Infinity)
                    continue;
                sum += hs[m];
                w++;
            }
            out[k] = sum / w;
        }
        hs = out;
    }
    const segs = [];
    let i = 0;
    while (i < n) {
        if (surf.baseY[i] === Infinity || hs[i] <= 1.2) {
            i++;
            continue;
        }
        let j = i;
        while (j + 1 < n && surf.baseY[j + 1] !== Infinity && hs[j + 1] > 1.2)
            j++;
        segs.push([i, j]);
        i = j + 1;
    }
    let minBase = Infinity;
    for (let k = 0; k < n; k++)
        if (surf.baseY[k] !== Infinity)
            minBase = Math.min(minBase, surf.baseY[k]);
    const grad = new Cairo.LinearGradient(0, minBase - surf.cap, 0, minBase + LIP);
    grad.addColorStopRGBA(0, 1, 1, 1, 0.98);
    grad.addColorStopRGBA(0.6, 0.96, 0.975, 1, 0.97);
    grad.addColorStopRGBA(1, 0.78, 0.84, 0.95, 0.96);

    for (const [a, b] of segs) {
        // тень на окне под сугробом
        cr.save();
        cr.translate(0.5, 2.5);
        surfacePath(cr, surf, hs, a, b);
        cr.setSourceRGBA(0.08, 0.12, 0.28, 0.2);
        cr.fill();
        cr.restore();
        surfacePath(cr, surf, hs, a, b);
        cr.setSource(grad);
        cr.fillPreserve();
        cr.setSourceRGBA(0.62, 0.7, 0.88, 0.45);
        cr.setLineWidth(1);
        cr.stroke();
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
        this._stacks = new Set();
        this._roll = null;
        this._rollTrack = null;
        this._drag = null;
        this._rollFlushT = 0;

        this._content = makeFlakeContent();
        this._layer = new Clutter.Actor({ name: 'snowfall-layer', reactive: false });
        // где показывать: поверх окон / только на пустом столе / под окнами
        this._fl = new Festive.FestiveLayer('snowfall', this._settings, () => this._updatePaused());
        this._fl.actor.add_child(this._layer);
        this._groundBox = new Clutter.Actor({ reactive: false });
        this._fallBox = new Clutter.Actor({ reactive: false });
        this._ballBox = new Clutter.Actor({ reactive: false });
        this._layer.add_child(this._groundBox);
        this._layer.add_child(this._ballBox);
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

        this._connect(this._settings, 'changed::drift-height', () => {
            for (const t of this._trackers.values())
                this._layoutPainter(t);
        });
        this._connect(this._settings, 'changed::snowballs', () => {
            if (!this._cfg.snowballs)
                this.clearSnowmen();
        });

        this._syncFlakeCount(true);
        this._updatePaused();
        this._startTimer();

        // Для других праздничных расширений: сани Деда Мороза врезаются
        // в снежный шар/снеговика внизу экрана — шар разлетается.
        this._groundApi = {
            heightAt: (x0, x1) => this._groundHeight(x0, x1),
            blast: (x0, x1, dir) => this._blastGround(x0, x1, dir),
            hitBall: (x0, x1, dir) => this._hitBall(x0, x1, dir),
        };
        globalThis.__festiveGround = this._groundApi;
    }

    _groundHeight(x0, x1) {
        const g = this._ground;
        if (!this._running || this._paused || !g || !g.count)
            return 0;
        const b0 = Math.max(0, Math.floor(Math.min(x0, x1) / BIN));
        const b1 = Math.min(g.n - 1, Math.floor(Math.max(x0, x1) / BIN));
        let h = 0;
        for (let i = b0; i <= b1; i++)
            h = Math.max(h, g.heights[i]);
        return h;
    }

    // Есть ли внизу экрана снежок/снеговик в полосе x0..x1? Если да — он
    // разлетается от удара, а функция возвращает true.
    _hitBall(x0, x1, dir) {
        if (!this._running || this._paused || !this._stacks)
            return false;
        const lo = Math.min(x0, x1), hi = Math.max(x0, x1);
        for (const st of this._stacks) {
            if (st.owner || (st.state !== 'rest' && st.state !== 'roll'))
                continue;
            const r = st.geo.c[0].r;
            const g = this._ground;
            const b = Math.floor(st.x / BIN);
            // только те, что стоят на земле (не висят в воздухе над окном)
            if (!g.hasFloor(b) || st.y < g.baseY[b] - GROUND_CAP - 4)
                continue;
            if (st.x + r < lo || st.x - r > hi)
                continue;
            this._shatter(st, dir);
            return true;
        }
        return false;
    }

    // шар (или снеговик) разлетается на снежные комья
    _shatter(st, dir) {
        const [sx, sy] = this._screenOf(st);
        const now = this._time;
        for (const c of st.geo.c) {
            const n = Math.max(14, Math.min(70, Math.round(c.r * 1.8)));
            for (let k = 0; k < n; k++) {
                const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * c.r;
                const size = 3 + Math.random() * 8;
                const f = this._flakeProps(size);
                f.opacity = 235;
                f.actor = this._takeActor(size, f.opacity);
                f.x = sx + Math.cos(a) * d;
                f.y = sy + c.y + Math.sin(a) * d;
                // комья летят вперёд по ходу саней и вверх, во все стороны от центра
                f.vx = dir * (40 + Math.random() * 280) + Math.cos(a) * 160;
                f.vy = -(120 + Math.random() * 420) + Math.sin(a) * 90;
                f.k = 1.0 + Math.random() * 0.8;
                f.ignoreUntil = now;
                this._place(f);
                this._free.push(f);
            }
        }
        this._destroyStack(st);
    }

    // сугроб разлетается вверх и вперёд
    _blastGround(x0, x1, dir) {
        const g = this._ground;
        if (!this._running || !g)
            return;
        const b0 = Math.max(0, Math.floor(Math.min(x0, x1) / BIN));
        const b1 = Math.min(g.n - 1, Math.floor(Math.max(x0, x1) / BIN));
        for (let i = b0; i <= b1; i++) {
            if (!g.bins[i].length)
                continue;
            this._releaseFrom(g, i, 0, {
                vx: dir * (60 + Math.random() * 320),
                vy: -(220 + Math.random() * 520),
                k: 0.9 + Math.random() * 0.8,
                jitter: 160,
            }, null, false);
        }
        this._flushSurface(g);
    }

    stop() {
        if (!this._running)
            return;
        this._running = false;
        if (globalThis.__festiveGround === this._groundApi)
            delete globalThis.__festiveGround;
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
        for (const [obj, id] of this._signals)
            obj.disconnect(id);
        this._signals = [];
        this._endDrag(false);
        this._roll = null;
        for (const st of [...this._stacks])
            this._destroyStack(st);
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
            driftH: s.get_int('drift-height'),
            // сколько «высоты» даёт одна осевшая снежинка: больше — сугробы плотнее и быстрее
            acc: 0.4 + s.get_int('drift-accumulation') * 0.5,
            snowballs: s.get_boolean('snowballs'),
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
        if (this._paused) {
            this._endDrag(false);
            this._stopRoll();
        }
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
            h: size * 0.42 * this._cfg.acc,
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
        const surf = new Surface(Math.ceil(info.w / BIN), this._cfg.driftH, false);
        surf.ox = info.x;
        surf.oy = info.y;
        surf.painter = new St.DrawingArea({ reactive: false });
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
        this._layoutPainter(t);
        return t;
    }

    // размер картинки сугроба окна: высота сугроба + запас под свес по бокам
    _layoutPainter(t) {
        const s = t.surf;
        const cap = this._cfg.driftH;
        s.cap = cap;
        s.edge = cap * 0.55;
        s.padX = Math.ceil(cap * 0.5) + 4;
        s.paintY = -(cap + 14);
        s.painter.set_position(-s.padX, s.paintY);
        s.painter.set_size(t.width + 2 * s.padX, cap + 14 + LIP + 4);
        s.painter.queue_repaint();
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
        // снежки и снеговики с этого окна падают вниз
        this._dropStacks(t, 0, 0);
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
        t.width = width;
        this._layoutPainter(t);
        this._flushSurface(s);
        for (const st of this._stacks) {
            if (st.owner === t && st.state === 'rest' && st.x > width)
                this._fallStack(st, 0, 0);
        }
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
        const ax = (vx - pvx) / dt;
        const ay = (vy - pvy) / dt;
        // Снег держится трением: срывает горизонтальное ускорение и
        // ускорение окна вниз (окно «уходит из-под» снега).
        const a = Math.hypot(ax, Math.max(0, ay));
        const gripBase = 6000 * Math.pow(2, (5 - this._cfg.sens) / 2);
        const cap = v => Math.max(-1500, Math.min(1500, v));
        // снеговики стоят крепче снега, но сильную тряску не выдерживают
        if (a > gripBase * 2.2)
            this._dropStacks(t, cap(pvx) * 0.6, cap(pvy) * 0.6 - 80);
        if (a < gripBase * 0.5 || t.surf.count === 0)
            return;
        const s = t.surf;
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
        // снежинка сразу растворяется в сугробе — без точек поверх него
        this._giveActor(f.actor);

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
        this._dropStacks(t, vx, vy);
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
        // «снег идёт» — для других праздничных расширений (ёлка копит снег на ветках)
        globalThis.__festiveSnowStamp = nowAbs;
        if (dt > 0.1)
            dt = 0.1;
        this._time += dt;
        const now = this._time;
        const cfg = this._cfg;

        for (const t of [...this._trackers.values()]) {
            if (t.destroyed)
                continue;
            this._updateTracker(t, dt);
            if (t.surf.count === 0 && t.surf.pending.length === 0 && !this._hasStacks(t)) {
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
        let allWins = null;
        const getWins = () => allWins || (allWins = this._collectWindows());
        const wins = canSettle && cfg.settleWin ? getWins() : [];
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

        // снежки: катание курсором, падение, складывание в снеговиков
        if (cfg.snowballs)
            this._tickRoll(dt, getWins);
        if (this._stacks.size) {
            this._tickStacks(dt, getWins);
            this._syncStackInput(getWins);
        }

        const surfaces = this._meltTick(dt);
        // сугроб под катящимся снежком перерисовываем чаще — видно колею
        if (this._roll) {
            this._rollFlushT += dt;
            const rs = this._roll.surf;
            if (this._rollFlushT >= 0.08 && rs.dirty) {
                this._rollFlushT = 0;
                this._flushSurface(rs);
            }
        }
        // перерисовка сугробов — не чаще 4 раз в секунду
        this._flushT += dt;
        if (this._flushT >= FLUSH_INTERVAL) {
            this._flushT = 0;
            for (const s of surfaces) {
                if (s.dirty || s.pending.length)
                    this._flushSurface(s);
            }
            for (const st of this._stacks) {
                if (st.state === 'rest')
                    this._settleStack(st);
            }
        }
    }

    // ---------- сугробы «по кнопке» ----------

    // Сразу насыпать плотные сугробы на видимые окна и внизу экрана.
    fillDrifts() {
        if (!this._running || this._paused)
            return;
        const cfg = this._cfg;
        const fill = (surf, target) => {
            const phase = Math.random() * 10;
            for (let i = 0; i < surf.n; i++) {
                if (surf.baseY[i] === Infinity)
                    continue;
                const wave = 0.72 + 0.16 * Math.sin(i * 0.11 + phase) + 0.1 * Math.sin(i * 0.37 + phase * 2);
                let goal = target * wave;
                // у краёв окна — скругление, как у настоящей снежной шапки
                if (!surf.isGround) {
                    const d = Math.min(i, surf.n - 1 - i);
                    goal = Math.min(goal, surf.edge + d * REPOSE * 0.8);
                }
                while (surf.heights[i] < goal) {
                    const size = 3 + Math.random() * 6;
                    const hgt = size * 0.42 * cfg.acc;
                    const x = i * BIN + Math.random() * BIN;
                    surf.bins[i].push({
                        size, h: hgt, x,
                        y: surf.baseY[i] - surf.heights[i] - size * 0.15,
                        grip: 0.5 + Math.random() * 2.5,
                        a: 0.9,
                    });
                    surf.heights[i] += hgt;
                    surf.count++;
                    this._settledCount++;
                }
            }
            surf.dirty = true;
            this._flushSurface(surf);
        };
        if (cfg.settleWin) {
            for (const w of this._collectWindows()) {
                if (w.surface)
                    fill(this._getTracker(w).surf, cfg.driftH * 0.9);
            }
        }
        if (cfg.settleGround)
            fill(this._ground, GROUND_CAP * 0.6);
    }

    // ---------- снежки и снеговики ----------

    _hasStacks(t) {
        for (const st of this._stacks) {
            if (st.owner === t)
                return true;
        }
        return false;
    }

    _screenOf(st) {
        return st.owner ? [st.owner.surf.ox + st.x, st.owner.surf.oy + st.y] : [st.x, st.y];
    }

    _newStack(balls, owner, x, y, force = false) {
        // лимит: тает самый старый одиночный снежок
        if (this._stacks.size >= MAX_STACKS && !force) {
            let oldest = null;
            for (const st of this._stacks) {
                if (st.balls.length === 1 && st.state === 'rest' && (!oldest || st.born < oldest.born))
                    oldest = st;
            }
            if (!oldest)
                return null;
            this._destroyStack(oldest);
        }
        const st = {
            balls, owner, x, y,
            vx: 0, vy: 0,
            state: 'rest',
            seed: (Math.random() * 0x7fffffff) | 0,
            born: this._time,
            tracked: false,
            regionKey: '',
            ignoreWin: null, ignoreStack: null, ignoreUntil: 0,
        };
        st.actor = new St.DrawingArea({ reactive: true, name: 'snowfall-snowman' });
        st.actor.connect('repaint', a => Snowman.paint(a, st.balls, st.geo, st.seed));
        st.actor.connect('button-press-event', (a, ev) => {
            if (ev.get_button() !== Clutter.BUTTON_PRIMARY || st.state !== 'rest')
                return Clutter.EVENT_PROPAGATE;
            this._startDrag(st, ev);
            return Clutter.EVENT_STOP;
        });
        st.actor.connect('enter-event', () => {
            if (!this._drag)
                global.display.set_cursor(Meta.Cursor.POINTING_HAND);
            return Clutter.EVENT_PROPAGATE;
        });
        st.actor.connect('leave-event', () => {
            if (!this._drag)
                global.display.set_cursor(Meta.Cursor.DEFAULT);
            return Clutter.EVENT_PROPAGATE;
        });
        (owner ? owner.container : this._ballBox).add_child(st.actor);
        this._stacks.add(st);
        this._relayoutStack(st);
        return st;
    }

    _relayoutStack(st) {
        st.geo = Snowman.layout(st.balls);
        st.actor.set_size(st.geo.w, st.geo.h);
        st.actor.set_pivot_point(0.5, -st.geo.top / st.geo.h);
        st.actor.queue_repaint();
        this._placeStack(st);
    }

    _placeStack(st) {
        st.actor.set_position(Math.round(st.x - st.geo.halfW), Math.round(st.y + st.geo.top));
    }

    _destroyStack(st) {
        if (!this._stacks.has(st))
            return;
        this._stacks.delete(st);
        if (this._roll && this._roll.stack === st)
            this._roll = null;
        if (st.tracked)
            Main.layoutManager.untrackChrome(st.actor);
        st.tracked = false;
        st.actor.destroy();
    }

    // переносит стопку к другому владельцу (окно или экран) без скачка на экране
    _reparentStack(st, owner, parent = null) {
        const [sx, sy] = this._screenOf(st);
        const p = st.actor.get_parent();
        if (p)
            p.remove_child(st.actor);
        (parent || (owner ? owner.container : this._ballBox)).add_child(st.actor);
        st.owner = owner;
        st.x = owner ? sx - owner.surf.ox : sx;
        st.y = owner ? sy - owner.surf.oy : sy;
        st.regionKey = '';
        this._placeStack(st);
    }

    _fallStack(st, vx, vy) {
        if (this._roll && this._roll.stack === st)
            this._roll = null;
        const win = st.owner ? st.owner.win : null;
        if (st.owner)
            this._reparentStack(st, null);
        st.state = 'fall';
        st.vx = vx;
        st.vy = vy;
        st.ignoreWin = win;
        st.ignoreUntil = this._time + 0.6;
    }

    _dropStacks(t, vx, vy) {
        for (const st of [...this._stacks]) {
            if (st.owner === t && st.state !== 'drag')
                this._fallStack(st, vx + (Math.random() - 0.5) * 60, vy);
        }
    }

    clearSnowmen() {
        if (!this._running)
            return;
        this._endDrag(false);
        this._roll = null;
        for (const st of [...this._stacks])
            this._destroyStack(st);
    }

    // стопка в покое: оседает вместе со снегом под ней, у края окна — падает
    _settleStack(st) {
        let surf, base, lx = st.x;
        if (st.owner) {
            surf = st.owner.surf;
            base = 0;
            if (lx < 0 || lx >= st.owner.width) {
                this._fallStack(st, 0, 0);
                return;
            }
        } else {
            surf = this._ground;
            const b = Math.floor(lx / BIN);
            if (!surf.hasFloor(b)) {
                this._fallStack(st, 0, 0);
                return;
            }
            base = surf.baseY[b];
        }
        const y = base - this._snowUnder(surf, lx, st.balls[0].r) * 0.55;
        if (Math.abs(y - st.y) >= 0.5) {
            st.y = y;
            this._placeStack(st);
        }
    }

    // высота снега под серединой шара (берём меньшую — шар проседает в колею)
    _snowUnder(surf, x, r) {
        const b0 = Math.max(0, Math.floor((x - r * 0.35) / BIN));
        const b1 = Math.min(surf.n - 1, Math.floor((x + r * 0.35) / BIN));
        let h = Infinity;
        for (let i = b0; i <= b1; i++)
            h = Math.min(h, surf.heights[i]);
        return h === Infinity ? 0 : h;
    }

    _land(st, owner) {
        this._reparentStack(st, owner);
        st.state = 'rest';
        st.vx = st.vy = 0;
        this._settleStack(st);
        if (st.state !== 'rest')
            return;
        st.actor.remove_all_transitions();
        st.actor.scale_x = 1.08;
        st.actor.scale_y = 0.9;
        st.actor.ease({
            scale_x: 1, scale_y: 1,
            duration: 260,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });
    }

    _merge(st, onto) {
        onto.balls.push(...st.balls.map(b => ({ r: b.r, angle: 0 })));
        // снизу — самый большой ком
        onto.balls.sort((a, b) => b.r - a.r);
        this._destroyStack(st);
        this._relayoutStack(onto);
        onto.actor.remove_all_transitions();
        onto.actor.scale_x = 1.12;
        onto.actor.scale_y = 0.9;
        onto.actor.ease({
            scale_x: 1, scale_y: 1,
            duration: 380,
            mode: Clutter.AnimationMode.EASE_OUT_ELASTIC,
        });
    }

    _tickStacks(dt, getWins) {
        const now = this._time;
        const H = this._H;
        for (const st of [...this._stacks]) {
            if (st.state !== 'fall')
                continue;
            const prev = st.y;
            st.vy = Math.min(st.vy + BALL_GRAVITY * dt, 1800);
            st.vx *= Math.exp(-0.6 * dt);
            st.x += st.vx * dt;
            st.y += st.vy * dt;
            // края экрана отражают (снежок не улетает за экран)
            const br = st.geo.c[0].r;
            if (st.x < br && st.vx < 0) {
                st.x = br;
                st.vx = -st.vx * 0.35;
            } else if (st.x > this._W - br && st.vx > 0) {
                st.x = this._W - br;
                st.vx = -st.vx * 0.35;
            }
            let landed = false;
            if (st.vy > 0) {
                // на другой снежок/снеговика — складываем
                for (const o of this._stacks) {
                    if (o === st || o.state !== 'rest' || (o === st.ignoreStack && now < st.ignoreUntil))
                        continue;
                    const [ox, oy] = this._screenOf(o);
                    const topR = o.geo.c[o.geo.c.length - 1].r;
                    const topY = oy + o.geo.stackTop + topR * 0.35;
                    if (Math.abs(st.x - ox) > topR * 0.9 + st.balls[0].r * 0.35)
                        continue;
                    if (!(prev <= topY && st.y >= topY))
                        continue;
                    if (o.balls.length + st.balls.length <= Snowman.MAX_BALLS) {
                        this._merge(st, o);
                        landed = true;
                    } else {
                        // больше пяти шаров не бывает — скатывается вбок
                        st.vx = (st.x >= ox ? 1 : -1) * 160;
                        st.vy = -140;
                        st.ignoreStack = o;
                        st.ignoreUntil = now + 0.7;
                    }
                    break;
                }
                if (landed)
                    continue;
                const wins = getWins();
                for (let j = 0; j < wins.length && !landed; j++) {
                    const w = wins[j];
                    if (st.x < w.x || st.x >= w.x + w.w)
                        continue;
                    if (st.ignoreWin === w.win && now < st.ignoreUntil)
                        continue;
                    // внутрь окна (сквозь заголовок) — не проваливаемся, но и не цепляемся
                    if (!w.surface)
                        continue;
                    const t = this._trackers.get(w.win);
                    const bin = Math.floor((st.x - w.x) / BIN);
                    const surfY = w.y - (t && bin < t.surf.n ? t.surf.heights[bin] * 0.55 : 0);
                    if (!(prev <= surfY && st.y >= surfY))
                        continue;
                    let occluded = false;
                    for (let m = 0; m < j; m++) {
                        const o = wins[m];
                        if (st.x >= o.x && st.x < o.x + o.w && surfY >= o.y && surfY < o.y + o.h) {
                            occluded = true;
                            break;
                        }
                    }
                    if (occluded)
                        continue;
                    this._land(st, t || this._getTracker(w));
                    landed = true;
                }
                if (landed)
                    continue;
                const g = this._ground;
                const bin = Math.floor(st.x / BIN);
                if (g.hasFloor(bin) && st.y >= g.baseY[bin] - g.heights[bin] * 0.55) {
                    this._land(st, null);
                    continue;
                }
            }
            if (st.y > H + 300 || st.x < -300 || st.x > this._W + 300) {
                this._destroyStack(st);
                continue;
            }
            this._placeStack(st);
        }
    }

    // ---------- катание снежка курсором ----------

    // сугроб под курсором: {surf, owner, lx, base} или null
    _driftAt(px, py, getWins) {
        const wins = getWins();
        const above = this._fl.mode === 'above';
        for (let j = 0; j < wins.length; j++) {
            const w = wins[j];
            if (px < w.x || px >= w.x + w.w)
                continue;
            if (py >= w.y && py < w.y + w.h) {
                // курсор над окном: сугроб внизу экрана виден только в режиме «поверх окон»
                if (!above)
                    return null;
                break;
            }
            if (!w.surface)
                continue;
            const t = this._trackers.get(w.win);
            if (!t || t.container.visible === false)
                continue;
            const lx = px - w.x;
            const bin = Math.floor(lx / BIN);
            if (bin >= t.surf.n)
                continue;
            const h = Math.max(t.surf.heights[bin], 6);
            if (py >= w.y - h - 6 && py <= w.y + 2)
                return { surf: t.surf, owner: t, lx, base: 0, h: t.surf.heights[bin] };
        }
        const g = this._ground;
        const bin = Math.floor(px / BIN);
        if (!g.hasFloor(bin))
            return null;
        const h = Math.max(g.heights[bin], 6);
        if (py >= g.baseY[bin] - h - 6)
            return { surf: g, owner: null, lx: px, base: g.baseY[bin], h: g.heights[bin] };
        return null;
    }

    _stopRoll() {
        const r = this._roll;
        this._roll = null;
        this._rollTrack = null;
        if (r && this._stacks.has(r.stack)) {
            r.stack.state = 'rest';
            this._settleStack(r.stack);
        }
    }

    // снег под шаром налипает на него: столбики под шаром выскребаются до опоры
    _scrape(surf, x0, x1) {
        let area = 0;
        const b0 = Math.max(0, Math.floor(x0 / BIN));
        const b1 = Math.min(surf.n - 1, Math.floor(x1 / BIN));
        for (let i = b0; i <= b1; i++) {
            const stack = surf.bins[i];
            if (!stack.length)
                continue;
            area += surf.heights[i] * BIN;
            surf.count -= stack.length;
            this._settledCount -= stack.length;
            surf.bins[i] = [];
            surf.heights[i] = 0;
            surf.dirty = true;
        }
        return area;
    }

    _tickRoll(dt, getWins) {
        const [px, py, mods] = global.get_pointer();
        const buttons = Clutter.ModifierType.BUTTON1_MASK | Clutter.ModifierType.BUTTON2_MASK |
            Clutter.ModifierType.BUTTON3_MASK;
        if ((mods & buttons) || this._drag || Main.overview.visible) {
            // нажата кнопка (тащат окно, выделяют текст) — не катаем
            this._stopRoll();
            return;
        }
        const roll = this._roll;
        if (roll) {
            const st = roll.stack;
            const ball = st.balls[0];
            const [sx, sy] = this._screenOf(st);
            const r = ball.r;
            if (py < sy - 2 * r - 16 || py > sy + 10 || Math.abs(px - sx) > r + 50) {
                this._stopRoll();
                return;
            }
            const ox = st.owner ? st.owner.surf.ox : 0;
            const lx = px - ox;
            const nx = st.x + (lx - st.x) * Math.min(1, dt * 14);
            const dx = nx - st.x;
            const width = st.owner ? st.owner.width : this._W;
            if (st.owner && (nx < 0 || nx >= width)) {
                // скатился с края окна
                this._roll = null;
                st.x = nx;
                this._fallStack(st, Math.max(-500, Math.min(500, dx / dt)), -40);
                return;
            }
            st.x = Math.max(r, Math.min(width - (st.owner ? 0 : r), nx));
            ball.angle = (ball.angle || 0) + dx / r;
            if (r < MAX_R) {
                const area = this._scrape(roll.surf, st.x - r * 0.6, st.x + r * 0.6);
                if (area > 0)
                    ball.r = Math.min(MAX_R, Math.sqrt(r * r + area * 0.35 / Math.PI));
            }
            let base = roll.base;
            if (!st.owner) {
                const b = Math.floor(st.x / BIN);
                if (this._ground.hasFloor(b))
                    base = this._ground.baseY[b];
            }
            st.y = base - this._snowUnder(roll.surf, st.x, ball.r) * 0.55;
            if (Math.abs(ball.r - roll.drawnR) >= 0.5) {
                roll.drawnR = ball.r;
                this._relayoutStack(st);
            } else {
                this._placeStack(st);
                if (Math.abs(dx) > 0.2)
                    st.actor.queue_repaint();
            }
            return;
        }

        // начало: курсор ведут по сугробу (без нажатия) — снег скатывается в шар
        const d = this._driftAt(px, py, getWins);
        if (!d) {
            this._rollTrack = null;
            return;
        }
        let tr = this._rollTrack;
        if (!tr || tr.surf !== d.surf || Math.abs(py - tr.y) > 40) {
            tr = this._rollTrack = { surf: d.surf, x: px, y: py, travel: 0 };
            return;
        }
        tr.travel += Math.abs(px - tr.x);
        tr.x = px;
        tr.y = py;
        if (tr.travel < ROLL_START)
            return;
        // докатываем уже лежащий снежок, если курсор упёрся в него
        let st = null;
        for (const o of this._stacks) {
            if (o.state === 'rest' && o.balls.length === 1 && o.owner === d.owner &&
                Math.abs(o.x - d.lx) < o.balls[0].r + 8) {
                st = o;
                break;
            }
        }
        if (!st) {
            if (d.h < 3)
                return;
            st = this._newStack([{ r: START_R, angle: 0 }], d.owner, d.lx, d.base);
            if (!st)
                return;
        }
        st.state = 'roll';
        this._rollTrack = null;
        this._roll = { stack: st, surf: d.surf, base: d.base, drawnR: st.balls[0].r };
    }

    // ---------- перетаскивание: взять шар (и всё, что на нём) и положить на другой ----------

    _startDrag(st, ev) {
        if (this._drag || !this._running)
            return;
        const [x, y] = ev.get_coords();
        const [ok, ax, ay] = st.actor.transform_stage_point(x, y);
        let idx = 0;
        if (ok)
            idx = Snowman.pickBall(st.geo, ax - st.geo.halfW, ay + st.geo.top);
        let dragged = st;
        if (idx > 0) {
            // берём верхнюю часть снеговика: шар под курсором и всё, что выше
            const [sx, sy] = this._screenOf(st);
            const c = st.geo.c[idx];
            const upper = st.balls.splice(idx).map(b => ({ r: b.r, angle: 0 }));
            this._relayoutStack(st);
            dragged = this._newStack(upper, null, sx, sy + c.y + c.r, true);
            if (!dragged)
                return;
            dragged.seed = st.seed;
        }
        if (this._roll && this._roll.stack === dragged)
            this._roll = null;
        if (dragged.tracked) {
            Main.layoutManager.untrackChrome(dragged.actor);
            dragged.tracked = false;
        }
        // на время переноса — поверх всего
        this._reparentStack(dragged, null, Main.layoutManager.uiGroup);
        dragged.state = 'drag';
        dragged.actor.remove_all_transitions();
        dragged.actor.scale_x = dragged.actor.scale_y = 1.06;
        const grab = Main.pushModal(dragged.actor, { actionMode: Shell.ActionMode.NORMAL });
        this._drag = {
            st: dragged, grab,
            offX: dragged.x - x, offY: dragged.y - y,
            samples: [[GLib.get_monotonic_time() / 1e6, x, y]],
        };
        global.display.set_cursor(Meta.Cursor.DND_IN_DRAG);
        this._drag.id = dragged.actor.connect('captured-event', (a, e) => this._onDragEvent(e));
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
            const [x, y] = ev.get_coords();
            const now = GLib.get_monotonic_time() / 1e6;
            d.samples.push([now, x, y]);
            while (d.samples.length > 2 && now - d.samples[0][0] > 0.1)
                d.samples.shift();
            d.st.x = x + d.offX;
            d.st.y = y + d.offY;
            this._placeStack(d.st);
        } else if (type === Clutter.EventType.BUTTON_RELEASE) {
            this._endDrag(true);
        } else if (type === Clutter.EventType.KEY_PRESS && ev.get_key_symbol() === Clutter.KEY_Escape) {
            this._endDrag(false);
        }
        return Clutter.EVENT_STOP;
    }

    _endDrag(throwIt) {
        const d = this._drag;
        if (!d)
            return;
        this._drag = null;
        d.st.actor.disconnect(d.id);
        try {
            Main.popModal(d.grab);
        } catch (e) {
            logError(e, 'snowfall-physics: popModal');
        }
        global.display.set_cursor(Meta.Cursor.DEFAULT);
        const st = d.st;
        if (!this._stacks.has(st))
            return;
        st.actor.scale_x = st.actor.scale_y = 1;
        // отпустили на ходу — шар немного летит по инерции; остановились — кладём
        let vx = 0, vy = 0;
        const now = GLib.get_monotonic_time() / 1e6;
        if (throwIt && d.samples.length >= 2) {
            const [t0, x0, y0] = d.samples[0];
            const [t1, x1, y1] = d.samples[d.samples.length - 1];
            if (t1 - t0 > 0.01 && now - t1 < 0.08) {
                vx = Math.max(-450, Math.min(450, (x1 - x0) / (t1 - t0) * 0.4));
                vy = Math.max(-450, Math.min(450, (y1 - y0) / (t1 - t0) * 0.4));
            }
        }
        // отпустили — падает (и складывается, если внизу шар), уже в слое снега
        this._reparentStack(st, null);
        st.state = 'fall';
        st.vx = vx;
        st.vy = vy;
        st.ignoreWin = null;
        st.ignoreStack = null;
        if (!this._running || this._paused)
            this._destroyStack(st);
    }

    // Снеговики ловят мышь (X11: область ввода Shell), только когда их видно:
    // если снеговика закрывает другое окно, клики проходят к этому окну.
    _syncStackInput(getWins) {
        const allow = this._cfg.snowballs && !this._paused;
        let wins = null;
        let changed = false;
        for (const st of this._stacks) {
            let want = allow && st.state === 'rest' && (!st.owner || st.owner.container.visible);
            let sx = 0, sy = 0;
            if (want) {
                [sx, sy] = this._screenOf(st);
                const cy = sy + st.geo.top * 0.5;
                wins = wins || getWins();
                if (st.owner) {
                    let found = false;
                    for (const w of wins) {
                        if (w.win === st.owner.win) {
                            found = true;
                            break;
                        }
                        if (sx >= w.x && sx < w.x + w.w && cy >= w.y && cy < w.y + w.h) {
                            want = false;
                            break;
                        }
                    }
                    if (!found)
                        want = false;
                } else if (this._fl.mode !== 'above') {
                    want = !wins.some(w => sx >= w.x && sx < w.x + w.w && cy >= w.y && cy < w.y + w.h);
                }
            }
            if (want !== st.tracked) {
                if (want)
                    Main.layoutManager.trackChrome(st.actor, { affectsInputRegion: true });
                else
                    Main.layoutManager.untrackChrome(st.actor);
                st.tracked = want;
                st.regionKey = '';
            }
            if (want) {
                const key = `${Math.round(sx)},${Math.round(sy)},${st.geo.w},${st.geo.h}`;
                if (key !== st.regionKey) {
                    st.regionKey = key;
                    changed = true;
                }
            }
        }
        // окно с снеговиком сдвинули — область ввода надо пересчитать
        if (changed && Main.layoutManager._queueUpdateRegions)
            Main.layoutManager._queueUpdateRegions();
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
        const fill = new PopupMenu.PopupMenuItem(T('Намести сугробы', 'Pile up snow now'));
        fill.connect('activate', () => ext.fillDrifts());
        this.menu.addMenuItem(fill);
        const shake = new PopupMenu.PopupMenuItem(T('Стряхнуть весь снег', 'Shake off all snow'));
        shake.connect('activate', () => ext.shakeAll());
        this.menu.addMenuItem(shake);
        const clear = new PopupMenu.PopupMenuItem(T('Убрать снежки и снеговиков', 'Remove snowballs and snowmen'));
        clear.connect('activate', () => ext.clearSnowmen());
        this.menu.addMenuItem(clear);
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

    fillDrifts() {
        this._engine?.fillDrifts();
    }

    clearSnowmen() {
        this._engine?.clearSnowmen();
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
