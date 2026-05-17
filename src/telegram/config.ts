/**
 * Configuração do bot do Telegram (lado da extensão).
 * Edite aqui quando trocar de bot ou adicionar novo.
 */

// @username do bot, sem o "@". Tem que bater com o que foi criado no @BotFather.
export const BOT_USERNAME = "Ignis_crm_bot";

// Display name (informativo pro usuário ver na UI).
export const BOT_DISPLAY_NAME = "IGNIS BOT CRM";

/**
 * Gera o link mágico que o cliente clica no celular pra vincular.
 * Formato: https://t.me/<bot_username>?start=ws_<workspace_id>
 *
 * Hoje (ambiente controlado, ~10 clientes) o token é o próprio
 * workspace_id. Quando virar ambiente menos controlado, trocar
 * pelo UUID descartável da tabela telegram_invites.
 */
export function buildConnectLink(workspaceId: string): string {
  return `https://t.me/${BOT_USERNAME}?start=ws_${workspaceId}`;
}
