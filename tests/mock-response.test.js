import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mockChatCompletion } from '../api/rewrite.js';
import { PLACEHOLDER_TOKEN } from '../shared/prompt.js';

/**
 * Mock 演示响应单测（Issue #19 / #20 / #23）。
 *
 * 背景：Mock 此前只接收 experience，导致三个真实缺陷——
 *   1. 关键词硬编码「内容生产/数据分析」，与传入的 JD 完全无关（FR-5 形同失效）；
 *   2. followups 答案被丢弃，补充后输出逐字节不变且已答追问照旧再问（FR-6 形同失效）；
 *   3. 硬编码尾缀「搭建选题模板」凭空新增原文没有的事实，Mock 自己违反零虚构红线；
 *   4. 截断把小数点当分隔符，切断数字后触发数字溯源一票否决 → 含小数输入直接 500。
 * 本文件锁定这四点，防止回归。
 *
 * 注意：Mock 位于**默认体验路径**（无 Key 时自动进入），这些行为是用户第一眼看到的东西。
 */

const EXP = '在某电商公司运营岗实习，负责信息流投放';
const EXP_WITH_DECIMAL = '预算 3.2 万元，覆盖 2 个平台';
/** 通用运营岗 JD（词组型） */
const JD_OPS = '运营实习生：投放优化、数据分析';

describe('Mock 消费 JD（Issue #19：FR-5 关键词不得与 JD 脱钩）', () => {
  test('关键词取自 JD，而非硬编码的内容生产/数据分析', () => {
    const jd = '产品经理实习生：需求分析、原型设计、用户调研、数据驱动';
    const r = mockChatCompletion({ experience: EXP, jd });
    const kws = r.keywords.map((k) => k.keyword);
    assert.ok(kws.includes('需求分析'), `应含 JD 中的「需求分析」，实际=${kws.join(',')}`);
    assert.ok(kws.includes('原型设计'), `应含 JD 中的「原型设计」，实际=${kws.join(',')}`);
    assert.ok(!kws.includes('内容生产'), '不得再出现硬编码的「内容生产」');
    assert.ok(!kws.includes('数据分析'), '未出现在该 JD 中，不应凭空出现');
  });

  test('同一经历换 JD，关键词随之改变（证明真的读了 JD）', () => {
    const a = mockChatCompletion({ experience: EXP, jd: '运营实习生：投放优化、用户增长' });
    const b = mockChatCompletion({ experience: EXP, jd: '内容运营实习：内容生产、选题策划' });
    const ka = a.keywords.map((k) => k.keyword);
    const kb = b.keywords.map((k) => k.keyword);
    assert.ok(ka.includes('投放优化'));
    assert.ok(kb.includes('选题策划'));
    assert.notDeepEqual(ka, kb, '不同 JD 必须产出不同关键词');
  });

  test('职位名与头衔不作为关键词（「内容运营实习」→「内容运营」）', () => {
    const r = mockChatCompletion({ experience: EXP, jd: '内容运营实习：内容生产、数据分析' });
    const kws = r.keywords.map((k) => k.keyword);
    assert.ok(kws.includes('内容运营'), `应剥出「内容运营」，实际=${kws.join(',')}`);
    assert.ok(!kws.includes('内容运营实习'), '职位名不应原样作为关键词');
  });

  test('keywords 每项结构完整（keyword/status/source_hint）', () => {
    const r = mockChatCompletion({ experience: EXP, jd: '运营实习生：投放优化、数据分析' });
    assert.ok(r.keywords.length > 0);
    for (const k of r.keywords) {
      assert.equal(typeof k.keyword, 'string');
      assert.ok(k.keyword.length > 0);
      assert.ok(['hit', 'missing'].includes(k.status));
      assert.equal(typeof k.source_hint, 'string');
      assert.ok(k.source_hint.length > 0);
    }
  });
});

