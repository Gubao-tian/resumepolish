import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractLatinTokens,
  extractNumbers,
  normalizeForMatch,
  normalizeNumberToken,
  textContainsNumber,
} from '../shared/numbers.js';

describe('normalizeNumberToken', () => {
  test('万/亿/千 单位与阿拉伯数字互通', () => {
    assert.equal(normalizeNumberToken('３万'), '30000');
    assert.equal(normalizeNumberToken('3万'), '30000');
    assert.equal(normalizeNumberToken('三万'), '30000');
    assert.equal(normalizeNumberToken('30000'), '30000');
    assert.equal(normalizeNumberToken('30,000'), '30000');
    assert.equal(normalizeNumberToken('1.5万'), '15000');
    assert.equal(normalizeNumberToken('3千'), '3000');
    assert.equal(normalizeNumberToken('两亿'), '200000000');
  });

  test('中文数字组合', () => {
    assert.equal(normalizeNumberToken('十二'), '12');
    assert.equal(normalizeNumberToken('三千五'), '3500'); // 口语简写：三千五 = 3500
    assert.equal(normalizeNumberToken('三百五'), '350');
    assert.equal(normalizeNumberToken('三万五'), '35000');
    assert.equal(normalizeNumberToken('一百零五'), '105'); // 零之后不简写
    assert.equal(normalizeNumberToken('三千五百'), '3500');
    assert.equal(normalizeNumberToken('一百二十'), '120');
    assert.equal(normalizeNumberToken('十万'), '100000');
  });

  test('非数字返回 null', () => {
    assert.equal(normalizeNumberToken('abc'), null);
    assert.equal(normalizeNumberToken(''), null);
    assert.equal(normalizeNumberToken('待补充'), null);
    assert.equal(normalizeNumberToken('万'), null); // 纯单位字不是数字
    assert.equal(normalizeNumberToken(null), null);
    assert.equal(normalizeNumberToken(undefined), null);
  });
});

describe('extractNumbers', () => {
  test('阿拉伯数字抽取（保序去重）', () => {
    assert.deepEqual(extractNumbers('负责 3 个渠道，覆盖 30000 名学生，3 个渠道各 1 名负责人'), ['3', '30000', '1']);
  });

  test('单字中文数字须后接量词，避免"统一/一定"误抽', () => {
    assert.deepEqual(extractNumbers('统一管理团队口径'), []);
    assert.deepEqual(extractNumbers('管理 3 个校园渠道'), ['3']);
    assert.deepEqual(extractNumbers('三个校园渠道'), ['3']);
    assert.deepEqual(extractNumbers('一定提升效率'), []);
  });

  test('多字中文数字串直接抽取', () => {
    assert.deepEqual(extractNumbers('预算十二万，历时三周'), ['120000', '3']);
  });

  test('全角数字与单位后缀', () => {
    assert.deepEqual(extractNumbers('月度预算３万元'), ['30000']);
  });

  test('"三成"换算为 30，与"30%"互通', () => {
    assert.deepEqual(extractNumbers('转化率提升三成'), ['30']);
  });

  test('数字与单位间允许空格', () => {
    assert.deepEqual(extractNumbers('预算 3 万元'), ['30000']);
  });

  test('非字符串输入返回空数组', () => {
    assert.deepEqual(extractNumbers(null), []);
    assert.deepEqual(extractNumbers(42), []);
  });

  test('副词中的数字字符不误抽（十分/一定），锁定行为防过度抽取', () => {
    assert.deepEqual(extractNumbers('效果十分理想，一定要量化成果'), []);
    assert.deepEqual(extractNumbers('统一团队口径，一定可以提升'), []);
  });
});

describe('textContainsNumber', () => {
  test('数字等价互通（３万/30,000/三万/30000）', () => {
    assert.equal(textContainsNumber('覆盖 30000 名学生', '3万'), true);
    assert.equal(textContainsNumber('覆盖 3 万名学生', '30000'), true);
    assert.equal(textContainsNumber('月度预算三万', '30,000'), true);
    assert.equal(textContainsNumber('月度预算 ３万', '30000'), true);
  });

  test('不等价数字不互通', () => {
    assert.equal(textContainsNumber('管理 3 个渠道', '10'), false);
    assert.equal(textContainsNumber('月度预算 3 万', '50000'), false);
  });

  test('非数字 needle 退化为归一化子串', () => {
    assert.equal(textContainsNumber('负责 XX 系统的需求分析', 'XX 系统'), true);
    assert.equal(textContainsNumber('负责 XX 系统的需求分析', 'YY 系统'), false);
  });
});

describe('normalizeForMatch', () => {
  test('全半角/标点/大小写归一', () => {
    assert.equal(normalizeForMatch('负责ＸＸ系统，覆盖 3 万用户'), normalizeForMatch('负责XX系统 覆盖3万用户'));
    assert.equal(normalizeForMatch('SQL 报表开发'), normalizeForMatch('sql报表开发'));
  });

  test('非字符串返回空串', () => {
    assert.equal(normalizeForMatch(null), '');
  });
});

describe('extractLatinTokens', () => {
  test('过滤单字母与短符号 token', () => {
    assert.deepEqual(extractLatinTokens('使用 A/B 测试与 C++ 优化 iOS 页面'), ['ios']);
    assert.deepEqual(extractLatinTokens('v2 版本上线'), []);
  });

  test('保留多字母 token 并统一小写', () => {
    assert.deepEqual(extractLatinTokens('负责 SQL 报表与 Python 脚本'), ['sql', 'python']);
  });
});
