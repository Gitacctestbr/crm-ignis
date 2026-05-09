import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { STAGES, stageLabel } from "../crm/stages";
import type { StageId } from "../crm/stages";
import { fetchAvatarAsDataUrl } from "../instagram/avatarScraper";
import { LeadAvatar } from "../ui/LeadAvatar";

// ─── Tipos ──────────────────────────────────────────────────────────────────

type BoardType = "OUTBOUND" | "SOCIAL";

interface LeadSummary {
  id: string;
  username: string;
  displayName?: string;
  stageId: string;
  board: BoardType;
  avatarUrl?: string | null;
}

type ViewState =
  | { kind: "loading" }
  | { kind: "list" } // só DM: busca + recentes
  | {
      kind: "selected";
      lead: LeadSummary;
      draftStageId: string;
      saving: boolean;
      feedback: boolean;
    }
  | {
      kind: "register";
      presetUsername: string;
      allowUsernameEdit: boolean;
      // memória do estado anterior para o botão "Voltar" no DM
      backTo: "list" | null;
    };

type Context = "profile" | "dm";

// ─── Design tokens (matching theme.css) ─────────────────────────────────────

const C = {
  panel: "rgba(12, 12, 14, 0.92)",
  text: "#f0f0f8",
  muted: "#6c6c78",
  border: "rgba(38, 38, 46, 0.85)",
  accent: "#ea7c30",
  radius: "14px",
  danger: "#f87171",
  ok: "#4ade80",
};

const s = {
  // position coords are applied dynamically (draggable); only static props here
  panelBase: {
    width: "320px",
    maxHeight: "calc(100vh - 100px)",
    overflowY: "auto" as const,
    backgroundColor: C.panel,
    border: `1px solid rgba(234, 124, 48, 0.75)`,
    borderRadius: "16px",
    padding: "16px",
    boxShadow:
      "0 24px 64px rgba(0,0,0,0.70), 0 0 0 1px rgba(234,124,48,0.06), inset 0 1px 0 rgba(255,255,255,0.04)",
    backdropFilter: "blur(20px)",
    WebkitBackdropFilter: "blur(20px)",
    animation: "ignis-panel-pulse 3s ease-in-out infinite",
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    fontSize: "12px",
    color: C.text,
    zIndex: 2147483647,
    boxSizing: "border-box" as const,
  },
  input: {
    width: "100%",
    background: "rgba(0,0,0,0.50)",
    border: `1px solid rgba(255,255,255,0.10)`,
    borderRadius: "12px",
    color: C.text,
    fontSize: "12px",
    padding: "10px 16px",
    outline: "none",
    fontFamily: "inherit",
    boxSizing: "border-box" as const,
    transition: "border-color 0.15s, box-shadow 0.15s",
  },
  select: {
    width: "100%",
    background: "rgba(18, 18, 22, 0.95)",
    border: `1px solid rgba(38, 38, 46, 0.85)`,
    borderRadius: "10px",
    color: C.text,
    fontSize: "12px",
    padding: "8px 12px",
    outline: "none",
    fontFamily: "inherit",
    cursor: "pointer",
    boxSizing: "border-box" as const,
  },
  btnPrimary: {
    background: C.accent,
    color: "#000",
    border: "none",
    borderRadius: "10px",
    fontSize: "12px",
    padding: "9px 14px",
    cursor: "pointer",
    fontWeight: 700,
    fontFamily: "inherit",
    boxShadow: "0 4px 15px rgba(234,124,48,0.4), 0 0 20px rgba(234,124,48,0.2)",
    transition: "opacity 0.15s, box-shadow 0.15s",
  },
  btnSecondary: {
    background: "rgba(255,255,255,0.05)",
    color: C.muted,
    border: `1px solid rgba(38, 38, 46, 0.85)`,
    borderRadius: "10px",
    fontSize: "12px",
    padding: "9px 14px",
    cursor: "pointer",
    fontFamily: "inherit",
    transition: "background 0.15s",
  },
  btnOutline: {
    width: "100%",
    background: "rgba(234,124,48,0.08)",
    border: `1px solid rgba(234,124,48,0.35)`,
    borderRadius: "10px",
    color: C.accent,
    fontSize: "12px",
    padding: "9px",
    cursor: "pointer",
    fontWeight: 600,
    fontFamily: "inherit",
    transition: "background 0.15s",
  },
  label: {
    fontSize: "10px",
    color: C.muted,
    marginBottom: "4px",
    display: "block",
    textTransform: "uppercase" as const,
    letterSpacing: "0.06em",
    fontWeight: 600,
  },
  leadRow: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "8px 10px",
    border: `1px solid rgba(38, 38, 46, 0.85)`,
    borderRadius: "10px",
    background: "rgba(255,255,255,0.02)",
    cursor: "pointer",
    width: "100%",
    textAlign: "left" as const,
    color: C.text,
    fontFamily: "inherit",
    fontSize: "12px",
    boxSizing: "border-box" as const,
    transition: "border-color 0.15s, background 0.15s",
  },
  badge: {
    fontSize: "9px",
    padding: "2px 8px",
    borderRadius: "99px",
    border: `1px solid rgba(234,124,48,0.30)`,
    background: "rgba(234,124,48,0.08)",
    color: C.accent,
    whiteSpace: "nowrap" as const,
    fontWeight: 600,
  },
};