describe('Mock 消费 followups（Issue #19/#23：FR-6 不得失效）', () => {
  const answers = [{ question: '这段经历带来的可量化结果是多少？', answer: '预算 3.2 万元，覆盖 2 个平台，ROI 1.8' }];

  test('用户补充的数字进入 rewritten（答案不再被丢弃）', () => {
    const r = mockChatCompletion({ experience: EXP, jd: '运营实习生：投放优化', followups: answers });
    assert.match(r.rewritten, /3\.2 万元/, `改写文应消费补充答案，实际=${r.rewritten}`);
  });

  test('答案中的多个数字都被消费，而非只取首个', () => {
    // User A 复验原场景：她填了四个数字，只取首个会静默丢弃「阅读量 1200 / 平均 400 / 涨粉 80」，
    // 而最有说服力的恰恰是阅读量与涨粉——观感上仍是「没完全听进去」。
    const r = mockChatCompletion({
      experience: '在校园公众号写过几篇推文',
      jd: '内容运营实习：内容生产',
      followups: [
        { question: '这段经历带来的可量化结果是多少？', answer: '6 篇，阅读量 1200，平均 400，涨粉 80' },
      ],
    });
    for (const n of ['6 篇', '1200', '400', '80']) {
      assert.ok(r.rewritten.includes(n), `应消费数字「${n}」，实际=${r.rewritten}`);
    }
  });

  test('不带答案与带答案的两次输出不同（证明补充真的被消费）', () => {
    const before = mockChatCompletion({ experience: EXP, jd: '运营实习生：投放优化' });
    const after = mockChatCompletion({ experience: EXP, jd: '运营实习生：投放优化', followups: answers });
    assert.notEqual(before.rewritten, after.rewritten, '补充后输出必须变化');
  });

  test('已回答的追问不再重复提问', () => {
    const r = mockChatCompletion({ experience: EXP, jd: '运营实习生：投放优化', followups: answers });
    assert.equal(r.questions.length, 0, `已回答则不应再问，实际=${JSON.stringify(r.questions)}`);
  });

  test('未回答时仍正常追问（不因去重逻辑而丢失追问）', () => {
    const r = mockChatCompletion({ experience: EXP, jd: '运营实习生：投放优化' });
    assert.equal(r.questions.length, 1);
    assert.equal(r.questions[0].blocking, false, '追问恒不阻断（契约 §2）');
    assert.ok(r.questions[0].reason.length > 0);
  });

  test('原文已含数字时不追问数字，且不再占位', () => {
    const r = mockChatCompletion({ experience: EXP_WITH_DECIMAL, jd: '运营实习生：投放优化' });
    assert.equal(r.questions.length, 0, '原文已有数字，不应再追问');
    assert.ok(!r.rewritten.includes(PLACEHOLDER_TOKEN), '已有数字不应出现占位符');
  });
});

describe('Mock 不新增事实（Issue #20：不得自己违反零虚构红线）', () => {
  test('不再硬编码尾缀「搭建选题模板」', () => {
    const r = mockChatCompletion({ experience: EXP, jd: '运营实习生：投放优化' });
    assert.ok(!r.rewritten.includes('搭建选题模板'), `投放岗用户从未搭过选题模板，实际=${r.rewritten}`);
    assert.ok(!r.rewritten.includes('形成可复用的内容生产流程'));
  });

  test('无数字且未补充时用占位符，不编造数值', () => {
    const r = mockChatCompletion({ experience: EXP, jd: '运营实习生：投放优化' });
    assert.ok(r.rewritten.includes(PLACEHOLDER_TOKEN), `缺失数字应占位，实际=${r.rewritten}`);
    assert.equal(/\d/.test(r.rewritten.replace(PLACEHOLDER_TOKEN, '')), false, '占位之外不得出现任何数字');
  });

  test('改写文不外扩原文之外的实义片段（仅做被动→主动的改写）', () => {
    const r = mockChatCompletion({ experience: '负责校园公众号运营', jd: '内容运营实习：内容生产' });
    assert.match(r.rewritten, /^主导/, '应把「负责」改为「主导」');
    assert.ok(r.rewritten.includes('校园公众号运营'), '应保留原文实义片段');
  });
});

