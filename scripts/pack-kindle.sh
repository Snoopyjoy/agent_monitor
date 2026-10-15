#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist/kdash.tgz"
# Official static ARMv7 build; dash.sh runs its udhcpd to give the Mac an address over the cable.
BUSYBOX_URL=https://busybox.net/downloads/binaries/1.31.0-defconfig-multiarch-musl/busybox-armv7l
BUSYBOX_SHA256=cd04052b8b6885f75f50b2a280bfcbf849d8710c8e61d369c533acf307eda064
BUSYBOX="$ROOT/dist/busybox-armv7l"

mkdir -p "$ROOT/dist"
if ! echo "$BUSYBOX_SHA256  $BUSYBOX" | shasum -a 256 -c --status 2>/dev/null; then
	curl -fsSL -o "$BUSYBOX.part" "$BUSYBOX_URL"
	if ! echo "$BUSYBOX_SHA256  $BUSYBOX.part" | shasum -a 256 -c --status; then
		rm -f "$BUSYBOX.part"
		echo "busybox 校验失败：$BUSYBOX_URL" >&2
		exit 1
	fi
	mv "$BUSYBOX.part" "$BUSYBOX"
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -R "$ROOT/kindle/agentdash" "$ROOT/kindle/documents" "$STAGE/"
cp "$BUSYBOX" "$STAGE/agentdash/busybox"
chmod 755 "$STAGE/agentdash" "$STAGE/documents" "$STAGE/agentdash/dash.sh" "$STAGE/agentdash/busybox" "$STAGE/documents/agent_dash.sh"
cd "$STAGE"
# The Kindle's busybox tar only understands plain ustar, without macOS metadata entries.
COPYFILE_DISABLE=1 tar --format ustar --no-xattrs --no-mac-metadata --uid 0 --gid 0 -czf "$OUT" agentdash documents

echo "已生成 $OUT"
echo "在 Kindle 的 kTerm 里下载后解压到 /mnt/us：cd /mnt/us && tar -xzf kdash.tgz"
