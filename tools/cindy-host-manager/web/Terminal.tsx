import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { loginLinks } from "./api";
import type { Key } from "./i18n";
import "@xterm/xterm/css/xterm.css";
export function LoginTerminal({
  id,
  t,
  onClose,
  onExit,
}: {
  id: string;
  t: (key: Key) => string;
  onClose: () => void;
  onExit?: (code: number) => void;
}) {
  const node = useRef<HTMLDivElement>(null);
  const answerField = useRef<HTMLInputElement>(null);
  const exitCallback = useRef(onExit);
  exitCallback.current = onExit;
  const copySelection = useRef<() => void>(() => {});
  const submitAnswer = useRef<(value: string) => boolean>(() => false);
  const [hasSelection, setHasSelection] = useState(false);
  const [status, setStatus] = useState<Key>("connecting");
  const [links, setLinks] = useState<string[]>([]);
  const [notice, setNotice] = useState<Key | null>(null);
  useEffect(() => {
    const term = new Terminal({
      cursorBlink: false,
      disableStdin: true,
      scrollback: 1000,
      fontSize: 14,
      allowProposedApi: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(node.current!);
    const copy = () => {
      const text = term.getSelection();
      if (!text) return;
      try {
        void navigator.clipboard.writeText(text).then(
          () => {
            if (active) setNotice("copied");
          },
          () => {
            if (active) setNotice("copyFailed");
          },
        );
      } catch {
        if (active) setNotice("copyFailed");
      }
    };
    copySelection.current = copy;
    term.attachCustomKeyEventHandler((event) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        event.key.toLowerCase() === "c" &&
        term.hasSelection()
      ) {
        event.preventDefault();
        if (event.type === "keydown") copy();
        return false;
      }
      return true;
    });
    const selection = term.onSelectionChange(() =>
      setHasSelection(term.hasSelection()),
    );
    const updateTheme = () => {
      const css = getComputedStyle(document.documentElement);
      term.options.theme = {
        background: css.getPropertyValue("--surface-elevated").trim(),
        foreground: css.getPropertyValue("--text-primary").trim(),
        cursor: css.getPropertyValue("--text-primary").trim(),
        selectionBackground: css.getPropertyValue("--surface-chip").trim(),
      };
    };
    updateTheme();
    const themeObserver = new MutationObserver(updateTheme);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    const url = new URL(`/api/logins/${encodeURIComponent(id)}`, location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    let ended = false;
    let active = true;
    let tail = "";
    const send = (data: object) => {
      if (socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify(data));
    };
    submitAnswer.current = (value) => {
      if (!active || ended || socket.readyState !== WebSocket.OPEN)
        return false;
      send({ type: "answer", value });
      return true;
    };
    const resize = () => {
      if (!active || ended) return;
      fit.fit();
      send({ type: "resize", cols: term.cols, rows: term.rows });
    };
    socket.onopen = () => {
      if (!active || ended) {
        socket.close();
        return;
      }
      setStatus("connected");
      resize();
      term.focus();
    };
    socket.onmessage = (event) => {
      if (!active || ended) return;
      try {
        const message = JSON.parse(event.data);
        if (message.type === "output" && typeof message.data === "string") {
          term.write(message.data);
          tail = (
            tail + message.data.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
          ).slice(-16384);
          setLinks((previous) =>
            [...new Set([...previous, ...loginLinks(tail)])].slice(-10),
          );
        } else if (message.type === "exit") {
          ended = true;
          if (answerField.current) answerField.current.value = "";
          setNotice(null);
          setStatus(
            message.code === 0
              ? "completed"
              : message.code === 130
                ? "interrupted"
                : "failed",
          );
          exitCallback.current?.(message.code);
        } else if (
          (message.type === "warning" || message.type === "error") &&
          message.code === "TERMINAL_RESIZE_FAILED"
        ) {
          setNotice("terminalResizeNotice");
        } else if (message.type === "error") {
          setStatus("failed");
        }
      } catch {
        if (!ended) setStatus("failed");
      }
    };
    socket.onclose = () => {
      if (active && !ended) setStatus("disconnected");
    };
    socket.onerror = () => {
      if (active && !ended) setStatus("failed");
    };
    const observer = new ResizeObserver(resize);
    observer.observe(node.current!);
    return () => {
      active = false;
      if (answerField.current) answerField.current.value = "";
      send({ type: "cancel" });
      socket.close();
      selection.dispose();
      copySelection.current = () => {};
      submitAnswer.current = () => false;
      observer.disconnect();
      themeObserver.disconnect();
      term.dispose();
      tail = "";
    };
  }, [id]);
  return (
    <section className="login-terminal" aria-label={t("terminal")}>
      <div className="toolbar">
        <h3>{t("terminal")}</h3>
        <button
          disabled={!hasSelection}
          onClick={() => copySelection.current()}
        >
          {t("copySelected")}
        </button>
        <button onClick={onClose}>{t("close")}</button>
      </div>
      <p role="status">{t(status)}</p>
      {notice && <p role="status">{t(notice)}</p>}
      <div className="terminal" ref={node} />
      <details>
        <summary>{t("loginAnswer")}</summary>
        <p>{t("loginAnswerNote")}</p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const input = event.currentTarget.elements.namedItem(
              "answer",
            ) as HTMLInputElement;
            const value = input.value;
            input.value = "";
            if (
              !value ||
              value.length > 4096 ||
              /[\x00-\x1f\x7f]/.test(value)
            ) {
              setNotice("answerInvalid");
              return;
            }
            setNotice(
              submitAnswer.current(value) ? "answerSent" : "answerNotSent",
            );
          }}
        >
          <label>
            {t("loginAnswerValue")}
            <input
              ref={answerField}
              name="answer"
              type="password"
              autoComplete="off"
              maxLength={4096}
              required
              disabled={status !== "connected"}
            />
          </label>
          <button disabled={status !== "connected"}>{t("submitAnswer")}</button>
        </form>
      </details>
      {links.length > 0 && (
        <nav aria-label={t("loginLinks")}>
          {links.map((url, index) => (
            <p key={url}>
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                referrerPolicy="no-referrer"
              >
                {t("openLogin")} {index + 1} · {new URL(url).host}
              </a>
            </p>
          ))}
        </nav>
      )}
    </section>
  );
}
