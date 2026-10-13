#!/bin/sh
# Start Bun with a fresh HOME/cache before any JavaScript can run. No installs.
set -eu
case "${1:-}" in
  tests) driver=scripts/run-tests.mts ;;
  containment) driver=scripts/check-containment.mts ;;
  typecheck) driver=scripts/run-typecheck.mts ;;
  boundaries) driver=scripts/check-boundaries.mts ;;
  build) driver=scripts/build.mts ;;
  verify) driver=scripts/verify-distribution.mts ;;
  formula) driver=scripts/generate-homebrew.mts ;;
  assets) driver=scripts/generate-assets.mts ;;
  eval-router) driver=scripts/eval-router.mts ;;
  eval-memory) driver=scripts/eval-memory.mts ;;
  sqlite-probe) driver=scripts/check-bun-sqlite.mts ;;
  sqlite-library-probe) driver=scripts/check-sqlite-library.mts ;;
  sqlite-native-acquire) driver=scripts/acquire-sqlite-native.mts ;;
  sqlite-native-prepare) driver=scripts/prepare-sqlite-native.mts ;;
  sqlite-native-build) driver=scripts/build-sqlite-native.mts ;;
  release-check) driver=scripts/check-release.mts ;;
  lsp) driver=scripts/run-lsp.mts ;;
  *) echo 'Usage: sh scripts/bun-check.sh tests|containment|typecheck|boundaries|build|verify|formula|assets|eval-router|eval-memory|sqlite-probe|sqlite-library-probe|sqlite-native-acquire|sqlite-native-prepare|sqlite-native-build|release-check|lsp [arguments]' >&2; exit 2 ;;
esac
shift
bun=$(command -v bun) || { echo 'Installed Bun is required; this command never installs it' >&2; exit 2; }
root=$(mktemp -d "${TMPDIR:-/private/tmp}/bosun-bun-driver.XXXXXX")
trap 'if [ -d "$root" ]; then rm -r -- "$root"; fi' EXIT
trap 'exit 143' HUP INT TERM
mkdir -m 700 "$root/home" "$root/cache"
env -i HOME="$root/home" TMPDIR="${TMPDIR:-/private/tmp}" TMP="${TMPDIR:-/private/tmp}" TEMP="${TMPDIR:-/private/tmp}" \
  XDG_CONFIG_HOME="$root/home/.config" XDG_DATA_HOME="$root/home/.local/share" XDG_STATE_HOME="$root/home/.local/state" XDG_CACHE_HOME="$root/cache" \
  BUN_INSTALL_CACHE_DIR="$root/cache" BUN_RUNTIME_TRANSPILER_CACHE_PATH="$root/cache/transpiler" DO_NOT_TRACK=1 \
  PATH="$(dirname "$bun"):/usr/bin:/bin" LANG=C LC_ALL=C TZ=UTC \
  "$bun" --no-env-file --no-install "$driver" "$@"
