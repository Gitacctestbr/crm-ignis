import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Cliente Supabase compartilhado por toda a extensão.
 *
 * Persistência de sessão: usamos chrome.storage.local como storage adapter
 * para que o token seja compartilhado entre service worker, popup, sidepanel,
 * dashboard e content scripts. localStorage não funciona em service worker.
 */

const SUPABASE_URL = (import.meta.env.WXT_SUPABASE_URL as string | undefined) ?? "";
const SUPABASE_ANON_KEY = (import.meta.env.WXT_SUPABASE_ANON_KEY as string | undefined) ?? "";

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.warn(
    "[CRM IGNIS] WXT_SUPABASE_URL e/ou WXT_SUPABASE_ANON_KEY ausentes no .env — " +
      "o cliente Supabase será criado, mas todas as queries falharão até as chaves serem configuradas.",
  );
}

const chromeStorageAdapter = {
  async getItem(key: string): Promise<string | null> {
    try {
      if (typeof chrome === "undefined" || !chrome?.storage?.local) return null;
      const result = await chrome.storage.local.get(key);
      const value = result?.[key];
      return typeof value === "string" ? value : null;
    } catch {
      return null;
    }
  },
  async setItem(key: string, value: string): Promise<void> {
    try {
      if (typeof chrome === "undefined" || !chrome?.storage?.local) return;
      await chrome.storage.local.set({ [key]: value });
    } catch {
      /* ignore */
    }
  },
  async removeItem(key: string): Promise<void> {
    try {
      if (typeof chrome === "undefined" || !chrome?.storage?.local) return;
      await chrome.storage.local.remove(key);
    } catch {
      /* ignore */
    }
  },
};

export const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: chromeStorageAdapter as any,
    storageKey: "crm-ignis-auth",
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

/**
 * Resolve o workspaceId do usuário logado.
 * Convencionamos workspace_id === auth.uid() (TEXT) para que a função
 * SQL get_my_workspace_id() encontre uma linha em user_workspaces.
 *
 * Lança erro se não houver sessão ativa — todas as queries de domínio
 * dependem deste id, então é melhor falhar cedo do que silenciar.
 */
export async function getCurrentWorkspaceId(): Promise<string> {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  const userId = data.session?.user?.id;
  if (!userId) throw new Error("Sessão Supabase ausente — usuário não autenticado.");
  return userId;
}

export async function getCurrentUserId(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.user?.id ?? null;
}
