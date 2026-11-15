'use strict';

const { Adw, Gdk, Gtk, Gio } = imports.gi;
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

function addChoice(group, settings, key, title, choices) {
    const row = new Adw.ActionRow({ title });
    const combo = new Gtk.ComboBoxText({ valign: Gtk.Align.CENTER });
    for (const [id, label] of choices)
        combo.append(id, label);
    settings.bind(key, combo, 'active-id', Gio.SettingsBindFlags.DEFAULT);
    row.add_suffix(combo);
    row.activatable_widget = combo;
    group.add(row);
}

function fillPreferencesWindow(window) {
    const settings = ExtensionUtils.getSettings();
    I18n.bindSettings(settings);
    const page = new Adw.PreferencesPage();

    const main = new Adw.PreferencesGroup({ title: T('Гирлянда', 'Garland') });
    addSwitch(main, settings, 'enabled', T('Гирлянда включена', 'Garland enabled'), T('То же делает горячая клавиша', 'The hotkey does the same'));
    addSwitch(main, settings, 'lights-on', T('Лампочки горят', 'Lights on'), T('Переключается и шнурком справа на гирлянде', 'Also toggled by the pull cord on the right'));
    addSwitch(main, settings, 'show-pull', T('Шнурок-выключатель справа', 'Pull-cord switch on the right'));
    addChoice(main, settings, 'mode', T('Режим мигания', 'Blink mode'), [
        ['twinkle', T('Мерцание', 'Twinkle')],
        ['chase', T('Бегущие огни', 'Chase')],
        ['alternate', T('Попеременно', 'Alternate')],
        ['steady', T('Ровный свет', 'Steady')],
    ]);
    addChoice(main, settings, 'palette', T('Цвета', 'Colors'), [
        ['multicolor', T('Разноцветные', 'Multicolor')],
        ['warm', T('Тёплые жёлтые', 'Warm yellow')],
        ['cold', T('Холодные голубые', 'Cold blue')],
    ]);
    addSpin(main, settings, 'speed', T('Скорость мигания', 'Blink speed'), '', 0.2, 4, 0.1, 1);
    page.add(main);

    const look = new Adw.PreferencesGroup({ title: T('Форма', 'Shape') });
    // цвет провода: любой через палитру
    const wireRow = new Adw.ActionRow({ title: T('Цвет провода', 'Wire color'), subtitle: T('Готовые цвета есть и в меню на панели', 'Preset colors are also in the panel menu') });
    const colorBtn = new Gtk.ColorButton({ valign: Gtk.Align.CENTER, use_alpha: false });
    const syncColor = () => {
        const rgba = new Gdk.RGBA();
        if (rgba.parse(settings.get_string('wire-color')))
            colorBtn.set_rgba(rgba);
    };
    syncColor();
    settings.connect('changed::wire-color', syncColor);
    colorBtn.connect('color-set', () => {
        const c = colorBtn.get_rgba();
        const hex = '#' + [c.red, c.green, c.blue]
            .map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
        settings.set_string('wire-color', hex);
    });
    wireRow.add_suffix(colorBtn);
    wireRow.activatable_widget = colorBtn;
    look.add(wireRow);
    addSpin(look, settings, 'bulb-count', T('Количество лампочек', 'Number of bulbs'), '', 5, 150, 1);
    addSpin(look, settings, 'sag', T('Провисание в середине, px', 'Sag in the middle, px'), '', 10, 400, 5);
    addSpin(look, settings, 'bulb-scale', T('Размер лампочек', 'Bulb size'), '', 0.5, 2.5, 0.1, 1);
    addVisibility(look, settings, T('«Только на пустом рабочем столе» — видно, когда все окна закрыты или свёрнуты', '“Only on an empty desktop” — visible when all windows are closed or minimized'));
    addLanguage(look, settings);
    addSwitch(look, settings, 'show-indicator', T('Значок на верхней панели', 'Icon on the top bar'));
    addSwitch(look, settings, 'hide-in-fullscreen', T('Прятать в полноэкранном режиме', 'Hide in fullscreen'), T('Видео, игры, презентации', 'Videos, games, presentations'));
    page.add(look);

    const keys = new Adw.PreferencesGroup({ title: T('Горячая клавиша', 'Hotkey') });
    const keyRow = new Adw.ActionRow({
        title: T('Включить/выключить', 'Turn on/off'),
        subtitle: T('Формат GTK, например &lt;Super&gt;&lt;Alt&gt;g. Пустое поле — без клавиши', 'GTK format, e.g. &lt;Super&gt;&lt;Alt&gt;g. Empty — no hotkey'),
    });
    const entry = new Gtk.Entry({ valign: Gtk.Align.CENTER, width_chars: 16 });
    entry.text = settings.get_strv('toggle-key')[0] || '';
    const applyKey = () => {
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
    };
    entry.connect('activate', applyKey);
    const focus = new Gtk.EventControllerFocus();
    focus.connect('leave', applyKey);
    entry.add_controller(focus);
    keyRow.add_suffix(entry);
    keys.add(keyRow);
    page.add(keys);

    window.add(page);
    window.set_default_size(600, 640);
}