describe('Mock 截取不破坏数字（Issue #20 扩展：含小数输入曾直接 500）', () => {
  test('小数整体保留，不被从中间切断', () => {
    const r = mockChatCompletion({ experience: EXP_WITH_DECIMAL, jd: '运营实习生：投放优化' });
    assert.ok(r.rewritten.includes('3.2'), `改写文数字须与原文一致，实际=${r.rewritten}`);
    assert.ok(!/\d\.?\d*$/.test(r.rewritten.replace('3.2', '')), '不得残留被切断的半截数字');
  });

  test('diff[].original_segment 是 experience 的逐字子串（契约 §6 第 3 道）', () => {
    for (const exp of [EXP, EXP_WITH_DECIMAL, '负责校园公众号运营', 'ROI 1.8']) {
      const r = mockChatCompletion({ experience: exp, jd: '运营实习生：投放优化' });
      assert.ok(
        exp.includes(r.diff[0].original_segment),
        `「${r.diff[0].original_segment}」必须是「${exp}」的子串`
      );
    }
  });

  test('改写文数字来自原文或补充答案（契约 §6 第 4 道溯源）', () => {
    const r = mockChatCompletion({ experience: EXP_WITH_DECIMAL, jd: '运营实习生：投放优化' });
    const nums = r.rewritten.match(/\d+(?:\.\d+)?/g) ?? [];
    for (const n of nums) {
      assert.ok(EXP_WITH_DECIMAL.includes(n), `数字 ${n} 必须原样来自原文`);
    }
  });
});

describe('Mock 确定性与结构（ADR-3）', () => {
  test('同输入同输出（连跑三次逐字节一致）', () => {
    const args = { experience: EXP, jd: '运营实习生：投放优化、数据分析' };
    const a = JSON.stringify(mockChatCompletion(args));
    const b = JSON.stringify(mockChatCompletion(args));
    const c = JSON.stringify(mockChatCompletion(args));
    assert.equal(a, b);
    assert.equal(b, c);
  });

  test('mock_mode 恒为 true，四要素齐全', () => {
    const r = mockChatCompletion({ experience: EXP, jd: '运营实习生：投放优化' });
    assert.equal(r.mock_mode, true);
    assert.equal(typeof r.rewritten, 'string');
    assert.ok(Array.isArray(r.diff) && r.diff.length > 0);
    assert.ok(Array.isArray(r.keywords));
    assert.ok(Array.isArray(r.questions));
    assert.ok(r.diff[0].rationale.length > 0, 'FR-4：修改理由不得为空');
  });

  test('缺省参数不崩溃（jd/followups 缺失时仍有合法结构）', () => {
    const r = mockChatCompletion({ experience: EXP });
    assert.equal(typeof r.rewritten, 'string');
    assert.ok(Array.isArray(r.keywords));
    assert.ok(Array.isArray(r.questions));
  });
});

/**
 * 以下用例来自研发 Code Review PR #26/#30 时定位的问题（Issue #34–#38），
 * 由 PM 逐条复现确认后修复。此处锁定，防止回归。
 */
describe('Issue #34 纯虚词经历不得 500（片段剥离后不得回退非子串）', () => {
  test('original_segment 始终是 experience 的逐字子串', () => {
    for (const exp of ['与、和', '的了和', '和']) {
      const r = mockChatCompletion({ experience: exp, jd: JD_OPS });
      assert.ok(
        exp.includes(r.diff[0].original_segment),
        `「${r.diff[0].original_segment}」必须是「${exp}」的子串——回退到硬编码兜底串会导致第 3 道校验必然失败 → 500`
      );
    }
  });

  test('不得出现硬编码兜底串「这段经历」作为原文片段', () => {
    const r = mockChatCompletion({ experience: '与、和', jd: JD_OPS });
    assert.notEqual(r.diff[0].original_segment, '这段经历');
  });
});

