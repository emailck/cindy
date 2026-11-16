/**
 * Terminal color themes. Each role is a set of Ink <Text> props, so a theme can use exact colors (dark / light,
 * values from the Desktop design tokens, same semantics: Thinking Orange for running, Heart Orange for full access,
 * info blue for plan mode and selection, GitHub diff colors) or only the terminal's own palette (ansi), where
 * "muted" is the terminal's dim attribute instead of a gray. Ink downgrades exact colors on 256/16-color terminals.
 */

export type ThemeName = 'dark' | 'light' | 'ansi';
export type ThemeSetting = 'auto' | ThemeName;
export const THEME_SETTINGS: readonly ThemeSetting[] = ['auto', 'dark', 'light', 'ansi'];
export function isThemeSetting(value: unknown): value is ThemeSetting {
  return typeof value === 'string' && (THEME_SETTINGS as readonly string[]).includes(value);
}

export interface Tone { color?: string; backgroundColor?: string; dimColor?: boolean }

export interface Theme {
  /** Secondary text: notices, summaries, tool arguments. */
  muted: Tone;
  /** Tertiary text: hints, gutters, context lines. */
  faint: Tone;
  /** Running / thinking (spinner, status). */
  running: Tone;
  /** Full access indicator. */
  full: Tone;
  /** Plan mode, selection, prompts awaiting a choice. */
  info: Tone;
  /** Inline code in replies. */
  code: Tone;
  success: Tone;
  error: Tone;
  warning: Tone;
  add: Tone;
  remove: Tone;
  /** The changed words inside an added / removed row. */
  addWord: Tone;
  removeWord: Tone;
  /** Local command mode (`!`): its prompt mark and input border. */
  local: Tone;
  border: string;
  /** Border of a confirmation that needs the user's decision. */
  attention: string;
  syntax: { keyword: Tone; string: Tone; number: Tone; comment: Tone };
}

const ORANGE = '#EA6B17';

export const THEMES: Record<ThemeName, Theme> = {
  dark: {
    muted: { color: '#A3A3A3' }, faint: { color: '#737373' },
    running: { color: ORANGE }, full: { color: ORANGE }, info: { color: '#60A5FA' }, code: { color: '#60A5FA' },
    success: { color: '#2AAE5B' }, error: { color: '#F87171' }, warning: { color: '#F3A115' },
    add: { color: '#7EE787', backgroundColor: '#033A16' }, remove: { color: '#FF7B72', backgroundColor: '#67060C' },
    addWord: { color: '#FFFFFF', backgroundColor: '#1A7F37' }, removeWord: { color: '#FFFFFF', backgroundColor: '#A40E26' },
    local: { color: '#E79FC1' },
    border: '#737373', attention: ORANGE,
    syntax: { keyword: { color: '#60A5FA' }, string: { color: '#7EE787' }, number: { color: '#F3A115' }, comment: { color: '#737373' } },
  },
  light: {
    muted: { color: '#737373' }, faint: { color: '#A3A3A3' },
    running: { color: ORANGE }, full: { color: ORANGE }, info: { color: '#1D4ED8' }, code: { color: '#1D4ED8' },
    success: { color: '#177C3C' }, error: { color: '#DC2626' }, warning: { color: ORANGE },
    add: { color: '#22863A', backgroundColor: '#F0FFF4' }, remove: { color: '#B31D28', backgroundColor: '#FFEEF0' },
    addWord: { color: '#165C2A', backgroundColor: '#ACF2BD' }, removeWord: { color: '#86181D', backgroundColor: '#FDB8C0' },
    local: { color: '#DF83B0' },
    border: '#A3A3A3', attention: ORANGE,
    syntax: { keyword: { color: '#1D4ED8' }, string: { color: '#22863A' }, number: { color: ORANGE }, comment: { color: '#A3A3A3' } },
  },
  ansi: {
    muted: { dimColor: true }, faint: { dimColor: true },
    running: { color: 'yellow' }, full: { color: 'yellow' }, info: { color: 'cyan' }, code: { color: 'cyan' },
    success: { color: 'green' }, error: { color: 'red' }, warning: { color: 'yellow' },
    add: { color: 'green' }, remove: { color: 'red' },
    addWord: { color: 'black', backgroundColor: 'green' }, removeWord: { color: 'black', backgroundColor: 'red' },
    local: { color: 'magenta' },
    border: 'gray', attention: 'yellow',
    syntax: { keyword: { color: 'cyan' }, string: { color: 'green' }, number: { color: 'yellow' }, comment: { dimColor: true } },
  },
};

/**
 * Terminals that render OSC 8 hyperlinks (link text stays clickable, no URL printed after it). Others print the
 * URL in parentheses. Detected from what the terminal itself sets; SSH sessions usually do not forward it.
 */
export function supportsHyperlinks(env: NodeJS.ProcessEnv, isTTY: boolean): boolean {
  if (!isTTY || env.TERM === 'dumb' || (env.NO_COLOR !== undefined && env.NO_COLOR !== '')) return false;
  if (env.CINDY_HYPERLINKS === '0') return false;
  if (env.CINDY_HYPERLINKS === '1') return true;
  if (env.WT_SESSION || env.KITTY_WINDOW_ID || env.WEZTERM_EXECUTABLE || env.GHOSTTY_RESOURCES_DIR) return true;
  if (/^xterm-(kitty|ghostty)$/.test(env.TERM ?? '')) return true;
  const program = env.TERM_PROGRAM ?? '';
  if (program === 'iTerm.app' || program === 'WezTerm' || program === 'vscode' || program === 'ghostty' || program === 'Hyper') return true;
  return Number(env.VTE_VERSION ?? 0) >= 5000;
}

