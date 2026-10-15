# agent-monitor

Local dashboard for **Codex** and **Cursor** remaining quota, recent token spend, and task reminders — plus an optional **Kindle e-ink** full-screen view over a USB cable.

No cloud account. Credentials stay on your machine. The web UI is tuned for e-ink browsers; the Kindle path renders a black-and-white PNG and paints it with [FBInk](https://github.com/NiLuJe/FBInk).

> **Chinese architecture & HOW-TO:** [docs/SCHEME.zh.md](docs/SCHEME.zh.md)

## Features

- Live Codex / Cursor quota, 7-day usage, and reminder list
- Access key for LAN; loopback and USB-cable Kindle can skip the key
- macOS LaunchAgent (`com.agent.monitor`) on port `7788`
- Kindle dashboard: poll `/screen.png`, DHCP to the Mac (no static IP on the host), power-button / unplug to exit

## Requirements

| Piece | Need |
| --- | --- |
| Host | macOS (LaunchAgent + Chrome screenshot path), Node.js ≥ 22.13 |
| Browser screenshot | Chrome, Chromium, or Edge (or `CHROME_PATH`) |
| Local data | Codex under `~/.codex`, Cursor under `~/.cursor` / Application Support |
| Kindle (optional) | Jailbroken Paperwhite-class device, USBNetLite, FBInk, data-capable USB cable |

Jailbreaking and USB networking are third-party; this repo does not ship Kindle firmware hacks. See the Chinese scheme for tested versions and upstream links.

## Quick start (Mac)

```bash
git clone <your-fork-or-url> agent_monitor
cd agent_monitor
npm start                 # http://127.0.0.1:7788
npm run url               # print LAN URL + access key
npm run daemon:install    # keep running in the background
```

Data and the access key live under `data/` (gitignored). Preview the e-ink frame at `http://127.0.0.1:7788/screen.png`.

## Kindle (USB)

1. Jailbreak and install USBNetLite + FBInk (see [docs/SCHEME.zh.md](docs/SCHEME.zh.md)).
2. On the Mac: `npm run kindle:pack` → `dist/kdash.tgz` (includes a pinned static BusyBox for `udhcpd`; **no access key**).
3. Copy the archive onto the Kindle, extract into `/mnt/us`.
4. Harden USBNetLite: set `USE_WIFI="false"` in `/mnt/us/usbnetlite/etc/config`, then toggle USBNet once while **unplugged**.
5. Unplugged → tap **看板模式** (dashboard). Plug the cable; the Kindle offers `192.168.15.201` over DHCP. No Mac static IP required.
6. Power button exits; after the Mac has been reached once, unplugging exits too.

Default USBNetLite addresses: Kindle `192.168.15.244`, Mac `192.168.15.201`. Override with `KINDLE_USB_IP` / `kindle/agentdash/config`.

## Architecture (short)

```text
Codex / Cursor local files ──► Node server (snapshot + reminders)
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
              HTML pages      /screen HTML     /screen.png
              (browser)       (layout)         (headless Chrome)
                                                    │
                                          USBNet + DHCP on Kindle
                                                    ▼
                                               FBInk full screen
```

## Security

- Do not commit `data/` (access key, caches, Chrome profile).
- LAN clients need `?key=` or the cookie; USB peer trust is address-based on the cable subnet only.
- Change or disable USBNetLite’s default SSH password; prefer key-only and `USE_WIFI="false"`.
- Jailbreaking voids warranties and may violate terms of service — your responsibility.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm start` / `npm run dev` | Foreground server / watch mode |
| `npm run local` | Bind `127.0.0.1` only |
| `npm run daemon:install` | LaunchAgent |
| `npm run kindle:pack` | Build `dist/kdash.tgz` |

## License

MIT — see [LICENSE](LICENSE). Third-party Kindle tools (USBNetLite, FBInk, BusyBox binaries) keep their own licenses; BusyBox is downloaded at pack time from busybox.net with a pinned SHA-256.
