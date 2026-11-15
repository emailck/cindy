import type { PermissionMode } from '@cindy/maker-core';
import type { PermissionChoice } from './profile';

/** Desktop mapping: full → bypassPermissions; plan is Plan mode on top of ask-first. */
export function permissionOptions(choice: PermissionChoice): { permissionMode: PermissionMode; planMode: boolean } {
  if (choice === 'full') return { permissionMode: 'bypassPermissions', planMode: false };
  if (choice === 'plan') return { permissionMode: 'default', planMode: true };
  return { permissionMode: 'default', planMode: false };
}
