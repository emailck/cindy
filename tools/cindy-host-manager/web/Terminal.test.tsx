// @vitest-environment jsdom
// Tier: unit. Rule: temporary authenticated login must cancel on unmount and only
// expose HTTPS links after an explicit user click. Gap: no terminal lifecycle test.
// Minimal input: HTML/javascript text followed by one HTTPS URL split over two
// output frames, then its line terminator. Partial links must never be exposed.
import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { LoginTerminal } from "./Terminal";
import { translator } from "./i18n";
const terminalInput = vi.hoisted(() => ({
  listener: undefined as undefined | ((data: string) => void),
  key: undefined as undefined | ((event: KeyboardEvent) => boolean),
  selection: "",
  options: {} as Record<string, unknown>,
  selectionChanged: undefined as undefined | (() => void),
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  terminalInput.listener = undefined;
  terminalInput.key = undefined;
  terminalInput.selection = "";
  terminalInput.selectionChanged = undefined;
});
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options = {};
    constructor(options: Record<string, unknown>) {
      terminalInput.options = options;
    }
    cols = 80;
    rows = 24;
    loadAddon() {}
    open() {}
    focus() {}
    write() {}
    dispose() {}
    hasSelection() {
      return !!terminalInput.selection;
    }
    getSelection() {
      return terminalInput.selection;
    }
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
      terminalInput.key = handler;
    }
    onSelectionChange(listener: () => void) {
      terminalInput.selectionChanged = listener;
      return {
        dispose() {
          terminalInput.selectionChanged = undefined;
        },
      };
    }
    onData(listener: (data: string) => void) {
      terminalInput.listener = listener;
      return {
        dispose() {
          terminalInput.listener = undefined;
        },
      };
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));
it("waits for a complete native login URL and cancels when unmounted", () => {
  const sends: unknown[] = [];
  const close = vi.fn();
  class Socket {
    static OPEN = 1;
    readyState = 1;
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    onclose?: () => void;
    onerror?: () => void;
    send(data: string) {
      sends.push(JSON.parse(data));
    }
    close = close;
    constructor() {
      socket = this;
    }
  }
  let socket: Socket;
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const view = render(
    <LoginTerminal id="login" t={translator("en")} onClose={() => {}} />,
  );
  act(() => {
    socket.onopen?.();
    socket.onmessage?.({
      data: JSON.stringify({
        type: "output",
        data: "<img src=x onerror=alert(1)> javascript:alert(1) https://accounts.ex",
      }),
    });
  });
  expect(screen.queryByRole("link")).toBeNull();
  act(() => {
    socket.onmessage?.({
      data: JSON.stringify({
        type: "output",
        data: "ample.test/oauth?code=synthetic%2Btoken&state=end.",
      }),
    });
  });
  expect(screen.queryByRole("link")).toBeNull();
  act(() => {
    socket.onmessage?.({
      data: JSON.stringify({ type: "output", data: "\r\n" }),
    });
  });
  expect(screen.getAllByRole("link")).toHaveLength(1);
  const link = screen.getByRole("link");
  expect(link.getAttribute("href")).toBe(
    "https://accounts.example.test/oauth?code=synthetic%2Btoken&state=end.",
  );
  expect(link.getAttribute("rel")).toContain("noopener");
  expect(view.container.querySelector("img")).toBeNull();
  expect(sends).toContainEqual({ type: "resize", cols: 80, rows: 24 });
  view.unmount();
  expect(sends).toContainEqual({ type: "cancel" });
  expect(close).toHaveBeenCalledOnce();
  vi.unstubAllGlobals();
});

