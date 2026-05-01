import React from "react";
import { addLead, deleteLead, getLeadByUsername, listLeadsByBoard, registerCtaAndMove } from "../db/leadsRepo";
import type { BoardType, DailyMetrics, Lead } from "../db/db";
import {
  closeDailyMetrics,
  emptyDailyMetrics,
  getDailyMetrics,
  getWeekMetrics,
  reopenDailyMetrics,
  todayDateKey,
  upsertDailyMetrics,
  upsertDailyMetricsGuarded,
} from "../db/metricsRepo";
import { parseInstagramUsername } from "../instagram/parseInstagram";
import { normalizeStageId, stageLabel } from "../crm/stages";
import { BackupRestorePanel } from "../ui/BackupRestorePanel";
import { ExtensionSettingsPanel } from "../ui/ExtensionSettingsPanel";
import { MetricInput } from "../ui/MetricInput";

type Tab = "Outbound" | "Social" | "Tasks" | "Filtros" | "Métricas" | "Settings";

function tabToBoard(tab: Tab): BoardType | null {
  if (tab === "Outbound") return "OUTBOUND";
  if (tab === "Social") return "SOCIAL";
  return null;
}

function getDashboardUrl() {
  return chrome.runtime.getURL("dashboard.html");
}

async function openOrFocusDashboard() {
  const dashboardUrl = getDashboardUrl();
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((t) => (t.url ? t.url.startsWith(dashboardUrl) : false));

  if (existing?.id) {
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId) await chrome.windows.update(existing.windowId, { focused: true });
    return;
  }

  await chrome.tabs.create({ url: dashboardUrl, active: true });
}

function openInstagramProfile(username: string) {
  const u = String(username || "").replace(/^@+/, "").trim();
  if (!u) return;
  const url = `https://www.instagram.com/${u}/`;
  chrome.tabs.create({ url, active: true });
}

// =============================================================
// Helpers: Active tab + Instagram URL parsing
// =============================================================

type ActiveLeadContext = {
  tabId: number;
  tabUrl: string;
  activeUsername: string | null;
  lead: Lead | null;
};

async function queryActiveTab(): Promise<chrome.tabs.Tab | null> {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs?.[0] ?? null;
  } catch {
    return null;
  }
}

async function sendMessageToTab<T>(tabId: number, message: any): Promise<T | null> {
  return await new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, message, (resp) => {
        const err = chrome.runtime.lastError;
        if (err) {
          resolve(null);
          return;
        }
        resolve((resp ?? null) as T | null);
      });
    } catch {
      resolve(null);
    }
  });
}

async function getActiveUsernameFromPage(tabId: number): Promise<string | null> {
  type Resp = { ok: true; username: string } | { ok: false; reason: string };
  const resp = await sendMessageToTab<Resp>(tabId, { type: "CRM_IGNIS_GET_ACTIVE_USERNAME" });
  if (!resp || (resp as any).ok !== true) return null;
  const u = String((resp as any).username || "").trim().replace(/^@+/, "");
  if (!u) return null;
  return u;
}

function isInstagramUrl(raw: string): boolean {
  try {
    const u = new URL(String(raw || "").trim());
    const host = u.hostname.replace(/^www\./, "");
    return host === "instagram.com" || host.endsWith(".instagram.com");
  } catch {
    return false;
  }
}

function extractProfileUsernameFromUrl(raw: string): string | null {
  try {
    const u = new URL(String(raw || "").trim());
    const host = u.hostname.replace(/^www\./, "");
    if (host !== "instagram.com" && !host.endsWith(".instagram.com")) return null;

    const path = u.pathname.replace(/\/+$/, "");
    const parts = path.split("/").filter(Boolean);
    if (!parts.length) return null;

    const first = parts[0];
    const blocked = new Set([
      "p",
      "reel",
      "reels",
      "stories",
      "explore",
      "accounts",
      "direct",
      "about",
      "developer",
    ]);
    if (blocked.has(first.toLowerCase())) return null;

    if (!/^[a-zA-Z0-9._]+$/.test(first)) return null;
    return first.replace(/^@+/, "");
  } catch {
    return null;
  }
}

async function resolveActiveLeadContext(input: { workspaceId: string }): Promise<ActiveLeadContext | null> {
  const tab = await queryActiveTab();
  if (!tab?.id) return null;

  const tabId = tab.id;
  const tabUrl = String(tab.url || "");

  let activeUsername: string | null = null;

  // Prefer content-script (works for DM and Profile)
  activeUsername = await getActiveUsernameFromPage(tabId);

  // Fallback: if the content script didn't respond, try to parse profile URL
  if (!activeUsername && tabUrl) {
    const parsed = parseInstagramUsername(tabUrl);
    if (parsed.ok) activeUsername = parsed.username;
  }

  const lead = activeUsername
    ? (await getLeadByUsername({ workspaceId: input.workspaceId, username: activeUsername })) ?? null
    : null;

  return { tabId, tabUrl, activeUsername, lead };
}


function cx(...parts: Array<string | false | undefined | null>) {
  return parts.filter(Boolean).join(" ");
}

function toLocalDayRange(dateStr: string): { start: number; end: number } | null {
  if (!dateStr) return null;
  const [y, m, d] = dateStr.split("-").map((x) => Number(x));
  if (!y || !m || !d) return null;

  // evita bug de fuso (Date("YYYY-MM-DD") vira UTC)
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

function safeInt(v: any): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  return Math.floor(n);
}

function pct(numer: number, denom: number): number {
  if (!denom) return 0;
  return (numer / denom) * 100;
}

// % para colunas de resposta (D e F no Sheets): 0 casas (ex.: 14%)
function fmtPctInt(p: number): string {
  if (!Number.isFinite(p)) return "0%";
  return `${Math.round(p)}%`;
}

// % para colunas de conversão (I e O no Sheets): 2 casas (ex.: 1,67%)
function fmtPct2(p: number): string {
  if (!Number.isFinite(p)) return "0,00%";
  return `${p.toFixed(2).replace(".", ",")}%`;
}

function shortDayLabel(dateKey: string) {
  const [y, m, d] = dateKey.split("-").map((x) => Number(x));
  const dt = new Date(y, m - 1, d, 12, 0, 0, 0);
  const names = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
  return names[dt.getDay()] ?? "";
}

function fullDayNamePT(dateKey: string) {
  const [y, m, d] = dateKey.split("-").map((x) => Number(x));
  const dt = new Date(y, m - 1, d, 12, 0, 0, 0);
  const names = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
  return names[dt.getDay()] ?? "";
}

