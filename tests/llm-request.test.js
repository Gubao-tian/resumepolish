import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUpstreamRequest, thinkingParam } from '../api/rewrite.js';

/**
 * 上游 LLM 请求体构造单测（真实调用分支；此前仅有 Mock 分支覆盖）。
 *
 * 背景：本次修复前，真实分支的默认值存在两处与官方事实不符（见 docs/llm-selection.md 裁决 #18/#19）：
 *  1. 默认模型名 deepseek-v4-flash 已被官方标注为退役 legacy name，现行 ID 应为 deepseek-flash；
 *  2. 未下发 thinking 参数 → DeepSeek 默认 thinking=enabled，而官方明确该模式下 temperature 无效
 *     （不报错但无效果），使契约 §5 冻结的 temperature=0.3 静默失效。
 * 本文件锁定这些默认值，防止回归。
 *
 * 所有用例通过注入 env 对象断言，不读写真实 process.env，避免相互污染。
 */

const DEEPSEEK = 'https://api.deepseek.com/v1';
const GLM = 'https://open.bigmodel.cn/api/paas/v4';
const MESSAGES = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: '【经历原文】\n负责公众号运营' },
];

describe('buildUpstreamRequest 默认值', () => {
  test('默认模型为 deepseek-flash（不是已退役的 deepseek-v4-flash）', () => {
    const body = buildUpstreamRequest({ base: DEEPSEEK, messages: MESSAGES, env: {} });
    assert.equal(body.model, 'deepseek-flash');
    assert.notEqual(body.model, 'deepseek-v4-flash', '不得回退到官方已标注退役的 legacy name');
  });

  test('LLM_MODEL 可覆盖默认模型', () => {
    const body = buildUpstreamRequest({
      base: DEEPSEEK,
      messages: MESSAGES,
      env: { LLM_MODEL: 'deepseek-v4-pro' },
    });
    assert.equal(body.model, 'deepseek-v4-pro');
  });

  test('temperature 恒为 0.3（契约 §5 冻结值）', () => {
    const body = buildUpstreamRequest({ base: DEEPSEEK, messages: MESSAGES, env: {} });
    assert.equal(body.temperature, 0.3);
  });

  test('response_format 恒为 json_object（提升 JSON 首 Try 合法率）', () => {
    const body = buildUpstreamRequest({ base: DEEPSEEK, messages: MESSAGES, env: {} });
    assert.deepEqual(body.response_format, { type: 'json_object' });
  });

  test('messages 原样透传，不被改写或包裹', () => {
    const body = buildUpstreamRequest({ base: DEEPSEEK, messages: MESSAGES, env: {} });
    assert.deepEqual(body.messages, MESSAGES);
  });

  test('注入 env 不污染 process.env（纯函数语义）', () => {
    const before = { ...process.env };
    buildUpstreamRequest({ base: DEEPSEEK, messages: MESSAGES, env: { LLM_MODEL: 'injected-model' } });
    assert.equal(process.env.LLM_MODEL, before.LLM_MODEL);
  });
});

describe('thinking 参数（DeepSeek 专有，ADR-2 可替换性）', () => {
  test('DeepSeek 端点默认下发 thinking=disabled，使 temperature 真正生效', () => {
    const body = buildUpstreamRequest({ base: DEEPSEEK, messages: MESSAGES, env: {} });
    assert.deepEqual(body.thinking, { type: 'disabled' });
  });

  test('LLM_THINKING=enabled 时下发 enabled（供 T9 A/B 实测对比）', () => {
    const body = buildUpstreamRequest({
      base: DEEPSEEK,
      messages: MESSAGES,
      env: { LLM_THINKING: 'enabled' },
    });
    assert.deepEqual(body.thinking, { type: 'enabled' });
  });

  test('LLM_THINKING 大小写不敏感', () => {
    const body = buildUpstreamRequest({
      base: DEEPSEEK,
      messages: MESSAGES,
      env: { LLM_THINKING: 'ENABLED' },
    });
    assert.deepEqual(body.thinking, { type: 'enabled' });
  });

  test('LLM_THINKING 为任意其他值时回落 disabled（默认值安全）', () => {
    for (const v of ['', 'on', 'true', '1', 'garbage']) {
      const body = buildUpstreamRequest({ base: DEEPSEEK, messages: MESSAGES, env: { LLM_THINKING: v } });
      assert.deepEqual(body.thinking, { type: 'disabled' }, `LLM_THINKING=${JSON.stringify(v)} 应回落 disabled`);
    }
  });

  test('非 DeepSeek 端点不下发 thinking（保持 OpenAI 兼容可替换性）', () => {
    for (const base of [GLM, 'https://api.openai.com/v1', 'http://127.0.0.1:8899/v1', '']) {
      const body = buildUpstreamRequest({ base, messages: MESSAGES, env: {} });
      assert.equal('thinking' in body, false, `${base} 不应携带 thinking 字段`);
    }
  });

  test('thinkingParam 对 DeepSeek 各类写法均识别（大小写与端口无关）', () => {
    for (const base of [DEEPSEEK, 'https://api.DeepSeek.com/v1', 'http://127.0.0.1:8787/deepseek-proxy']) {
      assert.notEqual(thinkingParam(base, {}), null, `${base} 应识别为 DeepSeek 端点`);
    }
  });

  test('thinkingParam 对非 DeepSeek 返回 null', () => {
    assert.equal(thinkingParam(GLM, {}), null);
    assert.equal(thinkingParam('', {}), null);
  });
});
