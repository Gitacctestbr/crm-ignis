import type { BoardType, DailyMetrics } from "./db";
import { db } from "./db";

export function makeMetricsId(workspaceId: string, board: BoardType, dateKey: string) {
  return `${workspaceId}:${board}:${dateKey}`;
}

export function todayDateKey(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function isValidDateKey(dateKey: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(dateKey);
}

export function emptyDailyMetrics(workspaceId: string, board: BoardType, dateKey: string): DailyMetrics {
  const now = Date.now();
  return {
    id: makeMetricsId(workspaceId, board, dateKey),
    workspaceId,
    board,
    dateKey,

    msg1Disparos: 0,
    msg1Respostas: 0,
    msg2Disparos: 0,
    msg2Respostas: 0,

    ctaDisparos: 0,
    agendNovos: 0,

    followEnviados: 0,
    followRespostas: 0,
    followCta: 0,
    agendFollow: 0,

    createdAt: now,
    updatedAt: now,
  };
}

export async function getDailyMetrics(workspaceId: string, board: BoardType, dateKey: string) {
  const id = makeMetricsId(workspaceId, board, dateKey);
  return db.dailyMetrics.get(id);
}

export async function upsertDailyMetrics(metrics: DailyMetrics) {
  const now = Date.now();
  const existing = await db.dailyMetrics.get(metrics.id);
  const createdAt = existing?.createdAt ?? metrics.createdAt ?? now;
  const payload: DailyMetrics = {
    ...metrics,
    createdAt,
    updatedAt: now,
  };
  await db.dailyMetrics.put(payload);
  return payload;
}

export type GuardedSaveResult =
  | { status: "saved"; metrics: DailyMetrics }
  | { status: "closed"; metrics: DailyMetrics };

export type GuardedSavePatch =
  Partial<Omit<DailyMetrics, "id" | "workspaceId" | "board" | "dateKey" | "createdAt" | "updatedAt">>
  & {
    workspaceId: string;
    board: BoardType;
    dateKey: string;
  };

/**
 * Upsert transacional seguro para uso em auto-save.
 * - Relê o registro dentro da transação e aborta se `closedAt` estiver setado
 *   (a trava do "Fechar dia" vence sobre qualquer debounce pendente).
 * - Aceita apenas um patch parcial: campos não informados preservam o valor
 *   do registro existente, evitando sobrescrever edições concorrentes vindas
 *   de outra aba (Kanban / outra janela).
 * - Preserva `createdAt`; atualiza `updatedAt` para now().
 */
export async function upsertDailyMetricsGuarded(
  patch: GuardedSavePatch,
): Promise<GuardedSaveResult> {
  const id = makeMetricsId(patch.workspaceId, patch.board, patch.dateKey);
  return db.transaction("rw", db.dailyMetrics, async () => {
    const existing = await db.dailyMetrics.get(id);
    if (existing?.closedAt) {
      return { status: "closed", metrics: existing };
    }
    const now = Date.now();
    const base: DailyMetrics =
      existing ?? emptyDailyMetrics(patch.workspaceId, patch.board, patch.dateKey);
    const { workspaceId, board, dateKey, ...rest } = patch;
    const payload: DailyMetrics = {
      ...base,
      ...rest,
      id,
      workspaceId,
      board,
      dateKey,
      createdAt: base.createdAt ?? now,
      updatedAt: now,
    };
    await db.dailyMetrics.put(payload);
    return { status: "saved", metrics: payload };
  });
}

export async function closeDailyMetrics(workspaceId: string, board: BoardType, dateKey: string) {
  const existing =
    (await getDailyMetrics(workspaceId, board, dateKey)) ?? emptyDailyMetrics(workspaceId, board, dateKey);
  const now = Date.now();
  const payload: DailyMetrics = {
    ...existing,
    closedAt: now,
    updatedAt: now,
  };
  await db.dailyMetrics.put(payload);
  return payload;
}

export async function reopenDailyMetrics(workspaceId: string, board: BoardType, dateKey: string) {
  const existing = await getDailyMetrics(workspaceId, board, dateKey);
  if (!existing) return null;
  const now = Date.now();
  const payload: DailyMetrics = { ...existing, closedAt: undefined, updatedAt: now };
  await db.dailyMetrics.put(payload);
  return payload;
}

/**
 * Lista métricas de uma semana (7 dias) baseado em um dateKey.
 * Semana começa na segunda-feira.
 */
export function weekRangeFromDateKey(dateKey: string) {
  // dateKey: YYYY-MM-DD
  const [y, m, d] = dateKey.split("-").map((x) => Number(x));
  const base = new Date(y, m - 1, d, 12, 0, 0, 0);
  const day = base.getDay(); // 0 domingo ... 6 sab
  const diffToMon = (day + 6) % 7; // seg=0
  const mon = new Date(base);
  mon.setDate(base.getDate() - diffToMon);
  mon.setHours(12, 0, 0, 0);

  const keys: string[] = [];
  for (let i = 0; i < 7; i++) {
    const x = new Date(mon);
    x.setDate(mon.getDate() + i);
    const yyyy = x.getFullYear();
    const mm = String(x.getMonth() + 1).padStart(2, "0");
    const dd = String(x.getDate()).padStart(2, "0");
    keys.push(`${yyyy}-${mm}-${dd}`);
  }
  return keys;
}

export async function getWeekMetrics(workspaceId: string, board: BoardType, dateKey: string) {
  const keys = weekRangeFromDateKey(dateKey);
  const ids = keys.map((k) => makeMetricsId(workspaceId, board, k));
  const rows = await db.dailyMetrics.bulkGet(ids);
  const out = keys.map((k, i) => ({ dateKey: k, metrics: rows[i] ?? null }));
  return out;
}
