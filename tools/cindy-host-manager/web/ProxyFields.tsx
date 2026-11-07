import { useEffect, useRef, useState } from "react";
import { ApiError, type Api, type Instance } from "./api";
import { errorText, type Key } from "./i18n";

export function proxyFormData(form: HTMLFormElement): Record<string, unknown> {
  const data: Record<string, unknown> = Object.fromEntries(new FormData(form).entries());
  for (const key of ["proxyUsername", "proxyPassword"]) if (!data[key]) delete data[key];
  if (data.proxyClearAuth !== undefined) data.proxyClearAuth = data.proxyClearAuth === "on";
  return data;
}

export function ProxyFields({ api, t, instance, defaultSettings = false, initialUrl = "", defaultProxyUrl = null, disabled = false }: {
  api: Api; t: (key: Key) => string; instance?: Instance; defaultSettings?: boolean;
  initialUrl?: string; defaultProxyUrl?: string | null; disabled?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const [mode, setMode] = useState(instance?.proxyMode ?? "none");
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const reset = () => { generation.current++; setMode(instance?.proxyMode ?? "none"); setResult(""); setError(""); };
    const form = root.current?.closest("form");
    form?.addEventListener("reset", reset);
    return () => { generation.current++; form?.removeEventListener("reset", reset); };
  }, [instance?.proxyMode]);
  async function test() {
    const form = root.current?.closest("form");
    if (!form) return;
    if (!defaultSettings && mode === "default" && !defaultProxyUrl) {
      setResult(""); setError(t("proxyNotConfigured")); return;
    }
    const data = proxyFormData(form);
    const body: Record<string, unknown> = { proxyMode: defaultSettings ? "default" : mode,
      ...(instance ? { instanceId: instance.id } : {}) };
    for (const key of ["proxyUrl", "proxyUsername", "proxyPassword", "proxyClearAuth"])
      if (key in data) body[key] = data[key];
    const token = ++generation.current;
    setTesting(true); setResult(""); setError("");
    try {
      const value = await api.request<{ ip: string; country: string; region: string; city: string }>("/proxy/test", "POST", body);
      if (token === generation.current) setResult(`${value.ip} · ${[value.country, value.region, value.city].filter(Boolean).join(" / ") || t("locationUnknown")}`);
    } catch (error) {
      if (token === generation.current) setError(errorText(error instanceof ApiError ? error.code : "PROXY_TEST_FAILED", t));
    } finally { setTesting(false); }
  }
  return <div ref={root} onChange={() => { generation.current++; setResult(""); setError(""); }}>
    {!defaultSettings && <label>{t("proxy")}<select name="proxyMode" value={mode} disabled={disabled}
      onChange={event => setMode(event.target.value as Instance["proxyMode"])}>
      <option value="none">{t("none")}</option><option value="default">{t("default")}</option>
      <option value="custom">{t("customProxy")}</option>
    </select></label>}
    {!defaultSettings && mode === "default" && <p>{defaultProxyUrl
      ? `${t("proxyUrl")}: ${defaultProxyUrl}` : t("defaultProxyMissing")}</p>}
    {(defaultSettings || mode === "custom") && <>
      <label>{t(defaultSettings ? "proxyUrl" : "customProxyUrl")}<input name="proxyUrl" type="url"
        defaultValue={instance?.proxyUrl ?? initialUrl} placeholder="http://proxy.example:8080" pattern="http://.*" required={!defaultSettings} disabled={disabled} /></label>
      <label>{t("proxyUsername")}<input name="proxyUsername" autoComplete="off" disabled={disabled} /></label>
      <label>{t("proxyPassword")}<input name="proxyPassword" type="password" autoComplete="new-password" disabled={disabled} /></label>
      <p>{t("proxyKeepAuth")}</p>
      <label className="checkbox-label"><input name="proxyClearAuth" type="checkbox" disabled={disabled} />{t("proxyClearAuth")}</label>
    </>}
    {(defaultSettings || mode !== "none") && <>
      <button type="button" disabled={testing || disabled} onClick={() => void test()}>{t(testing ? "testingProxy" : "testProxy")}</button>
      <p>{t("proxyTestNote")}</p>
      {testing && <p role="status">{t("proxyTestProgress")}</p>}
      {result && <p role="status">{t("proxyExit")}: {result}</p>}
      {error && <p role="alert">{error}</p>}
    </>}
  </div>;
}
