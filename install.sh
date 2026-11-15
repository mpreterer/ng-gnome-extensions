#!/usr/bin/env bash
# Festive GNOME extensions — installer / установщик
# Usage / запуск:  ./install.sh
set -euo pipefail
cd "$(dirname "$0")"

UUIDS=(snowfall-physics@local garland-lights@local ded-moroz-sleigh@local snowball-fight@local)
DEST="$HOME/.local/share/gnome-shell/extensions"

ru() { [[ "${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}" == ru* || "${LANGUAGE:-}" == ru* ]]; }
say() { if ru; then echo -e "$1"; else echo -e "$2"; fi; }
die() { say "❌ $1" "❌ $2"; exit 1; }

command -v gnome-shell >/dev/null || die "Не найден GNOME Shell. Эти расширения работают только в GNOME." \
                                        "GNOME Shell not found. These extensions work only in GNOME."
command -v glib-compile-schemas >/dev/null || die "Не найдена программа glib-compile-schemas. Установите: sudo apt install libglib2.0-bin" \
                                                 "glib-compile-schemas not found. Install it: sudo apt install libglib2.0-bin"
command -v gsettings >/dev/null || die "Не найдена программа gsettings." "gsettings not found."

VER=$(gnome-shell --version | grep -oE '[0-9]+' | head -1)
if [[ "$VER" != "42" ]]; then
    say "⚠️  Расширения сделаны и проверены для GNOME 42 (Ubuntu 22.04). У вас GNOME $VER — они могут не загрузиться." \
        "⚠️  These extensions are made and tested for GNOME 42 (Ubuntu 22.04). You have GNOME $VER — they may not load."
fi

mkdir -p "$DEST"
for u in "${UUIDS[@]}"; do
    rm -rf "${DEST:?}/${u:?}"
    cp -r "extensions/$u" "$DEST/$u"
    glib-compile-schemas "$DEST/$u/schemas"
    say "✅ установлено: $u" "✅ installed: $u"
done

# включаем расширения / enable the extensions
list=$(gsettings get org.gnome.shell enabled-extensions)
[[ "$list" == "@as []" ]] && list="[]"
for u in "${UUIDS[@]}"; do
    if [[ "$list" != *"'$u'"* ]]; then
        if [[ "$list" == "[]" ]]; then list="['$u']"; else list="${list%]}, '$u']"; fi
    fi
done
gsettings set org.gnome.shell enabled-extensions "$list"

if [[ "$(gsettings get org.gnome.shell disable-user-extensions)" == "true" ]]; then
    gsettings set org.gnome.shell disable-user-extensions false
    say "ℹ️  Пользовательские расширения были выключены в системе — включил." \
        "ℹ️  User extensions were disabled in the system — turned them on."
fi

echo
if [[ "${XDG_SESSION_TYPE:-}" == "x11" ]]; then
    say "Готово! Осталось перезапустить GNOME Shell (окна не закроются):\n  нажмите Alt+F2, введите r и нажмите Enter." \
        "Done! Now restart GNOME Shell (your windows stay open):\n  press Alt+F2, type r and press Enter."
else
    say "Готово! Осталось выйти из системы и войти снова (в Wayland Shell перезапускается только так)." \
        "Done! Now log out and log back in (on Wayland this is the only way to restart the Shell)."
fi
say "\nНастройки: значки снежинки, гирлянды, саней и снежка на верхней панели → «Настройки…»." \
    "\nSettings: the snowflake, garland, sleigh and snowball icons on the top bar → “Settings…”."
