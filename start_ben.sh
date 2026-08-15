#!/usr/bin/env bash
#
# start_ben.sh - start BEN's web app and open it in the browser.
#
# Launches the two processes the browser UI needs:
#   gameserver.py  ws://localhost:4443  bot engine (websockets)
#   appserver.py   http://localhost:8080  the UI itself
#
# Both must run from specific directories (appserver resolves BBA/CC and the
# game db relative to the working directory), and the browser talks to the
# gameserver directly on 4443, so both ports have to be free.
#
# Usage:
#   ./start_ben.sh                          random boards
#   ./start_ben.sh --boards Boards/x.pbn    deal from a file
#   ./start_ben.sh --force                  kill anything already on the ports
#   ./start_ben.sh --no-browser             don't open a browser window
#
# Any option that isn't listed above is passed through to gameserver.py.
# Ctrl-C stops everything.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Pick the interpreter: BEN_PYTHON wins, then an activated virtualenv, then the
# repo's own .venv, then a conda env named TF2 or ben, then python3 (macOS often
# has no bare `python`). Same ladder as src/runservers.sh, plus conda, since the
# README recommends installing into a conda environment.
pick_python() {
    if [[ -n "${BEN_PYTHON:-}" ]]; then printf '%s' "$BEN_PYTHON"; return; fi
    if [[ -n "${VIRTUAL_ENV:-}" && -x "$VIRTUAL_ENV/bin/python" ]]; then printf '%s' "$VIRTUAL_ENV/bin/python"; return; fi
    if [[ -x "$ROOT/.venv/bin/python" ]]; then printf '%s' "$ROOT/.venv/bin/python"; return; fi
    for env in TF2 ben; do
        for base in "$HOME/anaconda3" "$HOME/miniconda3" "$HOME/miniforge3" /opt/homebrew/anaconda3; do
            [[ -x "$base/envs/$env/bin/python" ]] && { printf '%s' "$base/envs/$env/bin/python"; return; }
        done
    done
    command -v python3 2>/dev/null || command -v python 2>/dev/null
}
PY="$(pick_python)"

APP_PORT="${BEN_APP_PORT:-8080}"
WS_PORT="${BEN_WS_PORT:-4443}"
LOG_DIR="$ROOT/logs"

# PIMC's engine (BGADLL) is a NativeAOT .NET library whose [DllImport("dds")]
# is resolved by dlopen, and dlopen does not search the assembly's own
# directory on macOS. Without this the DDS backend reports "Unable to load
# shared library 'dds'" at startup and the server dies with SIGABRT partway
# through the first trick. dyld only reads this at process start, so it has to
# be exported here rather than set from inside Python.
if [[ "$(uname -s)" == "Darwin" && -d "$ROOT/bin/BGA/macos/arm64" ]]; then
    export DYLD_LIBRARY_PATH="$ROOT/bin/BGA/macos/arm64${DYLD_LIBRARY_PATH:+:$DYLD_LIBRARY_PATH}"
fi

OPEN_BROWSER=1
FORCE=0
GAMESERVER_ARGS=()

