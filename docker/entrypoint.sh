#!/bin/bash
set -euo pipefail
umask 077
children=()
cleanup() {
  trap - EXIT INT TERM
  if ((${#children[@]})); then
    kill "${children[@]}" 2>/dev/null || true
    wait "${children[@]}" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 0' INT TERM

if [[ "${MACHUN_REMOTE_LOGIN:-0}" == "1" ]]; then
  Xvfb "$DISPLAY" -screen 0 1280x960x24 -nolisten tcp -ac >/dev/null 2>&1 &
  children+=("$!")
  ready=0
  for attempt in {1..50}; do
    if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then ready=1; break; fi
    sleep 0.1
  done
  if [[ "$ready" != "1" ]]; then echo '登录窗口显示服务启动失败。' >&2; exit 1; fi
  fluxbox >/dev/null 2>&1 &
  children+=("$!")
  x11vnc -display "$DISPLAY" -localhost -rfbport 5900 -forever -shared -nopw -quiet >/dev/null 2>&1 &
  children+=("$!")
  websockify --web /usr/share/novnc 127.0.0.1:6080 127.0.0.1:5900 >/dev/null 2>&1 &
  children+=("$!")
fi

"$@" &
children+=("$!")
set +e
wait -n "${children[@]}"
result=$?
exit "$result"
