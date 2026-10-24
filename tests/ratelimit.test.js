import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS } from '../shared/ratelimit.js';

describe('createRateLimiter', () => {
  test('窗口内放行、超限返回 429 语义与 Retry-After', () => {
    let t = 1_700_000_000_000;
    const lim = createRateLimiter({ max: 3, windowMs: 60_000, now: () => t });
    assert.equal(lim.check('1.2.3.4').allowed, true);
    t += 1000;
    assert.equal(lim.check('1.2.3.4').allowed, true);
    t += 1000;
    const third = lim.check('1.2.3.4');
    assert.equal(third.allowed, true);
    assert.equal(third.remaining, 0);
    t += 1000;
    const fourth = lim.check('1.2.3.4');
    assert.equal(fourth.allowed, false);
    assert.equal(fourth.remaining, 0);
    // 最早请求在 t0，窗口 60s；当前 t0+3000 → 还需约 57s
    assert.ok(fourth.retryAfterSec >= 56 && fourth.retryAfterSec <= 57, `retryAfterSec=${fourth.retryAfterSec}`);
  });

  test('滑动窗口：旧请求滑出后恢复放行', () => {
    let t = 0;
    const lim = createRateLimiter({ max: 2, windowMs: 1000, now: () => t });
    assert.equal(lim.check('ip').allowed, true);
    t += 500;
    assert.equal(lim.check('ip').allowed, true);
    t += 400;
    assert.equal(lim.check('ip').allowed, false); // t=900，窗口内仍有 2 条
    t += 200; // t=1100，t=0 的请求已滑出（cutoff=100）
    const after = lim.check('ip');
    assert.equal(after.allowed, true);
    assert.equal(after.remaining, 0);
  });

  test('不同 IP 相互隔离', () => {
    let t = 0;
    const lim = createRateLimiter({ max: 1, windowMs: 1000, now: () => t });
    assert.equal(lim.check('a').allowed, true);
    assert.equal(lim.check('a').allowed, false);
    assert.equal(lim.check('b').allowed, true);
  });

  test('reset 清空状态', () => {
    const lim = createRateLimiter({ max: 1, windowMs: 1000, now: () => 0 });
    assert.equal(lim.check('a').allowed, true);
    assert.equal(lim.check('a').allowed, false);
    lim.reset();
    assert.equal(lim.check('a').allowed, true);
  });

  test('常量与契约一致（30 次/小时）', () => {
    assert.equal(RATE_LIMIT_MAX, 30);
    assert.equal(RATE_LIMIT_WINDOW_MS, 60 * 60 * 1000);
  });
});
