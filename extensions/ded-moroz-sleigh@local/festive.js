/* Общие помощники праздничных расширений (одинаковая копия в каждом).
 * - FestiveIndicator: значок на верхней панели с меню управления;
 * - FestiveLayer: где показывать эффект — поверх окон, только на пустом
 *   рабочем столе (когда все окна закрыты/свёрнуты) или под окнами;
 * - placeLayer: низкоуровневая постановка слоя над/под окнами.
 */
'use strict';

const { Clutter, GLib, GObject, Gio, Meta, St } = imports.gi;

const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const Slider = imports.ui.slider;
const ExtensionUtils = imports.misc.extensionUtils;
const I18n = ExtensionUtils.getCurrentExtension().imports.i18n;
const T = I18n.T;

/* Ставит слой: aboveWindows=true — над окнами (под панелью и меню),
 * false — на рабочий стол: над обоями, под всеми окнами. */
function placeLayer(layer, aboveWindows) {
    const parent = layer.get_parent();
    if (parent)
        parent.remove_child(layer);
    if (aboveWindows) {
        Main.layoutManager.uiGroup.insert_child_above(layer, global.window_group);
    } else {
        const bg = Main.layoutManager._backgroundGroup;
        if (bg && bg.get_parent() === global.window_group)
            global.window_group.insert_child_above(layer, bg);
        else
            global.window_group.insert_child_at_index(layer, 0);
    }
}

// варианты показа (функция: перевод берётся в момент показа)
function visibilityChoices() {
    return [
        ['above', T('поверх окон', 'above windows')],
        ['desktop', T('только на пустом рабочем столе', 'only on an empty desktop')],
        ['below', T('под окнами', 'below windows')],
    ];
}

const WINDOW_TYPES = [Meta.WindowType.NORMAL, Meta.WindowType.DIALOG, Meta.WindowType.MODAL_DIALOG];

/* Следит, пуст ли текущий рабочий стол (нет видимых обычных окон). */
var DesktopWatcher = class DesktopWatcher {
    constructor(callback) {
        this._cb = callback;
        this._ids = [];
        this._timers = [];
        const on = (obj, sig) => this._ids.push([obj, obj.connect(sig, () => this._queue())]);
        on(global.display, 'restacked');
        on(global.display, 'window-created');
        on(global.workspace_manager, 'active-workspace-changed');
        for (const sig of ['minimize', 'unminimize', 'map', 'destroy'])
            on(global.window_manager, sig);
        this.clear = this._compute();
    }

    _compute() {
        const ws = global.workspace_manager.get_active_workspace();
        for (const actor of global.get_window_actors()) {
            const w = actor.meta_window;
            if (!w || w.minimized || w.is_override_redirect() || w.skip_taskbar)
                continue;
            if (!WINDOW_TYPES.includes(w.get_window_type()))
                continue;
            if (!w.get_workspace() || !w.located_on_workspace(ws))
                continue;
            return false;
        }
        return true;
    }

    // пересчёт вскоре и ещё раз после анимаций закрытия/сворачивания
    _queue() {
        for (const id of this._timers)
            GLib.source_remove(id);
        this._timers = [];
        for (const ms of [80, 450]) {
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                this._timers = this._timers.filter(t => t !== id);
                this._update();
                return GLib.SOURCE_REMOVE;
            });
            this._timers.push(id);
        }
    }

    _update() {
        const clear = this._compute();
        if (clear !== this.clear) {
            this.clear = clear;
            this._cb(clear);
        }
    }

    destroy() {
        for (const [obj, id] of this._ids)
            obj.disconnect(id);
        this._ids = [];
        for (const id of this._timers)
            GLib.source_remove(id);
        this._timers = [];
    }
};

/* Обёртка для слоя эффекта. Расширение кладёт свои акторы в .actor, а
 * обёртка сама ставит её поверх окон / под окна и в режиме «только на пустом
 * столе» плавно показывает/прячет. onChange(shown) — чтобы расширение могло
 * поставить анимацию на паузу или перестроить области ввода. */
