"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Dashboard } from "./dashboard";

type SessionUser = { username: string; role: "viewer" | "operator" | "admin" };

export function AuthenticatedApp({ user }: { user: SessionUser }) {
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [logoutError, setLogoutError] = useState("");

  useEffect(() => {
    let stopped = false;
    const verifySession = async () => {
      if (document.visibilityState === "hidden") return;
      try {
        const response = await fetch("/api/auth/session", { cache: "no-store" });
        if (!stopped && response.status === 401) window.location.replace("/");
      } catch {
        // A transient network failure must not discard a still-valid session.
      }
    };
    const timer = window.setInterval(() => void verifySession(), 60_000);
    const onVisible = () => { if (document.visibilityState === "visible") void verifySession(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, []);

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
  const errorRef = useRef<HTMLParagraphElement>(null);

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
      <div className="login-grid" />
      <div className="login-orbit orbit-one" />
      <div className="login-orbit orbit-two" />
      <div className="login-earth">
        <span className="login-target target-one" />
        <span className="login-target target-two" />
        <span className="login-coverage"><b>候选观测区</b></span>
      </div>
      <div className="login-visual-copy">
        <span>全球灾害监测与卫星任务规划</span>
        <h2>发现灾害，判断卫星何时能拍</h2>
        <p>汇聚多源灾害信息，筛选遥感可观测事件，并生成卫星任务候选。</p>
      </div>
      <ol className="login-workflow">
        <li><b>01</b><span>发现事件</span></li>
        <li><b>02</b><span>判断可观测性</span></li>
        <li><b>03</b><span>生成任务候选</span></li>
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
        {error ? <p id="login-error" ref={errorRef} className="login-error" role="alert" tabIndex={-1}>{error}</p> : null}
        <button type="submit" disabled={disabled}>{busy ? "正在验证…" : "登录并进入系统"}</button>
      </form>
      <p className="login-help">无法登录？请联系系统管理员。</p>
      <small className="login-footnote">为保护任务数据，请勿在公共设备保存账号密码；长时间未操作将自动退出。</small>
    </section>
  </main>;
}
