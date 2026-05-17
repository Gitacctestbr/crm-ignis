/**
 * Tipos de domínio do CRM IGNIS.
 *
 * O banco local Dexie foi removido em favor do Supabase (PostgreSQL na nuvem).
 * Este arquivo agora só exporta os tipos compartilhados pelo app — toda
 * persistência vive nos repos (`leadsRepo.ts`, `metricsRepo.ts`).
 *
 * Convenções:
 *   - camelCase em todo o TypeScript (workspaceId, createdAt, ...)
 *   - snake_case no PostgreSQL (workspace_id, created_at, ...)
 *   - O mapeamento entre os dois acontece dentro de cada repo.
 */

export type BoardType = "OUTBOUND" | "SOCIAL";

export type Lead = {
  id: string;
  workspaceId: string;

  board: BoardType;
  stageId: string;

  username: string;
  usernameLower: string;

  displayName?: string;

  avatarUrl?: string;

  priority: "low" | "medium" | "high";
  tags: string[];

  notes: string;

  createdAt: number;
  updatedAt: number;
  lastTouchedAt: number;
  nextFollowUpAt?: number;
  deletedAt?: number;

  ctaUrl?: string;
  ctaAt?: number;
  ctaNote?: string;

  // Bot Telegram: rastreabilidade + revisão manual
  needsReview?: boolean;          // OCR ambíguo → SDR precisa corrigir manualmente
  createdByChatId?: number;       // qual chat capturou (rastreabilidade multi-operador)
  originalPrintUrl?: string;      // path no bucket print_review (UI gera signed URL)
  extractionObs?: string;         // texto da observação do OCR
};

export type Task = {
  id: string;
  workspaceId: string;
  leadId: string;

  title: string;
  dueAt: number;
  doneAt?: number;

  status: "open" | "done" | "snoozed";
  snoozeUntil?: number;
};

export type ActivityEvent = {
  id: string;
  workspaceId: string;
  leadId: string;

  type:
    | "CREATED"
    | "MOVED_STAGE"
    | "NOTE_UPDATED"
    | "PRIORITY_CHANGED"
    | "TASK_CREATED"
    | "TASK_DONE";

  fromStageId?: string;
  toStageId?: string;

  at: number;
  day: number; // formato: yyyymmdd (para filtro por dia)
};

export type DailyMetrics = {
  id: string; // `${workspaceId}:${board}:${dateKey}`
  workspaceId: string;
  board: BoardType;
  dateKey: string;

  msg1Disparos: number;
  msg1Respostas: number;
  msg2Disparos: number;
  msg2Respostas: number;

  ctaDisparos: number;
  agendNovos: number;

  followEnviados: number;
  followRespostas: number;
  followCta: number;
  agendFollow: number;

  createdAt: number;
  updatedAt: number;
  closedAt?: number;
};

/**
 * Converte epoch ms em yyyymmdd inteiro (TZ local).
 * Usado para filtrar eventos por dia sem parse de data.
 */
export function toDayKey(ts: number) {
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return Number(`${yyyy}${mm}${dd}`);
}
