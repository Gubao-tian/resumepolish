import { useState } from 'react';
import { LIMITS, countChars } from '../api.js';

/** 与后端 shared/validate.js 的 §7.4 文案保持一致：无论前端拦截还是服务端 400，用户看到同一句话 */
const MESSAGES = Object.freeze({
  experienceEmpty: '请粘贴一条简历经历',
  experienceTooLong: `经历不能超过 ${LIMITS.experience} 字，请拆分成多条后逐条提交`,
  jdEmpty: '请粘贴目标岗位 JD，否则无法进行岗位对照改写',
  jdTooLong: `JD 不能超过 ${LIMITS.jd} 字，请精简至岗位职责与任职要求部分`,
});

/**
 * 输入区（FR-1/FR-2）。
 *
 * 交互决策：提交按钮不因空值/超限硬禁用——点击时展示内联错误并聚焦首个
 * 不合法字段，同时满足「阻止提交」与「空输入给出引导文案」两条验收；
 * 仅「提交中」一种场景禁用按钮。
 */
export default function ExperienceForm({ onSubmit, submitting }) {
  const [experience, setExperience] = useState('');
  const [jd, setJd] = useState('');
  const [showErrors, setShowErrors] = useState(false);

  const expOver = countChars(experience) > LIMITS.experience;
  const jdOver = countChars(jd) > LIMITS.jd;

  const focusField = (id) => document.getElementById(id)?.focus();

  const handleSubmit = (event) => {
    event.preventDefault();
    const invalid =
      experience.trim() === '' || jd.trim() === '' || expOver || jdOver;
    if (invalid) {
      setShowErrors(true);
      if (experience.trim() === '' || expOver) focusField('experience');
      else focusField('jd');
      return;
    }
    setShowErrors(false);
    onSubmit(experience, jd);
  };

  return (
    <form className="panel input-panel" onSubmit={handleSubmit} noValidate>
      <div className="field">
        <div className="field-head">
          <label htmlFor="experience">简历经历原文</label>
          <span
            className={`counter${expOver ? ' counter-over' : ''}`}
            data-testid="experience-counter"
          >
            {countChars(experience)}/{LIMITS.experience}
          </span>
        </div>
        <textarea
          id="experience"
          rows={5}
          value={experience}
          placeholder="例：负责 XX 系统的需求分析与功能设计"
          onChange={(e) => setExperience(e.target.value)}
        />
        {showErrors && (expOver || experience.trim() === '') && (
          <p className="field-error" data-testid="experience-error">
            {expOver ? MESSAGES.experienceTooLong : MESSAGES.experienceEmpty}
          </p>
        )}
      </div>

      <div className="field">
        <div className="field-head">
          <label htmlFor="jd">目标岗位 JD（必填）</label>
          <span className={`counter${jdOver ? ' counter-over' : ''}`} data-testid="jd-counter">
            {countChars(jd)}/{LIMITS.jd}
          </span>
        </div>
        <textarea
          id="jd"
          rows={8}
          value={jd}
          placeholder="粘贴目标岗位的招聘说明，含岗位职责与任职要求"
          onChange={(e) => setJd(e.target.value)}
        />
        {showErrors && (jdOver || jd.trim() === '') && (
          <p className="field-error" data-testid="jd-error">
            {jdOver ? MESSAGES.jdTooLong : MESSAGES.jdEmpty}
          </p>
        )}
      </div>

      <button type="submit" className="button-primary" disabled={submitting}>
        {submitting ? '改写中…' : '开始改写'}
      </button>

      <p className="privacy-line">输入仅用于本次生成，不存储、不用于其他用途</p>
    </form>
  );
}
