import { existsSync } from 'node:fs';
import { errorText } from '../util.js';
import { readClaudeAuth } from './auth.js';
import { fetchClaudeQuota } from './quota.js';
import { ClaudeStats } from './stats.js';

export class ClaudeSource {
  constructor(cfg) {
    this.cfg = cfg;
    this.available = existsSync(cfg.claudeHome);
    this.stats = new ClaudeStats(cfg);
    this.live = null;
    this.liveError = null;
    this.planType = null;
  }

  async refreshRemote() {
    if (!this.available) return;
    try {
      const auth = await readClaudeAuth(this.cfg.claudeHome);
      this.planType = auth.subscriptionType;
      if (!auth.token) {
        this.liveError = 'Claude Code 未登录';
        return;
      }
      if (auth.expiresAt && auth.expiresAt <= Date.now()) {
        this.liveError = 'Claude 登录态已过期，打开 Claude Code 后会自动刷新';
        return;
      }
      this.live = await fetchClaudeQuota(auth.token);
      this.liveError = null;
    } catch (err) {
      this.liveError = errorText(err);
    }
  }

  quota() {
    if (!this.live) {
      return {
        source: 'none',
        windows: [],
        planType: this.planType,
        extra: null,
        error: this.liveError ?? (this.available ? '正在获取额度…' : '未检测到 Claude Code（~/.claude）'),
      };
    }
    return { ...this.live, planType: this.planType, error: this.liveError };
  }
}
