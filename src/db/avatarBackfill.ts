// Backfill de avatares para leads que ainda não têm foto.
//
// O endpoint web_profile_info do IG só responde de dentro de uma aba do IG
// autenticada — então este módulo depende de:
//   - haver pelo menos uma aba do IG aberta;
//   - o usuário estar logado naquela aba.
//
// Comportamento:
//   - Itera leads sem avatarUrl, em ordem de updatedAt desc (lead mais "vivo"
//     primeiro — o usuário tipicamente quer ver foto nos cards que está mexendo).
//   - Faz uma requisição por vez com pequena pausa para não estourar rate-limit
//     do IG. Caller pode parar via flag `cancelled`.
//   - Atualiza o banco assim que cada avatar chega — UI recebe broadcast e
//     re-renderiza incrementalmente, em vez de esperar o batch acabar.

import { db } from "./db";
import { updateLead } from "./leadsRepo";
import { fetchAvatarForUsername } from "../instagram/avatarFetcher";

export type BackfillProgress = {
  done: number;
  total: number;
  updated: number;
  skipped: number;
};

export type BackfillResult = BackfillProgress & {
  cancelled: boolean;
};

const STEP_DELAY_MS = 250;

function sleep(ms: number) {
  return new Promise<void>((res) => window.setTimeout(res, ms));
}

export async function backfillMissingAvatars(input: {
  workspaceId: string;
  onProgress?: (p: BackfillProgress) => void;
  shouldCancel?: () => boolean;
}): Promise<BackfillResult> {
  const all = await db.leads.where("workspaceId").equals(input.workspaceId).toArray();
  const missing = all
    .filter((l) => !l.avatarUrl)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

  const total = missing.length;
  let updated = 0;
  let skipped = 0;
  let cancelled = false;

  console.log(`[CRM IGNIS][avatar][backfill] iniciando — ${total} leads sem foto`);
  input.onProgress?.({ done: 0, total, updated, skipped });

  for (let i = 0; i < missing.length; i++) {
    if (input.shouldCancel?.()) {
      console.log("[CRM IGNIS][avatar][backfill] cancelado pelo usuário");
      cancelled = true;
      break;
    }

    const lead = missing[i];
    try {
      const url = await fetchAvatarForUsername(lead.username);
      if (url) {
        await updateLead({
          workspaceId: input.workspaceId,
          leadId: lead.id,
          patch: { avatarUrl: url },
        });
        updated++;
        console.log(
          `[CRM IGNIS][avatar][backfill] ✅ @${lead.username} (${i + 1}/${total}) — ${url.startsWith("data:") ? "data URL" : "URL"}`,
        );
      } else {
        skipped++;
        console.warn(
          `[CRM IGNIS][avatar][backfill] ⚠️ @${lead.username} (${i + 1}/${total}) — sem avatar`,
        );
      }
    } catch (e) {
      skipped++;
      console.error(`[CRM IGNIS][avatar][backfill] ❌ @${lead.username}:`, e);
    }

    input.onProgress?.({ done: i + 1, total, updated, skipped });

    if (i < missing.length - 1) await sleep(STEP_DELAY_MS);
  }

  console.log(
    `[CRM IGNIS][avatar][backfill] fim — ${updated} atualizados, ${skipped} pulados, cancelado=${cancelled}`,
  );

  return { done: Math.min(missing.length, updated + skipped), total, updated, skipped, cancelled };
}

/**
 * Re-busca o avatar de um único lead — usado para refresh manual quando o
 * usuário clica num card e percebe que a CDN expirou a foto antiga.
 */
export async function refreshAvatarForLead(input: {
  workspaceId: string;
  leadId: string;
  username: string;
}): Promise<string | null> {
  const url = await fetchAvatarForUsername(input.username);
  if (!url) return null;
  await updateLead({
    workspaceId: input.workspaceId,
    leadId: input.leadId,
    patch: { avatarUrl: url },
  });
  return url;
}
