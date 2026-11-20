/**
 * Terminal task state, independent of the renderer: slash commands, remote events → transcript,
 * and the single interaction channel (Agent permissions, questions, plans, and the local
 * shared-provider credential confirmations all arrive through setInteractionResolver).
 * Never fabricates a user decision: aborted prompts resolve as dismissed/deny.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { AgentEvent, AgentSessionHandle, AskUserQuestionItem, Effort, InteractionDecision, InteractionRequest, UserContentBlock, UserMessage } from '@cindy/maker-core';
import { readTokenSpeedSnapshot } from '@cindy/maker-shared/usage-format';
import { parseShareAgentDeviceId, type CatalogModel, type CatalogResult, type CatalogSource } from '../catalog';
import { createTranslator, type Language, type MessageKey, type Translate } from '../i18n';
import type { ModelChoice, PermissionChoice } from '../profile';
import { permissionOptions } from '../permissions';
import { shareFailure } from '../received';
import type { RemoteTaskRequest } from '../session';
import { taskTitle, type TaskRecord, type TaskStore } from '../store';
import { fenceAfter, stableMarkdownEnd } from './markdown';
import {
  builtinName, commandText, GROUPED_TOOLS, SUBAGENT_TOOLS, toolDetail, toolOutput,
  type DiffRow, type ReadText, type ToolDetail,
} from './tools';
import { commandAvailable, commandHelpRows, resolveCommand } from './commands';
export { COMMANDS, commandDescription, commandSuggestions } from './commands';
import { isThemeSetting, resolveTheme, THEME_SETTINGS, type ThemeName, type ThemeSetting } from './theme';

/** A tool call a sub-Agent made, shown under the call that started it. */
export interface ChildTool { id: string; name: string; summary: string; done?: boolean; error?: boolean }
/** What the host reports about a sub-Agent run (agent_task_update). */
export interface TaskProgress { toolUses?: number; totalTokens?: number; durationMs?: number }
/** One read / search call inside a collapsed group. */
export interface GroupItem { id: string; name: string; summary: string; result?: string; error?: boolean; interrupted?: boolean }

/** An image going with a message: a local file the remote proxy reads and sends along. */
export interface ImageAttachment { path: string; mimeType: string }

/** A message to send: what goes to the Agent, what the transcript shows, and images going with it. */
export interface Outgoing { text: string; display?: string; images?: readonly ImageAttachment[] }

export type Line =
  | { id: string; kind: 'user'; text: string; /** Sent into the running turn (插话). */ steer?: boolean }
  /**
   * cont: a later piece of the same reply, committed in stable blocks while streaming (no gap before it).
   * code: the piece starts inside a code fence opened by an earlier piece.
   */
  | { id: string; kind: 'assistant'; text: string; cont?: boolean; code?: boolean }
  /**
   * name is the tool's own name; result is its output (bounded, truncated when cut), summarized by the renderer.
   * interrupted: the turn was interrupted before a result came. Sub-Agent calls keep their last few tool calls
   * (children), how many there were, and the host's progress figures.
   */
  | { id: string; kind: 'tool'; name: string; summary: string; detail?: ToolDetail; result?: string; error?: boolean; truncated?: boolean;
    interrupted?: boolean; children?: ChildTool[]; childCount?: number; task?: TaskProgress }
  /** Read / search calls that followed each other, shown as one row. */
  | { id: string; kind: 'group'; items: GroupItem[] }
  /** A finished thinking block; its text is shown in the Ctrl+O viewer. */
  | { id: string; kind: 'thinking'; text: string; durationMs?: number }
  /** Marks where the user interrupted the turn. */
  | { id: string; kind: 'interrupted' }
  /** `!command`: run on this computer by the user; its output goes with the next message. */
  | { id: string; kind: 'local'; command: string; output?: string; exitCode?: number | null; running?: boolean }
  | { id: string; kind: 'notice'; text: string; tone: 'info' | 'warn' | 'error' }
  /** /help and ?: operations grouped by situation; each row is [keys, what it does]. */
  | { id: string; kind: 'help'; sections: HelpSection[] };

/** Last sub-Agent tool calls kept under the call that started it. */
export const CHILD_ROWS = 3;

/**
 * The read / search group still open for more calls: the last group line when only thinking rows follow it.
 * The view keeps it (and what follows) out of the printed history while the turn runs, so it can still grow.
 */
export function openGroupIndex(lines: readonly Line[]): number {
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!;
    if (line.kind === 'group') return index;
    if (line.kind !== 'thinking') return -1;
  }
  return -1;
}

export interface HelpSection { title: string; rows: Array<[string, string]> }

type LineInput = Line extends infer L ? (L extends Line ? Omit<L, 'id'> : never) : never;

export interface Choice { label: string; detail?: string; group?: string; /** Shown but not selectable. */ disabled?: boolean }

/** One provider on one computer (or one share): the first step of /model. */
export interface ProviderGroup { key: string; label: string; models: CatalogModel[] }

/**
 * Groups models by Agent computer + provider, in catalog order. Identical labels (the same sharer
 * sharing the same provider twice) get "(2)", "(3)" like Desktop's model list.
 */
export function groupModels(models: readonly CatalogModel[]): ProviderGroup[] {
  const groups = new Map<string, ProviderGroup>();
  for (const model of models) {
    const key = `${model.target}\0${model.providerId}`;
    let group = groups.get(key);
    if (!group) { group = { key, label: `${model.providerName} · ${model.targetLabel}`, models: [] }; groups.set(key, group); }
    group.models.push(model);
  }
  const seen = new Map<string, number>();
  return [...groups.values()].map(group => {
    const count = (seen.get(group.label) ?? 0) + 1;
    seen.set(group.label, count);
    return count === 1 ? group : { ...group, label: `${group.label} (${count})` };
  });
}

export type Prompt =
  | { kind: 'picker'; title: string; choices: Choice[]; index: number; /** Esc returns to the previous step. */ back?: boolean; searchable?: boolean }
  /** feedback: typed text denies the call and tells the Agent why (not for confirmations this computer owns). */
  | { kind: 'permission'; title: string; summary: string; description?: string; preview?: PermissionPreview; choices: Choice[]; index: number; feedback: boolean }
  | { kind: 'question'; question: AskUserQuestionItem; position: string; choices: Choice[]; index: number; /** Multi-select: toggled option indexes. */ selected: number[] }
  | { kind: 'plan'; plan: string; choices: Choice[]; index: number };

/**
 * What a confirmation shows of the call before it runs: an edit's diff, the start of a file being written,
 * or a command in full. `more` counts the rows left out.
 */
export type PermissionPreview =
  | { kind: 'diff'; rows: DiffRow[]; more: number }
  | { kind: 'write'; rows: string[]; more: number }
  | { kind: 'command'; rows: string[]; more: number };

export interface ChatSnapshot {
  lines: readonly Line[];
  /** Streaming assistant text not yet committed: an unfinished line or structural Markdown block. */
  live: string;
  /** live continues an assistant line already committed during this reply (rendered without a gap). */
  liveCont: boolean;
  /** live is inside a code fence. */
  liveCode: boolean;
  phase: 'idle' | 'connecting' | 'running';
  thinking: boolean;
  /** When the running turn started (elapsed time in the status line). */
  turnStartedAt: number | null;
  prompt: Prompt | null;
  model: CatalogModel | null;
  permission: PermissionChoice;
  effort: string | null;
  language: Language;
  /** Colors in use, and the setting they come from (/theme). */
  theme: ThemeName;
  themeSetting: ThemeSetting;
  /** Messages typed during a turn; sent one per turn, in order, after the current turn ends. */
  queue: readonly QueuedMessage[];
  /** Interrupts and errors pause the queue (Desktop parity); Enter on an empty line resumes. */
  queuePaused: boolean;
  exitArmed: boolean;
  exited: boolean;
  /** Status bar figures for the open task; null until the Agent reports usage. */
  usage: UsageView | null;
  /** A `!command` is running on this computer (Esc stops it). */
  localRunning: boolean;
  /** `!command` results waiting to go with the next message. */
  localPending: number;
}

/** Usage shown in the status bar, from the Agent's status events (UsageSnapshot). */
export interface UsageView {
  /** Context taken by the last model request. */
  contextTokens: number;
  /** 0 when the Agent does not report its context window. */
  contextWindow: number;
  /** Output tok/s of this turn: live while streaming, the turn's average once it ended. Null when not measured reliably. */
  turnRate: number | null;
  /** Output tokens over generation time (tool waits excluded) across this task's turns. */
  averageRate: number | null;
  /** Cost the Agent reports for this task in USD; 0 when it reports none (Codex, subscriptions). */
  costUsd: number;
  /** Tokens this task sent and received, summed over models; null until the Agent reports request receipts. */
  tokens: TokenTotals | null;
}

/** Input excludes cache reads and writes (every Agent reports it uncached), as in Desktop's usage figures. */
export interface TokenTotals { input: number; output: number; cacheRead: number; cacheWrite: number }

const NO_TOKENS: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const TOKEN_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;

function sumTokens(parts: TokenTotals[]): TokenTotals {
  const total = { ...NO_TOKENS };
  for (const part of parts) for (const key of TOKEN_KEYS) total[key] += part[key];
  return total;
}

/** Desktop's formula: cache read / (input + cache read + cache write); null before any input. */
export function cacheHitRate(tokens: TokenTotals): number | null {
  const denominator = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  return denominator > 0 ? tokens.cacheRead / denominator : null;
}

interface SpeedSample { tokens: number; ms: number }

export interface QueuedMessage extends Outgoing { id: string }

/** Output of a `!command`; exitCode is null when it was stopped or could not start. */
export interface LocalResult { output: string; exitCode: number | null }

/** Where a path in a message points, for `@` mentions. */
export type PathKind = 'file' | 'dir' | null;

