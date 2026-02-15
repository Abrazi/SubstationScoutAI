#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIBIEC_ROOT="${LIBIEC_ROOT:-/tmp/libiec61850}"
GEN_DIR="${GEN_DIR:-$ROOT_DIR/.libiec-generated}"
LIBIEC_BIN="${LIBIEC_BIN:-$GEN_DIR/dubgg_server}"
BACKEND_PORT="${IEC_BACKEND_PORT:-8102}"

pkill -f "$LIBIEC_BIN $BACKEND_PORT" >/dev/null 2>&1 || true
pkill -f "server_example_simple $BACKEND_PORT" >/dev/null 2>&1 || true
pkill -f "node scripts/modbus-relay.cjs" >/dev/null 2>&1 || true

echo "[std-iec] stopped backend + relay"
ss -tlnp | grep -E ":102|:$BACKEND_PORT" || true
