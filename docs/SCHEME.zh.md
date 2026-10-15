# Agent Monitor：低功耗墨水屏 Agent 用量监控方案

本文是本仓库的完整制作方案（中文），面向想复现或二次开发的人。英文入口见仓库根目录 [README.md](../README.md)。

## 1. 要解决什么问题

在跑 Codex / Cursor 等 Agent 时，需要随时看到：

- Codex 剩余额度、重置时间、近 7 天 token
- Cursor 剩余额度、今日花费、账期预估
- 任务完成 / 中断 / 待确认 / 无响应 / 额度类提醒

目标设备是 **Kindle 一类低功耗电子墨水屏**：不耗电刷网页、不占手机、插上线就能当副屏。同一套服务也提供普通浏览器页面（已按墨水屏对比度优化），可在局域网用访问密钥打开。

**设计约束：**

- 数据只读本机（`~/.codex`、`~/.cursor`），不上传云端
- Kindle 与 Mac **可以不在同一 Wi‑Fi**（公司环境常拦跨设备访问）
- Mac **不必配置固定 IP**（公司 MDM 常禁止）
- Kindle 安装包 **不含访问密钥**，可经公开直链分发

## 2. 整体架构

```text
┌──────────────────────────── Mac ────────────────────────────┐
│  Codex / Cursor 本地文件                                      │
│         │                                                     │
│         ▼                                                     │
│  Node 服务 agent-monitor (:7788)                              │
│    · 轮询本地快照 + 远程额度                                    │
│    · 提醒落盘 data/reminders.json                             │
│    · HTML 页面（浏览器）                                       │
│    · /screen → 墨水屏布局 HTML                                 │
│    · /screen.png ← 无头 Chrome 截图（1072×1448）              │
│    · LaunchAgent com.agent.monitor 常驻                       │
└───────────────┬─────────────────────────────────────────────┘
                │ USB 数据线（USBNetLite：RNDIS/以太网小工具）
                │ Kindle DHCP：把 192.168.15.201 分给 Mac
                ▼
┌──────────────────────────── Kindle ─────────────────────────┐
│  USBNetLite（usb0 = 192.168.15.244）                          │
│  agentdash/dash.sh：curl 取 PNG → FBInk 全屏刷新              │
│  documents/agent_dash.sh：书库入口「看板模式」                  │
└─────────────────────────────────────────────────────────────┘
```

| 角色 | 职责 |
| --- | --- |
| Mac Node 服务 | 聚合用量与提醒；渲染网页与 PNG |
| 无头 Chrome | 把固定尺寸 HTML 打成黑白 PNG |
| USBNetLite | Kindle ↔ Mac 点对点 IP |
| Kindle DHCP（BusyBox `udhcpd`） | 给 Mac 发地址，免静态配置 |
| FBInk | 绕过 Kindle UI，直写帧缓冲 |

## 3. 仓库结构

```text
agent_monitor/
├── server/                 # HTTP 服务与数据源
│   ├── index.js            # 路由、鉴权、轮询
│   ├── auth.js             # 访问密钥 + USB 对端信任
│   ├── config.js           # 端口、路径、KINDLE_USB_IP
│   ├── snapshot.js         # 额度与任务快照
│   ├── reminders.js        # 提醒
│   ├── screen.js           # Chrome 截图
│   ├── codex/ · cursor/    # 本地配额与统计
│   └── views/              # HTML（含 screen.js 墨水屏页）
├── public/                 # 前端静态资源
├── kindle/
│   ├── agentdash/          # dash.sh、config（打包时再嵌入 busybox）
│   └── documents/          # 书库 scriptlet「看板模式」
├── scripts/
│   ├── install-launchagent.sh
│   ├── pack-kindle.sh      # 下载并校验 BusyBox，打 kdash.tgz
│   └── …
├── docs/SCHEME.zh.md       # 本文
└── README.md
```

运行期目录 `data/`（已 gitignore）：访问密钥、提醒、用量缓存、Chrome 截图配置文件。`dist/` 为打包产物。

## 4. Mac 端：监控服务

### 4.1 运行

```bash
# 需 Node.js ≥ 22.13
npm start                 # 前台，默认 0.0.0.0:7788
npm run local             # 仅本机
npm run url               # 打印局域网 URL 与密钥
npm run daemon:install    # LaunchAgent，开机自启
```

默认端口 `7788`。密钥首次启动写入 `data/access-key`（权限 `0600`），也可用环境变量 `MONITOR_KEY`。

### 4.2 数据与刷新

| 周期 | 行为 |
| --- | --- |
| 约 3 s | 读本地任务 / 用量相关文件，重建 snapshot |
| 约 60 s | 拉远程额度（若配置允许） |
| 浏览器页 | 可调自动刷新（15–300 s） |
| Kindle | 默认每 30 s 拉一次 PNG；内容不变则少刷屏 |