export interface ChatDeps {
  workingDir: string;
  language: Language;
  permission: PermissionChoice;
  /** Model id from --model, or the saved choice. */
  initialModel?: string | ModelChoice;
  account?: { displayName?: string; email?: string } | null;
  catalog(): Promise<CatalogResult>;
  openTask(request: RemoteTaskRequest): Promise<AgentSessionHandle>;
  tasks: TaskStore;
  saveLanguage?(language: Language): Promise<void>;
  /** Explicit per-share local trust; status and mutations revalidate membership. */
  shareTrust?(shareId: string, enabled?: boolean): Promise<{ name: string; enabled: boolean }>;
  saveModel?(choice: ModelChoice): Promise<void>;
  /** Saved /theme choice and what was detected about the terminal at startup. */
  theme?: { setting: ThemeSetting; background: 'dark' | 'light' | null; depth: ThemeName | null };
  saveTheme?(setting: ThemeSetting): Promise<void>;
  /** False when ripgrep is missing: warn once at startup. */
  searchAvailable?: boolean;
  /** False on Windows without Git Bash: warn once at startup. */
  shellAvailable?: boolean;
  now?(): number;
  /** Draws attention (terminal bell): a long turn finished, or a running turn waits for the user's decision. */
  notify?(event: 'done' | 'waiting'): void;
  /** Typed input remembered across runs, per project directory (↑ and Ctrl+R). */
  history?: InputHistory;
  /** A local file's text (diff line numbers and context); null when it cannot be read. */
  readText?: ReadText;
  /** Whether an absolute local path is a file or a directory (`@` mentions). */
  statPath?(absolute: string): PathKind;
  /** Project files and directories relative to the working directory (`@` completion); directories end with /. */
  listFiles?(): Promise<string[]>;
  /** Runs a `!command` in the working directory on this computer. */
  runLocal?(command: string, signal: AbortSignal): Promise<LocalResult>;
  /** Saves an image on the clipboard to a temporary file; null when the clipboard holds no image. */
  clipboardImage?(): Promise<ImageAttachment | null>;
}

export interface InputHistory {
  /** Oldest first. */
  load(workingDir: string): Promise<string[]>;
  add(workingDir: string, text: string): Promise<void>;
}

/** A turn at least this long rings when it ends; shorter ones were watched anyway. */
export const NOTIFY_AFTER_MS = 10_000;

/** What `cindy` prints after the interactive UI closes. */
export interface ExitSummary { tokens: TokenTotals | null; costUsd: number; workMs: number; turns: number }

/** Image types the Agents accept as message attachments. */
export const IMAGE_TYPES: Readonly<Record<string, string>> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

/** A `!command`'s output kept for the transcript and the next message. */
const LOCAL_OUTPUT_KEEP = 30_000;

/** The operations guide shown by /help and ?. Keys are literal; descriptions follow the interface language. */
export function helpSections(t: Translate): HelpSection[] {
  const row = (keys: string, key: MessageKey): [string, string] => [keys, t(key)];
  return [
    { title: t('help.titleCommands'), rows: commandHelpRows(t) },
    { title: t('help.titleInput'), rows: [
      row('Enter', 'help.send'), row('\\ + Enter · Ctrl+J', 'help.newline'), row('↑ / ↓', 'help.history'),
      row('/ · Tab', 'help.complete'), row('@', 'help.mention'), row('!', 'help.local'),
      row('Ctrl+V · Alt+V', 'help.pasteImage'), row('Esc · Ctrl+U', 'help.clearInput'),
      row('Alt+← / → · Ctrl+W · Ctrl+K', 'help.editing'), row('Ctrl+A / Ctrl+E', 'help.lineStart'),
    ] },
    { title: t('help.titleView'), rows: [
      row('Ctrl+O', 'help.expand'), row(t('help.keyViewer'), 'help.viewerKeys'),
    ] },
    { title: t('help.titleRunning'), rows: [
      row('Enter', 'help.queue'), row('Ctrl+S', 'help.steer'), row(t('help.keyUpEmpty'), 'help.takeBack'), row('Esc · Ctrl+C', 'help.interrupt'),
    ] },
    { title: t('help.titleChoices'), rows: [
      row('↑ / ↓ · Enter', 'help.choose'), row('1–9', 'help.chooseNumber'), row(t('help.keySpace'), 'help.toggle'),
      row('Esc', 'help.cancelChoice'), row(t('help.keyType'), 'help.typeAnswer'),
    ] },
    { title: t('help.titleOther'), rows: [
      row('Shift+Tab', 'help.cyclePermission'), row(t('help.keyQuestion'), 'help.showHelp'), row('Ctrl+C ×2', 'help.exit'), row('cindy -c', 'help.continue'),
    ] },
  ];
}

/** One-line summary of a tool call input for the transcript. */
export function toolSummary(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const record = input as Record<string, unknown>;
  for (const key of ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      const line = value.trim().split('\n')[0]!;
      return line.length > 120 ? `${line.slice(0, 119)}…` : line;
    }
  }
  return '';
}

type Pending =
  | { kind: 'picker'; choose(index: number): void | Promise<void>; back?: () => void }
  | { kind: 'permission'; decisions: InteractionDecision[]; resolve(decision: InteractionDecision): void }
  | { kind: 'question'; queue: AskUserQuestionItem[]; answers: Record<string, string>; resolve(decision: InteractionDecision): void }
  | { kind: 'plan'; resolve(decision: InteractionDecision): void };

export class ChatController {
  private listeners = new Set<() => void>();
  private snapshot: ChatSnapshot;
  private t: Translate;
  private handle: AgentSessionHandle | null = null;
  private sessionId: string = randomUUID();
  private resumeSessionId: string | undefined;
  private title = '';
  private pending: Pending | null = null;
  /** Tool call id → the transcript line showing it (a group or sub-Agent parent for grouped / child calls). */
  private tools = new Map<string, { line: string; role: 'tool' | 'group' | 'child' }>();
  /** The thinking block being streamed: its text so far and when it started. */
  private thinkingText = '';
  private thinkingStarted: number | null = null;
  /** `!command` outputs not sent yet, and the one running. */
  private localContext: string[] = [];
  private localAbort: AbortController | null = null;
  /** `@` completion: project paths, loaded on first use. */
  private files: string[] | null = null;
  private filesLoading = false;
  /** Lines from here on belong to the open task and are not in its saved transcript yet. */
  private persisted = 0;
  /** Time spent in turns and how many there were in this task (the exit summary). */
  private workMs = 0;
  private turns = 0;
  private models: CatalogModel[] = [];
  private exitTimer: ReturnType<typeof setTimeout> | undefined;
  private exitWaiters: Array<() => void> = [];
  private turnWaiters: Array<() => void> = [];
  /** Raw text of the reply being streamed, and how much of it is already committed to lines. */
  private streamed = '';
  private flushed = 0;
  /** A code fence is open at the end of the committed part of the reply. */
  private fence = false;
  /** Generation of finished turns, the running turn's latest sample, and the turn just folded (a late repeat of it is ignored). */
  private speedDone: SpeedSample = { tokens: 0, ms: 0 };
  private speedTurn: SpeedSample | null = null;
  private speedFolded: SpeedSample | null = null;
  /** Reported cost restarts when the remote Agent process does; earlier totals are kept in costBase. */
  private costBase = 0;
  private costLast = 0;
  /**
   * Request receipts are cumulative per Agent process (epoch) and per model. A new epoch starts from zero: the
   * finished epochs' totals stay in tokenBase.
   */
  private tokenEpoch: string | null = null;
  private tokenModels = new Map<string, TokenTotals>();
  private tokenBase: TokenTotals = NO_TOKENS;

  constructor(private readonly deps: ChatDeps) {
    this.t = createTranslator(deps.language);
    this.snapshot = { lines: [], live: '', liveCont: false, liveCode: false, phase: 'idle', thinking: false, turnStartedAt: null, prompt: null, model: null,
      permission: deps.permission, effort: null, language: deps.language, queue: [],
      theme: resolveTheme(deps.theme?.setting ?? 'auto', { background: deps.theme?.background ?? null, depth: deps.theme?.depth ?? null }),
      themeSetting: deps.theme?.setting ?? 'auto', queuePaused: false, exitArmed: false, exited: false, usage: null, localRunning: false, localPending: 0 };
  }

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;
  translate(): Translate { return this.t; }

