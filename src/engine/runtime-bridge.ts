/** Detect Electron shell and invoke main-process runtime handlers. */

export interface RuntimeExecResult {
  stdout: string
  stderr: string
  exit_code: number
  success?: boolean
}

export interface PolarRuntimeApi {
  isElectron: boolean
  executeNode(classType: string, params: Record<string, unknown>, inputs: Record<string, unknown>): Promise<RuntimeExecResult & { result?: unknown; screenshot?: string }>
}

declare global {
  interface Window {
    polarRuntime?: PolarRuntimeApi
  }
}

export function isElectronRuntime(): boolean {
  return Boolean(typeof window !== 'undefined' && window.polarRuntime?.isElectron)
}

export async function invokeElectronRuntime(
  classType: string,
  params: Record<string, unknown>,
  inputs: Record<string, unknown>,
): Promise<RuntimeExecResult & { result?: unknown; screenshot?: string }> {
  if (!window.polarRuntime?.isElectron) {
    throw new Error('Electron runtime unavailable')
  }
  return window.polarRuntime.executeNode(classType, params, inputs)
}
