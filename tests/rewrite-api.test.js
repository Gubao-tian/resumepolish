import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { handleRewriteRequest } from '../api/rewrite.js';
import { server } from '../server/dev-server.js';
import { createRateLimiter } from '../shared/ratelimit.js';

const VALID_BODY = {
  experience: '负责 3 个校园渠道的日常运营，每周产出内容',
  jd: '招聘内容运营，要求具备数据分析能力',
};

const GOOD_OUTPUT = JSON.stringify({
  rewritten: '主导 3 个校园渠道的内容运营，形成可复用的内容生产流程',
  diff: [
    {
      original_segment: '负责 3 个校园渠道',
      revised_segment: '主导 3 个校园渠道的内容运营',
      rationale: '「负责」改为「主导」突出 ownership，并补充运营方法',
    },
  ],
  keywords: [{ keyword: '内容运营', status: 'hit', source_hint: '原文运营职责' }],
  questions: [],
});

/** 可控 fake LLM：按调用次数返回不同内容；字符串返回值自动包装为 {content, usage} */
function fakeLLM(returns) {
  let calls = 0;
  const fn = async () => {
    calls += 1;
    const value = typeof returns === 'function' ? returns(calls) : returns;
    return typeof value === 'string' ? { content: value, usage: null } : value;
  };
  fn.callCount = () => calls;
  return fn;
}

before(() => {
  process.env.LLM_API_KEY = 'test-key-not-real'; // 强制非 Mock 模式，便于注入 fake
  delete process.env.MOCK;
});

after(() => {
  delete process.env.LLM_API_KEY;
  delete process.env.MOCK;
});

describe('handleRewriteRequest 成功路径', () => {
  test('合法输入返回 200 四要素与隐私响应头', async () => {
    const r = await handleRewriteRequest({ body: VALID_BODY, callLLM: fakeLLM(GOOD_OUTPUT) });
    assert.equal(r.status, 200);
    assert.equal(r.headers['Cache-Control'], 'no-store');
    assert.equal(r.headers['X-Content-Storage'], 'none');
    assert.equal(r.body.mock_mode, false);
    assert.equal(typeof r.body.rewritten, 'string');
    assert.ok(Array.isArray(r.body.diff) && r.body.diff.length === 1);
    assert.ok(Array.isArray(r.body.keywords));
    assert.ok(Array.isArray(r.body.questions));
  });

  test('关键词未命中由服务端降级为 missing', async () => {
    const output = JSON.stringify({
      rewritten: '主导 3 个校园渠道的日常运营',
      diff: [{ original_segment: '负责 3 个校园渠道', revised_segment: '主导 3 个校园渠道的日常运营', rationale: '突出 ownership' }],
      keywords: [{ keyword: '用户增长', status: 'hit', source_hint: '可从粉丝群挖掘' }],
      questions: [],
    });
    const r = await handleRewriteRequest({ body: VALID_BODY, callLLM: fakeLLM(output) });
    assert.equal(r.status, 200);
    assert.equal(r.body.keywords[0].status, 'missing');
  });

  test('结构损坏首次 + 合法第二次 → 重试一次后 200', async () => {
    const llm = fakeLLM((n) => (n === 1 ? '这不是 JSON' : GOOD_OUTPUT));
    const r = await handleRewriteRequest({ body: VALID_BODY, callLLM: llm });
    assert.equal(r.status, 200);
    assert.equal(llm.callCount(), 2);
  });

  test('容忍 Markdown 代码块包裹的 JSON', async () => {
    const r = await handleRewriteRequest({ body: VALID_BODY, callLLM: fakeLLM(`\`\`\`json\n${GOOD_OUTPUT}\n\`\`\``) });
    assert.equal(r.status, 200);
  });

  test('followups 全量累积进入请求消息', async () => {
    /** @type {Array<Array<{role:string,content:string}>>} */
    const seen = [];
    const llm = async (messages) => {
      seen.push(messages);
      return { content: GOOD_OUTPUT, usage: null };
    };
    const body = { ...VALID_BODY, followups: [{ question: '月度预算？', answer: '3 万元' }] };
    const r = await handleRewriteRequest({ body, callLLM: llm });
    assert.equal(r.status, 200);
    const userMsg = seen[0].find((m) => m.role === 'user');
    assert.ok(userMsg.content.includes('月度预算？'), 'user 消息应包含追问');
    assert.ok(userMsg.content.includes('3 万元'), 'user 消息应包含补充回答');
  });
});

