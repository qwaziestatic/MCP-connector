#!/usr/bin/env bash
# Runs a command the way the packaged app's smoke test needs on Linux: on a
# virtual display, in a private D-Bus session with an unlocked GNOME Keyring,
# as a GNOME desktop. Chromium keeps the vault's key in that keyring; on a
# desktop it doesn't recognize it falls back to "basic_text", which the vault
# refuses, so the vault and stdio checks would be skipped.
#
# Needs xvfb, dbus and gnome-keyring.
#   apps/desktop/scripts/linux-test-session.sh npm run smoke-test -- --require-keyring
set -euo pipefail

export XDG_CURRENT_DESKTOP=GNOME
# Nothing in this session may reach a real display: on a developer's desktop,
# a keyring prompt would otherwise pop up there and wait for someone.
# xvfb-run gives the command its own display.
unset DISPLAY WAYLAND_DISPLAY
exec dbus-run-session -- bash -c '
  set -euo pipefail
  # Creates and unlocks a login keyring that lives only as long as this session.
  printf "smoke-test" | gnome-keyring-daemon --unlock --components=secrets > /dev/null
  exec xvfb-run --auto-servernum --server-args="-screen 0 1280x800x24" "$@"
' linux-test-session "$@"
