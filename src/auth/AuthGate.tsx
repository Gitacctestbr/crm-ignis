import React from "react";
import { AuthProvider, useAuth } from "./AuthContext";
import LoginScreen from "./LoginScreen";

/**
 * Gate de auth para envolver qualquer entrypoint da extensão.
 * Enquanto não houver sessão ativa, renderiza o LoginScreen.
 * Quando o usuário loga, o componente filho é renderizado.
 */
function GateInner({ children }: { children: React.ReactNode }) {
  const { session, loading } = useAuth();

  if (loading) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#fafafa",
          color: "#86868b",
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, sans-serif',
          fontSize: 14,
        }}
      >
        Carregando…
      </div>
    );
  }

  if (!session) return <LoginScreen />;
  return <>{children}</>;
}

export default function AuthGate({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <GateInner>{children}</GateInner>
    </AuthProvider>
  );
}
