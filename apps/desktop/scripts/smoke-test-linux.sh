#!/usr/bin/env bash
# For CI: runs the smoke test (scripts/smoke-test.mjs) on the Linux builds the
# way users get them: the .deb as installed, the AppImage, then the unpacked
# build. Needs sudo, and xvfb, dbus, gnome-keyring and libfuse2t64 installed.
# Every run needs the keyring, so the vault and stdio checks always run.
set -euo pipefail
cd "$(dirname "$0")/.."

session=scripts/linux-test-session.sh
shopt -s nullglob
debs=(release/MCP-Connector-*.deb)
appimages=(release/MCP-Connector-*.AppImage)
if [ ${#debs[@]} -ne 1 ] || [ ${#appimages[@]} -ne 1 ]; then
  echo "Expected one .deb and one .AppImage in release/; run npm run package:linux first." >&2
  exit 1
fi

# Ubuntu 23.10 and newer restrict unprivileged user namespaces through
# AppArmor, which Chromium's sandbox needs. The app refuses to run without its
# sandbox, so each build below must be allowed by an AppArmor profile.
restrict=$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo "not set")
echo "kernel.apparmor_restrict_unprivileged_userns: $restrict"

echo "::group::.deb, installed with its AppArmor profile"
sudo apt-get install -y --no-install-recommends "./${debs[0]}"
if [ -f /etc/apparmor.d/mcp-connector ]; then cat /etc/apparmor.d/mcp-connector; fi
"$session" node scripts/smoke-test.mjs "/opt/MCP Connector/mcp-connector" --require-keyring
echo "::endgroup::"

echo "::group::AppImage, allowed by the AppArmor profile in the release notes"
if [ "$restrict" = 1 ]; then
  # Exactly the profile the release notes tell users to save.
  profile=$(sed -n '/^abi <abi\/4.0>,$/,/^}$/p' ../../.github/release-notes.md)
  if [ -z "$profile" ]; then
    echo "The release notes no longer contain the AppImage's AppArmor profile." >&2
    exit 1
  fi
  printf '%s\n' "$profile" | sudo tee /etc/apparmor.d/mcp-connector-appimage
  sudo apparmor_parser -r /etc/apparmor.d/mcp-connector-appimage
fi
"$session" node scripts/smoke-test.mjs "$PWD/${appimages[0]}" --require-keyring
echo "::endgroup::"

echo "::group::Unpacked build"
# No profile covers release/linux-unpacked, so lift the restriction for this
# run only. This changes the CI runner, never the app or a user's system.
if [ "$restrict" = 1 ]; then
  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
fi
"$session" node scripts/smoke-test.mjs --require-keyring
echo "::endgroup::"
