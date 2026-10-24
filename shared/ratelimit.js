/**
 * 滑动窗口限流器（契约 v1.2 §5：30 次/小时/IP，超限 429 + Retry-After）。
 *
 * 设计：工厂函数封装存储（不暴露内部 Map），时钟可注入便于单测；
 * handler 持有模块级单例，测试可注入独立实例避免相互干扰。
 * V1.0 为单实例内存存储（Serverless 冷启动重置属可接受降级，压测验证见 scripts/load-test.mjs）。
 */

export const RATE_LIMIT_MAX = 30;
export const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 小时

/**
 * 创建限流器实例。
 * @param {{ max?: number, windowMs?: number, now?: () => number }} options
 */
export function createRateLimiter({ max = RATE_LIMIT_MAX, windowMs = RATE_LIMIT_WINDOW_MS, now = () => Date.now() } = {}) {
  /** @type {Map<string, number[]>} ip -> 窗口内请求时间戳（升序） */
  const store = new Map();

  return {
    /**
     * 检查并记录一次请求。
     * @param {string} ip
     * @returns {{ allowed: boolean, retryAfterSec: number, remaining: number }}
     */
    check(ip) {
      const key = typeof ip === 'string' && ip.length > 0 ? ip : 'anonymous';
      const t = now();
      const cutoff = t - windowMs;
      const kept = (store.get(key) ?? []).filter((ts) => ts > cutoff);
      if (kept.length >= max) {
        store.set(key, kept);
        const retryAfterSec = Math.max(1, Math.ceil((kept[0] + windowMs - t) / 1000));
        return { allowed: false, retryAfterSec, remaining: 0 };
      }
      kept.push(t);
      store.set(key, kept);
      return { allowed: true, retryAfterSec: 0, remaining: max - kept.length };
    },
    /** 清空全部状态（测试用） */
    reset() {
      store.clear();
    },
  };
}
