import React from "react";
import type { BoardType } from "../../src/db/db";
import { addLead } from "../../src/db/leadsRepo";
import { useAuth } from "../../src/auth/AuthContext";

// ─── Helpers — Chrome / utils ──────────────────────────────────────────────

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

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Helpers — CSV parsing (preservado da versão anterior) ─────────────────

function cleanCell(s: string) {
  let x = String(s || "").trim();
  x = x.replace(/^"+|"+$/g, "").replace(/^'+|'+$/g, "");
  x = x.replace(/^﻿/, "");
  return x.trim();
}

function extractUrlFromLine(line: string): string | null {
  const raw = cleanCell(line);
  if (!raw) return null;

  const m1 = raw.match(/(https?:\/\/[^\s,"']*instagram\.com[^\s,"']*)/i);
  if (m1?.[1]) return cleanCell(m1[1]);

  const idx = raw.toLowerCase().indexOf("instagram.com");
  if (idx >= 0) {
    let token = raw.slice(idx);
    token = token.split(/[\s,;\t]/)[0] || token;
    token = cleanCell(token);
    if (!token) return null;
    if (!token.startsWith("http")) token = `https://${token.replace(/^\/\//, "")}`;
    return token;
  }

  return null;
}

type ParseProfileResult =
  | { ok: true; username: string }
  | { ok: false; reason: string };

function parseInstagramProfileUrl(maybeUrl: string): ParseProfileResult {
  const raw = cleanCell(maybeUrl);
  if (!raw) return { ok: false, reason: "Linha vazia" };

  const urlStr = raw.includes("://") ? raw : `https://${raw}`;

  try {
    const u = new URL(urlStr);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();

    if (!host.endsWith("instagram.com")) return { ok: false, reason: "Não é URL do Instagram" };

    const path = u.pathname.replace(/\/+$/, "");
    const parts = path.split("/").filter(Boolean);
    if (parts.length === 0) return { ok: false, reason: "Não é um perfil" };

    const first = parts[0];
    const blocked = new Set([
      "p", "reel", "reels", "stories", "explore", "accounts", "direct", "about", "developer",
    ]);
    if (blocked.has(first)) return { ok: false, reason: "Essa URL não é de perfil" };

    const username = first.trim().replace(/^@+/, "");
    if (!/^[a-zA-Z0-9._]+$/.test(username)) return { ok: false, reason: "Username inválido" };
    return { ok: true, username };
  } catch {
    return { ok: false, reason: "URL inválida" };
  }
}

type ImportPreview = {
  filename: string;
  totalLines: number;
  validCount: number;
  invalidCount: number;
  duplicateInFileCount: number;
  usernames: string[];
  invalidSamples: Array<{ line: number; value: string; reason: string }>;
};

function buildPreviewFromCsvText(filename: string, text: string): ImportPreview {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const totalLines = lines.length;
  const usernames: string[] = [];
  const seen = new Set<string>();
  const invalidSamples: ImportPreview["invalidSamples"] = [];
  let invalidCount = 0;
  let duplicateInFileCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const url = extractUrlFromLine(line);
    if (!url) {
      invalidCount++;
      if (invalidSamples.length < 6) {
        invalidSamples.push({
          line: i + 1,
          value: line.slice(0, 120),
          reason: "Não achei URL do Instagram",
        });
      }
      continue;
    }

    const parsed = parseInstagramProfileUrl(url);
    if (!parsed.ok) {
      invalidCount++;
      if (invalidSamples.length < 6) {
        invalidSamples.push({ line: i + 1, value: url.slice(0, 120), reason: parsed.reason });
      }
      continue;
    }

    const usernameLower = parsed.username.toLowerCase();
    if (seen.has(usernameLower)) {
      duplicateInFileCount++;
      continue;
    }
    seen.add(usernameLower);
    usernames.push(parsed.username);
  }

  return {
    filename,
    totalLines,
    validCount: usernames.length,
    invalidCount,
    duplicateInFileCount,
    usernames,
    invalidSamples,
  };
}

// ─── Estado de navegação ───────────────────────────────────────────────────

type ImportProgress = { done: number; total: number; created: number; exists: number };
type ImportResult = { created: number; exists: number; totalImported: number };

type View =
  | { kind: "home" }
  | { kind: "choose-funnel" }
  | { kind: "preview"; board: BoardType; preview: ImportPreview }
  | { kind: "importing"; board: BoardType; preview: ImportPreview; progress: ImportProgress; log: string[] }
  | { kind: "done"; board: BoardType; preview: ImportPreview; result: ImportResult; log: string[] };

function boardLabel(b: BoardType) {
  return b === "OUTBOUND" ? "Outbound" : "Social Selling";
}

// ─── App ───────────────────────────────────────────────────────────────────

export default function App() {
  const { user, signOut } = useAuth();
  const WORKSPACE_ID = user?.id ?? "";

  const [view, setView] = React.useState<View>({ kind: "home" });
  const [err, setErr] = React.useState<string | null>(null);
  const [signingOut, setSigningOut] = React.useState(false);

  // Input file invisível. `selectedBoardRef` carrega o funil escolhido até o
  // file picker resolver (não dá pra passar argumento via onClick em <input>).
  const fileRef = React.useRef<HTMLInputElement | null>(null);
  const selectedBoardRef = React.useRef<BoardType>("OUTBOUND");

  function startUploadForBoard(board: BoardType) {
    setErr(null);
    selectedBoardRef.current = board;
    fileRef.current?.click();
  }

  async function handleFileChosen(file: File | null) {
    if (!file) return;
    const board = selectedBoardRef.current;
    setErr(null);
    try {
      const text = await file.text();
      const preview = buildPreviewFromCsvText(file.name, text);
      if (preview.totalLines === 0) {
        setErr("O arquivo está vazio.");
        return;
      }
      setView({ kind: "preview", board, preview });
    } catch (e: any) {
      console.error(e);
      setErr(e?.message || "Erro ao ler o arquivo");
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function confirmImport() {
    if (view.kind !== "preview") return;
    const { board, preview } = view;

    if (preview.validCount === 0) {
      setErr("Não encontrei nenhum perfil válido para importar.");
      return;
    }

    const total = preview.usernames.length;
    const log: string[] = [
      `Iniciando importação…`,
      `Arquivo: ${preview.filename}`,
      `Funil: ${boardLabel(board)}`,
      `Total de perfis válidos: ${total}`,
      "—",
    ];

    setView({
      kind: "importing",
      board,
      preview,
      progress: { done: 0, total, created: 0, exists: 0 },
      log,
    });

    let created = 0;
    let exists = 0;

    for (let i = 0; i < total; i++) {
      const username = preview.usernames[i];
      try {
        const r = await addLead({
          workspaceId: WORKSPACE_ID,
          board,
          stageId: "Leads novos",
          username,
        });

        if (r.status === "created") created++;
        else exists++;

        if (i < 8) {
          log.push(`${r.status === "created" ? "✅ Criado" : "⚠️ Já existia"}: @${username}`);
        } else if (i === 8) {
          log.push("(…continuando em lote, sem mostrar cada linha pra não poluir)");
        }
      } catch (e: any) {
        console.error(e);
        if (i < 8) log.push(`❌ Erro em @${username}: ${e?.message || "erro"}`);
      }

      const done = i + 1;
      setView((cur) => {
        if (cur.kind !== "importing") return cur;
        return { ...cur, progress: { done, total, created, exists }, log };
      });

      if (done % 60 === 0) await sleep(0);
    }

    log.push("—");
    log.push(`✅ Finalizado. Criados: ${created} • Já existiam: ${exists}`);
    log.push("Obs: se já existia, eu NÃO alterei a etapa atual do lead.");

    setView({
      kind: "done",
      board,
      preview,
      result: { created, exists, totalImported: total },
      log,
    });
  }

  async function handleSignOut() {
    if (signingOut) return;
    if (view.kind === "importing") {
      const ok = window.confirm("Importação em andamento. Sair mesmo assim?");
      if (!ok) return;
    }
    setErr(null);
    setSigningOut(true);
    try {
      await signOut();
    } catch (e: any) {
      console.error("[popup] signOut", e);
      setErr(e?.message || "Erro ao sair da conta");
      setSigningOut(false);
    }
  }

  return (
    <div className="w-[360px] p-4 bg-[rgb(var(--bg))] text-[rgb(var(--text))]">
      <Header />

      <input
        ref={fileRef}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={(e) => void handleFileChosen(e.target.files?.[0] ?? null)}
      />

      {view.kind === "home" && (
        <HomeView
          onOpenKanban={() => void openOrFocusDashboard()}
          onUpload={() => setView({ kind: "choose-funnel" })}
        />
      )}

      {view.kind === "choose-funnel" && (
        <ChooseFunnelView
          onBack={() => setView({ kind: "home" })}
          onPick={startUploadForBoard}
        />
      )}

      {view.kind === "preview" && (
        <PreviewView
          board={view.board}
          preview={view.preview}
          onBack={() => setView({ kind: "home" })}
          onChangeFile={() => fileRef.current?.click()}
          onConfirm={() => void confirmImport()}
        />
      )}

      {view.kind === "importing" && (
        <ImportingView
          board={view.board}
          progress={view.progress}
          log={view.log}
        />
      )}

      {view.kind === "done" && (
        <DoneView
          board={view.board}
          result={view.result}
          log={view.log}
          onOpenKanban={() => void openOrFocusDashboard()}
          onNewImport={() => setView({ kind: "home" })}
        />
      )}

      {err ? (
        <div
          role="alert"
          className="mt-3 text-[11px] text-red-300 bg-red-500/10 border border-red-500/20 rounded-[var(--radius)] px-3 py-2"
        >
          {err}
        </div>
      ) : null}

      <AccountFooter
        email={user?.email}
        signingOut={signingOut}
        disabled={view.kind === "importing"}
        onSignOut={() => void handleSignOut()}
      />
    </div>
  );
}

// ─── Subcomponentes ────────────────────────────────────────────────────────

function Header() {
  return (
    <div className="flex items-center gap-2.5 mb-4">
      <FlameLogo size={26} />
      <div className="min-w-0">
        <div className="text-[14px] font-extrabold tracking-tight leading-tight">
          <span className="text-[rgb(var(--accent))]">IGNIS</span>
          <span className="text-[rgb(var(--muted))]/50 mx-1.5">·</span>
          <span className="text-[rgb(var(--text))]/90 font-medium">CRM</span>
        </div>
        <div className="text-[10.5px] text-[rgb(var(--muted))]/70 leading-tight mt-0.5">
          Painel
        </div>
      </div>
    </div>
  );
}

function HomeView(props: { onOpenKanban: () => void; onUpload: () => void }) {
  return (
    <div className="flex flex-col gap-2">
      <ActionTile
        kind="primary"
        title="Abrir Kanban"
        subtitle="Gerenciar leads em colunas"
        onClick={props.onOpenKanban}
      />
      <ActionTile
        kind="secondary"
        title="Subir lista de leads"
        subtitle="Importar CSV de perfis do Instagram"
        onClick={props.onUpload}
      />
    </div>
  );
}

function ChooseFunnelView(props: {
  onBack: () => void;
  onPick: (board: BoardType) => void;
}) {
  return (
    <div>
      <BackButton onClick={props.onBack} label="Voltar" />
      <div className="mt-3 mb-3">
        <div className="text-[14px] font-bold leading-tight">Para qual funil?</div>
        <div className="text-[11.5px] text-[rgb(var(--muted))]/85 mt-1 leading-snug">
          Os leads serão criados na coluna inicial do funil escolhido.
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <ActionTile
          kind="secondary"
          title="Outbound"
          subtitle="Leads prospectados ativamente"
          onClick={() => props.onPick("OUTBOUND")}
        />
        <ActionTile
          kind="secondary"
          title="Social Selling"
          subtitle="Leads vindos de engajamento orgânico"
          onClick={() => props.onPick("SOCIAL")}
        />
      </div>
    </div>
  );
}

function PreviewView(props: {
  board: BoardType;
  preview: ImportPreview;
  onBack: () => void;
  onChangeFile: () => void;
  onConfirm: () => void;
}) {
  const { board, preview } = props;
  const canImport = preview.validCount > 0;

  return (
    <div>
      <BackButton onClick={props.onBack} label="Cancelar" />

      <div className="mt-3 mb-3">
        <div className="text-[14px] font-bold leading-tight">Prévia do arquivo</div>
        <div className="text-[11.5px] text-[rgb(var(--muted))]/85 mt-1 leading-snug">
          Funil:{" "}
          <span className="text-[rgb(var(--accent))] font-semibold">{boardLabel(board)}</span>
        </div>
      </div>

      <div className="rounded-[var(--radius)] bg-white/[0.03] border border-white/[0.08] p-3">
        <div className="text-[11px] text-[rgb(var(--muted))]/80 truncate" title={preview.filename}>
          {preview.filename}
        </div>
        <div className="mt-2 grid grid-cols-3 gap-2 text-center">
          <Stat label="Válidos" value={preview.validCount} accent />
          <Stat label="Inválidos" value={preview.invalidCount} />
          <Stat label="Duplicados" value={preview.duplicateInFileCount} />
        </div>
      </div>

      {preview.invalidSamples.length ? (
        <details className="mt-2 group">
          <summary className="text-[11px] text-[rgb(var(--muted))]/80 cursor-pointer select-none hover:text-[rgb(var(--text))]/80 transition-colors">
            Ver exemplos de linhas inválidas
          </summary>
          <ul className="mt-2 text-[11px] text-[rgb(var(--muted))] list-disc pl-5 leading-relaxed">
            {preview.invalidSamples.map((x) => (
              <li key={`${x.line}-${x.value}`}>
                Linha {x.line}: {x.reason} — "{x.value}"
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <div className="mt-4 flex gap-2">
        <button
          className="flex-1 text-xs font-semibold px-3 py-2.5 rounded-[var(--radius)] bg-gradient-to-b from-[#f08a3e] to-[#d96d28] text-white shadow-[0_4px_14px_rgba(234,124,48,0.35)] hover:brightness-110 hover:shadow-[0_6px_20px_rgba(234,124,48,0.45)] active:translate-y-px transition-all disabled:opacity-40 disabled:cursor-not-allowed disabled:bg-none disabled:bg-[rgba(234,124,48,0.22)] disabled:text-white/55 disabled:shadow-none"
          disabled={!canImport}
          onClick={props.onConfirm}
        >
          Importar {preview.validCount} {preview.validCount === 1 ? "lead" : "leads"}
        </button>
        <button
          className="text-xs px-3 py-2.5 rounded-[var(--radius)] border border-[rgb(var(--border))] text-[rgb(var(--muted))] hover:bg-white/5 hover:text-[rgb(var(--text))] transition-all"
          onClick={props.onChangeFile}
          title="Escolher outro arquivo"
        >
          Trocar
        </button>
      </div>
    </div>
  );
}

function ImportingView(props: {
  board: BoardType;
  progress: ImportProgress;
  log: string[];
}) {
  const { progress, board } = props;
  const pct = Math.round((progress.done / Math.max(1, progress.total)) * 100);

  return (
    <div>
      <div className="mb-3">
        <div className="text-[14px] font-bold leading-tight">Importando…</div>
        <div className="text-[11.5px] text-[rgb(var(--muted))]/85 mt-1 leading-snug">
          Funil:{" "}
          <span className="text-[rgb(var(--accent))] font-semibold">{boardLabel(board)}</span>
        </div>
      </div>

      <div className="rounded-[var(--radius)] bg-white/[0.03] border border-white/[0.08] p-3">
        <div className="flex items-baseline justify-between mb-2">
          <div className="text-[12px] font-semibold">
            {progress.done}/{progress.total}
          </div>
          <div className="text-[11px] text-[rgb(var(--muted))]/80 tabular-nums">{pct}%</div>
        </div>
        <div className="w-full h-1.5 rounded-full bg-white/5 overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-[#f08a3e] to-[#ea7c30] transition-[width] duration-300 ease-out"
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="mt-2.5 grid grid-cols-2 gap-2 text-center">
          <Stat label="Criados" value={progress.created} accent />
          <Stat label="Já existiam" value={progress.exists} />
        </div>
      </div>

      <LogPanel log={props.log} />
    </div>
  );
}

function DoneView(props: {
  board: BoardType;
  result: ImportResult;
  log: string[];
  onOpenKanban: () => void;
  onNewImport: () => void;
}) {
  const { result, board } = props;

  return (
    <div>
      <div className="mb-3">
        <div className="text-[14px] font-bold leading-tight flex items-center gap-2">
          <CheckIcon />
          Importação concluída
        </div>
        <div className="text-[11.5px] text-[rgb(var(--muted))]/85 mt-1 leading-snug">
          Funil:{" "}
          <span className="text-[rgb(var(--accent))] font-semibold">{boardLabel(board)}</span>
        </div>
      </div>

      <div className="rounded-[var(--radius)] bg-white/[0.03] border border-white/[0.08] p-3 grid grid-cols-3 gap-2 text-center">
        <Stat label="Total" value={result.totalImported} />
        <Stat label="Criados" value={result.created} accent />
        <Stat label="Já existiam" value={result.exists} />
      </div>

      <div className="mt-4 flex gap-2">
        <button
          className="flex-1 text-xs font-semibold px-3 py-2.5 rounded-[var(--radius)] bg-gradient-to-b from-[#f08a3e] to-[#d96d28] text-white shadow-[0_4px_14px_rgba(234,124,48,0.35)] hover:brightness-110 hover:shadow-[0_6px_20px_rgba(234,124,48,0.45)] active:translate-y-px transition-all"
          onClick={props.onOpenKanban}
        >
          Abrir Kanban
        </button>
        <button
          className="text-xs px-3 py-2.5 rounded-[var(--radius)] border border-[rgb(var(--border))] text-[rgb(var(--muted))] hover:bg-white/5 hover:text-[rgb(var(--text))] transition-all"
          onClick={props.onNewImport}
        >
          Novo
        </button>
      </div>

      <LogPanel log={props.log} />
    </div>
  );
}

// ─── Componentes utilitários ───────────────────────────────────────────────

function ActionTile(props: {
  kind: "primary" | "secondary";
  title: string;
  subtitle?: string;
  onClick: () => void;
}) {
  const base =
    "group flex items-center w-full text-left px-3.5 py-3 rounded-[var(--radius)] " +
    "transition-all duration-150 hover:-translate-y-px active:translate-y-0";
  const primary =
    "bg-[rgba(234,124,48,0.06)] border border-[rgba(234,124,48,0.30)] " +
    "hover:bg-[rgba(234,124,48,0.10)] hover:border-[rgba(234,124,48,0.50)] " +
    "hover:shadow-[0_4px_18px_rgba(234,124,48,0.18)]";
  const secondary =
    "bg-white/[0.03] border border-white/[0.08] " +
    "hover:bg-white/[0.05] hover:border-white/[0.16] " +
    "hover:shadow-[0_4px_14px_rgba(0,0,0,0.25)]";

  return (
    <button
      type="button"
      onClick={props.onClick}
      className={[base, props.kind === "primary" ? primary : secondary].join(" ")}
    >
      <div className="flex-1 min-w-0">
        <div
          className={
            "text-[13px] font-semibold leading-tight " +
            (props.kind === "primary"
              ? "text-[rgb(var(--accent))]"
              : "text-[rgb(var(--text))]")
          }
        >
          {props.title}
        </div>
        {props.subtitle ? (
          <div className="text-[11px] text-[rgb(var(--muted))]/85 mt-1 leading-snug truncate">
            {props.subtitle}
          </div>
        ) : null}
      </div>
      <ChevronRight
        className={
          "shrink-0 ml-2 transition-all duration-150 " +
          "opacity-50 group-hover:opacity-100 group-hover:translate-x-0.5 " +
          (props.kind === "primary"
            ? "text-[rgb(var(--accent))]"
            : "text-[rgb(var(--muted))]")
        }
      />
    </button>
  );
}

function BackButton(props: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className="text-[11px] text-[rgb(var(--muted))]/80 hover:text-[rgb(var(--text))] transition-colors inline-flex items-center gap-1"
    >
      <ChevronLeft />
      {props.label}
    </button>
  );
}

function Stat(props: { label: string; value: number; accent?: boolean }) {
  return (
    <div>
      <div
        className={
          "text-[16px] font-bold tabular-nums leading-none " +
          (props.accent ? "text-[rgb(var(--accent))]" : "text-[rgb(var(--text))]")
        }
      >
        {props.value}
      </div>
      <div className="text-[10px] text-[rgb(var(--muted))]/75 uppercase tracking-wide mt-1">
        {props.label}
      </div>
    </div>
  );
}

function LogPanel(props: { log: string[] }) {
  return (
    <details className="mt-3 group">
      <summary className="text-[11px] text-[rgb(var(--muted))]/80 cursor-pointer select-none hover:text-[rgb(var(--text))]/80 transition-colors">
        Ver log detalhado
      </summary>
      <div className="mt-2 text-[11px] whitespace-pre-wrap rounded-[var(--radius)] bg-white/[0.03] border border-white/[0.08] p-2.5 max-h-[160px] overflow-auto font-mono leading-relaxed text-[rgb(var(--muted))]">
        {props.log.join("\n")}
      </div>
    </details>
  );
}

function AccountFooter(props: {
  email?: string;
  signingOut: boolean;
  disabled: boolean;
  onSignOut: () => void;
}) {
  return (
    <div className="mt-5 pt-3 border-t border-[rgb(var(--border))]/50 flex items-center gap-2">
      <div className="flex-1 min-w-0">
        <div className="text-[10px] text-[rgb(var(--muted))]/70 leading-tight uppercase tracking-wide">
          Logado como
        </div>
        <div
          className="text-[11.5px] font-medium text-[rgb(var(--text))]/85 truncate mt-0.5"
          title={props.email ?? ""}
        >
          {props.email ?? "—"}
        </div>
      </div>
      <button
        type="button"
        onClick={props.onSignOut}
        disabled={props.signingOut || props.disabled}
        className="text-[11px] px-3 py-1.5 rounded-[var(--radius)] border border-[rgb(var(--border))] text-[rgb(var(--muted))] hover:border-red-500/40 hover:bg-red-500/8 hover:text-red-300 transition-all disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
        title={
          props.disabled
            ? "Aguarde a importação terminar"
            : "Sair da conta (você será redirecionado para o login)"
        }
      >
        {props.signingOut ? "Saindo…" : "Sair"}
      </button>
    </div>
  );
}

// ─── Ícones ────────────────────────────────────────────────────────────────

function FlameLogo({ size = 28 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      style={{ filter: "drop-shadow(0 0 8px rgba(234,124,48,0.35))" }}
    >
      <path
        d="M16 3c-1 4-5 5-5 12a5 5 0 0010 0c0-2-1-3-1-5 5 2 7 6 7 11a11 11 0 11-22 0c0-9 8-10 11-18z"
        fill="url(#popup-flame-grad)"
      />
      <defs>
        <linearGradient
          id="popup-flame-grad"
          x1="16"
          y1="3"
          x2="16"
          y2="29"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#ffc26a" />
          <stop offset="0.55" stopColor="#ea7c30" />
          <stop offset="1" stopColor="#b3441a" />
        </linearGradient>
      </defs>
    </svg>
  );
}

function ChevronRight({ className = "" }: { className?: string }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M5 3l4 4-4 4" />
    </svg>
  );
}

function ChevronLeft() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 3l-4 4 4 4" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-[rgb(var(--ok))]"
      aria-hidden="true"
    >
      <path d="M3 8.5l3 3 7-7" />
    </svg>
  );
}