describe('Issue #35 英文 JD 不得产出虚词关键词', () => {
  const EN_JD =
    'We are looking for an intern with good communication skills and experience in data analysis for growth and optimization';

  test('英文虚词（are/for/and/with/good…）不得进入 keywords', () => {
    const r = mockChatCompletion({ experience: EXP, jd: EN_JD });
    const kws = r.keywords.map((k) => k.keyword.toLowerCase());
    for (const w of ['are', 'for', 'and', 'with', 'good', 'the', 'we', 'you', 'our', 'this']) {
      assert.ok(!kws.includes(w), `英文虚词「${w}」不应作为关键词，实际=${kws.join(',')}`);
    }
  });

  test('英文能力词应被保留（data / growth / analysis / intern）', () => {
    const r = mockChatCompletion({ experience: EXP, jd: EN_JD });
    const kws = r.keywords.map((k) => k.keyword.toLowerCase());
    assert.ok(kws.some((k) => ['data', 'growth', 'analysis', 'intern', 'optimization'].includes(k)),
      `应保留英文能力词，实际=${kws.join(',')}`);
  });
});

describe('Issue #36 日期不得被当作可量化成果', () => {
  const Q = '这段经历带来的可量化结果是多少？';

  test('回答含日期时只取真实成果数字', () => {
    const r = mockChatCompletion({
      experience: '在社团做公众号',
      jd: JD_OPS,
      followups: [{ question: Q, answer: '从 2023.06 到 2023.09 涨粉 300 人' }],
    });
    assert.ok(r.rewritten.includes('300 人'), `应保留真实成果，实际=${r.rewritten}`);
    assert.ok(!r.rewritten.includes('2023.06'), '日期不得作为可量化成果');
    assert.ok(!r.rewritten.includes('2023.09'), '日期不得作为可量化成果');
  });

  test('四位数的阅读量不会被误判为年份（1200 必须保留）', () => {
    const r = mockChatCompletion({
      experience: '在社团做公众号',
      jd: JD_OPS,
      followups: [{ question: Q, answer: '6 篇，阅读量 1200，平均 400，涨粉 80' }],
    });
    for (const n of ['6 篇', '1200', '400', '80']) {
      assert.ok(r.rewritten.includes(n), `「${n}」应保留，实际=${r.rewritten}`);
    }
  });
});

describe('Issue #37 改写文不得超过 300 字符（片段长度预算）', () => {
  test('无标点超长经历（350 字）仍产出 ≤300 的改写文', () => {
    const long = '在2023年6月到9月期间于某电商公司运营岗实习负责信息流广告投放与日常出价调整及素材上新工作并配合完成每周数据复盘与竞品分析以及月度投放策略调整';
    const exp = long.repeat(3).slice(0, 350);
    const r = mockChatCompletion({ experience: exp, jd: JD_OPS });
    assert.ok(r.rewritten.length <= 300, `rewritten 长度 ${r.rewritten.length} 超过 300 上限`);
    assert.ok(exp.includes(r.diff[0].original_segment), '片段仍须是原文子串');
  });
});

