/**
 * Claim port from PolarPort (SSOT). No heuristic fallback.
 */
const POLARPORT_URL = process.env.POLARPORT_URL ?? 'http://127.0.0.1:11050';

/**
 * @param {{ serviceName: string; project?: string; preferred?: number }} opts
 * @returns {Promise<number>}
 */
export async function claimPolarPort(opts) {
  const res = await fetch(`${POLARPORT_URL}/api/allocate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      service_name: opts.serviceName,
      project: opts.project ?? 'PolarUI',
      preferred_port: opts.preferred,
    }),
    signal: AbortSignal.timeout(8000),
  });
  const data = await res.json();
  if (!res.ok || !data.ok || typeof data.port !== 'number') {
    throw new Error(`PolarPort allocate failed for ${opts.serviceName}: ${data.message ?? res.status}`);
  }
  return data.port;
}

export default claimPolarPort;
