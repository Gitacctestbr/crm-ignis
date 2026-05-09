import { supabase } from "../utils/supabaseClient";
import { Lead, ActivityEvent, BoardType, toDayKey } from "./db";
import { normalizeStageId, type StageId } from "../crm/stages";

function newId() {
  return crypto.randomUUID();
}

/**
 * Fonte única de verdade para normalização de username.
 * Todo username que entra no sistema — para busca ou para gravação —
 * DEVE passar por esta função. Nunca salvar `usernameLower` com `@`.
 */
export function canonicalUsername(u: string): string {
  return String(u || "").trim().replace(/^@+/, "").toLowerCase();
}

// ─── Mapeamento snake_case (PostgreSQL) ↔ camelCase (TypeScript) ──────────────
// O Supabase devolve linhas com as colunas exatas do schema. Mantemos os tipos
// camelCase no app inteiro e fazemos o mapping aqui no repo, ponto único de
// conversão. Isso evita refator em centenas de pontos da UI.

type LeadRow = {
  id: string;
  workspace_id: string;
  board: BoardType;
  stage_id: string;
  username: string;
  username_lower: string;
  display_name: string | null;
  avatar_url: string | null;
  priority: "low" | "medium" | "high";
  tags: string[] | null;
  notes: string | null;
  created_at: number | string;
  updated_at: number | string;
  last_touched_at: number | string;
  next_follow_up_at: number | string | null;
  deleted_at: number | string | null;
  cta_url: string | null;
  cta_at: number | string | null;
  cta_note: string | null;
};

function n(v: number | string | null | undefined): number | undefined {
  if (v == null) return undefined;
  const x = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(x) ? x : undefined;
}

function rowToLead(r: LeadRow): Lead {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    board: r.board,
    stageId: r.stage_id,
    username: r.username,
    usernameLower: r.username_lower,
    displayName: r.display_name ?? undefined,
    avatarUrl: r.avatar_url ?? undefined,
    priority: r.priority,
    tags: Array.isArray(r.tags) ? r.tags : [],
    notes: r.notes ?? "",
    createdAt: n(r.created_at) ?? 0,
    updatedAt: n(r.updated_at) ?? 0,
    lastTouchedAt: n(r.last_touched_at) ?? 0,
    nextFollowUpAt: n(r.next_follow_up_at),
    deletedAt: n(r.deleted_at),
    ctaUrl: r.cta_url ?? undefined,
    ctaAt: n(r.cta_at),
    ctaNote: r.cta_note ?? undefined,
  };
}

function leadToRow(lead: Lead): LeadRow {
  return {
    id: lead.id,
    workspace_id: lead.workspaceId,
    board: lead.board,
    stage_id: lead.stageId,
    username: lead.username,
    username_lower: lead.usernameLower,
    display_name: lead.displayName ?? null,
    avatar_url: lead.avatarUrl ?? null,
    priority: lead.priority,
    tags: lead.tags ?? [],
    notes: lead.notes ?? "",
    created_at: lead.createdAt,
    updated_at: lead.updatedAt,
    last_touched_at: lead.lastTouchedAt,
    next_follow_up_at: lead.nextFollowUpAt ?? null,
    deleted_at: lead.deletedAt ?? null,
    cta_url: lead.ctaUrl ?? null,
    cta_at: lead.ctaAt ?? null,
    cta_note: lead.ctaNote ?? null,
  };
}

type EventRow = {
  id: string;
  workspace_id: string;
  lead_id: string;
  type: ActivityEvent["type"];
  from_stage_id: string | null;
  to_stage_id: string | null;
  at: number | string;
  day: number;
};

function eventToRow(ev: ActivityEvent): EventRow {
  return {
    id: ev.id,
    workspace_id: ev.workspaceId,
    lead_id: ev.leadId,
    type: ev.type,
    from_stage_id: ev.fromStageId ?? null,
    to_stage_id: ev.toStageId ?? null,
    at: ev.at,
    day: ev.day,
  };
}

// ─── Broadcast ────────────────────────────────────────────────────────────────

/**
 * Notifica todos os contextos da extensão que algo mudou no banco.
 * Mesmo padrão da era Dexie — `broadcastDbUpdated` continua o canal de
 * sincronização entre painel flutuante (content script), Dashboard e SidePanel.
 */