describe('Issue #36 补充：日期过滤不得误伤真实成果、不得漏网', () => {
  const Q = '这段经历带来的可量化结果是多少？';
  const answerTo = (answer) =>
    mockChatCompletion({
      experience: '在社团做公众号',
      jd: JD_OPS,
      followups: [{ question: Q, answer }],
    }).rewritten;

  test('裸四位数成果不得被误判为年份（曝光 2000 必须保留）', () => {
    // 回归点：早先把「任意四位数字」当成年份过滤，会把用户填的真实成果静默删掉
    assert.ok(answerTo('曝光 2000').includes('2000'), `「2000」是成果不是年份，实际=${answerTo('曝光 2000')}`);
    assert.ok(answerTo('涨粉 2023').includes('2023'), `「2023」在此处是数量，实际=${answerTo('涨粉 2023')}`);
  });

  test('带 - / 年 / 月 分隔的日期不得漏网（只滤掉年份是不够的）', () => {
    for (const [answer, junk] of [
      ['2023-09 涨粉 300', '09'],
      ['2023年6月涨粉 300', '2023'],
      ['2023 年 6 月到 9 月，涨粉 300', '2023'],
      ['2023.06.09 上线，阅读 800', '06'],
    ]) {
      const out = answerTo(answer);
      assert.ok(!out.includes(junk), `日期片段「${junk}」不应作为成果出现，实际=${out}`);
    }
  });

  test('日期剔除后真实成果必须保留', () => {
    for (const [answer, keep] of [
      ['2023-09 涨粉 300', '300'],
      ['2023年6月涨粉 300', '300'],
      ['6月9日活动，到场 300 人', '300 人'],
      ['2023.06.09 上线，阅读 800', '800'],
    ]) {
      assert.ok(answerTo(answer).includes(keep), `真实成果「${keep}」应保留，实际=${answerTo(answer)}`);
    }
  });
});

describe('Issue #34 补充：片段剥离不得产出半截词，兜底不得用硬编码串', () => {
  test('「参与」的「与」不得被当虚词剥掉（主导参 / 主导全程参）', () => {
    // 回归点：尾缀剥离 [的了和与及等其将已并]+$ 会吃掉「参与」的「与」
    for (const exp of ['参与', '全程参与', '深度参与']) {
      const r = mockChatCompletion({ experience: exp, jd: JD_OPS });
      assert.equal(r.diff[0].original_segment, exp, `片段应保持完整，实际=${r.diff[0].original_segment}`);
      // 注意不能用 includes('主导参') 判断——「主导参与」本身就包含「主导参」
      assert.ok(r.rewritten.startsWith(`主导${exp}`), `不得产出半截词，实际=${r.rewritten}`);
    }
  });

  test('片段整体是被动动词时，rewritten 不得退化成「这段经历」', () => {
    for (const exp of ['负责', '协助', '参与']) {
      const r = mockChatCompletion({ experience: exp, jd: JD_OPS });
      assert.ok(!r.rewritten.includes('这段经历'), `不得回退到硬编码兜底串，实际=${r.rewritten}`);
      // rewritten 与 diff 必须描述同一件事：原文片段的字面量仍应出现在改写文里
      assert.ok(r.rewritten.includes(exp), `改写文应仍基于原片段「${exp}」，实际=${r.rewritten}`);
    }
  });
});

describe('JD 停用词补充：时间量词与邮箱/域名不得成为关键词', () => {
  const JD_REAL =
    '工作地点：北京海淀。日薪 200 元，本科及以上在读。岗位职责：1. 负责信息流投放账户搭建与日常优化；2. 跟踪投放数据并输出复盘报告。任职要求：1. 熟悉 Excel 与 SQL，对数据敏感；2. 每周到岗 4 天以上，实习 3 个月以上。投递方式：简历命名为「姓名+学校+实习」发送至 hr@example.com';

  test('时长/时间量词（个月/天/小时）与页眉标题不得进入 keywords', () => {
    const kws = mockChatCompletion({ experience: EXP, jd: JD_REAL }).keywords.map((k) => k.keyword);
    for (const noise of ['个月', '每周', '工作地点']) {
      assert.ok(!kws.includes(noise), `「${noise}」不是能力词，实际=${kws.join(',')}`);
    }
  });

  test('邮箱被切分后漏出的 com / hr 不得成为关键词', () => {
    const kws = mockChatCompletion({ experience: EXP, jd: JD_REAL }).keywords.map((k) => k.keyword.toLowerCase());
    for (const junk of ['com', 'hr']) {
      assert.ok(!kws.includes(junk), `邮箱片段「${junk}」不是能力词，实际=${kws.join(',')}`);
    }
  });

  test('补停用词后真实能力词仍须保留', () => {
    const kws = mockChatCompletion({ experience: EXP, jd: JD_REAL }).keywords.map((k) => k.keyword);
    assert.ok(kws.includes('SQL') && kws.includes('Excel'), `能力词应保留，实际=${kws.join(',')}`);
  });
});

