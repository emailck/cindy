import type { ReactNode } from 'react';
import type { Instance } from 'ink';

/**
 * Keep Static mounted while removing live UI, so Ink can return the native caret
 * to the bottom before erasing it. Unmount alone forgets that caret position.
 * The caller supplies the same surface with its disposable UI hidden.
 */
export async function closeChatSurface(instance: Instance, closedSurface: ReactNode, stdout: Pick<NodeJS.WriteStream, 'write'>): Promise<void> {
  try {
    instance.rerender(closedSurface);
    await instance.waitUntilRenderFlush();
    instance.clear();
  } finally {
    try {
      // Inherited focus reporting otherwise sends [I/[O to the restored shell.
      stdout.write('\u001b[?1004l');
    } finally {
      instance.unmount();
      await instance.waitUntilExit();
    }
  }
}
