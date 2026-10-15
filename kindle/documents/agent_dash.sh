#!/bin/sh
# Name: 看板模式
# Author: agent_monitor

SELF="$0"
[ -f "$SELF" ] || SELF=/mnt/us/documents/agent_dash.sh
if [ "$(id -u)" -ne 0 ]; then
	if [ ! -x /var/local/mkk/su ]; then
		echo "Jailbreak not detected."
		sleep 5
		exit 1
	fi
	exec /var/local/mkk/su -c "/bin/sh '$SELF'"
fi

DASH=/mnt/us/agentdash/dash.sh
PIDFILE=/tmp/agentdash.pid

if [ ! -f "$DASH" ] || [ ! -x /mnt/us/libkh/bin/fbink ]; then
	echo "Missing $DASH or FBInk."
	echo "Extract kdash.tgz into /mnt/us again."
	sleep 6
	exit 1
fi
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
	echo "Dashboard is already running."
	sleep 3
	exit 0
fi

echo "Starting dashboard..."
# Detached, so the library launcher neither waits for it nor kills it.
if command -v setsid >/dev/null 2>&1; then
	setsid /bin/sh "$DASH" >/tmp/agentdash.log 2>&1 </dev/null &
else
	nohup /bin/sh "$DASH" >/tmp/agentdash.log 2>&1 </dev/null &
fi
