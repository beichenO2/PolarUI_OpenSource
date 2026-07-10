/** Step apply helpers without PDF / Node deps — safe for browser GUI overlay. */

function parseResult(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  const text = String(raw);
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      return JSON.parse(m[0]);
    } catch {
      return { reply: text };
    }
  }
  return { reply: text };
}

/** Apply Step 0 LLM JSON → session transition */
export async function applyStep0(session, result, fileTexts = '') {
  const r = parseResult(result);
  if (r.teacher?.name) session.teacher = { ...session.teacher, ...r.teacher };
  if (r.student?.profile) session.student.profile = r.student.profile;

  const ready = r.ready === true
    && session.teacher.name?.trim()
    && session.student.profile?.trim();

  if (ready) session.step = 'S1_Research';

  return {
    reply: r.reply ?? (ready
      ? '信息已齐，开始调研导师背景（风评、署名、研究方向）…'
      : '请补充：导师姓名/单位/主页链接，以及你的学校、专业、科研经历和意向方向。'),
    step: session.step,
    ready,
    missing: r.missing,
  };
}

/** Apply Step 1 synthesize LLM JSON (research from upstream merge) */
export async function applyStep1(session, research, synthesizeResult) {
  const syn = parseResult(synthesizeResult);
  session.research = {
    ...research,
    at: new Date().toISOString(),
  };

  const continueResearch = syn.continue_research === true;
  if (!continueResearch) session.step = 'S2_Select';

  return {
    reply: syn.reply ?? '导师调研完成，请选择感兴趣的方向编号或描述你的偏好。',
    step: session.step,
    research: session.research,
    direction_options: syn.direction_options ?? research?.directions?.cross_points ?? [],
    continue_research: continueResearch,
  };
}

/** Apply Step 2 LLM JSON → session (PDF compile delegated to Node apply-step.mjs) */
export async function applyStep2(session, result, { compileLatex } = {}) {
  const r = parseResult(result);
  if (r.selected_direction) session.selected_direction = r.selected_direction;
  if (r.outreach_draft) session.outreach_draft = r.outreach_draft;

  const locked = r.direction_locked === true && session.selected_direction;
  let overviewPdf = null;

  if (locked && r.overview_latex && compileLatex) {
    const slug = `overview-${Date.now()}`;
    overviewPdf = await compileLatex(r.overview_latex, slug);
    session.artifacts.overview_pdf = overviewPdf;
  }

  if (locked) session.step = 'S3_DeepPrep';

  return {
    reply: r.reply ?? (locked ? '方向已锁定，正在生成深度准备材料…' : '请确认方向或修改套辞话术。'),
    step: session.step,
    outreach_draft: session.outreach_draft,
    direction_locked: locked,
    pdf_path: overviewPdf,
  };
}

/** Apply Step 3 LLM JSON → session (PDF compile delegated to Node apply-step.mjs) */
export async function applyStep3(session, result, { compileLatex } = {}) {
  const r = parseResult(result);
  if (r.outreach_final) session.outreach_draft = r.outreach_final;

  let prepPdf = null;
  if (r.prep_latex && compileLatex) {
    const slug = `prep-${Date.now()}`;
    prepPdf = await compileLatex(r.prep_latex, slug);
    session.artifacts.prep_pdf = prepPdf;
  }

  const done = r.prep_pdf_sent === true || !!prepPdf;
  if (done) session.step = 'done';

  return {
    reply: r.reply ?? '深度准备 PDF 已生成，请查收附件。',
    step: done ? 'done' : session.step,
    outreach_final: session.outreach_draft,
    mock_qa: r.mock_qa ?? [],
    pdf_path: prepPdf ?? session.artifacts.prep_pdf,
    prep_pdf_sent: done,
  };
}

export function buildHarnessOutput(conversationId, session, stepResult) {
  return {
    ok: !stepResult.error,
    conversation_id: conversationId,
    step: session.step,
    reply: stepResult.reply,
    pdf_path: stepResult.pdf_path ?? null,
    outreach_draft: stepResult.outreach_draft ?? session.outreach_draft,
    direction_options: stepResult.direction_options ?? null,
    mock_qa: stepResult.mock_qa ?? null,
    session_snapshot: {
      teacher: session.teacher,
      selected_direction: session.selected_direction,
      artifacts: session.artifacts,
    },
  };
}
