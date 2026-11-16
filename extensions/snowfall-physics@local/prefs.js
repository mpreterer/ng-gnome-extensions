'use strict';

const { Adw, Gtk, Gio } = imports.gi;
const ExtensionUtils = imports.misc.extensionUtils;
const I18n = ExtensionUtils.getCurrentExtension().imports.i18n;
const T = I18n.T;

function init() {
}

function addLanguage(group, settings) {
    const row = new Adw.ActionRow({
        title: T('Язык / Language', 'Language / Язык'),
        subtitle: T('Меню меняется сразу, это окно — после переоткрытия', 'The menu changes at once, this window after reopening'),
    });
    const combo = new Gtk.ComboBoxText({ valign: Gtk.Align.CENTER });
    combo.append('auto', T('Как в системе', 'As in the system'));
    combo.append('ru', 'Русский');
    combo.append('en', 'English');
    settings.bind('language', combo, 'active-id', Gio.SettingsBindFlags.DEFAULT);
    row.add_suffix(combo);
    group.add(row);
}

function addVisibility(group, settings, subtitle) {
    const row = new Adw.ActionRow({ title: T('Где показывать', 'Where to show'), subtitle: subtitle || '' });
    const combo = new Gtk.ComboBoxText({ valign: Gtk.Align.CENTER });
    combo.append('above', T('Поверх окон', 'Above windows'));
    combo.append('desktop', T('Только на пустом рабочем столе', 'Only on an empty desktop'));
    combo.append('below', T('Под окнами', 'Below windows'));
    settings.bind('visibility', combo, 'active-id', Gio.SettingsBindFlags.DEFAULT);
    row.add_suffix(combo);
    group.add(row);
}

function addSwitch(group, settings, key, title, subtitle) {
    const row = new Adw.ActionRow({ title, subtitle: subtitle || '' });
    const sw = new Gtk.Switch({ valign: Gtk.Align.CENTER });
    settings.bind(key, sw, 'active', Gio.SettingsBindFlags.DEFAULT);
    row.add_suffix(sw);
    row.activatable_widget = sw;
    group.add(row);
}

function addSpin(group, settings, key, title, subtitle, lower, upper, step, digits = 0) {
    const row = new Adw.ActionRow({ title, subtitle: subtitle || '' });
    const spin = new Gtk.SpinButton({
        adjustment: new Gtk.Adjustment({ lower, upper, step_increment: step, page_increment: step * 10 }),
        digits,
        valign: Gtk.Align.CENTER,
    });
    settings.bind(key, spin, 'value', Gio.SettingsBindFlags.DEFAULT);
    row.add_suffix(spin);
    row.activatable_widget = spin;
    group.add(row);
}

