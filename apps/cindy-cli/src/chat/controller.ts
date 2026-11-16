/**
 * Terminal task state, independent of the renderer: slash commands, remote events → transcript,
 * and the single interaction channel (Agent permissions, questions, plans, and the local
 * shared-provider credential confirmations all arrive through setInteractionResolver).
 * Never fabricates a user decision: aborted prompts resolve as dismissed/deny.
 */
import { randomUUID } from 'node:crypto';
import type { AgentEvent, AgentSessionHandle, AskUserQuestionItem, Effort, InteractionDecision, InteractionRequest } from '@cindy/maker-core';
import type { CatalogModel, CatalogResult, CatalogSource } from '../catalog';
import { createTranslator, type Language, type MessageKey, type Translate } from '../i18n';
import type { ModelChoice, PermissionChoice } from '../profile';
import { permissionOptions } from '../permissions';
import type { RemoteTaskRequest } from '../session';
import { taskTitle, type TaskRecord, type TaskStore } from '../store';
import { fenceAfter } from './markdown';
import { toolDetail, toolOutput, type ToolDetail } from './tools';
import { isThemeSetting, resolveTheme, THEME_SETTINGS, type ThemeName, type ThemeSetting } from './theme';

export type Line =
  | { id: string; kind: 'user'; text: string; /** Sent into the running turn (插话). */ steer?: boolean }
  /**
   * cont: a later piece of the same reply, committed line by line while streaming (no gap before it).
   * code: the piece starts inside a code fence opened by an earlier piece.
   */
  | { id: string; kind: 'assistant'; text: string; cont?: boolean; code?: boolean }
  /** name is the tool's own name; result is its output (bounded), summarized by the renderer. */
  | { id: string; kind: 'tool'; name: string; summary: string; detail?: ToolDetail; result?: string; error?: boolean }
  | { id: string; kind: 'notice'; text: string; tone: 'info' | 'warn' | 'error' }
  /** /help and ?: operations grouped by situation; each row is [keys, what it does]. */
  | { id: string; kind: 'help'; sections: HelpSection[] };

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
  | { kind: 'picker'; title: string; choices: Choice[]; index: number; /** Esc returns to the previous step. */ back?: boolean }
  | { kind: 'permission'; title: string; summary: string; description?: string; choices: Choice[]; index: number }
  | { kind: 'question'; question: AskUserQuestionItem; position: string; choices: Choice[]; index: number; /** Multi-select: toggled option indexes. */ selected: number[] }
  | { kind: 'plan'; plan: string; choices: Choice[]; index: number };

export interface ChatSnapshot {
  lines: readonly Line[];
  /** Streaming assistant text not yet committed: only the unfinished last line, finished lines are already in lines. */
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
}

export interface QueuedMessage { id: string; text: string }

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
  saveModel?(choice: ModelChoice): Promise<void>;
  /** Saved /theme choice and what was detected about the terminal at startup. */
  theme?: { setting: ThemeSetting; background: 'dark' | 'light' | null; depth: ThemeName | null };
  saveTheme?(setting: ThemeSetting): Promise<void>;
  /** False when ripgrep is missing: warn once at startup. */
  searchAvailable?: boolean;
  /** False on Windows without Git Bash: warn once at startup. */
  shellAvailable?: boolean;
  now?(): number;
}

export const COMMANDS = ['help', 'model', 'effort', 'permissions', 'plan', 'compact', 'clear', 'resume', 'status', 'cost', 'context', 'lang', 'theme', 'exit', 'quit'] as const;
type Command = (typeof COMMANDS)[number];

export function commandSuggestions(input: string): Command[] {
  if (!input.startsWith('/') || input.includes(' ')) return [];
  const prefix = input.slice(1).toLowerCase();
  return COMMANDS.filter(name => name.startsWith(prefix) && name !== 'quit');
}

