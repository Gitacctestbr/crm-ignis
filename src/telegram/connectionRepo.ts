import { supabase } from "../utils/supabaseClient";

/**
 * Estado de conexão com Telegram do workspace atual.
 * - false = nenhum chat ativo vinculado
 * - true  = pelo menos 1 chat ativo
 */
export async function isWorkspaceConnected(workspaceId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("telegram_links")
    .select("chat_id")
    .eq("workspace_id", workspaceId)
    .eq("is_active", true)
    .limit(1);
  if (error) {
    console.warn("[CRM IGNIS] isWorkspaceConnected error:", error);
    return false;
  }
  return Boolean(data && data.length);
}

/**
 * Lista chat_ids vinculados ativos. Útil pra mostrar "X chats conectados"
 * quando o workspace tem multi-operadores.
 */
export async function listActiveChats(workspaceId: string): Promise<number[]> {
  const { data, error } = await supabase
    .from("telegram_links")
    .select("chat_id")
    .eq("workspace_id", workspaceId)
    .eq("is_active", true);
  if (error) return [];
  return (data ?? []).map((r) => Number(r.chat_id));
}
