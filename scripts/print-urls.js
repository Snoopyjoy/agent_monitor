import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../server/config.js';
import { lanAddresses } from '../server/util.js';

const key = config.key || (await readFile(join(config.dataDir, 'access-key'), 'utf8').catch(() => '')).trim();
const port = config.port;

console.log(`本机：http://127.0.0.1:${port}/`);
const lan = lanAddresses();
for (const { name, address } of lan) {
  const hint = address.startsWith('172.20.10.') ? '，iPhone 热点' : '';
  console.log(`Kindle（${name}${hint}）：http://${address}:${port}/?key=${key}`);
}
if (!lan.length) console.log('当前没有可用的局域网地址');
