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
        title: T('Фейерверк', 'Fireworks'),
        description: T('В меню значка выберите «Поставить ракету / батарею / фонтан» и щёлкните по экрану. Наведите курсор на фейерверк — он станет зажигалкой — и зажмите кнопку мыши, пока не загорится фитиль. Правая кнопка по фейерверку — убрать его.',
            'In the icon menu choose “Place a rocket / cake / fountain” and click on the screen. Point at a firework — the pointer turns into a lighter — and hold the mouse button until the fuse catches. Right click a firework to remove it.'),
    });

    const enRow = new Adw.ActionRow({ title: T('Фейерверк включён', 'Fireworks enabled') });
    const sw = new Gtk.Switch({ valign: Gtk.Align.CENTER });
    settings.bind('enabled', sw, 'active', Gio.SettingsBindFlags.DEFAULT);
    enRow.add_suffix(sw);
    enRow.activatable_widget = sw;
    group.add(enRow);

    const indRow = new Adw.ActionRow({ title: T('Значок на верхней панели', 'Icon on the top bar') });
    const sw2 = new Gtk.Switch({ valign: Gtk.Align.CENTER });
    settings.bind('show-indicator', sw2, 'active', Gio.SettingsBindFlags.DEFAULT);
    indRow.add_suffix(sw2);
    indRow.activatable_widget = sw2;
    group.add(indRow);

    addVisibility(group, settings, T('«Только на пустом рабочем столе» — видно, когда все окна закрыты или свёрнуты', '“Only on an empty desktop” — visible when all windows are closed or minimized'));
    addLanguage(group, settings);
    addSpin(group, settings, 'burst-size', T('⚡ Искр в одном взрыве', '⚡ Sparks in one burst'),
        T('Больше — пышнее, но тяжелее для системы. Рекомендуется 80–120', 'More is fuller but heavier. Recommended 80–120'), 30, 250, 10);

    const keyRow = new Adw.ActionRow({
        title: T('«Салют сейчас!»', '“Fireworks now!”'),
        subtitle: T('Из меню значка или клавишами Super+Alt+F', 'From the icon menu or with Super+Alt+F'),
    });
    group.add(keyRow);

    page.add(group);
    window.add(page);
    window.set_default_size(560, 520);
}
