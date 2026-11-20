/**
 * 测试价值
 * - 生产入口与可观察结果：width 与 input/editor 真实入口；终端单元格宽度、光标移动、编辑原文、可视窗口。
 * - Bug／规则依据：CLI TUI 升级计划的 Unicode 编辑、粘贴原子占位符、自动折行与有界输入要求。
 * - 现有覆盖缺口：App 的内存终端交互测试不验证原文偏移、emoji 簇或视觉列；此处纯模型环境避免启动整棵 UI。
 * - 最小失败输入：e + combining acute、家庭 emoji、[图片 #1]、宽度 4 的 abcdef、长短长三行的连续 ↓。
 * - tier：unit；无外部状态、定时器或模块重载。
 * - 实测耗时：vitest 单独运行 Duration 1.22 秒（22 项，测试执行 31 ms；2026-11-16）。
 */
import { describe, expect, it } from 'vitest';
import { charWidth, displayWidth, truncateWidth, wrapLine } from '../width.js';
import { edit, inputUnits, inputViewport, layoutInput, moveVertical, snapCursor } from './editor.js';

describe('terminal graphemes and source-preserving editor', () => {
  it.each([
    ['汉字', 4], ['e\u0301', 1], ['👨‍👩‍👧‍👦', 2], ['👍🏽', 2], ['🇨🇳', 2],
    ['1️⃣', 2], ['⚠', 1], ['⚠️', 2], ['\u200b\u200d\u2060\ufeff\u0301', 0],
    ['\x1b[31m红\x1b[0m', 2], ['\x1b]8;;https://example.test\x07link\x1b]8;;\x07', 4],
  ])('measures %j without counting invisible or ANSI bytes', (text, width) => {
    expect(displayWidth(text)).toBe(width);
  });

  it('wraps and truncates only at grapheme boundaries within the available cells', () => {
    expect(charWidth('')).toBe(0);
    expect(wrapLine('e\u0301👨‍👩‍👧‍👦汉', 3)).toEqual(['e\u0301👨‍👩‍👧‍👦', '汉']);
    expect(wrapLine('汉A', 1)).toEqual(['�', 'A']);
    expect(wrapLine('a\tb\n', 3)).toEqual(['a  ', 'b', '']);
    expect(truncateWidth('e\u0301👩🏽‍💻abc', 4)).toBe('e\u0301👩🏽‍💻…');
    expect(truncateWidth('abc', 0)).toBe('');
    expect(truncateWidth('abc', 1)).toBe('…');
  });

  it.each(['e\u0301', '👩🏽‍💻', '🇨🇳', '[Pasted text #1, 50 lines]', '[粘贴的文本 #2，50 行]', '[Image #3]', '[图片 #4]'])('moves and deletes %j as one source unit', unit => {
    const value = `a${unit}z`;
    const before = { value, cursor: 1 };
    const after = { value, cursor: 1 + unit.length };
    expect(edit.right(before)).toBe(after.cursor);
    expect(edit.left(after)).toBe(before.cursor);
    expect(edit.delete(before)).toEqual({ value: 'az', cursor: 1 });
    expect(edit.backspace(after)).toEqual({ value: 'az', cursor: 1 });
    expect(edit.insert(before, 'x').value).toBe(`ax${unit}z`);
    expect(snapCursor(value, 2)).toBe(1);
    expect(snapCursor(value, 2, 'right')).toBe(after.cursor);
  });

  it('word edits and repaired interior ranges cannot split an attachment', () => {
    const value = 'hello [图片 #1] world';
    expect(edit.wordLeft({ value, cursor: 13 })).toBe(6);
    expect(edit.wordRight({ value, cursor: 6 })).toBe(13);
    expect(edit.remove({ value, cursor: 8 }, 8, 10)).toEqual({ value: 'hello  world', cursor: 6 });
    expect(edit.wordLeft({ value: 'a汉字', cursor: 3 })).toBe(0);
    expect(edit.lineStart({ value: '\na', cursor: 0 })).toBe(0);
  });

  it('moves through soft wraps and retains a visual column through a short line', () => {
    const start = { value: 'abcdef', cursor: 2 };
    expect(moveVertical(start, 1, 4)?.cursor).toBe(6);
    expect(moveVertical({ value: 'abcd', cursor: 4 }, -1, 4)?.cursor).toBe(0);
    const long = { value: '汉ab\nx\n汉ab', cursor: 3 };
    const short = moveVertical(long, 1, 20)!;
    expect(short.cursor).toBe(5);
    expect(short.preferredColumn).toBe(4);
    expect(moveVertical(short, 1, 20)?.cursor).toBe(long.value.length);
    expect(moveVertical({ value: '汉ab', cursor: 0 }, -1, 20)).toBeNull();
    const atBreak = layoutInput('abcd\nx', 4, 4);
    expect(atBreak.rows.map(row => row.text)).toEqual(['abcd', 'x']);
    expect(atBreak.cursorColumn).toBe(0);
    expect(atBreak.cursorRow).toBe(1);
    expect(moveVertical({ value: 'abcd\nx', cursor: 0 }, 1, 4)?.cursor).toBe(5);
  });

  it('bounds the viewport around the caret and preserves raw text and marker offsets', () => {
    const value = 'e\u0301\n[粘贴的文本 #1，100 行]\n尾部\nlast';
    const initial = inputViewport({ value, cursor: 0 }, 8, 2);
    expect(initial.rows).toHaveLength(2);
    expect(initial.hiddenBelow).toBeGreaterThan(0);
    const viewport = inputViewport({ value, cursor: value.length }, 8, 2, initial.top);
    expect(viewport.rows).toHaveLength(2);
    expect(viewport.hiddenAbove).toBeGreaterThan(0);
    expect(viewport.cursorRow).toBe(1);
    expect(viewport.beforeCursor).toBe('last');
    expect(viewport.atCursor).toBe(' ');
    const marker = inputUnits(value).find(unit => unit.atomic)!;
    const row = layoutInput(value, 8).rows.find(item => item.start === marker.start)!;
    expect(row.text.endsWith('…')).toBe(true);
    expect(row.end).toBe(marker.end);
    expect(row.stops.map(stop => stop.offset)).toEqual([marker.start, marker.end]);
    expect(value.startsWith('e\u0301')).toBe(true);
    expect(viewport.rows.every(item => displayWidth(item.text) <= 8)).toBe(true);
  });
});
