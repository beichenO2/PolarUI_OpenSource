export function assertNameLocks(workspace, {
  contextTitle,
  conversationId,
  conversationTitle,
}) {
  if (workspace?.context?.title !== contextTitle) {
    throw new Error(`Context title lock failed: ${workspace?.context?.title ?? 'missing'}`);
  }
  const conversation = workspace?.conversations?.find(({ id }) => id === conversationId);
  if (!conversation || conversation.title !== conversationTitle) {
    throw new Error(`Conversation title lock failed: ${conversation?.title ?? 'missing'}`);
  }
  if (conversation.titleSource !== 'user') {
    throw new Error(`Conversation title source is not user: ${conversation.titleSource ?? 'missing'}`);
  }
}