// Tier: unit. Native exit is authoritative. Previously a ResizeObserver callback
// after exit resized a removed container; its delayed error replaced success.
// Minimal failure sequence: exit(0), resize error, socket error. Also retain a
// nonzero exit and keep an active resize notice distinct from native completion.
function terminalFixture(onExit?: (code: number) => void) {
  const sends: unknown[] = [];
  let resize: () => void = () => {};
  let socket: Socket;
  class Socket {
    static OPEN = 1;
    readyState = 1;
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    onerror?: () => void;
    onclose?: () => void;
    constructor() {
      socket = this;
    }
    send(data: string) {
      sends.push(JSON.parse(data));
    }
    close() {}
  }
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  const view = render(
    <LoginTerminal
      id="synthetic"
      t={translator("en")}
      onClose={() => {}}
      onExit={onExit}
    />,
  );
  act(() => socket.onopen?.());
  return {
    view,
    sends,
    select(text: string) {
      act(() => {
        terminalInput.selection = text;
        terminalInput.selectionChanged?.();
      });
    },
    key(modifier: "ctrlKey" | "metaKey") {
      const event = new KeyboardEvent("keydown", {
        key: "c",
        [modifier]: true,
        cancelable: true,
      });
      act(() => {
        if (terminalInput.key?.(event) !== false)
          terminalInput.listener?.("\x03");
      });
      return event;
    },
    message(value: object) {
      act(() => socket.onmessage?.({ data: JSON.stringify(value) }));
    },
    resize() {
      act(() => resize());
    },
    input() {
      act(() => terminalInput.listener?.("synthetic input"));
    },
    lateTransportError() {
      act(() => {
        socket.onerror?.();
        socket.onclose?.();
      });
    },
  };
}
it.each([0, 1])(
  "keeps native exit %i sticky and stops terminal writes after exit",
  (code) => {
    const fixture = terminalFixture();
    fixture.message({ type: "exit", code });
    const outcome = code === 0 ? "Login process ended" : "Login process failed";
    expect(screen.getByText(outcome)).toBeTruthy();
    fixture.message({ type: "error", message: "Terminal resize failed." });
    fixture.lateTransportError();
    expect(screen.getByText(outcome)).toBeTruthy();
    const count = fixture.sends.length;
    fixture.resize();
    fixture.input();
    expect(fixture.sends).toHaveLength(count);
    fixture.message({ type: "exit", code: code === 0 ? 1 : 0 });
    expect(screen.getByText(outcome)).toBeTruthy();
  },
);
it("shows an active resize warning without treating the login as failed or complete", () => {
  const fixture = terminalFixture();
  fixture.message({ type: "warning", code: "TERMINAL_RESIZE_FAILED" });
  expect(screen.getByText("Connected")).toBeTruthy();
  expect(
    screen.getByText(
      "The terminal could not be resized. You can continue logging in.",
    ),
  ).toBeTruthy();
  expect(screen.queryByText("Login process failed")).toBeNull();
  expect(screen.queryByText("Login process ended")).toBeNull();
  fixture.message({ type: "exit", code: 0 });
  expect(
    screen.queryByText(
      "The terminal could not be resized. You can continue logging in.",
    ),
  ).toBeNull();
  expect(screen.getByText("Login process ended")).toBeTruthy();
});

// Tier: unit. Output is read-only. Copy selection must remain in the browser;
// no keyboard or paste channel may forward raw input to native login. Exercise
// the custom selection handler registered by the production component.
it("keeps output read-only while copying selected text via keyboard/button", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const fixture = terminalFixture();
  fixture.select("synthetic selection");
  for (const modifier of ["ctrlKey", "metaKey"] as const) {
    expect(fixture.key(modifier).defaultPrevented).toBe(true);
  }
  fireEvent.click(screen.getByRole("button", { name: "Copy selected text" }));
  expect(writeText).toHaveBeenCalledTimes(3);
  expect(writeText).toHaveBeenLastCalledWith("synthetic selection");
  expect(fixture.sends).not.toContainEqual({ type: "input", data: "\x03" });
  writeText.mockRejectedValueOnce(new Error("synthetic clipboard denial"));
  fireEvent.click(screen.getByRole("button", { name: "Copy selected text" }));
  await screen.findByText(
    "Could not copy. Check your browser clipboard permission.",
  );
  expect(screen.getByText("Connected")).toBeTruthy();
  fixture.select("");
  fixture.key("ctrlKey");
  expect(terminalInput.options.disableStdin).toBe(true);
  expect(terminalInput.listener).toBeUndefined();
  expect(fixture.sends.some((message: any) => message.type === "input")).toBe(
    false,
  );
});
it("reports definitive interrupted exit once through the latest callback without reconnecting", () => {
  const oldCallback = vi.fn();
  const latestCallback = vi.fn();
  const fixture = terminalFixture(oldCallback);
  fixture.view.rerender(
    <LoginTerminal
      id="synthetic"
      t={translator("en")}
      onClose={() => {}}
      onExit={latestCallback}
    />,
  );
  fixture.message({ type: "exit", code: 130 });
  fixture.message({ type: "exit", code: 0 });
  expect(screen.getByText("Login interrupted")).toBeTruthy();
  expect(oldCallback).not.toHaveBeenCalled();
  expect(latestCallback).toHaveBeenCalledExactlyOnceWith(130);
  expect(
    fixture.sends.filter((message: any) => message.type === "resize"),
  ).toHaveLength(1);
});
// Tier: unit. Read-only output needs a separate, explicit single-line handoff;
// only that form may send a response, and its sensitive value must clear at once.
it("submits only explicit login answers, clears them immediately and blocks controls/late answers", () => {
  const fixture = terminalFixture();
  fireEvent.click(screen.getByText("Enter content needed for login"));
  const input = screen.getByLabelText("Login response") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "synthetic-code" } });
  fireEvent.submit(input.form!);
  expect(input.value).toBe("");
  expect(fixture.sends).toContainEqual({
    type: "answer",
    value: "synthetic-code",
  });
  const count = fixture.sends.length;
  fireEvent.change(input, { target: { value: "synthetic\x1bcontrol" } });
  fireEvent.submit(input.form!);
  expect(input.value).toBe("");
  expect(fixture.sends).toHaveLength(count);
  fixture.message({ type: "exit", code: 130 });
  fireEvent.change(input, { target: { value: "late-synthetic-code" } });
  fireEvent.submit(input.form!);
  expect(input.value).toBe("");
  expect(fixture.sends).toHaveLength(count);
  expect(fixture.sends.some((message: any) => message.type === "input")).toBe(
    false,
  );
});
