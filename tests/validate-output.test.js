import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { validateOutput } from '../shared/validate.js';
import { NEGATIVE_WORDS } from '../shared/negative-words.js';

const SOURCES = {
  experience: '负责 3 个校园渠道的日常运营，每周产出内容并维护粉丝群',
  followupText: '',
};

/** 基准合法输出（四要素齐全，数字可溯源，无禁用词） */
function base() {
  return {
    rewritten: '主导 3 个校园渠道的内容运营，搭建选题模板，形成可复用的内容生产流程',
    diff: [
      {
        original_segment: '负责 3 个校园渠道的日常运营',
        revised_segment: '主导 3 个校园渠道的内容运营',
        rationale: '「负责」改为「主导」突出 ownership，并补充运营方法',
      },
    ],
    keywords: [
      { keyword: '内容运营', status: 'hit', source_hint: '校园渠道经历可直接对应' },
      { keyword: '数据分析', status: 'missing', source_hint: '可从周报数据挖掘' },
    ],
    questions: [
      { question: '内容生产带来的粉丝增长具体是多少？', blocking: false, reason: '缺少量化结果，影响成果表达' },
    ],
  };
}

/** 最小输出（diff 不含数字，便于数字溯源用例精确控制变量） */
function minimal(rewritten, originalSegment) {
  return {
    rewritten,
    diff: [{ original_segment: originalSegment, revised_segment: '对应改写片段', rationale: '补充方法说明' }],
    keywords: [],
    questions: [],
  };
}

describe('validateOutput 合法输出', () => {
  test('完整四要素通过', () => {
    const r = validateOutput(base(), SOURCES);
    assert.equal(r.ok, true);
  });

  test('mock_mode 可选注入', () => {
    const parsed = base();
    parsed.mock_mode = true;
    const r = validateOutput(parsed, SOURCES);
    assert.equal(r.ok, true);
  });
});

describe('数字溯源（一票否决，契约 §6 第 4 道）', () => {
  test('拦截：改写中出现原文没有的数字', () => {
    const parsed = base();
    parsed.rewritten = '主导 10 个校园渠道的内容运营，覆盖 5000 名学生';
    const r = validateOutput(parsed, SOURCES);
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'INVALID_OUTPUT');
    assert.ok(r.error.issues.some((s) => s.includes('「10」')), '应报告无法溯源的 10');
  });

  test('拦截：revised_segment 放大原文数字', () => {
    const parsed = base();
    parsed.diff[0].revised_segment = '主导 5 个校园渠道的内容运营';
    const r = validateOutput(parsed, SOURCES);
    assert.equal(r.ok, false);
    assert.ok(r.error.issues.some((s) => s.includes('「5」')));
  });

  test('放行：占位符「待补充」', () => {
    const parsed = base();
    parsed.rewritten = '主导 3 个校园渠道的内容运营，粉丝增长待补充';
    const r = validateOutput(parsed, SOURCES);
    assert.equal(r.ok, true);
  });

  test('放行：followups 补充的数字进入白名单', () => {
    const parsed = {
      rewritten: '管理月度预算 3 万元的校园渠道投放',
      diff: [{ original_segment: '信息流广告投放', revised_segment: '管理月度预算 3 万元的投放执行', rationale: '补充预算规模与管理动作' }],
      keywords: [],
      questions: [],
    };
    const r = validateOutput(parsed, { experience: '负责信息流广告投放', followupText: '问：月度预算？答：3 万元' });
    assert.equal(r.ok, true);
  });

  test('拦截：补充中也没有的数字', () => {
    const parsed = {
      rewritten: '管理月度预算 8 万元的校园渠道投放',
      diff: [{ original_segment: '信息流广告投放', revised_segment: '管理月度预算的投放执行', rationale: '补充管理动作' }],
      keywords: [],
      questions: [],
    };
    const r = validateOutput(parsed, { experience: '负责信息流广告投放', followupText: '问：月度预算？答：3 万元' });
    assert.equal(r.ok, false);
    assert.ok(r.error.issues.some((s) => s.includes('「80000」')));
  });

  test('放行：３万/30,000/三万/30000 归一化互通', () => {
    const variants = [
      { experience: '月度预算３万', text: '管理 30,000 元月度预算' },
      { experience: '月度预算三万', text: '管理 30000 元月度预算' },
      { experience: '月度预算 30,000 元', text: '管理 3 万元月度预算' },
    ];
    for (const v of variants) {
      const r = validateOutput(minimal(v.text, '月度预算'), { experience: v.experience, followupText: '' });
      assert.equal(r.ok, true, `${v.experience} -> ${v.text} 应放行`);
    }
  });
});

describe('负面词（一票否决，契约 §6 第 5 道）', () => {
  test('rewritten 命中判非法', () => {
    const parsed = base();
    parsed.rewritten = '主导 3 个校园渠道的内容运营，全面赋能内容生产链路';
    const r = validateOutput(parsed, SOURCES);
    assert.equal(r.ok, false);
    assert.ok(r.error.issues.some((s) => s.includes('赋能')));
  });

  test('rationale 命中判非法', () => {
    const parsed = base();
    parsed.diff[0].rationale = '用组合拳思路重构表达，形成闭环';
    const r = validateOutput(parsed, SOURCES);
    assert.equal(r.ok, false);
    assert.ok(r.error.issues.some((s) => s.includes('组合拳')));
  });

  test('25 词逐一命中均判非法', () => {
    for (const w of NEGATIVE_WORDS) {
      const parsed = base();
      parsed.rewritten = `主导 3 个校园渠道的${w}运营`;
      const r = validateOutput(parsed, SOURCES);
      assert.equal(r.ok, false, `禁用词「${w}」应判非法`);
    }
  });
});

