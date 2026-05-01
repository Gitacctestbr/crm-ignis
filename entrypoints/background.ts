import { defineBackground } from "#imports";

function normalizeUsername(u: string) {
  return String(u || "").trim().replace(/^@+/, "").toLowerCase();
}

async function broadcastToast(message: string) {
  try {
    await chrome.runtime.sendMessage({ type: "CRM_IGNIS_TOAST", message });
  } catch {
    // ignore
  }
}

async function broadcastDbUpdated(payload?: any) {
  try {
    await chrome.runtime.sendMessage({ type: "CRM_IGNIS_DB_UPDATED", payload: payload ?? null });
  } catch {
    // ignore
  }
}

export default defineBackground(() => {
  chrome.runtime.onMessage.addListener((message: any, _sender, sendResponse) => {
    // === CAPTURA LEAD ===
    if (message?.type === "CRM_IGNIS_CAPTURE") {
      const { board, stageId, username, displayName } = message.payload || {};

      (async () => {
        const repo = await import("../src/db/leadsRepo");

        // 1. Escrita no banco — deve ser o primeiro await
        const result = await repo.addLead({
          workspaceId: "default",
          board: board || "OUTBOUND",
          stageId: stageId || "LEADS_NOVOS",
          username: normalizeUsername(username || ""),
          displayName: displayName || undefined,
        });

        // 2. Broadcast — só depois do commit no IndexedDB
        await broadcastToast(result.status === "created" ? "✅ Lead capturado!" : "⚠️ Lead já existia.");
        await broadcastDbUpdated({ reason: "capture", leadId: result.lead.id });

        // 3. sendResponse — último passo, garante que o cliente só recebe a
        //    confirmação após broadcast estar resolvido.
        //    leadId exposto no topo para acesso direto sem navegar em result.lead.
        sendResponse({ ok: true, result, leadId: result.lead.id });
      })().catch((err) => {
        console.error(err);
        sendResponse({ ok: false, error: String(err) });
      });

      return true;
    }

    // === DM SMART: buscar lead por username (NÃO cria lead) ===
    if (message?.type === "CRM_IGNIS_DM_SMART_GET_LEAD") {
      (async () => {
        const { workspaceId, username } = message.payload || {};
        const repo = await import("../src/db/leadsRepo");

        const lead = await repo.getLeadByUsername({
          workspaceId: workspaceId || "default",
          username: normalizeUsername(username || ""),
        });

        if (!lead) {
          sendResponse({
            ok: false,
            reason: "Lead não existe no CRM. Capture primeiro (Outbound/Social) e tente novamente.",
          });
          return;
        }

        sendResponse({
          ok: true,
          lead: {
            id: lead.id,
            username: lead.username,
            displayName: lead.displayName || "",
            stageId: lead.stageId,
            notes: lead.notes || "",
            board: lead.board,
            nextFollowUpAt: lead.nextFollowUpAt,
          },
        });
      })().catch((err) => {
        console.error(err);
        sendResponse({ ok: false, reason: String(err) });
      });

      return true;
    }

    // === DM SMART: buscar leads por nome/username (substring) ===
    if (message?.type === "CRM_IGNIS_SEARCH_LEADS") {
      (async () => {
        const { workspaceId, query, limit } = message.payload || {};
        const repo = await import("../src/db/leadsRepo");

        const items = await repo.searchLeads({
          workspaceId: workspaceId || "default",
          query: String(query || ""),
          limit: typeof limit === "number" ? limit : 10,
        });

        sendResponse({
          ok: true,
          leads: items.map((l) => ({
            id: l.id,
            username: l.username,
            displayName: l.displayName || "",
            stageId: l.stageId,
            board: l.board,
          })),
        });
      })().catch((err) => {
        console.error(err);
        sendResponse({ ok: false, reason: String(err) });
      });

      return true;
    }

    // === DM SMART: leads movimentados recentemente ===
    if (message?.type === "CRM_IGNIS_RECENT_LEADS") {
      (async () => {
        const { workspaceId, limit } = message.payload || {};
        const repo = await import("../src/db/leadsRepo");

        const items = await repo.listRecentlyUpdatedLeads({
          workspaceId: workspaceId || "default",
          limit: typeof limit === "number" ? limit : 5,
        });

        sendResponse({
          ok: true,
          leads: items.map((l) => ({
            id: l.id,
            username: l.username,
            displayName: l.displayName || "",
            stageId: l.stageId,
            board: l.board,
          })),
        });
      })().catch((err) => {
        console.error(err);
        sendResponse({ ok: false, reason: String(err) });
      });

      return true;
    }

    // === DM SMART: salvar alterações ===
    if (message?.type === "CRM_IGNIS_DM_SMART_SAVE") {
      (async () => {
        const { workspaceId, leadId, patch } = message.payload || {};
        const repo = await import("../src/db/leadsRepo");

        if (!leadId || !patch || typeof patch !== "object") {
          sendResponse({ ok: false, reason: "Payload inválido." });
          return;
        }

        // 1. Escrita no banco
        await repo.updateLead({
          workspaceId: workspaceId || "default",
          leadId,
          patch: {
            stageId: patch.stageId,
            notes: typeof patch.notes === "string" ? patch.notes : undefined,
            nextFollowUpAt: typeof patch.nextFollowUpAt === "number" ? patch.nextFollowUpAt : undefined,
          },
        });

        // 2. Broadcast — só depois do commit no IndexedDB
        await broadcastDbUpdated({ reason: "dm_smart_save", leadId });

        // 3. sendResponse — cliente recebe confirmação apenas após broadcast resolvido
        sendResponse({ ok: true });
      })().catch((err) => {
        console.error(err);
        sendResponse({ ok: false, reason: String(err) });
      });

      return true;
    }

    return false;
  });
});
