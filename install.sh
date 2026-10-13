#!/usr/bin/env bash
# Source checkout entry: ./install.sh <action> [options].
# See bosun install --help for the current plan/apply/status/undo/service commands.
exec bun --no-env-file --no-install "$(cd "$(dirname "$0")" && pwd)/bin/bosun" install "$@"
