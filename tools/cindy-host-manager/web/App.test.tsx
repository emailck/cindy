// @vitest-environment jsdom
// Tier: unit. Frozen API requires provider/Google logins without an empty email;
// saved authentication from check must remain observable after refreshing inventory.
// Gap: new web entry had no behavioral coverage. Minimal input: stopped instance,
// Google login (empty email), check result with saved credentials, recipient code.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { App } from "./App";
const terminalEvents = vi.hoisted(() => ({
  autoExit: null as number | null,
  lastExit: undefined as undefined | ((code: number) => void),
}));
vi.mock("./Terminal", async () => {
  const { useLayoutEffect } = await import("react");
  return {
    LoginTerminal: ({
      onClose,
      onExit,
    }: {
      onClose: () => void;
      onExit?: (code: number) => void;
    }) => {
      terminalEvents.lastExit = onExit;
      useLayoutEffect(() => {
        if (terminalEvents.autoExit !== null) {
          const code = terminalEvents.autoExit;
          terminalEvents.autoExit = null;
          onExit?.(code);
        }
      }, [onExit]);
      return (
        <>
          <button onClick={onClose}>Close login</button>
          <button onClick={() => onExit?.(0)}>Finish login</button>
          <button onClick={() => onExit?.(130)}>Interrupt login</button>
        </>
      );
    },
  };
});
const calls: {
  path: string;
  body?: Record<string, unknown>;
  method: string;
}[] = [];
let state = "stopped";
let providerStatus = "authenticated";
let checkGate: Promise<void> | undefined;
let checkGateId: string | undefined;
let failedCheckId = "";
let created = false;
let omitAuthentication = false;
let accountSnapshots: Record<string, unknown> = {};
let includeOther = false;
let authenticated = true;
beforeEach(() => {
  calls.length = 0;
  state = "stopped";
  providerStatus = "authenticated";
  checkGate = undefined;
  checkGateId = undefined;
  failedCheckId = "";
  created = false;
  omitAuthentication = false;
  accountSnapshots = {};
  includeOther = false;
  authenticated = true;
  terminalEvents.autoExit = null;
  terminalEvents.lastExit = undefined;
  Object.defineProperty(navigator, "language", {
    value: "en",
    configurable: true,
  });
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, options: RequestInit) => {
      const method = options.method ?? "GET";
      const body = options.body ? JSON.parse(String(options.body)) : undefined;
      calls.push({ path, method, body });
      const instance = {
        id: path.includes("/other/")
          ? "other"
          : path.includes("/created/")
            ? "created"
            : "test",
        name: path.includes("/other/")
          ? "Other CLI"
          : path.includes("/created/")
            ? "Created CLI"
            : "My CLI",
        engine: "codex",
        proxyMode: "none",
        createdAt: "2026-01-01",
        state,
      };
      let data: unknown;
      if (path === "/api/session") {
        if (method === "DELETE") authenticated = false;
        data = { authenticated, csrfToken: "test-csrf" };
      } else if (path === "/api/settings")
        data = { image: "test-image", proxyConfigured: false, proxyUrl: null };
      else if (path === "/api/instances" && method === "POST") {
        created = true;
        data = {
          instance: { ...instance, id: "created", name: "Created CLI" },
        };
      } else if (path === "/api/instances")
        data = {
          instances: [
            instance,
            ...(created
              ? [{ ...instance, id: "created", name: "Created CLI" }]
              : []),
            ...(includeOther
              ? [
                  {
                    ...instance,
                    id: "other",
                    name: "Other CLI",
                    engine: "claude-code",
                  },
                ]
              : []),
          ],
        };
      else if (path.endsWith("/login")) data = { loginId: "temporary" };
      else if (path.endsWith("/actions")) {
        if (body.action === "start") state = "running";
        if (
          body.action === "check" &&
          checkGate &&
          (!checkGateId || checkGateId === instance.id)
        )
          await checkGate;
        if (body.action === "check" && failedCheckId === instance.id)
          return {
            ok: false,
            status: 401,
            json: async () => ({
              error: {
                code: "UNAUTHENTICATED",
                message: "synthetic stale expiry",
              },
            }),
          };
        data = {
          instance: {
            ...instance,
            state,
            ...(accountSnapshots[instance.id] === undefined
              ? {}
              : { accounts: accountSnapshots[instance.id] }),
            ...(omitAuthentication
              ? {}
              : {
                  authentication: { cindy: "stored", provider: providerStatus },
                }),
          },
        };
      } else if (path.endsWith("/share"))
        data = {
          result:
            body.action === "list"
              ? {
                  shares: [
                    {
                      shareId: "share",
                      providerLabel: "Codex",
                      requests: [
                        {
                          requestId: "request",
                          displayName: "Guest",
                          expiresAt: "2099-01-01",
                        },
                      ],
                      members: [],
                    },
                  ],
                  usage: [],
                }
              : { ok: true },
        };
      else throw new Error(`Unexpected ${path}`);
      return { ok: true, json: async () => data };
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
async function openInstance() {
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: /My CLI/ }));
  await screen.findByText(
    `Cindy: Saved · Provider: ${providerStatus === "missing" ? "No saved login" : "Saved"}`,
  );
}
it("sends native Google and provider login bodies without empty email", async () => {
  await openInstance();
  fireEvent.click(screen.getByRole("button", { name: "Log in" }));
  await screen.findByRole("button", { name: "Close login" });
  const probes = calls.filter((call) => call.body?.action === "check").length;
  fireEvent(window, new Event("focus"));
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(calls.filter((call) => call.body?.action === "check")).toHaveLength(
    probes,
  );
  expect(calls.find((call) => call.path.endsWith("/login"))?.body).toEqual({
    target: "cindy",
    method: "google",
  });
  fireEvent.click(screen.getByRole("button", { name: "Close login" }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Log in" }).hasAttribute("disabled"),
    ).toBe(false),
  );
  const selects = screen.getAllByRole("combobox");
  const target = selects.find(
    (node) => node.getAttribute("name") === "target",
  )!;
  fireEvent.change(target, { target: { value: "provider" } });
  fireEvent.click(screen.getByRole("button", { name: "Log in" }));
  await waitFor(() =>
    expect(calls.filter((call) => call.path.endsWith("/login"))).toHaveLength(
      2,
    ),
  );
  expect(calls.filter((call) => call.path.endsWith("/login"))[1].body).toEqual({
    target: "provider",
  });
});
it("preserves saved authentication from check and submits recipient pairing code", async () => {
  await openInstance();
  fireEvent.click(screen.getByRole("button", { name: "Check saved login" }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Start" }).hasAttribute("disabled"),
    ).toBe(false),
  );
  expect(calls.filter((call) => call.body?.action === "check")).toHaveLength(2);
  expect(screen.getByText("Cindy: Saved · Provider: Saved")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  await screen.findByRole("button", { name: "Create invitation link" });
  const buttons = screen.getAllByRole("button", { name: "Refresh" });
  fireEvent.click(buttons[buttons.length - 1]);
  await screen.findByText("Guest");
  const code = screen.getByLabelText("Pairing code from recipient");
  expect((code as HTMLInputElement).value).toBe("");
  fireEvent.change(code, { target: { value: "1234" } });
  fireEvent.click(screen.getByRole("button", { name: "Approve" }));
  await waitFor(() =>
    expect(
      calls.some(
        (call) =>
          call.body?.action === "approve" &&
          call.body.code === "1234" &&
          call.body.id === "request",
      ),
    ).toBe(true),
  );
});

// Tier: unit. Native exit is not proof of saved provider login. The real parent
// must check its bound API, retain terminal output, and ignore stale completions.
it.each([0, 130])(
  "checks actual saved authentication on native exit %i without closing terminal",
  async (code) => {
    providerStatus = "missing";
    terminalEvents.autoExit = code;
    await openInstance();
    expect(
      screen
        .getAllByRole("option", { name: "Codex" })
        .find((option) => option.getAttribute("value") === "provider"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));
    await screen.findByRole("button", { name: "Close login" });
    await waitFor(() =>
      expect(
        calls.filter((call) => call.body?.action === "check"),
      ).toHaveLength(2),
    );
    await waitFor(() =>
      expect(screen.queryByText("Checking saved login…")).toBeNull(),
    );
    expect(
      screen.getByText("Cindy: Saved · Provider: No saved login"),
    ).toBeTruthy();
    expect(
      calls.filter(
        (call) =>
          call.path === "/api/instances/test/actions" &&
          call.body?.action === "check",
      ),
    ).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Close login" }));
    expect(
      screen.getByText("Cindy: Saved · Provider: No saved login"),
    ).toBeTruthy();
  },
);
it("discards old terminal completions after switching instance and in-flight checks after logout", async () => {
  includeOther = true;
  await openInstance();
  fireEvent.click(screen.getByRole("button", { name: "Log in" }));
  await screen.findByRole("button", { name: "Close login" });
  const oldExit = terminalEvents.lastExit;
  fireEvent.click(screen.getByRole("button", { name: "Close login" }));
  fireEvent.click(screen.getByRole("button", { name: /Other CLI/ }));
  expect(
    screen
      .getAllByRole("option", { name: "Claude Code" })
      .find((option) => option.getAttribute("value") === "provider"),
  ).toBeTruthy();
  await screen.findByText("Cindy: Saved · Provider: Saved");
  act(() => oldExit?.(0));
  expect(calls.filter((call) => call.body?.action === "check")).toHaveLength(2);
  let resolve!: () => void;
  checkGate = new Promise<void>((done) => {
    resolve = done;
  });
  fireEvent.click(screen.getByRole("button", { name: "Log in" }));
  fireEvent.click(await screen.findByRole("button", { name: "Finish login" }));
  await screen.findByText("Checking saved login…");
  expect(
    calls.some(
      (call) =>
        call.path === "/api/instances/other/actions" &&
        call.body?.action === "check",
    ),
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  await screen.findByRole("button", { name: "Sign in" });
  await act(async () => resolve());
  expect(screen.queryByText(/Cindy: Saved/)).toBeNull();
  expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
});

// Tier: unit. Inventory contains container metadata, not authentication. Opening
// detail must probe the selected real API once; refresh/focus must re-probe that
// instance only. No saved status may be inferred from absent metadata.
it("loads saved login on detail open and updates it on explicit/focus refresh", async () => {
  includeOther = true;
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: /My CLI/ }));
  await screen.findByText("Cindy: Saved · Provider: Saved");
  expect(calls.filter((call) => call.body?.action === "check")).toHaveLength(1);
  providerStatus = "missing";
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByText("Cindy: Saved · Provider: No saved login");
  providerStatus = "authenticated";
  fireEvent(window, new Event("focus"));
  await screen.findByText("Cindy: Saved · Provider: Saved");
  expect(calls.filter((call) => call.body?.action === "check")).toHaveLength(3);
  expect(
    calls.some((call) => call.path === "/api/instances/other/actions"),
  ).toBe(false);
  omitAuthentication = true;
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByText("Cindy: Unknown · Provider: Unknown");
  expect(
    screen.queryByText("Cindy: No saved login · Provider: No saved login"),
  ).toBeNull();
  expect(calls.filter((call) => call.body?.action === "check")).toHaveLength(4);
});
it("checks a newly created selected instance even while create is settling", async () => {
  render(<App />);
  await screen.findByRole("button", { name: /My CLI/ });
  fireEvent.click(screen.getByText("Create instance", { selector: "summary" }));
  fireEvent.change(screen.getByLabelText("Name"), {
    target: { value: "Created CLI" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create instance" }));
  await screen.findByText("Cindy: Saved · Provider: Saved");
  expect(
    calls.filter(
      (call) =>
        call.path === "/api/instances/created/actions" &&
        call.body?.action === "check",
    ),
  ).toHaveLength(1);
});

it("ignores stale detail probe failures after selection changes", async () => {
  includeOther = true;
  accountSnapshots.test = {
    cindy: { displayName: "Synthetic previous owner" },
    provider: null,
  };
  accountSnapshots.other = {
    cindy: { displayName: "Synthetic selected owner" },
    provider: null,
  };
  providerStatus = "missing";
  checkGateId = "test";
  failedCheckId = "test";
  let resolve!: () => void;
  checkGate = new Promise<void>((done) => {
    resolve = done;
  });
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: /My CLI/ }));
  await screen.findByText("Checking saved login…");
  fireEvent.click(screen.getByRole("button", { name: /Other CLI/ }));
  await screen.findByText("Cindy: Saved · Provider: No saved login");
  await act(async () => resolve());
  expect(screen.getByRole("heading", { name: "Other CLI" })).toBeTruthy();
  expect(screen.getByText("Synthetic selected owner")).toBeTruthy();
  expect(screen.queryByText("Synthetic previous owner")).toBeNull();
  expect(
    screen.getByText("Cindy: Saved · Provider: No saved login"),
  ).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
});
it("deduplicates a reopened pending probe and drops its result after logout", async () => {
  includeOther = true;
  checkGateId = "test";
  let resolve!: () => void;
  checkGate = new Promise<void>((done) => {
    resolve = done;
  });
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: /My CLI/ }));
  await screen.findByText("Checking saved login…");
  fireEvent.click(screen.getByRole("button", { name: /Other CLI/ }));
  await screen.findByText("Cindy: Saved · Provider: Saved");
  fireEvent.click(screen.getByRole("button", { name: /My CLI/ }));
  await screen.findByText("Checking saved login…");
  expect(
    calls.filter(
      (call) =>
        call.path === "/api/instances/test/actions" &&
        call.body?.action === "check",
    ),
  ).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  await screen.findByRole("button", { name: "Sign in" });
  await act(async () => resolve());
  expect(screen.queryByText(/Cindy: Saved/)).toBeNull();
  expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
});