function fillPreferencesWindow(window) {
    const settings = ExtensionUtils.getSettings();
    I18n.bindSettings(settings);
    const page = new Adw.PreferencesPage();

    const main = new Adw.PreferencesGroup({
        title: T('Снег', 'Snow'),
        description: T('⚡ — опции, от которых больше всего зависит нагрузка на систему.', '⚡ — options that affect system load the most.'),
    });
    addSwitch(main, settings, 'enabled', T('Снег включён', 'Snow enabled'), T('То же самое делает горячая клавиша и значок на панели', 'The hotkey and the panel icon do the same'));
    addSpin(main, settings, 'flake-count', T('⚡ Падающих снежинок', '⚡ Falling snowflakes'), T('Нагружает систему. Рекомендуется 80–150; больше 250 — заметная нагрузка', 'Affects system load. Recommended 80–150; above 250 is noticeably heavier'), 10, 400, 10);
    addSpin(main, settings, 'wind', T('Ветер', 'Wind'), T('px/с; отрицательное значение — дует влево', 'px/s; negative blows to the left'), -100, 100, 1, 0);
    page.add(main);

    const pile = new Adw.PreferencesGroup({ title: T('Сугробы', 'Snow piles') });
    addSwitch(pile, settings, 'settle-on-windows', T('Оседать на окнах', 'Settle on windows'));
    addSwitch(pile, settings, 'settle-on-ground', T('Оседать внизу экрана', 'Settle at the bottom of the screen'));
    addSpin(pile, settings, 'drift-height', T('Высота сугробов на окнах, px', 'Height of drifts on windows, px'), T('Плотная снежная шапка на верхней кромке окна', 'A thick snow cap on the top edge of the window'), 8, 80, 2);
    addSpin(pile, settings, 'drift-accumulation', T('Как быстро растут сугробы', 'How fast drifts grow'), T('1 — тонкий слой, 10 — быстро наметает толстые сугробы', '1 — a thin layer, 10 — thick drifts pile up fast'), 1, 10, 1);
    addSpin(pile, settings, 'max-settled', T('Максимум осевших снежинок', 'Maximum settled snowflakes'), T('Нагрузка небольшая (сугробы рисуются картинкой). 0 — снег не оседает', 'Low load (piles are drawn as a single image). 0 — snow does not settle'), 0, 20000, 500);
    addSpin(pile, settings, 'melt-time', T('Время таяния, секунд', 'Melting time, seconds'), T('Среднее время жизни осевшей снежинки', 'Average lifetime of a settled snowflake'), 10, 3600, 10);
    addSpin(pile, settings, 'shake-sensitivity', T('Чувствительность к тряске', 'Shake sensitivity'), T('1 — снег держится крепко, 10 — слетает от лёгкого движения', '1 — snow holds tight, 10 — falls off at the slightest move'), 1, 10, 1);
    page.add(pile);

    const balls = new Adw.PreferencesGroup({
        title: T('Снежки и снеговики', 'Snowballs and snowmen'),
        description: T('Проведите курсором вдоль сугроба (без нажатия) — снег скатается в шар. Шар можно взять мышью и положить на другой: из 2–5 шаров получится снеговик в шапке и шарфе.',
            'Move the pointer along a drift (no click) and the snow rolls into a ball. Grab a ball with the mouse and drop it onto another: 2–5 balls make a snowman with a hat and a scarf.'),
    });
    addSwitch(balls, settings, 'snowballs', T('Лепить снежки мышкой', 'Roll snowballs with the mouse'));
    page.add(balls);

    const misc = new Adw.PreferencesGroup({ title: T('Прочее', 'Other') });
    addSpin(misc, settings, 'fps', T('⚡ Кадров в секунду', '⚡ Frames per second'), T('Сильно влияет на нагрузку. Рекомендуется 30; 60 — вдвое тяжелее', 'Strongly affects load. Recommended 30; 60 is twice as heavy'), 10, 60, 5);
    addVisibility(misc, settings, T('«Только на пустом рабочем столе» — видно, когда все окна закрыты или свёрнуты', '“Only on an empty desktop” — visible when all windows are closed or minimized'));
    addLanguage(misc, settings);
    addSwitch(misc, settings, 'hide-in-fullscreen', T('Прятать снег в полноэкранном режиме', 'Hide snow in fullscreen'), T('Видео, игры, презентации', 'Videos, games, presentations'));
    addSwitch(misc, settings, 'show-indicator', T('Значок снежинки на верхней панели', 'Snowflake icon on the top bar'));

    const keyRow = new Adw.ActionRow({
        title: T('Горячая клавиша вкл/выкл', 'On/off hotkey'),
        subtitle: T('Формат GTK, например &lt;Super&gt;&lt;Alt&gt;x. Пустое поле — без клавиши', 'GTK format, e.g. &lt;Super&gt;&lt;Alt&gt;x. Empty — no hotkey'),
    });
    const entry = new Gtk.Entry({ valign: Gtk.Align.CENTER, width_chars: 16 });
    entry.text = settings.get_strv('toggle-key')[0] || '';
    entry.connect('activate', () => applyKey());
    const focus = new Gtk.EventControllerFocus();
    focus.connect('leave', () => applyKey());
    entry.add_controller(focus);
    function applyKey() {
        const text = entry.text.trim();
        if (text === '') {
            settings.set_strv('toggle-key', []);
            entry.remove_css_class('error');
            return;
        }
        const [ok, key] = Gtk.accelerator_parse(text);
        if (ok && key !== 0) {
            settings.set_strv('toggle-key', [text]);
            entry.remove_css_class('error');
        } else {
            entry.add_css_class('error');
        }
    }
    keyRow.add_suffix(entry);
    misc.add(keyRow);
    page.add(misc);

    window.add(page);
    window.set_default_size(620, 760);
}
