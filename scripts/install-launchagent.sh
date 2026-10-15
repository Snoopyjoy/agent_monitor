#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.agent.monitor"
AGENTS="$HOME/Library/LaunchAgents"
PLIST="$AGENTS/${LABEL}.plist"
NODE="$(command -v node)"
LOG_DIR="$ROOT/data/logs"

if [[ -z "$NODE" ]]; then
  echo "找不到 node，请先安装 Node.js（本项目需要 >= 22.13）"
  exit 1
fi

mkdir -p "$LOG_DIR" "$AGENTS"

UID_NUM="$(id -u)"
DOMAIN="gui/${UID_NUM}"

if launchctl print "${DOMAIN}/${LABEL}" &>/dev/null; then
  launchctl bootout "${DOMAIN}" "$PLIST" 2>/dev/null || true
fi

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>WorkingDirectory</key>
  <string>${ROOT}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE}</string>
    <string>--disable-warning=ExperimentalWarning</string>
    <string>${ROOT}/server/index.js</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/stderr.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key>
    <string>${PORT:-7788}</string>
    <key>PATH</key>
    <string>/usr/bin:/bin:/usr/sbin:/sbin:${HOME}/.nvm/versions/node/current/bin</string>
  </dict>
</dict>
</plist>
EOF

# 结束手动 `npm start` 留下的实例（命令行可能是相对路径，所以按运行目录识别），避免占用端口
for pid in $(pgrep -f 'server/index\.js' || true); do
  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
  if [[ "$cwd" == "$ROOT" ]]; then
    kill "$pid" 2>/dev/null || true
  fi
done
sleep 1

launchctl bootstrap "${DOMAIN}" "$PLIST"
launchctl enable "${DOMAIN}/${LABEL}" 2>/dev/null || true
launchctl kickstart -k "${DOMAIN}/${LABEL}"

sleep 1

echo ""
echo "Agent 监控已注册为后台服务（LaunchAgent）"
"$NODE" "$ROOT/scripts/print-urls.js"
echo "日志：${LOG_DIR}/stdout.log"
echo ""
echo "常用命令："
echo "  当前访问地址  npm run url"
echo "  查看状态  launchctl print ${DOMAIN}/${LABEL}"
echo "  重启服务  launchctl kickstart -k ${DOMAIN}/${LABEL}"
echo "  停止并卸载  npm run daemon:uninstall"
