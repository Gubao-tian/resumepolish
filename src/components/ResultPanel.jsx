import { useState } from 'react';
import { countChars } from '../api.js';

/** 一键复制（FR-7）：clipboard API + execCommand 降级，2 秒成功反馈 */
function useCopyToClipboard() {
  const [copied, setCopied] = useState(false);
  const copy = (text) => {
    const done = () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    };
    const fallback = () => {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      done();
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(fallback);
    } else {
      fallback();
    }
  };
  return [copied, copy];
}

/**
 * 结果区：四要素展示（契约 §3；FR-3~FR-6）。
 *
 * - rewritten：纯文本整段 + 一键复制 + 字数（契约裁决 2：不拆结构化字段）；
 * - diff：逐处对照表，每处必带理由（FR-4）；
 * - keywords：hit=已保留 / missing=待补充，missing 附 source_hint 仅提示不写入；
 * - questions：blocking 恒 false 不阻断；内联回答后「补充并重新生成」，
 *   仅回传已回答项，由 App 做多轮全量累积（契约 §2）。
 */
export default function ResultPanel({ result, onRegenerate, submitting }) {
  const [copied, copy] = useCopyToClipboard();
  const [answers, setAnswers] = useState({});

  const { mock_mode: mockMode, rewritten, diff, keywords, questions } = result;
  const hitKeywords = keywords.filter((k) => k.status === 'hit');
  const missingKeywords = keywords.filter((k) => k.status === 'missing');
  const answeredCount = questions.filter((q) => (answers[q.question] ?? '').trim() !== '').length;

  const handleRegenerate = () => {
    const followups = questions
      .filter((q) => (answers[q.question] ?? '').trim() !== '')
      .map((q) => ({ question: q.question, answer: answers[q.question].trim() }));
    onRegenerate(followups);
  };

  return (
    <div className="result-panel">
      {mockMode && (
        <p className="demo-badge" data-testid="demo-badge">
          演示模式：当前为 Mock 数据，未调用真实模型
        </p>
      )}

      <section className="card" aria-labelledby="rewrite-title">
        <div className="card-head">
          <h3 id="rewrite-title">改写后的经历描述</h3>
          <div className="card-head-actions">
            <span className="char-count">{countChars(rewritten)} 字</span>
            <button type="button" className="button-secondary" onClick={() => copy(rewritten)}>
              {copied ? '已复制 ✓' : '一键复制'}
            </button>
          </div>
        </div>
        <p className="rewrite-text" data-testid="rewrite-text">
          {rewritten}
        </p>
      </section>

      <section className="card" aria-labelledby="diff-title">
        <h3 id="diff-title">逐处修改对照</h3>
        {diff.length === 0 ? (
          <p className="empty-state">本次改写未做片段级调整，可直接使用上方描述</p>
        ) : (
          <table className="diff-table" data-testid="diff-table">
            <thead>
              <tr>
                <th scope="col">原文</th>
                <th scope="col">改后</th>
                <th scope="col">为什么改</th>
              </tr>
            </thead>
            <tbody>
              {diff.map((item, i) => (
                <tr key={`${item.original_segment}-${i}`} data-testid="diff-row">
                  <td className="diff-original">{item.original_segment}</td>
                  <td className="diff-revised">{item.revised_segment}</td>
                  <td className="diff-reason">{item.rationale}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card" aria-labelledby="keywords-title">
        <h3 id="keywords-title">岗位关键词提示</h3>
        <div className="keyword-group">
          <h4>已保留（JD 关键词，已体现在改写中）</h4>
          <div className="chips" data-testid="keywords-hit">
            {hitKeywords.length === 0 && <span className="empty-state">暂无</span>}
            {hitKeywords.map((k, i) => (
              <span key={`${k.keyword}-${i}`} className="chip chip-hit">
                {k.keyword}
              </span>
            ))}
          </div>
        </div>
        <div className="keyword-group">
          <h4>待补充（JD 中出现，但你的原文未覆盖）</h4>
          <div className="chips" data-testid="keywords-missing">
            {missingKeywords.length === 0 && <span className="empty-state">暂无</span>}
            {missingKeywords.map((k, i) => (
              <span key={`${k.keyword}-${i}`} className="chip chip-missing" title={k.source_hint}>
                {k.keyword}
              </span>
            ))}
          </div>
          {missingKeywords.length > 0 && (
            <ul className="keyword-hints">
              {missingKeywords.map((k, i) => (
                <li key={`${k.keyword}-${i}`}>
                  <strong>{k.keyword}</strong>：可从「{k.source_hint}」挖掘，确认具备后自行添加——产品不会替你写入
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="card" aria-labelledby="questions-title">
        <h3 id="questions-title">缺失信息反问</h3>
        {questions.length === 0 ? (
          <p className="empty-state" data-testid="questions-empty">
            未发现明显缺失的信息，可直接使用或微调后复制
          </p>
        ) : (
          <>
            <p className="questions-intro">
              以下信息缺失，补充后改写会更扎实。回答不了可以跳过——产品不会替你编造。
            </p>
            <ul className="question-list">
              {questions.map((q, i) => (
                <li key={`${q.question}-${i}`} className="question-item" data-testid="question-item">
                  <p className="question-text">{q.question}</p>
                  {q.reason && <p className="question-reason">为什么问：{q.reason}</p>}
                  <textarea
                    className="question-input"
                    rows={2}
                    placeholder="补充真实细节（如具体数字、方法、时长）"
                    value={answers[q.question] ?? ''}
                    onChange={(e) =>
                      setAnswers((prev) => ({ ...prev, [q.question]: e.target.value }))
                    }
                  />
                </li>
              ))}
            </ul>
            <div className="question-actions">
              <button
                type="button"
                className="button-primary"
                disabled={submitting || answeredCount === 0}
                onClick={handleRegenerate}
              >
                {submitting ? '重新生成中…' : '补充并重新生成'}
              </button>
              {answeredCount === 0 && (
                <span className="question-hint">填写至少一条补充后再生成，或直接使用当前结果</span>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
