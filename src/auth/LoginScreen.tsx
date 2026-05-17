import React, { useState } from "react";
import { useAuth } from "./AuthContext";

type Mode = "signin" | "signup";

export default function LoginScreen() {
  const { signIn, signUp } = useAuth();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "signin") await signIn(email.trim(), password);
      else await signUp(email.trim(), password, workspaceName.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <style>{loginStyles}</style>
      <div className="ignis-login-page">
        <div className="ignis-login-card">
          <div className="ignis-login-brand">
            <FlameIcon />
            <div className="ignis-login-title">
              <span className="ignis-login-title-accent">IGNIS</span>
              <span className="ignis-login-title-sep">·</span>
              <span className="ignis-login-title-main">CRM</span>
            </div>
            <div className="ignis-login-subtitle">
              {mode === "signin" ? "Entre na sua conta" : "Crie sua conta"}
            </div>
          </div>

          <form onSubmit={onSubmit} className="ignis-login-form">
            {mode === "signup" && (
              <input
                type="text"
                required
                placeholder="Nome do seu CRM (ex: Studio Beauty VT)"
                value={workspaceName}
                onChange={(e) => setWorkspaceName(e.target.value)}
                maxLength={60}
                aria-label="Nome do CRM"
                className="ignis-login-input"
                autoFocus
              />
            )}
            <input
              type="email"
              required
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              aria-label="Email"
              className="ignis-login-input"
              autoFocus={mode === "signin"}
            />
            <input
              type="password"
              required
              minLength={6}
              placeholder="Senha"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === "signin" ? "current-password" : "new-password"}
              aria-label="Senha"
              className="ignis-login-input"
            />

            {error && (
              <div role="alert" className="ignis-login-error">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={busy}
              className="ignis-login-primary"
            >
              {busy ? "Aguarde…" : mode === "signin" ? "Entrar" : "Criar conta"}
            </button>
          </form>

          <div className="ignis-login-switch">
            {mode === "signin" ? (
              <>
                Novo aqui?{" "}
                <button
                  type="button"
                  onClick={() => setMode("signup")}
                  className="ignis-login-link"
                >
                  Criar conta
                </button>
              </>
            ) : (
              <>
                Já tem conta?{" "}
                <button
                  type="button"
                  onClick={() => setMode("signin")}
                  className="ignis-login-link"
                >
                  Entrar
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function FlameIcon() {
  return (
    <svg
      width="44"
      height="44"
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      className="ignis-login-flame"
    >
      <path
        d="M16 3c-1 4-5 5-5 12a5 5 0 0010 0c0-2-1-3-1-5 5 2 7 6 7 11a11 11 0 11-22 0c0-9 8-10 11-18z"
        fill="url(#ignis-flame-grad)"
      />
      <defs>
        <linearGradient
          id="ignis-flame-grad"
          x1="16"
          y1="3"
          x2="16"
          y2="29"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#ffc26a" />
          <stop offset="0.55" stopColor="#ea7c30" />
          <stop offset="1" stopColor="#b3441a" />
        </linearGradient>
      </defs>
    </svg>
  );
}

const loginStyles = `
.ignis-login-page {
  min-height: 100vh;
  width: 100%;
  /* Garante que o popup do Chrome (que ajusta largura ao conteúdo) abra com
     no mínimo 360px. Sem isso, o popup encolhe e o card quebra cada palavra
     em uma linha. */
  min-width: 360px;
  display: flex;
  align-items: center;
  justify-content: center;
  background:
    radial-gradient(1200px 600px at 20% 0%, rgba(234, 124, 48, 0.10), transparent 55%),
    radial-gradient(900px 500px at 85% 100%, rgba(45, 212, 191, 0.05), transparent 55%),
    linear-gradient(180deg, rgb(12, 12, 14), rgb(8, 8, 10));
  color: rgb(240, 240, 248);
  font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  padding: 24px 20px;
  box-sizing: border-box;
  -webkit-font-smoothing: antialiased;
}

.ignis-login-card {
  width: 100%;
  max-width: 360px;
  padding: 32px 28px;
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.08);
  box-shadow:
    0 12px 40px rgba(0, 0, 0, 0.45),
    inset 0 1px 0 rgba(255, 255, 255, 0.04);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}

.ignis-login-brand {
  display: flex;
  flex-direction: column;
  align-items: center;
  margin-bottom: 28px;
}

.ignis-login-flame {
  margin-bottom: 14px;
  filter: drop-shadow(0 0 14px rgba(234, 124, 48, 0.5));
}

.ignis-login-title {
  font-size: 22px;
  font-weight: 800;
  letter-spacing: -0.02em;
}

.ignis-login-title-accent {
  color: #ea7c30;
}

.ignis-login-title-sep {
  color: rgba(240, 240, 248, 0.40);
  margin: 0 8px;
  font-weight: 400;
}

.ignis-login-title-main {
  color: rgba(240, 240, 248, 0.92);
  font-weight: 500;
}

.ignis-login-subtitle {
  font-size: 13px;
  color: rgba(240, 240, 248, 0.55);
  margin-top: 8px;
}

.ignis-login-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.ignis-login-input {
  height: 44px;
  padding: 0 14px;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.10);
  background: rgba(255, 255, 255, 0.04);
  font-size: 14px;
  color: rgb(240, 240, 248);
  outline: none;
  font-family: inherit;
  box-sizing: border-box;
  transition: border-color 0.15s ease, background 0.15s ease, box-shadow 0.15s ease;
}

.ignis-login-input::placeholder {
  color: rgba(240, 240, 248, 0.35);
}

.ignis-login-input:hover:not(:focus) {
  border-color: rgba(255, 255, 255, 0.18);
}

.ignis-login-input:focus {
  border-color: rgba(234, 124, 48, 0.55);
  background: rgba(234, 124, 48, 0.04);
  box-shadow: 0 0 0 3px rgba(234, 124, 48, 0.10);
}

.ignis-login-error {
  font-size: 13px;
  color: #fca5a5;
  background: rgba(239, 68, 68, 0.08);
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid rgba(239, 68, 68, 0.20);
  line-height: 1.4;
}

.ignis-login-primary {
  height: 44px;
  border: none;
  border-radius: 10px;
  background: linear-gradient(180deg, #f08a3e, #d96d28);
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
  margin-top: 8px;
  letter-spacing: 0.01em;
  box-shadow: 0 4px 14px rgba(234, 124, 48, 0.35);
  transition: filter 0.15s ease, box-shadow 0.15s ease, transform 0.08s ease;
}

.ignis-login-primary:hover:not(:disabled) {
  filter: brightness(1.07);
  box-shadow: 0 6px 20px rgba(234, 124, 48, 0.45);
}

.ignis-login-primary:active:not(:disabled) {
  transform: translateY(1px);
  filter: brightness(0.96);
}

.ignis-login-primary:disabled {
  background: rgba(234, 124, 48, 0.22);
  color: rgba(255, 255, 255, 0.55);
  cursor: default;
  box-shadow: none;
}

.ignis-login-switch {
  text-align: center;
  margin-top: 22px;
  font-size: 13px;
  color: rgba(240, 240, 248, 0.55);
}

.ignis-login-link {
  background: transparent;
  border: none;
  color: #ea7c30;
  cursor: pointer;
  padding: 0;
  font-size: 13px;
  font-family: inherit;
  font-weight: 600;
  transition: color 0.15s ease;
}

.ignis-login-link:hover {
  color: #ffa55c;
  text-decoration: underline;
  text-underline-offset: 3px;
}

.ignis-login-link:focus-visible {
  outline: 2px solid rgba(234, 124, 48, 0.55);
  outline-offset: 3px;
  border-radius: 3px;
}
`;
