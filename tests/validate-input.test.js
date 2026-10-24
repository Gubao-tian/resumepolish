import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { validateInput } from '../shared/validate.js';

const valid = {
  experience: '负责 3 个校园渠道的日常运营，每周产出内容',
  jd: '招聘内容运营，要求具备数据分析能力',
};

/** 构造含控制/零宽字符的脏字符串（避免在源码中嵌入原始控制字节） */
function dirtyText() {
  return `负责${String.fromCharCode(0)}系统${String.fromCharCode(0x00ad)}管${String.fromCharCode(0x200b)}理`;
}

describe('validateInput 合法输入', () => {
  test('基本合法请求，followups 默认空数组', () => {
    const r = validateInput(valid);
    assert.equal(r.ok, true);
    assert.equal(r.data.experience, valid.experience);
    assert.equal(r.data.jd, valid.jd);
    assert.deepEqual(r.data.followups, []);
  });

  test('边界：experience 300 / jd 2000 字符通过', () => {
    const r = validateInput({ experience: '经'.repeat(300), jd: '职'.repeat(2000) });
    assert.equal(r.ok, true);
  });

  test('followups 合法结构并原样保留', () => {
    const r = validateInput({ ...valid, followups: [{ question: '预算？', answer: '3 万' }] });
    assert.equal(r.ok, true);
    assert.equal(r.data.followups.length, 1);
    assert.equal(r.data.followups[0].question, '预算？');
    assert.equal(r.data.followups[0].answer, '3 万');
  });
});

