import { useRef, useState } from "react";
import { ApiError, type Api, type Network } from "./api";
import { errorText, type Key } from "./i18n";
import { proxyFormData } from "./ProxyFields";

const DEFAULT_DIRECT = "cindy.app, cindy.com.cn";

type Test = { pending: boolean; result?: string; error?: string };

function stateKey(state: Network["state"]): Key {
  return state === "running" ? "networkRunning" : state === "stopped" ? "networkStopped"
    : state === "missing" ? "networkMissing" : state === "busy" ? "busy" : "error";
}

/** Forced-egress networks shared by instances: list, create, edit, test exit, delete. */
export function NetworksPanel({ api, t, networks, enabled, disabled, run, onChanged }: {
  api: Api;
  t: (key: Key) => string;
  networks: Network[];
  /** False when this computer has no gateway image configured. */
  enabled: boolean;
  disabled: boolean;
  run: (action: () => Promise<void>) => Promise<void>;
  onChanged: () => Promise<void>;
}) {
  const details = useRef<HTMLDetailsElement>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, Test>>({});
  const generation = useRef(0);

  async function test(network: Network) {
    const token = ++generation.current;
    setTests(current => ({ ...current, [network.id]: { pending: true } }));
    try {
      const value = await api.request<{ ip: string; country: string; region: string; city: string }>(
        `/networks/${encodeURIComponent(network.id)}/test`, "POST", {});
      if (token !== generation.current) return;
      const place = [value.country, value.region, value.city].filter(Boolean).join(" / ") || t("locationUnknown");
      setTests(current => ({ ...current, [network.id]: { pending: false, result: `${value.ip} · ${place}` } }));
    } catch (failure) {
      if (token !== generation.current) return;
      setTests(current => ({ ...current, [network.id]: { pending: false,
        error: errorText(failure instanceof ApiError ? failure.code : "PROXY_TEST_FAILED", t) } }));
    }
  }

  function save(form: HTMLFormElement, network?: Network) {
    const body = proxyFormData(form);
    void run(async () => {
      if (network) await api.request(`/networks/${encodeURIComponent(network.id)}`, "PATCH", body);
      else await api.request("/networks", "POST", body);
      setEditing(null);
      await onChanged();
    });
  }

  return (
    <details className="modal-details" ref={details} onToggle={() => { generation.current++; setTests({}); setEditing(null); }}>
      <summary className="btn-summary">🌐 {t("networks")} ({networks.length})</summary>
      <div className="modal-scrim">
        <div className="modal-panel modal-panel-wide">
          <div className="modal-head">
            <h3>{t("networks")}</h3>
            <button type="button" className="sm" onClick={() => { if (details.current) details.current.open = false; }}>
              {t("close")}
            </button>
          </div>
          <p className="field-hint">{t("networksNote")}</p>
          {!enabled && <p className="account-empty-box" role="alert">{t("networksDisabled")}</p>}

          <div className="network-list">
            {networks.map(network => {
              const result = tests[network.id];
              return (
                <section className="network-card" key={network.id} aria-label={network.name}>
                  <div className="account-card-head">
                    <span className="account-card-title">{network.name}</span>
                    <span className="badge">
                      <span className={`dot ${network.state === "running" ? "ok" : network.state === "busy" ? "busy" : "err"}`} />
                      {t(stateKey(network.state))}
                    </span>
                  </div>
                  <dl className="probe-meta network-meta">
                    <dt>{t("networkProxyUrl")}</dt>
                    <dd>{network.proxyUrl}{network.proxyAuthConfigured ? " · 🔑" : ""}</dd>
                    <dt>{t("directDomains")}</dt>
                    <dd>{network.directDomains.join(", ") || "—"}</dd>
                    <dt>{t("networkSubnet")}</dt>
                    <dd>{network.subnet} / {network.gateway}</dd>
                    <dt>{t("networkInstances")}</dt>
                    <dd>{network.instances.map(item => item.name).join(", ") || t("networkNoInstances")}</dd>
                  </dl>
                  <div className="toolbar network-actions">
                    <button type="button" disabled={disabled || !enabled || result?.pending} onClick={() => void test(network)}>
                      {t(result?.pending ? "testingProxy" : "networkTest")}
                    </button>
                    <button type="button" disabled={disabled} onClick={() => setEditing(editing === network.id ? null : network.id)}>
                      {t("editNetwork")}
                    </button>
                    <button type="button" className="danger-outline" disabled={disabled || network.instances.length > 0}
                      title={network.instances.length ? t("networkInUse") : undefined}
                      onClick={() => {
                        if (!confirm(t("deleteNetworkConfirm"))) return;
                        void run(async () => {
                          await api.request(`/networks/${encodeURIComponent(network.id)}`, "DELETE");
                          await onChanged();
                        });
                      }}>
                      {t("deleteNetwork")}
                    </button>
                  </div>
                  {result?.pending && <p role="status">{t("proxyTestProgress")}</p>}
                  {result?.result && <p role="status">{t("proxyExit")}: {result.result}</p>}
                  {result?.error && <p role="alert">{result.error}</p>}
                  {editing === network.id && (
                    <NetworkForm t={t} network={network} disabled={disabled}
                      onSubmit={form => save(form, network)} onCancel={() => setEditing(null)} />
                  )}
                </section>
              );
            })}
          </div>

          {editing === "new" ? (
            <section className="network-card">
              <h4>{t("createNetwork")}</h4>
              <NetworkForm t={t} disabled={disabled} onSubmit={form => save(form)} onCancel={() => setEditing(null)} />
            </section>
          ) : (
            <div className="modal-footer">
              <button type="button" className="primary" disabled={disabled || !enabled} onClick={() => setEditing("new")}>
                {t("createNetwork")}
              </button>
            </div>
          )}
          <p className="field-hint">{t("networkTestNote")}</p>
        </div>
      </div>
    </details>
  );
}

function NetworkForm({ t, network, disabled, onSubmit, onCancel }: {
  t: (key: Key) => string;
  network?: Network;
  disabled: boolean;
  onSubmit: (form: HTMLFormElement) => void;
  onCancel: () => void;
}) {
  return (
    <form className="network-form" onSubmit={event => { event.preventDefault(); onSubmit(event.currentTarget); }}>
      <label>{t("name")}<input name="name" required maxLength={100} defaultValue={network?.name} disabled={disabled} /></label>
      <label>{t("networkProxyUrl")}
        <input name="proxyUrl" type="url" required pattern="http://.*" placeholder="http://172.17.0.1:7890"
          defaultValue={network?.proxyUrl} disabled={disabled} />
      </label>
      <label>{t("proxyUsername")}<input name="proxyUsername" autoComplete="off" disabled={disabled} /></label>
      <label>{t("proxyPassword")}<input name="proxyPassword" type="password" autoComplete="new-password" disabled={disabled} /></label>
      {network && <>
        <p className="field-hint">{t("proxyKeepAuth")}</p>
        <label className="checkbox-label"><input name="proxyClearAuth" type="checkbox" disabled={disabled} />{t("proxyClearAuth")}</label>
      </>}
      <label>{t("directDomains")}
        <input name="directDomains" defaultValue={network?.directDomains.join(", ") ?? DEFAULT_DIRECT} disabled={disabled} />
      </label>
      <p className="field-hint">{t("directDomainsHint")}</p>
      <div className="modal-footer">
        <button type="button" disabled={disabled} onClick={onCancel}>{t("cancel")}</button>
        <button className="primary" disabled={disabled}>{t("save")}</button>
      </div>
    </form>
  );
}
