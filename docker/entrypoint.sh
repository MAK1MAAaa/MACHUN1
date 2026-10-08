#!/bin/sh
set -eu
mkdir -p "$MACHUN_DATA_DIR"
chmod 700 "$MACHUN_DATA_DIR"
exec "$@"
