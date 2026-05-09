import { supabase, getCurrentWorkspaceId } from "../utils/supabaseClient";
import { canonicalUsername } from "./leadsRepo";

/**
 * Backup / restore de dados do CRM.
 *
 * Pós-migração para Supabase, o banco de origem é remoto. Este módulo:
 *   - Exporta as 4 tabelas do workspace logado (leads, tasks, activity_events,
 *     daily_metrics) em um envelope JSON versionado;
 *   - Importa o envelope de volta para o Supabase, em modo MERGE (default,
 *     idempotente) ou REPLACE (apaga tudo do workspace antes de inserir).
 *
 * O formato do envelope mantém compatibilidade com a v1 da era Dexie. Backups
 * antigos (que tinham nomes de tabela como "events" e campos camelCase) ainda
 * funcionam porque normalizamos os nomes/campos no import.
 */

export type IgnisBackupFormat = "ignis-crm-backup";

export type IgnisBackupEnvelopeV1 = {
  format: IgnisBackupFormat;
  backupVersion: 1;
  exportedAt: string; // ISO
  app: {
    name: string;
    extensionVersion?: string;
    workspaceId?: string;
  };
  tables: Record<
    string,
    {
      count: number;
      rows: any[];
    }
  >;
};

export type ImportMode = "merge" | "replace";

export type ImportOptions = {
  mode?: ImportMode; // default "merge"
  confirmReplace?: boolean;
  keepExistingLeadStage?: boolean; // default true
};

export type ImportResult = {
  tables: Array<{
    name: string;
    incoming: number;
    added: number;
    updated: number;
    skipped: number;
  }>;
};

// Nomes canônicos das tabelas no Supabase. Usamos os mesmos no envelope para
// não inventar metadado novo.
const TABLE_NAMES = ["leads", "tasks", "activity_events", "daily_metrics"] as const;
type TableName = (typeof TABLE_NAMES)[number];

// Mapeamento de nomes legados (era Dexie) → nome atual.
function canonicalTableName(name: string): TableName | null {
  const n = name.toLowerCase();
  if (n === "leads" || n === "lead") return "leads";
  if (n === "tasks" || n === "task") return "tasks";
  if (n === "events" || n === "activity_events" || n === "activityevents") return "activity_events";
  if (n === "dailymetrics" || n === "daily_metrics") return "daily_metrics";
  return null;
}

function getExtensionVersion(): string | undefined {
  try {
    return chrome?.runtime?.getManifest?.()?.version;
  } catch {
    return undefined;
  }
}

function isRecord(x: unknown): x is Record<string, any> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function safeLower(x: unknown) {
  return String(x ?? "").trim().toLowerCase();
}

/**
 * Lead "natural key" para evitar colisões de id entre exports.
 * Usamos (board + username) como identificador estável para merges.
 */
function computeLeadNaturalKey(lead: any): string {
  const username =
    lead.username ??
    lead.username_lower ??
    lead.usernameLower ??
    lead.igUsername ??
    lead.handle ??
    "";
  const board = lead.board ?? lead.boardId ?? "default";
  return `${safeLower(board)}::${canonicalUsername(String(username))}`;
}

// ─── Conversão TS (camelCase) → linha PG (snake_case) por tipo ───────────────
// O envelope pode chegar de versões antigas com camelCase OU com snake_case
// (após esta migração). Aceitamos os dois e produzimos sempre snake_case.

function pickCamelOrSnake<T>(row: any, snake: string, camel: string, fallback: T): T {
  if (row[snake] != null) return row[snake];
  if (row[camel] != null) return row[camel];
  return fallback;
}