describe('original_segment 原文子串（契约 §6 第 3 道）', () => {
  test('非原文片段判非法', () => {
    const parsed = base();
    parsed.diff[0].original_segment = '主导 10 个渠道的投放工作';
    const r = validateOutput(parsed, SOURCES);
    assert.equal(r.ok, false);
    assert.ok(r.error.issues.some((s) => s.includes('original_segment')));
  });

  test('标点/全半角差异不影响子串判定', () => {
    const parsed = base();
    parsed.diff[0].original_segment = '负责３个校园渠道的日常运营'; // 全角３
    const r = validateOutput(parsed, SOURCES);
    assert.equal(r.ok, true);
  });
});

describe('专有名词拉丁 token 溯源（契约 §6 第 7 道）', () => {
  test('拦截：凭空出现的拉丁专有名词', () => {
    const parsed = base();
    parsed.rewritten = '使用 Python 搭建 3 个校园渠道的数据看板';
    const r = validateOutput(parsed, { experience: '负责 3 个校园渠道的日常运营', followupText: '' });
    assert.equal(r.ok, false);
    assert.ok(r.error.issues.some((s) => s.includes('无法溯源')));
  });

  test('放行：原文已有的拉丁 token（大小写不敏感）', () => {
    const parsed = base();
    parsed.rewritten = '优化 SQL 报表产出流程，覆盖 3 个校园渠道';
    parsed.diff = [{ original_segment: 'SQL 报表开发', revised_segment: '优化 SQL 报表产出流程', rationale: '补充结果导向表述' }];
    const r = validateOutput(parsed, { experience: '负责 SQL 报表开发与 3 个校园渠道运营', followupText: '' });
    assert.equal(r.ok, true);
  });
});

describe('关键词 hit 复核降级（契约 §6 第 6 道，不影响 ok）', () => {
  test('hit 未命中 rewritten 自动降级 missing', () => {
    const parsed = base();
    parsed.keywords = [{ keyword: '用户增长', status: 'hit', source_hint: '可从粉丝群运营挖掘' }];
    const r = validateOutput(parsed, SOURCES);
    assert.equal(r.ok, true);
    assert.equal(r.value.keywords[0].status, 'missing');
  });

  test('hit 命中则保持', () => {
    const r = validateOutput(base(), SOURCES);
    assert.equal(r.ok, true);
    assert.equal(r.value.keywords[0].status, 'hit'); // 「内容运营」在 rewritten 中
    assert.equal(r.value.keywords[1].status, 'missing');
  });
});

describe('Schema 校验（契约 §6 第 1/2 道）', () => {
  test('缺 diff', () => {
    const parsed = base();
    delete parsed.diff;
    const r = validateOutput(parsed, SOURCES);
    assert.equal(r.ok, false);
    assert.ok(r.error.issues.some((s) => s.includes('diff')));
  });

  test('keywords 为字符串（类型错）', () => {
    const parsed = base();
    parsed.keywords = '内容运营';
    const r = validateOutput(parsed, SOURCES);
    assert.equal(r.ok, false);
  });

  test('rewritten 为空', () => {
    const parsed = base();
    parsed.rewritten = '   ';
    const r = validateOutput(parsed, SOURCES);
    assert.equal(r.ok, false);
  });

  test('rewritten 301 字符超硬上限', () => {
    const parsed = base();
    parsed.rewritten = '运'.repeat(301);
    const r = validateOutput(parsed, SOURCES);
    assert.equal(r.ok, false);
    assert.ok(r.error.issues.some((s) => s.includes('300')));
  });

  test('rationale 为空（FR-4 理由缺失率 0）', () => {
    const parsed = base();
    parsed.diff[0].rationale = '';
    const r = validateOutput(parsed, SOURCES);
    assert.equal(r.ok, false);
    assert.ok(r.error.issues.some((s) => s.includes('rationale')));
  });

  test('blocking 为 true（必须恒 false）', () => {
    const parsed = base();
    parsed.questions[0].blocking = true;
    const r = validateOutput(parsed, SOURCES);
    assert.equal(r.ok, false);
  });

  test('status 非法枚举值', () => {
    const parsed = base();
    parsed.keywords[0].status = 'covered';
    const r = validateOutput(parsed, SOURCES);
    assert.equal(r.ok, false);
  });

  test('契约外顶层字段严格拒绝', () => {
    const parsed = base();
    parsed.notes = '额外说明';
    const r = validateOutput(parsed, SOURCES);
    assert.equal(r.ok, false);
    assert.ok(r.error.issues.some((s) => s.includes('notes')));
  });

  test('mock_mode 类型错误', () => {
    const parsed = base();
    parsed.mock_mode = 'yes';
    const r = validateOutput(parsed, SOURCES);
    assert.equal(r.ok, false);
  });

  test('输出非对象', () => {
    for (const parsed of ['x', null, 42, []]) {
      const r = validateOutput(parsed, SOURCES);
      assert.equal(r.ok, false);
    }
  });
});

describe('防御性行为', () => {
  test('缺少 sources 时从严判非法（无法溯源）', () => {
    const r = validateOutput(base(), {});
    assert.equal(r.ok, false);
  });

  test('不修改入参对象', () => {
    const parsed = base();
    const snapshot = JSON.stringify(parsed);
    validateOutput(parsed, SOURCES);
    assert.equal(JSON.stringify(parsed), snapshot);
  });
});