### 4.3 墨水屏 PNG

1. `server/views/screen.js` 生成固定 **536×724 CSS 像素**、**deviceScale=2** 的黑白 HTML（物理 **1072×1448**，对齐 Paperwhite 一类分辨率）。
2. `ScreenRenderer` 调用无头 Chrome `--screenshot`；macOS 上 Chrome 写完图后可能不退出，进程在日志出现 `bytes written to file` 后被结束。
3. 相同 HTML 复用缓存；渲染串行，避免抢 profile。
4. 展示内容：Codex / Cursor 剩余额度、最新提醒、近 7 天用量。页脚提示电源键 / 拔线退出。

预览：`http://127.0.0.1:7788/screen.png`（本机可不带密钥）。

### 4.4 鉴权

| 来源 | 规则 |
| --- | --- |
| 本机 loopback 且 Host 为 localhost / 127.0.0.1 | 信任（防 DNS 重绑定） |
| 局域网 | `?key=` 或 Cookie |
| USB Kindle | `remoteAddress === KINDLE_USB_IP`（默认 `192.168.15.244`），且本机 `localAddress` 同 /24 → `/screen.png` 免密钥 |

USB 信任依据：应答只能从这条 USB 网口出去，同网段伪造握手在链路上不可达。将 `KINDLE_USB_IP` 置空可关闭免密钥。

## 5. Kindle 端：全屏看板

### 5.1 硬件与前置（实测参考）

