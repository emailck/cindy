import { ProxyFields, proxyFormData } from "./ProxyFields";
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

function stateDot(state: Instance["state"]): string {
  if (state === "running") return "ok";
  if (state === "busy") return "busy";
  if (state === "error" || state === "missing") return "err";
  return "";
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
  const [listFilter, setListFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
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
  const createDetailsRef = useRef<HTMLDetailsElement>(null);
  const settingsDetailsRef = useRef<HTMLDetailsElement>(null);
  const instanceSettingsDetailsRef = useRef<HTMLDetailsElement>(null);
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

  function backToList() {
    clearSensitive(false);
    selectedId.current = "";
    setSelected("");
    setError("");
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

  async function run(actionFn: () => Promise<void>) {
    if (pending) return;
    setPending(true);
    setError("");
    setNotice("");
    try {
      await actionFn();
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

  async function share(actionName: string, id?: string, code?: string) {
    const { result } = await api.request<{ result: unknown }>(
      `/instances/${selected}/share`,
      "POST",
      { action: actionName, id, code },
    );
    if (actionName === "link")
      setInvitation(result as { url: string; expiresAt?: string });
    else if (actionName === "list") {
      const data = result as { shares: Share[]; usage: unknown };
      setShares(data.shares);
      setUsage(data.usage);
    } else if (actionName === "usage" || actionName === "quota") setUsage(result);
    else await share("list");
  }

  const formData = (form: HTMLFormElement) =>
    Object.fromEntries(new FormData(form));

  const filteredInstances = instances.filter((item) => {
    if (listFilter !== "all" && item.state !== listFilter) return false;
    const q = searchQuery.trim().toLowerCase();
    if (!q) return true;
    const hay = [
      item.name,
      item.engine === "codex" ? "codex" : "claude code",
      item.accounts?.cindy?.displayName ?? "",
      item.accounts?.cindy?.email ?? "",
      item.accounts?.provider?.displayName ?? "",
      item.accounts?.provider?.email ?? "",
    ]
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  });

  return (
    <>
      <header className="app-header">
        <div className="app-brand">
          <div className="app-logo" aria-hidden="true">
            &gt;_
          </div>
          <div>
            <h1>{t("title")}</h1>
            <p>{t("subtitle")}</p>
          </div>
        </div>
        <div className="header-controls">
          <label className="compact">
            <span>{t("language")}</span>
            <select
              value={locale}
              onChange={(event) => setLocale(event.target.value as Locale)}
            >
              <option value="en">English</option>
              <option value="zh-CN">简体中文</option>
            </select>
          </label>
          <label className="compact">
            <span>{t("theme")}</span>
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

      <div className="feedback toast-layer" aria-live="polite">
        {pending && (
          <span className="toast-pill" role="status">
            <span className="toast-dot pending" />
            {t("pending")}
          </span>
        )}
        {error && (
          <p role="alert" className="error toast-pill">
            <span className="toast-dot error" />
            {error}
          </p>
        )}
        {notice && (
          <p className="toast-pill" role="status">
            <span className="toast-dot" />
            {notice}
          </p>
        )}
      </div>

      {auth === null ? (
        <div className="page-container">
          <p>{t("loading")}</p>
        </div>
      ) : !auth ? (
        <main className="signin-stage">
          <form
            className="signin"
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
      ) : !instance ? (
        /* ==================== 一级页面：全宽实例列表页 ==================== */
        <main className="page-container list-page">
          <div className="list-page-header">
            <div className="list-page-title">
              <h2>
                {t("instances")}{" "}
                <span className="count-chip">({instances.length})</span>
              </h2>
              <p>{t("select")}</p>
            </div>
            <div className="list-page-actions">
              <button
                disabled={pending || !!loginId || loginChecking}
                onClick={() => void run(refreshSelected)}
              >
                ↻ {t("refresh")}
              </button>

              {/* 全局默认 Proxy 设置弹窗卡片 */}
              <details className="modal-details" ref={settingsDetailsRef}>
                <summary className="btn-summary">
                  ⚙ {t("settings")} ·{" "}
                  {t(
                    settings?.proxyConfigured
                      ? "proxyConfigured"
                      : "proxyUnconfigured",
                  )}
                </summary>
                <div className="modal-scrim">
                  <div className="modal-panel">
                    <div className="modal-head">
                      <div>
                        <h3>{t("settings")}</h3>
                        <p className="modal-sub">
                          {t(
                            settings?.proxyConfigured
                              ? "proxyConfigured"
                              : "proxyUnconfigured",
                          )}
                        </p>
                      </div>
                      <button
                        type="button"
                        className="sm"
                        onClick={() => {
                          if (settingsDetailsRef.current)
                            settingsDetailsRef.current.open = false;
                        }}
                      >
                        {t("close")}
                      </button>
                    </div>
                    <p className="field-hint">{t("proxyNote")}</p>
                    <form
                      key={settings?.proxyUrl ?? ""}
                      onSubmit={(event) => {
                        event.preventDefault();
                        const form = event.currentTarget;
                        const data = proxyFormData(form);
                        const body = {
                          ...data,
                          proxyUrl: data.proxyUrl || null,
                        };
                        form.reset();
                        void run(async () => {
                          await api.request("/settings", "PUT", body);
                          await refresh();
                          setNotice(t("saved"));
                          if (settingsDetailsRef.current)
                            settingsDetailsRef.current.open = false;
                        });
                      }}
                    >
                      <ProxyFields
                        api={api}
                        t={t}
                        defaultSettings
                        initialUrl={settings?.proxyUrl ?? ""}
                        disabled={pending}
                      />
                      <div className="modal-footer">
                        <button
                          type="button"
                          className="danger-outline"
                          disabled={pending}
                          onClick={() =>
                            void run(async () => {
                              await api.request("/settings", "PUT", {
                                proxyUrl: null,
                              });
                              await refresh();
                              if (settingsDetailsRef.current)
                                settingsDetailsRef.current.open = false;
                            })
                          }
                        >
                          {t("clearProxy")}
                        </button>
                        <button className="primary" disabled={pending}>
                          {t("save")}
                        </button>
                      </div>
                    </form>
                  </div>
                </div>
              </details>

              {/* 创建实例弹窗卡片 */}
              <details className="modal-details" ref={createDetailsRef}>
                <summary className="btn-summary primary-summary">
                  {t("create")}
                </summary>
                <div className="modal-scrim">
                  <div className="modal-panel">
                    <div className="modal-head">
                      <h3>{t("create")}</h3>
                      <button
                        type="button"
                        className="sm"
                        onClick={() => {
                          if (createDetailsRef.current)
                            createDetailsRef.current.open = false;
                        }}
                      >
                        {t("close")}
                      </button>
                    </div>
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        const form = event.currentTarget;
                        const body = proxyFormData(form);
                        void run(async () => {
                          const result = await api.request<{
                            instance: Instance;
                          }>("/instances", "POST", body);
                          form.reset();
                          if (createDetailsRef.current)
                            createDetailsRef.current.open = false;
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
                      <ProxyFields
                        api={api}
                        t={t}
                        defaultProxyUrl={settings?.proxyUrl}
                        disabled={pending || !!loginId || loginChecking}
                      />
                      <div className="modal-footer">
                        <button
                          className="primary"
                          disabled={pending || !!loginId || loginChecking}
                        >
                          {t("create")}
                        </button>
                      </div>
                    </form>
                  </div>
                </div>
              </details>
            </div>
          </div>

          {instances.length > 0 && (
            <div className="list-toolbar">
              <div className="filter-pills" role="group">
                {(
                  [
                    ["all", t("allInstances"), instances.length],
                    [
                      "running",
                      t("running"),
                      instances.filter((i) => i.state === "running").length,
                    ],
                    [
                      "stopped",
                      t("stopped"),
                      instances.filter((i) => i.state === "stopped").length,
                    ],
                    [
                      "error",
                      t("error"),
                      instances.filter((i) => i.state === "error").length,
                    ],
                  ] as const
                ).map(([key, label, count]) => (
                  <button
                    type="button"
                    key={key}
                    aria-pressed={listFilter === key}
                    onClick={() => setListFilter(key)}
                  >
                    {label} ({count})
                  </button>
                ))}
              </div>
              <div className="toolbar-right">
                <input
                  className="search-input"
                  type="search"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder={t("searchPlaceholder")}
                  aria-label={t("searchPlaceholder")}
                />
              </div>
            </div>
          )}

          <section className="instance-table-card">
            <div className="instance-list-head">
              <div>
                {t("name")} / {t("engine")} / {t("proxy")}
              </div>
              <div>{t("instances")}</div>
              <div>{t("cindy")}</div>
              <div>{t("provider")}</div>
              <div className="align-right">{t("manageDetail")}</div>
            </div>
            {instances.length === 0 ? (
              <div className="empty-list-box">
                <p>{t("empty")}</p>
              </div>
            ) : (
              <nav aria-label={t("instances")} className="instance-rows-nav">
                {filteredInstances.map((item) => {
                  const cindyState = item.authentication?.cindy;
                  const provState = item.authentication?.provider;
                  const engineLabel =
                    item.engine === "codex" ? "Codex" : "Claude Code";
                  const proxyLabel =
                    item.proxyMode === "none"
                      ? t("none")
                      : item.proxyMode === "default"
                        ? t("default")
                        : t("customProxy");
                  return (
                    <button
                      className="instance-row-card"
                      key={item.id}
                      disabled={pending || !!loginId}
                      onClick={() => choose(item.id)}
                    >
                      <div className="row-col-main">
                        <div className="row-name-line">
                          <strong className="row-name">{item.name}</strong>
                          <span className="badge subtle">{engineLabel}</span>
                        </div>
                        <span className="row-subline">{proxyLabel}</span>
                        {item.error && (
                          <span className="row-error-hint">⚠ {item.error}</span>
                        )}
                      </div>

                      <div>
                        <span className="badge">
                          <span className={`dot ${stateDot(item.state)}`} />
                          {t(item.state)}
                        </span>
                      </div>

                      <div className="row-account-cell">
                        <span className="row-account-status">
                          <span
                            className={`dot ${cindyState === "stored" ? "ok" : cindyState === "missing" ? "warn" : ""}`}
                          />
                          {t(
                            cindyState === "missing"
                              ? "authMissing"
                              : (cindyState ?? "unknown"),
                          )}
                        </span>
                        {item.accounts?.cindy?.displayName && (
                          <span className="row-account-detail">
                            {item.accounts.cindy.displayName}
                          </span>
                        )}
                      </div>

                      <div className="row-account-cell">
                        <span className="row-account-status">
                          <span
                            className={`dot ${provState === "authenticated" ? "ok" : provState === "missing" ? "warn" : ""}`}
                          />
                          {t(
                            provState === "missing"
                              ? "authMissing"
                              : (provState ?? "unknown"),
                          )}
                        </span>
                        {item.accounts?.provider?.displayName && (
                          <span className="row-account-detail">
                            {item.accounts.provider.displayName}
                          </span>
                        )}
                      </div>

                      <div className="row-actions-cell">
                        <span className="row-enter-pill">
                          {t("manageDetail")} →
                        </span>
                      </div>
                    </button>
                  );
                })}
              </nav>
            )}
          </section>
        </main>
      ) : (
        /* ==================== 二级页面：单实例详情页 ==================== */
        <main className="page-container detail-page">
          <div className="detail-breadcrumb-bar">
            <div className="breadcrumb-left">
              <button
                type="button"
                className="sm"
                disabled={pending || !!loginId}
                onClick={backToList}
              >
                ← {t("backToList")}
              </button>
              <span className="breadcrumb-sep">/</span>
              <span className="breadcrumb-current">{instance.name}</span>
            </div>

            <div className="breadcrumb-right">
              <nav
                className="instance-quick-nav"
                aria-label={t("instances")}
              >
                {instances.map((item) => (
                  <button
                    className="instance-pill"
                    key={item.id}
                    aria-current={item.id === selected ? "true" : undefined}
                    disabled={pending || !!loginId}
                    onClick={() => choose(item.id)}
                  >
                    <span className={`dot ${stateDot(item.state)}`} />
                    <strong>{item.name}</strong>
                    <span className="instance-pill-meta">
                      {item.engine === "codex" ? "Codex" : "Claude Code"} ·{" "}
                      {t(item.state)}
                    </span>
                  </button>
                ))}
              </nav>
              <button
                className="sm"
                disabled={pending || !!loginId || loginChecking}
                onClick={() => void run(refreshSelected)}
              >
                {t("refresh")}
              </button>
            </div>
          </div>

          <article className="detail-pane">
            {/* 1. 顶部实例概览头卡 */}
            <section className="hero-card">
              <div className="hero-top">
                <div>
                  <div className="hero-title-row">
                    <h2>{instance.name}</h2>
                    <span className="badge subtle">
                      {instance.engine === "codex" ? "Codex" : "Claude Code"}
                    </span>
                    <span className="badge">
                      <span className={`dot ${stateDot(instance.state)}`} />
                      {t(instance.state)}
                    </span>
                  </div>
                  <p className="hero-sub">
                    {instance.engine === "codex" ? "Codex" : "Claude Code"} ·{" "}
                    {t(instance.state)} · {t("stateNote")}
                  </p>
                </div>

                <div className="hero-actions">
                  {(["start", "stop", "restart", "check"] as const).map(
                    (value) => (
                      <button
                        key={value}
                        className={
                          value === "start" && instance.state !== "running"
                            ? "primary"
                            : undefined
                        }
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

                  {/* 实例名称与 Proxy 设置弹窗 */}
                  <details
                    className="modal-details"
                    ref={instanceSettingsDetailsRef}
                  >
                    <summary className="btn-summary">
                      ⚙ {t("settings")}
                    </summary>
                    <div className="modal-scrim">
                      <div className="modal-panel">
                        <div className="modal-head">
                          <h3>{t("instanceSettings")}</h3>
                          <button
                            type="button"
                            className="sm"
                            onClick={() => {
                              if (instanceSettingsDetailsRef.current)
                                instanceSettingsDetailsRef.current.open = false;
                            }}
                          >
                            {t("close")}
                          </button>
                        </div>
                        <form
                          key={
                            instance.id +
                            instance.name +
                            instance.proxyMode +
                            instance.proxyUrl +
                            instance.proxyAuthConfigured
                          }
                          onSubmit={(event) => {
                            event.preventDefault();
                            const form = event.currentTarget;
                            const body = proxyFormData(form);
                            void run(async () => {
                              await api.request(
                                `/instances/${selected}`,
                                "PATCH",
                                body,
                              );
                              form.reset();
                              if (instanceSettingsDetailsRef.current)
                                instanceSettingsDetailsRef.current.open = false;
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
                          <ProxyFields
                            api={api}
                            t={t}
                            instance={instance}
                            defaultProxyUrl={settings?.proxyUrl}
                            disabled={
                              instance.state === "running" ||
                              pending ||
                              !!loginId ||
                              loginChecking
                            }
                          />
                          <div className="modal-footer">
                            <button
                              className="primary"
                              disabled={pending || !!loginId || loginChecking}
                            >
                              {t("save")}
                            </button>
                          </div>
                        </form>
                      </div>
                    </div>
                  </details>
                </div>
              </div>

              <div className="hero-footer">
                <p className="auth-summary-line">
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
                {loginChecking && (
                  <p className="badge" role="status">
                    <span className="dot busy" />
                    {t("checkingLogin")}
                  </p>
                )}
              </div>
            </section>

            {instance.error && (
              <p className="error error-card" role="alert">
                <span className="dot err" />
                <span>{instance.error}</span>
              </p>
            )}

            {/* 2. 账号与登录双卡区 */}
            <section className="section-block">
              <div className="section-header">
                <div>
                  <h3>{t("accounts")}</h3>
                  <p className="section-sub">{t("loginNote")}</p>
                </div>
              </div>

              <div className="accounts-grid account-identities">
                {/* 左卡：Cindy 账号 */}
                <div
                  className="account-card"
                  data-selected={loginTarget === "cindy"}
                  onClick={() => setLoginTarget("cindy")}
                >
                  <div className="account-card-head">
                    <span className="account-card-title">{t("cindy")}</span>
                    <span className="badge">
                      <span
                        className={`dot ${
                          instance.authentication?.cindy === "stored"
                            ? "ok"
                            : instance.authentication?.cindy === "missing"
                              ? "warn"
                              : ""
                        }`}
                      />
                      {t(
                        instance.authentication?.cindy === "missing"
                          ? "authMissing"
                          : (instance.authentication?.cindy ?? "unknown"),
                      )}
                    </span>
                  </div>
                  <AccountDetails
                    title={t("cindy")}
                    account={instance.accounts?.cindy}
                    saved={instance.authentication?.cindy === "stored"}
                    t={t}
                  />
                  {instance.authentication?.cindy !== "stored" && (
                    <div className="account-empty-box">
                      {t(
                        instance.authentication?.cindy === "missing"
                          ? "authMissing"
                          : "unknown",
                      )}
                    </div>
                  )}
                </div>

                {/* 右卡：Provider 供应商账号 */}
                <div
                  className="account-card"
                  data-selected={loginTarget === "provider"}
                  onClick={() => setLoginTarget("provider")}
                >
                  <div className="account-card-head">
                    <span className="account-card-title">
                      {instance.engine === "codex" ? "Codex" : "Claude Code"}
                    </span>
                    <span className="badge">
                      <span
                        className={`dot ${
                          instance.authentication?.provider === "authenticated"
                            ? "ok"
                            : instance.authentication?.provider === "missing"
                              ? "warn"
                              : ""
                        }`}
                      />
                      {t(
                        instance.authentication?.provider === "missing"
                          ? "authMissing"
                          : (instance.authentication?.provider ?? "unknown"),
                      )}
                    </span>
                  </div>
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
                  {instance.authentication?.provider !== "authenticated" && (
                    <div className="account-empty-box">
                      {t(
                        instance.authentication?.provider === "missing"
                          ? "authMissing"
                          : "unknown",
                      )}
                    </div>
                  )}
                </div>
              </div>

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
                  className="login-form login-bar-card"
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
                      onChange={(event) => setLoginTarget(event.target.value)}
                    >
                      <option value="cindy">{t("cindy")}</option>
                      <option value="provider">
                        {instance.engine === "codex" ? "Codex" : "Claude Code"}
                      </option>
                    </select>
                  </label>
                  {loginTarget === "cindy" && (
                    <label>
                      {t("login")}
                      <select
                        name="method"
                        value={loginMethod}
                        onChange={(event) => setLoginMethod(event.target.value)}
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
                    className="primary"
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

            {/* 3. 供应商分享与用量区 */}
            <section className="section-block">
              <div className="section-header">
                <h3>{t("sharing")}</h3>
                {instance.state === "running" && (
                  <div className="toolbar">
                    <button
                      disabled={pending}
                      onClick={() => void run(() => share("list"))}
                    >
                      {t("refresh")}
                    </button>
                    <button
                      className="primary"
                      disabled={pending}
                      onClick={() => void run(() => share("link"))}
                    >
                      {t("invitation")}
                    </button>
                  </div>
                )}
              </div>

              {instance.state !== "running" ? (
                <div className="empty-state-banner">
                  <p>{t("shareNote")}</p>
                </div>
              ) : (
                <div className="card-panel">
                  {invitation && (
                    <div className="invitation invitation-box">
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
                      <div className="toolbar">
                        <button
                          className="primary"
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
                            className="btn sm"
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
                    </div>
                  )}

                  {shares && (
                    <>
                      <div className="share-group">
                        <h4>{t("requests")}</h4>
                        {shares.every((value) => !value.requests.length) && (
                          <p className="account-empty-box">{t("noRequests")}</p>
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
                              <div className="person-meta">
                                <strong>{request.displayName}</strong>
                                <span>
                                  {t("expires")}:{" "}
                                  {new Date(request.expiresAt).toLocaleString(
                                    locale,
                                  )}
                                </span>
                              </div>
                              <div className="pairing-actions">
                                <label className="inline-code-label">
                                  <span>{t("code")}</span>
                                  <input
                                    className="code-input"
                                    name="code"
                                    required
                                    autoComplete="off"
                                    inputMode="numeric"
                                    pattern="[0-9]{4}"
                                    maxLength={4}
                                  />
                                </label>
                                <button className="primary" disabled={pending}>
                                  {t("approve")}
                                </button>
                                <button
                                  type="button"
                                  className="danger-outline"
                                  disabled={pending}
                                  onClick={() =>
                                    void run(() =>
                                      share("reject", request.requestId),
                                    )
                                  }
                                >
                                  {t("reject")}
                                </button>
                              </div>
                            </form>
                          )),
                        )}
                      </div>

                      <div className="share-group">
                        <h4>{t("members")}</h4>
                        {shares.every((value) => !value.members.length) && (
                          <p className="account-empty-box">{t("noMembers")}</p>
                        )}
                        {shares.flatMap((value) =>
                          value.members.map((member) => (
                            <div className="share-row" key={member.memberId}>
                              <div className="person-meta">
                                <strong>{member.displayName}</strong>
                                <span className="badge">
                                  <span
                                    className={`dot ${member.status === "active" ? "ok" : ""}`}
                                  />
                                  {t(member.status)}
                                </span>
                              </div>
                              <div className="pairing-actions">
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
                                  className="danger-outline"
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
                            </div>
                          )),
                        )}
                      </div>

                      <div className="share-group">
                        <h4>{t("usage")}</h4>
                        <Usage value={usage} shares={shares} t={t} />
                      </div>
                    </>
                  )}
                </div>
              )}
            </section>
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
  if (!rows.length) return <p className="account-empty-box">{t("noUsage")}</p>;
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>{t("members")}</th>
            <th>{t("model")}</th>
            <th className="num">{t("turns")}</th>
            <th className="num">{t("inputTokens")}</th>
            <th className="num">{t("outputTokens")}</th>
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
                <td className="num">{model.turns}</td>
                <td className="num">{model.inputTokens}</td>
                <td className="num">{model.outputTokens}</td>
              </tr>
            )),
          )}
        </tbody>
      </table>
    </div>
  );
}
