/** 胡友财 / 郭韵怡 情景 — mock LLM 输出脚本 */

export const STUDENT_PROFILE =
  '郭韵怡，中国药科大学制药工程2023级，推免2027，光催化S-芳基化大创，SPOP合成，HPLC，意向胡友财老师';

export const TEACHER = {
  name: '胡友财',
  institution: '北京协和医学院/药物所',
  url: 'https://example.edu/hu',
};

export const DIRECTION = {
  id: 'A',
  title: '托酚酮杂萜酶法全合成与 SpoC 酶工程',
  cross_points: ['SpoC radical ring expansion', 'pathway reconstruction'],
};

export function mockStep0FirstTurn() {
  return {
    ready: false,
    reply: '请补充：导师单位/主页，以及你的科研经历细节。',
    missing: ['teacher.institution', 'student.profile'],
    teacher: { name: '胡友财', institution: '', url: '' },
    student: { profile: '药大制药工程大三，意向胡友财' },
  };
}

export function mockStep0Ready() {
  return {
    ready: true,
    reply: '信息已齐，开始调研导师背景…',
    teacher: TEACHER,
    student: { profile: STUDENT_PROFILE },
  };
}

export function mockStep1Synthesize() {
  return {
    reply: '胡友财组聚焦天然药物化学与 SpoC 酶促反应。推荐方向 A：托酚酮杂萜全合成。',
    direction_options: [DIRECTION],
    continue_research: false,
  };
}

export function mockStep2Draft() {
  return {
    reply: '方向 A 套辞话术草案如下，请确认。',
    direction_locked: false,
    outreach_draft: '胡老师您好，我是药大郭韵怡…',
  };
}

export function mockStep2Locked() {
  return {
    reply: '方向已锁定，概览 PDF 生成中。',
    direction_locked: true,
    selected_direction: DIRECTION,
    outreach_draft: '胡老师您好，我是中国药科大学制药工程郭韵怡…',
    overview_latex: '\\documentclass{ctexart}\\begin{document}概览\\end{document}',
  };
}

export function mockStep3Prep() {
  const mock_qa = [
    { q: '你为什么选择这个细分领域？', a: 'SpoC 机制已阐明，pathway 重构是自然的下一步。' },
    { q: '你觉得为什么你可以胜任这个工作？', a: '大创中做过光催化与 SPOP，具备有机合成与 HPLC 基础。' },
    { q: '你对 SpoC 了解多少？', a: '读过 JACS 2025 SpoC radical ring expansion 论文。' },
    { q: '为什么选我们组？', a: '方向与我的合成背景高度契合。' },
    { q: '推免时间线？', a: '2027 推免，可提前进组学习。' },
    { q: '能否全职进实验室？', a: '假期与推免前可投入较多时间。' },
    { q: '英语如何？', a: '可阅读 JACS 级文献。' },
    { q: '最大科研挑战？', a: '复杂天然产物全合成的路线设计。' },
    { q: '为何不做别的方向？', a: '已聚焦托酚酮杂萜单线，避免分散。' },
    { q: '期望产出？', a: '掌握酶促自由基环化与途径重构。' },
  ];
  return {
    reply: '深度准备 PDF 已生成。',
    outreach_final: '胡老师您好…（定稿）',
    prep_latex: '\\documentclass{ctexart}\\begin{document}深度准备\\end{document}',
    mock_qa,
    prep_pdf_sent: true,
  };
}

export function mockSubAgent() {
  return { status: 'done', summary: 'mock subagent output', cross_points: [] };
}

/** 子进程 mock：按 session 状态返回，避免每轮 harness 重置队列 */
export function mockForSession(session) {
  const userTurns = (session.history ?? []).filter((h) => h.role === 'user').length;

  switch (session.step) {
    case 'S0_Clarify':
      if (session.teacher?.name && session.student?.profile?.trim()) {
        return mockStep0Ready();
      }
      if (userTurns >= 2) return mockStep0Ready();
      return mockStep0FirstTurn();
    case 'S1_Research': {
      const n = session._mock_s1_calls ?? 0;
      session._mock_s1_calls = n + 1;
      if (n < 3) return mockSubAgent();
      return mockStep1Synthesize();
    }
    case 'S2_Select': {
      const n = session._mock_s2_calls ?? 0;
      session._mock_s2_calls = n + 1;
      return n === 0 ? mockStep2Draft() : mockStep2Locked();
    }
    case 'S3_DeepPrep':
    case 'done':
      return mockStep3Prep();
    default:
      return mockStep0FirstTurn();
  }
}

/** 按 LLM 调用顺序返回 mock 响应队列（单进程单元测试用） */
export function createMockQueue() {
  const queue = [
    mockStep0FirstTurn(),
    mockStep0Ready(),
    mockSubAgent(),
    mockSubAgent(),
    mockSubAgent(),
    mockStep1Synthesize(),
    mockStep2Draft(),
    mockStep2Locked(),
    mockStep3Prep(),
  ];
  let i = 0;
  return () => {
    const item = queue[Math.min(i, queue.length - 1)];
    i += 1;
    return item;
  };
}