| 项 | 参考值 |
| --- | --- |
| 设备 | Kindle Paperwhite 第 10 代（PW4） |
| 固件 | 5.18.1.x（需确认当前越狱链是否仍支持） |
| 越狱 | 社区方案（如 SpiderCat / hdnext 一类入口；**以当时上游说明为准**） |
| 网络 | [USBNetLite](https://github.com/notmarek/kindle-usbnetlite)（或同源维护分支） |
| 显示 | [FBInk](https://github.com/NiLuJe/FBInk)（经 KPM / libkh 等路径安装） |
| 线缆 | **能传数据** 的 USB 线（仅充电线无效） |
| 入口 | 书库 scriptlet（部分固件上 KUAL 不可用） |

**警告：** 越狱会使保修与 ToS 风险自负；勿恢复出厂或装官方 OTA（许多越狱会禁用 `otaupd`）；公司电脑若禁止挂载 U 盘，文件请改走 Wi‑Fi 下载 / 其它机器拷贝。

### 5.2 默认地址与「免固定 IP」

USBNetLite 常见默认：

- Kindle：`192.168.15.244`
- 期望 Mac：`192.168.15.201/24`

本方案在看板进程里起 **`udhcpd`**（优先用打包进 `agentdash/busybox` 的静态 ARM 二进制），在 `usb0` 上只租出 `config` 里 URL 主机对应的那一个地址，**不发 gateway / DNS**，Mac 上网仍走 Wi‑Fi。

因此 Mac 侧网口保持「DHCP」即可，无需管理员改静态 IP。

### 5.3 安装包

```bash
npm run kindle:pack   # → dist/kdash.tgz
```

打包脚本会：

1. 从 busybox.net 下载官方 `busybox-armv7l`（1.31.0 musl），校验 SHA-256  
2. 打成 Kindle busybox tar 能认的 **ustar**，去掉 macOS xattr / AppleDouble  
3. **不包含** `data/access-key`

Kindle 上（kTerm 等）：

```sh
cd /mnt/us
curl -L -o kdash.tgz '<直链>'
tar -xzf kdash.tgz
```

### 5.4 安全：关掉 Wi‑Fi 上的 SSH

USBNetLite 默认常开密码登录，且 `USE_WIFI="true"` 时会在无线侧暴露 root。建议：

```sh
cd /mnt/us/usbnetlite/etc
# 若打坏配置，可先：cp config.default config
sed -i 's/^USE_WIFI=.*/USE_WIFI="false"/' config
grep USE_WIFI config   # 应为 USE_WIFI="false"
```

**不插线**时点一次「USBNet 开关」使配置生效。后续应改为密钥登录并关闭默认密码。

### 5.5 看板行为（`kindle/agentdash/dash.sh`）

| 行为 | 说明 |
| --- | --- |
| 启动 | 未插线且 USBNet 关 → 自动 `toggle_usbnet`；插着线无法切换，屏幕提示先拔线 |
| DHCP | USBNet 起来后提供 `192.168.15.201` |
| 取图 | `curl`/`wget` 拉 `URL`；校验 PNG 头；后台下载以便电源键不被超时卡住 |
| 刷新 | 内容变化才重绘；每 `FLASH_EVERY` 次全刷去残影 |
| 未连通 | 等待页（ASCII，因 FBInk 内置字库无 CJK） |
| 退出 | 电源键（`goingToScreenSaver`）；曾连通后连续检测到拔线 |
| 恢复 UI | `CONT awesome`、开 pillow、状态栏；非电源退出时回主页并 `xrefresh` |

可改 `kindle/agentdash/config`：`URL`、`INTERVAL`、`FLASH_EVERY`。

### 5.6 日常用法

1. **不必每次点 USBNet 开关**：看板会在未插线时自行打开（重启后也会从 U 盘模式回到网络模式）。  
2. 未插线点「看板模式」→ 出现 Plug the cable… → 插线 → 约十余秒出图。  
3. 先插线再点看板：若一分钟无图，拔掉重插一次（部分 Mac 需重新 DHCP）。  
4. 仅当需要当 U 盘、或让 `USE_WIFI` 改动生效时，才手动点开关（须不插线）。

## 6. 端到端联调清单

**Mac**

- [ ] `npm start` 或 daemon 已起，`curl -sI http://127.0.0.1:7788/screen.png` → 200  
- [ ] 局域网无密钥 → 401；带密钥 → 200  
- [ ] Chrome / Chromium / Edge 可用，或设置 `CHROME_PATH`

**Kindle**

- [ ] `;log` / KPM 一类入口正常，FBInk 路径存在（常见 `/mnt/us/libkh/bin/fbink`）  
- [ ] USBNetLite 已装；`USE_WIFI="false"`  
- [ ] `kdash.tgz` 已解压，书库有「看板模式」  
- [ ] 数据线上：Mac 出现 USB 网卡并拿到 `192.168.15.201`  
- [ ] Kindle 能 `curl http://192.168.15.201:7788/screen.png` 得到 PNG  

**异常**

| 现象 | 排查 |
| --- | --- |
| 只充电无网卡 | 换能传数据的线；确认 USBNet ON（`lsmod \| grep g_ether`） |
| Mac 无 192.168.15.201 | 看板是否已起 DHCP；拔插线；公司 802.1X 是否卡住有线口（多数无认证服务器时仍可 DHCP） |
| 有地址无图 | Mac 防火墙 / 服务未监听 `0.0.0.0`；Kindle IP 是否仍是 `.244` |
| 电源键无反应 | 长按约 40 s 强制重启；脚本改动均为临时，重启可恢复 |

## 7. 环境变量摘要

| 变量 | 含义 | 默认 |
| --- | --- | --- |
| `PORT` / `HOST` | 监听 | `7788` / `0.0.0.0` |
| `MONITOR_KEY` | 访问密钥 | 自动生成到 `data/access-key` |
| `KINDLE_USB_IP` | USB 免密钥对端 | `192.168.15.244` |
| `CHROME_PATH` | 截图浏览器 | 自动探测 |
| `CODEX_HOME` / `CURSOR_HOME` / `CURSOR_USER_DIR` | 数据根目录 | 各平台默认 |
| `LOCAL_POLL_MS` / `REMOTE_POLL_MS` | 轮询间隔 | 3000 / 60000 |

## 8. 开源与合规说明

| 内容 | 状态 |
| --- | --- |
| 本仓库 Node 服务与 Kindle shell | MIT（见 [LICENSE](../LICENSE)） |
| USBNetLite / FBInk / 越狱工具 | **不随仓库分发**；请从上游获取并遵守其许可与设备条款 |
| BusyBox 静态包 | `kindle:pack` 时下载，SHA-256 钉死；遵循 BusyBox 许可 |
| `data/`、密钥、Cookie、个人用量 | **不得**提交公开仓库 |
| 公司内网 / MDM / 802.1X | 仅作部署提示；本方案不提供绕过 MDM 的方法 |

建议公开发布前自检：`git status` 无 `data/`；`kdash.tgz` 内无密钥；README / 本文不写内网主机名与真实密钥。

## 9. 可扩展方向

- 其它分辨率：改 `config.screenSize` 与 `views/screen.js` 布局  
- 其它数据源：在 `snapshot` 侧增加字段，并改 screen 模板  
- 非 Kindle 墨水屏：保留 `/screen.png`，换设备侧取图与刷屏程序  
- Linux 宿主：LaunchAgent 换成 systemd；Chrome 路径用 `CHROME_PATH`

## 10. 关键文件索引

| 文件 | 作用 |
| --- | --- |
| [server/index.js](../server/index.js) | 路由与生命周期 |
| [server/auth.js](../server/auth.js) | 密钥与 USB 对端 |
| [server/screen.js](../server/screen.js) | Chrome 截图 |
| [server/views/screen.js](../server/views/screen.js) | 墨水屏 HTML |
| [kindle/agentdash/dash.sh](../kindle/agentdash/dash.sh) | Kindle 主循环 |
| [scripts/pack-kindle.sh](../scripts/pack-kindle.sh) | 打包与 BusyBox 校验 |
| [scripts/install-launchagent.sh](../scripts/install-launchagent.sh) | macOS 常驻 |