describe('handleRewriteRequest 输入错误（400）', () => {
  test('experience 为空', async () => {
    const r = await handleRewriteRequest({ body: { ...VALID_BODY, experience: '' }, callLLM: fakeLLM(GOOD_OUTPUT) });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'INVALID_INPUT');
    assert.equal(r.body.error.detail.field, 'experience');
  });

  test('jd 缺失', async () => {
    const r = await handleRewriteRequest({ body: { experience: VALID_BODY.experience }, callLLM: fakeLLM(GOOD_OUTPUT) });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.detail.field, 'jd');
  });

  test('experience 超 300 字', async () => {
    const r = await handleRewriteRequest({
      body: { experience: '经'.repeat(301), jd: VALID_BODY.jd },
      callLLM: fakeLLM(GOOD_OUTPUT),
    });
    assert.equal(r.status, 400);
    assert.match(r.body.error.message, /300/);
  });

  test('jd 超 2000 字（与 experience 对偶的边界锁定，前端 LIMITS.jd 依赖）', async () => {
    const r = await handleRewriteRequest({
      body: { experience: VALID_BODY.experience, jd: '职'.repeat(2001) },
      callLLM: fakeLLM(GOOD_OUTPUT),
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'INVALID_INPUT');
    assert.equal(r.body.error.detail.field, 'jd');
    assert.match(r.body.error.message, /2000/);
  });
});

describe('handleRewriteRequest 限流（429）', () => {
  test('同 IP 超限返回 429 与 Retry-After', async () => {
    const limiter = createRateLimiter({ max: 2, windowMs: 60_000 });
    const opts = { body: VALID_BODY, callLLM: fakeLLM(GOOD_OUTPUT), limiter, ip: '9.9.9.9' };
    assert.equal((await handleRewriteRequest(opts)).status, 200);
    assert.equal((await handleRewriteRequest(opts)).status, 200);
    const third = await handleRewriteRequest(opts);
    assert.equal(third.status, 429);
    assert.equal(third.body.error.code, 'RATE_LIMITED');
    assert.ok(Number(third.headers['Retry-After']) >= 1);
  });

  // Issue #24：限流按 IP 计数，而校园网/公司网等 NAT 出口下同一 IP 由多人共用，
  // 用户可能一次都没提交过却看到「请求过于频繁」。文案必须说明真实原因，否则会被误认为产品故障。
  test('429 文案说明额度按网络出口统计（避免 NAT 共用出口用户误判为故障）', async () => {
    const limiter = createRateLimiter({ max: 1, windowMs: 60_000 });
    const opts = { body: VALID_BODY, callLLM: fakeLLM(GOOD_OUTPUT), limiter, ip: '8.8.8.8' };
    await handleRewriteRequest(opts);
    const limited = await handleRewriteRequest(opts);
    assert.equal(limited.status, 429);
    assert.match(limited.body.error.message, /网络出口/, '应说明额度按网络出口统计');
    assert.match(limited.body.error.message, /合并计算/, '应说明会与同网用户合并计算');
    assert.match(limited.body.error.message, /\d+ 秒后再试/, '仍须给出可操作的等待时长');
  });
});