// ─── Comunicação com background ─────────────────────────────────────────────

// Placeholder — o background ignora este campo e resolve o workspaceId
// a partir da sessão Supabase (auth.uid()). Mantido apenas para não quebrar
// chamadas existentes; pode ser removido quando os RPCs forem atualizados.
const WORKSPACE_ID = "default";

function normalizeUsername(u: string): string {
  return String(u || "").trim().replace(/^@+/, "").toLowerCase();
}

async function rpcGetLead(username: string): Promise<LeadSummary | null> {
  const resp = await chrome.runtime.sendMessage({
    type: "CRM_IGNIS_DM_SMART_GET_LEAD",
    payload: { workspaceId: WORKSPACE_ID, username: normalizeUsername(username) },
  });
  if (resp?.ok && resp.lead) {
    return {
      id: resp.lead.id,
      username: resp.lead.username,
      displayName: resp.lead.displayName,
      stageId: resp.lead.stageId,
      board: resp.lead.board,
      avatarUrl: resp.lead.avatarUrl ?? null,
    };
  }
  return null;
}

async function rpcSearchLeads(query: string, limit = 8): Promise<LeadSummary[]> {
  const resp = await chrome.runtime.sendMessage({
    type: "CRM_IGNIS_SEARCH_LEADS",
    payload: { workspaceId: WORKSPACE_ID, query, limit },
  });
  if (resp?.ok && Array.isArray(resp.leads)) return resp.leads as LeadSummary[];
  return [];
}

async function rpcRecentLeads(limit = 5): Promise<LeadSummary[]> {
  const resp = await chrome.runtime.sendMessage({
    type: "CRM_IGNIS_RECENT_LEADS",
    payload: { workspaceId: WORKSPACE_ID, limit },
  });
  if (resp?.ok && Array.isArray(resp.leads)) return resp.leads as LeadSummary[];
  return [];
}

async function rpcUpdateAvatar(leadId: string, avatarUrl: string): Promise<boolean> {
  const resp = await chrome.runtime.sendMessage({
    type: "CRM_IGNIS_DM_SMART_SAVE",
    payload: { workspaceId: WORKSPACE_ID, leadId, patch: { avatarUrl } },
  });
  return !!resp?.ok;
}

async function rpcUpdateStage(leadId: string, stageId: string): Promise<boolean> {
  const resp = await chrome.runtime.sendMessage({
    type: "CRM_IGNIS_DM_SMART_SAVE",
    payload: { workspaceId: WORKSPACE_ID, leadId, patch: { stageId } },
  });
  return !!resp?.ok;
}

