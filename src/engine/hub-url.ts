/** Hub API base — browser 走 Vite proxy；Node headless 用绝对地址 */
export function hubApiBase(): string {
  if (typeof window !== 'undefined') return ''
  return process.env.POLAR_HUB_URL ?? 'http://127.0.0.1:8040'
}
