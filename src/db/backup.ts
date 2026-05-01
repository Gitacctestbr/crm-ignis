import { db } from "./db";
import { canonicalUsername } from "./leadsRepo";

export type IgnisBackupFormat = "ignis-crm-backup";

export type IgnisBackupEnvelopeV1 = {
  format: IgnisBackupFormat;
  backupVersion: 1;
  exportedAt: string; // ISO
  app: {
    name: string;
    extensionVersion?: string;
    dbName?: string;
  };
  tables: Record<
    string,
    {
      primaryKey?: {
        keyPath?: string | string[];
        auto?: boolean;
      };
      indexes?: Array<{ name: string; keyPath: string | string[] }>;
      count: number;
      rows: any[];
    }
  >;
};

export type ImportMode = "merge" | "replace";

export type ImportOptions = {
  mode?: ImportMode; // default "merge"
  confirmReplace?: boolean;

  // MERGE safety knobs
  keepExistingLeadStage?: boolean; // default true
};

export type ImportResult = {
  tables: Array<{
    name: string;
    incoming: number;
    added: number;
    updated: number;
    skipped: number;
  }>;
};

function getExtensionVersion(): string | undefined {
  try {
    // @ts-ignore
    const manifest = chrome?.runtime?.getManifest?.();
    return manifest?.version;
  } catch {
    return undefined;
  }
}

function isRecord(x: unknown): x is Record<string, any> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function safeLower(x: unknown) {
  return String(x ?? "").trim().toLowerCase();
}

/**
 * Lead "natural key" to avoid ID collisions across Chrome profiles / PCs.
 * We use (board + username) as the stable identifier for merges.
 * canonicalUsername remove @ e aplica lowercase para garantir que "@johndoe"
 * e "johndoe" colidam corretamente durante o merge.
 */
function computeLeadNaturalKey(lead: any): string {
  const username =
    lead.username ??
    lead.igUsername ??
    lead.instagramUsername ??
    lead.handle ??
    lead.user ??
    "";
  const board =
    lead.boardId ??
    lead.board ??
    lead.funnel ??
    lead.boardName ??
    lead.pipeline ??
    "default";
  return `${safeLower(board)}::${canonicalUsername(String(username))}`;
}

/**
 * Normaliza os campos de username de um lead restaurado do backup.
 * Corrige dados legados onde `username` poderia ter `@` ou maiúsculas,
 * e `usernameLower` poderia estar inconsistente.
 */
function normalizeLeadUsernameFields(lead: any): any {
  if (!lead || typeof lead !== "object") return lead;

  const rawUsername =
    lead.username ??
    lead.igUsername ??
    lead.instagramUsername ??
    lead.handle ??
    lead.user ??
    "";

  if (!rawUsername) return lead;

  const clean = canonicalUsername(String(rawUsername));
  return {
    ...lead,
    username: clean,
    usernameLower: clean,
  };
}

function pickPrimKeyInfo(table: any) {
  const primKey = table?.schema?.primKey;
  const keyPath = primKey?.keyPath;
  const auto = !!primKey?.auto;
  return { keyPath, auto };
}

function pickIndexesInfo(table: any) {
  const idx = table?.schema?.indexes ?? [];
  return idx.map((i: any) => ({
    name: i?.name,
    keyPath: i?.keyPath,
  }));
}