// Tier: unit. Saved authentication is distinct from account identity. Render
// native allowlisted fields only, clear explicit null/missing snapshots and never
// expose extra response fields or masked keys through the production detail UI.
it("shows allowlisted account identities and clears null/unverified snapshots", async () => {
  accountSnapshots.test = {
    cindy: {
      displayName: "Synthetic Owner",
      email: "owner@example.test",
      loginMethod: "cindy",
      plan: "Pro",
      organization: "Synthetic team",
      token: "synthetic-secret-token",
      accountId: "synthetic-secret-id",
      avatarUrl: "synthetic-secret-avatar",
    },
    provider: {
      displayName: "provider@example.test",
      email: "provider@example.test",
      loginMethod: "chatgpt",
      plan: "Plus",
      rawResponse: "synthetic-secret-response",
    },
  };
  await openInstance();
  expect(screen.getByText("Synthetic Owner")).toBeTruthy();
  expect(screen.getByText("owner@example.test")).toBeTruthy();
  expect(screen.getAllByText("provider@example.test")).toHaveLength(1);
  expect(screen.getByText("Cindy account")).toBeTruthy();
  expect(screen.getByText("ChatGPT account")).toBeTruthy();
  expect(screen.getByText("Pro")).toBeTruthy();
  expect(screen.getByText("Plus")).toBeTruthy();
  expect(screen.getByText("Synthetic team")).toBeTruthy();
  expect(document.body.textContent).not.toContain("synthetic-secret");
  accountSnapshots.test = {
    cindy: { displayName: "Synthetic switched owner", loginMethod: "cindy" },
    provider: { loginMethod: "claude" },
  };
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByText("Synthetic switched owner");
  expect(screen.queryByText("Synthetic Owner")).toBeNull();
  expect(screen.getByText("Claude account")).toBeTruthy();
  accountSnapshots.test = { cindy: null, provider: null };
  let resolve!: () => void;
  checkGate = new Promise<void>((done) => {
    resolve = done;
  });
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByText("Checking saved login…");
  expect(screen.getByText("Synthetic switched owner")).toBeTruthy();
  await act(async () => resolve());
  checkGate = undefined;
  await waitFor(() =>
    expect(screen.getAllByText("Account information unavailable")).toHaveLength(
      2,
    ),
  );
  expect(screen.queryByText("Synthetic Owner")).toBeNull();
  expect(screen.getByText("Cindy: Saved · Provider: Saved")).toBeTruthy();
  accountSnapshots.test = {
    cindy: { loginMethod: "cindy" },
    provider: { loginMethod: "chatgpt", plan: "Pro" },
  };
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByText("Pro");
  expect(screen.getByText("Cindy account")).toBeTruthy();
  expect(screen.getByText("ChatGPT account")).toBeTruthy();
  expect(screen.getAllByText("Account information unavailable")).toHaveLength(
    2,
  );
  accountSnapshots.test = {
    cindy: { displayName: "Stale Owner" },
    provider: { displayName: "Stale Provider" },
  };
  omitAuthentication = true;
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByText("Cindy: Unknown · Provider: Unknown");
  expect(screen.queryByText("Stale Owner")).toBeNull();
  expect(screen.queryByText("Stale Provider")).toBeNull();
});
it("shows only API Key login method and clears the account when authentication disappears", async () => {
  accountSnapshots.test = {
    cindy: null,
    provider: {
      loginMethod: "api-key",
      displayName: "synthetic-masked-key",
      email: "synthetic-key-fragment",
      plan: "synthetic-key-plan",
      apiKey: "synthetic-secret-key",
    },
  };
  await openInstance();
  expect(screen.getByText("API Key")).toBeTruthy();
  expect(document.body.textContent).not.toContain("synthetic-masked-key");
  expect(document.body.textContent).not.toContain("synthetic-key-fragment");
  expect(document.body.textContent).not.toContain("synthetic-key-plan");
  expect(document.body.textContent).not.toContain("synthetic-secret-key");
  providerStatus = "missing";
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByText("Cindy: Saved · Provider: No saved login");
  expect(screen.queryByText("API Key")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  await screen.findByRole("button", { name: "Sign in" });
  expect(screen.queryByText("Account information unavailable")).toBeNull();
});
