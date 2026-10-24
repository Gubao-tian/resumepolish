import { useEffect, useRef, useState } from 'react';
import ExperienceForm from './components/ExperienceForm.jsx';
import ResultPanel from './components/ResultPanel.jsx';
import { rewrite } from './api.js';
import { mergeFollowups } from './followups.js';

/** 等待态：骨架 + 已等待秒数。不伪造分阶段进度——后端是单次 LLM 调用，诚实展示 */
function LoadingPanel() {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="result-panel" data-testid="loading-state">
      <p className="loading-text">正在改写，通常 10-20 秒…（已等待 {elapsed} 秒，超过 30 秒将停止并提示重试）</p>
      <div className="skeleton-card" />
      <div className="skeleton-card" />
    </div>
  );
}

/** 错误态：按 code 渲染（契约 §4；429 含重试时间，超时/上游/500 系均给重试按钮） */
function ErrorPanel({ error, onRetry }) {
  const retryHint =
    error.code === 'RATE_LIMITED' && error.retryAfter
      ? `（约 ${error.retryAfter} 秒后可重试）`
      : error.code === 'ABORTED' || error.code === 'UPSTREAM_TIMEOUT'
        ? '（改写较慢，稍等片刻后重试通常即可成功）'
        : '';
  return (
    <div className="result-panel" data-testid="error-state">
      <section className="card card-error">
        <h3>没能完成这次改写</h3>
        <p data-testid="error-message">
          {error.message}
          {retryHint}
        </p>
        <button type="button" className="button-primary" onClick={onRetry}>
          重试
        </button>
      </section>
    </div>
  );
}

export default function App() {
  const [phase, setPhase] = useState('idle');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  /** 最近一次请求的输入，供重试与「补充并重新生成」复用 */
  const lastRequestRef = useRef(null);
  const [followups, setFollowups] = useState([]);

  const run = async (request) => {
    lastRequestRef.current = request;
    setPhase('submitting');
    setError(null);
    const res = await rewrite(request);
    if (res.ok) {
      setResult(res.data);
      setPhase('success');
    } else {
      setError(res.error);
      setPhase('error');
      // INVALID_INPUT 带 detail.field 时聚焦对应输入框（契约 §4）
      const field = res.error.detail?.field;
      if (res.error.code === 'INVALID_INPUT' && (field === 'experience' || field === 'jd')) {
        document.getElementById(field)?.focus();
      }
    }
  };

  /** 表单提交=新一轮改写的起点：重置累积的回答（旧回答可能不再适用于被编辑过的原文） */
  const handleSubmit = (experience, jd) => {
    setFollowups([]);
    run({ experience, jd });
  };

  const handleRegenerate = (newFollowups) => {
    const merged = mergeFollowups(followups, newFollowups);
    setFollowups(merged);
    if (lastRequestRef.current) {
      run({ ...lastRequestRef.current, followups: merged });
    }
  };

  const handleRetry = () => {
    if (lastRequestRef.current) run({ ...lastRequestRef.current, followups });
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1>简历润笔</h1>
        <p className="tagline">把真实经历翻译成目标岗位看得懂的成果描述——帮你挖，不帮你编</p>
      </header>

      <main className="layout">
        <ExperienceForm onSubmit={handleSubmit} submitting={phase === 'submitting'} />

        <div className="status-region" aria-live="polite">
          {phase === 'idle' && (
            <div className="result-panel" data-testid="idle-state">
              <section className="card">
                <h3>改写结果将在这里呈现，包含四部分</h3>
                <ol className="idle-list">
                  <li>改写后的经历描述（动作 + 方法 + 结果）</li>
                  <li>逐处修改对照：改了哪里、为什么改</li>
                  <li>岗位关键词提示：已保留 / 待补充</li>
                  <li>缺失信息反问：缺数字的地方会问你，不会替你编</li>
                </ol>
              </section>
            </div>
          )}
          {phase === 'submitting' && <LoadingPanel />}
          {phase === 'error' && <ErrorPanel error={error} onRetry={handleRetry} />}
          {phase === 'success' && result && (
            <ResultPanel
              result={result}
              onRegenerate={handleRegenerate}
              submitting={phase === 'submitting'}
            />
          )}
        </div>
      </main>

      <footer className="app-footer">
        <p>简历润笔 V1.0 · 零虚构 · 无 AI 味 · 不存数据</p>
      </footer>
    </div>
  );
}