var FestiveLayer = class FestiveLayer {
    constructor(name, settings, onChange, params = {}) {
        this._settings = settings;
        this._onChange = onChange || (() => {});
        this._params = params;
        this.actor = new Clutter.Actor({ name: `festive-${name}`, reactive: false });
        this._id = settings.connect('changed::visibility', () => this._apply(true));
        this._apply(false);
    }

    get mode() {
        return this._settings.get_string('visibility');
    }

    get shown() {
        return this.mode !== 'desktop' || (this._watcher ? this._watcher.clear : true);
    }

    _place() {
        const above = this.mode === 'above';
        const a = this.actor;
        if (above && this._params.topOfUi) {
            // над всем интерфейсом, включая док (сани — проезд короткий)
            const parent = a.get_parent();
            if (parent)
                parent.remove_child(a);
            Main.layoutManager.uiGroup.add_child(a);
        } else {
            placeLayer(a, above);
        }
        // держаться над другими праздничными слоями того же уровня (сани над снегом)
        for (const other of this._params.aboveSiblings || []) {
            const parent = a.get_parent();
            const sib = parent?.get_children().find(c => c.name === `festive-${other}`);
            if (sib && parent.get_children().indexOf(sib) > parent.get_children().indexOf(a))
                parent.set_child_above_sibling(a, sib);
        }
    }

    // заново встать на место (например, над слоем снега перед проездом саней)
    restack() {
        this._place();
    }

    _apply(notify) {
        this._place();
        if (this.mode === 'desktop' && !this._watcher)
            this._watcher = new DesktopWatcher(() => this._fade(true));
        else if (this.mode !== 'desktop' && this._watcher) {
            this._watcher.destroy();
            this._watcher = null;
        }
        this._fade(notify);
    }

    _fade(notify) {
        const shown = this.shown;
        const a = this.actor;
        a.remove_all_transitions();
        if (shown) {
            a.show();
            a.ease({ opacity: 255, duration: 450, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
        } else {
            a.ease({
                opacity: 0,
                duration: 300,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    if (!this.shown)
                        a.hide();
                },
            });
        }
        if (notify)
            this._onChange(shown);
    }

    destroy() {
        this._settings.disconnect(this._id);
        if (this._watcher) {
            this._watcher.destroy();
            this._watcher = null;
        }
        this.actor.destroy();
    }
};

/* Подменю выбора строкового значения с отметкой текущего. */
function addChoiceMenu(menu, settings, label, key, choices, watch) {
    const sub = new PopupMenu.PopupSubMenuMenuItem(label);
    const items = [];
    for (const [id, text] of choices) {
        const it = new PopupMenu.PopupMenuItem(text);
        it.connect('activate', () => settings.set_string(key, id));
        items.push([id, it]);
        sub.menu.addMenuItem(it);
    }
    const sync = () => {
        const cur = settings.get_string(key);
        for (const [id, it] of items)
            it.setOrnament(id === cur ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);
        const found = choices.find(c => c[0] === cur);
        sub.label.text = found ? `${label}: ${found[1]}` : label;
    };
    sync();
    watch(sync);
    menu.addMenuItem(sub);
    return sub;
}

var FestiveIndicator = GObject.registerClass(
class FestiveIndicator extends PanelMenu.Button {
    _init(name, iconFile, settings) {
        super._init(0.0, name);
        // компактная кнопка: отступы по бокам меньше стандартных 12px
        this.style = '-natural-hpadding: 5px; -minimum-hpadding: 3px;';
        this._settings = settings;
        this._ids = [];
        this._sources = [];
        const gicon = Gio.icon_new_for_string(iconFile);
        this.add_child(new St.Icon({ gicon, style_class: 'system-status-icon', style: 'margin: 0; padding: 4px 2px;' }));
        const title = new PopupMenu.PopupMenuItem(name, { reactive: false });
        title.label.style = 'font-weight: bold;';
        this.menu.addMenuItem(title);
        this.connect('destroy', () => {
            for (const id of this._ids)
                this._settings.disconnect(id);
            for (const id of this._sources)
                GLib.source_remove(id);
            this._ids = [];
            this._sources = [];
        });
    }

    _watch(key, cb) {
        this._ids.push(this._settings.connect(`changed::${key}`, cb));
    }

    addSwitch(label, key) {
        const item = new PopupMenu.PopupSwitchMenuItem(label, this._settings.get_boolean(key));
        item.connect('toggled', (i, state) => this._settings.set_boolean(key, state));
        this._watch(key, () => item.setToggleState(this._settings.get_boolean(key)));
        this.menu.addMenuItem(item);
        return item;
    }

    addAction(label, cb) {
        const item = new PopupMenu.PopupMenuItem(label);
        item.connect('activate', cb);
        this.menu.addMenuItem(item);
        return item;
    }

    addLabel(textFn) {
        const item = new PopupMenu.PopupMenuItem('', { reactive: false });
        const sync = () => {
            item.label.text = textFn();
        };
        sync();
        this.menu.connect('open-state-changed', (m, open) => {
            if (open)
                sync();
        });
        item.sync = sync;
        this.menu.addMenuItem(item);
        return item;
    }

    // Выбор одного варианта (строковый ключ / enum) — подменю с точкой.
    addChoice(label, key, choices) {
        return addChoiceMenu(this.menu, this._settings, label, key, choices, cb => this._watch(key, cb));
    }

    addVisibility() {
        return this.addChoice(T('Показывать', 'Show'), 'visibility', visibilityChoices());
    }

    // Ползунок для числового ключа; в настройки пишем с задержкой.
    addSlider(label, key, min, max, isInt, fmt) {
        const get = () => (isInt ? this._settings.get_int(key) : this._settings.get_double(key));
        const set = v => (isInt ? this._settings.set_int(key, Math.round(v)) : this._settings.set_double(key, v));
        const text = new PopupMenu.PopupMenuItem('', { reactive: false });
        const show = v => {
            text.label.text = `${label}: ${fmt ? fmt(v) : (isInt ? Math.round(v) : v.toFixed(2))}`;
        };
        const item = new PopupMenu.PopupBaseMenuItem({ activate: false });
        const slider = new Slider.Slider((get() - min) / (max - min));
        slider.x_expand = true;
        slider.accessible_name = label;
        item.add_child(slider);
        let pending = 0;
        show(get());
        slider.connect('notify::value', () => {
            const v = min + slider.value * (max - min);
            show(v);
            if (pending)
                GLib.source_remove(pending);
            pending = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
                this._sources = this._sources.filter(s => s !== pending);
                pending = 0;
                set(v);
                return GLib.SOURCE_REMOVE;
            });
            this._sources.push(pending);
        });
        this._watch(key, () => {
            if (!pending) {
                slider.value = (get() - min) / (max - min);
                show(get());
            }
        });
        this.menu.addMenuItem(text);
        this.menu.addMenuItem(item);
        return slider;
    }

    addSeparator() {
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    }

    addPrefs() {
        this.addAction(T('Настройки…', 'Settings…'), () => ExtensionUtils.openPrefs());
    }
});

