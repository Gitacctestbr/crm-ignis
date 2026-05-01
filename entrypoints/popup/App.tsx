import React from "react";
import type { BoardType } from "../../src/db/db";
import { addLead } from "../../src/db/leadsRepo";

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

function cx(...parts: Array<string | false | undefined | null>) {
  return parts.filter(Boolean).join(" ");
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function cleanCell(s: string) {
  let x = String(s || "").trim();
  // remove aspas comuns
  x = x.replace(/^"+|"+$/g, "").replace(/^'+|'+$/g, "");
  // remove BOM
  x = x.replace(/^\uFEFF/, "");
  return x.trim();
}

function extractUrlFromLine(line: string): string | null {
  const raw = cleanCell(line);
  if (!raw) return null;

  // 1) regex com http(s)
  const m1 = raw.match(/(https?:\/\/[^\s,"']*instagram\.com[^\s,"']*)/i);
  if (m1?.[1]) return cleanCell(m1[1]);

  // 2) linha tem instagram.com mas sem protocolo
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

  // garante esquema
  const urlStr = raw.includes("://") ? raw : `https://${raw}`;

  try {
    const u = new URL(urlStr);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();

    // aceita subdomínios: www, m, l, etc.
    if (!host.endsWith("instagram.com")) return { ok: false, reason: "Não é URL do Instagram" };

    const path = u.pathname.replace(/\/+$/, "");
    const parts = path.split("/").filter(Boolean);
    if (parts.length === 0) return { ok: false, reason: "Não é um perfil" };

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

type ImportState =
  | { step: "idle" }
  | { step: "preview"; preview: ImportPreview }
  | {
      step: "importing";
      preview: ImportPreview;
      progress: { done: number; total: number; created: number; exists: number };
      log: string[];
    }
  | {
      step: "done";
      preview: ImportPreview;
      result: { created: number; exists: number; totalImported: number };
      log: string[];
    };

export default function App() {
  const WORKSPACE_ID = "default";
  const [board, setBoard] = React.useState<BoardType>("OUTBOUND");
  const fileRef = React.useRef<HTMLInputElement | null>(null);

  const [err, setErr] = React.useState<string | null>(null);
  const [state, setState] = React.useState<ImportState>({ step: "idle" });

  function resetImport() {
    setErr(null);
    setState({ step: "idle" });
    if (fileRef.current) fileRef.current.value = "";
  }

  async function handlePickFile() {
    setErr(null);
    fileRef.current?.click();
  }

  async function handleFileChosen(file: File | null) {
    if (!file) return;
    setErr(null);
    try {
      const text = await file.text();
      const preview = buildPreviewFromCsvText(file.name, text);

      if (preview.totalLines === 0) {
        setErr("O arquivo está vazio.");
        setState({ step: "idle" });
        return;
      }

      setState({ step: "preview", preview });
    } catch (e: any) {
      console.error(e);
      setErr(e?.message || "Erro ao ler o arquivo");
      setState({ step: "idle" });
    }
  }

  async function confirmImport() {
    if (state.step !== "preview") return;
    const preview = state.preview;
    if (preview.validCount === 0) {
      setErr("Não encontrei nenhum perfil válido para importar.");
      return;
    }

    const total = preview.usernames.length;

    // Mantemos o mesmo array para ir atualizando (e não perder as linhas iniciais)
    const log: string[] = [
      `Iniciando importação…`,
      `Arquivo: ${preview.filename}`,
      `Funil: ${board === "OUTBOUND" ? "Outbound" : "Social"}`,
      `Total de perfis válidos: ${total}`,
      "—",
    ];

    setState({
      step: "importing",
      preview,
      progress: { done: 0, total, created: 0, exists: 0 },
      log,
    });

    let created = 0;
    let exists = 0;

    // Importa em sequência para não travar o popup, com "yield" a cada N itens
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

        // log enxuto (não spammar milhares de linhas)
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
      setState((cur) => {
        if (cur.step !== "importing") return cur;
        return {
          ...cur,
          progress: { done, total, created, exists },
          log,
        };
      });

      if (done % 60 === 0) {
        // dá um respiro na UI
        await sleep(0);
      }
    }

    log.push("—");
    log.push(`✅ Finalizado. Criados: ${created} • Já existiam: ${exists}`);
    log.push("Obs: se já existia, eu NÃO alterei a etapa atual do lead.");

    setState({
      step: "done",
      preview,
      result: { created, exists, totalImported: total },
      log,
    });
  }

  const isBusy = state.step === "importing";
  const canImport = state.step === "preview" && state.preview.validCount > 0;

  return (
    <div className="w-[360px] max-h-[560px] overflow-auto p-3 bg-[rgb(var(--bg))] text-[rgb(var(--text))]">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-black text-sm">CRM IGNIS</div>
          <div className="text-[11px] text-[rgb(var(--muted))] mt-0.5">Popup • Importar leads por CSV</div>
        </div>

        <button
          className="text-[11px] px-2 py-1 rounded-[var(--radius)] border border-[rgb(var(--border))] hover:bg-white/5"
          onClick={async () => {
            setErr(null);
            try {
              await openOrFocusDashboard();
            } catch (e: any) {
              console.error(e);
              setErr(e?.message || "Erro ao abrir o dashboard");
            }
          }}
          title="Abrir o Kanban em uma aba"
        >
          Abrir Kanban
        </button>
      </div>

      {/* Funil */}
      <div className="mt-3">
        <div className="text-[11px] text-[rgb(var(--muted))] mb-1">Escolha o funil para importar:</div>
        <div className="flex gap-2">
          <button
            className={cx(
              "flex-1 text-xs px-3 py-2 rounded-[var(--radius)] border",
              board === "OUTBOUND"
                ? "border-[rgb(var(--accent))] bg-white/5"
                : "border-[rgb(var(--border))] hover:bg-white/5",
            )}
            onClick={() => setBoard("OUTBOUND")}
            disabled={isBusy}
          >
            Outbound
          </button>
          <button
            className={cx(
              "flex-1 text-xs px-3 py-2 rounded-[var(--radius)] border",
              board === "SOCIAL"
                ? "border-[rgb(var(--accent))] bg-white/5"
                : "border-[rgb(var(--border))] hover:bg-white/5",
            )}
            onClick={() => setBoard("SOCIAL")}
            disabled={isBusy}
          >
            Social
          </button>
        </div>
      </div>

      {/* Import */}
      <div className="mt-3 border border-[rgb(var(--border))] rounded-[var(--radius)] overflow-hidden">
        <div className="px-3 py-2 bg-white/5 border-b border-[rgb(var(--border))]">
          <div className="text-xs font-extrabold">Importar CSV</div>
          <div className="text-[11px] text-[rgb(var(--muted))] mt-0.5">
            CSV contendo URLs de perfil do Instagram (1 por linha). Exemplos: https://www.instagram.com/usuario/
          </div>
        </div>

        <div className="p-3">
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => void handleFileChosen(e.target.files?.[0] ?? null)}
          />

          <button
            className="w-full text-xs px-3 py-2 rounded-[var(--radius)] border border-[rgb(var(--border))] hover:bg-white/5"
            onClick={() => void handlePickFile()}
            disabled={isBusy}
          >
            {state.step === "preview" || state.step === "importing" || state.step === "done"
              ? "Escolher outro CSV"
              : "Importar CSV"}
          </button>

          {/* Preview */}
          {state.step === "preview" ? (
            <div className="mt-3 text-xs">
              <div className="font-extrabold">Prévia do arquivo</div>
              <div className="text-[11px] text-[rgb(var(--muted))] mt-1">
                <div>Arquivo: {state.preview.filename}</div>
                <div>Linhas: {state.preview.totalLines}</div>
                <div>
                  Válidos: <span className="font-bold">{state.preview.validCount}</span> • Inválidos: {state.preview.invalidCount} •
                  Duplicados no arquivo: {state.preview.duplicateInFileCount}
                </div>
                <div className="mt-1">
                  Todos os leads novos serão criados em: <span className="font-bold">Leads novos</span>
                </div>
              </div>

              {state.preview.invalidSamples.length ? (
                <div className="mt-2">
                  <div className="text-[11px] text-[rgb(var(--muted))]">Exemplos de linhas inválidas:</div>
                  <ul className="mt-1 text-[11px] text-[rgb(var(--muted))] list-disc pl-5">
                    {state.preview.invalidSamples.map((x) => (
                      <li key={`${x.line}-${x.value}`}>
                        Linha {x.line}: {x.reason} — “{x.value}”
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <div className="mt-3 flex gap-2">
                <button
                  className={cx(
                    "flex-1 text-xs px-3 py-2 rounded-[var(--radius)] border",
                    canImport ? "border-[rgb(var(--accent))] bg-white/5" : "border-[rgb(var(--border))] opacity-60",
                  )}
                  disabled={!canImport}
                  onClick={() => void confirmImport()}
                >
                  Confirmar importação
                </button>
                <button
                  className="text-xs px-3 py-2 rounded-[var(--radius)] border border-[rgb(var(--border))] hover:bg-white/5"
                  onClick={resetImport}
                >
                  Cancelar
                </button>
              </div>
            </div>
          ) : null}

          {/* Importing */}
          {state.step === "importing" ? (
            <div className="mt-3">
              <div className="text-xs font-extrabold">Importando…</div>
              <div className="text-[11px] text-[rgb(var(--muted))] mt-1">
                {state.progress.done}/{state.progress.total} • Criados: {state.progress.created} • Já existiam: {state.progress.exists}
              </div>
              <div className="mt-2 w-full h-2 rounded-full bg-white/5 border border-[rgb(var(--border))] overflow-hidden">
                <div
                  className="h-full bg-white/20"
                  style={{ width: `${Math.round((state.progress.done / Math.max(1, state.progress.total)) * 100)}%` }}
                />
              </div>
            </div>
          ) : null}

          {/* Done */}
          {state.step === "done" ? (
            <div className="mt-3">
              <div className="text-xs font-extrabold">Finalizado ✅</div>
              <div className="text-[11px] text-[rgb(var(--muted))] mt-1">
                Total: {state.result.totalImported} • Criados: {state.result.created} • Já existiam: {state.result.exists}
              </div>
              <div className="mt-3 flex gap-2">
                <button
                  className="flex-1 text-xs px-3 py-2 rounded-[var(--radius)] border border-[rgb(var(--border))] hover:bg-white/5"
                  onClick={() => void openOrFocusDashboard()}
                >
                  Abrir Kanban agora
                </button>
                <button
                  className="text-xs px-3 py-2 rounded-[var(--radius)] border border-[rgb(var(--border))] hover:bg-white/5"
                  onClick={resetImport}
                >
                  Novo import
                </button>
              </div>
            </div>
          ) : null}

          {/* Log */}
          {state.step === "importing" || state.step === "done" ? (
            <div className="mt-3">
              <div className="text-[11px] text-[rgb(var(--muted))]">Log</div>
              <div className="mt-1 text-[11px] whitespace-pre-wrap rounded-[var(--radius)] bg-white/5 border border-[rgb(var(--border))] p-2 max-h-[170px] overflow-auto">
                {(state as any).log?.join("\n")}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {err ? <div className="mt-2 text-[11px] text-red-400">{err}</div> : null}

      <div className="mt-3 text-[10px] text-[rgb(var(--muted))]">
        Dica: se a sua lista estiver em Excel, exporte como CSV e deixe 1 URL por linha.
      </div>
    </div>
  );
}
