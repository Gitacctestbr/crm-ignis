import React, { useRef, useState } from "react";
import { exportIgnisBackupToFile, importIgnisBackupFromFile } from "../db/backup";

type Props = {
  compact?: boolean;
};

export function BackupRestorePanel({ compact }: Props) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState<null | "export" | "import">(null);
  const [log, setLog] = useState<string>("");

  function append(msg: string) {
    setLog((prev) => (prev ? `${prev}\n${msg}` : msg));
  }

  async function handleExport() {
    if (busy) return;

    try {
      setBusy("export");
      setLog("");
      append("Iniciando export...");
      await exportIgnisBackupToFile();
      append("✅ Backup exportado com sucesso.");
    } catch (e: any) {
      append(`❌ Falha ao exportar: ${e?.message ?? String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  function handlePickFile() {
    if (busy) return;

    // Reset para permitir selecionar o mesmo arquivo novamente
    if (fileRef.current) fileRef.current.value = "";

    // Evita edge cases de clique/render
    requestAnimationFrame(() => {
      fileRef.current?.click();
    });
  }

  async function handleImport(file?: File | null) {
    if (!file) return;
    if (busy) return;

    try {
      setBusy("import");
      setLog("");
      append(`Lendo arquivo: ${file.name}`);
      append("Importando em modo seguro (MERGE)...");
      const res = await importIgnisBackupFromFile(file, {
        mode: "merge",
        keepExistingLeadStage: true,
      });

      append("✅ Import finalizado.");
      append("Resumo:");
      for (const t of res.tables) {
        append(
          `- ${t.name}: incoming=${t.incoming} | added=${t.added} | updated=${t.updated} | skipped=${t.skipped}`,
        );
      }

      append("");
      append("Obs: MERGE não apaga nada.");
    } catch (e: any) {
      append(`❌ Falha ao importar: ${e?.message ?? String(e)}`);
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const btnClass =
    "text-xs px-3 py-2 rounded-[var(--radius)] border border-[rgb(var(--border))] hover:bg-white/5 transition";
  const disabledClass = "opacity-50 cursor-not-allowed";

  const exportDisabled = busy !== null;
  const importDisabled = busy !== null;

  return (
    <div
      className={[
        "w-full rounded-[var(--radius)] border border-[rgb(var(--border))] bg-white/5",
        compact ? "p-2" : "p-3",
      ].join(" ")}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="font-extrabold text-xs">Backup / Restore</div>

        <div className="flex items-center gap-2">
          <button
            className={`${btnClass} ${exportDisabled ? disabledClass : ""}`}
            disabled={exportDisabled}
            onClick={() => void handleExport()}
          >
            {busy === "export" ? "Exportando..." : "Exportar backup"}
          </button>

          <button
            className={`${btnClass} ${importDisabled ? disabledClass : ""}`}
            disabled={importDisabled}
            onClick={handlePickFile}
          >
            {busy === "import" ? "Importando..." : "Importar backup"}
          </button>

          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => void handleImport(e.target.files?.[0])}
          />
        </div>
      </div>

      <div className="mt-2 text-[11px] text-[rgb(var(--muted))]">
        Dica: faça backup por perfil do Chrome (cada perfil tem um banco diferente).
      </div>

      {log ? (
        <pre className="mt-3 whitespace-pre-wrap text-[11px] p-3 rounded-[var(--radius)] bg-[rgb(var(--panel))] border border-[rgb(var(--border))] max-h-56 overflow-auto">
          {log}
        </pre>
      ) : null}
    </div>
  );
}
