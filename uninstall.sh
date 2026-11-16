#!/usr/bin/env bash
# Festive GNOME extensions — uninstaller / удаление
# Usage / запуск:  ./uninstall.sh
set -euo pipefail

UUIDS=(snowfall-physics@local garland-lights@local ded-moroz-sleigh@local snowball-fight@local fireworks@local christmas-tree@local)
DEST="$HOME/.local/share/gnome-shell/extensions"

ru() { [[ "${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}" == ru* || "${LANGUAGE:-}" == ru* ]]; }
say() { if ru; then echo -e "$1"; else echo -e "$2"; fi; }

# выключаем / disable
list=$(gsettings get org.gnome.shell enabled-extensions)
for u in "${UUIDS[@]}"; do
    list=$(echo "$list" | sed -e "s/'$u', //; s/, '$u'//; s/'$u'//")
    command -v gnome-extensions >/dev/null && gnome-extensions disable "$u" 2>/dev/null || true
done
[[ "$list" == "[]" ]] && list="@as []"
gsettings set org.gnome.shell enabled-extensions "$list"

# удаляем файлы и настройки / remove files and settings
for u in "${UUIDS[@]}"; do
    rm -rf "${DEST:?}/${u:?}"
    name="${u%@*}"
    dconf reset -f "/org/gnome/shell/extensions/$name/" 2>/dev/null || true
    say "🗑  удалено: $u" "🗑  removed: $u"
done

echo
if [[ "${XDG_SESSION_TYPE:-}" == "x11" ]]; then
    say "Готово. Чтобы всё исчезло с экрана: Alt+F2, введите r, Enter." \
        "Done. To clear the screen: press Alt+F2, type r, press Enter."
else
    say "Готово. Чтобы всё исчезло с экрана, выйдите из системы и войдите снова." \
        "Done. To clear the screen, log out and log back in."
fi
