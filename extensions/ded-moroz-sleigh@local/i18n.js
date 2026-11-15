/* Two-language UI: Russian or English.
 * Двуязычный интерфейс: русский или английский.
 * Setting "language": auto (as in the system), ru, en. Uses only GLib, so it
 * works both in GNOME Shell and in the preferences window.
 * Настройка "language": auto (как в системе), ru, en. */
'use strict';

const { GLib } = imports.gi;

const SYSTEM = GLib.get_language_names().find(l => l !== 'C' && l !== 'POSIX') || 'en';

let _ru = SYSTEM.startsWith('ru');

function setLanguage(pref) {
    _ru = pref === 'ru' || (pref !== 'en' && SYSTEM.startsWith('ru'));
}

// берёт язык из настроек расширения (ключ "language")
function bindSettings(settings) {
    // чтение несуществующего ключа аварийно завершает процесс — проверяем схему
    const schema = settings.settings_schema;
    setLanguage(schema && schema.has_key('language') ? settings.get_string('language') : 'auto');
}

function isRu() {
    return _ru;
}

/* T('русский текст', 'English text') */
function T(ru, en) {
    return _ru ? ru : en;
}
