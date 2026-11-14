import type { SendOptions } from './agents/base-agent.js';
import { isTerminalAgentErrorEvent, type AgentEvent } from './types/events.js';

// Call-local provenance never crosses a wire or comes from provider event fields.
const sendOwners = new WeakMap<SendOptions, { generation: number; terminalStatus: () => 'settled' | 'unsettled' | undefined }>();
const terminalOwners = new WeakMap<AgentEvent, { generation: number; terminalStatus: () => 'settled' | 'unsettled' | undefined }>();

export function bindSessionSendOwner(
  options: SendOptions, generation: number, terminalStatus: () => 'settled' | 'unsettled' | undefined,
): SendOptions {
  sendOwners.set(options, { generation, terminalStatus });
  return options;
}

/** Mark an adapter-synthesized terminal for the exact Session.send that owns it. */
export function markSessionSendTerminal(options: SendOptions | undefined, event: AgentEvent): AgentEvent {
  const owner = options && sendOwners.get(options);
  if (owner !== undefined && event.turnScope !== 'background'
    && (event.type === 'done' || isTerminalAgentErrorEvent(event))) terminalOwners.set(event, owner);
  return event;
}

/** null means a marked terminal whose owning send was rejected or superseded. */
export function readSessionSendTerminalOwner(event: AgentEvent): number | null | undefined {
  const owner = terminalOwners.get(event);
  if (!owner) return undefined;
  // Recheck when consumed: a terminal can be queued before send rejects, and
  // the next accepted send can reuse the rolled-back generation number.
  return owner.terminalStatus() === undefined ? null : owner.generation;
}

/** Read the owning Session after queued provider events have been consumed. */
export function readSessionSendTerminalStatus(options: SendOptions | undefined): 'settled' | 'unsettled' | undefined {
  return options && sendOwners.get(options)?.terminalStatus();
}
