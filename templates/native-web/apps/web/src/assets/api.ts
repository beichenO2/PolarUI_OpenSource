export interface WorkflowAsset {
  kind: 'attachment' | 'artifact'; id: string; filename: string; mediaType: string;
  byteSize: number; sha256: string; createdAt: string;
}
async function json(response: Response) {
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.code ?? 'REQUEST_FAILED');
  return body;
}
export async function listThreadAttachments(threadId: string): Promise<WorkflowAsset[]> {
  const response = await fetch(`/api/threads/${encodeURIComponent(threadId)}/attachments`, { credentials: 'same-origin' });
  return (await json(response)).attachments;
}
export async function listStageArtifacts(routeId: string, stageKey: string): Promise<WorkflowAsset[]> {
  const response = await fetch(
    `/api/routes/${encodeURIComponent(routeId)}/stages/${encodeURIComponent(stageKey)}/artifacts`,
    { credentials: 'same-origin' },
  );
  return (await json(response)).artifacts;
}
export async function uploadAttachment(threadId: string, file: File): Promise<void> {
  const response = await fetch(`/api/threads/${encodeURIComponent(threadId)}/attachments`, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/octet-stream', 'x-file-media-type': file.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name) }, body: file,
  });
  await json(response);
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
