import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv, loadEnv } from '../shared/load-env.js';

/**
 * .env 加载器单测（修复缺陷 #18：npm start 不读取 .env，用户填了 Key 仍静默走 Mock）。
 *
 * 本地开发服务器是唯一入口（Vercel 由平台注入环境变量，不依赖本模块），
 * 因此这里锁定解析规则与「不覆盖已有环境变量」的安全语义。
 */

describe('parseEnv 解析规则', () => {
  test('忽略空行与 # 注释行', () => {
    const r = parseEnv('\n# 这是注释\n\nLLM_API_KEY=sk-x\n  # 缩进注释\n');
    assert.deepEqual(r, { LLM_API_KEY: 'sk-x' });
  });

  test('剥离成对的双引号与单引号', () => {
    assert.deepEqual(parseEnv('A="v1"\nB=\'v2\''), { A: 'v1', B: 'v2' });
  });

  test('引号不配对时原样保留（不吞字符）', () => {
    assert.deepEqual(parseEnv('A="v1'), { A: '"v1' });
  });

  test('支持 export 前缀（兼容 shell 习惯写法）', () => {
    assert.deepEqual(parseEnv('export LLM_MODEL=deepseek-flash'), { LLM_MODEL: 'deepseek-flash' });
  });

  test('裁剪 = 两侧空白，但保留值内部空格', () => {
    assert.deepEqual(parseEnv('  KEY  =  a b  '), { KEY: 'a b' });
  });

  test('值中含 = 时仅按第一个 = 切分', () => {
    assert.deepEqual(parseEnv('URL=a=b=c'), { URL: 'a=b=c' });
  });

  test('跳过无 = 的行、键名为空的行与非法键名', () => {
    const r = parseEnv('NOEQ\n=value\n9BAD=x\nOK=yes\nhas-dash=x\n');
    assert.deepEqual(r, { OK: 'yes' });
  });

  test('支持下划线与数字组成的合法键名', () => {
    assert.deepEqual(parseEnv('LLM_BASE_URL=u\nA1=b'), { LLM_BASE_URL: 'u', A1: 'b' });
  });

  test('处理 CRLF 换行', () => {
    assert.deepEqual(parseEnv('A=1\r\nB=2\r\n'), { A: '1', B: '2' });
  });

  test('空输入与非字符串输入返回空对象（不抛错）', () => {
    assert.deepEqual(parseEnv(''), {});
    assert.deepEqual(parseEnv(undefined), {});
    assert.deepEqual(parseEnv(null), {});
  });

  test('后者覆盖同名键（与常规 .env 语义一致）', () => {
    assert.deepEqual(parseEnv('A=1\nA=2'), { A: '2' });
  });

  test('未加引号的值剥离行内注释（避免把注释当成密钥的一部分）', () => {
    assert.deepEqual(parseEnv('LLM_API_KEY=sk-x # 这是我的 Key'), { LLM_API_KEY: 'sk-x' });
    assert.deepEqual(parseEnv('PORT=8787#紧邻无空格'), { PORT: '8787' });
  });

  test('已加引号的值保留 #（兼容含 # 的密钥，不被误截）', () => {
    assert.deepEqual(parseEnv('KEY="a#b"'), { KEY: 'a#b' });
    assert.deepEqual(parseEnv("KEY='a#b #c'"), { KEY: 'a#b #c' });
  });

  test('值以 # 开头时判为行内注释 → 值为空（使 Mock 判定正确，不会拿注释去调真实接口）', () => {
    assert.deepEqual(parseEnv('LLM_API_KEY=# 还没填'), { LLM_API_KEY: '' });
    assert.deepEqual(parseEnv('LLM_API_KEY=   # 只有注释'), { LLM_API_KEY: '' });
  });
});

describe('loadEnv 加载语义', () => {
  test('文件存在时写入新键，返回 loaded 列表', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rp-env-'));
    const file = join(dir, '.env');
    await writeFile(file, 'LLM_API_KEY=sk-test\nLLM_MODEL=deepseek-flash\n', 'utf8');
    try {
      const env = {};
      const r = await loadEnv(file, env);
      assert.equal(r.missing, false);
      assert.deepEqual(r.loaded.sort(), ['LLM_API_KEY', 'LLM_MODEL']);
      assert.deepEqual(r.skipped, []);
      assert.equal(env.LLM_API_KEY, 'sk-test');
      assert.equal(env.LLM_MODEL, 'deepseek-flash');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('已有环境变量不被 .env 覆盖（平台注入优先）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rp-env-'));
    const file = join(dir, '.env');
    await writeFile(file, 'LLM_API_KEY=from-dotenv\nLLM_MODEL=from-dotenv\n', 'utf8');
    try {
      const env = { LLM_API_KEY: 'from-runtime' }; // 运行时已有
      const r = await loadEnv(file, env);
      assert.equal(env.LLM_API_KEY, 'from-runtime', '.env 不得覆盖运行时已注入的 Key');
      assert.equal(env.LLM_MODEL, 'from-dotenv', '未冲突的键仍应写入');
      assert.deepEqual(r.skipped, ['LLM_API_KEY']);
      assert.deepEqual(r.loaded, ['LLM_MODEL']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('文件不存在时静默返回 missing=true 且不抛错（Mock 演示模式仍可用）', async () => {
    const r = await loadEnv(join(tmpdir(), 'rp-definitely-missing-.env'), {});
    assert.equal(r.missing, true);
    assert.deepEqual(r.loaded, []);
    assert.deepEqual(r.skipped, []);
  });

  test('空值键（LLM_API_KEY=）仍写入，供 Mock 判定为「未配置」', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rp-env-'));
    const file = join(dir, '.env');
    await writeFile(file, 'LLM_API_KEY=\n', 'utf8');
    try {
      const env = {};
      const r = await loadEnv(file, env);
      assert.deepEqual(r.loaded, ['LLM_API_KEY']);
      assert.equal(env.LLM_API_KEY, '', '空值应写入，使 isMockMode() 判定为 Mock');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('不修改传入 env 之外的全局 process.env', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rp-env-'));
    const file = join(dir, '.env');
    await writeFile(file, 'RP_PROBE_KEY=leaked\n', 'utf8');
    try {
      const isolated = {};
      await loadEnv(file, isolated);
      assert.equal('RP_PROBE_KEY' in process.env, false, '显式传入 env 时不得污染 process.env');
      assert.equal(isolated.RP_PROBE_KEY, 'leaked');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
