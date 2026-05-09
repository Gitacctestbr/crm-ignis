import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "../utils/supabaseClient";

type AuthState = {
  session: Session | null;
  user: User | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, workspaceName?: string) => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

/**
 * Garante que existe uma linha em user_workspaces para o usuário logado.
 * Convenção: workspace_id === user_id (UUID convertido para TEXT).
 * Se workspaceName for passado, atualiza o nome humano do workspace
 * (usado pelo bot Telegram pra confirmar vinculação).
 */
async function ensureWorkspaceRow(user: User, workspaceName?: string): Promise<void> {
  try {
    const row: Record<string, unknown> = { user_id: user.id, workspace_id: user.id };
    if (workspaceName && workspaceName.trim()) {
      row.workspace_name = workspaceName.trim();
    }
    await supabase
      .from("user_workspaces")
      .upsert(row, { onConflict: "user_id" });
  } catch (err) {
    console.warn("[CRM IGNIS] Falha ao garantir user_workspaces:", err);
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setSession(data.session);
      setLoading(false);
      if (data.session?.user) ensureWorkspaceRow(data.session.user);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
      if (newSession?.user) ensureWorkspaceRow(newSession.user);
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      session,
      user: session?.user ?? null,
      loading,
      async signIn(email, password) {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      },
      async signUp(email, password, workspaceName) {
        const { data, error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        // Se o signUp já entregou sessão (auto-confirm), grava o nome do workspace.
        // Caso contrário, o nome será gravado no próximo login (via state listener)
        // — mas aí precisa da próxima chamada — então gravamos aqui também via UPSERT
        // direto, pra cobrir o caso de email confirmation pendente.
        if (data.user) {
          await ensureWorkspaceRow(data.user, workspaceName);
        }
      },
      async signOut() {
        await supabase.auth.signOut();
      },
    }),
    [session, loading],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth deve ser usado dentro de <AuthProvider>");
  return ctx;
}
