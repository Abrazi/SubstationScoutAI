#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIBIEC_ROOT="${LIBIEC_ROOT:-/tmp/libiec61850}"
GEN_DIR="${GEN_DIR:-$ROOT_DIR/.libiec-generated}"
SCD_FILE="${SCD_FILE:-$ROOT_DIR/DUBGG.scd}"
SCD_IED_NAME="${SCD_IED_NAME:-}"
SCD_AP_NAME="${SCD_AP_NAME:-}"
LIBIEC_BIN="${LIBIEC_BIN:-$GEN_DIR/dubgg_server}"
BACKEND_PORT="${IEC_BACKEND_PORT:-8102}"
BACKEND_HOST="${IEC_BACKEND_HOST:-127.0.0.1}"
RELAY_AUTOCONFIG_ENDPOINT="${RELAY_AUTOCONFIG_ENDPOINT:-0}"
RELAY_FORCE_BACKEND="${RELAY_FORCE_BACKEND:-1}"
RELAY_LOG="${RELAY_LOG:-$ROOT_DIR/relay.log}"
BACKEND_LOG="${BACKEND_LOG:-$ROOT_DIR/libiec61850.log}"

resolve_scd_path() {
  if [[ "$SCD_FILE" = /* ]]; then
    echo "$SCD_FILE"
  else
    echo "$ROOT_DIR/$SCD_FILE"
  fi
}

build_libiec() {
  if [[ -f "$LIBIEC_ROOT/build/src/libiec61850.a" && -f "$LIBIEC_ROOT/build/hal/libhal.a" ]]; then
    return 0
  fi

  echo "[std-iec] libiec61850 binary not found; building at $LIBIEC_ROOT"
  rm -rf "$LIBIEC_ROOT"
  git clone --depth 1 https://github.com/mz-automation/libiec61850.git "$LIBIEC_ROOT"
  cmake -S "$LIBIEC_ROOT" -B "$LIBIEC_ROOT/build" -DBUILD_EXAMPLES=ON -DBUILD_PYTHON_BINDINGS=OFF
  cmake --build "$LIBIEC_ROOT/build" -j"$(nproc)"

  if [[ ! -f "$LIBIEC_ROOT/build/src/libiec61850.a" || ! -f "$LIBIEC_ROOT/build/hal/libhal.a" ]]; then
    echo "[std-iec] failed to build libiec61850 libraries"
    exit 1
  fi
}

build_scd_backend() {
  local resolved_scd
  resolved_scd="$(resolve_scd_path)"

  if [[ ! -f "$resolved_scd" ]]; then
    echo "[std-iec] SCD file not found: $resolved_scd"
    exit 1
  fi

  mkdir -p "$GEN_DIR"

  local scd_marker="$GEN_DIR/.active_scd"
  local previous_scd=""
  if [[ -f "$scd_marker" ]]; then
    previous_scd="$(cat "$scd_marker" 2>/dev/null || true)"
  fi

  local regen_required=0
  if [[ ! -f "$GEN_DIR/ied_model.c" ]]; then
    regen_required=1
  elif [[ "$resolved_scd" -nt "$GEN_DIR/ied_model.c" ]]; then
    regen_required=1
  elif [[ "$previous_scd" != "$resolved_scd" ]]; then
    regen_required=1
  fi

  if [[ $regen_required -eq 1 ]]; then
    echo "[std-iec] generating IEC model from $resolved_scd"
    (
      cd "$GEN_DIR"
      local args=("$resolved_scd" "-out" "ied_model")
      if [[ -n "$SCD_IED_NAME" ]]; then
        args+=("-ied" "$SCD_IED_NAME")
      fi
      if [[ -n "$SCD_AP_NAME" ]]; then
        args+=("-ap" "$SCD_AP_NAME")
      fi
      java -jar "$LIBIEC_ROOT/tools/model_generator/genmodel.jar" "${args[@]}"
    )
    echo "$resolved_scd" > "$scd_marker"
  fi

  if [[ ! -x "$LIBIEC_BIN" || "$GEN_DIR/ied_model.c" -nt "$LIBIEC_BIN" || "$ROOT_DIR/scripts/dubgg_libiec_server.c" -nt "$LIBIEC_BIN" ]]; then
    echo "[std-iec] compiling custom libiec backend"

    cat > "$GEN_DIR/ied_model_stubs.c" <<'EOF'
#include "iec61850_model.h"
/* Workaround for generator output referencing missing GoCB symbol in some SCD files */
GSEControlBlock iedModel_Application_LLN0_gse0 = {0};
EOF

    cc -O2 -Wredundant-decls -Wundef \
      -I"$LIBIEC_ROOT/build/config" \
      -I"$LIBIEC_ROOT/src/common/inc" \
      -I"$LIBIEC_ROOT/src/goose" \
      -I"$LIBIEC_ROOT/src/sampled_values" \
      -I"$LIBIEC_ROOT/src/r_session" \
      -I"$LIBIEC_ROOT/src/hal/inc" \
      -I"$LIBIEC_ROOT/src/iec61850/inc" \
      -I"$LIBIEC_ROOT/src/iec61850/inc_private" \
      -I"$LIBIEC_ROOT/src/mms/inc" \
      -I"$LIBIEC_ROOT/src/mms/inc_private" \
      -I"$LIBIEC_ROOT/src/mms/iso_mms/asn1c" \
      -I"$LIBIEC_ROOT/src/logging" \
      -I"$LIBIEC_ROOT/hal/inc" \
      -I"$GEN_DIR" \
      "$ROOT_DIR/scripts/dubgg_libiec_server.c" \
      "$GEN_DIR/ied_model.c" \
      "$GEN_DIR/ied_model_stubs.c" \
      "$LIBIEC_ROOT/build/src/libiec61850.a" \
      "$LIBIEC_ROOT/build/hal/libhal.a" \
      -lpthread -lm -lrt \
      -o "$LIBIEC_BIN"
  fi
}

stop_old() {
  pkill -f "$LIBIEC_BIN $BACKEND_PORT" >/dev/null 2>&1 || true
  pkill -f "node scripts/modbus-relay.cjs" >/dev/null 2>&1 || true
}

start_backend() {
  # Backend is now started by the relay (modbus-relay.cjs)
  echo "[std-iec] backend binary ready at $LIBIEC_BIN"
}

start_relay() {
  (
    cd "$ROOT_DIR"
    if [[ "$RELAY_FORCE_BACKEND" == "1" ]]; then
      RELAY_IEC_BACKEND_HOST="$BACKEND_HOST" \
      RELAY_IEC_BACKEND_PORT="$BACKEND_PORT" \
      RELAY_IEC_FORCE_BACKEND=1 \
      RELAY_IEC_FORCE_BACKEND_HOST="$BACKEND_HOST" \
      RELAY_IEC_FORCE_BACKEND_PORT="$BACKEND_PORT" \
      RELAY_IEC_DEFAULT_LISTENER=0 \
      RELAY_CLEAR_IEC_ON_UI_DISCONNECT=1 \
      IEC_SERVER_BIN="$LIBIEC_BIN" \
      nohup npm run relay > "$RELAY_LOG" 2>&1 &
    else
      RELAY_IEC_BACKEND_HOST="$BACKEND_HOST" \
      RELAY_IEC_BACKEND_PORT="$BACKEND_PORT" \
      RELAY_IEC_DEFAULT_LISTENER=0 \
      RELAY_CLEAR_IEC_ON_UI_DISCONNECT=1 \
      IEC_SERVER_BIN="$LIBIEC_BIN" \
      nohup npm run relay > "$RELAY_LOG" 2>&1 &
    fi
  )
  echo "[std-iec] relay started: 172.16.21.12:102"
}

configure_endpoint() {
  sleep 2
  (cd "$ROOT_DIR" && IEC_BACKEND_HOST="$BACKEND_HOST" IEC_BACKEND_PORT="$BACKEND_PORT" node test-relay-config.cjs)
}

show_status() {
  echo "[std-iec] listeners:"
  ss -tlnp | grep -E ":102|:$BACKEND_PORT" || true
  echo "[std-iec] active SCD: $(resolve_scd_path)"
  if [[ -n "$SCD_IED_NAME" ]]; then
    echo "[std-iec] selected IED: $SCD_IED_NAME"
  fi
  if [[ -n "$SCD_AP_NAME" ]]; then
    echo "[std-iec] selected AP: $SCD_AP_NAME"
  fi
  echo "[std-iec] relay tail:"
  tail -8 "$RELAY_LOG" || true
}

build_libiec
build_scd_backend
stop_old
start_backend
start_relay

if [[ "$RELAY_AUTOCONFIG_ENDPOINT" == "1" ]]; then
  configure_endpoint
else
  echo "[std-iec] relay endpoint auto-config disabled; use app Network Binding -> Connect IEC to publish imported IED endpoints"
fi

show_status