async function broadcastDbUpdated(reason: string, leadId?: string): Promise<void> {
  const message = {
    type: "CRM_IGNIS_DB_UPDATED" as const,
    payload: { reason, leadId: leadId ?? null },
  };

  try {
    if (typeof chrome !== "undefined" && chrome?.runtime?.sendMessage) {
      await Promise.resolve(chrome.runtime.sendMessage(message)).catch(() => {});
    }
  } catch {
    /* contexto sem chrome.runtime — ignora */
  }

  try {
    if (typeof chrome !== "undefined" && chrome?.tabs?.query) {
      const tabs = await chrome.tabs.query({
        url: ["*://instagram.com/*", "*://*.instagram.com/*"],
      });
      await Promise.all(
        tabs.map((t) =>
          t.id == null
            ? Promise.resolve()
            : Promise.resolve(chrome.tabs.sendMessage(t.id, message)).catch(() => {}),
        ),
      );
    }
  } catch {
    /* chrome.tabs não disponível neste contexto (ex: content script) */
  }
}

// ─── API pública ──────────────────────────────────────────────────────────────

export type AddLeadResult =
  | { status: "created"; lead: Lead }
  | { status: "exists"; lead: Lead };

export async function addLead(input: {
  workspaceId: string;
  board: BoardType;
  stageId?: string;
  username: string;
  displayName?: string;
  avatarUrl?: string | null;
}): Promise<AddLeadResult> {
  const now = Date.now();

  const usernameLower = canonicalUsername(input.username);
  const stageId = normalizeStageId((input.stageId && String(input.stageId).trim()) || "LEADS_NOVOS");

  if (!input.workspaceId) throw new Error("workspaceId obrigatório");
  if (!usernameLower) throw new Error("username obrigatório");
  if (input.board !== "OUTBOUND" && input.board !== "SOCIAL") throw new Error("board inválido");

  const cleanAvatar =
    typeof input.avatarUrl === "string" &&
    (input.avatarUrl.startsWith("http") || input.avatarUrl.startsWith("data:"))
      ? input.avatarUrl
      : undefined;

  // Proteção contra duplicatas: busca pelo usernameLower no workspace.
  // O índice único parcial em leads(workspace_id, username_lower) WHERE deleted_at IS NULL
  // é a garantia final contra race conditions, mas a checagem antecipada
  // dá feedback melhor pra UI ("exists" em vez de erro).
  const { data: existingRows, error: lookupErr } = await supabase
    .from("leads")
    .select("*")
    .eq("workspace_id", input.workspaceId)
    .eq("username_lower", usernameLower)
    .is("deleted_at", null)
    .limit(1);
  if (lookupErr) throw lookupErr;

  const existing = existingRows && existingRows[0] ? rowToLead(existingRows[0] as LeadRow) : null;

  if (existing) {
    if (!existing.avatarUrl && cleanAvatar) {
      const { error: updErr } = await supabase
        .from("leads")
        .update({ avatar_url: cleanAvatar, updated_at: now, last_touched_at: now })
        .eq("id", existing.id);
      if (updErr) throw updErr;

      const refreshed: Lead = { ...existing, avatarUrl: cleanAvatar, updatedAt: now, lastTouchedAt: now };
      await broadcastDbUpdated("addLead:avatar_backfill", existing.id);
      return { status: "exists", lead: refreshed };
    }
    return { status: "exists", lead: existing };
  }

  const lead: Lead = {
    id: newId(),
    workspaceId: input.workspaceId,

    board: input.board,
    stageId,

    username: usernameLower,
    usernameLower,

    displayName: input.displayName?.trim() || undefined,
    avatarUrl: cleanAvatar,

    priority: "medium",
    tags: [],
    notes: "",

    createdAt: now,
    updatedAt: now,
    lastTouchedAt: now,
  };

  const event: ActivityEvent = {
    id: newId(),
    workspaceId: lead.workspaceId,
    leadId: lead.id,
    type: "CREATED",
    at: now,
    day: toDayKey(now),
  };

  const { error: insertErr } = await supabase.from("leads").insert(leadToRow(lead));
  if (insertErr) throw insertErr;

  // Event é fire-and-forget: se falhar, o lead já foi criado e o app continua
  // funcionando — o histórico de atividades é informativo, não crítico.
  const { error: evErr } = await supabase.from("activity_events").insert(eventToRow(event));
  if (evErr) console.warn("[CRM IGNIS] Falha ao registrar activity_event CREATED:", evErr);

  await broadcastDbUpdated("addLead:created", lead.id);
  return { status: "created", lead };
}

