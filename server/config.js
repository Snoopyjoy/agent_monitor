import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = homedir();
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function defaultCursorUserDir() {
  if (platform() === 'darwin') return join(HOME, 'Library', 'Application Support', 'Cursor', 'User');
  if (platform() === 'win32') return join(process.env.APPDATA || join(HOME, 'AppData', 'Roaming'), 'Cursor', 'User');
  return join(process.env.XDG_CONFIG_HOME || join(HOME, '.config'), 'Cursor', 'User');
}

function num(value, fallback) {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(n) ? n : fallback;
}

export const config = {
  root: ROOT,
  publicDir: join(ROOT, 'public'),
  dataDir: join(ROOT, 'data'),
  host: process.env.HOST || '0.0.0.0',
  port: num(process.env.PORT, 7788),
  key: process.env.MONITOR_KEY || '',
  codexHome: process.env.CODEX_HOME || join(HOME, '.codex'),
  cursorHome: process.env.CURSOR_HOME || join(HOME, '.cursor'),
  cursorUserDir: process.env.CURSOR_USER_DIR || defaultCursorUserDir(),
  localPollMs: num(process.env.LOCAL_POLL_MS, 3000),
  remotePollMs: num(process.env.REMOTE_POLL_MS, 60000),
  taskLimit: num(process.env.TASK_LIMIT, 30),
  stalledAfterMs: num(process.env.STALLED_MINUTES, 30) * 60000,
  statsDays: num(process.env.STATS_DAYS, 14),
  defaultRefreshSec: num(process.env.PAGE_REFRESH_SEC, 60),
  refreshChoices: [15, 30, 60, 120, 300],
  // USBNetLite's default address for the Kindle; an empty value makes /screen.png require the key.
  kindleUsbIp: process.env.KINDLE_USB_IP ?? '192.168.15.244',
  chromePath: process.env.CHROME_PATH || '',
  screenSize: { width: 1072, height: 1448, scale: 2 },
};
