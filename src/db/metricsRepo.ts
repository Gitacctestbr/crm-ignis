import { supabase } from "../utils/supabaseClient";
import type { BoardType, DailyMetrics } from "./db";

// ─── Mapping snake_case ↔ camelCase ──────────────────────────────────────────

type MetricsRow = {
  id: string;
  workspace_id: string;
  board: BoardType;
  date_key: string;
  msg1_disparos: number;
  msg1_respostas: number;
  msg2_disparos: number;
  msg2_respostas: number;
  cta_disparos: number;
  agend_novos: number;
  follow_enviados: number;
  follow_respostas: number;
  follow_cta: number;
  agend_follow: number;
  created_at: number | string;
  updated_at: number | string;
  closed_at: number | string | null;
};

function n(v: number | string | null | undefined): number | undefined {
  if (v == null) return undefined;
  const x = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(x) ? x : undefined;
}

function rowToMetrics(r: MetricsRow): DailyMetrics {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    board: r.board,
    dateKey: r.date_key,
    msg1Disparos: r.msg1_disparos ?? 0,
    msg1Respostas: r.msg1_respostas ?? 0,
    msg2Disparos: r.msg2_disparos ?? 0,
    msg2Respostas: r.msg2_respostas ?? 0,
    ctaDisparos: r.cta_disparos ?? 0,
    agendNovos: r.agend_novos ?? 0,
    followEnviados: r.follow_enviados ?? 0,
    followRespostas: r.follow_respostas ?? 0,
    followCta: r.follow_cta ?? 0,
    agendFollow: r.agend_follow ?? 0,
    createdAt: n(r.created_at) ?? 0,
    updatedAt: n(r.updated_at) ?? 0,
    closedAt: n(r.closed_at),
  };
}

function metricsToRow(m: DailyMetrics): MetricsRow {
  return {
    id: m.id,
    workspace_id: m.workspaceId,
    board: m.board,
    date_key: m.dateKey,
    msg1_disparos: m.msg1Disparos ?? 0,
    msg1_respostas: m.msg1Respostas ?? 0,
    msg2_disparos: m.msg2Disparos ?? 0,
    msg2_respostas: m.msg2Respostas ?? 0,
    cta_disparos: m.ctaDisparos ?? 0,
    agend_novos: m.agendNovos ?? 0,
    follow_enviados: m.followEnviados ?? 0,
    follow_respostas: m.followRespostas ?? 0,
    follow_cta: m.followCta ?? 0,
    agend_follow: m.agendFollow ?? 0,
    created_at: m.createdAt,
    updated_at: m.updatedAt,
    closed_at: m.closedAt ?? null,
  };
}

// ─── Helpers públicos (puros, mantidos como antes) ───────────────────────────

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

export function emptyDailyMetrics(
  workspaceId: string,
  board: BoardType,
  dateKey: string,
): DailyMetrics {
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

// ─── CRUD ────────────────────────────────────────────────────────────────────

export async function getDailyMetrics(
  workspaceId: string,
  board: BoardType,
  dateKey: string,
): Promise<DailyMetrics | undefined> {
  const id = makeMetricsId(workspaceId, board, dateKey);
  const { data, error } = await supabase
    .from("daily_metrics")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data ? rowToMetrics(data as MetricsRow) : undefined;
}

export async function upsertDailyMetrics(metrics: DailyMetrics) {
  const now = Date.now();
  const existing = await getDailyMetrics(metrics.workspaceId, metrics.board, metrics.dateKey);
  const createdAt = existing?.createdAt ?? metrics.createdAt ?? now;
  const payload: DailyMetrics = {
    ...metrics,
    createdAt,
    updatedAt: now,
  };
  const { error } = await supabase.from("daily_metrics").upsert(metricsToRow(payload));
  if (error) throw error;
  return payload;
}

export type GuardedSaveResult =
  | { status: "saved"; metrics: DailyMetrics }
  | { status: "closed"; metrics: DailyMetrics };

export type GuardedSavePatch = Partial<
  Omit<DailyMetrics, "id" | "workspaceId" | "board" | "dateKey" | "createdAt" | "updatedAt">
> & {
  workspaceId: string;
  board: BoardType;
  dateKey: string;
};

/**
 * Upsert seguro com guarda contra dia fechado.
 *
 * No mundo Dexie isso era uma transação. Com Supabase, fazemos read → check →
 * write em duas chamadas: o pior caso é uma race onde duas abas escrevem
 * "ao mesmo tempo" — a última escrita ganha. Como o auto-save já roda com
 * debounce e o caso é single-user, é aceitável aqui. Se virar problema,
 * migrar para uma RPC (função PL/pgSQL) que faz tudo server-side.
 */
export async function upsertDailyMetricsGuarded(
  patch: GuardedSavePatch,
): Promise<GuardedSaveResult> {
  const existing = await getDailyMetrics(patch.workspaceId, patch.board, patch.dateKey);
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
    id: makeMetricsId(workspaceId, board, dateKey),
    workspaceId,
    board,
    dateKey,
    createdAt: base.createdAt ?? now,
    updatedAt: now,
  };

  const { error } = await supabase.from("daily_metrics").upsert(metricsToRow(payload));
  if (error) throw error;
  return { status: "saved", metrics: payload };
}

export async function closeDailyMetrics(
  workspaceId: string,
  board: BoardType,
  dateKey: string,
) {
  const existing =
    (await getDailyMetrics(workspaceId, board, dateKey)) ??
    emptyDailyMetrics(workspaceId, board, dateKey);
  const now = Date.now();
  const payload: DailyMetrics = {
    ...existing,
    closedAt: now,
    updatedAt: now,
  };
  const { error } = await supabase.from("daily_metrics").upsert(metricsToRow(payload));
  if (error) throw error;
  return payload;
}

export async function reopenDailyMetrics(
  workspaceId: string,
  board: BoardType,
  dateKey: string,
) {
  const existing = await getDailyMetrics(workspaceId, board, dateKey);
  if (!existing) return null;
  const now = Date.now();
  const payload: DailyMetrics = { ...existing, closedAt: undefined, updatedAt: now };
  const { error } = await supabase.from("daily_metrics").upsert(metricsToRow(payload));
  if (error) throw error;
  return payload;
}

export function weekRangeFromDateKey(dateKey: string) {
  const [y, m, d] = dateKey.split("-").map((x) => Number(x));
  const base = new Date(y, m - 1, d, 12, 0, 0, 0);
  const day = base.getDay();
  const diffToMon = (day + 6) % 7;
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

export async function getWeekMetrics(
  workspaceId: string,
  board: BoardType,
  dateKey: string,
) {
  const keys = weekRangeFromDateKey(dateKey);
  const ids = keys.map((k) => makeMetricsId(workspaceId, board, k));

  const { data, error } = await supabase
    .from("daily_metrics")
    .select("*")
    .in("id", ids);
  if (error) throw error;

  const byId = new Map<string, DailyMetrics>();
  for (const row of data ?? []) {
    const m = rowToMetrics(row as MetricsRow);
    byId.set(m.id, m);
  }

  return keys.map((k) => ({
    dateKey: k,
    metrics: byId.get(makeMetricsId(workspaceId, board, k)) ?? null,
  }));
}
