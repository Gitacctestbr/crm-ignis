import React from "react";
import type { BoardType } from "../../src/db/db";
import { addLead, deleteLead, listDeletedLeads, listLeadsByBoard, moveLeadStage, restoreLead, updateLead } from "../../src/db/leadsRepo";
import { backfillMissingAvatars, type BackfillProgress } from "../../src/db/avatarBackfill";
import { BackupRestorePanel } from "../../src/ui/BackupRestorePanel";
import { LeadAvatar } from "../../src/ui/LeadAvatar";
import { STAGES as CRM_STAGES, normalizeStageId, stageLabel } from "../../src/crm/stages";
import { useAuth } from "../../src/auth/AuthContext";
import { useReactiveQuery } from "../../src/utils/useReactiveQuery";

const STAGES = CRM_STAGES;

type Toast = { id: string; message: string; kind: "ok" | "warn" | "error" };
function newId() {
  return crypto.randomUUID();
}

function openInstagramProfile(username: string) {
  const u = String(username || "").replace(/^@+/, "").trim();
  const url = `https://www.instagram.com/${u}/`;
  try {
    chrome.tabs.create({ url });
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

function toLocalDayRange(dateStr: string): { start: number; end: number } | null {
  if (!dateStr) return null;
  const [y, m, d] = dateStr.split("-").map((x) => Number(x));
  if (!y || !m || !d) return null;

  // ⚠️ Montar manualmente evita bug de fuso (Date("YYYY-MM-DD") vira UTC)
  const start = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
  const end = new Date(y, m - 1, d + 1, 0, 0, 0, 0).getTime();
  return { start, end };
}

function todayAsInputDate(): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export default function App() {
  const { user } = useAuth();
  const WORKSPACE_ID = user?.id ?? "";
  const [board, setBoard] = React.useState<BoardType>("OUTBOUND");
  const [search, setSearch] = React.useState("");
  const [dayFilter, setDayFilter] = React.useState<string>("");
  const [toast, setToast] = React.useState<Toast | null>(null);
  const [showBackup, setShowBackup] = React.useState(false);
  const [backfill, setBackfill] = React.useState<BackfillProgress | null>(null);
  const backfillCancelRef = React.useRef(false);
  const csvInputRef = React.useRef<HTMLInputElement>(null);
  const [importing, setImporting] = React.useState(false);
  const [syncing, setSyncing] = React.useState(false);
  const [showTrash, setShowTrash] = React.useState(false);

  const showToast = React.useCallback((message: string, kind: Toast["kind"] = "ok") => {
    const t = { id: newId(), message, kind };
    setToast(t);
    window.setTimeout(() => setToast((cur) => (cur?.id === t.id ? null : cur)), 2500);
  }, []);

  // ─── Leads reativos (Supabase → UI auto-refresh via broadcast) ──────────────
  // useReactiveQuery roda a query e re-executa quando qualquer repo dispara
  // CRM_IGNIS_DB_UPDATED após uma escrita. Mesma UX que tínhamos com
  // useLiveQuery do Dexie, sem precisar de Realtime do Supabase.
  const leadsQuery = useReactiveQuery(
    () => (WORKSPACE_ID ? listLeadsByBoard(WORKSPACE_ID, board) : Promise.resolve([])),
    [board, WORKSPACE_ID],
  );
  // data é `undefined` enquanto a query ainda não retornou. Usar [] evita
  // flicker de "coluna vazia" perceptível.
  const leads = leadsQuery.data ?? [];

  const dayRange = React.useMemo(() => toLocalDayRange(dayFilter), [dayFilter]);

  const filtered = React.useMemo(() => {
    let base = leads;

    if (dayRange) {
      base = base.filter((l) => {
        const createdAt = Number(l?.createdAt ?? 0);
        return createdAt >= dayRange.start && createdAt < dayRange.end;
      });
    }

    const q = search.trim().toLowerCase();
    if (!q) return base;
    return base.filter(
      (l) =>
        String(l.username || "").toLowerCase().includes(q) ||
        String(l.displayName || "").toLowerCase().includes(q),
    );
  }, [leads, search, dayRange]);

  const byStage = React.useMemo(() => {
    const map = new Map<string, any[]>();
    for (const s of STAGES) map.set(s.id, []);

    for (const l of filtered) {
      const sid = normalizeStageId(String(l.stageId || ""));
      map.get(sid)!.push(l);
    }
    return map;
  }, [filtered]);

  const dayLabel = React.useMemo(() => {
    if (!dayRange) return null;
    try {
      return new Date(dayRange.start).toLocaleDateString("pt-BR");
    } catch {
      return dayFilter;
    }
  }, [dayFilter, dayRange]);

  // ─── Handlers ───────────────────────────────────────────────────────────────

  async function onDropLead(leadId: string, toStageId: string) {
    try {
      const result = await moveLeadStage({ workspaceId: WORKSPACE_ID, leadId, toStageId });
      if (!result) {
        // Lead não encontrado no banco: DB inalterado → useLiveQuery mantém
        // o card na coluna original automaticamente (sem revert manual).
        showToast("Lead não encontrado no banco. O card voltou à posição original.", "error");
        return;
      }
      // useLiveQuery detecta a escrita e re-renderiza o Kanban automaticamente.
      // Nenhum reload() manual necessário.
    } catch (e: any) {
      console.error("[onDropLead]", e);
      showToast(e?.message || "Erro ao mover lead", "error");
    }
  }

  async function onDeleteLead(leadId: string, username: string) {
    try {
      await deleteLead({ workspaceId: WORKSPACE_ID, leadId });
      showToast(`🗑️ Removido: @${username}`, "warn");
      // useLiveQuery detecta a exclusão automaticamente.
    } catch (e: any) {
      console.error(e);
      showToast(e?.message || "Erro ao remover lead", "error");
    }
  }

  async function runAvatarBackfill() {
    if (backfill) {
      // Botão clicado de novo → cancela
      backfillCancelRef.current = true;
      return;
    }
    backfillCancelRef.current = false;
    setBackfill({ done: 0, total: 0, updated: 0, skipped: 0 });
    try {
      const result = await backfillMissingAvatars({
        workspaceId: WORKSPACE_ID,
        onProgress: (p) => setBackfill(p),
        shouldCancel: () => backfillCancelRef.current,
      });
      if (result.cancelled) {
        showToast(`Backfill cancelado. Atualizados: ${result.updated}`, "warn");
      } else if (result.total === 0) {
        showToast("Todos os leads já têm foto.", "ok");
      } else if (result.updated === 0) {
        showToast(
          "Nenhum avatar capturado. Abra uma aba do Instagram e tente de novo.",
          "warn",
        );
      } else {
        showToast(`✅ ${result.updated} avatar(es) atualizado(s).`, "ok");
      }
    } catch (e: any) {
      console.error(e);
      showToast(e?.message || "Erro no backfill", "error");
    } finally {
      setBackfill(null);
      backfillCancelRef.current = false;
    }
  }

  // ─── Sync via Google Sheets URL ─────────────────────────────────────────────

  async function handleForceSync() {
    setSyncing(true);
    try {
      const resp = await new Promise<any>((resolve) => {
        try {
          chrome.runtime.sendMessage({ type: "CRM_IGNIS_FORCE_SYNC" }, (r) => {
            const err = chrome.runtime.lastError;
            if (err) { resolve({ ok: false, error: err.message }); return; }
            resolve(r ?? { ok: false, error: "Sem resposta do background" });
          });
        } catch (e) {
          resolve({ ok: false, error: String(e) });
        }
      });
      if (!resp.ok) {
        showToast(`Erro ao sincronizar: ${resp.error}`, "error");
      } else {
        const { created, skipped, errors } = resp as { created: number; skipped: number; errors: number };
        showToast(
          `Sincronizado: ${created} novo(s), ${skipped} já existia(m)${errors ? `, ${errors} ignorado(s)` : ""}.`,
          errors && created === 0 ? "error" : errors ? "warn" : "ok",
        );
      }
    } catch (e: any) {
      showToast(e?.message || "Erro na sincronização", "error");
    } finally {
      setSyncing(false);
    }
  }

  // ─── CSV Import ─────────────────────────────────────────────────────────────

  function parseSimpleCsv(text: string): string[][] {
    const result: string[][] = [];
    let cur = "";
    let inQuotes = false;
    let row: string[] = [];

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      const next = text[i + 1];

      if (inQuotes) {
        if (ch === '"' && next === '"') {
          cur += '"';
          i++;
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          cur += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === ",") {
          row.push(cur.trim());
          cur = "";
        } else if (ch === "\n" || (ch === "\r" && next === "\n")) {
          if (ch === "\r") i++;
          row.push(cur.trim());
          if (row.some((f) => f)) result.push(row);
          row = [];
          cur = "";
        } else if (ch === "\r") {
          row.push(cur.trim());
          if (row.some((f) => f)) result.push(row);
          row = [];
          cur = "";
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
    } catch {
      /* fallback para regex */
    }
    const m = s.match(/instagram\.com\/([^/?#\s]+)/);
    return m?.[1] || null;
  }

  async function handleCsvImport(file: File) {
    setImporting(true);
    let created = 0;
    let skipped = 0;
    let errors = 0;

    try {
      const text = await file.text();
      const rows = parseSimpleCsv(text);

      // Pula a primeira linha se não contiver um link do Instagram (é cabeçalho)
      const firstCell = String(rows[0]?.[0] ?? "").toLowerCase();
      const dataRows = firstCell.includes("instagram.com") || firstCell.startsWith("http")
        ? rows
        : rows.slice(1);

      for (const row of dataRows) {
        const [linkCol, nome, bio, seguidores, seguindo] = row;
        const username = extractUsernameFromLink(linkCol ?? "");
        if (!username) {
          errors++;
          continue;
        }

        const noteParts = [
          bio ? `Bio: ${bio}` : "",
          seguidores ? `Seguidores: ${seguidores}` : "",
          seguindo ? `Seguindo: ${seguindo}` : "",
        ].filter(Boolean);
        const notes = noteParts.join("\n");

        try {
          const result = await addLead({
            workspaceId: WORKSPACE_ID,
            board: "OUTBOUND",
            stageId: "LEADS_NOVOS",
            username,
            displayName: nome?.trim() || undefined,
          });

          if (result.status === "created" && notes) {
            await updateLead({
              workspaceId: WORKSPACE_ID,
              leadId: result.lead.id,
              patch: { notes },
            });
          }

          result.status === "created" ? created++ : skipped++;
        } catch {
          errors++;
        }
      }

      const msg = `Importados: ${created} novo(s), ${skipped} já existia(m)${errors ? `, ${errors} ignorado(s)` : ""}.`;
      showToast(msg, errors && created === 0 ? "error" : errors ? "warn" : "ok");
    } catch (e: any) {
      console.error("[handleCsvImport]", e);
      showToast(e?.message || "Erro ao ler o CSV", "error");
    } finally {
      setImporting(false);
      // Limpa o input para permitir reimportar o mesmo arquivo
      if (csvInputRef.current) csvInputRef.current.value = "";
    }
  }

  return (
    <div className="min-h-screen bg-[rgb(var(--bg))] text-[rgb(var(--text))]">
      {/* ── Topbar ── */}
      <div className="sticky top-0 z-10 border-b border-[rgb(var(--border))]/60 bg-[rgb(var(--bg))]/90 backdrop-blur-md">
        <div className="w-full px-4 py-3 flex items-center gap-3 flex-wrap">
          <div className="font-black tracking-tight text-base">
            <span className="text-[rgb(var(--accent))]">IGNIS</span>
            <span className="text-[rgb(var(--muted))]/60 font-normal mx-1">•</span>
            <span className="font-normal text-sm text-[rgb(var(--muted))]">Kanban</span>
          </div>

          <div className="flex items-center gap-1.5 ml-2">
            {(["OUTBOUND", "SOCIAL"] as BoardType[]).map((b) => (
              <button
                key={b}
                className={
                  "text-xs px-3 py-1.5 rounded-[var(--radius)] border transition-all duration-200 " +
                  (board === b
                    ? "border-[rgba(234,124,48,0.5)] bg-[rgba(234,124,48,0.1)] text-[rgb(var(--accent))] font-semibold shadow-[0_0_12px_rgba(234,124,48,0.15)]"
                    : "border-[rgb(var(--border))] text-[rgb(var(--muted))] hover:border-[rgba(234,124,48,0.3)] hover:text-[rgb(var(--text))] hover:bg-white/5")
                }
                onClick={() => setBoard(b)}
              >
                {b === "OUTBOUND" ? "Outbound" : "Social Selling"}
              </button>
            ))}
          </div>

          <div className="flex-1" />

          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar @username…"
            className="text-xs w-[220px] max-w-[40vw] px-3 py-1.5 rounded-[var(--radius)] bg-white/5 border border-[rgb(var(--border))] outline-none focus:border-[rgb(var(--accent))] focus:shadow-[0_0_0_2px_rgba(234,124,48,0.1)] transition-all placeholder:text-[rgb(var(--muted))]/50"
          />

          <input
            type="date"
            value={dayFilter}
            onChange={(e) => setDayFilter(e.target.value)}
            title="Mostra somente leads adicionados no dia selecionado"
            className="text-xs w-[150px] max-w-[35vw] px-3 py-1.5 rounded-[var(--radius)] bg-white/5 border border-[rgb(var(--border))] outline-none focus:border-[rgb(var(--accent))] transition-all"
          />

          <button
            className="text-xs px-3 py-1.5 rounded-[var(--radius)] border border-[rgb(var(--border))] hover:border-[rgba(234,124,48,0.35)] hover:bg-white/5 transition-all"
            onClick={() => setDayFilter(todayAsInputDate())}
            title="Filtrar por hoje"
          >
            Hoje
          </button>

          {dayFilter ? (
            <button
              className="text-xs px-3 py-1.5 rounded-[var(--radius)] border border-[rgb(var(--border))] hover:bg-white/5 transition-all"
              onClick={() => setDayFilter("")}
              title="Remover filtro de dia"
            >
              Limpar
            </button>
          ) : null}

          <button
            className="text-xs px-3 py-1.5 rounded-[var(--radius)] border border-[rgb(var(--border))] hover:border-[rgba(234,124,48,0.35)] hover:bg-white/5 transition-all"
            onClick={() => void runAvatarBackfill()}
            title={
              backfill
                ? "Clique para cancelar"
                : "Busca foto de perfil para leads que ainda não têm. Precisa de uma aba do Instagram aberta."
            }
          >
            {backfill
              ? `Atualizando fotos… ${backfill.done}/${backfill.total} (${backfill.updated} ok)`
              : "Atualizar fotos"}
          </button>

          <button
            className="text-xs px-3 py-1.5 rounded-[var(--radius)] border border-[rgb(var(--border))] hover:border-[rgba(234,124,48,0.35)] hover:bg-white/5 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={() => void handleForceSync()}
            disabled={syncing || importing}
            title="Busca o CSV da URL configurada nas Settings e importa leads novos automaticamente (roda também a cada 30 min)."
          >
            {syncing ? "Sincronizando…" : "Sincronizar Leads Drive"}
          </button>

          <button
            className="text-xs px-3 py-1.5 rounded-[var(--radius)] border border-[rgb(var(--border))] hover:border-red-500/30 hover:bg-red-500/5 hover:text-red-300 transition-all"
            onClick={() => setShowTrash((v) => !v)}
            title="Ver leads removidos (Lixeira)"
          >
            🗑 Lixeira
          </button>

          <button
            className="text-xs px-3 py-1.5 rounded-[var(--radius)] border border-[rgb(var(--border))] hover:border-[rgba(234,124,48,0.35)] hover:bg-white/5 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={() => csvInputRef.current?.click()}
            disabled={importing}
            title="Importa um CSV exportado manualmente da planilha Google Sheets (colunas: Link, Nome, Bio, Seguidores, Seguindo)"
          >
            {importing ? "Importando…" : "Importar CSV Manual"}
          </button>
          <input
            ref={csvInputRef}
            type="file"
            accept=".csv"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleCsvImport(file);
            }}
          />

          <button
            className="text-xs px-3 py-1.5 rounded-[var(--radius)] border border-[rgb(var(--border))] hover:bg-white/5 transition-all"
            onClick={() => setShowBackup((v) => !v)}
            title="Abrir/Fechar Backup"
          >
            {showBackup ? "Fechar Backup" : "Backup/Restore"}
          </button>
        </div>

        {dayLabel ? (
          <div className="px-4 pb-2 -mt-1 text-[11px] text-[rgb(var(--muted))]">
            Leads de <span className="font-bold text-[rgb(var(--text))]">{dayLabel}</span>
          </div>
        ) : null}
      </div>

      {/* ── Board ── */}
      <div className="w-full px-4 py-5">
        {showBackup ? (
          <div className="mb-5">
            <BackupRestorePanel />
          </div>
        ) : null}

        <div className="overflow-x-auto">
          <div className="flex gap-3 pb-4 min-w-max">
            {STAGES.map((stage) => (
              <KanbanColumn
                key={stage.id}
                stageId={stage.id}
                title={stage.label}
                items={byStage.get(stage.id) ?? []}
                onDropLead={onDropLead}
                onDeleteLead={onDeleteLead}
                onUpdateNotes={async (leadId, notes) => {
                  try {
                    await updateLead({ workspaceId: WORKSPACE_ID, leadId, patch: { notes } });
                  } catch (e) {
                    console.error("[onUpdateNotes]", e);
                  }
                }}
              />
            ))}
          </div>
        </div>

        <div className="text-[11px] text-[rgb(var(--muted))]/60 mt-1">
          Arraste o card para outra coluna para mover o estágio.
        </div>
      </div>

      {/* ── Lixeira Modal ── */}
      {showTrash ? (
        <TrashModal
          workspaceId={WORKSPACE_ID}
          onClose={() => setShowTrash(false)}
          onToast={showToast}
        />
      ) : null}

      {/* ── Toast ── */}
      {toast ? (
        <div className="fixed right-4 bottom-4 z-50">
          <div
            className={
              "text-xs font-semibold px-4 py-2.5 rounded-[var(--radius)] border shadow-[var(--shadow-md)] backdrop-blur-md " +
              (toast.kind === "error"
                ? "bg-red-500/15 border-red-500/25 text-red-200"
                : toast.kind === "warn"
                  ? "bg-yellow-500/10 border-yellow-500/20 text-yellow-200"
                  : "bg-emerald-500/10 border-emerald-500/20 text-emerald-200")
            }
          >
            {toast.message}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function KanbanColumn(props: {
  stageId: string;
  title: string;
  items: any[];
  onDropLead: (leadId: string, toStageId: string) => Promise<void>;
  onDeleteLead: (leadId: string, username: string) => Promise<void>;
  onUpdateNotes: (leadId: string, notes: string) => Promise<void>;
}) {
  function onDragOver(e: React.DragEvent) {
    e.preventDefault();
  }

  // Sem `void` — a Promise é tratada explicitamente com .catch() para garantir
  // que erros não escapem silenciosamente. onDropLead já tem try/catch interno
  // com feedback de toast; este .catch() captura qualquer throw inesperado.
  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    const leadId = e.dataTransfer.getData("text/leadId");
    if (!leadId) return;
    props.onDropLead(leadId, props.stageId).catch((err) => {
      console.error("[KanbanColumn] Erro inesperado no drop handler:", err);
    });
  }

  return (
    <div
      className="w-[280px] shrink-0 rounded-[var(--radius)] bg-[rgb(var(--panel))]/60 backdrop-blur-sm border border-[rgb(var(--border))]/80 shadow-[var(--shadow-sm)] flex flex-col"
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {/* Column header */}
      <div className="px-3 py-2.5 border-b border-[rgb(var(--border))]/60 flex items-center gap-2">
        <div className="w-[3px] h-3.5 rounded-full bg-[rgba(234,124,48,0.55)] shrink-0" />
        <div className="text-[11px] font-bold flex-1 truncate">{props.title}</div>
        <div className="text-[10px] tabular-nums px-1.5 py-0.5 rounded-full bg-white/5 border border-[rgb(var(--border))]/60 text-[rgb(var(--muted))]">
          {props.items.length}
        </div>
      </div>

      {/* Cards */}
      <div className="p-2 flex flex-col gap-1.5 min-h-[80px]">
        {props.items.length === 0 ? (
          <div className="text-[10px] text-[rgb(var(--muted))]/40 text-center py-5">
            Solte aqui
          </div>
        ) : null}

        {props.items.map((l) => (
          <LeadCard
            key={l.id}
            lead={l}
            onDelete={() => props.onDeleteLead(l.id, l.username)}
            onUpdateNotes={(notes) => props.onUpdateNotes(l.id, notes)}
          />
        ))}
      </div>
    </div>
  );
}

function TrashModal(props: {
  workspaceId: string;
  onClose: () => void;
  onToast: (msg: string, kind: Toast["kind"]) => void;
}) {
  const deletedQuery = useReactiveQuery(
    () => listDeletedLeads({ workspaceId: props.workspaceId }),
    [props.workspaceId],
  );
  const deleted = deletedQuery.data ?? [];

  async function handleRestore(leadId: string, username: string) {
    try {
      await restoreLead({ workspaceId: props.workspaceId, leadId });
      props.onToast(`✅ @${username} restaurado em Leads Novos`, "ok");
    } catch (e: any) {
      props.onToast(e?.message || "Erro ao restaurar lead", "error");
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) props.onClose(); }}
    >
      <div className="w-full max-w-md mx-4 rounded-[var(--radius)] border border-[rgb(var(--border))] bg-[rgb(var(--bg))] shadow-[var(--shadow-md)] flex flex-col max-h-[80vh]">
        <div className="flex items-center justify-between px-4 py-3 border-b border-[rgb(var(--border))]/60 shrink-0">
          <div className="text-sm font-bold">
            🗑 Lixeira
            <span className="ml-2 text-[11px] font-normal text-[rgb(var(--muted))]">
              ({deleted.length} lead{deleted.length !== 1 ? "s" : ""})
            </span>
          </div>
          <button
            className="text-xs text-[rgb(var(--muted))] hover:text-[rgb(var(--text))] transition-colors"
            onClick={props.onClose}
          >
            ✕ Fechar
          </button>
        </div>
        <div className="p-3 overflow-y-auto flex flex-col gap-1.5">
          {deleted.length === 0 ? (
            <div className="text-xs text-[rgb(var(--muted))]/60 text-center py-10">
              Lixeira vazia
            </div>
          ) : (
            deleted.map((l) => (
              <div
                key={l.id}
                className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg bg-white/[0.03] border border-[rgb(var(--border))]/60"
              >
                <LeadAvatar username={l.username} avatarUrl={l.avatarUrl} size={28} />
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-bold truncate">@{l.username}</div>
                  {l.displayName ? (
                    <div className="text-[10px] text-[rgb(var(--muted))] truncate">{l.displayName}</div>
                  ) : null}
                  <div className="text-[9px] text-[rgb(var(--muted))]/50 mt-0.5">
                    Removido {l.deletedAt ? new Date(l.deletedAt).toLocaleDateString("pt-BR") : ""}
                  </div>
                </div>
                <button
                  className="text-[10px] px-2.5 py-1 rounded border border-[rgb(var(--border))]/60 hover:border-[rgba(234,124,48,0.4)] hover:bg-[rgba(234,124,48,0.05)] transition-all shrink-0"
                  onClick={() => void handleRestore(l.id, l.username)}
                >
                  Restaurar
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function LeadCard(props: {
  lead: any;
  onDelete: () => void;
  onUpdateNotes: (notes: string) => void;
}) {
  const { lead } = props;

  const [notes, setNotes] = React.useState<string>(lead.notes || "");
  const tRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    setNotes(String(lead.notes || ""));
  }, [lead.notes]);

  function scheduleSave(next: string) {
    if (tRef.current) window.clearTimeout(tRef.current);
    tRef.current = window.setTimeout(() => props.onUpdateNotes(next), 400);
  }

  const stage = stageLabel(normalizeStageId(String(lead.stageId || "")));

  return (
    <div
      className="group rounded-[var(--radius)] bg-white/[0.03] border border-[rgb(var(--border))]/80 p-2.5 cursor-grab active:cursor-grabbing transition-all duration-200 hover:border-[rgba(234,124,48,0.45)] hover:bg-white/[0.05] hover:shadow-[0_0_0_1px_rgba(234,124,48,0.08),0_4px_16px_rgba(234,124,48,0.05)]"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/leadId", lead.id);
        e.dataTransfer.effectAllowed = "move";
      }}
    >
      {/* ── 1. Nome / Avatar ── */}
      <div className="flex items-center gap-2">
        <LeadAvatar
          username={lead.username}
          avatarUrl={lead.avatarUrl}
          size={32}
          onClick={() => openInstagramProfile(lead.username)}
          title="Abrir perfil no Instagram"
        />

        <div className="flex-1 min-w-0">
          {/* ── 2. Status / Empresa ── */}
          <a
            className="block text-xs font-bold truncate hover:text-[rgb(var(--accent))] transition-colors"
            href={`https://www.instagram.com/${String(lead.username || "").replace(/^@+/, "").trim()}/`}
            target="_blank"
            rel="noreferrer"
          >
            @{lead.username}
          </a>
          {lead.displayName ? (
            <div className="text-[10px] text-[rgb(var(--muted))] truncate">{lead.displayName}</div>
          ) : null}
          <div className="text-[9px] mt-0.5 inline-flex items-center px-1.5 py-[1px] rounded-full border border-[rgb(var(--border))]/60 text-[rgb(var(--muted))]/70">
            {stage}
          </div>
        </div>

        <button
          className="opacity-0 group-hover:opacity-100 transition-opacity text-[10px] px-1.5 py-1 rounded border border-[rgb(var(--border))]/60 text-[rgb(var(--muted))]/70 hover:border-red-500/40 hover:text-red-400 hover:bg-red-500/10"
          onClick={props.onDelete}
          title="Remover lead"
        >
          ✕
        </button>
      </div>

      {/* ── 3. Próximo passo (nota rápida) ── */}
      <div className="mt-2">
        <textarea
          value={notes}
          onChange={(e) => {
            const v = e.target.value;
            setNotes(v);
            scheduleSave(v);
          }}
          placeholder="Próximo passo…"
          className="w-full text-[11px] min-h-[40px] max-h-[120px] resize-y px-2 py-1.5 rounded-lg bg-[rgb(var(--bg))]/50 border border-[rgb(var(--border))]/50 outline-none focus:border-[rgba(234,124,48,0.4)] transition-colors placeholder:text-[rgb(var(--muted))]/40"
        />
      </div>
    </div>
  );
}