/* Показывает/прячет значок по ключу show-indicator. build(indicator) наполняет меню. */
var IndicatorManager = class IndicatorManager {
    constructor(uuidRole, name, iconFile, settings, build) {
        this._role = uuidRole;
        this._name = name;
        this._icon = iconFile;
        this._settings = settings;
        this._build = build;
        this._id = settings.connect('changed::show-indicator', () => this.sync());
        // сменили язык — пересобираем значок и меню
        this._langId = settings.connect('changed::language', () => {
            I18n.bindSettings(settings);
            if (this._indicator) {
                this._indicator.destroy();
                this._indicator = null;
            }
            this.sync();
        });
        // на экране блокировки значков расширений быть не должно
        this._modeId = Main.sessionMode.connect('updated', () => this.sync());
        this.sync();
    }

    sync() {
        const show = this._settings.get_boolean('show-indicator') && !Main.sessionMode.isLocked;
        if (show && !this._indicator) {
            const name = typeof this._name === 'function' ? this._name() : this._name;
            this._indicator = new FestiveIndicator(name, this._icon, this._settings);
            this._build(this._indicator);
            Main.panel.addToStatusArea(this._role, this._indicator);
        } else if (!show && this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }

    destroy() {
        this._settings.disconnect(this._id);
        this._settings.disconnect(this._langId);
        Main.sessionMode.disconnect(this._modeId);
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
};
