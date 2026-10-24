import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeFollowups } from '../src/followups.js';

/**
 * 多轮回答累积合并单测（契约 §2 全量累积；FR-6）。
 *
 * 覆盖四条语义：新增问题追加、同问题后来覆盖、首次出现顺序保持、纯函数不修改入参。
 * src/followups.js 无 React 与 import.meta 依赖，故可在 Node 下直测（ADR-1 v1 单运行器）。
 */

const Q1 = { question: '这段经历带来的可量化结果是多少？', answer: '3 万阅读量' };
const Q2 = { question: '团队规模？', answer: '5 人' };

describe('mergeFollowups 语义', () => {
  test('新问题追加到末尾，保留首次出现顺序', () => {
    const r = mergeFollowups([Q1], [Q2]);
    assert.deepEqual(r, [Q1, Q2]);
  });

  test('同一 question 以后来回答覆盖，位置不变且不重复', () => {
    const updated = { question: Q1.question, answer: '12 万阅读量' };
    const r = mergeFollowups([Q1, Q2], [updated]);
    assert.deepEqual(r, [updated, Q2]);
    assert.equal(r.length, 2, '同问题不得产生重复项');
  });

  test('incoming 为空时返回历史副本；prev 为空时等于 incoming 副本', () => {
    assert.deepEqual(mergeFollowups([Q1], []), [Q1]);
    assert.deepEqual(mergeFollowups([], [Q2]), [Q2]);
    assert.deepEqual(mergeFollowups([], []), []);
  });

  test('纯函数：不修改入参数组，返回新引用', () => {
    const prev = [Q1];
    const incoming = [Q2];
    const r = mergeFollowups(prev, incoming);
    assert.deepEqual(prev, [Q1], 'prev 未被修改');
    assert.deepEqual(incoming, [Q2], 'incoming 未被修改');
    assert.notEqual(r, prev);
    assert.notEqual(r[0], prev[0], '元素为浅拷贝，避免共享引用被下游改写');
  });

  test('多轮累积复合场景：三问中改一问加一问', () => {
    const q3 = { question: '投放预算？', answer: '2 万元' };
    const updated2 = { question: Q2.question, answer: '8 人' };
    const r = mergeFollowups([Q1, Q2], [updated2, q3]);
    assert.deepEqual(r, [Q1, updated2, q3]);
  });
});
