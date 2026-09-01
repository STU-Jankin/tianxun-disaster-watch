"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Dashboard } from "./dashboard";

type SessionUser = { username: string; role: "viewer" | "operator" | "admin" };

export function AuthenticatedApp({ user }: { user: SessionUser }) {
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const [sessionExpiresAt, setSessionExpiresAt] = useState<number | null>(null);
  const [sessionWarningDismissed, setSessionWarningDismissed] = useState(false);
  const [clock, setClock] = useState(() => Date.now());

  useEffect(() => {
    let stopped = false;
    const verifySession = async () => {
      if (document.visibilityState === "hidden") return;
      try {
        const response = await fetch("/api/auth/session", { cache: "no-store" });
        if (!stopped && response.status === 401) {
          window.sessionStorage.setItem("tianxun:session-notice", "登录已到期。你的本机候选任务和推演草稿仍已保留，请重新登录后继续。 ");
          window.location.replace("/");
          return;
        }
        if (!stopped && response.ok) {
          const result = await response.json() as { expiresAt?: string | number };
          const expiresAt = typeof result.expiresAt === "number" ? result.expiresAt : Date.parse(String(result.expiresAt ?? ""));
          if (Number.isFinite(expiresAt)) setSessionExpiresAt(expiresAt);
        }
      } catch {
        // A transient network failure must not discard a still-valid session.
      }
    };
    void verifySession();
    const timer = window.setInterval(() => void verifySession(), 60_000);
    const clockTimer = window.setInterval(() => setClock(Date.now()), 30_000);
    const onVisible = () => { if (document.visibilityState === "visible") void verifySession(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.clearInterval(clockTimer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, []);

  const remainingSessionMs = sessionExpiresAt === null ? Number.POSITIVE_INFINITY : sessionExpiresAt - clock;
  const showSessionWarning = !sessionWarningDismissed && remainingSessionMs > 0 && remainingSessionMs <= 5 * 60_000;

  const logout = async () => {
    setLogoutBusy(true);
    setLogoutError("");
    try {
      const response = await fetch("/api/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      if (!response.ok) {
        const result = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(result.error || "退出失败");
      }
      window.location.replace("/");
    } catch (error) {
      setLogoutError(error instanceof Error ? error.message : "退出失败");
      setLogoutBusy(false);
    }
  };

  return <>
    <Dashboard currentUser={user} onLogout={() => void logout()} logoutBusy={logoutBusy} />
    {showSessionWarning ? <div className="auth-toast session-warning" role="alert"><span>登录将在 {Math.max(1, Math.ceil(remainingSessionMs / 60_000))} 分钟内到期。本机候选任务和推演草稿会保留；请及时完成当前操作并重新登录。</span><button onClick={() => setSessionWarningDismissed(true)}>知道了</button></div> : null}
    {logoutError ? <div className="auth-toast" role="alert">{logoutError}<button onClick={() => setLogoutError("")}>关闭</button></div> : null}
  </>;
}

export function LoginScreen({ configured, serviceUnavailable = false }: { configured: boolean; serviceUnavailable?: boolean }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [credentialError, setCredentialError] = useState(false);
  const [sessionNotice, setSessionNotice] = useState("");
  const errorRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    const notice = window.sessionStorage.getItem("tianxun:session-notice") ?? "";
    const timer = window.setTimeout(() => {
      if (notice) setSessionNotice(notice.trim());
      window.sessionStorage.removeItem("tianxun:session-notice");
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  const clearCredentialError = () => {
    if (!credentialError) return;
    setCredentialError(false);
    setError("");
  };

  const updateCapsLock = (event: KeyboardEvent<HTMLInputElement>) => {
    setCapsLock(event.getModifierState("CapsLock"));
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    setCredentialError(false);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const result = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) {
        if (response.status === 401) {
          setCredentialError(true);
          throw new Error("用户名或密码不正确，请重新输入。");
        }
        if (response.status === 429) {
          const retryAfter = Number(response.headers.get("Retry-After") || 0);
          const retryText = retryAfter > 0
            ? `请在 ${retryAfter >= 60 ? `${Math.ceil(retryAfter / 60)} 分钟` : `${retryAfter} 秒`}后重试`
            : "请稍后重试";
          throw new Error(`尝试次数过多，${retryText}。`);
        }
        if (response.status === 426) {
          throw new Error("当前连接未使用 HTTPS。为保护账号安全，请改用 HTTPS 地址登录。");
        }
        if (response.status >= 500) {
          throw new Error("登录服务暂时不可用，请稍后重试或联系系统管理员。");
        }
        throw new Error(result.error || `登录失败（HTTP ${response.status}）`);
      }
      setPassword("");
      window.location.replace("/");
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : "登录失败");
      setBusy(false);
    }
  };

  const unavailable = !configured || serviceUnavailable;
  const disabled = busy || unavailable || !username.trim() || !password;
  const describedBy = [capsLock ? "login-caps-lock" : "", error ? "login-error" : ""].filter(Boolean).join(" ") || undefined;
  return <main className="login-shell">
    <section className="login-visual" aria-hidden="true">
      <div className="login-mission-scene" />
      <div className="login-visual-copy">
        <span className="login-visual-kicker"><i /> 全球灾情 × 在轨资源</span>
        <h2>从灾害发现，到卫星成像窗口</h2>
        <p>汇聚权威灾情、影响范围与轨道机会，形成可复核的观测任务候选。</p>
      </div>
      <ol className="login-workflow">
        <li><b>01</b><span>多源灾情发现</span></li>
        <li><b>02</b><span>遥感可观测研判</span></li>
        <li><b>03</b><span>卫星任务规划</span></li>
      </ol>
    </section>
    <section className="login-panel" aria-labelledby="login-title">
      <div className="login-brand"><span className="brand-logo-frame login-brand-logo" aria-hidden="true" /><div><strong>天巡</strong><small>灾情实时预报系统</small></div></div>
      <div className="login-heading"><span>全球灾害监测与卫星任务规划</span><h1 id="login-title">登录天巡系统</h1><p>请使用管理员分配的账号登录。</p></div>
      <form className="login-form" onSubmit={submit} aria-busy={busy}>
        <label htmlFor="login-username"><span>用户名</span></label>
        <input
          id="login-username"
          name="username"
          autoComplete="username"
          value={username}
          maxLength={120}
          aria-invalid={credentialError || undefined}
          aria-describedby={error ? "login-error" : undefined}
          onChange={(event) => { setUsername(event.target.value); clearCredentialError(); }}
          disabled={busy || unavailable}
          required
        />
        <label htmlFor="login-password"><span>密码</span></label>
        <div className="login-password-field">
          <input
            id="login-password"
            name="password"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            value={password}
            maxLength={128}
            aria-invalid={credentialError || undefined}
            aria-describedby={describedBy}
            onChange={(event) => { setPassword(event.target.value); clearCredentialError(); }}
            onKeyDown={updateCapsLock}
            onKeyUp={updateCapsLock}
            onBlur={() => setCapsLock(false)}
            disabled={busy || unavailable}
            required
          />
          <button type="button" aria-pressed={showPassword} aria-label={showPassword ? "隐藏密码" : "显示密码"} onClick={() => setShowPassword((visible) => !visible)} disabled={!password || busy}> {showPassword ? "隐藏" : "显示"} </button>
        </div>
        {capsLock ? <p id="login-caps-lock" className="login-caps-lock" role="status">大写锁定已开启，请确认密码大小写。</p> : null}
        {!configured ? <p className="login-error" role="alert">登录服务尚未启用，请联系系统管理员。</p> : null}
        {serviceUnavailable ? <p className="login-error" role="alert">登录服务暂时不可用，请稍后重试或联系系统管理员。</p> : null}
        {sessionNotice ? <p className="login-session-notice" role="status">{sessionNotice}</p> : null}
        {error ? <p id="login-error" ref={errorRef} className="login-error" role="alert" tabIndex={-1}>{error}</p> : null}
        <button type="submit" disabled={disabled}>{busy ? "正在验证…" : "登录并进入系统"}</button>
      </form>
      <p className="login-help">无法登录？请联系系统管理员。</p>
      <small className="login-footnote">为保护任务数据，请勿在公共设备保存账号密码；长时间未操作将自动退出。</small>
    </section>
  </main>;
}
