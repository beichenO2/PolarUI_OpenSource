import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { complete } from './claude-core.mjs';

const PROMPTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'prompts');

async function loadPrompt(name) {
  return readFile(join(PROMPTS, name), 'utf8');
}

function sessionSummary(session) {
  return JSON.stringify(
    {
      step: session.step,
      teacher: session.teacher,
      student: { profile: session.student.profile, file_count: session.student.files?.length ?? 0 },
      selected_direction: session.selected_direction,
      has_research: !!session.research,
    },
    null,
    2,
  );
}

/** Step 0: 循环澄清直到 teacher + student 齐全 */
export async function runStep0(session, userMessage, fileTexts) {
  const system = await loadPrompt('step0-clarify.md');
  const user = `当前会话状态:\n${sessionSummary(session)}\n\n用户附件摘要:\n${fileTexts || '（无）'}\n\n用户消息:\n${userMessage}`;

  const result = await complete({ system, user, json: true });

  if (result.teacher?.name) session.teacher = { ...session.teacher, ...result.teacher };
  if (result.student?.profile) session.student.profile = result.student.profile;

  const ready = result.ready === true
    && session.teacher.name?.trim()
    && session.student.profile?.trim();

  if (ready) {
    session.step = 'S1_Research';
    return {
      reply: result.reply ?? '信息已齐，开始调研导师背景（风评、署名、研究方向）…',
      step: session.step,
      ready: true,
    };
  }

  return {
    reply: result.reply ?? '请补充：导师姓名/单位/主页链接，以及你的学校、专业、科研经历和意向方向。',
    step: session.step,
    ready: false,
    missing: result.missing ?? ['teacher.name', 'student.profile'],
  };
}

/** Step 1: 三路 subAgent（可因用户补充而重跑） */
export async function runStep1(session, userMessage) {
  const { runReputationAgent } = await import('../subagents/reputation.mjs');
  const { runAuthorshipAgent } = await import('../subagents/authorship.mjs');
  const { runDirectionsAgent } = await import('../subagents/directions.mjs');

  const ctx = { teacher: session.teacher, student: session.student, userMessage };

  const [reputation, authorship, directions] = await Promise.all([
    runReputationAgent(ctx),
    runAuthorshipAgent(ctx),
    runDirectionsAgent(ctx),
  ]);

  session.research = { reputation, authorship, directions, at: new Date().toISOString() };

  const system = await loadPrompt('step1-synthesize.md');
  const user = `调研结果:\n${JSON.stringify(session.research, null, 2)}\n\n用户消息:\n${userMessage}`;
  const syn = await complete({ system, user, json: true });

  const continueResearch = syn.continue_research === true;
  if (!continueResearch) session.step = 'S2_Select';

  return {
    reply: syn.reply ?? '导师调研完成，请选择感兴趣的方向编号或描述你的偏好。',
    step: session.step,
    research: session.research,
    direction_options: syn.direction_options ?? directions.cross_points ?? [],
    continue_research: continueResearch,
  };
}

/** Step 2: 选方向 + 套辞话术 + 概览 PDF */
export async function runStep2(session, userMessage) {
  const system = await loadPrompt('step2-outreach.md');
  const user = `会话:\n${sessionSummary(session)}\n\n调研:\n${JSON.stringify(session.research, null, 2)}\n\n用户:\n${userMessage}`;
  const result = await complete({ system, user, json: true });

  if (result.selected_direction) session.selected_direction = result.selected_direction;
  if (result.outreach_draft) session.outreach_draft = result.outreach_draft;

  const locked = result.direction_locked === true && session.selected_direction;

  let overviewPdf = null;
  if (locked && result.overview_latex) {
    const { compileLatex } = await import('./pdf.mjs');
    const slug = `overview-${Date.now()}`;
    overviewPdf = await compileLatex(result.overview_latex, slug);
    session.artifacts.overview_pdf = overviewPdf;
  }

  if (locked) session.step = 'S3_DeepPrep';

  return {
    reply: result.reply ?? (locked ? '方向已锁定，正在生成深度准备材料…' : '请确认方向或修改套辞话术。'),
    step: session.step,
    outreach_draft: session.outreach_draft,
    direction_locked: locked,
    pdf_path: overviewPdf,
  };
}

/** Step 3: 深度准备 PDF + 模拟问答 */
export async function runStep3(session, userMessage) {
  const system = await loadPrompt('step3-deep-prep.md');
  const user = `方向: ${JSON.stringify(session.selected_direction)}\n话术:\n${session.outreach_draft}\n\n用户:\n${userMessage}`;
  const result = await complete({ system, user, json: true });

  if (result.outreach_final) session.outreach_draft = result.outreach_final;

  let prepPdf = null;
  if (result.prep_latex) {
    const { compileLatex } = await import('./pdf.mjs');
    const slug = `prep-${Date.now()}`;
    prepPdf = await compileLatex(result.prep_latex, slug);
    session.artifacts.prep_pdf = prepPdf;
  }

  const done = result.prep_pdf_sent === true || !!prepPdf;
  if (done) session.step = 'done';

  return {
    reply: result.reply ?? '深度准备 PDF 已生成，请查收附件。',
    step: done ? 'done' : session.step,
    outreach_final: session.outreach_draft,
    mock_qa: result.mock_qa ?? [],
    pdf_path: prepPdf ?? session.artifacts.prep_pdf,
    prep_pdf_sent: done,
  };
}

export async function dispatch(session, userMessage, fileTexts) {
  switch (session.step) {
    case 'S0_Clarify':
      return runStep0(session, userMessage, fileTexts);
    case 'S1_Research':
      return runStep1(session, userMessage);
    case 'S2_Select':
      return runStep2(session, userMessage);
    case 'S3_DeepPrep':
      return runStep3(session, userMessage);
    case 'done':
      session.step = 'S3_DeepPrep';
      return runStep3(session, userMessage);
    default:
      session.step = 'S0_Clarify';
      return runStep0(session, userMessage, fileTexts);
  }
}
