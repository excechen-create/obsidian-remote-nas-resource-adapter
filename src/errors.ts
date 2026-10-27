export type ErrorCode = 'PATH' | 'UNMAPPED' | 'HOST' | 'HTTP' | 'AUTH' | 'NOT_FOUND' |
  'TIMEOUT' | 'UNLOADED' | 'IMAGE' | 'TOO_LARGE' | 'NETWORK' | 'NAS_DISABLED' | 'BUSY' | 'TLS' | 'REDIRECT' | 'ABORTED';
export class AdapterError extends Error {
  constructor(public readonly code: ErrorCode, message: string = code) { super(message); this.name = 'AdapterError'; }
}
export function errorCode(error: unknown): ErrorCode {
  return error instanceof AdapterError ? error.code : 'NETWORK';
}
