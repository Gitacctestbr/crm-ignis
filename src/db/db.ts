import Dexie, { Table } from "dexie";

export type BoardType = "OUTBOUND" | "SOCIAL";

export type Lead = {
  id: string;
  workspaceId: string;

  board: BoardType;
  stageId: string;

  username: string;
  usernameLower: string;

  displayName?: string;

  // ✅ NOVO: foto de perfil (opcional)
  avatarUrl?: string;

  priority: "low" | "medium" | "high";
  tags: string[];

  notes: string;

  createdAt: number;
  updatedAt: number;
  lastTouchedAt: number;
  nextFollowUpAt?: number;
  deletedAt?: number;

  // ✅ CTA (registro unificado)
  ctaUrl?: string;
  ctaAt?: number; // timestamp
  ctaNote?: string;
};

export type Task = {
  id: string;
  workspaceId: string;
  leadId: string;

  title: string;
  dueAt: number;
  doneAt?: number;

  status: "open" | "done" | "snoozed";
  snoozeUntil?: number;
};

export type ActivityEvent = {
  id: string;
  workspaceId: string;
  leadId: string;

  type:
    | "CREATED"
    | "MOVED_STAGE"
    | "NOTE_UPDATED"
    | "PRIORITY_CHANGED"
    | "TASK_CREATED"
    | "TASK_DONE";

  fromStageId?: string;
  toStageId?: string;

  at: number;
  day: number; // formato: yyyymmdd (para filtro por dia)
};

/**
 * Métricas diárias (controle igual planilha)
 * dateKey: "YYYY-MM-DD" (data local)
 */
export type DailyMetrics = {
  id: string; // `${workspaceId}:${board}:${dateKey}`
  workspaceId: string;
  board: BoardType;
  dateKey: string;

  // Novas abordagens
  msg1Disparos: number;
  msg1Respostas: number;
  msg2Disparos: number;
  msg2Respostas: number; // opcional (pode ficar 0)

  ctaDisparos: number;
  agendNovos: number;

  // Follow-up
  followEnviados: number;
  followRespostas: number;
  followCta: number;
  agendFollow: number;

  // controle
  createdAt: number;
  updatedAt: number;
  closedAt?: number;
};

/**
 * Banco local (IndexedDB) usando Dexie
 */
export class CrmIgnisDB extends Dexie {
  leads!: Table<Lead, string>;
  tasks!: Table<Task, string>;
  events!: Table<ActivityEvent, string>;
  dailyMetrics!: Table<DailyMetrics, string>;