async function copyToClipboard(text: string) {
  // preferencial (moderno)
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // fallback (mais compatível)
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      ta.style.top = "-9999px";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

export function SidePanelApp() {
  const [tab, setTab] = React.useState<Tab>("Outbound");
  const workspaceId = "default";
  const activeBoard = tabToBoard(tab);

  const [leads, setLeads] = React.useState<any[]>([]);
  const [search, setSearch] = React.useState("");

  const [dayFilter, setDayFilter] = React.useState<string>(""); // YYYY-MM-DD

  const [toastState, setToastState] = React.useState<
    | {
        message: string;
        actionLabel?: string;
        onAction?: () => void;
      }
    | null
  >(null);
  const toastTimer = React.useRef<number | null>(null);

  function toast(m: string, action?: { label: string; onClick: () => void }) {
    setToastState({ message: m, actionLabel: action?.label, onAction: action?.onClick });
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastState(null), 2500);
  }

  const reload = React.useCallback(async () => {
    if (!activeBoard) {
      setLeads([]);
      return;
    }
    try {
      const items = await listLeadsByBoard(workspaceId, activeBoard);
      setLeads(items);
    } catch (err) {
      console.error(err);
      toast("Erro ao carregar leads (veja o Console).");
    }
  }, [activeBoard]);

  React.useEffect(() => {
    void reload();
    if (!activeBoard) return;
    const id = window.setInterval(() => {
      void reload();
    }, 1500);
    return () => window.clearInterval(id);
  }, [reload]);

  // Reload immediately when background broadcasts a DB change (e.g. lead saved from DM panel)
  React.useEffect(() => {
    const handler = (msg: any) => {
      if (msg?.type === "CRM_IGNIS_DB_UPDATED") void reload();
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, [reload]);

  async function captureFromCurrentTab() {
    if (!activeBoard) return;

    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabInfo = tabs?.[0];
    const url = tabInfo?.url;

    if (!url) {
      toast("Não consegui ler a aba ativa.");
      return;
    }

    const parsed = parseInstagramUsername(url);
    if (!parsed.ok) {
      toast(parsed.reason);
      return;
    }

    try {
      const result = await addLead({
        workspaceId,
        board: activeBoard,
        stageId: "LEADS_NOVOS",
        username: parsed.username,
      });

      if (result.status === "created") toast(`✅ Capturado: @${result.lead.username}`);
      if (result.status === "exists") toast(`⚠️ Já existe: @${result.lead.username}`);

      await reload();
    } catch (err) {
      console.error(err);
      toast("Erro ao adicionar lead (veja o Console).");
    }
  }

  async function onDelete(leadId: string, username: string) {
    try {
      await deleteLead({ workspaceId, leadId });
      toast(`🗑️ Lead @${username} excluído`);
      await reload();
    } catch (err) {
      console.error(err);
      toast("Erro ao excluir lead (veja o Console).");
    }
  }

  // Só "Leads novos" (fila para abordagem)
  const leadsToApproach = React.useMemo(() => {
    return leads.filter((l) => normalizeStageId(String(l?.stageId ?? "")) === "LEADS_NOVOS");
  }, [leads]);

  // filtro por dia (createdAt)
  const dayRange = React.useMemo(() => toLocalDayRange(dayFilter), [dayFilter]);
  const dayFiltered = React.useMemo(() => {
    const base = leadsToApproach;
    if (!dayRange) return base;
    return base.filter((l) => {
      const createdAt = Number(l?.createdAt ?? 0);
      return createdAt >= dayRange.start && createdAt < dayRange.end;
    });
  }, [leadsToApproach, dayRange]);

  // busca
  const q = search.trim().toLowerCase();
  const filtered = React.useMemo(() => {
    const base = dayFiltered;
    if (!q) return base;
    return base.filter(
      (l) =>
        String(l.username || "").toLowerCase().includes(q) ||
        String(l.displayName || "").toLowerCase().includes(q),
    );
  }, [dayFiltered, q]);

  const dayLabel = React.useMemo(() => {
    if (!dayRange) return null;
    try {
      return new Date(dayRange.start).toLocaleDateString("pt-BR");
    } catch {
      return dayFilter;
    }
  }, [dayFilter, dayRange]);

  return (
    <div className="min-h-screen bg-[#09090b] text-[rgb(var(--text))] p-5">
      <div className="flex items-center gap-2 pb-3 border-b border-[rgb(var(--border))]/50">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="currentColor"
          className="text-[rgb(var(--accent))] shrink-0"
          style={{ filter: "drop-shadow(0 0 5px rgba(234,124,48,0.65))" }}
        >
          <path d="M12.963 2.286a.75.75 0 00-1.071-.136 9.742 9.742 0 00-3.539 6.177A7.547 7.547 0 016.648 6.61a.75.75 0 00-1.152-.082A9 9 0 1015.68 4.534a7.46 7.46 0 01-2.717-2.248zM15.75 14.25a3.75 3.75 0 11-7.313-1.172c.628.465 1.35.81 2.133 1a5.99 5.99 0 011.925-3.545 3.75 3.75 0 013.255 3.717z" />
        </svg>
        <div className="font-black tracking-wide text-sm">CRM IGNIS</div>
        <div className="text-[10px] text-[rgb(var(--muted))] font-mono">• Padrão</div>
      </div>

      <div className="flex gap-1.5 mt-3 flex-wrap">
        {(["Outbound", "Social", "Tasks", "Filtros", "Métricas", "Settings"] as Tab[]).map((t) => (
          <button
            key={t}
            className={cx(
              "text-[11px] px-3 py-1.5 rounded-full border transition-all duration-200 font-medium",
              tab === t
                ? "border-[rgba(234,124,48,0.6)] bg-[rgba(234,124,48,0.10)] text-[rgb(var(--accent))] animate-[ignis-pulse_3s_ease-in-out_infinite]"
                : "border-white/10 bg-white/5 text-zinc-400 hover:bg-white/10 hover:border-[rgba(234,124,48,0.5)] hover:text-[rgb(var(--text))]",
            )}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button
          className="text-xs px-3 py-2 rounded-full border border-white/10 bg-white/5 text-zinc-300 hover:bg-white/10 hover:border-[rgba(234,124,48,0.45)] transition-all"
          onClick={() => void captureFromCurrentTab()}
          disabled={!activeBoard}
        >
          Capturar lead da aba atual
        </button>

        <button
          className="text-xs px-3 py-2 rounded-full border border-white/10 bg-white/5 text-zinc-300 hover:bg-white/10 hover:border-[rgba(234,124,48,0.45)] transition-all"
          onClick={() => void openOrFocusDashboard()}
        >
          Abrir Kanban
        </button>
      </div>

      {tab === "Métricas" ? (
        <MetricsPanel workspaceId={workspaceId} toast={toast} openDashboard={openOrFocusDashboard} />
      ) : activeBoard ? (
        <>
          <div className="mt-3 flex items-center gap-2">
            <input
              className="text-xs w-full px-4 py-2.5 rounded-xl bg-black/50 border border-white/10 outline-none focus:border-[#ea7c30] focus:shadow-[0_0_0_3px_rgba(234,124,48,0.12)] transition-all"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar…"
            />
          </div>

          <div className="mt-2 flex items-center gap-2">
            <div className="text-[11px] text-[rgb(var(--muted))] shrink-0">Filtrar por dia:</div>

            <input
              type="date"
              value={dayFilter}
              onChange={(e) => setDayFilter(e.target.value)}
              className="text-xs w-full px-4 py-2.5 rounded-xl bg-black/50 border border-white/10 outline-none focus:border-[#ea7c30] focus:shadow-[0_0_0_3px_rgba(234,124,48,0.12)] transition-all"
              title="Mostra somente leads adicionados no dia selecionado"
            />

            <button
              type="button"
              className="text-xs px-3 py-2 rounded-full border border-white/10 bg-white/5 text-zinc-300 hover:bg-white/10 hover:border-[rgba(234,124,48,0.45)] transition-all"
              onClick={() => setDayFilter(todayAsInputDate())}
              title="Filtrar por hoje"
            >
              Hoje
            </button>

            {dayFilter ? (
              <button
                type="button"
                className="text-xs px-3 py-2 rounded-full border border-white/10 bg-white/5 text-zinc-300 hover:bg-white/10 hover:border-[rgba(234,124,48,0.45)] transition-all"
                onClick={() => setDayFilter("")}
                title="Remover filtro de dia"
              >
                Limpar
              </button>
            ) : null}
          </div>

          <div className="mt-4 border border-white/10 rounded-xl overflow-hidden">
            <div className="px-4 py-2.5 text-xs font-semibold border-b border-white/10 bg-white/[0.025]">
              Leads para abordar ({filtered.length}){dayLabel ? ` • ${dayLabel}` : ""}
            </div>

            <div className="p-3 flex flex-col gap-2.5">
              {filtered.map((l) => {
                const firstLetter = (String(l.username || "?")[0] || "?").toUpperCase();

                return (
                  <div
                    key={l.id}
                    className="p-3 rounded-xl border border-white/10 bg-white/5 transition-all duration-200 hover:border-[rgba(234,124,48,0.28)] hover:bg-white/[0.07]"
                  >
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-full border border-[rgba(234,124,48,0.3)] bg-[rgba(234,124,48,0.08)] grid place-items-center text-[10px] font-black text-[rgb(var(--accent))]">
                        {firstLetter}
                      </div>

                      <div className="flex-1">
                        <button
                          type="button"
                          className="text-xs font-extrabold hover:underline text-left"
                          onClick={() => openInstagramProfile(l.username)}
                          title="Abrir perfil no Instagram"
                        >
                          @{l.username}
                        </button>

                        <div className="text-[11px] text-[rgb(var(--muted))]">
                          {stageLabel(normalizeStageId(String(l.stageId || "")))}
                        </div>
                      </div>

                      <button
                        className="text-[11px] px-2 py-1 rounded-full border border-white/10 bg-white/5 text-zinc-400 hover:bg-white/10 hover:border-[rgba(234,124,48,0.4)] transition-all"
                        onClick={() => void onDelete(l.id, l.username)}
                      >
                        Remover
                      </button>
                    </div>
                  </div>
                );
              })}

              {filtered.length === 0 ? (
                <div className="text-xs text-[rgb(var(--muted))] mt-2">Nenhum lead encontrado.</div>
              ) : null}
            </div>
          </div>
        </>
      ) : (
        <div className="mt-3">
          {tab === "Settings" ? (
            <div className="flex flex-col gap-3">
              <ExtensionSettingsPanel />
              <BackupRestorePanel />
            </div>
          ) : (
            <div className="text-xs text-[rgb(var(--muted))]">
              Aba <span className="font-bold">{tab}</span> (em construção).
            </div>
          )}
        </div>
      )}

      {toastState ? (
        <div className="fixed right-3 bottom-3 z-50">
          <div className="text-xs font-bold px-3 py-2 rounded-xl border border-white/10 bg-white/10 backdrop-blur shadow-[var(--shadow-sm)] flex items-center gap-2">
            <div>{toastState.message}</div>
            {toastState.actionLabel && toastState.onAction ? (
              <button
                type="button"
                className="text-[11px] px-2 py-1 rounded-full border border-white/10 bg-white/5 text-zinc-400 hover:bg-white/10 hover:border-[rgba(234,124,48,0.4)] transition-all"
                onClick={() => {
                  try {
                    toastState.onAction?.();
                  } finally {
                    setToastState(null);
                  }
                }}
              >
                {toastState.actionLabel}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// =============================================================
// MÉTRICAS
// =============================================================

type MetricNumericField =
  | "msg1Disparos"
  | "msg1Respostas"
  | "msg2Disparos"
  | "msg2Respostas"
  | "ctaDisparos"
  | "agendNovos"
  | "followEnviados"
  | "followRespostas"
  | "followCta"
  | "agendFollow";

type SaveStatus = "idle" | "saving" | "saved" | "error";

interface SectionProps {
  title: string;
  children: React.ReactNode;
  right?: React.ReactNode;
  headerRight?: React.ReactNode;
}

interface SaveStatusPillProps {
  status: SaveStatus;
  isClosed: boolean;
}

function SaveStatusPill({ status, isClosed }: SaveStatusPillProps) {
  if (isClosed) {
    return (
      <div className="text-[11px] font-mono px-3 py-2 rounded-full border border-white/10 bg-white/5 text-[rgb(var(--muted))]">
        🔒 Bloqueado
      </div>
    );
  }

  let label: string;
  let tone: string;
  switch (status) {
    case "saving":
      label = "Salvando…";
      tone = "border-[rgb(var(--accent))] text-[rgb(var(--accent))]";
      break;
    case "saved":
      label = "✓ Salvo";
      tone = "border-[rgb(var(--border))] text-[rgb(var(--muted))]";
      break;
    case "error":
      label = "⚠ Erro";
      tone = "border-red-600 text-red-400";
      break;
    default:
      label = "Auto-save";
      tone = "border-[rgb(var(--border))] text-[rgb(var(--muted))]";
  }

  return (
    <div
      aria-live="polite"
      className={cx(
        "text-[11px] font-mono px-3 py-2 rounded-full border bg-white/5 min-w-[84px] text-center transition-colors",
        tone,
      )}
    >
      {label}
    </div>
  );
}

function Section({ title, children, right, headerRight }: SectionProps) {
  return (
    <div className="mt-3 border border-[rgb(var(--border))]/80 rounded-[var(--radius)] overflow-hidden bg-[rgb(var(--panel))]/50 backdrop-blur-sm transition-all duration-300 hover:border-[rgba(234,124,48,0.28)] hover:shadow-[0_0_20px_rgba(234,124,48,0.07)]">
      <div className="px-3 py-2 text-[10px] font-bold uppercase tracking-widest border-b border-[rgb(var(--border))]/60 bg-white/[0.025] flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="text-[rgb(var(--muted))] shrink-0">{title}</div>
          {right ? <div className="text-[10px] text-[rgb(var(--muted))]/60 font-normal normal-case tracking-normal truncate">{right}</div> : null}
        </div>
        {headerRight ? <div className="shrink-0">{headerRight}</div> : null}
      </div>
      <div className="p-2">{children}</div>
    </div>
  );
}

interface CtaRegisterRowProps {
  count: number;
  disabled?: boolean;
  hasCta: boolean;
  onClick: () => void;
}

function CtaRegisterRow({ count, disabled, hasCta, onClick }: CtaRegisterRowProps) {
  return (
    <div className="flex items-center gap-2 py-1">
      <div className="flex-1">
        <div className="text-xs">CTA FEITO (follow)</div>
      </div>
      <input
        disabled
        className="text-xs w-20 px-2 py-2 rounded-xl bg-black/50 border border-white/10 opacity-60"
        value={String(count)}
        readOnly
      />
      <button
        type="button"
        disabled={disabled}
        className={cx(
          "text-[11px] px-3 py-2 rounded-full border border-white/10 bg-white/5 text-zinc-300 hover:bg-white/10 hover:border-[rgba(234,124,48,0.45)] transition-all w-[130px] text-center",
          disabled ? "opacity-50" : "",
        )}
        onClick={onClick}
        title={hasCta ? "Editar CTA" : "(Add)"}
      >
        {hasCta ? "Editar CTA" : "(Add)"}
      </button>
    </div>
  );
}

interface WeekPanelProps {
  open: boolean;
  weekRows: Array<{ dateKey: string; metrics: DailyMetrics | null }>;
}

function WeekPanel({ open, weekRows }: WeekPanelProps) {
  if (!open) return null;
  return (
    <div className="mt-3 border border-white/10 rounded-xl overflow-hidden">
      <div className="px-3 py-2.5 text-xs font-semibold border-b border-white/10 bg-white/[0.025]">Semana</div>
      <div className="p-2 flex flex-col gap-2">
        {weekRows.map((r) => {
          const m = r.metrics;
          const contatosTotal = m ? safeInt(m.msg1Disparos) + safeInt(m.followEnviados) : 0;
          const agendTotal = m ? safeInt(m.agendNovos) + safeInt(m.agendFollow) : 0;
          const pctAg = pct(agendTotal, contatosTotal);
          const label = `${shortDayLabel(r.dateKey)} • ${r.dateKey.split("-").reverse().join("/")}`;
          return (
            <details
              key={r.dateKey}
              className="rounded-xl border border-white/10 bg-white/5"
              open={false}
            >
              <summary className="cursor-pointer list-none p-2 flex items-center justify-between gap-2">
                <div className="text-xs font-bold">{label}</div>
                <div className="text-[11px] text-[rgb(var(--muted))]">
                  Contatos: <span className="font-bold">{contatosTotal}</span> • Agend.:{" "}
                  <span className="font-bold">{agendTotal}</span> • {fmtPct2(pctAg)}
                </div>
              </summary>
              <div className="p-2 text-[11px] text-[rgb(var(--muted))]">
                {m ? (
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <div className="font-bold text-[rgb(var(--text))]">Novas</div>
                      <div>Msg1: {m.msg1Disparos} | Resp1: {m.msg1Respostas} ({fmtPctInt(pct(m.msg1Respostas, m.msg1Disparos))})</div>
                      <div>Msg2: {m.msg2Disparos} | Resp2: {m.msg2Respostas} ({fmtPctInt(pct(m.msg2Respostas, m.msg2Disparos))})</div>
                      <div>CTA: {m.ctaDisparos} | Agend: {m.agendNovos} ({fmtPct2(pct(m.agendNovos, m.ctaDisparos))})</div>
                    </div>
                    <div>
                      <div className="font-bold text-[rgb(var(--text))]">Follow</div>
                      <div>Follow: {m.followEnviados} | Resp: {m.followRespostas}</div>
                      <div>CTA: {m.followCta} | Agend: {m.agendFollow}</div>
                    </div>
                  </div>
                ) : (
                  <div>Sem dados</div>
                )}
              </div>
            </details>
          );
        })}
      </div>
    </div>
  );
}

interface CtaRegisterSheetProps {
  open: boolean;
  busy: boolean;
  ctaUrl: string;
  setCtaUrl: (v: string) => void;
  ctaNote: string;
  setCtaNote: (v: string) => void;
  ctaUrlIsValid: boolean;
  mismatchConfirm: { url: string; note: string; linkUser: string; leadUser: string } | null;
  setMismatchConfirm: (v: { url: string; note: string; linkUser: string; leadUser: string } | null) => void;
  disableInputs: boolean;
  onClose: () => void;
  onPasteFromActiveTab: () => Promise<void>;
  onOpenCtaLink: () => Promise<void>;
  onSaveAndMoveCta: (forceMismatchOk: boolean) => Promise<void>;
}

function CtaRegisterSheet({
  open,
  busy,
  ctaUrl,
  setCtaUrl,
  ctaNote,
  setCtaNote,
  ctaUrlIsValid,
  mismatchConfirm,
  setMismatchConfirm,
  disableInputs,
  onClose,
  onPasteFromActiveTab,
  onOpenCtaLink,
  onSaveAndMoveCta,
}: CtaRegisterSheetProps) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      <div
        className="absolute inset-0 bg-black/60"
        onClick={() => { if (busy) return; setMismatchConfirm(null); onClose(); }}
      />
      <div className="relative w-full max-w-[420px] bg-[#09090b] border border-white/10 rounded-t-[16px] p-4 backdrop-blur-xl">
        <div className="flex items-center justify-between gap-2 mb-2">
          <div className="text-sm font-bold">Registrar CTA</div>
          <button
            type="button"
            className={cx(
              "text-[11px] px-2 py-1 rounded-full border border-white/10 bg-white/5 text-zinc-400 hover:bg-white/10 hover:border-[rgba(234,124,48,0.4)] transition-all",
              busy ? "opacity-50 cursor-not-allowed" : "",
            )}
            onClick={() => { if (busy) return; setMismatchConfirm(null); onClose(); }}
          >
            Fechar
          </button>
        </div>
        <div className="flex flex-col gap-2">
          <div>
            <div className="text-xs font-bold mb-1">URL do perfil/DM (obrigatório)</div>
            <input
              value={ctaUrl}
              onChange={(e) => setCtaUrl(e.target.value)}
              placeholder="Cole o link do perfil ou da DM..."
              className={cx(
                "w-full text-xs px-4 py-2.5 rounded-xl bg-black/50 border border-white/10 outline-none focus:border-[#ea7c30] focus:shadow-[0_0_0_3px_rgba(234,124,48,0.12)] transition-all",
                !ctaUrl || ctaUrlIsValid ? "" : "border-red-500/60",
              )}
            />
            {!ctaUrl ? null : !ctaUrlIsValid ? (
              <div className="text-[11px] text-red-400 mt-1">URL precisa ser do Instagram.</div>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="text-[11px] px-3 py-2 rounded-full border border-white/10 bg-white/5 text-zinc-300 hover:bg-white/10 hover:border-[rgba(234,124,48,0.4)] transition-all"
              onClick={() => void onPasteFromActiveTab()}
            >
              Colar da aba atual
            </button>
            <button
              type="button"
              className={cx(
                "text-[11px] px-3 py-2 rounded-full border border-white/10 bg-white/5 text-zinc-300 hover:bg-white/10 hover:border-[rgba(234,124,48,0.4)] transition-all",
                !ctaUrl ? "opacity-50 cursor-not-allowed" : "",
              )}
              onClick={() => void onOpenCtaLink()}
              disabled={!ctaUrl}
            >
              Abrir link
            </button>
          </div>
          <div>
            <div className="text-xs font-bold mb-1">Observação rápida (opcional)</div>
            <textarea
              value={ctaNote}
              onChange={(e) => setCtaNote(e.target.value)}
              rows={3}
              className="w-full text-xs px-4 py-2.5 rounded-xl bg-black/50 border border-white/10 outline-none focus:border-[#ea7c30] focus:shadow-[0_0_0_3px_rgba(234,124,48,0.12)] transition-all"
            />
          </div>
          {mismatchConfirm ? (
            <div className="p-2 rounded-xl border border-yellow-500/50 bg-yellow-500/10">
              <div className="text-xs font-bold text-yellow-200 mb-1">Atenção</div>
              <div className="text-[11px] text-yellow-100">Esse link parece ser de outro perfil. Quer salvar mesmo?</div>
              <div className="text-[11px] text-[rgb(var(--muted))] mt-1">
                Link: <span className="font-bold">@{mismatchConfirm.linkUser}</span> • Lead: <span className="font-bold">@{mismatchConfirm.leadUser}</span>
              </div>
              <div className="flex items-center gap-2 mt-2">
                <button
                  type="button"
                  className={cx("text-[11px] px-3 py-2 rounded-full border border-white/10 bg-white/5 text-zinc-300 hover:bg-white/10 hover:border-[rgba(234,124,48,0.4)] transition-all", busy ? "opacity-50 cursor-not-allowed" : "")}
                  onClick={() => { if (busy) return; setMismatchConfirm(null); }}
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  className={cx("text-[11px] px-3 py-2 rounded-full border border-white/10 bg-white/5 text-zinc-300 hover:bg-white/10 hover:border-[rgba(234,124,48,0.4)] transition-all", busy ? "opacity-50 cursor-not-allowed" : "")}
                  onClick={() => void onSaveAndMoveCta(true)}
                >
                  Salvar mesmo
                </button>
              </div>
            </div>
          ) : null}
          <button
            type="button"
            disabled={disableInputs || busy || !ctaUrlIsValid || !ctaUrl.trim()}
            className={cx(
              "text-xs font-bold px-4 py-3 rounded-full bg-[#ea7c30] text-black border-none neon-button transition-all",
              disableInputs || busy || !ctaUrlIsValid || !ctaUrl.trim() ? "opacity-50 cursor-not-allowed" : "hover:opacity-90",
            )}
            onClick={() => void onSaveAndMoveCta(false)}
          >
            {busy ? "Salvando…" : "Salvar e mover para CTA"}
          </button>
        </div>
      </div>
    </div>
  );
}

function MetricsPanel({
  workspaceId,
  toast,
  openDashboard,
}: {
  workspaceId: string;
  toast: (msg: string, action?: { label: string; onClick: () => void }) => void;
  openDashboard: () => Promise<void>;
}) {
  const [board, setBoard] = React.useState<BoardType>("OUTBOUND");
  const [dateKey, setDateKey] = React.useState<string>(todayDateKey());
  const [metrics, setMetrics] = React.useState<DailyMetrics | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [showMsg2Resp, setShowMsg2Resp] = React.useState(false);
  const [saveStatus, setSaveStatus] = React.useState<SaveStatus>("idle");
  const [weekOpen, setWeekOpen] = React.useState(false);
  const [weekRows, setWeekRows] = React.useState<Array<{ dateKey: string; metrics: DailyMetrics | null }>>([]);

  // Auto-save infrastructure
  // - pendingCountRef: N in-flight writes; status only flips to "saved" when it hits 0.
  // - savedResetTimerRef: holds the "saved → idle" timeout so it can be cancelled on new writes.
  // - contextRef: current (board, dateKey) — read AFTER save resolves so we can decide
  //   whether to reconcile local state with the DB result or discard it (if user
  //   switched context during the async write).
  const pendingCountRef = React.useRef(0);
  const savedResetTimerRef = React.useRef<number | null>(null);
  const contextRef = React.useRef({ board, dateKey });
  React.useEffect(() => {
    contextRef.current = { board, dateKey };
  }, [board, dateKey]);
  React.useEffect(() => {
    return () => {
      if (savedResetTimerRef.current) {
        window.clearTimeout(savedResetTimerRef.current);
        savedResetTimerRef.current = null;
      }
    };
  }, []);

  // =============================================================
  // CTA (registro unificado)
  // =============================================================
  const [activeLead, setActiveLead] = React.useState<Lead | null>(null);
  const [ctaMetricKey, setCtaMetricKey] = React.useState<"followCta" | "ctaDisparos">("followCta");
  const [ctaSheetOpen, setCtaSheetOpen] = React.useState(false);
  const [ctaUrl, setCtaUrl] = React.useState<string>("");
  const [ctaNote, setCtaNote] = React.useState<string>("");
  const [ctaBusy, setCtaBusy] = React.useState(false);
  const [mismatchConfirm, setMismatchConfirm] = React.useState<
    | {
        url: string;
        note: string;
        linkUser: string;
        leadUser: string;
      }
    | null
  >(null);

  const computed = React.useMemo(() => {
    const m = metrics;
    if (!m) {
      return {
        pctMsg1: 0,
        pctMsg2: 0,
        pctCta: 0,
        agendTotal: 0,
        contatosTotal: 0,
        pctAgendAcoes: 0,
      };
    }

    const pctMsg1 = pct(safeInt(m.msg1Respostas), safeInt(m.msg1Disparos));
    const pctMsg2 = pct(safeInt(m.msg2Respostas), safeInt(m.msg2Disparos));
    const pctCta = pct(safeInt(m.agendNovos), safeInt(m.ctaDisparos));
    const agendTotal = safeInt(m.agendNovos) + safeInt(m.agendFollow);
    const contatosTotal = safeInt(m.msg1Disparos) + safeInt(m.followEnviados);
    const pctAgendAcoes = pct(agendTotal, contatosTotal);
    return { pctMsg1, pctMsg2, pctCta, agendTotal, contatosTotal, pctAgendAcoes };
  }, [metrics]);

  async function load(dateKeyArg: string, boardArg: BoardType) {
    setBusy(true);
    try {
      const existing = await getDailyMetrics(workspaceId, boardArg, dateKeyArg);
      const base = existing ?? emptyDailyMetrics(workspaceId, boardArg, dateKeyArg);
      setMetrics(base);
      setShowMsg2Resp((base.msg2Respostas ?? 0) > 0);
    } catch (err) {
      console.error(err);
      toast("Erro ao carregar métricas (veja o Console).");
    } finally {
      setBusy(false);
    }
  }

  React.useEffect(() => {
    void load(dateKey, board);
  }, [dateKey, board]);

  // Resolve o lead "atual" (aba ativa do Instagram) para definir o estado do botão Registrar/Editar CTA
  React.useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const ctx = await resolveActiveLeadContext({ workspaceId });
        if (cancelled) return;
        setActiveLead(ctx?.lead ?? null);
      } catch {
        if (cancelled) return;
        setActiveLead(null);
      }
    };
    void tick();
    const id = window.setInterval(() => {
      void tick();
    }, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [workspaceId]);

  async function openCtaSheet(metricKey: "followCta" | "ctaDisparos" = "followCta") {
    if (metrics?.closedAt) return;

    setCtaMetricKey(metricKey);

    const ctx = await resolveActiveLeadContext({ workspaceId });
    if (!ctx?.lead) {
      toast("Não encontrei o lead dessa conversa/perfil no CRM. Capture o lead antes.");
      return;
    }

    setActiveLead(ctx.lead);
    setMismatchConfirm(null);

    const initialUrl = ctx.lead.ctaUrl || ctx.tabUrl || "";
    const initialNote = ctx.lead.ctaNote || "";

    setCtaUrl(initialUrl);
    setCtaNote(initialNote);
    setCtaSheetOpen(true);
  }

  async function handlePasteFromActiveTab() {
    const tab = await queryActiveTab();
    const url = tab?.url || "";
    if (!url) {
      toast("Não consegui ler a URL da aba ativa.");
      return;
    }
    setCtaUrl(url);
  }

  async function handleOpenCtaLink() {
    if (!ctaUrl) return;
    try {
      // valida URL básica
      const u = new URL(ctaUrl);
      await chrome.tabs.create({ url: u.toString() });
    } catch {
      toast("URL inválida.");
    }
  }

  const ctaUrlIsValid = React.useMemo(() => isInstagramUrl(ctaUrl), [ctaUrl]);

  async function handleSaveAndMoveCta(forceMismatchOk: boolean) {
    const url = ctaUrl.trim();
    const note = ctaNote.trim();

    if (!url) return;
    if (!isInstagramUrl(url)) return;

    const ctx = await resolveActiveLeadContext({ workspaceId });
    const lead = ctx?.lead || activeLead;
    if (!lead) {
      toast("Não encontrei o lead dessa conversa/perfil no CRM. Capture o lead antes.");
      return;
    }

    // mismatch: só aplicável para URL de perfil
    const linkUser = extractProfileUsernameFromUrl(url);
    const leadUser = String(lead.username || "");

    if (!forceMismatchOk && linkUser && leadUser && linkUser.toLowerCase() !== leadUser.toLowerCase()) {
      setMismatchConfirm({ url, note, linkUser, leadUser });
      return;
    }

    setMismatchConfirm(null);
    setCtaBusy(true);
    try {
      const result = await registerCtaAndMove({
        workspaceId,
        leadId: lead.id,
        ctaUrl: url,
        ctaNote: note || undefined,
        toStageId: "CTA_REALIZADO",
      });

      if (!result) {
        toast("Não consegui registrar o CTA (lead não encontrado).");
        return;
      }

      // Atualiza lead ativo no SidePanel
      setActiveLead(result.lead);

      // Registra a métrica somente se foi o 1º CTA do lead (sem duplicar em edição)
      // - Se o CTA foi registrado pela seção Follow-up → incrementa followCta
      // - Se o CTA foi registrado pela seção CTA (Novos) → incrementa ctaDisparos
      if (result.wasFirstCta) {
        const base = metrics ?? emptyDailyMetrics(workspaceId, board, dateKey);
        const current = safeInt((base as any)[ctaMetricKey]);
        const next = { ...base, [ctaMetricKey]: current + 1 } as DailyMetrics;
        const saved = await upsertDailyMetrics(next);
        setMetrics(saved);
      }

      setCtaSheetOpen(false);
      toast("CTA registrado e lead movido para 'CTA' ✅", {
        label: "Abrir no Kanban",
        onClick: () => {
          void openDashboard();
        },
      });
    } catch (err) {
      console.error(err);
      toast("Erro ao registrar CTA (veja o Console).");
    } finally {
      setCtaBusy(false);
    }
  }

  function beginSave() {
    pendingCountRef.current += 1;
    if (savedResetTimerRef.current) {
      window.clearTimeout(savedResetTimerRef.current);
      savedResetTimerRef.current = null;
    }
    setSaveStatus("saving");
  }

  function endSave(outcome: "ok" | "closed" | "error") {
    pendingCountRef.current = Math.max(0, pendingCountRef.current - 1);
    if (pendingCountRef.current > 0) return;
    if (outcome === "error") {
      setSaveStatus("error");
      return;
    }
    if (outcome === "closed") {
      setSaveStatus("idle");
      return;
    }
    setSaveStatus("saved");
    if (savedResetTimerRef.current) window.clearTimeout(savedResetTimerRef.current);
    savedResetTimerRef.current = window.setTimeout(() => {
      setSaveStatus((prev) => (prev === "saved" ? "idle" : prev));
      savedResetTimerRef.current = null;
    }, 1500);
  }

  // autoSave captura o snapshot (workspaceId, board, dateKey) no instante
  // da chamada — que corresponde ao instante em que o usuário digitou, já
  // que o MetricInput fixa a referência de onChange ao disparar o debounce.
  // Assim o write sempre cai na linha certa mesmo se o usuário trocar
  // data/aba antes do debounce estourar.
  // O repo faz upsert dentro de transação Dexie, relê closedAt e aborta
  // se o dia foi fechado no meio tempo (vs. sobrescrever histórico).
  async function autoSave(key: MetricNumericField, v: number): Promise<void> {
    const snapshot = { workspaceId, board, dateKey };
    beginSave();
    try {
      const result = await upsertDailyMetricsGuarded({
        workspaceId: snapshot.workspaceId,
        board: snapshot.board,
        dateKey: snapshot.dateKey,
        [key]: safeInt(v),
      });
      const sameContext =
        contextRef.current.board === snapshot.board &&
        contextRef.current.dateKey === snapshot.dateKey;
      if (result.status === "closed") {
        if (sameContext) setMetrics(result.metrics);
        toast("Dia fechado — edição bloqueada. Reabra para editar.");
        endSave("closed");
        return;
      }
      if (sameContext) setMetrics(result.metrics);
      endSave("ok");
    } catch (err) {
      console.error(err);
      toast("Erro no auto-save da métrica (veja o Console).");
      endSave("error");
    }
  }

  function makeOnChange(key: MetricNumericField) {
    return (v: number): Promise<void> => autoSave(key, v);
  }

  function incField(key: MetricNumericField, step: number) {
    if (!metrics || busy || isClosed) return;
    const current = safeInt((metrics as any)[key]);
    const next = safeInt(current + step);
    // Update local state otimista → feedback instantâneo no +1/+5.
    // autoSave reconcilia com o resultado do banco (ou aborta se dia fechado).
    setMetrics({ ...metrics, [key]: next } as DailyMetrics);
    void autoSave(key, next);
  }

  async function handleClose() {
    try {
      setBusy(true);
      const closed = await closeDailyMetrics(workspaceId, board, dateKey);
      setMetrics(closed);
      toast("✅ Dia fechado");
    } catch (err) {
      console.error(err);
      toast("Erro ao fechar o dia (veja o Console).");
    } finally {
      setBusy(false);
    }
  }

  async function handleReopen() {
    try {
      setBusy(true);
      const reopened = await reopenDailyMetrics(workspaceId, board, dateKey);
      if (reopened) {
        setMetrics(reopened);
        toast("Dia reaberto");
      }
    } catch (err) {
      console.error(err);
      toast("Erro ao reabrir o dia (veja o Console).");
    } finally {
      setBusy(false);
    }
  }

  async function toggleWeek() {
    const next = !weekOpen;
    setWeekOpen(next);
    if (!next) return;
    try {
      setBusy(true);
      const rows = await getWeekMetrics(workspaceId, board, dateKey);
      setWeekRows(rows);
    } catch (err) {
      console.error(err);
      toast("Erro ao carregar semana (veja o Console).");
    } finally {
      setBusy(false);
    }
  }

  const isClosed = Boolean(metrics?.closedAt);
  const disableInputs = busy || isClosed;


  async function handleCopyForSheets() {
    if (!metrics) return;

    // Ordem EXATA do Sheets (A → P):
    // A dia da semana
    // B Disparos Msg1
    // C Respostas Msg1
    // D % Resp Msg1
    // E Disparos Msg2
    // F % Resp Msg2
    // G DISPARO CTA
    // H Agendamentos (Novos)
    // I Conversão CTA vs Agendamento
    // J follow up
    // K resposta followup
    // L CTA FEITO
    // M Agendamentos (Follow)
    // N agendamento total
    // O % de agendamentos sob ações totais
    // P contatos totais no dia (Novos + Follow Ups)

    const A = fullDayNamePT(dateKey);
    const B = safeInt(metrics.msg1Disparos);
    const C = safeInt(metrics.msg1Respostas);
    const D = fmtPctInt(computed.pctMsg1);
    const E = safeInt(metrics.msg2Disparos);
    const F = fmtPctInt(computed.pctMsg2);
    const G = safeInt(metrics.ctaDisparos);
    const H = safeInt(metrics.agendNovos);
    const I = fmtPct2(computed.pctCta);
    const J = safeInt(metrics.followEnviados);
    const K = safeInt(metrics.followRespostas);
    const L = safeInt(metrics.followCta);
    const M = safeInt(metrics.agendFollow);
    const N = safeInt(computed.agendTotal);
    const O = fmtPct2(computed.pctAgendAcoes);
    const P = safeInt(computed.contatosTotal);

    const tsv = [A, B, C, D, E, F, G, H, I, J, K, L, M, N, O, P].join("\t") + "\n";
    const ok = await copyToClipboard(tsv);
    if (ok) toast("📋 Copiado! Cole no Sheets (coluna A da linha do dia)");
    else toast("Não consegui copiar. Tente novamente.");
  }


  return (
    <div className="mt-3">
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-2 flex-1">
          <div className="text-[11px] text-[rgb(var(--muted))] shrink-0">Data:</div>
          <input
            type="date"
            value={dateKey}
            onChange={(e) => setDateKey(e.target.value || todayDateKey())}
            className="text-xs w-full px-4 py-2.5 rounded-xl bg-black/50 border border-white/10 outline-none focus:border-[#ea7c30] focus:shadow-[0_0_0_3px_rgba(234,124,48,0.12)] transition-all"
            disabled={busy}
          />
        </div>

        <SaveStatusPill status={saveStatus} isClosed={isClosed} />

        {isClosed ? (
          <button
            className={cx(
              "text-xs px-3 py-2 rounded-full border border-white/10 bg-white/5 text-zinc-300 hover:bg-white/10 hover:border-[rgba(234,124,48,0.45)] transition-all",
              busy ? "opacity-60" : "",
            )}
            onClick={() => void handleReopen()}
            disabled={busy}
            title="Reabrir para editar"
          >
            Reabrir
          </button>
        ) : (
          <button
            className={cx(
              "text-xs px-3 py-2 rounded-full border border-white/10 bg-white/5 text-zinc-300 hover:bg-white/10 hover:border-[rgba(234,124,48,0.45)] transition-all",
              busy ? "opacity-60" : "",
            )}
            onClick={() => void handleClose()}
            disabled={busy}
          >
            Fechar dia
          </button>
        )}
      </div>

      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="flex gap-2">
          {([
            { label: "Outbound", value: "OUTBOUND" as const },
            { label: "Social", value: "SOCIAL" as const },
          ] as const).map((opt) => (
            <button
              key={opt.value}
              className={cx(
                "text-xs px-3 py-1.5 rounded-full border transition-all duration-200",
                board === opt.value
                  ? "border-[rgba(234,124,48,0.6)] bg-[rgba(234,124,48,0.10)] text-[rgb(var(--accent))]"
                  : "border-white/10 bg-white/5 text-zinc-400 hover:bg-white/10 hover:border-[rgba(234,124,48,0.4)] hover:text-[rgb(var(--text))]",
              )}
              onClick={() => setBoard(opt.value)}
              disabled={busy}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <button
          type="button"
          className="text-xs text-[rgb(var(--accent))] hover:underline"
          onClick={() => void toggleWeek()}
          disabled={busy}
        >
          {weekOpen ? "Fechar semana" : "Ver semana"} →
        </button>
      </div>

      {isClosed ? (
        <div className="mt-2 text-[11px] text-[rgb(var(--muted))]">✅ Dia fechado • edição bloqueada</div>
      ) : null}

      <Section title="Novas abordagens" right={`% Resp Msg1: ${fmtPctInt(computed.pctMsg1)} • % Resp Msg2: ${fmtPctInt(computed.pctMsg2)}`}>
        {metrics ? (
          <>
            <div className="text-[11px] text-[rgb(var(--muted))] mb-1">Mensagem 1 (primeiro contato)</div>
            <MetricInput
              label="Disparos Mensagem 1"
              value={safeInt(metrics.msg1Disparos)}
              onChange={makeOnChange("msg1Disparos")}
              onInc1={() => incField("msg1Disparos", 1)}
              onInc5={() => incField("msg1Disparos", 5)}
              disabled={disableInputs}
            />
            <MetricInput
              label="Respostas Mensagem 1"
              value={safeInt(metrics.msg1Respostas)}
              onChange={makeOnChange("msg1Respostas")}
              onInc1={() => incField("msg1Respostas", 1)}
              onInc5={() => incField("msg1Respostas", 5)}
              disabled={disableInputs}
              hint={`% de Respostas (Msg 1): ${fmtPctInt(computed.pctMsg1)}`}
            />

            <div className="mt-2 text-[11px] text-[rgb(var(--muted))] mb-1">Mensagem 2</div>
            <MetricInput
              label="Disparos Mensagem 2"
              value={safeInt(metrics.msg2Disparos)}
              onChange={makeOnChange("msg2Disparos")}
              onInc1={() => incField("msg2Disparos", 1)}
              onInc5={() => incField("msg2Disparos", 5)}
              disabled={disableInputs}
              hint={`% de Respostas (Msg 2): ${fmtPctInt(computed.pctMsg2)}`}
            />

            {!showMsg2Resp ? (
              <button
                type="button"
                className="mt-1 text-[11px] text-[rgb(var(--accent))] hover:underline"
                onClick={() => setShowMsg2Resp(true)}
                disabled={disableInputs}
              >
                + (Opcional) Adicionar respostas Msg 2
              </button>
            ) : (
              <MetricInput
                label="Respostas Msg 2"
                value={safeInt(metrics.msg2Respostas)}
                onChange={makeOnChange("msg2Respostas")}
                onInc1={() => incField("msg2Respostas", 1)}
                onInc5={() => incField("msg2Respostas", 5)}
                disabled={disableInputs}
              />
            )}
          </>
        ) : (
          <div className="text-xs text-[rgb(var(--muted))]">Carregando…</div>
        )}
      </Section>

      <Section
        title="CTA → Agendamento (Novos)"
        right={`Conversão (CTA→Agendamento): ${fmtPct2(computed.pctCta)}`}
        headerRight={
          <button
            type="button"
            disabled={disableInputs}
            className={cx(
              "text-[11px] px-3 py-1.5 rounded-full border border-white/10 bg-white/5 text-zinc-300 hover:bg-white/10 hover:border-[rgba(234,124,48,0.45)] transition-all w-[130px] text-center",
              disableInputs ? "opacity-50" : "",
            )}
            onClick={() => void openCtaSheet("ctaDisparos")}
            title={activeLead?.ctaAt ? "Editar CTA" : "(Add)"}
          >
            {activeLead?.ctaAt ? "Editar CTA" : "(Add)"}
          </button>
        }
      >
        {metrics ? (
          <>
            <MetricInput
              label="DISPARO CTA"
              value={safeInt(metrics.ctaDisparos)}
              onChange={makeOnChange("ctaDisparos")}
              onInc1={() => incField("ctaDisparos", 1)}
              onInc5={() => incField("ctaDisparos", 5)}
              disabled={disableInputs}
            />
            <MetricInput
              label="Agendamentos (Novos)"
              value={safeInt(metrics.agendNovos)}
              onChange={makeOnChange("agendNovos")}
              onInc1={() => incField("agendNovos", 1)}
              onInc5={() => incField("agendNovos", 5)}
              disabled={disableInputs}
            />
          </>
        ) : null}
      </Section>

      <Section title="Follow-up">
        {metrics ? (
          <>
            <MetricInput
              label="Follow up"
              value={safeInt(metrics.followEnviados)}
              onChange={makeOnChange("followEnviados")}
              onInc1={() => incField("followEnviados", 1)}
              onInc5={() => incField("followEnviados", 5)}
              disabled={disableInputs}
            />
            <MetricInput
              label="Resposta followup"
              value={safeInt(metrics.followRespostas)}
              onChange={makeOnChange("followRespostas")}
              onInc1={() => incField("followRespostas", 1)}
              onInc5={() => incField("followRespostas", 5)}
              disabled={disableInputs}
            />
            <CtaRegisterRow
              count={safeInt(metrics.followCta)}
              disabled={disableInputs}
              hasCta={Boolean(activeLead?.ctaAt)}
              onClick={() => void openCtaSheet("followCta")}
            />
            <MetricInput
              label="Agendamentos (follow)"
              value={safeInt(metrics.agendFollow)}
              onChange={makeOnChange("agendFollow")}
              onInc1={() => incField("agendFollow", 1)}
              onInc5={() => incField("agendFollow", 5)}
              disabled={disableInputs}
            />
          </>
        ) : null}
      </Section>

      <Section
        title="Fechamento do dia (sequência do Sheets)"
        headerRight={
          <button
            type="button"
            className={cx(
              "text-[11px] px-2 py-1 rounded-full border border-white/10 bg-white/5 text-zinc-400 hover:bg-white/10 hover:border-[rgba(234,124,48,0.4)] transition-all",
              !metrics ? "opacity-50 cursor-not-allowed" : "",
            )}
            onClick={() => void handleCopyForSheets()}
            disabled={!metrics}
            title="Copia uma linha tabulada pronta para colar no Google Sheets (coluna A)"
          >
            Copiar para Sheets
          </button>
        }
      >
        {metrics ? (
          <div className="text-[11px] text-[rgb(var(--muted))] flex flex-col gap-1">
            <div className="text-xs text-[rgb(var(--text))] font-bold mb-1">
              Cole no Sheets na linha do dia (começando na coluna A)
            </div>

            <div><span className="text-[rgb(var(--text))] font-semibold">A</span> Dia da semana: <span className="font-bold text-[rgb(var(--text))]">{fullDayNamePT(dateKey)}</span></div>
            <div><span className="text-[rgb(var(--text))] font-semibold">B</span> Disparos Mensagem 1: <span className="font-bold text-[rgb(var(--text))]">{safeInt(metrics.msg1Disparos)}</span></div>
            <div><span className="text-[rgb(var(--text))] font-semibold">C</span> Respostas Mensagem 1: <span className="font-bold text-[rgb(var(--text))]">{safeInt(metrics.msg1Respostas)}</span></div>
            <div><span className="text-[rgb(var(--text))] font-semibold">D</span> % de Respostas (Msg 1): <span className="font-bold text-[rgb(var(--text))]">{fmtPctInt(computed.pctMsg1)}</span></div>
            <div><span className="text-[rgb(var(--text))] font-semibold">E</span> Disparos Mensagem 2: <span className="font-bold text-[rgb(var(--text))]">{safeInt(metrics.msg2Disparos)}</span></div>
            <div><span className="text-[rgb(var(--text))] font-semibold">F</span> % de Respostas (Msg 2): <span className="font-bold text-[rgb(var(--text))]">{fmtPctInt(computed.pctMsg2)}</span></div>
            <div><span className="text-[rgb(var(--text))] font-semibold">G</span> DISPARO CTA: <span className="font-bold text-[rgb(var(--text))]">{safeInt(metrics.ctaDisparos)}</span></div>
            <div><span className="text-[rgb(var(--text))] font-semibold">H</span> Agendamentos (Novos): <span className="font-bold text-[rgb(var(--text))]">{safeInt(metrics.agendNovos)}</span></div>
            <div><span className="text-[rgb(var(--text))] font-semibold">I</span> Conversão CTA vs Agendamento: <span className="font-bold text-[rgb(var(--text))]">{fmtPct2(computed.pctCta)}</span></div>
            <div><span className="text-[rgb(var(--text))] font-semibold">J</span> follow up: <span className="font-bold text-[rgb(var(--text))]">{safeInt(metrics.followEnviados)}</span></div>
            <div><span className="text-[rgb(var(--text))] font-semibold">K</span> resposta followup: <span className="font-bold text-[rgb(var(--text))]">{safeInt(metrics.followRespostas)}</span></div>
            <div><span className="text-[rgb(var(--text))] font-semibold">L</span> CTA FEITO: <span className="font-bold text-[rgb(var(--text))]">{safeInt(metrics.followCta)}</span></div>
            <div><span className="text-[rgb(var(--text))] font-semibold">M</span> Agendamentos (follow): <span className="font-bold text-[rgb(var(--text))]">{safeInt(metrics.agendFollow)}</span></div>
            <div><span className="text-[rgb(var(--text))] font-semibold">N</span> agendamento total: <span className="font-bold text-[rgb(var(--text))]">{safeInt(computed.agendTotal)}</span></div>
            <div><span className="text-[rgb(var(--text))] font-semibold">O</span> % de agendamentos sob ações totais: <span className="font-bold text-[rgb(var(--text))]">{fmtPct2(computed.pctAgendAcoes)}</span></div>
            <div><span className="text-[rgb(var(--text))] font-semibold">P</span> contatos totais no dia (Novos + Follow Ups): <span className="font-bold text-[rgb(var(--text))]">{safeInt(computed.contatosTotal)}</span></div>
          </div>
        ) : (
          <div className="text-xs text-[rgb(var(--muted))]">Carregando…</div>
        )}
      </Section>

      <CtaRegisterSheet
        open={ctaSheetOpen}
        busy={ctaBusy}
        ctaUrl={ctaUrl}
        setCtaUrl={setCtaUrl}
        ctaNote={ctaNote}
        setCtaNote={setCtaNote}
        ctaUrlIsValid={ctaUrlIsValid}
        mismatchConfirm={mismatchConfirm}
        setMismatchConfirm={setMismatchConfirm}
        disableInputs={disableInputs}
        onClose={() => setCtaSheetOpen(false)}
        onPasteFromActiveTab={handlePasteFromActiveTab}
        onOpenCtaLink={handleOpenCtaLink}
        onSaveAndMoveCta={handleSaveAndMoveCta}
      />

      <WeekPanel open={weekOpen} weekRows={weekRows} />
    </div>
  );
}
