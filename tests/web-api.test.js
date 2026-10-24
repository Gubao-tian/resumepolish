import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { rewrite, LIMITS, DEFAULT_TIMEOUT_MS, countChars } from '../src/api.js';

/**
 * 前端 /api/rewrite 客户端契约适配测试（契约 v1.2 冻结版；docs/api-contract.md 为唯一权威）。
 *
 * 覆盖 src/api.js 的四个面：
 * 1. 成功路径：v1.2 四要素结构校验（纵深防御）、mock_mode 归一化、请求体形状与 followups 回传；
 * 2. 错误映射：错误信封优先、HTTP 状态兜底（含 v1.2 新增 502/504）、Retry-After 解析、detail 透传；
 * 3. 结构非法：rewritten/diff/keywords/questions 任一字段不合规 → INVALID_OUTPUT；
 * 4. 客户端异常：网络错误 → NETWORK，超时中止 → ABORTED（前端自有错误码，契约 §4）。
 *
 * src/api.js 以 fetchImpl 注入解耦、无 import.meta 依赖，故可在 Node 下直测，
 * 由 CI 的 `npm test`（node --test）自动发现执行。
 */

const INPUT = {
  experience: '负责 3 个校园渠道的日常运营，每周产出内容',
  jd: '招聘内容运营，要求具备数据分析能力',
};

/** 合法 v1.2 成功响应（mock_mode: true 演示数据形状） */
const GOOD_RESPONSE = Object.freeze({
  mock_mode: true,
  rewritten: '主导 3 个校园渠道的内容运营，搭建可复用的内容生产流程',
  diff: [
    {
      original_segment: '负责 3 个校园渠道',
      revised_segment: '主导 3 个校园渠道的内容运营',
      rationale: '「负责」改为「主导」突出 ownership，并补充运营方法',
    },
  ],
  keywords: [
    { keyword: '内容运营', status: 'hit', source_hint: '原文运营职责' },
    { keyword: '数据分析', status: 'missing', source_hint: '可从渠道周报数据挖掘' },
  ],
  questions: [
    { question: '内容产出频率如何？', blocking: false, reason: 'JD 要求高频更新能力' },
  ],
});

/** 可控 fake fetch：记录调用参数，按配置返回响应或抛错 */
function fakeFetch({ status = 200, payload = GOOD_RESPONSE, headers = {}, reject = null } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    if (reject) throw reject;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name) => headers[name] ?? null },
      json: async () => {
        if (payload instanceof Error) throw payload;
        return payload;
      },
    };
  };
  fn.calls = calls;
  return fn;
}

/** 深拷贝后局部篡改，构造非法成功响应 */
function badResponse(mutate) {
  const clone = structuredClone(GOOD_RESPONSE);
  mutate(clone);
  return clone;
}

describe('rewrite 成功路径（契约 §3）', () => {
  test('200 合法响应通过 v1.2 结构校验，四要素与 mock_mode 透传；请求形状符合契约', async () => {
    const fetchImpl = fakeFetch();
    const r = await rewrite(INPUT, { fetchImpl });

    assert.equal(r.ok, true);
    assert.equal(r.data.mock_mode, true);
    assert.equal(r.data.rewritten, GOOD_RESPONSE.rewritten);
    assert.deepEqual(r.data.diff, GOOD_RESPONSE.diff);
    assert.deepEqual(r.data.keywords, GOOD_RESPONSE.keywords);
    assert.deepEqual(r.data.questions, GOOD_RESPONSE.questions);

    // 请求契约：POST /api/rewrite + JSON 体（experience/jd 必填，契约 §2）
    const call = fetchImpl.calls[0];
    assert.equal(call.url, '/api/rewrite');
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.headers['Content-Type'], 'application/json');
    const body = JSON.parse(call.init.body);
    assert.equal(body.experience, INPUT.experience);
    assert.equal(body.jd, INPUT.jd);
    assert.ok(call.init.signal, '应携带 AbortSignal 以支持 30 秒封顶');

    // 契约 §2 输入上限与前后端一致的 UTF-16 计数口径
    assert.deepEqual(LIMITS, { experience: 300, jd: 2000 });
    assert.equal(countChars('abc'), 3);
    assert.equal(countChars('🙂'), 2, 'UTF-16 码元口径：代理对计 2');
  });

  test('mock_mode 缺省归一化为 false；非布尔值拒绝为 INVALID_OUTPUT', async () => {
    const noField = badResponse((p) => {
      delete p.mock_mode;
    });
    const r1 = await rewrite(INPUT, { fetchImpl: fakeFetch({ payload: noField }) });
    assert.equal(r1.ok, true);
    assert.equal(r1.data.mock_mode, false, '缺省应按非演示数据处理');

    const nonBoolean = badResponse((p) => {
      p.mock_mode = 'true';
    });
    const r2 = await rewrite(INPUT, { fetchImpl: fakeFetch({ payload: nonBoolean }) });
    assert.equal(r2.ok, false);
    assert.equal(r2.error.code, 'INVALID_OUTPUT');
  });

  test('followups 非空原样回传请求体；空数组时省略 followups 字段', async () => {
    const followups = [{ question: '月度预算？', answer: '3 万元' }];
    const withFollowups = fakeFetch();
    await rewrite({ ...INPUT, followups }, { fetchImpl: withFollowups });
    assert.deepEqual(JSON.parse(withFollowups.calls[0].init.body).followups, followups);

    const without = fakeFetch();
    await rewrite({ ...INPUT, followups: [] }, { fetchImpl: without });
    assert.equal('followups' in JSON.parse(without.calls[0].init.body), false);
  });
});

