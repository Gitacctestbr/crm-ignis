import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { STAGES, stageLabel } from "../crm/stages";
import type { StageId } from "../crm/stages";

// ─── Tipos ──────────────────────────────────────────────────────────────────

type BoardType = "OUTBOUND" | "SOCIAL";

interface LeadSummary {
  id: string;
  username: string;
  displayName?: string;
  stageId: string;
  board: BoardType;
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
  panel: "#121216",
  text: "#f0f0f5",
  muted: "#787882",
  border: "#282830",
  accent: "#ea7c30",
  radius: "14px",
  danger: "#f87171",
  ok: "#4ade80",
};

const s = {
  panel: {
    position: "fixed" as const,
    bottom: "20px",
    right: "20px",
    width: "320px",
    maxHeight: "calc(100vh - 120px)",
    overflowY: "auto" as const,
    backgroundColor: C.panel,
    border: `1px solid ${C.border}`,
    borderRadius: C.radius,
    padding: "14px",
    boxShadow: "0 12px 32px rgba(0,0,0,0.55)",
    backdropFilter: "blur(8px)",
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    fontSize: "12px",
    color: C.text,
    zIndex: 2147483647,
    boxSizing: "border-box" as const,
  },
  input: {
    width: "100%",
    background: "rgba(255,255,255,0.05)",
    border: `1px solid ${C.border}`,
    borderRadius: "8px",
    color: C.text,
    fontSize: "12px",
    padding: "7px 10px",
    outline: "none",
    fontFamily: "inherit",
    boxSizing: "border-box" as const,
  },
  select: {
    width: "100%",
    background: "#181820",
    border: `1px solid ${C.border}`,
    borderRadius: "8px",
    color: C.text,
    fontSize: "12px",
    padding: "7px 10px",
    outline: "none",
    fontFamily: "inherit",
    cursor: "pointer",
    boxSizing: "border-box" as const,
  },
  btnPrimary: {
    background: C.accent,
    color: "#000",
    border: "none",
    borderRadius: "8px",
    fontSize: "12px",
    padding: "8px 12px",
    cursor: "pointer",
    fontWeight: 700,
    fontFamily: "inherit",
  },
  btnSecondary: {
    background: "transparent",
    color: C.muted,
    border: `1px solid ${C.border}`,
    borderRadius: "8px",
    fontSize: "12px",
    padding: "8px 12px",
    cursor: "pointer",
    fontFamily: "inherit",
  },
  btnOutline: {
    width: "100%",
    background: "rgba(234,124,48,0.10)",
    border: `1px solid ${C.accent}`,
    borderRadius: "8px",
    color: C.accent,
    fontSize: "12px",
    padding: "8px",
    cursor: "pointer",
    fontWeight: 600,
    fontFamily: "inherit",
  },
  label: {
    fontSize: "10px",
    color: C.muted,
    marginBottom: "4px",
    display: "block",
    textTransform: "uppercase" as const,
    letterSpacing: "0.04em",
  },
  leadRow: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "8px 10px",
    border: `1px solid ${C.border}`,
    borderRadius: "10px",
    background: "rgba(255,255,255,0.02)",
    cursor: "pointer",
    width: "100%",
    textAlign: "left" as const,
    color: C.text,
    fontFamily: "inherit",
    fontSize: "12px",
    boxSizing: "border-box" as const,
  },
  badge: {
    fontSize: "9px",
    padding: "2px 6px",
    borderRadius: "99px",
    border: `1px solid ${C.border}`,
    color: C.muted,
    whiteSpace: "nowrap" as const,
  },
};

// ─── Comunicação com background ─────────────────────────────────────────────

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
}): Promise<LeadSummary | null> {
  const resp = await chrome.runtime.sendMessage({
    type: "CRM_IGNIS_CAPTURE",
    payload: {
      board: input.board,
      stageId: input.stageId,
      username: normalizeUsername(input.username),
      displayName: input.displayName.trim(),
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
  };
}

// ─── Subcomponentes ─────────────────────────────────────────────────────────

function PanelHeader({ onClose, subtitle }: { onClose: () => void; subtitle?: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginBottom: "12px",
      }}
    >
      <div>
        <div
          style={{
            fontWeight: 800,
            fontSize: "11px",
            color: C.accent,
            letterSpacing: "0.06em",
          }}
        >
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
        title="Fechar"
        style={{
          background: "none",
          border: "none",
          color: C.muted,
          cursor: "pointer",
          padding: "4px 8px",
          borderRadius: "6px",
          fontSize: "14px",
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
  const initial = (lead.username[0] || "?").toUpperCase();
  return (
    <button
      type="button"
      onClick={onClick}
      style={s.leadRow}
      onMouseEnter={(e) =>
        ((e.currentTarget as HTMLButtonElement).style.background =
          "rgba(255,255,255,0.06)")
      }
      onMouseLeave={(e) =>
        ((e.currentTarget as HTMLButtonElement).style.background =
          "rgba(255,255,255,0.02)")
      }
    >
      <div
        style={{
          width: "30px",
          height: "30px",
          borderRadius: "999px",
          background: "rgba(234,124,48,0.15)",
          color: C.accent,
          display: "grid",
          placeItems: "center",
          fontWeight: 700,
          fontSize: "12px",
          flexShrink: 0,
        }}
      >
        {initial}
      </div>
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
          gap: "8px",
          marginBottom: "10px",
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
        <div style={{ fontSize: "11px", color: C.muted, marginBottom: "10px" }}>
          {state.lead.displayName}
        </div>
      ) : null}

      <div style={{ marginBottom: "10px" }}>
        <label style={s.label}>Etapa atual</label>
        <div
          style={{
            display: "inline-block",
            fontSize: "11px",
            padding: "3px 10px",
            borderRadius: "99px",
            border: `1px solid ${state.feedback ? C.accent : C.border}`,
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
                padding: "7px",
                borderRadius: "8px",
                border: `1px solid ${board === b ? C.accent : C.border}`,
                background: board === b ? "rgba(234,124,48,0.12)" : "transparent",
                color: board === b ? C.accent : C.muted,
                fontSize: "11px",
                cursor: saving ? "default" : "pointer",
                fontFamily: "inherit",
                fontWeight: board === b ? 700 : 500,
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
        const lead = await rpcCreateLead(input);
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
    [context],
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
    <div style={s.panel}>
      <PanelHeader onClose={onClose} subtitle={subtitle} />

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
                padding: "6px 8px",
                borderRadius: "8px",
                background: "rgba(248,113,113,0.08)",
                border: `1px solid rgba(248,113,113,0.25)`,
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
