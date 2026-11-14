import { useEffect, useRef, useState, type ReactNode } from "react";
import { Api, ApiError, type Instance } from "./api";
import { errorText, type Key } from "./i18n";

interface Node {
  id: string;
  name: string;
  online: boolean;
  lastSeen: string | null;
}
interface Enrollment {
  node: Node;
  enrollmentToken: string;
  expiresAt: string;
}
type Inventory = { instances?: Instance[]; failed?: boolean };

/** The central owns only node metadata. Account/settings pages remain node-bound. */
export function Federation({
  api,
  t,
  onSessionExpired,
  renderManager,
}: {
  api: Api;
  t: (key: Key) => string;
  onSessionExpired: () => void;
  renderManager: (api: Api) => ReactNode;
}) {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [inventories, setInventories] = useState<Record<string, Inventory>>({});
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState("");
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const management = useRef<HTMLElement>(null);
  const managementTitle = useRef<HTMLHeadingElement>(null);
  const epoch = useRef(0);
  const reading = useRef(false);
  const callbacks = useRef({ t, onSessionExpired });
  callbacks.current = { t, onSessionExpired };
  const [binding, setBinding] = useState<{ id: string; api: Api } | null>(null);
  const node = nodes.find((value) => value.id === selected);
  useEffect(() => {
    if (!selected) return;
    management.current?.scrollIntoView?.({ block: "start" });
    managementTitle.current?.focus({ preventScroll: true });
  }, [selected]);
  function choose(id: string) {
    const scoped = new Api(
      `/api/federation/nodes/${encodeURIComponent(id)}/api`,
    );
    scoped.csrf = api.csrf;
    setBinding({ id, api: scoped });
    setSelected(id);
    setEnrollment(null);
  }
  function failure(value: unknown) {
    if (!mounted.current) return;
    if (value instanceof ApiError && value.status === 401) {
      setEnrollment(null);
      callbacks.current.onSessionExpired();
    } else
      setError(
        value instanceof ApiError
          ? errorText(value.code, callbacks.current.t)
          : callbacks.current.t("requestFailed"),
      );
  }
  async function refresh() {
    if (reading.current) return;
    reading.current = true;
    const current = ++epoch.current;
    const valid = () => mounted.current && current === epoch.current;
    try {
      const result = await api.request<{ nodes: Node[] }>("/federation/nodes");
      if (!valid()) return;
      setNodes(result.nodes);
      setInventories((previous) =>
        Object.fromEntries(
          result.nodes
            .filter((node) => node.online && previous[node.id])
            .map((node) => [node.id, previous[node.id]]),
        ),
      );
      setLoaded(true);
      setError("");
      // Publish each result independently: an unavailable node cannot block peers.
      void Promise.allSettled(
        result.nodes
          .filter((value) => value.online)
          .map(async (value) => {
            const scoped = new Api(
              `/api/federation/nodes/${encodeURIComponent(value.id)}/api`,
            );
            try {
              const result = await scoped.request<{ instances: Instance[] }>(
                "/instances",
              );
              if (valid())
                setInventories((previous) => ({
                  ...previous,
                  [value.id]: { instances: result.instances },
                }));
            } catch (error) {
              if (valid()) {
                setInventories((previous) => ({
                  ...previous,
                  [value.id]: { failed: true },
                }));
                if (error instanceof ApiError && error.status === 401)
                  failure(error);
              }
            }
          }),
      );
    } catch (error) {
      if (valid()) failure(error);
    } finally {
      reading.current = false;
    }
  }
  useEffect(() => {
    mounted.current = true;
    void refresh();
    // Fleet connectivity changes without user interaction; retry only reads.
    const timer = window.setInterval(() => void refresh(), 10_000);
    const recover = () => void refresh();
    window.addEventListener("focus", recover);
    window.addEventListener("online", recover);
    return () => {
      mounted.current = false;
      epoch.current++;
      window.clearInterval(timer);
      window.removeEventListener("focus", recover);
      window.removeEventListener("online", recover);
    };
  }, [api]);
  useEffect(() => {
    if (!enrollment) return;
    const timer = window.setTimeout(
      () => setEnrollment(null),
      Math.max(0, Date.parse(enrollment.expiresAt) - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [enrollment]);
  async function mutate(action: () => Promise<void>) {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      await action();
    } catch (error) {
      failure(error);
    } finally {
      if (mounted.current) setPending(false);
    }
  }
  return (
    <div className="federation">
      <section className="page-container fleet-page" aria-label={t("machines")}>
        <div className="list-page-header">
          <div>
            <h2>{t("machines")}</h2>
            <p>{t("centralSubtitle")}</p>
          </div>
          <button disabled={pending} onClick={() => void refresh()}>
            {t("refresh")}
          </button>
        </div>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <form
          className="enrollment-form"
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const name = String(new FormData(form).get("name") ?? "").trim();
            if (!name) return;
            void mutate(async () => {
              const result = await api.request<Enrollment>(
                "/federation/nodes",
                "POST",
                { name },
              );
              if (!mounted.current) return;
              epoch.current++;
              setNodes((previous) => [
                ...previous.filter((value) => value.id !== result.node.id),
                result.node,
              ]);
              setEnrollment(result);
              form.reset();
            });
          }}
        >
          <label>
            {t("machineName")}
            <input name="name" required maxLength={100} disabled={pending} />
          </label>
          <button className="primary" disabled={pending}>
            {t("addMachine")}
          </button>
        </form>
        {enrollment && (
          <section className="enrollment-panel" aria-label={t("enrollment")}>
            <h3>
              {t("enrollment")} · {enrollment.node.name}
            </h3>
            <p>{t("enrollmentNote")}</p>
            <p>
              {t("centralAddress")}: <code>{location.origin}</code>
            </p>
            <p>{t("enrollmentCommand")}</p>
            <pre className="enrollment-command">
              <code>{`read -r -s -p "${t("enrollmentToken")}: " cindyEnrollmentCode
printf '\n'
printf '%s' "$cindyEnrollmentCode" | CINDY_MANAGER_CENTRAL_ORIGIN='${location.origin}' node dist/main.js connect
unset cindyEnrollmentCode`}</code>
            </pre>
            <label>
              {t("enrollmentToken")}
              <input
                readOnly
                value={enrollment.enrollmentToken}
                autoComplete="off"
              />
            </label>
            <p>
              {t("expires")}: {new Date(enrollment.expiresAt).toLocaleString()}
            </p>
            <button onClick={() => setEnrollment(null)}>{t("close")}</button>
          </section>
        )}
        {!loaded && <p>{t("loading")}</p>}
        {loaded && !nodes.length && <p>{t("noMachines")}</p>}
        <div className="fleet-grid">
          {nodes.map((value) => (
            <article className="machine-card" key={value.id}>
              <div className="machine-heading">
                <h3>{value.name}</h3>
                <span className="badge">
                  <span className={`dot ${value.online ? "ok" : ""}`} />
                  {t(value.online ? "machineOnline" : "machineOffline")}
                </span>
              </div>
              {!value.online && (
                <>
                  <p>{t("offlineNote")}</p>
                  <p>
                    {t("lastSeen")}:{" "}
                    {value.lastSeen
                      ? new Date(value.lastSeen).toLocaleString()
                      : t("neverConnected")}
                  </p>
                </>
              )}
              {value.online &&
                (inventories[value.id]?.failed ? (
                  <p role="status">{t("inventoryUnavailable")}</p>
                ) : !inventories[value.id]?.instances ? (
                  <p>{t("loading")}</p>
                ) : (
                  <>
                    <p>
                      {t("instances")}:{" "}
                      {inventories[value.id].instances!.length}
                    </p>
                    <ul className="fleet-instances">
                      {inventories[value.id].instances!.map((instance) => (
                        <li key={instance.id}>
                          <span>{instance.name}</span>
                          <span className="badge">{t(instance.state)}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                ))}
              <div className="toolbar">
                <button
                  disabled={!value.online}
                  aria-pressed={selected === value.id}
                  onClick={() => choose(value.id)}
                >
                  {t("manageMachine")}
                </button>
                <button
                  className="danger-outline"
                  disabled={pending}
                  onClick={() => {
                    if (!confirm(`${t("revokeConfirm")}\n${value.name}`))
                      return;
                    void mutate(async () => {
                      await api.request(
                        `/federation/nodes/${encodeURIComponent(value.id)}`,
                        "DELETE",
                      );
                      if (!mounted.current) return;
                      epoch.current++;
                      setNodes((previous) =>
                        previous.filter((node) => node.id !== value.id),
                      );
                      setInventories((previous) => {
                        const next = { ...previous };
                        delete next[value.id];
                        return next;
                      });
                      setEnrollment(null);
                      if (selected === value.id) {
                        setSelected("");
                        setBinding(null);
                      }
                    });
                  }}
                >
                  {t("revokeMachine")}
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>
      {node && (
        <section
          ref={management}
          className="machine-management"
          aria-label={`${t("manageMachine")} · ${node.name}`}
        >
          <div className="page-container machine-heading">
            <h2 ref={managementTitle} tabIndex={-1}>{node.name}</h2>
            <button
              onClick={() => {
                setSelected("");
                setBinding(null);
              }}
            >
              {t("close")}
            </button>
          </div>
          {!node.online ? (
            <p className="page-container" role="status">
              {t("offlineNote")}
            </p>
          ) : (
            binding?.id === node.id && (
              <div key={node.id}>{renderManager(binding.api)}</div>
            )
          )}
        </section>
      )}
    </div>
  );
}