  constructor() {
    super("crm-ignis");

    this.version(1).stores({
      leads:
        "id, workspaceId, [workspaceId+usernameLower], [workspaceId+board+stageId], *tags, [workspaceId+nextFollowUpAt], createdAt, updatedAt",
      tasks: "id, workspaceId, [workspaceId+status], [workspaceId+dueAt], [workspaceId+leadId]",
      events:
        "id, workspaceId, [workspaceId+type+day], [workspaceId+type+toStageId+day], [workspaceId+leadId], at",
    });

    // v2: adiciona tabela de métricas diárias
    this.version(2).stores({
      leads:
        "id, workspaceId, [workspaceId+usernameLower], [workspaceId+board+stageId], *tags, [workspaceId+nextFollowUpAt], createdAt, updatedAt",
      tasks: "id, workspaceId, [workspaceId+status], [workspaceId+dueAt], [workspaceId+leadId]",
      events:
        "id, workspaceId, [workspaceId+type+day], [workspaceId+type+toStageId+day], [workspaceId+leadId], at",
      dailyMetrics:
        "id, workspaceId, [workspaceId+board+dateKey], [workspaceId+dateKey], [workspaceId+board+closedAt], dateKey, updatedAt, closedAt",
    });

    // v3: adiciona campos de CTA no lead (sem mudar índices)
    this.version(3).stores({
      leads:
        "id, workspaceId, [workspaceId+usernameLower], [workspaceId+board+stageId], *tags, [workspaceId+nextFollowUpAt], createdAt, updatedAt",
      tasks: "id, workspaceId, [workspaceId+status], [workspaceId+dueAt], [workspaceId+leadId]",
      events:
        "id, workspaceId, [workspaceId+type+day], [workspaceId+type+toStageId+day], [workspaceId+leadId], at",
      dailyMetrics:
        "id, workspaceId, [workspaceId+board+dateKey], [workspaceId+dateKey], [workspaceId+board+closedAt], dateKey, updatedAt, closedAt",
    });

    // v4: schema idêntico à v3 — esta versão existe APENAS para rodar a migração
    // de dados (limpeza de username/usernameLower e deduplicação de leads
    // colididos por '@' ou maiúsculas). O upgrade hook abaixo executa em
    // transação dentro do próprio Dexie, garantindo atomicidade.
    //
    // ⚠️ Esta migração é frozen-in-time: as constantes e helpers vivem dentro
    // do callback para que mudanças futuras em outros arquivos (stages.ts,
    // leadsRepo.ts) NÃO alterem o comportamento histórico desta migração.
    this.version(4)
      .stores({
        leads:
          "id, workspaceId, [workspaceId+usernameLower], [workspaceId+board+stageId], *tags, [workspaceId+nextFollowUpAt], createdAt, updatedAt",
        tasks: "id, workspaceId, [workspaceId+status], [workspaceId+dueAt], [workspaceId+leadId]",
        events:
          "id, workspaceId, [workspaceId+type+day], [workspaceId+type+toStageId+day], [workspaceId+leadId], at",
        dailyMetrics:
          "id, workspaceId, [workspaceId+board+dateKey], [workspaceId+dateKey], [workspaceId+board+closedAt], dateKey, updatedAt, closedAt",
      })
      .upgrade(async (tx) => {
        // ─── Helpers locais (frozen-in-time) ──────────────────────────────
        // Snapshot da ordem de estágios no momento desta migração. Não
        // importar de stages.ts: se a ordem mudar no futuro, esta migração
        // legada deve continuar produzindo o mesmo resultado.
        const STAGE_ORDER: Record<string, number> = {
          LEADS_NOVOS: 0,
          ABORDAGEM_ENVIADA: 1,
          ABORDAGEM_RESPONDIDA: 2,
          PERGUNTA_ENVIADA: 3,
          PERGUNTA_RESPONDIDA: 4,
          CTA_REALIZADO: 5,
          ACEITOU_CALL: 6,
          AGENDAMENTO_COMPLETO: 7,
          COMPARECEU: 8,
          NO_SHOW: 9,
          REAGENDAR: 10,
          FECHADO_GANHO: 11,
          PERDIDO: 12,
        };

        const stageRank = (s: any): number =>
          STAGE_ORDER[String(s ?? "").trim()] ?? -1;

        const cleanUsername = (u: any): string =>
          String(u ?? "").trim().replace(/^@+/, "").toLowerCase();

        const hasNotes = (n: any): boolean =>
          String(n ?? "").trim().length > 0;

        const mergeNotes = (a: any, b: any): string => {
          const aN = String(a ?? "").trim();
          const bN = String(b ?? "").trim();
          if (!aN && !bN) return "";
          if (!aN) return bN;
          if (!bN) return aN;
          if (aN === bN) return aN;
          // Ambos têm notas distintas — concatena para não perder histórico
          return `${aN}\n---\n${bN}`;
        };

        const mergeTags = (a: any, b: any): string[] => {
          const aT = Array.isArray(a) ? a : [];
          const bT = Array.isArray(b) ? b : [];
          return Array.from(new Set([...aT, ...bT].map((t) => String(t))));
        };

        const pickNonEmpty = <T,>(a: T, b: T): T => {
          if (a === undefined || a === null || (a as any) === "") return b;
          return a;
        };

        const minDefined = (a: any, b: any): number | undefined => {
          const aN = Number(a || 0);
          const bN = Number(b || 0);
          if (!aN && !bN) return undefined;
          if (!aN) return bN;
          if (!bN) return aN;
          return Math.min(aN, bN);
        };

        // ─── Coleta + decisão de vencedores ───────────────────────────────
        const leadsTable = tx.table("leads");
        const allLeads = await leadsTable.toArray();

        // Map<"workspaceId::cleanUsernameLower", lead vencedor (já normalizado)>
        const winners = new Map<string, any>();
        const losersToDelete: string[] = [];
        let dirtyCount = 0;

        for (const lead of allLeads) {
          if (!lead || !lead.id) continue;

          const clean = cleanUsername(lead.username);
          if (!clean) {
            // Lead sem username válido — preserva no banco como está,
            // não tenta migrar (caso patológico, raro).
            continue;
          }

          const wsId = String(lead.workspaceId ?? "default");
          const key = `${wsId}::${clean}`;
          const existing = winners.get(key);

          // Detecta se este registro está "sujo" (precisa de re-escrita
          // mesmo que não seja duplicata) — para decidir se vale dar put.
          const isDirty =
            lead.username !== clean || lead.usernameLower !== clean;

          if (!existing) {
            const cleaned = {
              ...lead,
              username: clean,
              usernameLower: clean,
              workspaceId: wsId,
              // Garante que campos opcionais não sejam undefined-em-Dexie
              tags: Array.isArray(lead.tags) ? lead.tags : [],
              notes: String(lead.notes ?? ""),
              priority: lead.priority || "medium",
            };
            winners.set(key, cleaned);
            if (isDirty) dirtyCount++;
            continue;
          }

          // ─── Duplicata detectada — decide vencedor por estágio ──────────
          const existingRank = stageRank(existing.stageId);
          const incomingRank = stageRank(lead.stageId);

          let winner: any;
          let loser: any;

          if (incomingRank > existingRank) {
            winner = lead;
            loser = existing;
          } else if (incomingRank < existingRank) {
            winner = existing;
            loser = lead;
          } else {
            // Empate de estágio — desempata por presença de notas
            const existingHasN = hasNotes(existing.notes);
            const incomingHasN = hasNotes(lead.notes);
            if (incomingHasN && !existingHasN) {
              winner = lead;
              loser = existing;
            } else {
              // Default: mantém o existente (primeiro encontrado)
              winner = existing;
              loser = lead;
            }
          }

          // ─── Mescla os dados preservando o id do vencedor ───────────────
          // Spread loser primeiro (base), winner sobrescreve, depois overrides
          // explícitos para campos que precisam de regra de combinação.
          const merged = {
            ...loser,
            ...winner,
            id: winner.id, // sempre id do vencedor
            workspaceId: wsId,
            username: clean,
            usernameLower: clean,
            // Combinações cuidadosas para preservar dados:
            notes: mergeNotes(winner.notes, loser.notes),
            tags: mergeTags(winner.tags, loser.tags),
            displayName: pickNonEmpty(winner.displayName, loser.displayName),
            avatarUrl: pickNonEmpty(winner.avatarUrl, loser.avatarUrl),
            ctaUrl: pickNonEmpty(winner.ctaUrl, loser.ctaUrl),
            ctaAt: pickNonEmpty(winner.ctaAt, loser.ctaAt),
            ctaNote: pickNonEmpty(winner.ctaNote, loser.ctaNote),
            priority: winner.priority || loser.priority || "medium",
            // nextFollowUpAt: o mais cedo (mais urgente) entre os dois
            nextFollowUpAt: minDefined(
              winner.nextFollowUpAt,
              loser.nextFollowUpAt,
            ),
            // createdAt: o mais antigo (preserva histórico)
            createdAt: Math.min(
              Number(winner.createdAt || Date.now()),
              Number(loser.createdAt || Date.now()),
            ),
            updatedAt: Math.max(
              Number(winner.updatedAt || 0),
              Number(loser.updatedAt || 0),
            ),
            lastTouchedAt: Math.max(
              Number(winner.lastTouchedAt || 0),
              Number(loser.lastTouchedAt || 0),
            ),
            board: winner.board || loser.board,
            stageId: winner.stageId || loser.stageId,
          };

          winners.set(key, merged);
          // O id do perdedor (em iterações com merge encadeado, o "loser"
          // pode ser um merged anterior cujo id é de algum lead processado
          // antes — em qualquer caso, o id em loser.id é o que precisa sair).
          if (loser.id && loser.id !== winner.id) {
            losersToDelete.push(loser.id);
          }
        }

        // ─── Persistência atômica (dentro da transação do upgrade) ────────
        if (losersToDelete.length > 0) {
          await leadsTable.bulkDelete(losersToDelete);
        }

        if (winners.size > 0) {
          await leadsTable.bulkPut(Array.from(winners.values()));
        }

        // Telemetria de migração — útil para debugar via DevTools do worker
        console.log(
          `[CRM IGNIS] DB migration v3→v4: ${allLeads.length} processado(s), ` +
            `${dirtyCount} normalizado(s), ${losersToDelete.length} duplicata(s) mesclada(s) e removida(s).`,
        );
      });

    // v5: adiciona campo deletedAt (soft delete) — sem alteração de índices
    this.version(5).stores({
      leads:
        "id, workspaceId, [workspaceId+usernameLower], [workspaceId+board+stageId], *tags, [workspaceId+nextFollowUpAt], createdAt, updatedAt",
      tasks: "id, workspaceId, [workspaceId+status], [workspaceId+dueAt], [workspaceId+leadId]",
      events:
        "id, workspaceId, [workspaceId+type+day], [workspaceId+type+toStageId+day], [workspaceId+leadId], at",
      dailyMetrics:
        "id, workspaceId, [workspaceId+board+dateKey], [workspaceId+dateKey], [workspaceId+board+closedAt], dateKey, updatedAt, closedAt",
    });
  }
}

export const db = new CrmIgnisDB();

export function toDayKey(ts: number) {
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return Number(`${yyyy}${mm}${dd}`);
}
