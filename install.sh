#!/usr/bin/env bash
# ./install.sh [--host claude|codex|both] [--replace-plugins]   (same as: bosun install)
exec node "$(cd "$(dirname "$0")" && pwd)/bin/bosun" install "$@"