export function commandDescription(t: Translate, name: Command): string {
  return t((name === 'quit' ? 'cmd.exit' : `cmd.${name}`) as MessageKey);
}

/** The operations guide shown by /help and ?. Keys are literal; descriptions follow the interface language. */
export function helpSections(t: Translate): HelpSection[] {
  const row = (keys: string, key: MessageKey): [string, string] => [keys, t(key)];
  return [
    { title: t('help.titleCommands'), rows: COMMANDS.filter(command => command !== 'quit').map(command => [`/${command}`, commandDescription(t, command)]) },
    { title: t('help.titleInput'), rows: [
      row('Enter', 'help.send'), row('\\ + Enter · Ctrl+J', 'help.newline'), row('↑ / ↓', 'help.history'),
      row('/ · Tab', 'help.complete'), row('Esc · Ctrl+U', 'help.clearInput'),
      row('Alt+← / → · Ctrl+W · Ctrl+K', 'help.editing'), row('Ctrl+A / Ctrl+E', 'help.lineStart'),
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
  private tools = new Map<string, string>();
  private models: CatalogModel[] = [];
  private exitTimer: ReturnType<typeof setTimeout> | undefined;
  private exitWaiters: Array<() => void> = [];
  private turnWaiters: Array<() => void> = [];
  /** Raw text of the reply being streamed, and how much of it is already committed to lines. */
  private streamed = '';
  private flushed = 0;
  /** A code fence is open at the end of the committed part of the reply. */
  private fence = false;

  constructor(private readonly deps: ChatDeps) {
    this.t = createTranslator(deps.language);
    this.snapshot = { lines: [], live: '', liveCont: false, liveCode: false, phase: 'idle', thinking: false, turnStartedAt: null, prompt: null, model: null,
      permission: deps.permission, effort: null, language: deps.language, queue: [],
      theme: resolveTheme(deps.theme?.setting ?? 'auto', { background: deps.theme?.background ?? null, depth: deps.theme?.depth ?? null }),
      themeSetting: deps.theme?.setting ?? 'auto', queuePaused: false, exitArmed: false, exited: false };
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

  async submit(raw: string): Promise<void> {
    const text = raw.trim();
    if (!text) { if (!this.pending) this.resumeQueue(); return; }
    if (this.pending?.kind === 'question') { this.answerQuestion(text); return; }
    if (this.pending?.kind === 'plan') { this.planFeedback(text); return; }
    if (this.pending) return;
    if (text.startsWith('/')) { await this.command(text); return; }
    // Typing during a turn queues the message (Desktop 「排队发送」); Ctrl+S steers instead.
    if (this.snapshot.phase !== 'idle') { this.enqueue(text); return; }
    await this.send(text);
  }

  private enqueue(text: string) { this.update({ queue: [...this.snapshot.queue, { id: randomUUID(), text }] }); }

  /** ↑ on an empty line: take the last queued message back into the editor. */
  popQueued(): string | null {
    const queue = this.snapshot.queue;
    const last = queue.at(-1);
    if (!last) return null;
    this.update({ queue: queue.slice(0, -1), ...(queue.length === 1 ? { queuePaused: false } : {}) });
    return last.text;
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
    void this.send(next.text);
  }

  /**
   * Ctrl+S (插话): put a message into the running turn without interrupting it; the Agent handles it
   * after its current action. Empty input steers the first queued message. When nothing is running,
   * the message is simply sent.
   */
  async steer(raw: string): Promise<'steered' | 'sent' | 'queued' | 'none'> {
    let text = raw.trim();
    const queued = !text ? this.snapshot.queue[0] : undefined;
    if (queued) text = queued.text;
    if (!text || this.pending) return 'none';
    if (text.startsWith('/')) { await this.submit(text); return 'sent'; }
    if (queued) this.update({ queue: this.snapshot.queue.slice(1) });
    const handle = this.handle;
    if (this.snapshot.phase !== 'running' || !handle) { await this.send(text); return 'sent'; }
    try {
      await handle.steer({ type: 'user', content: text });
      this.commitLive();
      this.push({ kind: 'user', text, steer: true });
      return 'steered';
    } catch {
      // Never lose the message: it goes to the front of the queue.
      this.update({ queue: [{ id: randomUUID(), text }, ...this.snapshot.queue] });
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

  private async send(text: string): Promise<void> {
    if (this.snapshot.phase !== 'idle') { this.enqueue(text); return; }
    const model = this.snapshot.model;
    if (!model) { this.notice('chat.noModel', undefined, 'warn'); return; }
    this.push({ kind: 'user', text });
    if (!this.title) this.title = taskTitle(text);
    const handle = await this.ensureHandle(model);
    if (!handle) return;
    this.update({ phase: 'running', thinking: false, turnStartedAt: (this.deps.now ?? Date.now)() });
    try { await handle.send({ type: 'user', content: text }); }
    catch (error) {
      this.notice('chat.error', { message: errorText(error) }, 'error');
      this.finishTurn('error');
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
   * Streamed reply text: finished lines move to lines right away so only the unfinished last line stays live.
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
    const cut = this.streamed.lastIndexOf('\n');
    const end = cut < 0 ? 0 : this.streamed.slice(0, cut).trimEnd().length;
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
    switch (event.type) {
      case 'text': {
        if (event.agentMeta && typeof (event.agentMeta as { parentUuid?: unknown }).parentUuid === 'string') return; // subagent text
        const text = typeof data.text === 'string' ? data.text : '';
        this.streamText(text, data.isFinal === true);
        return;
      }
      case 'thinking': this.update({ thinking: data.stage !== 'final' && data.stage !== 'redacted' }); return;
      case 'tool_use': {
        this.commitLive();
        const id = typeof data.toolUseId === 'string' ? data.toolUseId : randomUUID();
        const lineId = randomUUID();
        this.tools.set(id, lineId);
        const name = String(data.toolName ?? 'tool');
        const detail = toolDetail(name, data.input);
        if (detail && detail.kind !== 'todos') detail.path = this.relative(detail.path);
        this.update({ thinking: false, lines: [...this.snapshot.lines, { id: lineId, kind: 'tool', name, summary: this.relative(toolSummary(data.input)), ...(detail ? { detail } : {}) }] });
        return;
      }
      case 'tool_result_full': {
        const lineId = typeof data.toolUseId === 'string' ? this.tools.get(data.toolUseId) : undefined;
        if (!lineId || typeof data.fullText !== 'string') return;
        const { output, error } = toolOutput(data.fullText);
        this.update({ lines: this.snapshot.lines.map(line => (line.id === lineId && line.kind === 'tool' ? { ...line, result: output, ...(error || data.isError === true ? { error: true } : {}) } : line)) });
        return;
      }
      case 'error': {
        this.commitLive();
        const message = typeof data.message === 'string' ? data.message : 'error';
        this.push({ kind: 'notice', text: this.t('chat.error', { message }), tone: 'error' });
        const terminal = data.isTerminal ?? (data.willRetry === undefined ? true : !data.willRetry);
        if (terminal) this.finishTurn('error');
        return;
      }
      case 'done': this.commitLive(); this.finishTurn(); void this.record(); return;
      default: return;
    }
  }

  private finishTurn(outcome: 'done' | 'interrupted' | 'error' | 'closed' = 'done') {
    this.commitLive();
    const wasRunning = this.snapshot.phase !== 'idle';
    if (wasRunning || this.snapshot.thinking) this.update({ phase: 'idle', thinking: false, turnStartedAt: null });
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
    this.notice('chat.interrupted', undefined, 'warn');
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

  private picker(titleKey: MessageKey, choices: Choice[], choose: (index: number) => void | Promise<void>, index = 0, options: { title?: string; back?: () => void } = {}) {
    this.pending = { kind: 'picker', choose, ...(options.back ? { back: options.back } : {}) };
    const first = choices.findIndex(choice => !choice.disabled);
    const start = choices[index] && !choices[index]!.disabled ? index : Math.max(0, first);
    this.update({ prompt: { kind: 'picker', title: options.title ?? this.t(titleKey), choices, index: start, ...(options.back ? { back: true } : {}) } });
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
        this.update({ prompt: { kind: 'permission', title: this.t('ask.permissionTitle', { tool: request.displayName ?? request.toolName }),
          summary: toolSummary(request.input), ...(request.description ? { description: request.description } : {}), choices, index: 0 } });
      } else if (request.kind === 'ask_user_question') {
        this.pending = { kind: 'question', queue: [...request.questions], answers: {}, resolve: settle };
        this.nextQuestion();
      } else {
        this.pending = { kind: 'plan', resolve: settle };
        this.update({ prompt: { kind: 'plan', plan: request.plan, choices: [{ label: this.t('ask.planApprove') }, { label: this.t('ask.planRevise') }], index: 0 } });
      }
    });
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
    const name = (head ?? '').toLowerCase() as Command;
    const arg = rest.join(' ').trim();
    if (!(COMMANDS as readonly string[]).includes(name)) { this.notice('chat.unknownCommand', { name: `/${head}` }, 'warn'); return; }
    const busy = this.snapshot.phase !== 'idle' && !['help', 'status', 'cost', 'context', 'exit', 'quit', 'lang', 'theme'].includes(name);
    if (busy) { this.notice('chat.busy', undefined, 'warn'); return; }
    switch (name) {
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
      case 'exit':
      case 'quit': await this.exit(); return;
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
      Math.max(0, groups.findIndex(isCurrent)));
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
      { title: this.t('picker.modelOf', { provider: group.label }), ...(back ? { back } : {}) });
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
    this.update({ live: '', liveCont: false, liveCode: false, phase: 'idle', thinking: false, turnStartedAt: null });
  }

  private async resumeCommand(): Promise<void> {
    const records = await this.deps.tasks.list(this.deps.workingDir).catch(() => []);
    if (!records.length) { this.notice('chat.resumeNone'); return; }
    this.picker('picker.resume', records.map(record => ({ label: record.title, detail: new Date(record.updatedAt).toLocaleString(), group: `${record.model} · ${record.targetLabel}` })),
      async index => { await this.resumeRecord(records[index]!); });
  }

  /** `cindy -c`: continue the most recent session started in this directory. */
  async continueLatest(): Promise<boolean> {
    const [latest] = await this.deps.tasks.list(this.deps.workingDir).catch(() => [] as TaskRecord[]);
    // -c asked for a continuation: say why none happened, also in print mode.
    if (!latest) { this.notice('chat.resumeNone', undefined, 'warn'); return false; }
    return this.resumeRecord(latest);
  }

  /**
   * A native resume id belongs to the computer and provider that created it. Resume only when that
   * exact route is still offered; never hand it to whichever model happens to be selected.
   */
  private async resumeRecord(record: TaskRecord): Promise<boolean> {
    const model = this.models.find(item => item.target === record.target && item.providerId === record.providerId && item.model === record.model);
    if (!model) { this.notice('chat.resumeUnavailable', { title: record.title, model: record.model, where: record.targetLabel }, 'warn'); return false; }
    await this.newSession();
    this.sessionId = record.sessionId;
    this.resumeSessionId = record.resumeSessionId;
    this.title = record.title;
    this.update({ model, effort: model.efforts.includes(this.snapshot.effort ?? '') ? this.snapshot.effort : model.defaultEffort });
    this.notice('chat.resumed', { title: record.title });
    return true;
  }
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Protocol markers like [REMOTE_AGENT_UNAVAILABLE] stay; the remaining text is already user-safe.
  return message.length > 300 ? `${message.slice(0, 299)}…` : message;
}