describe('validateInput 非法输入', () => {
  test('experience 为空或纯空白', () => {
    for (const experience of ['', `   ${String.fromCharCode(10)}${String.fromCharCode(9)} `]) {
      const r = validateInput({ ...valid, experience });
      assert.equal(r.ok, false);
      assert.equal(r.error.code, 'INVALID_INPUT');
      assert.equal(r.error.detail.field, 'experience');
      assert.match(r.error.message, /请粘贴一条简历经历/);
    }
  });

  test('experience 301 字符超限', () => {
    const r = validateInput({ experience: '经'.repeat(301), jd: valid.jd });
    assert.equal(r.ok, false);
    assert.equal(r.error.detail.field, 'experience');
    assert.match(r.error.message, /300/);
  });

  // Issue #22：仅标点/符号/emoji 的输入能骗过 trim()，却在下游 normalizeForMatch() 归一化后归零，
  // 使输出校验第 3 道对任何输出都必然失败 → 500（真实链路还会白烧两次 LLM 调用）。
  test('experience 仅标点 / 符号 / emoji（归一化后为空）→ 400 引导，不得放行', () => {
    for (const experience of ['。', '！！！', '，，，', '🎉', '🎉🎉', '￥', '……', '、；？！', '***', '---']) {
      const r = validateInput({ ...valid, experience });
      assert.equal(r.ok, false, `「${experience}」应被拦下`);
      assert.equal(r.error.code, 'INVALID_INPUT');
      assert.equal(r.error.detail.field, 'experience');
      assert.match(r.error.message, /请粘贴一条简历经历/);
      assert.match(r.error.message, /仅标点/, '应给出「仅标点、符号或表情」的具体引导');
    }
  });

  test('jd 仅标点 / 符号 / emoji（归一化后为空）→ 400 引导', () => {
    for (const jd of ['。', '！！！', '🎉', '￥', '……']) {
      const r = validateInput({ ...valid, jd });
      assert.equal(r.ok, false, `jd「${jd}」应被拦下`);
      assert.equal(r.error.detail.field, 'jd');
      assert.match(r.error.message, /请粘贴目标岗位 JD/);
    }
  });

  test('含 emoji / 英文 / 数字的正常输入不被误杀（归一化后非空）', () => {
    for (const experience of ['🎉 负责校园公众号运营', 'Student Union 干事', '预算 3.2 万元', 'a', '1']) {
      const r = validateInput({ ...valid, experience });
      assert.equal(r.ok, true, `「${experience}」不应被拦下`);
    }
  });

  test('全角空格仍走原有纯空白路径（trim 先行），文案不带「仅标点」补充', () => {
    const r = validateInput({ ...valid, experience: '　' });
    assert.equal(r.ok, false);
    assert.equal(r.error.detail.field, 'experience');
    assert.match(r.error.message, /请粘贴一条简历经历/);
    assert.doesNotMatch(r.error.message, /仅标点/, '纯空白应命中 trim 分支，而非归一化分支');
  });

  // Issue #34 第二层：纯虚词输入（与、和）此前能骗过「归一化后非空」，却在下游片段剥离后变空 → 500
  test('experience 仅虚词（与、和）→ 400 引导，不得放行', () => {
    for (const experience of ['与、和', '的了和', '的', '与', '和']) {
      const r = validateInput({ ...valid, experience });
      assert.equal(r.ok, false, `「${experience}」应被拦下`);
      assert.equal(r.error.detail.field, 'experience');
      assert.match(r.error.message, /仅有标点或虚词/, '应给出「仅有标点或虚词」的具体引导');
    }
  });

  test('正常输入含虚词但不全是虚词 → 不得误伤', () => {
    for (const experience of ['负责校园公众号运营', '参与社团活动', '在社团做公众号', '参与了产品设计']) {
      const r = validateInput({ ...valid, experience });
      assert.equal(r.ok, true, `「${experience}」不应被误伤`);
    }
  });

  test('jd 为空', () => {
    const r = validateInput({ ...valid, jd: '' });
    assert.equal(r.ok, false);
    assert.equal(r.error.detail.field, 'jd');
    assert.match(r.error.message, /请粘贴目标岗位 JD/);
  });

  test('jd 2001 字符超限', () => {
    const r = validateInput({ experience: valid.experience, jd: '职'.repeat(2001) });
    assert.equal(r.ok, false);
    assert.equal(r.error.detail.field, 'jd');
    assert.match(r.error.message, /2000/);
  });

  test('字段缺失或类型错误', () => {
    assert.equal(validateInput({ jd: valid.jd }).error.detail.field, 'experience');
    assert.equal(validateInput({ experience: 123, jd: valid.jd }).error.detail.field, 'experience');
    assert.equal(validateInput({ experience: valid.experience }).error.detail.field, 'jd');
    assert.equal(validateInput({ experience: valid.experience, jd: null }).error.detail.field, 'jd');
  });

  test('followups 结构非法', () => {
    const cases = ['x', 42, [{}], [{ question: 'q' }], [{ answer: 'a' }], [null], [{ question: '  ', answer: 'a' }]];
    for (const followups of cases) {
      const r = validateInput({ ...valid, followups });
      assert.equal(r.ok, false, `followups=${JSON.stringify(followups)} 应判非法`);
      assert.equal(r.error.detail.field, 'followups');
    }
  });

  test('请求体不是对象', () => {
    for (const body of [null, undefined, 'x', 42, []]) {
      const r = validateInput(body);
      assert.equal(r.ok, false);
      assert.equal(r.error.detail.field, 'body');
    }
  });
});

describe('sanitize（经 validateInput 生效）', () => {
  test('控制字符与零宽字符被剔除，正常 Unicode 保留', () => {
    const r = validateInput({ experience: dirtyText(), jd: valid.jd });
    assert.equal(r.ok, true);
    assert.equal(r.data.experience, '负责系统管理');
  });

  test('清洗后参与长度校验', () => {
    // 300 个正常字符 + 若干零宽字符 = 清洗后 300，应通过
    const padded = '经'.repeat(299) + String.fromCharCode(0x200b);
    const r = validateInput({ experience: padded, jd: valid.jd });
    assert.equal(r.ok, true);
  });
});
