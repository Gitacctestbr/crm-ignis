import React from "react";
import { useLiveQuery } from "dexie-react-hooks";
import type { BoardType } from "../../src/db/db";
import { deleteLead, listLeadsByBoard, moveLeadStage, updateLead } from "../../src/db/leadsRepo";
import { BackupRestorePanel } from "../../src/ui/BackupRestorePanel";
import { STAGES as CRM_STAGES, normalizeStageId, stageLabel } from "../../src/crm/stages";

const WORKSPACE_ID = "default";

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
  const [board, setBoard] = React.useState<BoardType>("OUTBOUND");
  const [search, setSearch] = React.useState("");
  const [dayFilter, setDayFilter] = React.useState<string>("");
  const [toast, setToast] = React.useState<Toast | null>(null);
  const [showBackup, setShowBackup] = React.useState(false);

  const showToast = React.useCallback((message: string, kind: Toast["kind"] = "ok") => {
    const t = { id: newId(), message, kind };
    setToast(t);
    window.setTimeout(() => setToast((cur) => (cur?.id === t.id ? null : cur)), 2500);
  }, []);

  // ─── Leads reativos (Dexie → UI sem polling, sem listeners manuais) ──────────
  // useLiveQuery re-executa a query automaticamente sempre que qualquer linha
  // da tabela `leads` for criada, atualizada ou deletada — em qualquer aba,
  // painel flutuante ou worker que escreva no mesmo banco IndexedDB.
  const rawLeads = useLiveQuery(
    () => listLeadsByBoard(WORKSPACE_ID, board),
    [board],
  );
  // rawLeads é `undefined` enquanto a query ainda não retornou (montagem inicial
  // e troca de board). Usar [] evita flicker de "coluna vazia" perceptível.
  const leads = rawLeads ?? [];

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

  const firstLetter = (String(lead.username || "?")[0] || "?").toUpperCase();
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
        <button
          type="button"
          className="shrink-0"
          onClick={() => openInstagramProfile(lead.username)}
          title="Abrir perfil no Instagram"
        >
          <div className="w-8 h-8 rounded-full border border-[rgba(234,124,48,0.3)] bg-[rgba(234,124,48,0.1)] grid place-items-center text-[11px] font-black text-[rgb(var(--accent))]">
            {firstLetter}
          </div>
        </button>

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
