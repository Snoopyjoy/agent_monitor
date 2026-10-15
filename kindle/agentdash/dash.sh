#!/bin/sh
# Full-screen Agent monitor dashboard for a jailbroken Kindle on USBNetLite.
# Started in the background by documents/agent_dash.sh. It leaves on a power button press,
# or when the cable is pulled after the Mac has been reached at least once.

DIR=/mnt/us/agentdash
URL="http://192.168.15.201:7788/screen.png"
INTERVAL=30
FLASH_EVERY=10
[ -f "$DIR/config" ] && . "$DIR/config"

FBINK=/mnt/us/libkh/bin/fbink
USBNET=/mnt/us/extensions/usbnetlite/bin/usbnetlite.sh
PIDFILE=/tmp/agentdash.pid
LIPCPID=/tmp/agentdash.lipc.pid
DHCPCONF=/tmp/agentdash.udhcpd.conf
NEW=/tmp/agentdash.new.png
CUR=/tmp/agentdash.png
HOST=${URL#*://}
HOST=${HOST%%/*}
MAC_IP=${HOST%%:*}
MAIN=$$
REASON=
WATCHER=
DHCPD=
FETCH=

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
	echo "already running"
	exit 0
fi
echo $$ >"$PIDFILE"

# The firmware's busybox may not include a DHCP server, so the bundle carries a static one.
if "$DIR/busybox" true 2>/dev/null; then
	UDHCPD="$DIR/busybox udhcpd"
elif command -v udhcpd >/dev/null 2>&1; then
	UDHCPD=udhcpd
else
	UDHCPD=
fi

# FBInk's built-in font only has ASCII glyphs.
say() {
	"$FBINK" -q -m -M -S 3 -y "$1" "$2"
}

show() {
	if [ "$2" = flash ]; then
		"$FBINK" -q -f -W GC16 -g file="$1"
	else
		"$FBINK" -q -W GC16 -g file="$1"
	fi
}

plugged() {
	[ "$(cat "$(kdb get system/driver/usb/SYS_CONNECTED 2>/dev/null)" 2>/dev/null)" = "1" ]
}

usbnet_on() {
	lsmod | grep -q g_ether
}

# A reboot puts the Kindle back in USB drive mode, and USBNetLite only switches while unplugged.
ensure_usbnet() {
	if usbnet_on || plugged || [ ! -f "$USBNET" ]; then
		return
	fi
	echo "$(date '+%F %T') turning USBNet on"
	/bin/sh "$USBNET" toggle_usbnet >/dev/null 2>&1
}

usb_ip() {
	ifconfig usb0 2>/dev/null | sed -n 's/.*inet \(addr:\)\{0,1\}\([0-9.]*\).*/\2/p'
}

# The Mac's USB network port asks for an address over DHCP, so offer it the one in URL.
# No router or DNS option: the Mac keeps using its own network for everything else.
start_dhcp() {
	[ -n "$DHCPD" ] && kill -0 "$DHCPD" 2>/dev/null && return
	DHCPD=
	kip=$(usb_ip)
	if [ -z "$UDHCPD" ] || [ -z "$kip" ] || [ "${kip%.*}" != "${MAC_IP%.*}" ]; then
		return
	fi
	# There is only one address to give. Leases aren't kept, since the Mac's side of the cable can
	# come back with a new MAC address, and a conflict blocks it for 60 s instead of an hour.
	cat >"$DHCPCONF" <<-EOF
		interface usb0
		start $MAC_IP
		end $MAC_IP
		max_leases 1
		option subnet 255.255.255.0
		lease_file /dev/null
		pidfile /tmp/agentdash.udhcpd.pid
		decline_time 60
		conflict_time 60
	EOF
	$UDHCPD -f "$DHCPCONF" &
	DHCPD=$!
	echo "$(date '+%F %T') DHCP: offering $MAC_IP on usb0"
}

# Downloads run in the background: the shell holds signal traps, such as the power button's,
# until a foreground command ends, and a request to a vanished Mac takes the full timeout.
fetch() {
	rm -f "$NEW"
	if command -v curl >/dev/null 2>&1; then
		curl -fsS -m 15 -o "$NEW" "$URL" &
	else
		wget -q -T 15 -O "$NEW" "$URL" &
	fi
	FETCH=$!
	wait "$FETCH" || return 1
	[ "$(dd if="$NEW" bs=1 skip=1 count=3 2>/dev/null)" = "PNG" ]
}

waiting_screen() {
	"$FBINK" -q -f -k
	say -6 "Agent Monitor"
	say -3 "Waiting for the Mac at"
	say -2 "$HOST"
	if usbnet_on; then
		say 1 "Plug the cable into the Mac."
		say 3 "No picture after a minute?"
		say 4 "Unplug the cable and plug it in again."
	elif plugged; then
		say 1 "USBNet is off. Unplug the cable,"
		say 2 "then start the dashboard again."
	else
		say 1 "USBNet is off. Tap the USBNet toggle,"
		say 2 "then start the dashboard again."
	fi
	say 7 "Press the power button to exit"
}

hide_ui() {
	lipc-set-prop com.lab126.powerd preventScreenSaver 1
	[ -f /etc/upstart/statusbar.conf ] && stop statusbar >/dev/null 2>&1
	lipc-set-prop com.lab126.pillow disableEnablePillow disable
	# The window manager drives the framework's own refreshes, such as the status bar clock.
	killall -STOP awesome
}

restore_ui() {
	killall -CONT awesome
	lipc-set-prop com.lab126.pillow disableEnablePillow enable
	[ -f /etc/upstart/statusbar.conf ] && start statusbar >/dev/null 2>&1
	lipc-set-prop com.lab126.powerd preventScreenSaver 0
	# After a power button press the framework is busy drawing the screensaver.
	if [ "$REASON" != power ]; then
		lipc-set-prop com.lab126.appmgrd start app://com.lab126.booklet.home
		/usr/bin/xrefresh -d :0.0 2>/dev/null
	fi
}

watch_power() {
	lipc-wait-event -s 0 com.lab126.powerd goingToScreenSaver >/dev/null 2>&1 &
	echo $! >"$LIPCPID"
	wait $! && kill -USR1 "$MAIN"
}

cleanup() {
	trap - EXIT
	[ -f "$LIPCPID" ] && kill "$(cat "$LIPCPID")" 2>/dev/null
	[ -n "$WATCHER" ] && kill "$WATCHER" 2>/dev/null
	[ -n "$DHCPD" ] && kill "$DHCPD" 2>/dev/null
	[ -n "$FETCH" ] && kill "$FETCH" 2>/dev/null
	restore_ui
	rm -f "$PIDFILE" "$LIPCPID" "$NEW" "$CUR"
	echo "$(date '+%F %T') stopped: ${REASON:-error}"
}

trap cleanup EXIT
trap 'REASON=${REASON:-signal}; exit 0' TERM INT HUP
trap 'REASON=power; exit 0' USR1

echo "$(date '+%F %T') starting, image from $URL"
# Let the library finish redrawing after the scriptlet launcher hands the screen back.
sleep 4
ensure_usbnet
hide_ui
watch_power &
WATCHER=$!
start_dhcp

count=0
reached=0
waiting=0
offline=0
unplugged=0
while :; do
	if fetch; then
		reached=1
		waiting=0
		if [ "$offline" = 1 ] || ! cmp -s "$NEW" "$CUR"; then
			count=$((count + 1))
			if [ "$offline" = 1 ] || [ $(((count - 1) % FLASH_EVERY)) -eq 0 ]; then
				show "$NEW" flash
			else
				show "$NEW"
			fi
			mv -f "$NEW" "$CUR"
			offline=0
		fi
	else
		start_dhcp
		if [ "$reached" = 0 ]; then
			[ "$waiting" = 1 ] || waiting_screen
			waiting=1
		elif [ "$offline" = 0 ]; then
			"$FBINK" -q -h -m -p -S 3 -y -2 "Mac not reachable, retrying"
			offline=1
		fi
	fi

	slept=0
	while [ "$slept" -lt "$INTERVAL" ]; do
		sleep 5 &
		wait $!
		slept=$((slept + 5))
		if [ "$reached" = 1 ] && ! plugged; then
			unplugged=$((unplugged + 1))
			if [ "$unplugged" -ge 2 ]; then
				REASON=unplugged
				exit 0
			fi
		else
			unplugged=0
		fi
		# Until the Mac answers, retry every few seconds so the picture follows the cable quickly.
		if [ "$reached" = 0 ] || [ "$offline" = 1 ]; then
			break
		fi
	done
done
