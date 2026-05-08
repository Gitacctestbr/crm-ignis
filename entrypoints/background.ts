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

// ─── CSV helpers ─────────────────────────────────────────────────────────────

function parseSimpleCsv(text: string): string[][] {
  const result: string[][] = [];
  let cur = "";
  let inQuotes = false;
  let row: string[] = [];

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') { cur += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { cur += ch; }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        row.push(cur.trim()); cur = "";
      } else if (ch === "\n" || (ch === "\r" && next === "\n")) {
        if (ch === "\r") i++;
        row.push(cur.trim());
        if (row.some((f) => f)) result.push(row);
        row = []; cur = "";
      } else if (ch === "\r") {
        row.push(cur.trim());
        if (row.some((f) => f)) result.push(row);
        row = []; cur = "";
      } else {
        cur += ch;
      }
    }
  }
  if (cur || row.length > 0) {
    row.push(cur.trim());
    if (row.some((f) => f)) result.push(row);
  }
  return result;
}

function extractUsernameFromLink(link: string): string | null {
  const s = String(link || "").trim();
  if (!s) return null;
  try {
    const url = new URL(s.startsWith("http") ? s : `https://${s}`);
    if (url.hostname.includes("instagram.com")) {
      const parts = url.pathname.split("/").filter(Boolean);
      return parts[0] || null;
    }
  } catch { /* fallback */ }
  const m = s.match(/instagram\.com\/([^/?#\s]+)/);
  return m?.[1] || null;
}

// ─── Motor de sincronização ───────────────────────────────────────────────────

type SyncResult = { created: number; skipped: number; errors: number };

async function syncLeadsFromSheets(): Promise<SyncResult> {
  const { loadSettings } = await import("../src/settings/extensionSettings");
  const settings = await loadSettings();

  const csvUrl = settings.syncCsvUrl?.trim();
  if (!csvUrl) return { created: 0, skipped: 0, errors: 0 };

  const resp = await fetch(csvUrl);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ao buscar o CSV`);
  const text = await resp.text();

  const rows = parseSimpleCsv(text);
  const firstCell = String(rows[0]?.[0] ?? "").toLowerCase();
  const dataRows =
    firstCell.includes("instagram.com") || firstCell.startsWith("http")
      ? rows
      : rows.slice(1);

  const repo = await import("../src/db/leadsRepo");
  let created = 0;
  let skipped = 0;
  let errors = 0;
  const newLeads: Array<{ id: string; username: string }> = [];

  for (const row of dataRows) {
    const [linkCol, nome, bio, seguidores, seguindo] = row;
    const username = extractUsernameFromLink(linkCol ?? "");
    if (!username) { errors++; continue; }

    const notes = [
      bio ? `Bio: ${bio}` : "",
      seguidores ? `Seguidores: ${seguidores}` : "",
      seguindo ? `Seguindo: ${seguindo}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    try {
      const result = await repo.addLead({
        workspaceId: "default",
        board: "OUTBOUND",
        stageId: "LEADS_NOVOS",
        username: normalizeUsername(username),
        displayName: nome?.trim() || undefined,
      });

      if (result.status === "created") {
        created++;
        if (notes) {
          await repo.updateLead({
            workspaceId: "default",
            leadId: result.lead.id,
            patch: { notes },
          });
        }
        newLeads.push({ id: result.lead.id, username: result.lead.username });
      } else {
        skipped++;
      }
    } catch {
      errors++;
    }
  }

  // Backfill de avatar para os leads recém-criados (fire-and-forget, máx. 20)
  if (newLeads.length > 0) {
    void (async () => {
      try {
        const { fetchAvatarForUsername } = await import("../src/instagram/avatarFetcher");
        const repo2 = await import("../src/db/leadsRepo");
        const cap = newLeads.slice(0, 20);
        for (const lead of cap) {
          try {
            const avatarUrl = await fetchAvatarForUsername(lead.username);
            if (avatarUrl) {
              await repo2.updateLead({
                workspaceId: "default",
                leadId: lead.id,
                patch: { avatarUrl },
              });
            }
          } catch { /* ignora falha individual */ }
          await new Promise<void>((r) => setTimeout(r, 300));
        }
      } catch { /* ignora erros de importação */ }
    })();
  }

  return { created, skipped, errors };
}

export default defineBackground(() => {
  // ─── Auto-sync a cada 30 minutos ─────────────────────────────────────────
  chrome.alarms.create("crm-ignis-auto-sync", { periodInMinutes: 30 });

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== "crm-ignis-auto-sync") return;
    syncLeadsFromSheets()
      .then(({ created }) => {
        if (created > 0) {
          chrome.runtime
            .sendMessage({
              type: "CRM_IGNIS_TOAST",
              message: `Auto-sync: ${created} novo(s) lead(s) importado(s) da planilha.`,
            })
            .catch(() => {});
        }
      })
      .catch(() => {});
  });

  // ─── Message listeners ────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((message: any, _sender, sendResponse) => {
    // === SYNC MANUAL ===
    if (message?.type === "CRM_IGNIS_FORCE_SYNC") {
      syncLeadsFromSheets()
        .then(({ created, skipped, errors }) => {
          sendResponse({ ok: true, created, skipped, errors });
        })
        .catch((err) => {
          sendResponse({ ok: false, error: String(err) });
        });
      return true;
    }

    // === CAPTURA LEAD ===
    if (message?.type === "CRM_IGNIS_CAPTURE") {
      const { board, stageId, username, displayName, avatarUrl } = message.payload || {};

      (async () => {
        const repo = await import("../src/db/leadsRepo");

        const result = await repo.addLead({
          workspaceId: "default",
          board: board || "OUTBOUND",
          stageId: stageId || "LEADS_NOVOS",
          username: normalizeUsername(username || ""),
          displayName: displayName || undefined,
          avatarUrl: typeof avatarUrl === "string" ? avatarUrl : undefined,
        });

        await broadcastToast(result.status === "created" ? "✅ Lead capturado!" : "⚠️ Lead já existia.");
        await broadcastDbUpdated({ reason: "capture", leadId: result.lead.id });

        sendResponse({ ok: true, result, leadId: result.lead.id });
      })().catch((err) => {
        console.error(err);
        sendResponse({ ok: false, error: String(err) });
      });

      return true;
    }

    // === DM SMART: buscar lead por username ===
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
            avatarUrl: lead.avatarUrl ?? null,
          },
        });
      })().catch((err) => {
        console.error(err);
        sendResponse({ ok: false, reason: String(err) });
      });

      return true;
    }

    // === DM SMART: buscar leads por nome/username ===
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
            avatarUrl: l.avatarUrl ?? null,
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
            avatarUrl: l.avatarUrl ?? null,
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

        await repo.updateLead({
          workspaceId: workspaceId || "default",
          leadId,
          patch: {
            stageId: patch.stageId,
            notes: typeof patch.notes === "string" ? patch.notes : undefined,
            nextFollowUpAt: typeof patch.nextFollowUpAt === "number" ? patch.nextFollowUpAt : undefined,
            avatarUrl: typeof patch.avatarUrl === "string" ? patch.avatarUrl : undefined,
          },
        });

        await broadcastDbUpdated({ reason: "dm_smart_save", leadId });

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
