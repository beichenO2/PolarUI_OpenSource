export function workflowInput(page) {
  return page.getByRole('textbox', { name: 'Workflow Input', exact: true });
}

export function workflowInterrupt(page) {
  return page.getByRole('form', { name: 'Workflow Interrupt', exact: true });
}

export async function waitForZeroContextReady(page, {
  timeoutMs = 30_000,
  pollIntervalMs = 50,
} = {}) {
  const heading = page.getByRole('heading', { name: '你现在想处理什么？' });
  await heading.waitFor();
  const composer = workflowInput(page);
  await composer.waitFor();

  const deadline = Date.now() + timeoutMs;
  while (!(await composer.isEnabled())) {
    if (Date.now() >= deadline) throw new Error('Workflow Input did not become enabled');
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return composer;
}