# gameserver runs with its working directory set to src/, so any path the user
# typed relative to wherever they invoked this script has to be absolutised
# before being passed through.
absolutise() {
    if [[ -e "$1" && "$1" != /* ]]; then
        printf '%s/%s' "$(cd "$(dirname "$1")" && pwd)" "$(basename "$1")"
    else
        printf '%s' "$1"
    fi
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --no-browser) OPEN_BROWSER=0; shift ;;
        --force)      FORCE=1; shift ;;
        -h|--help)    sed -n '3,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *)            GAMESERVER_ARGS+=("$(absolutise "$1")"); shift ;;
    esac
done

if [[ -z "$PY" || ! -x "$PY" ]]; then
    echo "error: no usable python found${PY:+ at $PY}" >&2
    echo "       Point BEN_PYTHON at the interpreter that has BEN's dependencies, e.g." >&2
    echo "       BEN_PYTHON=\$HOME/anaconda3/envs/ben/bin/python ./start_ben.sh" >&2
    echo "       See conda_setup.sh to create the environment." >&2
    exit 1
fi

# --- port handling ---------------------------------------------------------

listeners_on() { lsof -ti "tcp:$1" -sTCP:LISTEN 2>/dev/null || true; }

for spec in "$WS_PORT:gameserver" "$APP_PORT:appserver"; do
    port="${spec%%:*}"; what="${spec##*:}"
    busy="$(listeners_on "$port")"
    [[ -z "$busy" ]] && continue
    if (( FORCE )); then
        echo "port $port ($what) in use by pid(s) $(echo $busy) - killing"
        kill $busy 2>/dev/null || true
        for _ in {1..20}; do
            [[ -z "$(listeners_on "$port")" ]] && break
            sleep 0.25
        done
        [[ -n "$(listeners_on "$port")" ]] && kill -9 $(listeners_on "$port") 2>/dev/null || true
    else
        echo "error: port $port ($what) is already in use by pid(s) $(echo $busy)" >&2
        echo "       BEN is probably already running. Re-run with --force to restart it." >&2
        exit 1
    fi
done

# --- launch ----------------------------------------------------------------

mkdir -p "$LOG_DIR"
PIDS=()
STOPPING=0

cleanup() {
    (( STOPPING )) && return
    STOPPING=1
    trap - INT TERM EXIT
    echo ""
    echo "stopping..."
    for pid in ${PIDS[@]+"${PIDS[@]}"}; do
        kill "$pid" 2>/dev/null || true
    done
    for pid in ${PIDS[@]+"${PIDS[@]}"}; do
        for _ in {1..40}; do
            kill -0 "$pid" 2>/dev/null || break
            sleep 0.25
        done
        kill -9 "$pid" 2>/dev/null || true
    done
    wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

echo "python:  $PY"
echo "logs:    $LOG_DIR"
echo ""

# ${arr[@]+...} guards against "unbound variable" on empty arrays in bash 3.2,
# which is what macOS ships.
( cd "$ROOT/src" && exec "$PY" gameserver.py --port "$WS_PORT" ${GAMESERVER_ARGS[@]+"${GAMESERVER_ARGS[@]}"} ) \
    > "$LOG_DIR/gameserver.log" 2>&1 &
GAMESERVER_PID=$!
PIDS+=("$GAMESERVER_PID")

# BEN_UI selects the play UI ("bridge" or "allwyn"); appserver defaults it.
( cd "$ROOT/src/frontend" && exec "$PY" appserver.py --host 127.0.0.1 --port "$APP_PORT" \
    ${BEN_UI:+--ui "$BEN_UI"} ) \
    > "$LOG_DIR/appserver.log" 2>&1 &
APPSERVER_PID=$!
PIDS+=("$APPSERVER_PID")

# --- wait until both are actually listening --------------------------------

# gameserver loads the neural nets before it binds, so give it plenty of time.
wait_for_port() {
    local port="$1" name="$2" pid="$3" timeout="$4" waited=0
    printf "waiting for %s on port %s " "$name" "$port"
    while (( waited < timeout )); do
        if ! kill -0 "$pid" 2>/dev/null; then
            printf "\n"
            echo "error: $name exited during startup. Last lines of $LOG_DIR/$name.log:" >&2
            tail -n 20 "$LOG_DIR/$name.log" >&2
            exit 1
        fi
        if nc -z 127.0.0.1 "$port" 2>/dev/null; then
            printf " ok\n"
            return 0
        fi
        printf "."
        sleep 1
        waited=$((waited + 1))
    done
    printf "\n"
    echo "error: $name did not start listening within ${timeout}s - see $LOG_DIR/$name.log" >&2
    exit 1
}

wait_for_port "$WS_PORT" gameserver "$GAMESERVER_PID" 300
wait_for_port "$APP_PORT" appserver "$APPSERVER_PID" 60

URL="http://localhost:$APP_PORT/home"
echo ""
echo "BEN is up: $URL"
echo "Ctrl-C to stop both servers."
(( OPEN_BROWSER )) && open "$URL"

# Exit as soon as either server dies, so we never leave a half-running app.
while kill -0 "$GAMESERVER_PID" 2>/dev/null && kill -0 "$APPSERVER_PID" 2>/dev/null; do
    sleep 1
done
echo "a server exited - shutting the other one down"
