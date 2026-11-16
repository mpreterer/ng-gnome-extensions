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

function addCombo(group, settings, key, title, subtitle, choices) {
    const row = new Adw.ActionRow({ title, subtitle: subtitle || '' });
    const combo = new Gtk.ComboBoxText({ valign: Gtk.Align.CENTER });
    for (const [id, label] of choices)
        combo.append(id, label);
    settings.bind(key, combo, 'active-id', Gio.SettingsBindFlags.DEFAULT);
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

function fillPreferencesWindow(window) {
    const settings = ExtensionUtils.getSettings();
    I18n.bindSettings(settings);
    const page = new Adw.PreferencesPage();
    const group = new Adw.PreferencesGroup({
        title: T('Ёлка', 'Christmas tree'),
        description: T('Возьмите игрушку из ящика рядом с ёлкой и отпустите над веткой — она там повиснет. Большую звезду ставьте на макушку. Чтобы снять игрушку, утащите её с ёлки. Наряд сохраняется после перезагрузки.',
            'Take a toy from the box next to the tree and release it over a branch — it hangs there. Put the big star on the top. To take a toy off, drag it away from the tree. The decorations are kept after a reboot.'),
    });
    addSwitch(group, settings, 'enabled', T('Ёлка на рабочем столе', 'Tree on the desktop'));
    addSwitch(group, settings, 'show-box', T('Ящик с игрушками', 'Toy box'), T('Можно убрать, когда ёлка наряжена', 'Hide it once the tree is decorated'));
    addSwitch(group, settings, 'show-indicator', T('Значок на верхней панели', 'Icon on the top bar'));
    addCombo(group, settings, 'position', T('Где стоит', 'Position'), T('Внизу главного монитора', 'At the bottom of the primary monitor'), [
        ['right', T('Справа', 'Right')], ['center', T('По центру', 'Center')], ['left', T('Слева', 'Left')],
    ]);
    addSpin(group, settings, 'tree-size', T('Размер', 'Size'), T('1.0 — высота около 430 px', '1.0 is about 430 px tall'), 0.5, 1.6, 0.05, 2);
    addCombo(group, settings, 'tree-snow', T('Снег на ветках', 'Snow on the branches'),
        T('«Копится в снегопад» — пока идёт снег из расширения «Снег»; потом медленно тает', '“Piles up while it snows” — while the Snowfall extension is snowing; then slowly melts'), [
            ['snowfall', T('Копится в снегопад', 'Piles up while it snows')], ['always', T('Всегда', 'Always')], ['never', T('Нет', 'None')],
        ]);
    addVisibility(group, settings, T('«Под окнами» — ёлка на рабочем столе, окна её закрывают', '“Below windows” — the tree stands on the desktop, windows cover it'));
    addLanguage(group, settings);
    page.add(group);
    window.add(page);
    window.set_default_size(560, 560);
}
