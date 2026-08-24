"use client";

import { useState, type FormEvent } from "react";
import { Dashboard } from "./dashboard";

type SessionUser = { username: string; role: "viewer" | "operator" | "admin" };

export function AuthenticatedApp({ user }: { user: SessionUser }) {
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [logoutError, setLogoutError] = useState("");

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const result = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(result.error || `登录失败（HTTP ${response.status}）`);
      setPassword("");
      window.location.replace("/");
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : "登录失败");
      setBusy(false);
    }
  };

  const disabled = busy || !configured || serviceUnavailable;
  return <main className="login-shell">
    <section className="login-visual" aria-hidden="true">
      <div className="login-grid" />
      <div className="login-orbit orbit-one" />
      <div className="login-orbit orbit-two" />
      <div className="login-earth"><span>全球灾情</span><strong>实时监测</strong></div>
      <p>多源灾害发现 · 遥感可观测性筛选 · 卫星任务规划</p>
    </section>
    <section className="login-panel" aria-labelledby="login-title">
      <div className="login-brand"><span className="brand-logo-frame" aria-hidden="true" /><div><strong>星联体·天巡</strong><small>DISASTER NOWCAST & MISSION PLANNING</small></div></div>
      <div className="login-heading"><span>SECURE OPERATIONS CONSOLE</span><h1 id="login-title">登录灾情预报系统</h1><p>仅限授权值班与任务规划人员使用。</p></div>
      <form className="login-form" onSubmit={submit}>
        <label><span>用户名</span><input name="username" autoComplete="username" value={username} maxLength={120} onChange={(event) => setUsername(event.target.value)} disabled={disabled} required /></label>
        <label><span>密码</span><input name="password" type="password" autoComplete="current-password" value={password} maxLength={128} onChange={(event) => setPassword(event.target.value)} disabled={disabled} required /></label>
        {!configured ? <p className="login-error" role="alert">登录服务尚未配置，请先在服务器设置账号与密码哈希。</p> : null}
        {serviceUnavailable ? <p className="login-error" role="alert">会话数据库暂不可用，请检查服务状态后重试。</p> : null}
        {error ? <p className="login-error" role="alert">{error}</p> : null}
        <button type="submit" disabled={disabled}>{busy ? "正在安全验证…" : "进入指挥控制台"}</button>
      </form>
      <div className="login-security"><span>◉ 服务端权限校验</span><span>◉ HttpOnly 会话</span><span>◉ 闲置自动失效</span></div>
      <small className="login-footnote">登录行为受频率限制；生产环境必须使用 HTTPS。请勿在公共设备保存密码。</small>
    </section>
  </main>;
}