async function rpcCreateLead(input: {
  username: string;
  displayName: string;
  board: BoardType;
  stageId: StageId;
  avatarUrl?: string | null;
}): Promise<LeadSummary | null> {
  const resp = await chrome.runtime.sendMessage({
    type: "CRM_IGNIS_CAPTURE",
    payload: {
      board: input.board,
      stageId: input.stageId,
      username: normalizeUsername(input.username),
      displayName: input.displayName.trim(),
      avatarUrl: input.avatarUrl ?? undefined,
    },
  });
  if (!resp?.ok || !resp.result?.lead) return null;
  // Extrai o lead diretamente da resposta do CAPTURE, eliminando a race condition
  // que existia ao fazer um segundo rpcGetLead() logo após o commit do IndexedDB.
  const lead = resp.result.lead;
  return {
    id: lead.id,
    username: lead.username,
    displayName: lead.displayName,
    stageId: lead.stageId,
    board: lead.board,
    avatarUrl: lead.avatarUrl ?? null,
  };
}

// ─── Subcomponentes ─────────────────────────────────────────────────────────

function PanelHeader({
  onClose,
  subtitle,
  onHeaderMouseDown,
}: {
  onClose: () => void;
  subtitle?: string;
  onHeaderMouseDown?: (e: React.MouseEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      onMouseDown={onHeaderMouseDown}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginBottom: "14px",
        paddingBottom: "12px",
        borderBottom: "1px solid rgba(38,38,46,0.7)",
        cursor: "grab",
        userSelect: "none",
      }}
    >
      <div>
        {/* Drag handle hint */}
        <div
          style={{
            fontSize: "9px",
            color: "rgba(108,108,120,0.45)",
            letterSpacing: "0.14em",
            lineHeight: 1,
            marginBottom: "4px",
          }}
        >
          ⠿⠿ arrastar
        </div>
        <div
          style={{
            fontWeight: 800,
            fontSize: "12px",
            color: C.accent,
            letterSpacing: "0.08em",
            display: "flex",
            alignItems: "center",
            gap: "5px",
          }}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill={C.accent}
            style={{ filter: "drop-shadow(0 0 4px rgba(234,124,48,0.65))", flexShrink: 0 }}
          >
            <path d="M12.963 2.286a.75.75 0 00-1.071-.136 9.742 9.742 0 00-3.539 6.177A7.547 7.547 0 016.648 6.61a.75.75 0 00-1.152-.082A9 9 0 1015.68 4.534a7.46 7.46 0 01-2.717-2.248zM15.75 14.25a3.75 3.75 0 11-7.313-1.172c.628.465 1.35.81 2.133 1a5.99 5.99 0 011.925-3.545 3.75 3.75 0 013.255 3.717z" />
          </svg>
          CRM IGNIS
        </div>
        {subtitle ? (
          <div style={{ fontSize: "10px", color: C.muted, marginTop: "2px" }}>
            {subtitle}
          </div>
        ) : null}
      </div>
      <button
        onClick={onClose}
        onMouseDown={(e) => e.stopPropagation()}
        title="Fechar"
        style={{
          background: "rgba(255,255,255,0.07)",
          border: "1px solid rgba(38,38,46,0.85)",
          borderRadius: "8px",
          color: C.muted,
          cursor: "pointer",
          padding: "5px 9px",
          fontSize: "13px",
          lineHeight: 1,
          fontFamily: "inherit",
        }}
      >
        ✕
      </button>
    </div>
  );
}

function LeadRow({
  lead,
  onClick,
}: {
  lead: LeadSummary;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={s.leadRow}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.05)";
        (e.currentTarget as HTMLButtonElement).style.borderColor = "rgba(234,124,48,0.25)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.02)";
        (e.currentTarget as HTMLButtonElement).style.borderColor = "rgba(38,38,46,0.85)";
      }}
    >
      <LeadAvatar
        username={lead.username}
        avatarUrl={lead.avatarUrl}
        size={30}
        bgColor="rgba(234,124,48,0.12)"
        borderColor="rgba(234,124,48,0.28)"
        textColor={C.accent}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontWeight: 700,
            color: C.text,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          @{lead.username}
        </div>
        <div
          style={{
            fontSize: "10px",
            color: C.muted,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {lead.displayName ? `${lead.displayName} • ` : ""}
          {stageLabel(lead.stageId)}
        </div>
      </div>
      <span style={s.badge}>{lead.board === "OUTBOUND" ? "Out" : "Social"}</span>
    </button>
  );
}

