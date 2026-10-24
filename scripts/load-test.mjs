/**
 * 两层压测（tech-design T11；PRD §8.4/R4/R5）。
 *
 * Mock 层（默认，不依赖 Key）：并发打 handleRewriteRequest，统计 P50/P95/MAX
 * 与状态码分布，并单独验证同 IP 连续请求触发 429（FR-9）。
 * 真实层（--real）：需配置 LLM_API_KEY，≥30 次记录 P95（成本约 0.3 元）。
 *
 * 用法：
 *   node scripts/load-test.mjs [--real] [--n 200] [--concurrency 10]
 *
 * 注：文件名 `*-test.mjs` 会被 `node --test` 默认发现模式误抓（在 tests/ 限定 glob 上线前），
 * 顶部守卫保证被误抓时静默跳过；真实压测必须显式运行本脚本。
 */

// 被 node --test 误抓为测试文件时直接退出（NODE_TEST_CONTEXT 仅测试运行器设置）
if (process.env.NODE_TEST_CONTEXT) process.exit(0);

import { handleRewriteRequest } from '../api/rewrite.js';

const argv = process.argv.slice(2);
const real = argv.includes('--real');
const n = Number(argv[argv.indexOf('--n') + 1]) || 200;
const concurrency = Number(argv[argv.indexOf('--concurrency') + 1]) || 10;

const BODY = {
  experience: '负责 3 个校园渠道的日常运营，每周产出内容并维护粉丝群',
  jd: '岗位职责：负责内容运营与用户增长，要求具备数据分析能力',
};

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return Math.round(sorted[idx]);
}

async function runConcurrent(total, workers, makeIp) {
  const latencies = [];
  /** @type {Record<string, number>} */
  const statuses = {};
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const i = cursor++;
      if (i >= total) return;
      const t0 = performance.now();
      const r = await handleRewriteRequest({ body: BODY, ip: makeIp(i) });
      latencies.push(performance.now() - t0);
      statuses[r.status] = (statuses[r.status] || 0) + 1;
    }
  };
  await Promise.all(Array.from({ length: workers }, worker));
  return { latencies: latencies.sort((a, b) => a - b), statuses };
}

if (real && !process.env.LLM_API_KEY) {
  console.error('--real 需要 LLM_API_KEY（真实层调用会计费，约 0.01 元/次）');
  process.exit(1);
}
if (!real) {
  process.env.MOCK = '1'; // Mock 层强制 Mock（isMockMode 调用时求值）
}

console.log(`[load-test] mode=${real ? 'REAL' : 'MOCK'} n=${n} concurrency=${concurrency}`);

const { latencies, statuses } = await runConcurrent(n, concurrency, (i) => `10.0.${Math.floor(i / 250) % 250}.${i % 250}`);
console.log('[load-test] 延迟分布(ms)：', {
  p50: percentile(latencies, 0.5),
  p95: percentile(latencies, 0.95),
  max: Math.round(latencies[latencies.length - 1] || 0),
});
console.log('[load-test] 状态码分布：', statuses);

// 限流验证（FR-9）：同 IP 连续 35 次，预期前 30 次 200、后 5 次 429
if (!real) {
  const rl = await runConcurrent(35, 1, () => '192.168.1.100');
  const ok = (rl.statuses[200] || 0) === 30 && (rl.statuses[429] || 0) === 5;
  console.log('[load-test] 限流验证（同 IP 35 次）：', rl.statuses, ok ? 'PASS' : 'FAIL');
  if (!ok) process.exitCode = 1;
}
