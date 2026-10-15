#!/usr/bin/env bash
set -euo pipefail

LABEL="com.agent.monitor"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
DOMAIN="gui/$(id -u)"

if [[ -f "$PLIST" ]]; then
  launchctl bootout "${DOMAIN}" "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "已停止并移除 LaunchAgent：${LABEL}"
else
  echo "未安装 LaunchAgent（找不到 ${PLIST}）"
fi