async function getLeadById(id: string): Promise<Lead | null> {
  const { data, error } = await supabase.from("leads").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data ? rowToLead(data as LeadRow) : null;
}

export async function getLeadByUsername(input: { workspaceId: string; username: string }) {
  const usernameLower = canonicalUsername(input.username);
  if (!input.workspaceId) throw new Error("workspaceId obrigatório");
  if (!usernameLower) return null;

  const { data, error } = await supabase
    .from("leads")
    .select("*")
    .eq("workspace_id", input.workspaceId)
    .eq("username_lower", usernameLower)
    .is("deleted_at", null)
    .limit(1);
  if (error) throw error;
  if (!data || data.length === 0) return null;
  return rowToLead(data[0] as LeadRow);
}

/**
 * Busca leads por substring em username ou displayName (case-insensitive).
 * Usa ilike no Postgres — o índice GIN não cobre, mas para a escala dessa
 * extensão (single user, centenas de leads) é mais que suficiente.
 */
export async function searchLeads(input: {
  workspaceId: string;
  query: string;
  limit?: number;
}): Promise<Lead[]> {
  const q = canonicalUsername(input.query);
  if (!input.workspaceId) throw new Error("workspaceId obrigatório");
  if (!q) return [];

  const limit = Math.max(1, Math.min(50, input.limit ?? 10));
  const pattern = `%${q}%`;

  const { data, error } = await supabase
    .from("leads")
    .select("*")
    .eq("workspace_id", input.workspaceId)
    .is("deleted_at", null)
    .or(`username_lower.ilike.${pattern},display_name.ilike.${pattern}`)
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((r) => rowToLead(r as LeadRow));
}

export async function listRecentlyUpdatedLeads(input: {
  workspaceId: string;
  limit?: number;
}): Promise<Lead[]> {
  if (!input.workspaceId) throw new Error("workspaceId obrigatório");
  const limit = Math.max(1, Math.min(50, input.limit ?? 5));

  const { data, error } = await supabase
    .from("leads")
    .select("*")
    .eq("workspace_id", input.workspaceId)
    .is("deleted_at", null)
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((r) => rowToLead(r as LeadRow));
}

export async function listLeadsByBoard(workspaceId: string, board: BoardType) {
  const { data, error } = await supabase
    .from("leads")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("board", board)
    .is("deleted_at", null)
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map((r) => rowToLead(r as LeadRow));
}

export async function updateLead(input: {
  workspaceId: string;
  leadId: string;
  patch: Partial<
    Pick<
      Lead,
      | "board"
      | "stageId"
      | "notes"
      | "tags"
      | "priority"
      | "displayName"
      | "nextFollowUpAt"
      | "avatarUrl"
      | "ctaUrl"
      | "ctaAt"
      | "ctaNote"
    >
  >;
}) {
  const lead = await getLeadById(input.leadId);
  if (!lead) return null;
  if (lead.workspaceId !== input.workspaceId) return null;

  const now = Date.now();
  const patch = { ...input.patch };

  const next: Lead = {
    ...lead,
    ...patch,
    stageId: patch.stageId
      ? normalizeStageId(String(patch.stageId).trim())
      : normalizeStageId(lead.stageId),
    updatedAt: now,
    lastTouchedAt: now,
  };

  const events: ActivityEvent[] = [];

  if (next.stageId !== lead.stageId) {
    events.push({
      id: newId(),
      workspaceId: lead.workspaceId,
      leadId: lead.id,
      type: "MOVED_STAGE",
      fromStageId: lead.stageId,
      toStageId: next.stageId,
      at: now,
      day: toDayKey(now),
    });
  }

  if (next.notes !== lead.notes) {
    events.push({
      id: newId(),
      workspaceId: lead.workspaceId,
      leadId: lead.id,
      type: "NOTE_UPDATED",
      at: now,
      day: toDayKey(now),
    });
  }

  if (next.priority !== lead.priority) {
    events.push({
      id: newId(),
      workspaceId: lead.workspaceId,
      leadId: lead.id,
      type: "PRIORITY_CHANGED",
      at: now,
      day: toDayKey(now),
    });
  }

  // Patch só com colunas que efetivamente podem mudar — evita reescrever
  // username/usernameLower/createdAt sem motivo.
  const dbPatch: Record<string, unknown> = {
    updated_at: next.updatedAt,
    last_touched_at: next.lastTouchedAt,
  };
  if (next.board !== lead.board) dbPatch.board = next.board;
  if (next.stageId !== lead.stageId) dbPatch.stage_id = next.stageId;
  if (next.notes !== lead.notes) dbPatch.notes = next.notes;
  if (next.tags !== lead.tags) dbPatch.tags = next.tags ?? [];
  if (next.priority !== lead.priority) dbPatch.priority = next.priority;
  if (next.displayName !== lead.displayName) dbPatch.display_name = next.displayName ?? null;
  if (next.avatarUrl !== lead.avatarUrl) dbPatch.avatar_url = next.avatarUrl ?? null;
  if (next.nextFollowUpAt !== lead.nextFollowUpAt)
    dbPatch.next_follow_up_at = next.nextFollowUpAt ?? null;
  if (next.ctaUrl !== lead.ctaUrl) dbPatch.cta_url = next.ctaUrl ?? null;
  if (next.ctaAt !== lead.ctaAt) dbPatch.cta_at = next.ctaAt ?? null;
  if (next.ctaNote !== lead.ctaNote) dbPatch.cta_note = next.ctaNote ?? null;

  const { error: updErr } = await supabase.from("leads").update(dbPatch).eq("id", lead.id);
  if (updErr) throw updErr;

  if (events.length) {
    const { error: evErr } = await supabase
      .from("activity_events")
      .insert(events.map(eventToRow));
    if (evErr) console.warn("[CRM IGNIS] Falha ao gravar activity_events:", evErr);
  }

  await broadcastDbUpdated("updateLead", next.id);
  return next;
}