async function downloadJsonFile(filename: string, jsonText: string) {
  const blob = new Blob([jsonText], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  // Prefer chrome.downloads if available
  try {
    // @ts-ignore
    if (chrome?.downloads?.download) {
      // @ts-ignore
      await chrome.downloads.download({
        url,
        filename,
        saveAs: true,
      });
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      return;
    }
  } catch {
    // fallback below
  }

  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Export the entire Dexie DB (all tables) into a versioned envelope.
 * This is schema-safe: does not modify DB, only reads.
 */
export async function exportIgnisBackup(): Promise<IgnisBackupEnvelopeV1> {
  const tables: IgnisBackupEnvelopeV1["tables"] = {};

  for (const t of db.tables) {
    const rows = await t.toArray();
    const primaryKey = pickPrimKeyInfo(t);
    const indexes = pickIndexesInfo(t);

    tables[t.name] = {
      primaryKey,
      indexes,
      count: rows.length,
      rows,
    };
  }

  return {
    format: "ignis-crm-backup",
    backupVersion: 1,
    exportedAt: new Date().toISOString(),
    app: {
      name: "CRM IGNIS",
      extensionVersion: getExtensionVersion(),
      // @ts-ignore
      dbName: db?.name,
    },
    tables,
  };
}

export async function exportIgnisBackupToFile() {
  const envelope = await exportIgnisBackup();
  const timestamp = envelope.exportedAt
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .replace("Z", "");
  const filename = `ignis-backup-${timestamp}.json`;
  const json = JSON.stringify(envelope, null, 2);
  await downloadJsonFile(filename, json);
}

function assertEnvelopeV1(x: any): asserts x is IgnisBackupEnvelopeV1 {
  if (!isRecord(x)) throw new Error("Backup inválido: não é um objeto JSON.");
  if (x.format !== "ignis-crm-backup") throw new Error("Backup inválido: format incorreto.");
  if (x.backupVersion !== 1) throw new Error("Backup inválido: versão não suportada (esperado v1).");
  if (!isRecord(x.tables)) throw new Error("Backup inválido: tables ausente.");
}

/**
 * Import backup with:
 * - merge (safe default): upsert without deleting anything
 * - replace (dangerous): clears tables then inserts (blocked unless confirmReplace=true)
 */
export async function importIgnisBackupFromJson(
  jsonText: string,
  options: ImportOptions = {},
): Promise<ImportResult> {
  const mode: ImportMode = options.mode ?? "merge";
  const keepExistingLeadStage = options.keepExistingLeadStage ?? true;

  const parsed = JSON.parse(jsonText);
  assertEnvelopeV1(parsed);

  const incomingTables = parsed.tables;

  // Only import tables that exist in current DB runtime
  const existingTableNames = new Set(db.tables.map((t) => t.name));
  const importTableNames = Object.keys(incomingTables).filter((name) => existingTableNames.has(name));
  const dexieTables = importTableNames.map((name) => db.table(name));

  const result: ImportResult = { tables: [] };

  await db.transaction("rw", dexieTables as any, async () => {
    if (mode === "replace") {
      if (!options.confirmReplace) {
        throw new Error("Importação em modo REPLACE bloqueada: confirmReplace=false.");
      }
      for (const name of importTableNames) {
        await db.table(name).clear();
      }
    }

    for (const name of importTableNames) {
      const table: any = db.table(name);
      const incomingRows = incomingTables[name]?.rows ?? [];
      const incoming = Array.isArray(incomingRows) ? incomingRows : [];

      let added = 0;
      let updated = 0;
      let skipped = 0;

      const isLeadsTable = name.toLowerCase().includes("lead");

      const prim = table?.schema?.primKey;
      const primKeyPath: string | string[] | undefined = prim?.keyPath;
      const primAuto: boolean = !!prim?.auto;

      // REPLACE: insert everything (strip auto PK if necessary)
      if (mode === "replace") {
        const rowsToAdd = incoming.map((r: any) => {
          let row = isLeadsTable ? normalizeLeadUsernameFields(r) : r;
          if (primAuto && typeof primKeyPath === "string") {
            const copy = { ...row };
            delete copy[primKeyPath];
            return copy;
          }
          return row;
        });

        if (rowsToAdd.length > 0) {
          await table.bulkAdd(rowsToAdd);
          added = rowsToAdd.length;
        }

        result.tables.push({ name, incoming: incoming.length, added, updated, skipped });
        continue;
      }

      // MERGE MODE
      if (isLeadsTable) {
        // Merge leads by natural key (board + username) to avoid collisions across profiles.
        // computeLeadNaturalKey usa canonicalUsername para que "@johndoe" e "johndoe"
        // colidam corretamente e não gerem duplicatas.
        const existing = await table.toArray();
        const existingByKey = new Map<string, any>();
        for (const e of existing) existingByKey.set(computeLeadNaturalKey(e), e);

        const toAdd: any[] = [];
        const toPut: any[] = [];

        for (const inc of incoming) {
          if (!inc) {
            skipped++;
            continue;
          }

          const key = computeLeadNaturalKey(inc);
          const parts = key.split("::");
          const usernamePart = parts[1] ?? "";
          if (!usernamePart) {
            skipped++;
            continue;
          }

          const found = existingByKey.get(key);
          if (found) {
            let merged = { ...found, ...inc };

            // Safer default: do NOT change stage of an existing lead during merge
            if (
              keepExistingLeadStage &&
              found.stageId &&
              inc.stageId &&
              String(found.stageId) !== String(inc.stageId)
            ) {
              merged.stageId = found.stageId;
            }

            // Keep stable id if table uses auto primary key
            if (primAuto && typeof primKeyPath === "string" && found[primKeyPath] != null) {
              merged[primKeyPath] = found[primKeyPath];
            }

            // Preserve createdAt if already present
            if (found.createdAt && !inc.createdAt) merged.createdAt = found.createdAt;

            // Re-normaliza username/usernameLower para corrigir dados legados
            // (ex.: backup antigo com "@johndoe" ou "JohnDoe" no campo username)
            merged = normalizeLeadUsernameFields(merged);

            toPut.push(merged);
            updated++;
          } else {
            let fresh = { ...inc };

            // Strip auto PK on new rows
            if (primAuto && typeof primKeyPath === "string") {
              delete fresh[primKeyPath];
            }

            // Ensure createdAt exists going forward
            if (!fresh.createdAt) fresh.createdAt = Date.now();

            // Normaliza username/usernameLower antes de inserir
            fresh = normalizeLeadUsernameFields(fresh);

            toAdd.push(fresh);
            added++;
          }
        }

        if (toPut.length) await table.bulkPut(toPut);
        if (toAdd.length) await table.bulkAdd(toAdd);

        result.tables.push({ name, incoming: incoming.length, added, updated, skipped });
        continue;
      }

      // Generic merge: bulkPut rows with PK; bulkAdd rows without PK (strip auto PK if needed)
      const withPk: any[] = [];
      const withoutPk: any[] = [];

      const pkName = typeof primKeyPath === "string" ? primKeyPath : undefined;

      for (const inc of incoming) {
        if (!inc) {
          skipped++;
          continue;
        }
        if (pkName && inc[pkName] != null) {
          withPk.push(inc);
        } else {
          const copy = { ...inc };
          if (primAuto && pkName) delete copy[pkName];
          withoutPk.push(copy);
        }
      }

      if (withPk.length) {
        await table.bulkPut(withPk);
        updated += withPk.length; // approximate (upsert)
      }
      if (withoutPk.length) {
        await table.bulkAdd(withoutPk);
        added += withoutPk.length;
      }

      result.tables.push({ name, incoming: incoming.length, added, updated, skipped });
    }
  });

  return result;
}

export async function importIgnisBackupFromFile(
  file: File,
  options: ImportOptions = {},
): Promise<ImportResult> {
  const text = await file.text();
  return importIgnisBackupFromJson(text, options);
}
