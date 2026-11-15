'use strict';

const { Adw, Gtk, Gio, GLib } = imports.gi;
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

    const main = new Adw.PreferencesGroup({ title: T('Дед Мороз на санях', 'Ded Moroz on a sleigh') });

    const addSwitch = (key, title, subtitle) => {
        const row = new Adw.ActionRow({ title, subtitle: subtitle || '' });
        const w = new Gtk.Switch({ valign: Gtk.Align.CENTER });
        settings.bind(key, w, 'active', Gio.SettingsBindFlags.DEFAULT);
        row.add_suffix(w);
        row.activatable_widget = w;
        main.add(row);
    };
    addSwitch('enabled', T('Проезжать автоматически', 'Ride automatically'), T('Выключено — только по кнопке или Super+Alt+D', 'Off — only by the button or Super+Alt+D'));
    addVisibility(main, settings, T('«Только на пустом рабочем столе» — видно, когда все окна закрыты или свёрнуты', '“Only on an empty desktop” — visible when all windows are closed or minimized'));
    addLanguage(main, settings);
    addSwitch('show-indicator', T('Значок на верхней панели', 'Icon on the top bar'));

    const runRow = new Adw.ActionRow({
        title: T('Проехать сейчас', 'Ride now'),
        subtitle: T('То же делает Super+Alt+D', 'Super+Alt+D does the same'),
    });
    const runBtn = new Gtk.Button({ label: T('Запустить', 'Start'), valign: Gtk.Align.CENTER });
    runBtn.add_css_class('suggested-action');
    runBtn.connect('clicked', () =>
        settings.set_int64('run-request', Math.floor(GLib.get_real_time() / 1000)));
    runRow.add_suffix(runBtn);
    main.add(runRow);

    addSpin(main, settings, 'interval-minutes', T('Как часто проезжает, минут', 'How often it rides, minutes'), T('180 = раз в 3 часа', '180 = once every 3 hours'), 1, 1440, 10);
    addSpin(main, settings, 'speed', T('Скорость, px/с', 'Speed, px/s'), '', 60, 800, 10);
    addSpin(main, settings, 'scale', T('Размер', 'Size'), T('1.0 — примерно 400×120 px', '1.0 ≈ 420×130 px'), 0.5, 2.5, 0.1, 1);

    const dirRow = new Adw.ActionRow({ title: T('Направление', 'Direction') });
    const combo = new Gtk.ComboBoxText({ valign: Gtk.Align.CENTER });
    combo.append('random', T('Случайно', 'Random'));
    combo.append('ltr', T('Слева направо', 'Left to right'));
    combo.append('rtl', T('Справа налево', 'Right to left'));
    settings.bind('direction', combo, 'active-id', Gio.SettingsBindFlags.DEFAULT);
    dirRow.add_suffix(combo);
    main.add(dirRow);

    const fsRow = new Adw.ActionRow({
        title: T('Не ездить поверх полноэкранных окон', 'Do not ride over fullscreen windows'),
        subtitle: T('Видео, игры, презентации', 'Videos, games, presentations'),
    });
    const sw = new Gtk.Switch({ valign: Gtk.Align.CENTER });
    settings.bind('hide-in-fullscreen', sw, 'active', Gio.SettingsBindFlags.DEFAULT);
    fsRow.add_suffix(sw);
    fsRow.activatable_widget = sw;
    main.add(fsRow);

    page.add(main);
    window.add(page);
    window.set_default_size(560, 520);
}
