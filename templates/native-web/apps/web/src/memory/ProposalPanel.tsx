import { useCallback, useEffect, useState } from 'react';
import { decideMemoryProposal, listMemoryProposals, type MemoryProposal } from '../assets/api';
export function ProposalPanel({ threadId, revision = 0 }: { threadId: string; revision?: number }) {
  const [proposals, setProposals] = useState<MemoryProposal[]>([]); const [error, setError] = useState('');
  const reload = useCallback(() => listMemoryProposals(threadId).then(setProposals).catch(() => setError('记忆提案暂时无法载入。')), [threadId]);
  useEffect(() => { void reload(); }, [reload, revision]); const pending = proposals.filter((item) => item.status === 'pending');
  if (pending.length === 0 && !error) return null;
  return <section className="proposal-panel" aria-labelledby="proposal-heading"><p className="card-kicker">显式确认</p><h3 id="proposal-heading">记忆提案</h3>
    {pending.map((proposal) => <article key={proposal.id} className="proposal-row"><div><small>{proposal.scope}</small><strong>{proposal.key}</strong><p>{String(proposal.value)}</p></div>
      <div><button type="button" onClick={async () => { await decideMemoryProposal(proposal.id, 'adopted'); await reload(); }}>采纳</button><button type="button" onClick={async () => { await decideMemoryProposal(proposal.id, 'rejected'); await reload(); }}>拒绝</button></div></article>)}
    {error && <p className="command-error" role="alert">{error}</p>}</section>;
}