function toLeadRow(r: any, workspaceId: string): any {
  const usernameRaw = r.username ?? r.username_lower ?? r.usernameLower ?? "";
  const clean = canonicalUsername(String(usernameRaw));
  return {
    id: r.id ?? crypto.randomUUID(),
    workspace_id: workspaceId,
    board: r.board,
    stage_id: pickCamelOrSnake(r, "stage_id", "stageId", "LEADS_NOVOS"),
    username: clean,
    username_lower: clean,
    display_name: pickCamelOrSnake(r, "display_name", "displayName", null),
    avatar_url: pickCamelOrSnake(r, "avatar_url", "avatarUrl", null),
    priority: r.priority ?? "medium",
    tags: Array.isArray(r.tags) ? r.tags : [],
    notes: r.notes ?? "",
    created_at: pickCamelOrSnake(r, "created_at", "createdAt", Date.now()),
    updated_at: pickCamelOrSnake(r, "updated_at", "updatedAt", Date.now()),
    last_touched_at: pickCamelOrSnake(r, "last_touched_at", "lastTouchedAt", Date.now()),
    next_follow_up_at: pickCamelOrSnake(r, "next_follow_up_at", "nextFollowUpAt", null),
    deleted_at: pickCamelOrSnake(r, "deleted_at", "deletedAt", null),
    cta_url: pickCamelOrSnake(r, "cta_url", "ctaUrl", null),
    cta_at: pickCamelOrSnake(r, "cta_at", "ctaAt", null),
    cta_note: pickCamelOrSnake(r, "cta_note", "ctaNote", null),
  };
}

function toTaskRow(r: any, workspaceId: string): any {
  return {
    id: r.id ?? crypto.randomUUID(),
    workspace_id: workspaceId,
    lead_id: pickCamelOrSnake(r, "lead_id", "leadId", null),
    title: r.title ?? "",
    due_at: pickCamelOrSnake(r, "due_at", "dueAt", Date.now()),
    done_at: pickCamelOrSnake(r, "done_at", "doneAt", null),
    status: r.status ?? "open",
    snooze_until: pickCamelOrSnake(r, "snooze_until", "snoozeUntil", null),
  };
}

function toEventRow(r: any, workspaceId: string): any {
  return {
    id: r.id ?? crypto.randomUUID(),
    workspace_id: workspaceId,
    lead_id: pickCamelOrSnake(r, "lead_id", "leadId", null),
    type: r.type,
    from_stage_id: pickCamelOrSnake(r, "from_stage_id", "fromStageId", null),
    to_stage_id: pickCamelOrSnake(r, "to_stage_id", "toStageId", null),
    at: r.at ?? Date.now(),
    day: r.day,
  };
}

function toMetricsRow(r: any, workspaceId: string): any {
  return {
    id: r.id,
    workspace_id: workspaceId,
    board: r.board,
    date_key: pickCamelOrSnake(r, "date_key", "dateKey", ""),
    msg1_disparos: pickCamelOrSnake(r, "msg1_disparos", "msg1Disparos", 0),
    msg1_respostas: pickCamelOrSnake(r, "msg1_respostas", "msg1Respostas", 0),
    msg2_disparos: pickCamelOrSnake(r, "msg2_disparos", "msg2Disparos", 0),
    msg2_respostas: pickCamelOrSnake(r, "msg2_respostas", "msg2Respostas", 0),
    cta_disparos: pickCamelOrSnake(r, "cta_disparos", "ctaDisparos", 0),
    agend_novos: pickCamelOrSnake(r, "agend_novos", "agendNovos", 0),
    follow_enviados: pickCamelOrSnake(r, "follow_enviados", "followEnviados", 0),
    follow_respostas: pickCamelOrSnake(r, "follow_respostas", "followRespostas", 0),
    follow_cta: pickCamelOrSnake(r, "follow_cta", "followCta", 0),
    agend_follow: pickCamelOrSnake(r, "agend_follow", "agendFollow", 0),
    created_at: pickCamelOrSnake(r, "created_at", "createdAt", Date.now()),
    updated_at: pickCamelOrSnake(r, "updated_at", "updatedAt", Date.now()),
    closed_at: pickCamelOrSnake(r, "closed_at", "closedAt", null),
  };
}