describe('Issue #41 能力章节候选不足时不得用噪声补满', () => {
  /** 含「页眉 → 岗位职责 → 任职要求 → 投递方式」的真实整段启事 */
  const JD_REAL =
    '工作地点：北京海淀。日薪 200 元，本科及以上在读。岗位职责：1. 负责信息流投放账户搭建与日常优化；2. 跟踪投放数据并输出复盘报告。任职要求：1. 熟悉 Excel 与 SQL，对数据敏感；2. 每周到岗 4 天以上，实习 3 个月以上。投递方式：简历命名为「姓名+学校+实习」发送至 hr@example.com';

  test('只给能力词，不得用页眉/页脚噪声补满 5 个', () => {
    const kws = mockChatCompletion({ experience: EXP, jd: JD_REAL }).keywords.map((k) => k.keyword);
    for (const noise of ['北京海淀', '实习」发送至', '工作地点', 'com', 'hr']) {
      assert.ok(!kws.includes(noise), `噪声「${noise}」不应作为关键词，实际=${kws.join(',')}`);
    }
    assert.deepEqual(kws, ['Excel', 'SQL', '数据敏感'], `应只给能力词，实际=${kws.join(',')}`);
  });

  test('宁缺毋滥：能力章节只有 3 个候选就只给 3 个，不补位到 5 个', () => {
    const r = mockChatCompletion({ experience: EXP, jd: JD_REAL });
    assert.ok(r.keywords.length > 0, '不得为空');
    assert.ok(r.keywords.length < 5, `不足 5 个时不应补位，实际 ${r.keywords.length} 个`);
  });

  test('词组型 JD（无章节标题）不得退化：仍按原逻辑给出全部能力词', () => {
    const kws = mockChatCompletion({
      experience: EXP,
      jd: '产品经理实习生：需求分析、原型设计、用户调研',
    }).keywords.map((k) => k.keyword);
    assert.deepEqual(kws, ['需求分析', '原型设计', '用户调研'], `词组型 JD 应保持原有输出，实际=${kws.join(',')}`);
  });

  test('无章节标题的 JD 兜底不得为空（英文 JD / 短 JD）', () => {
    for (const jd of [
      'Responsible for user growth, familiar with SQL and Excel, data driven',
      '运营实习生：数据分析',
    ]) {
      const kws = mockChatCompletion({ experience: EXP, jd }).keywords.map((k) => k.keyword);
      assert.ok(kws.length > 0, `JD「${jd}」的 keywords 不得为空`);
    }
  });
});

describe('Issue #38 已回答但无数字时不得出现死胡同', () => {
  const Q = '这段经历带来的可量化结果是多少？';

  test('答案无阿拉伯数字时，显示占位符的同时必须给出追问入口', () => {
    const r = mockChatCompletion({
      experience: '在社团做公众号',
      jd: JD_OPS,
      followups: [{ question: Q, answer: '涨了大概几百人' }],
    });
    assert.ok(r.rewritten.includes(PLACEHOLDER_TOKEN), '占位符应保留（不编造数字）');
    assert.ok(r.questions.length > 0, '不得既显示「待补充」又无任何追问入口（死胡同）');
    assert.notEqual(r.questions[0].question, Q, '应换一个措辞追问，而非重复同一个问题');
  });

  test('首次未回答时仍问原问题', () => {
    const r = mockChatCompletion({ experience: '在社团做公众号', jd: JD_OPS });
    assert.equal(r.questions.length, 1);
    assert.equal(r.questions[0].question, Q);
  });
});
