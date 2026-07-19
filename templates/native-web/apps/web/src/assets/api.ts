export interface WorkflowAsset {
  kind: 'attachment' | 'artifact'; id: string; filename: string; mediaType: string;
  byteSize: number; sha256: string; createdAt: string;
}
export interface StagedAttachment {
  id: string;
  filename: string;
  mediaType: string;
  byteSize: number;
  sha256: string;
  status: 'pending';
  conversationId: null;
  createdAt: string;
}
async function json(response: Response) {
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.code ?? 'REQUEST_FAILED');
  return body;
}
export async function listConversationAttachments(conversationId: string): Promise<WorkflowAsset[]> {
  const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/attachments`, { credentials: 'same-origin' });
  return (await json(response)).attachments;
}
export async function listStageArtifacts(routeId: string, stageKey: string): Promise<WorkflowAsset[]> {
  const response = await fetch(
    `/api/routes/${encodeURIComponent(routeId)}/stages/${encodeURIComponent(stageKey)}/artifacts`,
    { credentials: 'same-origin' },
  );
  return (await json(response)).artifacts;
}
export async function stageAttachment(file: File): Promise<StagedAttachment> {
  const response = await fetch('/api/attachments/staged', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/octet-stream', 'x-file-media-type': file.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name) }, body: file,
  });
  return (await json(response)).attachment;
}
export async function deleteStagedAttachment(attachmentId: string): Promise<void> {
  await json(await fetch(`/api/attachments/staged/${encodeURIComponent(attachmentId)}`, {
    method: 'DELETE', credentials: 'same-origin',
  }));
}
export function downloadUrl(asset: WorkflowAsset) { return `/api/assets/${asset.kind}/${encodeURIComponent(asset.id)}/download`; }
export interface MemoryProposal { id: string; scope: string; key: string; value: string | number | boolean | null; status: 'pending' | 'adopted' | 'rejected'; }
export async function listMemoryProposals(threadId: string): Promise<MemoryProposal[]> {
  const response = await fetch(`/api/memory-proposals?thread=${encodeURIComponent(threadId)}`, { credentials: 'same-origin' });
  return (await json(response)).proposals;
}
export async function decideMemoryProposal(id: string, decision: 'adopted' | 'rejected') {
  return json(await fetch(`/api/memory-proposals/${encodeURIComponent(id)}/decision`, {
    method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision }),
  }));
}