function SelectedView({
  state,
  onBack,
  onChangeStage,
  onSave,
}: {
  state: Extract<ViewState, { kind: "selected" }>;
  onBack: (() => void) | null; // null no contexto profile
  onChangeStage: (next: string) => void;
  onSave: () => void;
}) {
  const dirty = state.draftStageId !== state.lead.stageId;

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "10px",
          marginBottom: "10px",
        }}
      >
        <LeadAvatar
          username={state.lead.username}
          avatarUrl={state.lead.avatarUrl}
          size={44}
          bgColor="rgba(234,124,48,0.12)"
          borderColor="rgba(234,124,48,0.45)"
          textColor={C.accent}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "6px",
              marginBottom: "2px",
            }}
          >
            <span style={{ color: C.ok, fontSize: "14px" }}>✓</span>
            <span style={{ fontWeight: 700, fontSize: "13px" }}>
              @{state.lead.username}
            </span>
            <span style={s.badge}>
              {state.lead.board === "OUTBOUND" ? "Outbound" : "Social"}
            </span>
          </div>
          {state.lead.displayName ? (
            <div style={{ fontSize: "11px", color: C.muted }}>
              {state.lead.displayName}
            </div>
          ) : null}
        </div>
      </div>

      <div style={{ marginBottom: "10px" }}>
        <label style={s.label}>Etapa atual</label>
        <div
          style={{
            display: "inline-block",
            fontSize: "11px",
            padding: "3px 10px",
            borderRadius: "99px",
            border: `1px solid ${state.feedback ? C.accent : "rgba(38,38,46,0.85)"}`,
            color: state.feedback ? C.accent : C.text,
            background: state.feedback
              ? "rgba(234,124,48,0.12)"
              : "rgba(255,255,255,0.04)",
            transition: "all 0.3s ease",
            fontWeight: 600,
          }}
        >
          {stageLabel(state.lead.stageId)}
        </div>
      </div>

      <div style={{ marginBottom: "12px" }}>
        <label style={s.label}>Mover para</label>
        <select
          style={s.select}
          value={state.draftStageId}
          onChange={(e) => onChangeStage(e.target.value)}
          disabled={state.saving}
        >
          {STAGES.map((st) => (
            <option key={st.id} value={st.id}>
              {st.label}
            </option>
          ))}
        </select>
      </div>

      <div style={{ display: "flex", gap: "6px" }}>
        <button
          onClick={onSave}
          disabled={!dirty || state.saving}
          style={{
            ...s.btnPrimary,
            flex: 1,
            opacity: !dirty || state.saving ? 0.55 : 1,
            cursor: !dirty || state.saving ? "default" : "pointer",
          }}
        >
          {state.saving ? "Salvando…" : "Salvar"}
        </button>
        {onBack ? (
          <button onClick={onBack} style={s.btnSecondary} disabled={state.saving}>
            Voltar
          </button>
        ) : null}
      </div>
    </div>
  );
}

