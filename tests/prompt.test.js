import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMessages, MAX_EXPERIENCE_LEN, MAX_JD_LEN, PLACEHOLDER_TOKEN } from '../shared/prompt.js';
import { NEGATIVE_WORDS } from '../shared/negative-words.js';

const experience = '负责 3 个校园渠道的日常运营，每周产出内容并维护粉丝群';
const jd = '岗位职责：负责内容运营与用户增长，要求具备数据分析能力';

describe('buildMessages', () => {
  test('temperature 固定 0.3（契约 v1.2 §5）', () => {
    const { temperature } = buildMessages({ experience, jd });
    assert.equal(temperature, 0.3);
  });

  test('system 含负面词表/Schema 字段/溯源红线/占位符（三层结构）', () => {
    const { system } = buildMessages({ experience, jd });
    for (const w of ['赋能', '抓手', '闭环', '组合拳', '顶层思维']) {
      assert.ok(system.includes(w), `system 应包含禁用词「${w}」`);
    }
    for (const f of ['rewritten', 'diff', 'original_segment', 'revised_segment', 'rationale', 'keywords', 'status', 'questions', 'blocking']) {
      assert.ok(system.includes(f), `system 应包含字段 ${f}`);
    }
    assert.ok(system.includes(PLACEHOLDER_TOKEN), 'system 应包含占位符');
    assert.ok(system.includes('挖而不编'), 'system 应包含原则声明');
  });

  test('user 含经历原文与 JD，无 followups 时不出现补充区', () => {
    const { user } = buildMessages({ experience, jd });
    assert.ok(user.includes(experience));
    assert.ok(user.includes(jd));
    assert.ok(!user.includes('【用户对反问的补充】'));
  });

  test('followups 正确拼接为问答对', () => {
    const { user } = buildMessages({
      experience,
      jd,
      followups: [
        { question: '月度预算是多少？', answer: '3 万元' },
        { question: '粉丝增长是多少？', answer: '待补充' },
      ],
    });
    assert.ok(user.includes('【用户对反问的补充】'));
    assert.ok(user.includes('月度预算是多少？'));
    assert.ok(user.includes('3 万元'));
    assert.ok(user.includes('粉丝增长是多少？'));
  });

  test('缺省入参与空 followups 不抛错', () => {
    const a = buildMessages();
    assert.ok(a.system.length > 0 && a.user.length > 0 && a.temperature === 0.3);
    const b = buildMessages({ experience, jd, followups: [] });
    assert.ok(!b.user.includes('【用户对反问的补充】'));
  });
});

describe('常量与契约一致', () => {
  test('长度上限/占位符/词表规模', () => {
    assert.equal(MAX_EXPERIENCE_LEN, 300);
    assert.equal(MAX_JD_LEN, 2000);
    assert.equal(PLACEHOLDER_TOKEN, '待补充');
    assert.equal(NEGATIVE_WORDS.length, 25);
    assert.equal(new Set(NEGATIVE_WORDS).size, 25, '词表无重复');
  });
});
