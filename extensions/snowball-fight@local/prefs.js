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
    const group = new Adw.PreferencesGroup({
        title: T('Снежки', 'Snowballs'),
        description: T('Горка снежков лежит на рабочем столе под окнами. Схватите снежок мышью и бросьте.', 'A pile of snowballs lies on the desktop. Grab a snowball with the mouse and throw it.'),
    });

    const enRow = new Adw.ActionRow({ title: T('Снежки на рабочем столе', 'Snowballs on the desktop'), subtitle: T('То же делает Super+Alt+B', 'Super+Alt+B does the same') });
    const sw = new Gtk.Switch({ valign: Gtk.Align.CENTER });
    settings.bind('enabled', sw, 'active', Gio.SettingsBindFlags.DEFAULT);
    enRow.add_suffix(sw);
    enRow.activatable_widget = sw;
    group.add(enRow);

    for (const [key, title, sub] of [
        ['show-indicator', T('Значок на верхней панели', 'Icon on the top bar'), ''],
    ]) {
        const row = new Adw.ActionRow({ title, subtitle: sub });
        const w = new Gtk.Switch({ valign: Gtk.Align.CENTER });
        settings.bind(key, w, 'active', Gio.SettingsBindFlags.DEFAULT);
        row.add_suffix(w);
        row.activatable_widget = w;
        group.add(row);
    }

    addVisibility(group, settings, T('«Только на пустом рабочем столе» — видно, когда все окна закрыты или свёрнуты', '“Only on an empty desktop” — visible when all windows are closed or minimized'));

    addLanguage(group, settings);

    const cRow = new Adw.ActionRow({ title: T('Где лежит горка', 'Where the pile lies') });
    const combo = new Gtk.ComboBoxText({ valign: Gtk.Align.CENTER });
    combo.append('bottom-right', T('Справа внизу', 'Bottom right'));
    combo.append('bottom-left', T('Слева внизу', 'Bottom left'));
    settings.bind('corner', combo, 'active-id', Gio.SettingsBindFlags.DEFAULT);
    cRow.add_suffix(combo);
    group.add(cRow);

    addSpin(group, settings, 'pile-size', T('Снежков в горке', 'Snowballs in the pile'), '', 1, 15, 1);
    addSpin(group, settings, 'ball-size', T('Размер снежка, px', 'Snowball size, px'), '', 16, 80, 2);
    addSpin(group, settings, 'throw-power', T('Сила броска', 'Throw power'), '', 0.3, 3, 0.1, 1);
    addSpin(group, settings, 'gravity', T('Гравитация, px/с²', 'Gravity, px/s²'), T('0 — летят по прямой', '0 — fly in a straight line'), 0, 3000, 50);
    addSpin(group, settings, 'splat-lifetime', T('Сколько держится след, секунд', 'How long splats stay, seconds'), '', 3, 600, 5);

    page.add(group);
    window.add(page);
    window.set_default_size(560, 560);
}