function RegisterView({
  presetUsername,
  allowUsernameEdit,
  onCancel,
  onSubmit,
}: {
  presetUsername: string;
  allowUsernameEdit: boolean;
  onCancel: (() => void) | null;
  onSubmit: (input: {
    username: string;
    displayName: string;
    board: BoardType;
    stageId: StageId;
  }) => Promise<void>;
}) {
  const [username, setUsername] = useState(presetUsername);
  const [displayName, setDisplayName] = useState(presetUsername);
  const [board, setBoard] = useState<BoardType>("OUTBOUND");
  const [stageId, setStageId] = useState<StageId>("LEADS_NOVOS");
  const [saving, setSaving] = useState(false);

  const cleanUser = normalizeUsername(username);
  const canSubmit = cleanUser.length > 0 && !saving;

  async function handleSubmit() {
    if (!canSubmit) return;
    setSaving(true);
    try {
      await onSubmit({
        username: cleanUser,
        displayName: displayName.trim() || cleanUser,
        board,
        stageId,
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div style={{ marginBottom: "10px" }}>
        <label style={s.label}>@username</label>
        <input
          style={{
            ...s.input,
            opacity: allowUsernameEdit ? 1 : 0.7,
          }}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="@username"
          disabled={!allowUsernameEdit || saving}
          autoFocus={allowUsernameEdit}
        />
      </div>

      <div style={{ marginBottom: "10px" }}>
        <label style={s.label}>Nome</label>
        <input
          style={s.input}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="Nome do lead"
          disabled={saving}
        />
      </div>

      <div style={{ marginBottom: "10px" }}>
        <label style={s.label}>Funil</label>
        <div style={{ display: "flex", gap: "6px" }}>
          {(["OUTBOUND", "SOCIAL"] as BoardType[]).map((b) => (
            <button
              key={b}
              type="button"
              onClick={() => setBoard(b)}
              disabled={saving}
              style={{
                flex: 1,
                padding: "8px",
                borderRadius: "10px",
                border: `1px solid ${board === b ? C.accent : "rgba(38,38,46,0.85)"}`,
                background: board === b ? "rgba(234,124,48,0.12)" : "rgba(255,255,255,0.03)",
                color: board === b ? C.accent : C.muted,
                fontSize: "11px",
                cursor: saving ? "default" : "pointer",
                fontFamily: "inherit",
                fontWeight: board === b ? 700 : 500,
                transition: "border-color 0.15s, background 0.15s",
              }}
            >
              {b === "OUTBOUND" ? "Outbound" : "Social Selling"}
            </button>
          ))}
        </div>
      </div>

      <div style={{ marginBottom: "12px" }}>
        <label style={s.label}>Etapa inicial</label>
        <select
          style={s.select}
          value={stageId}
          onChange={(e) => setStageId(e.target.value as StageId)}
          disabled={saving}
        >
          {STAGES.map((st) => (
            <option key={st.id} value={st.id}>
              {st.label}
            </option>
          ))}
        </select>
      </div>

      <div style={{ display: "flex", gap: "6px" }}>
        <button
          onClick={() => void handleSubmit()}
          disabled={!canSubmit}
          style={{
            ...s.btnPrimary,
            flex: 1,
            opacity: canSubmit ? 1 : 0.55,
            cursor: canSubmit ? "pointer" : "default",
          }}
        >
          {saving ? "Cadastrando…" : "Cadastrar"}
        </button>
        {onCancel ? (
          <button onClick={onCancel} style={s.btnSecondary} disabled={saving}>
            Cancelar
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ListView({
  recent,
  onPick,
  onRegisterNew,
}: {
  recent: LeadSummary[];
  onPick: (lead: LeadSummary) => void;
  onRegisterNew: (presetUsername: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<LeadSummary[] | null>(null);
  const [searching, setSearching] = useState(false);

  const trimmed = query.trim();

  // Debounce de busca
  useEffect(() => {
    if (!trimmed) {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const id = window.setTimeout(async () => {
      const found = await rpcSearchLeads(trimmed, 10);
      setResults(found);
      setSearching(false);
    }, 220);
    return () => window.clearTimeout(id);
  }, [trimmed]);

  const showingResults = trimmed.length > 0;
  const list = showingResults ? results ?? [] : recent;
  const emptyMessage = showingResults
    ? searching
      ? "Buscando…"
      : "Nenhum lead encontrado."
    : "Nenhuma movimentação recente.";

  return (
    <div>
      <div style={{ marginBottom: "10px" }}>
        <label style={s.label}>Buscar por nome ou @username</label>
        <input
          style={s.input}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Ex.: davidlean"
          autoFocus
        />
      </div>

      <div style={{ marginBottom: "8px" }}>
        <div style={{ ...s.label, marginBottom: "6px" }}>
          {showingResults
            ? `Resultados${searching ? " (buscando…)" : ""}`
            : "Movimentações recentes"}
        </div>
        {list.length === 0 ? (
          <div style={{ fontSize: "11px", color: C.muted, padding: "6px 0" }}>
            {emptyMessage}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            {list.map((l) => (
              <LeadRow key={l.id} lead={l} onClick={() => onPick(l)} />
            ))}
          </div>
        )}
      </div>

      {showingResults && !searching && (results?.length ?? 0) === 0 ? (
        <button
          style={s.btnOutline}
          onClick={() => onRegisterNew(normalizeUsername(trimmed))}
        >
          + Cadastrar novo lead
        </button>
      ) : (
        <button
          style={{ ...s.btnOutline, marginTop: "4px" }}
          onClick={() => onRegisterNew(showingResults ? normalizeUsername(trimmed) : "")}
        >
          + Cadastrar novo lead
        </button>
      )}
    </div>
  );
}

// ─── Componente principal ───────────────────────────────────────────────────

export function DmLeadPanel({
  username,
  onClose,
}: {
  username: string | null;
  onClose: () => void;
}) {
  // Inferimos o contexto: se veio username (do URL), é perfil; caso contrário, DM.
  // O content.ts já garante essa correspondência via prop key.
  const context: Context = username ? "profile" : "dm";

  const [state, setState] = useState<ViewState>(() =>
    context === "profile" ? { kind: "loading" } : { kind: "list" },
  );

  // Espelha o state em ref para handlers assíncronos e listeners lerem o snapshot
  // atual sem depender da timing exata do setState.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const [recent, setRecent] = useState<LeadSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  // ─── Drag (posicionamento livre do painel) ───────────────────────────────

  const [pos, setPos] = useState<{ x: number; y: number }>(() => {
    if (typeof window === "undefined") return { x: 20, y: 20 };
    return {
      x: Math.max(0, window.innerWidth - 340),
      y: Math.max(20, window.innerHeight - 580),
    };
  });
  const [isDragging, setIsDragging] = useState(false);
  const isDraggingRef = useRef(false);
  const dragOffsetRef = useRef({ x: 0, y: 0 });

  // Attach global mousemove/mouseup once; use refs to avoid stale closures
  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!isDraggingRef.current) return;
      const newX = e.clientX - dragOffsetRef.current.x;
      const newY = e.clientY - dragOffsetRef.current.y;
      setPos({
        x: Math.max(0, Math.min(newX, window.innerWidth - 320)),
        y: Math.max(0, Math.min(newY, window.innerHeight - 60)),
      });
    }
    function onMouseUp() {
      if (!isDraggingRef.current) return;
      isDraggingRef.current = false;
      setIsDragging(false);
    }
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  // Inject CSS keyframes for panel neon-pulse animation into the host page head
  useEffect(() => {
    const id = "ignis-panel-pulse-style";
    if (document.getElementById(id)) return;
    const style = document.createElement("style");
    style.id = id;
    style.textContent = [
      "@keyframes ignis-panel-pulse {",
      "  0%, 100% { box-shadow: 0 24px 64px rgba(0,0,0,0.75), 0 0 0 1px rgba(234,124,48,0.30), 0 0 14px rgba(234,124,48,0.22), inset 0 1px 0 rgba(255,255,255,0.05); }",
      "  50%       { box-shadow: 0 24px 64px rgba(0,0,0,0.75), 0 0 0 1px rgba(234,124,48,0.65), 0 0 40px rgba(234,124,48,0.55), inset 0 1px 0 rgba(255,255,255,0.05); }",
      "}",
    ].join("\n");
    document.head.appendChild(style);
  }, []);

  function handleHeaderMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement;
    if (target.tagName === "BUTTON" || target.closest("button")) return;
    e.preventDefault();
    isDraggingRef.current = true;
    setIsDragging(true);
    dragOffsetRef.current = {
      x: e.clientX - pos.x,
      y: e.clientY - pos.y,
    };
  }

  // ─── Carregamento inicial ────────────────────────────────────────────────

  // Profile: busca o lead pelo username da URL
  useEffect(() => {
    if (context !== "profile" || !username) return;
    let cancelled = false;
    (async () => {
      try {
        const lead = await rpcGetLead(username);
        if (cancelled) return;
        if (lead) {
          setState({
            kind: "selected",
            lead,
            draftStageId: lead.stageId,
            saving: false,
            feedback: false,
          });
        } else {
          setState({
            kind: "register",
            presetUsername: username,
            allowUsernameEdit: false,
            backTo: null,
          });
        }
      } catch (e: any) {
        if (cancelled) return;
        setError(e?.message || "Erro ao carregar lead");
        setState({
          kind: "register",
          presetUsername: username,
          allowUsernameEdit: true,
          backTo: null,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [context, username]);

  // DM: pré-carrega os 5 últimos leads movimentados
  useEffect(() => {
    if (context !== "dm") return;
    let cancelled = false;
    (async () => {
      try {
        const list = await rpcRecentLeads(5);
        if (!cancelled) setRecent(list);
      } catch {
        if (!cancelled) setRecent([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [context]);

  // Profile: se o lead resolvido não tem avatar e estamos no perfil dele
  // (estamos dentro da aba do IG), busca via web_profile_info e persiste.
  // Roda apenas uma vez por (username, lead.id) para não martelar a API.
  const avatarFetchedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (context !== "profile" || !username) return;
    if (state.kind !== "selected") return;
    if (state.lead.avatarUrl) return;
    if (state.lead.username.toLowerCase() !== username.toLowerCase()) return;
    if (avatarFetchedForRef.current === state.lead.id) return;

    avatarFetchedForRef.current = state.lead.id;
    let cancelled = false;
    (async () => {
      try {
        const url = await fetchAvatarAsDataUrl(username);
        if (cancelled || !url) return;
        await rpcUpdateAvatar(state.lead.id, url);
        // Reflete localmente sem esperar broadcast (evita flicker).
        setState((cur) => {
          if (cur.kind !== "selected" || cur.lead.id !== state.lead.id) return cur;
          return { ...cur, lead: { ...cur.lead, avatarUrl: url } };
        });
      } catch {
        /* sem foto, segue */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [context, username, state]);

  // Profile: listener de CRM_IGNIS_DB_UPDATED para refletir escritas externas
  // (ex.: sidepanel move o lead enquanto o usuário está no perfil) e como safety
  // net para qualquer operação de escrita confirmada pelo background worker.
  useEffect(() => {
    if (context !== "profile" || !username) return;

    const handleMessage = (msg: any) => {
      if (msg?.type !== "CRM_IGNIS_DB_UPDATED") return;

      // Não interrompe save em andamento nem animação de feedback para evitar
      // sobrescrever estado visual que o usuário ainda está vendo.
      const snap = stateRef.current;
      if (snap.kind === "selected" && (snap.saving || snap.feedback)) return;

      void (async () => {
        try {
          const lead = await rpcGetLead(username);
          if (!lead) return;
          // Re-verifica após o await: o estado pode ter mudado enquanto esperávamos
          // a resposta do background (ex.: handleSubmitRegister já setou feedback).
          const cur = stateRef.current;
          if (cur.kind === "selected" && (cur.saving || cur.feedback)) return;
          setState({
            kind: "selected",
            lead,
            draftStageId: lead.stageId,
            saving: false,
            feedback: false,
          });
        } catch {
          // Silencioso — o carregamento inicial já trata erros visualmente.
        }
      })();
    };

    chrome.runtime.onMessage.addListener(handleMessage);
    return () => chrome.runtime.onMessage.removeListener(handleMessage);
  }, [context, username]);

  // ─── Ações ───────────────────────────────────────────────────────────────

  const goBackToList = useCallback(() => {
    setError(null);
    setState({ kind: "list" });
    // Recarrega recentes (último movimentado mudou)
    void rpcRecentLeads(5).then(setRecent);
  }, []);

  const handlePickLead = useCallback((lead: LeadSummary) => {
    setError(null);
    setState({
      kind: "selected",
      lead,
      draftStageId: lead.stageId,
      saving: false,
      feedback: false,
    });
  }, []);

  const handleStartRegister = useCallback((presetUsername: string) => {
    setError(null);
    setState({
      kind: "register",
      presetUsername,
      allowUsernameEdit: true,
      backTo: "list",
    });
  }, []);

  const handleSaveStage = useCallback(async () => {
    const snapshot = stateRef.current;
    if (snapshot.kind !== "selected") return;
    if (snapshot.draftStageId === snapshot.lead.stageId) return;

    setError(null);
    setState({ ...snapshot, saving: true });

    try {
      const ok = await rpcUpdateStage(snapshot.lead.id, snapshot.draftStageId);
      if (!ok) {
        setError("Erro ao salvar etapa");
        setState((cur) => (cur.kind === "selected" ? { ...cur, saving: false } : cur));
        return;
      }

      setState((cur) => {
        if (cur.kind !== "selected") return cur;
        return {
          kind: "selected",
          lead: { ...cur.lead, stageId: cur.draftStageId },
          draftStageId: cur.draftStageId,
          saving: false,
          feedback: true,
        };
      });

      // Apaga feedback visual após 1s
      window.setTimeout(() => {
        setState((cur) =>
          cur.kind === "selected" ? { ...cur, feedback: false } : cur,
        );
      }, 1000);

      // Atualiza lista de recentes em background
      if (context === "dm") void rpcRecentLeads(5).then(setRecent);
    } catch (e: any) {
      setError(e?.message || "Erro ao salvar");
      setState((cur) => (cur.kind === "selected" ? { ...cur, saving: false } : cur));
    }
  }, [context]);

  const handleSubmitRegister = useCallback(
    async (input: {
      username: string;
      displayName: string;
      board: BoardType;
      stageId: StageId;
    }) => {
      setError(null);
      try {
        // Em contexto de perfil, busca o avatar em paralelo — a página atual
        // É o perfil, então web_profile_info responde com a foto deste user.
        // Em contexto DM o cadastro é manual, sem avatar disponível.
        let avatarUrl: string | null = null;
        if (
          context === "profile" &&
          username &&
          input.username.toLowerCase() === username.toLowerCase()
        ) {
          try {
            avatarUrl = await fetchAvatarAsDataUrl(input.username);
          } catch {
            avatarUrl = null;
          }
        }

        const lead = await rpcCreateLead({ ...input, avatarUrl });
        if (!lead) {
          setError("Erro ao cadastrar lead");
          return;
        }
        setState({
          kind: "selected",
          lead,
          draftStageId: lead.stageId,
          saving: false,
          feedback: true,
        });
        window.setTimeout(() => {
          setState((cur) =>
            cur.kind === "selected" ? { ...cur, feedback: false } : cur,
          );
        }, 1000);
        if (context === "dm") void rpcRecentLeads(5).then(setRecent);
      } catch (e: any) {
        setError(e?.message || "Erro ao cadastrar");
      }
    },
    [context, username],
  );

  const handleChangeDraftStage = useCallback((next: string) => {
    setState((cur) => {
      if (cur.kind !== "selected") return cur;
      return { ...cur, draftStageId: next };
    });
  }, []);

  // ─── Render ──────────────────────────────────────────────────────────────

  const subtitle = useMemo(() => {
    if (context === "profile") return username ? `Perfil • @${username}` : "Perfil";
    return "Direct Message";
  }, [context, username]);

  return (
    <div
      style={{
        position: "fixed",
        ...s.panelBase,
        left: `${pos.x}px`,
        top: `${pos.y}px`,
        cursor: isDragging ? "grabbing" : "default",
        userSelect: isDragging ? "none" : "auto",
      }}
    >
      <PanelHeader
        onClose={onClose}
        subtitle={subtitle}
        onHeaderMouseDown={handleHeaderMouseDown}
      />

      {state.kind === "loading" && (
        <div style={{ fontSize: "12px", color: C.muted, padding: "12px 0" }}>
          Buscando lead…
        </div>
      )}

      {state.kind === "list" && (
        <ListView
          recent={recent}
          onPick={handlePickLead}
          onRegisterNew={handleStartRegister}
        />
      )}

      {state.kind === "selected" && (
        <SelectedView
          state={state}
          onBack={context === "dm" ? goBackToList : null}
          onChangeStage={handleChangeDraftStage}
          onSave={() => void handleSaveStage()}
        />
      )}

      {state.kind === "register" && (
        <div>
          {context === "profile" ? (
            <div
              style={{
                fontSize: "11px",
                color: C.muted,
                marginBottom: "10px",
                padding: "6px 10px",
                borderRadius: "10px",
                background: "rgba(248,113,113,0.07)",
                border: "1px solid rgba(248,113,113,0.22)",
              }}
            >
              Lead não cadastrado. Preencha abaixo para criar.
            </div>
          ) : null}
          <RegisterView
            presetUsername={state.presetUsername}
            allowUsernameEdit={state.allowUsernameEdit}
            onCancel={state.backTo === "list" ? goBackToList : null}
            onSubmit={handleSubmitRegister}
          />
        </div>
      )}

      {error && (
        <div style={{ marginTop: "8px", fontSize: "10px", color: C.danger }}>
          {error}
        </div>
      )}
    </div>
  );
}