/**
 * A 256-color terminal (common over SSH, where COLORTERM is not forwarded) rounds the subtle diff backgrounds to
 * the palette's saturated reds and greens (#870000, #005f00). These entries are the darkest (dark) and palest
 * (light) tinted ones the palette has, so diff rows stay readable there.
 */
const DIFF_256: Record<'dark' | 'light', Pick<Theme, 'add' | 'remove' | 'addWord' | 'removeWord'>> = {
  dark: {
    add: { color: '#7EE787', backgroundColor: 'ansi256(22)' }, remove: { color: '#FF7B72', backgroundColor: 'ansi256(52)' },
    addWord: { color: '#FFFFFF', backgroundColor: 'ansi256(28)' }, removeWord: { color: '#FFFFFF', backgroundColor: 'ansi256(88)' },
  },
  light: {
    add: { color: '#22863A', backgroundColor: 'ansi256(194)' }, remove: { color: '#B31D28', backgroundColor: 'ansi256(224)' },
    addWord: { color: '#165C2A', backgroundColor: 'ansi256(157)' }, removeWord: { color: '#86181D', backgroundColor: 'ansi256(217)' },
  },
};

/** The theme's colors for the terminal's color depth (bits per pixel, as getColorDepth reports). */
export function themeFor(name: ThemeName, colorDepth: number): Theme {
  const theme = THEMES[name];
  return name !== 'ansi' && colorDepth < 24 ? { ...theme, ...DIFF_256[name] } : theme;
}

/** Exact colors need a 256-color or truecolor terminal; otherwise the terminal's own palette reads better. */
export function colorDepthTheme(env: NodeJS.ProcessEnv, depth: number): ThemeName | null {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return 'ansi';
  return depth >= 8 ? null : 'ansi';
}

/** `rgb:RRRR/GGGG/BBBB` (1–4 hex digits per channel) from an OSC 11 reply → light or dark. */
export function backgroundTheme(reply: string): 'dark' | 'light' | null {
  // Only a terminated reply (BEL or ST): a reply split across reads must not be read half-way.
  const match = /\]11;rgba?:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})(?:\/[0-9a-f]{1,4})?(?:\x07|\x1b\\)/i.exec(reply);
  if (!match) return null;
  const [r, g, b] = match.slice(1, 4).map(hex => parseInt(hex, 16) / (16 ** hex.length - 1)) as [number, number, number];
  // Relative luminance (sRGB coefficients); mid-gray and up reads as a light background.
  return 0.2126 * r + 0.7152 * g + 0.0722 * b >= 0.5 ? 'light' : 'dark';
}

/** COLORFGBG ("fg;bg", set by rxvt, Konsole and others): background 7 or 15 is light. */
export function colorFgBgTheme(value: string | undefined): 'dark' | 'light' | null {
  const bg = value?.split(';').at(-1);
  if (!bg || !/^\d+$/.test(bg)) return null;
  return bg === '7' || bg === '15' ? 'light' : 'dark';
}

interface Tty {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  on(event: 'data', listener: (data: Buffer) => void): unknown;
  off(event: 'data', listener: (data: Buffer) => void): unknown;
  resume(): unknown;
  pause(): unknown;
}

/**
 * Asks the terminal for its background color (OSC 11), followed by a device-attributes query (DA1) that every
 * terminal answers, and in order: waiting for the DA1 reply means no reply is left to leak into Ink's input
 * afterwards, and a terminal that does not report colors is known at once. Runs before Ink takes stdin.
 * Ctrl+C typed meanwhile arrives as a byte (raw mode), so it is handed to `onInterrupt`.
 */
export function queryBackground(stdin: Tty, stdout: { write(text: string): unknown }, options: { timeoutMs?: number; onInterrupt?: () => void; env?: NodeJS.ProcessEnv } = {}): Promise<'dark' | 'light' | null> {
  if (!stdin.isTTY || !stdin.setRawMode || (options.env ?? process.env).TERM === 'dumb') return Promise.resolve(null);
  return new Promise(resolve => {
    let reply = '';
    const finish = () => {
      clearTimeout(timer);
      stdin.off('data', onData);
      stdin.setRawMode!(false);
      stdin.pause();
      resolve(backgroundTheme(reply));
    };
    const onData = (data: Buffer) => {
      reply += data.toString('latin1');
      if (reply.includes('\x03')) { finish(); options.onInterrupt?.(); return; }
      if (/\x1b\[\?[\d;]*c/.test(reply)) finish();
    };
    const timer = setTimeout(finish, options.timeoutMs ?? 1000);
    stdin.setRawMode!(true);
    stdin.on('data', onData);
    stdin.resume();
    stdout.write('\x1b]11;?\x1b\\\x1b[c');
  });
}

/** The theme for a setting: an explicit choice wins; auto uses the detected background, then dark. */
export function resolveTheme(setting: ThemeSetting, detected: { background: 'dark' | 'light' | null; depth: ThemeName | null }): ThemeName {
  if (setting !== 'auto') return setting;
  return detected.depth ?? detected.background ?? 'dark';
}