describe('rewrite 错误映射（契约 §4）', () => {
  test('400 → INVALID_INPUT：服务端 message 原样展示，detail.field 透传', async () => {
    const r = await rewrite(INPUT, {
      fetchImpl: fakeFetch({
        status: 400,
        payload: {
          error: {
            code: 'INVALID_INPUT',
            message: 'experience 不能为空',
            detail: { field: 'experience' },
          },
        },
      }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'INVALID_INPUT');
    assert.equal(r.error.message, 'experience 不能为空');
    assert.equal(r.error.detail.field, 'experience');
    assert.equal(r.error.retryAfter, undefined);
  });

  test('429 → RATE_LIMITED：Retry-After 头解析为 retryAfter，message 原样', async () => {
    const r = await rewrite(INPUT, {
      fetchImpl: fakeFetch({
        status: 429,
        headers: { 'Retry-After': '60' },
        payload: { error: { code: 'RATE_LIMITED', message: '请求过于频繁，请 60 秒后重试' } },
      }),
    });
    assert.equal(r.error.code, 'RATE_LIMITED');
    assert.equal(r.error.message, '请求过于频繁，请 60 秒后重试');
    assert.equal(r.error.retryAfter, 60);
  });

  test('502 → UPSTREAM_ERROR（v1.2 新增映射，无错误信封时按状态兜底）', async () => {
    const r = await rewrite(INPUT, { fetchImpl: fakeFetch({ status: 502, payload: null }) });
    assert.equal(r.error.code, 'UPSTREAM_ERROR');
    assert.equal(r.error.message, '模型服务暂时不可用，请稍后重试');
  });

  test('504 → UPSTREAM_TIMEOUT（v1.2 新增映射）', async () => {
    const r = await rewrite(INPUT, { fetchImpl: fakeFetch({ status: 504, payload: null }) });
    assert.equal(r.error.code, 'UPSTREAM_TIMEOUT');
    assert.equal(r.error.message, '模型响应超时，请重试');
  });

  test('500 + 带 code 的错误信封 → 采用服务端 code 与 message', async () => {
    const r = await rewrite(INPUT, {
      fetchImpl: fakeFetch({
        status: 500,
        payload: { error: { code: 'INTERNAL_ERROR', message: '服务开小差了，请稍后重试' } },
      }),
    });
    assert.equal(r.error.code, 'INTERNAL_ERROR');
    assert.equal(r.error.message, '服务开小差了，请稍后重试');
  });

  test('500 无错误信封 → 兜底 INTERNAL_ERROR + 本地兜底文案', async () => {
    const r = await rewrite(INPUT, { fetchImpl: fakeFetch({ status: 500, payload: null }) });
    assert.equal(r.error.code, 'INTERNAL_ERROR');
    assert.equal(r.error.message, '服务开小差了，请稍后重试');
  });

  test('非 JSON 错误体 + 400 → 按 HTTP 状态兜底 INVALID_INPUT', async () => {
    const r = await rewrite(INPUT, {
      fetchImpl: fakeFetch({ status: 400, payload: new SyntaxError('Unexpected token') }),
    });
    assert.equal(r.error.code, 'INVALID_INPUT');
    assert.equal(r.error.message, '输入不合法，请检查后重试');
  });
});

describe('rewrite 响应结构校验失败 → INVALID_OUTPUT', () => {
  test('rewritten 为空串', async () => {
    const r = await rewrite(INPUT, {
      fetchImpl: fakeFetch({ payload: badResponse((p) => { p.rewritten = ''; }) }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'INVALID_OUTPUT');
  });

  test('rewritten 超 300 字（契约 §3 上限）', async () => {
    const r = await rewrite(INPUT, {
      fetchImpl: fakeFetch({ payload: badResponse((p) => { p.rewritten = '描'.repeat(301); }) }),
    });
    assert.equal(r.error.code, 'INVALID_OUTPUT');
  });

  test('diff 缺 rationale（每处修改必带理由，FR-4）', async () => {
    const r = await rewrite(INPUT, {
      fetchImpl: fakeFetch({ payload: badResponse((p) => { delete p.diff[0].rationale; }) }),
    });
    assert.equal(r.error.code, 'INVALID_OUTPUT');
  });

  test('keywords.status 非法值（仅允许 hit/missing）', async () => {
    const r = await rewrite(INPUT, {
      fetchImpl: fakeFetch({ payload: badResponse((p) => { p.keywords[1].status = 'unknown'; }) }),
    });
    assert.equal(r.error.code, 'INVALID_OUTPUT');
  });

  test('questions.blocking 为 true（契约 §3 恒 false，不阻断流程）', async () => {
    const r = await rewrite(INPUT, {
      fetchImpl: fakeFetch({ payload: badResponse((p) => { p.questions[0].blocking = true; }) }),
    });
    assert.equal(r.error.code, 'INVALID_OUTPUT');
  });
});

describe('rewrite 客户端异常（前端自有错误码）', () => {
  test('fetch 抛错（网络异常）→ NETWORK', async () => {
    const r = await rewrite(INPUT, {
      fetchImpl: fakeFetch({ reject: new TypeError('Failed to fetch') }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'NETWORK');
    assert.equal(r.error.message, '网络异常，请检查连接后重试');
  });

  test('AbortError（30 秒封顶触发）→ ABORTED；默认超时为 30000ms', async () => {
    const abortErr = new Error('The operation was aborted');
    abortErr.name = 'AbortError';
    const r = await rewrite(INPUT, { fetchImpl: fakeFetch({ reject: abortErr }) });
    assert.equal(r.error.code, 'ABORTED');
    assert.equal(r.error.message, '等待超过 30 秒，已停止本次请求，请重试');
    assert.equal(DEFAULT_TIMEOUT_MS, 30000);
  });
});
