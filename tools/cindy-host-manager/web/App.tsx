import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  Api,
  ApiError,
  safeHttps,
  type AccountIdentity,
  type Instance,
  type Settings,
} from "./api";
import { translator, errorText, type Key, type Locale } from "./i18n";
const LoginTerminal = lazy(() =>
  import("./Terminal").then((module) => ({ default: module.LoginTerminal })),
);
const api = new Api();
type Share = {
  shareId: string;
  providerLabel: string;
  requests: { requestId: string; displayName: string; expiresAt: string }[];
  members: {
    memberId: string;
    displayName: string;
    status: "active" | "paused";
  }[];
};
function mergeInstance(
  current: Instance | undefined,
  incoming: Instance,
  verified = false,
): Instance {
  const authentication =
    incoming.authentication ?? (verified ? undefined : current?.authentication);
  const accounts =
    incoming.accounts === undefined && !verified
      ? current?.accounts
      : incoming.accounts;
  return {
    ...current,
    ...incoming,
    authentication,
    accounts: {
      cindy:
        authentication?.cindy === "stored" ? (accounts?.cindy ?? null) : null,
      provider:
        authentication?.provider === "authenticated"
          ? (accounts?.provider ?? null)
          : null,
    },
  };
}
export function App() {
  const [locale, setLocale] = useState<Locale>(
    navigator.language.startsWith("zh") ? "zh-CN" : "en",
  );
  const t = translator(locale);
  const [theme, setTheme] = useState(
    matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  );
  const [auth, setAuth] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const [instances, setInstances] = useState<Instance[]>([]);
  const [selected, setSelected] = useState("");
  const selectedId = useRef("");
  const sessionGeneration = useRef(0);
  const checkRequests = useRef(
    new Map<string, Promise<{ instance: Instance }>>(),
  );
  const checkContext = useRef<{
    instanceId: string;
    generation: number;
  } | null>(null);
  const profileAction = useRef<string | null>(null);
  const instance = instances.find((item) => item.id === selected);
  const [settings, setSettings] = useState<Settings>();
  const [loginId, setLoginId] = useState("");
  const [loginChecking, setLoginChecking] = useState(false);
  const generation = useRef(0);
  const loginContext = useRef<{
    id: string;
    instanceId: string;
    generation: number;
    completed: boolean;
  } | null>(null);
  useEffect(
    () => () => {
      generation.current++;
      checkContext.current = null;
      checkRequests.current.clear();
      loginContext.current = null;
    },
    [],
  );
  const [loginTarget, setLoginTarget] = useState("cindy");
  const [loginMethod, setLoginMethod] = useState("google");
  const [shares, setShares] = useState<Share[] | null>(null);
  const [invitation, setInvitation] = useState<{
    url: string;
    expiresAt?: string;
  } | null>(null);
  const [usage, setUsage] = useState<unknown>(null);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  function clearSensitive(endSession = true) {
    generation.current++;
    checkContext.current = null;
    if (endSession) {
      sessionGeneration.current++;
      checkRequests.current.clear();
      selectedId.current = "";
      setSelected("");
    }
    loginContext.current = null;
    setLoginChecking(false);
    setLoginId("");
    setShares(null);
    setInvitation(null);
    setUsage(null);
  }
  async function session() {
    const result = await api.request<{
      authenticated: boolean;
      csrfToken?: string;
    }>("/session");
    api.csrf = result.csrfToken ?? "";
    setAuth(result.authenticated);
  }
  async function refresh() {
    const epoch = generation.current;
    const [data, config] = await Promise.all([
      api.request<{ instances: Instance[] }>("/instances"),
      api.request<Settings>("/settings"),
    ]);
    if (epoch !== generation.current) return;
    setInstances((previous) =>
      data.instances.map((item) =>
        mergeInstance(
          previous.find((old) => old.id === item.id),
          item,
        ),
      ),
    );
    setSettings(config);
  }
  async function refreshSelected() {
    const id = selectedId.current;
    const epoch = generation.current;
    await refresh();
    if (id) await checkAuthentication(id, epoch);
  }
  async function run(action: () => Promise<void>) {
    if (pending) return;
    setPending(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (failure) {
      if (
        failure instanceof ApiError &&
        failure.status === 401 &&
        failure.code !== "LOGIN_FAILED"
      ) {
        clearSensitive();
        setAuth(false);
        setError(t("sessionExpired"));
      } else
        setError(
          failure instanceof ApiError
            ? errorText(failure.code, t)
            : t("requestFailed"),
        );
    } finally {
      setPending(false);
    }
  }
  useEffect(() => {
    void run(session);
  }, []);
  useEffect(() => {
    if (auth) void run(refresh);
  }, [auth]);
  useEffect(() => {
    const focus = () => {
      if (auth && !pending && !loginChecking && !loginId)
        void run(refreshSelected);
    };
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, [auth, pending, loginId, loginChecking]);
  function choose(id: string) {
    clearSensitive(false);
    selectedId.current = id;
    setSelected(id);
    setError("");
    // Creation calls choose while run() is still settling. The profile operation
    // has finished, so check directly rather than dropping it on pending state.
    void checkAuthentication(id, generation.current);
  }
  async function checkAuthentication(
    instanceId: string,
    epoch: number,
    stillValid: () => boolean = () => true,
  ) {
    const current = () =>
      generation.current === epoch &&
      selectedId.current === instanceId &&
      stillValid();
    if (
      !current() ||
      profileAction.current === instanceId ||
      (loginContext.current && !loginContext.current.completed)
    )
      return;
    if (
      checkContext.current?.instanceId === instanceId &&
      checkContext.current.generation === epoch
    )
      return;
    const token = { instanceId, generation: epoch };
    checkContext.current = token;
    setLoginChecking(true);
    try {
      const key = `${sessionGeneration.current}:${instanceId}`;
      let request = checkRequests.current.get(key);
      if (!request) {
        request = api.request<{ instance: Instance }>(
          `/instances/${encodeURIComponent(instanceId)}/actions`,
          "POST",
          { action: "check" },
        );
        checkRequests.current.set(key, request);
        const clear = () => {
          if (checkRequests.current.get(key) === request)
            checkRequests.current.delete(key);
        };
        void request.then(clear, clear);
      }
      const { instance: updated } = await request;
      if (!current() || updated.id !== instanceId) return;
      setInstances((items) =>
        items.map((item) =>
          item.id === instanceId ? mergeInstance(item, updated, true) : item,
        ),
      );
    } catch (failure) {
      if (!current()) return;
      if (failure instanceof ApiError && failure.status === 401) {
        clearSensitive();
        setAuth(false);
        setError(t("sessionExpired"));
      } else {
        setInstances((items) =>
          items.map((item) =>
            item.id === instanceId
              ? {
                  ...item,
                  authentication: { cindy: "unknown", provider: "unknown" },
                  accounts: { cindy: null, provider: null },
                }
              : item,
          ),
        );
        setError(
          failure instanceof ApiError
            ? errorText(failure.code, t)
            : t("requestFailed"),
        );
      }
    } finally {
      if (checkContext.current === token) {
        checkContext.current = null;
        setLoginChecking(false);
      }
    }
  }
  async function finishLogin(id: string, instanceId: string) {
    const context = loginContext.current;
    if (
      !context ||
      context.id !== id ||
      context.instanceId !== instanceId ||
      context.completed ||
      context.generation !== generation.current
    )
      return;
    context.completed = true;
    await checkAuthentication(
      instanceId,
      context.generation,
      () => loginContext.current === context,
    );
  }
  async function action(value: string) {
    const id = selectedId.current;
    const epoch = generation.current;
    if (value === "check") {
      await checkAuthentication(id, epoch);
      return;
    }
    profileAction.current = id;
    try {
      const { instance: updated } = await api.request<{ instance: Instance }>(
        `/instances/${encodeURIComponent(id)}/actions`,
        "POST",
        { action: value },
      );
      await refresh();
      if (epoch !== generation.current || selectedId.current !== id) return;
      setInstances((items) =>
        items.map((item) =>
          item.id === updated.id ? mergeInstance(item, updated) : item,
        ),
      );
    } finally {
      if (profileAction.current === id) profileAction.current = null;
    }
  }
  async function share(action: string, id?: string, code?: string) {
    const { result } = await api.request<{ result: unknown }>(
      `/instances/${selected}/share`,
      "POST",
      { action, id, code },
    );
    if (action === "link")
      setInvitation(result as { url: string; expiresAt?: string });
    else if (action === "list") {
      const data = result as { shares: Share[]; usage: unknown };
      setShares(data.shares);
      setUsage(data.usage);
    } else if (action === "usage" || action === "quota") setUsage(result);
    else await share("list");
  }
  const formData = (form: HTMLFormElement) =>
    Object.fromEntries(new FormData(form));
  return (
    <>
      <header>
        <div>
          <h1>{t("title")}</h1>
          <p>{t("subtitle")}</p>
        </div>
        <div className="toolbar">
          <label className="compact">
            {t("language")}
            <select
              value={locale}
              onChange={(event) => setLocale(event.target.value as Locale)}
            >
              <option value="en">English</option>
              <option value="zh-CN">简体中文</option>
            </select>
          </label>
          <label className="compact">
            {t("theme")}
            <select
              value={theme}
              onChange={(event) => setTheme(event.target.value)}
            >
              <option value="light">{t("light")}</option>
              <option value="dark">{t("dark")}</option>
            </select>
          </label>
          {auth && (
            <button
              disabled={pending}
              onClick={() =>
                void run(async () => {
                  clearSensitive();
                  await api.request("/session", "DELETE");
                  setAuth(false);
                  setInstances([]);
                  setSettings(undefined);
                })
              }
            >
              {t("signOut")}
            </button>
          )}
        </div>
      </header>
      <div className="feedback" aria-live="polite">
        {pending && <span role="status">{t("pending")}</span>}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
      </div>
      {auth === null ? (
        <p>{t("loading")}</p>
      ) : !auth ? (
        <main className="signin">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              const password = String(formData(form).password);
              form.reset();
              void run(async () => {
                const result = await api.request<{
                  authenticated: boolean;
                  csrfToken: string;
                }>("/session", "POST", { password });
                api.csrf = result.csrfToken;
                setAuth(result.authenticated);
              });
            }}
          >
            <h2>{t("signIn")}</h2>
            <label>
              {t("password")}
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                required
              />
            </label>
            <button className="primary" disabled={pending}>
              {t("signIn")}
            </button>
          </form>
        </main>
      ) : (
        <main className="workspace">
          <aside>
            <div className="toolbar">
              <h2>{t("instances")}</h2>
              <button
                disabled={pending || !!loginId || loginChecking}
                onClick={() => void run(refreshSelected)}
              >
                {t("refresh")}
              </button>
            </div>
            {instances.length === 0 && <p>{t("empty")}</p>}
            <nav aria-label={t("instances")}>
              {instances.map((item) => (
                <button
                  className="instance-row"
                  key={item.id}
                  aria-current={item.id === selected ? "true" : undefined}
                  disabled={pending || !!loginId}
                  onClick={() => choose(item.id)}
                >
                  <strong>{item.name}</strong>
                  <span>
                    {item.engine === "codex" ? "Codex" : "Claude Code"} ·{" "}
                    {t(item.state)}
                  </span>
                </button>
              ))}
            </nav>
            <details>
              <summary>{t("create")}</summary>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = event.currentTarget;
                  const body = formData(form);
                  void run(async () => {
                    const result = await api.request<{ instance: Instance }>(
                      "/instances",
                      "POST",
                      body,
                    );
                    form.reset();
                    await refresh();
                    choose(result.instance.id);
                  });
                }}
              >
                <label>
                  {t("name")}
                  <input name="name" required maxLength={100} />
                </label>
                <label>
                  {t("engine")}
                  <select name="engine">
                    <option value="codex">Codex</option>
                    <option value="claude-code">Claude Code</option>
                  </select>
                </label>
                <label>
                  {t("proxy")}
                  <select name="proxyMode">
                    <option value="none">{t("none")}</option>
                    <option value="default">{t("default")}</option>
                  </select>
                </label>
                <button
                  className="primary"
                  disabled={pending || !!loginId || loginChecking}
                >
                  {t("create")}
                </button>
              </form>
            </details>
            <details>
              <summary>{t("settings")}</summary>
              <p>
                {t(
                  settings?.proxyConfigured
                    ? "proxyConfigured"
                    : "proxyUnconfigured",
                )}
              </p>
              <p>{t("proxyNote")}</p>
              <form
                key={settings?.proxyUrl ?? ""}
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = event.currentTarget;
                  const data = formData(form);
                  const body = {
                    proxyUrl: data.proxyUrl || null,
                    ...(data.proxyUsername
                      ? { proxyUsername: data.proxyUsername }
                      : {}),
                    ...(data.proxyPassword
                      ? { proxyPassword: data.proxyPassword }
                      : {}),
                  };
                  form.reset();
                  void run(async () => {
                    await api.request("/settings", "PUT", body);
                    await refresh();
                    setNotice(t("saved"));
                  });
                }}
              >
                <label>
                  {t("proxyUrl")}
                  <input
                    name="proxyUrl"
                    type="url"
                    defaultValue={settings?.proxyUrl ?? ""}
                    placeholder="http://proxy.example:8080"
                    pattern="http://.*"
                  />
                </label>
                <label>
                  {t("proxyUsername")}
                  <input name="proxyUsername" autoComplete="off" />
                </label>
                <label>
                  {t("proxyPassword")}
                  <input
                    name="proxyPassword"
                    type="password"
                    autoComplete="new-password"
                  />
                </label>
                <button disabled={pending}>{t("save")}</button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() =>
                    void run(async () => {
                      await api.request("/settings", "PUT", { proxyUrl: null });
                      await refresh();
                    })
                  }
                >
                  {t("clearProxy")}
                </button>
              </form>
            </details>
          </aside>
          <article>
            {!instance ? (
              <p>{t("select")}</p>
            ) : (
              <>
                <div className="toolbar">
                  <div>
                    <h2>{instance.name}</h2>
                    <p>
                      {instance.engine === "codex" ? "Codex" : "Claude Code"} ·{" "}
                      {t(instance.state)}
                    </p>
                  </div>
                </div>
                <p>{t("stateNote")}</p>
                {instance.error && (
                  <p className="error" role="alert">
                    {instance.error}
                  </p>
                )}
                <div className="toolbar">
                  {(["start", "stop", "restart", "check"] as const).map(
                    (value) => (
                      <button
                        key={value}
                        disabled={
                          pending ||
                          !!loginId ||
                          loginChecking ||
                          instance.state === "busy" ||
                          (value === "start" && instance.state === "running") ||
                          ((value === "stop" || value === "restart") &&
                            instance.state !== "running")
                        }
                        onClick={() =>
                          void run(async () => {
                            setShares(null);
                            setInvitation(null);
                            await action(value);
                          })
                        }
                      >
                        {t(value)}
                      </button>
                    ),
                  )}
                </div>
                <details>
                  <summary>{t("settings")}</summary>
                  <form
                    key={instance.id + instance.name + instance.proxyMode}
                    onSubmit={(event) => {
                      event.preventDefault();
                      const body = formData(event.currentTarget);
                      void run(async () => {
                        await api.request(
                          `/instances/${selected}`,
                          "PATCH",
                          body,
                        );
                        await refresh();
                      });
                    }}
                  >
                    <label>
                      {t("name")}
                      <input
                        name="name"
                        required
                        defaultValue={instance.name}
                      />
                    </label>
                    <label>
                      {t("proxy")}
                      <select
                        name="proxyMode"
                        defaultValue={instance.proxyMode}
                        disabled={instance.state === "running"}
                      >
                        <option value="none">{t("none")}</option>
                        <option value="default">{t("default")}</option>
                      </select>
                    </label>
                    <button disabled={pending || !!loginId || loginChecking}>
                      {t("save")}
                    </button>
                  </form>
                </details>
                <section>
                  <h3>{t("accounts")}</h3>
                  <p>
                    {t("cindy")}:{" "}
                    {t(
                      instance.authentication?.cindy === "missing"
                        ? "authMissing"
                        : (instance.authentication?.cindy ?? "unknown"),
                    )}{" "}
                    · {t("provider")}:{" "}
                    {t(
                      instance.authentication?.provider === "missing"
                        ? "authMissing"
                        : (instance.authentication?.provider ?? "unknown"),
                    )}
                  </p>
                  <div className="account-identities">
                    <AccountDetails
                      title={t("cindy")}
                      account={instance.accounts?.cindy}
                      saved={instance.authentication?.cindy === "stored"}
                      t={t}
                    />
                    <AccountDetails
                      title={
                        instance.engine === "codex" ? "Codex" : "Claude Code"
                      }
                      account={instance.accounts?.provider}
                      saved={
                        instance.authentication?.provider === "authenticated"
                      }
                      t={t}
                    />
                  </div>
                  <p>{t("loginNote")}</p>
                  {loginChecking && <p role="status">{t("checkingLogin")}</p>}
                  {loginId ? (
                    <Suspense fallback={<p>{t("loading")}</p>}>
                      <LoginTerminal
                        id={loginId}
                        t={t}
                        onExit={() => void finishLogin(loginId, instance.id)}
                        onClose={() => {
                          setLoginId("");
                          if (!loginContext.current?.completed) {
                            generation.current++;
                            loginContext.current = null;
                          }
                        }}
                      />
                    </Suspense>
                  ) : (
                    <form
                      className="login-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const fields = formData(event.currentTarget);
                        const data =
                          fields.target === "provider"
                            ? { target: "provider" }
                            : {
                                target: "cindy",
                                method: fields.method,
                                ...(fields.method === "email"
                                  ? { email: fields.email }
                                  : {}),
                              };
                        event.currentTarget.reset();
                        const instanceId = instance.id;
                        void run(async () => {
                          const epoch = ++generation.current;
                          checkContext.current = null;
                          setLoginChecking(false);
                          const context = {
                            id: "",
                            instanceId,
                            generation: epoch,
                            completed: false,
                          };
                          loginContext.current = context;
                          let result: { loginId: string };
                          try {
                            result = await api.request<{ loginId: string }>(
                              `/instances/${encodeURIComponent(instanceId)}/login`,
                              "POST",
                              data,
                            );
                          } catch (failure) {
                            if (loginContext.current === context)
                              loginContext.current = null;
                            throw failure;
                          }
                          if (generation.current !== epoch) return;
                          loginContext.current = {
                            id: result.loginId,
                            instanceId,
                            generation: epoch,
                            completed: false,
                          };
                          setLoginId(result.loginId);
                        });
                      }}
                    >
                      <label>
                        {t("accounts")}
                        <select
                          name="target"
                          value={loginTarget}
                          onChange={(event) =>
                            setLoginTarget(event.target.value)
                          }
                        >
                          <option value="cindy">{t("cindy")}</option>
                          <option value="provider">
                            {instance.engine === "codex"
                              ? "Codex"
                              : "Claude Code"}
                          </option>
                        </select>
                      </label>
                      {loginTarget === "cindy" && (
                        <label>
                          {t("login")}
                          <select
                            name="method"
                            value={loginMethod}
                            onChange={(event) =>
                              setLoginMethod(event.target.value)
                            }
                          >
                            <option value="google">{t("google")}</option>
                            <option value="email">{t("email")}</option>
                          </select>
                        </label>
                      )}
                      {loginTarget === "cindy" && loginMethod === "email" && (
                        <label>
                          {t("emailAddress")}
                          <input
                            name="email"
                            type="email"
                            autoComplete="email"
                            required
                          />
                        </label>
                      )}
                      <button
                        disabled={
                          pending ||
                          loginChecking ||
                          instance.state === "running" ||
                          instance.state === "busy"
                        }
                      >
                        {t("login")}
                      </button>
                    </form>
                  )}
                </section>
                <section>
                  <h3>{t("sharing")}</h3>
                  {instance.state !== "running" ? (
                    <p>{t("shareNote")}</p>
                  ) : (
                    <>
                      <div className="toolbar">
                        <button
                          disabled={pending}
                          onClick={() => void run(() => share("list"))}
                        >
                          {t("refresh")}
                        </button>
                        <button
                          disabled={pending}
                          onClick={() => void run(() => share("link"))}
                        >
                          {t("invitation")}
                        </button>
                      </div>
                      {invitation && (
                        <div className="invitation">
                          <p>{t("invitationNote")}</p>
                          <label>
                            {t("invitation")}
                            <input readOnly value={invitation.url} />
                          </label>
                          {invitation.expiresAt && (
                            <p>
                              {t("expires")}:{" "}
                              {new Date(invitation.expiresAt).toLocaleString(
                                locale,
                              )}
                            </p>
                          )}
                          <button
                            onClick={() =>
                              void run(async () => {
                                await navigator.clipboard.writeText(
                                  invitation.url,
                                );
                                setNotice(t("copied"));
                              })
                            }
                          >
                            {t("copy")}
                          </button>
                          {safeHttps(invitation.url) && (
                            <a
                              href={safeHttps(invitation.url)!}
                              target="_blank"
                              rel="noopener noreferrer"
                              referrerPolicy="no-referrer"
                            >
                              {t("invitation")}
                            </a>
                          )}
                          <button onClick={() => setInvitation(null)}>
                            {t("close")}
                          </button>
                        </div>
                      )}
                      {shares && (
                        <>
                          <h4>{t("requests")}</h4>
                          {shares.every((value) => !value.requests.length) && (
                            <p>{t("noRequests")}</p>
                          )}
                          {shares.flatMap((value) =>
                            value.requests.map((request) => (
                              <form
                                className="share-row"
                                key={request.requestId}
                                onSubmit={(event) => {
                                  event.preventDefault();
                                  const code = String(
                                    formData(event.currentTarget).code,
                                  );
                                  event.currentTarget.reset();
                                  void run(() =>
                                    share("approve", request.requestId, code),
                                  );
                                }}
                              >
                                <strong>{request.displayName}</strong>
                                <span>
                                  {t("expires")}:{" "}
                                  {new Date(request.expiresAt).toLocaleString(
                                    locale,
                                  )}
                                </span>
                                <label>
                                  {t("code")}
                                  <input
                                    name="code"
                                    required
                                    autoComplete="off"
                                    inputMode="numeric"
                                    pattern="[0-9]{4}"
                                    maxLength={4}
                                  />
                                </label>
                                <button disabled={pending}>
                                  {t("approve")}
                                </button>
                                <button
                                  type="button"
                                  disabled={pending}
                                  onClick={() =>
                                    void run(() =>
                                      share("reject", request.requestId),
                                    )
                                  }
                                >
                                  {t("reject")}
                                </button>
                              </form>
                            )),
                          )}
                          <h4>{t("members")}</h4>
                          {shares.every((value) => !value.members.length) && (
                            <p>{t("noMembers")}</p>
                          )}
                          {shares.flatMap((value) =>
                            value.members.map((member) => (
                              <div className="share-row" key={member.memberId}>
                                <strong>{member.displayName}</strong>
                                <span>{t(member.status)}</span>
                                <button
                                  disabled={pending}
                                  onClick={() =>
                                    void run(() =>
                                      share(
                                        member.status === "active"
                                          ? "pause"
                                          : "resume",
                                        member.memberId,
                                      ),
                                    )
                                  }
                                >
                                  {t(
                                    member.status === "active"
                                      ? "pause"
                                      : "resume",
                                  )}
                                </button>
                                <button
                                  disabled={pending}
                                  onClick={() => {
                                    if (confirm(t("removeConfirm")))
                                      void run(() =>
                                        share("remove", member.memberId),
                                      );
                                  }}
                                >
                                  {t("remove")}
                                </button>
                              </div>
                            )),
                          )}
                          <h4>{t("usage")}</h4>
                          <Usage value={usage} shares={shares} t={t} />
                        </>
                      )}
                    </>
                  )}
                </section>
              </>
            )}
          </article>
        </main>
      )}
    </>
  );
}
function AccountDetails({
  title,
  account,
  saved,
  t,
}: {
  title: string;
  account?: AccountIdentity | null;
  saved: boolean;
  t: (key: Key) => string;
}) {
  if (!saved) return null;
  const text = (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim() : undefined;
  const apiKey = account?.loginMethod === "api-key";
  const name = apiKey ? undefined : text(account?.displayName);
  const email = apiKey ? undefined : text(account?.email);
  const plan = apiKey ? undefined : text(account?.plan);
  const organization = apiKey ? undefined : text(account?.organization);
  const methods: [AccountIdentity["loginMethod"], Key][] = [
    ["cindy", "loginMethodCindy"],
    ["chatgpt", "loginMethodChatgpt"],
    ["claude", "loginMethodClaude"],
    ["api-key", "loginMethodApiKey"],
  ];
  const method = methods.find(([value]) => value === account?.loginMethod)?.[1];
  const available = name || email || plan || organization || method;
  return (
    <section className="account-details" aria-label={title}>
      <h4>{title}</h4>
      {!apiKey && !name && !email && !organization && (
        <p>{t("accountUnavailable")}</p>
      )}
      {available && (
        <>
          {name && <p className="account-name">{name}</p>}
          {email && email.toLowerCase() !== name?.toLowerCase() && (
            <p>{email}</p>
          )}
          <dl>
            {method && (
              <>
                <dt>{t("accountLoginMethod")}</dt>
                <dd>{t(method)}</dd>
              </>
            )}
            {plan && (
              <>
                <dt>{t("accountPlan")}</dt>
                <dd>{plan}</dd>
              </>
            )}
            {organization && (
              <>
                <dt>{t("accountOrganization")}</dt>
                <dd>{organization}</dd>
              </>
            )}
          </dl>
        </>
      )}
    </section>
  );
}
function Usage({
  value,
  shares,
  t,
}: {
  value: unknown;
  shares: Share[];
  t: (key: Key) => string;
}) {
  const rows = Array.isArray(value)
    ? (value as {
        memberId: string;
        models?: {
          model: string;
          turns: number;
          inputTokens: number;
          outputTokens: number;
        }[];
      }[])
    : [];
  if (!rows.length) return <p>{t("noUsage")}</p>;
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>{t("members")}</th>
            <th>{t("model")}</th>
            <th>{t("turns")}</th>
            <th>{t("inputTokens")}</th>
            <th>{t("outputTokens")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.flatMap((row, index) =>
            (row.models ?? []).map((model, modelIndex) => (
              <tr key={`${index}-${modelIndex}`}>
                <td>
                  {shares
                    .flatMap((share) => share.members)
                    .find((member) => member.memberId === row.memberId)
                    ?.displayName ?? t("unknown")}
                </td>
                <td>{model.model}</td>
                <td>{model.turns}</td>
                <td>{model.inputTokens}</td>
                <td>{model.outputTokens}</td>
              </tr>
            )),
          )}
        </tbody>
      </table>
    </div>
  );
}