  private update(patch: Partial<ChatSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
  private push(line: LineInput) { this.update({ lines: [...this.snapshot.lines, { ...line, id: randomUUID() } as Line] }); }
  private notice(key: MessageKey, vars?: Record<string, string | number>, tone: 'info' | 'warn' | 'error' = 'info') { this.push({ kind: 'notice', text: this.t(key, vars), tone }); }
  private where(model: CatalogModel) { return `${model.providerName} · ${model.targetLabel}`; }
  /** Paths inside the project directory read relative to it in the transcript. */
  private relative(path: string) {
    const root = this.deps.workingDir.replace(/[\\/]+$/, '');
    return path.startsWith(`${root}/`) || path.startsWith(`${root}\\`) ? path.slice(root.length + 1) : path;
  }

  /** Loads models and applies the initial choice. */
  async init(): Promise<void> {
    if (this.deps.shellAvailable === false) this.notice('chat.gitBashMissing', undefined, 'warn');
    if (this.deps.searchAvailable === false) this.notice('chat.ripgrepMissing', undefined, 'warn');
    this.notice('chat.loadingModels');
    const { models, unavailable } = await this.deps.catalog().catch(() => ({ models: [], unavailable: [] } as CatalogResult));
    this.models = models;
    if (unavailable.length) this.notice('chat.unavailableSources', { names: unavailable.map(source => source.label).join(', ') }, 'warn');
    if (!models.length) { this.notice('chat.noModels', undefined, 'warn'); return; }
    const wanted = this.deps.initialModel;
    const found = typeof wanted === 'string'
      ? models.find(model => model.model === wanted)
      : wanted ? models.find(model => model.target === wanted.target && model.providerId === wanted.providerId && model.model === wanted.model) : undefined;
    if (typeof wanted === 'string' && !found) this.notice('chat.modelUnavailable', { model: wanted }, 'warn');
    const model = found ?? models[0]!;
    this.update({ model, effort: model.defaultEffort });
    this.notice('chat.modelSelected', { model: model.modelName, where: this.where(model) });
  }

  // ─── Input ──────────────────────────────────────────────────────────

  /**
   * Typed input. `extra` carries what the input box resolved: the text the transcript shows (pasted text stays
   * a placeholder there) and images pasted into the message.
   */
  async submit(raw: string, extra: { display?: string; images?: readonly ImageAttachment[] } = {}): Promise<void> {
    const text = raw.trim();
    if (!text && !extra.images?.length) { if (!this.pending) this.resumeQueue(); return; }
    if (this.pending?.kind === 'question') { this.answerQuestion(text); return; }
    if (this.pending?.kind === 'plan') { this.planFeedback(text); return; }
    if (this.pending?.kind === 'permission' && this.snapshot.prompt?.kind === 'permission' && this.snapshot.prompt.feedback) { this.denyWithReason(text); return; }
    if (this.pending) return;
    if (text.startsWith('/')) { await this.command(text); return; }
    if (text.startsWith('!')) { await this.runLocal(text.slice(1).trim()); return; }
    const message: Outgoing = { text, ...(extra.display && extra.display.trim() !== text ? { display: extra.display.trim() } : {}), ...(extra.images?.length ? { images: extra.images } : {}) };
    // Typing during a turn queues the message (Desktop 「排队发送」); Ctrl+S steers instead.
    if (this.snapshot.phase !== 'idle') { this.enqueue(message); return; }
    await this.send(message);
  }

  private enqueue(message: Outgoing) { this.update({ queue: [...this.snapshot.queue, { ...message, id: randomUUID() }] }); }

  /** ↑ on an empty line: take the last queued message back into the editor (as it was shown). */
  popQueued(): QueuedMessage | null {
    const queue = this.snapshot.queue;
    const last = queue.at(-1);
    if (!last) return null;
    this.update({ queue: queue.slice(0, -1), ...(queue.length === 1 ? { queuePaused: false } : {}) });
    return last;
  }

  /** Sends the next queued message when idle and not paused. */
  resumeQueue(): void {
    if (this.snapshot.queuePaused) this.update({ queuePaused: false });
    this.drainQueue();
  }

  private drainQueue() {
    const [next, ...rest] = this.snapshot.queue;
    if (!next || this.snapshot.queuePaused || this.snapshot.phase !== 'idle' || this.pending || this.snapshot.exited) return;
    this.update({ queue: rest });
    void this.send(next);
  }

  /**
   * Ctrl+S (插话): put a message into the running turn without interrupting it; the Agent handles it
   * after its current action. Empty input steers the first queued message. When nothing is running,
   * the message is simply sent.
   */
  async steer(raw: string, extra: { display?: string; images?: readonly ImageAttachment[] } = {}): Promise<'steered' | 'sent' | 'queued' | 'none'> {
    const typed = raw.trim();
    const queued = !typed && !extra.images?.length ? this.snapshot.queue[0] : undefined;
    const message: Outgoing = queued ?? { text: typed, ...(extra.display && extra.display.trim() !== typed ? { display: extra.display.trim() } : {}), ...(extra.images?.length ? { images: extra.images } : {}) };
    if ((!message.text && !message.images?.length) || this.pending) return 'none';
    if (message.text.startsWith('/') || message.text.startsWith('!')) { await this.submit(message.text); return 'sent'; }
    if (queued) this.update({ queue: this.snapshot.queue.slice(1) });
    const handle = this.handle;
    if (this.snapshot.phase !== 'running' || !handle) { await this.send(message); return 'sent'; }
    try {
      await handle.steer(this.userMessage(message));
      this.commitLive();
      this.push({ kind: 'user', text: message.display ?? message.text, steer: true });
      return 'steered';
    } catch {
      // Never lose the message: it goes to the front of the queue.
      this.update({ queue: [{ ...message, id: randomUUID() }, ...this.snapshot.queue] });
      this.notice('chat.steerFailed', undefined, 'warn');
      return 'queued';
    }
  }

  /** Shift+Tab: full → normal → plan → full. */
  async cyclePermission(): Promise<void> {
    if (this.pending) return;
    const order: PermissionChoice[] = ['full', 'normal', 'plan'];
    await this.setPermission(order[(order.indexOf(this.snapshot.permission) + 1) % order.length]!);
  }

  /**
   * What the Agent receives: earlier `!command` results first, then the text; `@path` mentions of existing project
   * paths and pasted images go along as blocks (the remote proxy maps paths and sends image bytes, as for Desktop).
   * Plain text stays a string.
   */
  private userMessage(message: Outgoing): UserMessage {
    const context = this.localContext.splice(0);
    if (context.length) this.update({ localPending: 0 });
    const text = [...context, message.text].filter(Boolean).join('\n\n');
    const blocks: UserContentBlock[] = [];
    const seen = new Set<string>();
    for (const mention of mentionPaths(message.text)) {
      const absolute = path.resolve(this.deps.workingDir, mention);
      const kind = this.deps.statPath?.(absolute) ?? null;
      if (!kind || seen.has(absolute)) continue;
      seen.add(absolute);
      blocks.push({ type: 'mention', name: path.basename(absolute) || absolute, path: absolute, kind });
    }
    for (const image of message.images ?? []) blocks.push({ type: 'image', path: image.path, mimeType: image.mimeType });
    return { type: 'user', content: blocks.length ? [{ type: 'text', text }, ...blocks] : text };
  }

  private async send(message: Outgoing): Promise<void> {
    if (this.snapshot.phase !== 'idle') { this.enqueue(message); return; }
    const model = this.snapshot.model;
    if (!model) { this.notice('chat.noModel', undefined, 'warn'); return; }
    this.push({ kind: 'user', text: message.display ?? message.text });
    if (!this.title) this.title = taskTitle(message.display ?? message.text);
    const handle = await this.ensureHandle(model);
    if (!handle) return;
    // A new request: the last turn counts toward the average, its own speed is no longer "this turn".
    this.foldSpeed();
    const usage = this.snapshot.usage;
    this.update({ phase: 'running', thinking: false, turnStartedAt: (this.deps.now ?? Date.now)(), ...(usage ? { usage: { ...usage, turnRate: null } } : {}) });
    try { await handle.send(this.userMessage(message)); }
    catch (error) {
      this.notice('chat.error', { message: errorText(error) }, 'error');
      this.finishTurn('error');
    }
  }

  // ─── Local commands, mentions, pasted images ────────────────────────

  /** `!command`: runs here in the working directory; the output is shown and goes with the next message. */
  private async runLocal(command: string): Promise<void> {
    if (!command) return;
    const run = this.deps.runLocal;
    if (!run) { this.notice('chat.unsupported', { name: '!' }, 'warn'); return; }
    if (this.localAbort) { this.notice('chat.localBusy', undefined, 'warn'); return; }
    const lineId = randomUUID();
    this.update({ lines: [...this.snapshot.lines, { id: lineId, kind: 'local', command, running: true }], localRunning: true });
    const abort = new AbortController();
    this.localAbort = abort;
    let result: LocalResult;
    try { result = await run(command, abort.signal); }
    catch (error) { result = { output: errorText(error), exitCode: null }; }
    finally { this.localAbort = null; }
    const output = result.output.replace(/\s+$/, '');
    const kept = output.length > LOCAL_OUTPUT_KEEP ? `${output.slice(0, LOCAL_OUTPUT_KEEP)}\n…` : output;
    this.localContext.push([
      'The user ran this command on their own computer, in the project directory, before writing the message below:',
      `$ ${command}`, kept || '(no output)', result.exitCode === null ? '(stopped before it finished)' : `(exit code ${result.exitCode})`,
    ].join('\n'));
    this.update({
      lines: this.snapshot.lines.map(line => (line.id === lineId && line.kind === 'local' ? { id: lineId, kind: 'local', command, output: kept, exitCode: result.exitCode } : line)),
      localRunning: false, localPending: this.localContext.length,
    });
  }

  /** Inputs remembered for this project directory, oldest first; empty without a store or when it cannot be read. */
  loadHistory(): Promise<string[]> {
    return this.deps.history?.load(this.deps.workingDir).catch(() => []) ?? Promise.resolve([]);
  }

  /** Remembers a sent input for later runs; a failure to save never disturbs the session. */
  remember(text: string): void {
    if (text.trim()) void this.deps.history?.add(this.deps.workingDir, text).catch(() => undefined);
  }

  /** The task's totals for the line printed on exit; null when no task was started. */
  exitSummary(): ExitSummary | null {
    if (!this.turns) return null;
    const usage = this.snapshot.usage;
    return { tokens: usage?.tokens ?? null, costUsd: usage?.costUsd ?? 0, workMs: this.workMs, turns: this.turns };
  }

  /** Esc while a `!command` runs: stop it. */
  stopLocal(): boolean {
    if (!this.localAbort) return false;
    this.localAbort.abort();
    return true;
  }

  /**
   * `@` completion: project paths matching `query`, best first (name starts with it, name contains it, path
   * contains it, then its letters in order). The list loads on first use; the view updates once it has.
   */
  fileSuggestions(query: string, limit = 8): string[] {
    if (!this.files) {
      if (!this.filesLoading && this.deps.listFiles) {
        this.filesLoading = true;
        void this.deps.listFiles().then(files => { this.files = files; }, () => { this.files = []; })
          .finally(() => { this.filesLoading = false; this.update({}); });
      }
      return [];
    }
    const needle = query.toLowerCase();
    const scored: Array<[number, string]> = [];
    for (const file of this.files) {
      const lower = file.toLowerCase();
      if (needle.endsWith('/') && lower === needle) continue;
      const name = lower.replace(/\/$/, '').split('/').pop()!;
      const score = !needle ? 3 : name.startsWith(needle) ? 0 : name.includes(needle) ? 1 : lower.includes(needle) ? 2 : subsequence(lower, needle) ? 3 : -1;
      if (score >= 0) scored.push([score, file]);
    }
    scored.sort((a, b) => a[0] - b[0] || a[1].length - b[1].length || a[1].localeCompare(b[1]));
    return scored.slice(0, limit).map(([, file]) => file);
  }

  /** A pasted or dropped path to an image file: the image to attach, or null when it is not one. */
  imageFromPath(raw: string): ImageAttachment | null {
    let value = raw.trim();
    if (!value || value.includes('\n')) return null;
    value = value.replace(/^(['"])(.*)\1$/, '$2');
    if (value.startsWith('file://')) { try { value = decodeURIComponent(new URL(value).pathname); } catch { return null; } }
    // Terminals escape spaces in dropped paths.
    value = value.replace(/\\ /g, ' ');
    const mimeType = IMAGE_TYPES[path.extname(value).toLowerCase()];
    if (!mimeType) return null;
    const absolute = path.resolve(this.deps.workingDir, value);
    return this.deps.statPath?.(absolute) === 'file' ? { path: absolute, mimeType } : null;
  }

  /** Ctrl+V / Alt+V: the clipboard's image, or a notice that there is none. */
  async pasteImage(): Promise<ImageAttachment | null> {
    const read = this.deps.clipboardImage;
    if (!read) { this.notice('chat.noClipboardImage', undefined, 'warn'); return null; }
    try {
      const image = await read();
      if (!image) this.notice('chat.noClipboardImage', undefined, 'warn');
      return image;
    } catch (error) {
      this.notice('chat.clipboardFailed', { reason: errorText(error) }, 'warn');
      return null;
    }
  }

  private async ensureHandle(model: CatalogModel): Promise<AgentSessionHandle | null> {
    if (this.handle) return this.handle;
    this.update({ phase: 'connecting' });
    try {
      const handle = await this.deps.openTask({
        target: model.target, agent: model.agent, providerId: model.providerId, model: model.model,
        effort: this.snapshot.effort, permission: this.snapshot.permission, workingDir: this.deps.workingDir,
        sessionId: this.sessionId, ...(this.resumeSessionId ? { resumeSessionId: this.resumeSessionId } : {}),
        credentialNotice: this.t('credential.notice'),
      });
      this.handle = handle;
      handle.setInteractionResolver((request, signal) => this.interaction(request, signal));
      void this.consume(handle);
      this.update({ phase: 'idle' });
      return handle;
    } catch (error) {
      this.update({ phase: 'idle' });
      this.notice('chat.startFailed', { reason: errorText(error) }, 'error');
      return null;
    }
  }

  private async consume(handle: AgentSessionHandle): Promise<void> {
    try {
      for await (const event of handle.events()) {
        if (this.handle !== handle) return;
        this.apply(event);
      }
    } catch (error) {
      if (this.handle === handle) this.notice('chat.error', { message: errorText(error) }, 'error');
    }
    if (this.handle === handle) { this.handle = null; this.finishTurn('closed'); }
  }

  /** Uncommitted part of the reply; a continuation drops the line break that separated it from the committed part. */
  private streamRest() {
    const rest = this.streamed.slice(this.flushed);
    return this.flushed ? rest.replace(/^[ \t]*\n/, '') : rest;
  }

  /**
   * Streamed reply text: stable lines move to history; unfinished structural Markdown blocks stay live.
   * Ink clears the screen and rewrites the whole transcript on every frame once the live area is taller than
   * the terminal, which is what made long replies flicker.
   */
  private streamText(text: string, final: boolean) {
    if (final) {
      // The final event carries the whole reply; keep the streamed text if it does not extend what was already committed.
      if (!this.flushed || text.startsWith(this.streamed.slice(0, this.flushed))) this.streamed = text;
      if (this.snapshot.thinking) this.update({ thinking: false });
      this.commitLive();
      return;
    }
    this.streamed += text;
    const end = this.flushed + stableMarkdownEnd(this.streamed.slice(this.flushed));
    const raw = end > this.flushed ? this.streamed.slice(this.flushed, end) : '';
    const piece = this.flushed ? raw.replace(/^[ \t]*\n/, '') : raw;
    if (piece.trim()) {
      const cont = this.flushed > 0;
      const code = this.fence;
      this.flushed = end;
      this.fence = fenceAfter(piece, code);
      this.update({ lines: [...this.snapshot.lines, { id: randomUUID(), kind: 'assistant', text: piece, cont, ...(code ? { code } : {}) }],
        live: this.streamRest(), liveCont: true, liveCode: this.fence, thinking: false });
    } else this.update({ live: this.streamRest(), liveCont: this.flushed > 0, liveCode: this.fence, thinking: false });
  }

  private commitLive() {
    const rest = this.streamRest().trimEnd();
    const cont = this.flushed > 0;
    const code = this.fence;
    this.streamed = '';
    this.flushed = 0;
    this.fence = false;
    if (!rest.trim()) { if (this.snapshot.live) this.update({ live: '', liveCont: false, liveCode: false }); return; }
    this.update({ lines: [...this.snapshot.lines, { id: randomUUID(), kind: 'assistant', text: rest, cont, ...(code ? { code } : {}) }], live: '', liveCont: false, liveCode: false });
  }

  apply(event: AgentEvent): void {
    const data = (event.data && typeof event.data === 'object' ? event.data : {}) as Record<string, unknown>;
    const parent = event.agentMeta && typeof (event.agentMeta as { parentUuid?: unknown }).parentUuid === 'string'
      ? (event.agentMeta as { parentUuid: string }).parentUuid : null;
    switch (event.type) {
      case 'text': {
        if (parent) return; // a sub-Agent's text: its result comes back to the call that started it
        const text = typeof data.text === 'string' ? data.text : '';
        this.streamText(text, data.isFinal === true);
        return;
      }
      case 'thinking': {
        if (parent) return;
        this.applyThinking(data);
        return;
      }
      case 'tool_use': {
        const id = typeof data.toolUseId === 'string' ? data.toolUseId : randomUUID();
        const name = builtinName(String(data.toolName ?? 'tool'));
        const summary = this.relative(toolSummary(data.input));
        const owner = parent ? this.tools.get(parent) : undefined;
        if (owner && owner.role === 'tool') { this.addChild(owner.line, { id, name, summary }); return; }
        this.commitLive();
        if (GROUPED_TOOLS.has(name)) { this.addGrouped({ id, name, summary }); return; }
        const lineId = randomUUID();
        this.tools.set(id, { line: lineId, role: 'tool' });
        const detail = toolDetail(name, data.input, this.deps.readText);
        if (detail && detail.kind !== 'todos') detail.path = this.relative(detail.path);
        this.update({ thinking: false, lines: [...this.snapshot.lines, { id: lineId, kind: 'tool', name, summary, ...(detail ? { detail } : {}) }] });
        return;
      }
      case 'tool_result_full': {
        const owner = typeof data.toolUseId === 'string' ? this.tools.get(data.toolUseId) : undefined;
        if (!owner || typeof data.fullText !== 'string') return;
        const { output, error: tagged, truncated } = toolOutput(data.fullText);
        const error = tagged || data.isError === true;
        const toolUseId = data.toolUseId as string;
        this.update({ lines: this.snapshot.lines.map(line => {
          if (line.id !== owner.line) return line;
          if (owner.role === 'child' && line.kind === 'tool') {
            return { ...line, children: (line.children ?? []).map(child => (child.id === toolUseId ? { ...child, done: true, ...(error ? { error: true } : {}) } : child)) };
          }
          if (owner.role === 'group' && line.kind === 'group') {
            return { ...line, items: line.items.map(item => (item.id === toolUseId ? { ...item, result: output, ...(error ? { error: true } : {}) } : item)) };
          }
          if (line.kind === 'tool') return { ...line, result: output, ...(error ? { error: true } : {}), ...(truncated ? { truncated: true } : {}) };
          return line;
        }) });
        return;
      }
      case 'agent_task_update': {
        const owner = typeof data.parentToolUseId === 'string' ? this.tools.get(data.parentToolUseId) : undefined;
        if (!owner || owner.role !== 'tool') return;
        const usage = (data.usage && typeof data.usage === 'object' ? data.usage : {}) as Record<string, unknown>;
        const figure = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined);
        const task: TaskProgress = {};
        const toolUses = figure(usage.toolUses); const totalTokens = figure(usage.totalTokens); const durationMs = figure(usage.durationMs);
        if (toolUses) task.toolUses = toolUses;
        if (totalTokens) task.totalTokens = totalTokens;
        if (durationMs) task.durationMs = durationMs;
        if (!Object.keys(task).length) return;
        this.update({ lines: this.snapshot.lines.map(line => (line.id === owner.line && line.kind === 'tool' ? { ...line, task: { ...line.task, ...task } } : line)) });
        return;
      }
      case 'error': {
        if (parent) return;
        this.commitLive();
        const message = typeof data.message === 'string' ? data.message : 'error';
        this.push({ kind: 'notice', text: this.t('chat.error', { message }), tone: 'error' });
        const terminal = data.isTerminal ?? (data.willRetry === undefined ? true : !data.willRetry);
        if (terminal) this.finishTurn('error');
        return;
      }
      case 'status': this.applyUsage(data); return;
      case 'done': this.commitLive(); this.finishTurn(); void this.record(); return;
      default: return;
    }
  }

  /** Thinking streams as start → delta… → final; the finished block becomes a transcript row. */
  private applyThinking(data: Record<string, unknown>) {
    const now = (this.deps.now ?? Date.now)();
    if (data.stage === 'start' || (data.stage === 'delta' && this.thinkingStarted === null)) this.thinkingStarted = now;
    if (data.stage === 'delta' && typeof data.text === 'string') this.thinkingText += data.text;
    if (data.stage !== 'final' && data.stage !== 'redacted') { if (!this.snapshot.thinking) this.update({ thinking: true }); return; }
    const text = (typeof data.text === 'string' && data.text ? data.text : this.thinkingText).trim();
    const reported = typeof data.durationMs === 'number' && Number.isFinite(data.durationMs) && data.durationMs >= 0 ? data.durationMs : undefined;
    const durationMs = reported ?? (this.thinkingStarted !== null ? now - this.thinkingStarted : undefined);
    this.thinkingText = '';
    this.thinkingStarted = null;
    if (data.stage === 'final' && text) {
      this.commitLive();
      this.push({ kind: 'thinking', text, ...(durationMs !== undefined ? { durationMs } : {}) });
    }
    this.update({ thinking: false });
  }

  /** A sub-Agent's tool call: counted under the call that started it; only the last few are kept. */
  private addChild(lineId: string, child: ChildTool) {
    this.tools.set(child.id, { line: lineId, role: 'child' });
    this.update({ lines: this.snapshot.lines.map(line => (line.id === lineId && line.kind === 'tool'
      ? { ...line, children: [...(line.children ?? []), child].slice(-CHILD_ROWS), childCount: (line.childCount ?? 0) + 1 } : line)) });
  }

  /** Read / search calls join the open group (see openGroupIndex), or start one. */
  private addGrouped(item: GroupItem) {
    const lines = this.snapshot.lines;
    const open = this.snapshot.phase === 'running' ? openGroupIndex(lines) : -1;
    if (open >= 0) {
      const group = lines[open] as Extract<Line, { kind: 'group' }>;
      this.tools.set(item.id, { line: group.id, role: 'group' });
      this.update({ thinking: false, lines: lines.map((line, index) => (index === open ? { ...group, items: [...group.items, item] } : line)) });
      return;
    }
    const lineId = randomUUID();
    this.tools.set(item.id, { line: lineId, role: 'group' });
    this.update({ thinking: false, lines: [...lines, { id: lineId, kind: 'group', items: [item] }] });
  }

  /**
   * Status events carry the UsageSnapshot fields inline. Placeholder frames omit or zero some of them; those keep
   * the last known value instead of flashing 0. Speed comes from the host's meter (tokenSpeed), or from turn output
   * tokens over generation time; neither is used when the host marks generation timing unreliable.
   */
  private applyUsage(data: Record<string, unknown>) {
    const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);
    const previous = this.snapshot.usage;
    const cost = num(data.costUsd);
    if (cost) {
      if (cost < this.costLast) this.costBase += this.costLast;
      this.costLast = cost;
    }
    let turnRate = previous?.turnRate ?? null;
    const reliable = data.generationReliable !== false;
    const speed = reliable ? readTokenSpeedSnapshot(data.tokenSpeed) : undefined;
    const output = num(data.outputTokens);
    const duration = num(data.generationDurationMs);
    const sample: (SpeedSample & { rate: number }) | null = speed && speed.elapsedMs > 0
      ? { tokens: speed.tokens, ms: speed.elapsedMs, rate: speed.streaming ? speed.rate : speed.average }
      : reliable && output && duration ? { tokens: output, ms: duration, rate: (output * 1000) / duration } : null;
    if (data.generationReliable === false) turnRate = null;
    else if (sample && !(this.speedFolded && this.speedFolded.tokens === sample.tokens && this.speedFolded.ms === sample.ms)) {
      // The meter restarted inside the turn (a continuation): count what it had measured so far.
      if (this.speedTurn && sample.ms < this.speedTurn.ms) this.foldSpeed();
      this.speedTurn = { tokens: sample.tokens, ms: sample.ms };
      this.speedFolded = null;
      turnRate = sample.tokens > 0 ? sample.rate : null;
    }
    const tokens = this.speedDone.tokens + (this.speedTurn?.tokens ?? 0);
    const ms = this.speedDone.ms + (this.speedTurn?.ms ?? 0);
    const usage: UsageView = {
      contextTokens: num(data.contextTokens) || previous?.contextTokens || 0,
      contextWindow: num(data.contextWindow) || previous?.contextWindow || 0,
      turnRate,
      averageRate: tokens > 0 && ms > 0 ? (tokens * 1000) / ms : null,
      costUsd: this.costBase + this.costLast,
      tokens: this.readTokens(data.requestUsage, previous?.tokens ?? null),
    };
    const same = previous && (Object.keys(usage) as Array<keyof UsageView>).every(key => usage[key] === previous[key]);
    if (!same) this.update({ usage });
  }

  /**
   * Task token totals from `requestUsage` ({ epoch, models: [...] }, cumulative per Agent process). Frames without
   * it keep the last totals; a model's count never goes down within an epoch. Returns `previous` when nothing
   * changed, so an unchanged frame does not re-render.
   */
  private readTokens(value: unknown, previous: TokenTotals | null): TokenTotals | null {
    const receipt = value && typeof value === 'object' ? value as { epoch?: unknown; models?: unknown } : null;
    if (!receipt || typeof receipt.epoch !== 'string' || !Array.isArray(receipt.models)) return previous;
    const count = (raw: unknown) => (typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 0);
    if (receipt.epoch !== this.tokenEpoch) {
      this.tokenBase = sumTokens([this.tokenBase, ...this.tokenModels.values()]);
      this.tokenModels = new Map();
      this.tokenEpoch = receipt.epoch;
    }
    for (const raw of receipt.models) {
      if (!raw || typeof raw !== 'object') continue;
      const row = raw as Record<string, unknown>;
      const model = typeof row.model === 'string' && row.model ? row.model : '';
      const last = this.tokenModels.get(model) ?? NO_TOKENS;
      this.tokenModels.set(model, {
        input: Math.max(last.input, count(row.inputTokens)),
        output: Math.max(last.output, count(row.outputTokens)),
        cacheRead: Math.max(last.cacheRead, count(row.cacheReadTokens)),
        cacheWrite: Math.max(last.cacheWrite, count(row.cacheCreateTokens)),
      });
    }
    const next = sumTokens([this.tokenBase, ...this.tokenModels.values()]);
    if (TOKEN_KEYS.every(key => !next[key])) return previous;
    return previous && TOKEN_KEYS.every(key => next[key] === previous[key]) ? previous : next;
  }

  private foldSpeed() {
    if (!this.speedTurn) return;
    this.speedDone = { tokens: this.speedDone.tokens + this.speedTurn.tokens, ms: this.speedDone.ms + this.speedTurn.ms };
    this.speedFolded = this.speedTurn;
    this.speedTurn = null;
  }

  private finishTurn(outcome: 'done' | 'interrupted' | 'error' | 'closed' = 'done') {
    this.commitLive();
    const wasRunning = this.snapshot.phase !== 'idle';
    const started = this.snapshot.turnStartedAt;
    if (wasRunning && started !== null) {
      const took = (this.deps.now ?? Date.now)() - started;
      this.workMs += took;
      this.turns++;
      if (outcome === 'done' && took >= NOTIFY_AFTER_MS) this.deps.notify?.('done');
    }
    if (wasRunning || this.snapshot.thinking) this.update({ phase: 'idle', thinking: false, turnStartedAt: null });
    this.saveTranscript();
    for (const waiter of this.turnWaiters.splice(0)) waiter();
    if (outcome !== 'done') {
      if (this.snapshot.queue.length && !this.snapshot.queuePaused) this.update({ queuePaused: true });
      return;
    }
    if (wasRunning) queueMicrotask(() => this.drainQueue());
  }

  /** Resolves when the current turn has ended (print mode). */
  waitForTurn(): Promise<void> {
    if (this.snapshot.phase === 'idle') return Promise.resolve();
    return new Promise(resolve => { this.turnWaiters.push(resolve); });
  }

  private async record(): Promise<void> {
    const model = this.snapshot.model;
    const handle = this.handle;
    if (!model || !handle) return;
    if (handle.id) this.resumeSessionId = handle.id;
    const record: TaskRecord = { sessionId: this.sessionId, workingDir: this.deps.workingDir, target: model.target, targetLabel: model.targetLabel,
      agent: model.agent, providerId: model.providerId, model: model.model, title: this.title || '…', updatedAt: (this.deps.now ?? Date.now)(),
      ...(this.resumeSessionId ? { resumeSessionId: this.resumeSessionId } : {}) };
    await this.deps.tasks.save(record).catch(() => undefined);
  }

  interrupt(): void {
    if (this.snapshot.phase !== 'running' || !this.handle) return;
    void this.handle.abort().catch(() => undefined);
    this.commitLive();
    // Calls still waiting for a result will not get one: mark them, then where the turn stopped.
    this.update({ lines: this.snapshot.lines.map(line => {
      if (line.kind === 'tool' && line.result === undefined && !line.interrupted && line.detail?.kind !== 'todos') return { ...line, interrupted: true };
      if (line.kind === 'group' && line.items.some(item => item.result === undefined && !item.interrupted)) {
        return { ...line, items: line.items.map(item => (item.result === undefined ? { ...item, interrupted: true } : item)) };
      }
      return line;
    }) });
    this.push({ kind: 'interrupted' });
    this.finishTurn('interrupted');
  }

  /** Ctrl+C: close a prompt, interrupt a turn, then require a second press to exit. */
  ctrlC(): void {
    if (this.pending) { this.cancelPrompt(); return; }
    if (this.snapshot.phase === 'running') { this.interrupt(); return; }
    if (this.snapshot.exitArmed) { void this.exit(); return; }
    this.update({ exitArmed: true });
    this.exitTimer = setTimeout(() => this.update({ exitArmed: false }), 2_000);
    (this.exitTimer as { unref?: () => void }).unref?.();
  }

  async exit(): Promise<void> {
    if (this.snapshot.exited) return;
    if (this.exitTimer) clearTimeout(this.exitTimer);
    this.cancelPrompt();
    this.localAbort?.abort();
    this.saveTranscript();
    const handle = this.handle;
    this.handle = null;
    await handle?.close({ reason: 'navigation' }).catch(() => undefined);
    this.update({ exited: true });
    for (const waiter of this.exitWaiters.splice(0)) waiter();
  }
  whenExited(): Promise<void> { return this.snapshot.exited ? Promise.resolve() : new Promise(resolve => { this.exitWaiters.push(resolve); }); }

  // ─── Prompts ────────────────────────────────────────────────────────

  move(delta: number): void {
    const prompt = this.snapshot.prompt;
    if (!prompt || !prompt.choices.length) return;
    let index = prompt.index;
    for (let step = 0; step < prompt.choices.length; step++) {
      index = (index + delta + prompt.choices.length) % prompt.choices.length;
      if (!prompt.choices[index]!.disabled) break;
    }
    this.update({ prompt: { ...prompt, index } as Prompt });
  }

  choose(index = this.snapshot.prompt?.index ?? 0): void {
    const pending = this.pending;
    if (!pending) return;
    if (pending.kind === 'picker') {
      if (this.snapshot.prompt?.choices[index]?.disabled) return;
      this.clearPrompt(); void pending.choose(index); return;
    }
    if (pending.kind === 'permission') { this.clearPrompt(); pending.resolve(pending.decisions[index] ?? { kind: 'permission', behavior: 'deny' }); return; }
    if (pending.kind === 'plan') { this.clearPrompt(); pending.resolve({ kind: 'plan_review', behavior: index === 0 ? 'allow' : 'deny' }); return; }
    const prompt = this.snapshot.prompt;
    if (prompt?.kind === 'question') {
      const options = prompt.question.options ?? [];
      if (prompt.question.multiSelect && prompt.selected.length && index < options.length) {
        this.answerQuestion(prompt.selected.map(position => options[position]!.label).join(', '));
        return;
      }
      const option = options[index];
      this.answerQuestion(option ? option.label : '');
    }
  }

  /** Space / number keys on a multi-select question. */
  toggle(index = this.snapshot.prompt?.index ?? 0): void {
    const prompt = this.snapshot.prompt;
    if (prompt?.kind !== 'question' || !prompt.question.multiSelect || index >= (prompt.question.options?.length ?? 0)) return;
    const selected = prompt.selected.includes(index) ? prompt.selected.filter(item => item !== index) : [...prompt.selected, index].sort((a, b) => a - b);
    this.update({ prompt: { ...prompt, selected, index } });
  }

  /** Typed text on a confirmation: deny the call and tell the Agent what to do instead. */
  private denyWithReason(text: string) {
    const pending = this.pending;
    if (pending?.kind !== 'permission') return;
    this.clearPrompt();
    pending.resolve({ kind: 'permission', behavior: 'deny', reason: text });
  }

  /** Typed text while a plan is shown: keep planning, with that feedback for the Agent. */
  private planFeedback(text: string) {
    const pending = this.pending;
    if (pending?.kind !== 'plan') return;
    this.clearPrompt();
    pending.resolve({ kind: 'plan_review', behavior: 'deny', reason: text });
  }

  cancelPrompt(): void {
    const pending = this.pending;
    if (!pending) return;
    this.clearPrompt();
    if (pending.kind === 'picker') pending.back?.();
    else if (pending.kind === 'permission') pending.resolve({ kind: 'permission', behavior: 'deny' });
    else if (pending.kind === 'question') pending.resolve({ kind: 'ask_user_question', answers: pending.answers });
    else if (pending.kind === 'plan') pending.resolve({ kind: 'plan_review', behavior: 'deny' });
  }

  private clearPrompt() { this.pending = null; this.update({ prompt: null }); }

  private picker(titleKey: MessageKey, choices: Choice[], choose: (index: number) => void | Promise<void>, index = 0, options: { title?: string; back?: () => void; searchable?: boolean } = {}) {
    this.pending = { kind: 'picker', choose, ...(options.back ? { back: options.back } : {}) };
    const first = choices.findIndex(choice => !choice.disabled);
    const start = choices[index] && !choices[index]!.disabled ? index : Math.max(0, first);
    this.update({ prompt: { kind: 'picker', title: options.title ?? this.t(titleKey), choices, index: start, ...(options.searchable ? { searchable: true } : {}), ...(options.back ? { back: true } : {}) } });
  }

  private interaction(request: InteractionRequest, signal?: AbortSignal): Promise<InteractionDecision> {
    return new Promise(resolve => {
      const dismissed: InteractionDecision = request.kind === 'permission'
        ? { kind: 'permission', behavior: 'deny', reason: 'dismissed' }
        : request.kind === 'ask_user_question' ? { kind: 'ask_user_question', answers: {}, dismissed: true }
          : { kind: 'plan_review', behavior: 'deny', dismissed: true };
      if (signal?.aborted) { resolve(dismissed); return; }
      const settle = (decision: InteractionDecision) => { signal?.removeEventListener('abort', onAbort); resolve(decision); };
      const onAbort = () => { if (this.pending && 'resolve' in this.pending && this.pending.resolve === settle) this.clearPrompt(); resolve(dismissed); };
      signal?.addEventListener('abort', onAbort, { once: true });
      // A newer prompt replaces an unanswered one; the older request is denied, never approved.
      if (this.pending && this.pending.kind !== 'picker') this.cancelPrompt();
      this.commitLive();
      const started = this.snapshot.turnStartedAt;
      if (started !== null && (this.deps.now ?? Date.now)() - started >= NOTIFY_AFTER_MS) this.deps.notify?.('waiting');
      if (request.kind === 'permission') {
        const decisions: InteractionDecision[] = [{ kind: 'permission', behavior: 'allow' }];
        const choices: Choice[] = [{ label: this.t('ask.allowOnce') }];
        if (Array.isArray(request.suggestions) && request.suggestions.length) {
          decisions.push({ kind: 'permission', behavior: 'allow', permissionUpdates: request.suggestions });
          choices.push({ label: this.t('ask.allowSession') });
        }
        decisions.push({ kind: 'permission', behavior: 'deny' });
        choices.push({ label: this.t('ask.deny') });
        this.pending = { kind: 'permission', decisions, resolve: settle };
        const preview = this.permissionPreview(builtinName(request.toolName), request.input);
        this.update({ prompt: { kind: 'permission', title: this.t('ask.permissionTitle', { tool: request.displayName ?? builtinName(request.toolName) }),
          // A command shown in full needs no one-line summary above it. Paths stay absolute: this is a decision.
          summary: preview?.kind === 'command' ? '' : toolSummary(request.input),
          ...(request.description ? { description: request.description } : {}), ...(preview ? { preview } : {}), choices, index: 0,
          // Confirmations this computer raises (shared-provider credentials) answer yes or no only; a reason would be lost.
          feedback: request.metadata?.hostOwnedConfirmation === undefined } });
      } else if (request.kind === 'ask_user_question') {
        this.pending = { kind: 'question', queue: [...request.questions], answers: {}, resolve: settle };
        this.nextQuestion();
      } else {
        this.pending = { kind: 'plan', resolve: settle };
        this.update({ prompt: { kind: 'plan', plan: request.plan, choices: [{ label: this.t('ask.planApprove') }, { label: this.t('ask.planRevise') }], index: 0 } });
      }
    });
  }

  /** What the confirmation shows of the call: the edit's diff, the file's first lines, or the whole command. */
  private permissionPreview(name: string, input: unknown): PermissionPreview | undefined {
    const command = commandText(name, input);
    if (command) {
      const rows = command.split('\n');
      return { kind: 'command', rows, more: 0 };
    }
    const detail = toolDetail(name, input, this.deps.readText);
    if (detail?.kind === 'edit') return { kind: 'diff', rows: detail.rows, more: 0 };
    if (detail?.kind === 'write') {
      const content = (input as Record<string, unknown>).content as string;
      return { kind: 'write', rows: content === '' ? [] : content.replace(/\n$/, '').split('\n'), more: 0 };
    }
    return undefined;
  }

  private nextQuestion() {
    const pending = this.pending;
    if (pending?.kind !== 'question') return;
    const question = pending.queue[0];
    if (!question) { this.clearPrompt(); pending.resolve({ kind: 'ask_user_question', answers: pending.answers }); return; }
    const total = Object.keys(pending.answers).length + pending.queue.length;
    const choices = [...(question.options ?? []).map(option => ({ label: option.label, ...(option.description ? { detail: option.description } : {}) })), { label: this.t('ask.skip') }];
    this.update({ prompt: { kind: 'question', question, position: total > 1 ? `${Object.keys(pending.answers).length + 1}/${total}` : '', choices, index: 0, selected: [] } });
  }

  private answerQuestion(answer: string) {
    const pending = this.pending;
    if (pending?.kind !== 'question') return;
    const question = pending.queue.shift();
    if (question) pending.answers[question.question] = answer;
    this.nextQuestion();
  }

  // ─── Slash commands ─────────────────────────────────────────────────

  private async command(text: string): Promise<void> {
    const [head, ...rest] = text.slice(1).split(/\s+/);
    const command = resolveCommand(head ?? '');
    const arg = rest.join(' ').trim();
    if (!command) { this.notice('chat.unknownCommand', { name: `/${head}` }, 'warn'); return; }
    const busy = !commandAvailable(command, this.snapshot.phase);
    if (busy) { this.notice('chat.busy', undefined, 'warn'); return; }
    switch (command.action) {
      case 'trust': {
        const model = this.snapshot.model;
        const shareId = model?.shared ? parseShareAgentDeviceId(model.target) : null;
        if (!model || !shareId) { this.push({ kind: 'notice', text: this.t('trust.notShared'), tone: 'warn' }); return; }
        if (arg && arg !== 'on' && arg !== 'off') { this.push({ kind: 'notice', text: this.t('trust.usage'), tone: 'warn' }); return; }
        if (!this.deps.shareTrust) { this.notice('chat.unsupported', { name: '/trust' }, 'warn'); return; }
        try {
          const result = await this.deps.shareTrust(shareId, arg ? arg === 'on' : undefined);
          const values = { provider: model.providerName, name: result.name, state: this.t(result.enabled ? 'trust.enabled' : 'trust.disabled') };
          this.push({ kind: 'notice', text: this.t(arg ? result.enabled ? 'trust.on' : 'trust.off' : 'trust.status', values), tone: 'info' });
          this.push({ kind: 'notice', text: this.t('trust.scope'), tone: 'info' });
        } catch (error) { const failure = shareFailure(error); this.notice(failure.messageKey, failure.vars, 'error'); }
        return;
      }
      case 'help': this.push({ kind: 'help', sections: helpSections(this.t) }); return;
      case 'model': return this.modelCommand(arg);
      case 'effort': return this.effortCommand(arg);
      case 'permissions': return this.permissionCommand(arg);
      case 'plan': return this.setPermission(this.snapshot.permission === 'plan' ? this.deps.permission === 'plan' ? 'normal' : this.deps.permission : 'plan');
      case 'compact': {
        const compact = this.handle?.compactSession;
        if (!this.handle) { this.notice('chat.noSession', undefined, 'warn'); return; }
        if (!compact) { this.notice('chat.unsupported', { name: '/compact' }, 'warn'); return; }
        this.notice('chat.compacting');
        try {
          const result = await compact.call(this.handle, arg || undefined);
          this.notice((result as { noop?: boolean })?.noop ? 'chat.compactNoop' : 'chat.compacted');
        } catch (error) { this.notice('chat.error', { message: errorText(error) }, 'error'); }
        return;
      }
      case 'clear': await this.newSession(); this.notice('chat.newSession'); return;
      case 'resume': return this.resumeCommand();
      case 'status': {
        const model = this.snapshot.model;
        const account = this.deps.account?.email ?? this.deps.account?.displayName ?? '—';
        this.push({ kind: 'notice', tone: 'info', text: [
          this.t('chat.statusAccount', { account }),
          this.t('chat.statusWhere', { where: model ? this.where(model) : '—' }),
          this.t('chat.statusModel', { model: model ? `${model.modelName}${this.snapshot.effort ? ` (${this.snapshot.effort})` : ''}` : '—' }),
          this.t('chat.statusPermission', { mode: this.t(`perm.${this.snapshot.permission}` as MessageKey) }),
          this.t('chat.statusCwd', { cwd: this.deps.workingDir }),
          this.t('chat.statusSession', { state: this.handle ? this.t('chat.sessionOpen') : this.t('chat.sessionNone') }),
        ].join('\n') });
        return;
      }
      case 'cost': {
        if (!this.handle) { this.notice('chat.noSession', undefined, 'warn'); return; }
        const usage = this.handle.getUsageSnapshot();
        this.notice('chat.cost', { tokens: usage.tokenUsage.toLocaleString(), cost: usage.costUsd.toFixed(4) });
        return;
      }
      case 'context': {
        if (!this.handle) { this.notice('chat.noSession', undefined, 'warn'); return; }
        try {
          const usage = this.handle.getContextUsage ? await this.handle.getContextUsage() : null;
          if (usage) this.notice('chat.context', { used: usage.totalTokens.toLocaleString(), max: usage.maxTokens.toLocaleString(), percent: Math.round(usage.percentage) });
          else {
            const snapshot = this.handle.getUsageSnapshot();
            const percent = snapshot.contextWindow ? Math.round((snapshot.contextTokens / snapshot.contextWindow) * 100) : 0;
            this.notice('chat.context', { used: snapshot.contextTokens.toLocaleString(), max: snapshot.contextWindow.toLocaleString(), percent });
          }
        } catch (error) { this.notice('chat.error', { message: errorText(error) }, 'error'); }
        return;
      }
      case 'lang': {
        const apply = async (language: Language) => {
          this.t = createTranslator(language);
          this.update({ language });
          await this.deps.saveLanguage?.(language).catch(() => undefined);
          this.notice('chat.language', { lang: language === 'zh' ? '中文' : 'English' });
        };
        if (arg === 'zh' || arg === 'en') return apply(arg);
        this.picker('picker.lang', [{ label: 'English' }, { label: '中文' }], index => apply(index === 0 ? 'en' : 'zh'), this.snapshot.language === 'zh' ? 1 : 0);
        return;
      }
      case 'theme': return this.themeCommand(arg);
      case 'exit': await this.exit(); return;
    }
  }

  private async modelCommand(arg: string): Promise<void> {
    // The picker itself shows unreachable sources; only report them in the transcript when there is no picker.
    const { models, unavailable } = await this.deps.catalog().catch(() => ({ models: this.models, unavailable: [] } as CatalogResult));
    this.models = models;
    const reportUnavailable = () => { if (unavailable.length) this.notice('chat.unavailableSources', { names: unavailable.map(source => source.label).join(', ') }, 'warn'); };
    if (!models.length) { reportUnavailable(); this.notice('chat.noModels', undefined, 'warn'); return; }
    if (arg) {
      const found = models.find(model => model.model === arg || model.modelName.toLowerCase() === arg.toLowerCase());
      if (!found) { reportUnavailable(); this.notice('chat.modelUnavailable', { model: arg }, 'warn'); return; }
      return this.selectModel(found);
    }
    const groups = groupModels(models);
    if (groups.length === 1 && !unavailable.length) { this.modelPicker(groups[0]!); return; }
    this.providerPicker(groups, unavailable);
  }

  /** Step 1: providers, current one highlighted; unreachable sources listed but not selectable. */
  private providerPicker(groups: ProviderGroup[], unavailable: readonly CatalogSource[]): void {
    const current = this.snapshot.model;
    const isCurrent = (group: ProviderGroup) => !!current && group.key === `${current.target}\0${current.providerId}`;
    const choices: Choice[] = [
      ...groups.map(group => ({ label: group.label,
        detail: [this.t('picker.modelCount', { count: group.models.length }), ...(isCurrent(group) ? [this.t('picker.current')] : [])].join(' · ') })),
      ...unavailable.map(source => ({ label: source.label, detail: this.t('picker.unreachable'), disabled: true })),
    ];
    this.picker('picker.provider', choices, index => this.modelPicker(groups[index]!, () => this.providerPicker(groups, unavailable)),
      Math.max(0, groups.findIndex(isCurrent)), { searchable: true });
  }

  /** Step 2: models of one provider; Esc returns to step 1 when there is one. */
  private modelPicker(group: ProviderGroup, back?: () => void): void {
    const current = this.snapshot.model;
    const index = group.models.findIndex(model => current && model.target === current.target && model.providerId === current.providerId && model.model === current.model);
    const choices: Choice[] = group.models.map((model, position) => {
      const detail = [...(model.modelName !== model.model ? [model.model] : []), ...(position === index ? [this.t('picker.current')] : [])].join(' · ');
      return detail ? { label: model.modelName, detail } : { label: model.modelName };
    });
    this.picker('picker.model', choices, choice => this.selectModel(group.models[choice]!), Math.max(0, index),
      { searchable: true, title: this.t('picker.modelOf', { provider: group.label }), ...(back ? { back } : {}) });
  }

  private async selectModel(model: CatalogModel): Promise<void> {
    const previous = this.snapshot.model;
    const effort = model.efforts.includes(this.snapshot.effort ?? '') ? this.snapshot.effort : model.defaultEffort;
    this.update({ model, effort });
    await this.deps.saveModel?.({ target: model.target, providerId: model.providerId, model: model.model }).catch(() => undefined);
    this.notice('chat.modelSelected', { model: model.modelName, where: this.where(model) });
    if (!this.handle || !previous) return;
    if (previous.target !== model.target || !this.handle.setModel) {
      await this.newSession();
      this.notice('chat.modelNewSession', undefined, 'warn');
      return;
    }
    try { await this.handle.setModel(model.model, { providerId: model.providerId, ...(effort ? { effort: effort as Effort } : {}) }); }
    catch (error) { this.notice('chat.error', { message: errorText(error) }, 'error'); }
  }

  private async themeCommand(arg: string): Promise<void> {
    const detected = { background: this.deps.theme?.background ?? null, depth: this.deps.theme?.depth ?? null };
    const label = (setting: ThemeSetting) => setting === 'auto'
      ? this.t('theme.auto', { theme: this.t(`theme.${resolveTheme('auto', detected)}` as MessageKey) })
      : this.t(`theme.${setting}` as MessageKey);
    const apply = async (setting: ThemeSetting) => {
      // Lines already printed keep their colors; everything from here on uses the new theme.
      this.update({ themeSetting: setting, theme: resolveTheme(setting, detected) });
      await this.deps.saveTheme?.(setting).catch(() => undefined);
      this.notice('chat.theme', { theme: label(setting) });
    };
    if (arg) {
      if (!isThemeSetting(arg)) { this.notice('chat.unknownCommand', { name: `/theme ${arg}` }, 'warn'); return; }
      return apply(arg);
    }
    this.picker('picker.theme', THEME_SETTINGS.map(setting => ({ label: label(setting) })), index => apply(THEME_SETTINGS[index]!),
      THEME_SETTINGS.indexOf(this.snapshot.themeSetting));
  }

  private async effortCommand(arg: string): Promise<void> {
    const model = this.snapshot.model;
    if (!model?.efforts.length) { this.notice('chat.effortNone', undefined, 'warn'); return; }
    const apply = async (effort: string) => {
      this.update({ effort });
      try { await this.handle?.setEffort?.(effort as Effort); }
      catch (error) { this.notice('chat.error', { message: errorText(error) }, 'error'); return; }
      this.notice('chat.effort', { effort });
    };
    if (arg) {
      if (!model.efforts.includes(arg)) { this.notice('chat.effortNone', undefined, 'warn'); return; }
      return apply(arg);
    }
    this.picker('picker.effort', model.efforts.map(effort => ({ label: effort })), index => apply(model.efforts[index]!), Math.max(0, model.efforts.indexOf(this.snapshot.effort ?? '')));
  }

  private async permissionCommand(arg: string): Promise<void> {
    const modes: PermissionChoice[] = ['full', 'normal', 'plan'];
    if (arg) {
      if (!modes.includes(arg as PermissionChoice)) { this.notice('chat.unknownCommand', { name: `/permissions ${arg}` }, 'warn'); return; }
      return this.setPermission(arg as PermissionChoice);
    }
    this.picker('picker.permission', modes.map(mode => ({ label: this.t(`perm.${mode}` as MessageKey) })), index => this.setPermission(modes[index]!), modes.indexOf(this.snapshot.permission));
  }

  private async setPermission(mode: PermissionChoice): Promise<void> {
    const handle = this.handle;
    if (handle) {
      const next = permissionOptions(mode);
      try {
        if (handle.setPermissionMode) await handle.setPermissionMode(next.permissionMode);
        if (handle.setPlanMode) await handle.setPlanMode(next.planMode);
        else if (next.planMode) { this.notice('chat.unsupported', { name: '/plan' }, 'warn'); return; }
      } catch (error) { this.notice('chat.error', { message: errorText(error) }, 'error'); return; }
    }
    const wasPlan = this.snapshot.permission === 'plan';
    this.update({ permission: mode });
    if (mode === 'plan') this.notice('chat.planOn');
    else if (wasPlan) this.notice('chat.planOff');
    this.notice('chat.permission', { mode: this.t(`perm.${mode}` as MessageKey) });
  }

  private async newSession(): Promise<void> {
    this.saveTranscript();
    const handle = this.handle;
    this.handle = null;
    this.cancelPrompt();
    await handle?.close({ reason: 'navigation' }).catch(() => undefined);
    this.sessionId = randomUUID();
    this.resumeSessionId = undefined;
    this.title = '';
    this.tools.clear();
    this.streamed = '';
    this.flushed = 0;
    this.fence = false;
    this.speedDone = { tokens: 0, ms: 0 };
    this.speedTurn = null;
    this.speedFolded = null;
    this.costBase = 0;
    this.costLast = 0;
    this.tokenEpoch = null;
    this.tokenModels = new Map();
    this.tokenBase = NO_TOKENS;
    this.thinkingText = '';
    this.thinkingStarted = null;
    // `!command` output belongs to the task it was meant for.
    this.localContext = [];
    this.workMs = 0;
    this.turns = 0;
    this.update({ live: '', liveCont: false, liveCode: false, phase: 'idle', thinking: false, turnStartedAt: null, usage: null, localPending: 0 });
    this.persisted = this.snapshot.lines.length;
  }

  /**
   * Adds what the open task showed since the last save to its local transcript: messages, replies, tool calls,
   * thinking, local commands and errors, with long outputs cut. Nothing is saved before the first message.
   */
  private saveTranscript() {
    const lines = this.snapshot.lines;
    const fresh = lines.slice(this.persisted);
    this.persisted = lines.length;
    if (!this.title || !this.deps.tasks.appendTranscript) return;
    const entries = fresh.flatMap(storedLine);
    if (entries.length) void this.deps.tasks.appendTranscript(this.sessionId, entries).catch(() => undefined);
  }

  private async resumeCommand(): Promise<void> {
    const records = await this.deps.tasks.list(this.deps.workingDir).catch(() => []);
    if (!records.length) { this.notice('chat.resumeNone'); return; }
    this.picker('picker.resume', records.map(record => ({ label: record.title, detail: new Date(record.updatedAt).toLocaleString(), group: `${record.model} · ${record.targetLabel}` })),
      async index => { await this.resumeRecord(records[index]!); }, 0, { searchable: true });
  }

  /** `cindy -c`: continue the most recent session started in this directory. Print mode does not replay it. */
  async continueLatest(options: { replay?: boolean } = {}): Promise<boolean> {
    const [latest] = await this.deps.tasks.list(this.deps.workingDir).catch(() => [] as TaskRecord[]);
    // -c asked for a continuation: say why none happened, also in print mode.
    if (!latest) { this.notice('chat.resumeNone', undefined, 'warn'); return false; }
    return this.resumeRecord(latest, options);
  }

  /**
   * A native resume id belongs to the computer and provider that created it. Resume only when that
   * exact route is still offered; never hand it to whichever model happens to be selected.
   */
  private async resumeRecord(record: TaskRecord, options: { replay?: boolean } = {}): Promise<boolean> {
    const model = this.models.find(item => item.target === record.target && item.providerId === record.providerId && item.model === record.model);
    if (!model) { this.notice('chat.resumeUnavailable', { title: record.title, model: record.model, where: record.targetLabel }, 'warn'); return false; }
    const saved = options.replay === false ? [] : await this.deps.tasks.readTranscript?.(record.sessionId).catch(() => []) ?? [];
    await this.newSession();
    this.sessionId = record.sessionId;
    this.resumeSessionId = record.resumeSessionId;
    this.title = record.title;
    this.update({ model, effort: model.efforts.includes(this.snapshot.effort ?? '') ? this.snapshot.effort : model.defaultEffort });
    // What the task showed before, as it was shown; the most recent part of a long one.
    const restored = saved.flatMap(restoreLine);
    if (restored.length) {
      const shown = restored.slice(-REPLAY_LINES);
      const first = shown[0]!;
      if (first.kind === 'assistant' && first.cont) shown[0] = { ...first, cont: false };
      const earlier = restored.length - shown.length;
      this.notice(earlier ? 'chat.replayEarlier' : 'chat.replay', { count: earlier });
      this.update({ lines: [...this.snapshot.lines, ...shown] });
    }
    this.notice('chat.resumed', { title: record.title });
    this.persisted = this.snapshot.lines.length;
    return true;
  }
}

/** Transcript entries replayed when a task is picked up again; earlier ones are counted. */
export const REPLAY_LINES = 300;

const SAVED_KINDS = new Set(['user', 'assistant', 'tool', 'group', 'thinking', 'interrupted', 'local', 'notice']);

function cut(text: string, limit: number): string { return text.length > limit ? `${text.slice(0, limit)}\n…` : text; }

/** A transcript line as saved: no id, long outputs cut; notices only when they report an error. */
export function storedLine(line: Line): Array<Record<string, unknown>> {
  const { id: _id, ...rest } = line;
  switch (line.kind) {
    case 'tool': return [{ ...rest, ...(line.result !== undefined ? { result: cut(line.result, 4_000), ...(line.result.length > 4_000 ? { truncated: true } : {}) } : {}),
      ...(line.detail?.kind === 'edit' ? { detail: { ...line.detail, rows: line.detail.rows.slice(0, 200) } } : {}) }];
    case 'group': return [{ ...rest, items: line.items.map(item => (item.result !== undefined ? { ...item, result: cut(item.result, 2_000) } : item)) }];
    case 'thinking': return [{ ...rest, text: cut(line.text, 8_000) }];
    case 'local': return [{ ...rest, ...(line.output !== undefined ? { output: cut(line.output, 4_000) } : {}) }];
    case 'user': case 'assistant': return [{ ...rest, text: cut(line.text, 50_000) }];
    case 'interrupted': return [rest];
    case 'notice': return line.tone === 'error' ? [rest] : [];
    default: return [];
  }
}

/**
 * A saved entry back as a transcript line, with a new id. The file is the user's own, but it is still checked
 * for shape; calls that never got a result read as interrupted (the task stopped there).
 */
export function restoreLine(entry: unknown): Line[] {
  if (!entry || typeof entry !== 'object') return [];
  const value = entry as Record<string, unknown>;
  if (typeof value.kind !== 'string' || !SAVED_KINDS.has(value.kind)) return [];
  const text = (key: string) => typeof value[key] === 'string';
  const ok = value.kind === 'user' || value.kind === 'assistant' || value.kind === 'thinking' ? text('text')
    : value.kind === 'tool' ? text('name') && text('summary')
      : value.kind === 'group' ? Array.isArray(value.items) && (value.items as unknown[]).every(item => !!item && typeof item === 'object' && typeof (item as GroupItem).name === 'string' && typeof (item as GroupItem).summary === 'string')
        : value.kind === 'local' ? text('command')
          : value.kind === 'notice' ? text('text') && (value.tone === 'info' || value.tone === 'warn' || value.tone === 'error')
            : true;
  if (!ok) return [];
  const line = { ...value, id: randomUUID() } as Line;
  if (line.kind === 'tool' && line.result === undefined && !line.interrupted && line.detail?.kind !== 'todos') return [{ ...line, interrupted: true }];
  if (line.kind === 'group') return [{ ...line, items: line.items.map(item => (item.result === undefined ? { ...item, interrupted: true } : item)) }];
  if (line.kind === 'local' && line.running) return [{ ...line, running: false, exitCode: null }];
  return [line];
}

/** `@path` and `@"path with spaces"` in a message, without trailing punctuation. */
export function mentionPaths(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/(?:^|\s)@(?:"([^"\n]+)"|([^\s"]+))/g)) {
    const value = match[1] ?? match[2]!.replace(/[,;:!?)\]}。，；：！？）]+$/u, '');
    if (value) found.push(value);
  }
  return found;
}

/** The input's mention completion token: `@` and what follows it up to the cursor, if the cursor is in one. */
export function mentionAt(value: string, cursor: number): { start: number; query: string } | null {
  const match = /(?:^|\s)@(?:"([^"\n]*)|([^\s"]*))$/.exec(value.slice(0, cursor));
  if (!match) return null;
  const query = match[1] ?? match[2]!;
  return { start: cursor - query.length - (match[1] !== undefined ? 2 : 1), query };
}

function subsequence(text: string, needle: string): boolean {
  let at = 0;
  for (const char of text) if (char === needle[at] && ++at === needle.length) return true;
  return false;
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Protocol markers like [REMOTE_AGENT_UNAVAILABLE] stay; the remaining text is already user-safe.
  return message.length > 300 ? `${message.slice(0, 299)}…` : message;
}