describe('handleRewriteRequest 上游错误（502/504）', () => {
  test('超时 → 504 UPSTREAM_TIMEOUT', async () => {
    const llm = async () => {
      const err = new Error('timeout');
      err.code = 'UPSTREAM_TIMEOUT';
      throw err;
    };
    const r = await handleRewriteRequest({ body: VALID_BODY, callLLM: llm });
    assert.equal(r.status, 504);
    assert.equal(r.body.error.code, 'UPSTREAM_TIMEOUT');
  });

  test('上游非 2xx → 502 UPSTREAM_ERROR（不重试）', async () => {
    const llm = async () => {
      const err = new Error('upstream status 401');
      err.code = 'UPSTREAM_ERROR';
      throw err;
    };
    const r = await handleRewriteRequest({ body: VALID_BODY, callLLM: llm });
    assert.equal(r.status, 502);
    assert.equal(r.body.error.code, 'UPSTREAM_ERROR');
  });
});

describe('handleRewriteRequest 输出校验失败（500 INVALID_OUTPUT）', () => {
  test('持续非法 → 恰好重试一次后 500', async () => {
    const llm = fakeLLM('{"rewritten": "主导 10 个渠道"}'); // 缺字段且数字无法溯源
    const r = await handleRewriteRequest({ body: VALID_BODY, callLLM: llm });
    assert.equal(r.status, 500);
    assert.equal(r.body.error.code, 'INVALID_OUTPUT');
    assert.equal(llm.callCount(), 2);
  });

  test('负面词命中 → 500', async () => {
    const output = JSON.stringify({
      rewritten: '主导 3 个校园渠道的内容运营，全面赋能生产链路',
      diff: [{ original_segment: '负责 3 个校园渠道', revised_segment: '主导 3 个校园渠道', rationale: '突出 ownership' }],
      keywords: [],
      questions: [],
    });
    const r = await handleRewriteRequest({ body: VALID_BODY, callLLM: fakeLLM(output) });
    assert.equal(r.status, 500);
    assert.equal(r.body.error.code, 'INVALID_OUTPUT');
  });
});

describe('handleRewriteRequest 方法与 Mock 模式', () => {
  test('非 POST → 405', async () => {
    const r = await handleRewriteRequest({ method: 'GET', body: VALID_BODY, callLLM: fakeLLM(GOOD_OUTPUT) });
    assert.equal(r.status, 405);
  });

  test('MOCK=1 且无 Key → mock_mode=true 的确定性 200', async () => {
    const savedKey = process.env.LLM_API_KEY;
    delete process.env.LLM_API_KEY;
    process.env.MOCK = '1';
    try {
      const r1 = await handleRewriteRequest({ body: VALID_BODY });
      const r2 = await handleRewriteRequest({ body: VALID_BODY });
      assert.equal(r1.status, 200);
      assert.equal(r1.body.mock_mode, true);
      assert.deepEqual(r1.body, r2.body); // 同输入同输出（ADR-3）
    } finally {
      process.env.LLM_API_KEY = savedKey;
      delete process.env.MOCK;
    }
  });
});

describe('dev-server HTTP 冒烟（tech-design T7）', () => {
  test('GET /api/health 与 POST /api/rewrite（Mock 模式全链路）', async () => {
    const savedKey = process.env.LLM_API_KEY;
    delete process.env.LLM_API_KEY;
    process.env.MOCK = '1';
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
      const health = await fetch(`http://127.0.0.1:${port}/api/health`);
      assert.equal(health.status, 200);
      const healthBody = await health.json();
      assert.equal(healthBody.status, 'ok');
      assert.equal(healthBody.mock, true);

      const res = await fetch(`http://127.0.0.1:${port}/api/rewrite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_BODY),
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.equal(res.headers.get('x-content-storage'), 'none');
      const body = await res.json();
      assert.equal(body.mock_mode, true);
      assert.equal(typeof body.rewritten, 'string');
      assert.ok(Array.isArray(body.diff) && body.diff.length >= 1);

      const bad = await fetch(`http://127.0.0.1:${port}/api/rewrite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ experience: '', jd: 'x' }),
      });
      assert.equal(bad.status, 400);
      assert.equal((await bad.json()).error.code, 'INVALID_INPUT');
    } finally {
      process.env.LLM_API_KEY = savedKey;
      delete process.env.MOCK;
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
