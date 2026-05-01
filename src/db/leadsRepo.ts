import Dexie from "dexie";
import { db, Lead, ActivityEvent, BoardType, toDayKey } from "./db";
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

/**
 * Notifica todos os contextos da extensão que algo mudou no banco.
 *
 * O Painel Flutuante (DmLeadPanel) vive injetado em instagram.com via content
 * script — ele só recebe mensagens enviadas com `chrome.tabs.sendMessage`.
 * Já as páginas da extensão (Dashboard, SidePanel, Popup) só recebem via
 * `chrome.runtime.sendMessage`. Por isso este helper dispara nos dois canais.
 *
 * Por design, é "fire and forget": uma falha de entrega NUNCA deve reverter
 * a escrita que acabou de commitar no IndexedDB. Ausência de listener é o
 * caso normal (nenhuma aba aberta) e gera uma rejeição silenciosa esperada.
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

  // canonicalUsername é a única fonte de verdade — nunca diverge entre
  // gravação e leitura, mesmo que o chamador passe "@Johndoe" ou "JohnDoe".
  const usernameLower = canonicalUsername(input.username);
  const stageId = normalizeStageId((input.stageId && String(input.stageId).trim()) || "LEADS_NOVOS");

  if (!input.workspaceId) throw new Error("workspaceId obrigatório");
  if (!usernameLower) throw new Error("username obrigatório");
  if (input.board !== "OUTBOUND" && input.board !== "SOCIAL") throw new Error("board inválido");

  const cleanAvatar =
    typeof input.avatarUrl === "string" && input.avatarUrl.startsWith("http")
      ? input.avatarUrl
      : undefined;

  // Proteção contra duplicatas: busca defensiva em memória para tolerar índice
  // físico sujo (dados legados com '@' ou maiúsculas no usernameLower).
  const all = await db.leads.where("workspaceId").equals(input.workspaceId).toArray();
  const existing = all.find(
    (l) => canonicalUsername(String(l.usernameLower || l.username || "")) === usernameLower,
  );

  if (existing) {
    // Se já existe e não tem foto, mas agora temos, atualiza silenciosamente
    if (!existing.avatarUrl && cleanAvatar) {
      await db.leads.update(existing.id, {
        avatarUrl: cleanAvatar,
        updatedAt: now,
        lastTouchedAt: now,
      });
      const refreshed = await db.leads.get(existing.id);
      await broadcastDbUpdated("addLead:avatar_backfill", existing.id);
      return { status: "exists", lead: refreshed ?? existing };
    }

    return { status: "exists", lead: existing };
  }

  const lead: Lead = {
    id: newId(),
    workspaceId: input.workspaceId,

    board: input.board,
    stageId,

    // username e usernameLower derivados da mesma função canônica para
    // garantir que o índice composto seja sempre consultável.
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

  await db.transaction("rw", db.leads, db.events, async () => {
    await db.leads.add(lead);
    await db.events.add(event);
  });

  await broadcastDbUpdated("addLead:created", lead.id);
  return { status: "created", lead };
}

export async function getLeadByUsername(input: { workspaceId: string; username: string }) {
  const usernameLower = canonicalUsername(input.username);
  if (!input.workspaceId) throw new Error("workspaceId obrigatório");
  if (!usernameLower) return null;

  const all = await db.leads.where("workspaceId").equals(input.workspaceId).toArray();
  return (
    all.find(
      (l) => canonicalUsername(String(l.usernameLower || l.username || "")) === usernameLower,
    ) ?? null
  );
}

/**
 * Busca leads por substring em username ou displayName (case-insensitive).
 * Usado pelo DmLeadPanel para encontrar manualmente o contato da conversa.
 *
 * Não há índice full-text no Dexie — para a escala dessa extensão (single user,
 * tipicamente centenas de leads), filtrar em memória após restringir por
 * workspaceId é mais rápido que múltiplos índices e mantém o schema simples.
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

  const all = await db.leads.where("workspaceId").equals(input.workspaceId).toArray();

  const matched = all.filter((l) => {
    // canonicalUsername no campo também cobre dados legados com @ ou maiúsculas
    const u = canonicalUsername(String(l.usernameLower || l.username || ""));
    const d = String(l.displayName || "").toLowerCase();
    return u.includes(q) || d.includes(q);
  });

  matched.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return matched.slice(0, limit);
}

/**
 * Retorna os N leads mais recentemente atualizados do workspace.
 * Usado pelo DmLeadPanel para mostrar atalhos rápidos quando o usuário abre o painel.
 */
export async function listRecentlyUpdatedLeads(input: {
  workspaceId: string;
  limit?: number;
}): Promise<Lead[]> {
  if (!input.workspaceId) throw new Error("workspaceId obrigatório");
  const limit = Math.max(1, Math.min(50, input.limit ?? 5));

  const items = await db.leads.where("workspaceId").equals(input.workspaceId).toArray();
  items.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return items.slice(0, limit);
}

export async function listLeadsByBoard(workspaceId: string, board: BoardType) {
  const items = await db.leads
    .where("[workspaceId+board+stageId]")
    .between([workspaceId, board, Dexie.minKey], [workspaceId, board, Dexie.maxKey])
    .toArray();

  items.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return items;
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
  const lead = await db.leads.get(input.leadId);
  if (!lead) return null;
  if (lead.workspaceId !== input.workspaceId) return null;

  const now = Date.now();
  const patch = { ...input.patch };

  const next: Lead = {
    ...lead,
    ...patch,
    stageId: patch.stageId ? normalizeStageId(String(patch.stageId).trim()) : normalizeStageId(lead.stageId),
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

  await db.transaction("rw", db.leads, db.events, async () => {
    await db.leads.put(next);
    if (events.length) await db.events.bulkAdd(events);
  });

  await broadcastDbUpdated("updateLead", next.id);
  return next;
}

export async function moveLeadStage(input: { workspaceId: string; leadId: string; toStageId: string }) {
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
  const lead = await db.leads.get(input.leadId);
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
  const lead = await db.leads.get(input.leadId);
  if (!lead) return;
  if (lead.workspaceId !== input.workspaceId) return;

  await db.transaction("rw", db.leads, db.tasks, db.events, async () => {
    await db.tasks.where("[workspaceId+leadId]").equals([input.workspaceId, input.leadId]).delete();
    await db.events.where("[workspaceId+leadId]").equals([input.workspaceId, input.leadId]).delete();
    await db.leads.delete(input.leadId);
  });

  await broadcastDbUpdated("deleteLead", input.leadId);
}
