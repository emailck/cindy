export { createHostAuthService } from './service.js';
export type { HostAuthOptions, HostAuthService, HostLoginResult } from './service.js';
export { getOrCreateDeviceIdentity, HostAuthError } from './store.js';
export type { ProtectedCredentialStore } from './store.js';
export { runAuthCommand } from './command.js';
export type { AuthCommandContext } from './command.js';
