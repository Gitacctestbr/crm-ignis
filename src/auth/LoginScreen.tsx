import React, { useState } from "react";
import { useAuth } from "./AuthContext";

type Mode = "signin" | "signup";

/**
 * Tela de login estética Apple minimalista.
 * Fundo claro, tipografia clean, sem ornamentação.
 * Usada como gate antes de renderizar qualquer parte do CRM.
 */
export default function LoginScreen() {
  const { signIn, signUp } = useAuth();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "signin") await signIn(email.trim(), password);
      else await signUp(email.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        width: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#fafafa",
        color: "#1d1d1f",
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, sans-serif',
        padding: 24,
      }}
    >
      <div style={{ width: "100%", maxWidth: 360 }}>
        <div style={{ textAlign: "center", marginBottom: 40 }}>
          <div
            style={{
              fontSize: 28,
              fontWeight: 600,
              letterSpacing: "-0.02em",
              marginBottom: 8,
            }}
          >
            Ignis CRM
          </div>
          <div style={{ fontSize: 14, color: "#86868b" }}>
            {mode === "signin" ? "Entre na sua conta" : "Crie sua conta"}
          </div>
        </div>

        <form onSubmit={onSubmit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <input
            type="email"
            required
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            style={inputStyle}
          />
          <input
            type="password"
            required
            minLength={6}
            placeholder="Senha"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === "signin" ? "current-password" : "new-password"}
            style={inputStyle}
          />

          {error && (
            <div
              style={{
                fontSize: 13,
                color: "#d70015",
                background: "#fff5f5",
                padding: "10px 12px",
                borderRadius: 10,
                border: "1px solid #ffd5d5",
              }}
            >
              {error}
            </div>
          )}

          <button type="submit" disabled={busy} style={primaryBtnStyle(busy)}>
            {busy ? "Aguarde…" : mode === "signin" ? "Entrar" : "Criar conta"}
          </button>
        </form>

        <div style={{ textAlign: "center", marginTop: 20, fontSize: 13 }}>
          {mode === "signin" ? (
            <>
              Novo aqui?{" "}
              <button onClick={() => setMode("signup")} style={linkBtnStyle}>
                Criar conta
              </button>
            </>
          ) : (
            <>
              Já tem conta?{" "}
              <button onClick={() => setMode("signin")} style={linkBtnStyle}>
                Entrar
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  height: 44,
  padding: "0 14px",
  borderRadius: 10,
  border: "1px solid #d2d2d7",
  background: "#fff",
  fontSize: 15,
  color: "#1d1d1f",
  outline: "none",
  transition: "border-color 0.15s ease",
  fontFamily: "inherit",
};

function primaryBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    height: 44,
    border: "none",
    borderRadius: 10,
    background: disabled ? "#a1a1a6" : "#0071e3",
    color: "#fff",
    fontSize: 15,
    fontWeight: 500,
    cursor: disabled ? "default" : "pointer",
    fontFamily: "inherit",
    marginTop: 4,
  };
}

const linkBtnStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "#0071e3",
  cursor: "pointer",
  padding: 0,
  fontSize: 13,
  fontFamily: "inherit",
};