// ─── Download helper ─────────────────────────────────────────────────────────

async function downloadJsonFile(filename: string, jsonText: string) {
  const blob = new Blob([jsonText], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  try {
    if (chrome?.downloads?.download) {
      await chrome.downloads.download({ url, filename, saveAs: true });
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      return;
    }
  } catch {
    /* fallback below */
  }

  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ─── EXPORT ──────────────────────────────────────────────────────────────────

export async function exportIgnisBackup(): Promise<IgnisBackupEnvelopeV1> {
  const workspaceId = await getCurrentWorkspaceId();
  const tables: IgnisBackupEnvelopeV1["tables"] = {};

  for (const name of TABLE_NAMES) {
    const { data, error } = await supabase
      .from(name)
      .select("*")
      .eq("workspace_id", workspaceId);
    if (error) throw error;
    const rows = data ?? [];
    tables[name] = { count: rows.length, rows };
  }

  return {
    format: "ignis-crm-backup",
    backupVersion: 1,
    exportedAt: new Date().toISOString(),
    app: {
      name: "CRM IGNIS",
      extensionVersion: getExtensionVersion(),
      workspaceId,
    },
    tables,
  };
}

export async function exportIgnisBackupToFile() {
  const envelope = await exportIgnisBackup();
  const timestamp = envelope.exportedAt
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .replace("Z", "");
  const filename = `ignis-backup-${timestamp}.json`;
  const json = JSON.stringify(envelope, null, 2);
  await downloadJsonFile(filename, json);
}

// ─── IMPORT ──────────────────────────────────────────────────────────────────

function assertEnvelopeV1(x: any): asserts x is IgnisBackupEnvelopeV1 {
  if (!isRecord(x)) throw new Error("Backup inválido: não é um objeto JSON.");
  if (x.format !== "ignis-crm-backup") throw new Error("Backup inválido: format incorreto.");
  if (x.backupVersion !== 1)
    throw new Error("Backup inválido: versão não suportada (esperado v1).");
  if (!isRecord(x.tables)) throw new Error("Backup inválido: tables ausente.");
}

export async function importIgnisBackupFromJson(
  jsonText: string,
  options: ImportOptions = {},
): Promise<ImportResult> {
  const mode: ImportMode = options.mode ?? "merge";
  const keepExistingLeadStage = options.keepExistingLeadStage ?? true;

  const parsed = JSON.parse(jsonText);
  assertEnvelopeV1(parsed);

  if (mode === "replace" && !options.confirmReplace) {
    throw new Error("Importação em modo REPLACE bloqueada: confirmReplace=false.");
  }

  const workspaceId = await getCurrentWorkspaceId();
  const result: ImportResult = { tables: [] };

  // Agrupa rows por tabela canônica (resolve nomes legados como "events").
  const rowsByTable: Record<TableName, any[]> = {
    leads: [],
    tasks: [],
    activity_events: [],
    daily_metrics: [],
  };

  for (const [rawName, payload] of Object.entries(parsed.tables)) {
    const canonical = canonicalTableName(rawName);
    if (!canonical) continue;
    const incomingRows = (payload as any)?.rows ?? [];
    if (Array.isArray(incomingRows)) {
      rowsByTable[canonical].push(...incomingRows);
    }
  }

  // ─── REPLACE ──────────────────────────────────────────────────────────────
  // Apaga TUDO do workspace e insere do zero. Ordem importa pelas FKs:
  // activity_events → tasks → daily_metrics → leads (deletar leads por último).
  if (mode === "replace") {
    for (const t of ["activity_events", "tasks", "daily_metrics", "leads"] as TableName[]) {
      const { error } = await supabase.from(t).delete().eq("workspace_id", workspaceId);
      if (error) throw error;
    }
  }

  // ─── LEADS ────────────────────────────────────────────────────────────────
  {
    const incoming = rowsByTable.leads;
    let added = 0;
    let updated = 0;
    let skipped = 0;

    if (mode === "replace") {
      const rows = incoming
        .filter((r) => r && (r.username || r.username_lower || r.usernameLower))
        .map((r) => toLeadRow(r, workspaceId));
      if (rows.length) {
        const { error } = await supabase.from("leads").insert(rows);
        if (error) throw error;
        added = rows.length;
      }
      skipped = incoming.length - rows.length;
    } else {
      // MERGE: por chave natural (board+username). Buscar tudo do ws e
      // construir mapa em memória — escala pra single-user, centenas de leads.
      const { data: existingRows, error: existingErr } = await supabase
        .from("leads")
        .select("*")
        .eq("workspace_id", workspaceId);
      if (existingErr) throw existingErr;

      const existingByKey = new Map<string, any>();
      for (const row of existingRows ?? []) {
        existingByKey.set(computeLeadNaturalKey(row), row);
      }

      const toInsert: any[] = [];
      const toUpdate: any[] = []; // pares para .upsert()

      for (const inc of incoming) {
        if (!inc) {
          skipped++;
          continue;
        }
        const cleanUsername = canonicalUsername(
          String(inc.username ?? inc.username_lower ?? inc.usernameLower ?? ""),
        );
        if (!cleanUsername) {
          skipped++;
          continue;
        }

        const key = computeLeadNaturalKey(inc);
        const found = existingByKey.get(key);

        if (found) {
          // merge campo a campo — incoming sobrescreve, com algumas guardas.
          const incRow = toLeadRow({ ...found, ...inc, id: found.id }, workspaceId);
          if (
            keepExistingLeadStage &&
            found.stage_id &&
            incRow.stage_id &&
            String(found.stage_id) !== String(incRow.stage_id)
          ) {
            incRow.stage_id = found.stage_id;
          }
          // Preserva createdAt mais antigo
          if (found.created_at) incRow.created_at = found.created_at;
          toUpdate.push(incRow);
          updated++;
        } else {
          toInsert.push(toLeadRow(inc, workspaceId));
          added++;
        }
      }

      if (toInsert.length) {
        const { error } = await supabase.from("leads").insert(toInsert);
        if (error) throw error;
      }
      if (toUpdate.length) {
        const { error } = await supabase.from("leads").upsert(toUpdate, { onConflict: "id" });
        if (error) throw error;
      }
    }

    result.tables.push({
      name: "leads",
      incoming: incoming.length,
      added,
      updated,
      skipped,
    });
  }

  // ─── TASKS / EVENTS / METRICS ─────────────────────────────────────────────
  // Estes três usam upsert por id (PK). Em merge, o id colidindo atualiza.
  for (const tableName of ["tasks", "activity_events", "daily_metrics"] as TableName[]) {
    const incoming = rowsByTable[tableName];
    let added = 0;
    let updated = 0;
    let skipped = 0;

    const rows = incoming
      .filter((r) => r && r.id)
      .map((r) => {
        if (tableName === "tasks") return toTaskRow(r, workspaceId);
        if (tableName === "activity_events") return toEventRow(r, workspaceId);
        return toMetricsRow(r, workspaceId);
      });

    skipped = incoming.length - rows.length;

    if (rows.length) {
      const { error } = await supabase.from(tableName).upsert(rows, { onConflict: "id" });
      if (error) throw error;
      // Sem checagem de existência prévia para não dobrar round-trips.
      // Reportamos como "updated" — semanticamente upsert é idempotente.
      updated = rows.length;
    }

    result.tables.push({
      name: tableName,
      incoming: incoming.length,
      added,
      updated,
      skipped,
    });
  }

  return result;
}

export async function importIgnisBackupFromFile(
  file: File,
  options: ImportOptions = {},
): Promise<ImportResult> {
  const text = await file.text();
  return importIgnisBackupFromJson(text, options);
}