export async function moveLeadStage(input: {
  workspaceId: string;
  leadId: string;
  toStageId: string;
}) {
  return updateLead({
    workspaceId: input.workspaceId,
    leadId: input.leadId,
    patch: { stageId: normalizeStageId(String(input.toStageId || "")) },
  });
}

export async function registerCtaAndMove(input: {
  workspaceId: string;
  leadId: string;
  ctaUrl: string;
  ctaNote?: string;
  toStageId?: StageId;
}): Promise<{ lead: Lead; wasFirstCta: boolean } | null> {
  const lead = await getLeadById(input.leadId);
  if (!lead) return null;
  if (lead.workspaceId !== input.workspaceId) return null;

  const wasFirstCta = !lead.ctaAt;
  const toStageId = input.toStageId ?? "CTA_REALIZADO";

  const next = await updateLead({
    workspaceId: input.workspaceId,
    leadId: input.leadId,
    patch: {
      ctaUrl: String(input.ctaUrl || "").trim(),
      ctaAt: Date.now(),
      ctaNote: String(input.ctaNote || ""),
      stageId: toStageId,
    },
  });

  if (!next) return null;
  return { lead: next, wasFirstCta };
}

export async function deleteLead(input: { workspaceId: string; leadId: string }) {
  const lead = await getLeadById(input.leadId);
  if (!lead) return;
  if (lead.workspaceId !== input.workspaceId) return;

  const { error } = await supabase
    .from("leads")
    .update({ deleted_at: Date.now() })
    .eq("id", input.leadId);
  if (error) throw error;

  await broadcastDbUpdated("deleteLead", input.leadId);
}

export async function restoreLead(input: { workspaceId: string; leadId: string }) {
  const lead = await getLeadById(input.leadId);
  if (!lead) return;
  if (lead.workspaceId !== input.workspaceId) return;

  const now = Date.now();
  const { error } = await supabase
    .from("leads")
    .update({
      deleted_at: null,
      stage_id: normalizeStageId("LEADS_NOVOS"),
      updated_at: now,
      last_touched_at: now,
    })
    .eq("id", input.leadId);
  if (error) throw error;

  await broadcastDbUpdated("restoreLead", input.leadId);
}

export async function listDeletedLeads(input: { workspaceId: string }): Promise<Lead[]> {
  if (!input.workspaceId) throw new Error("workspaceId obrigatório");

  const { data, error } = await supabase
    .from("leads")
    .select("*")
    .eq("workspace_id", input.workspaceId)
    .not("deleted_at", "is", null)
    .order("deleted_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map((r) => rowToLead(r as LeadRow));
}
