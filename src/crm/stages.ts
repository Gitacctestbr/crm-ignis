// react/src/crm/stages.ts
// Fonte única de verdade para estágios do CRM (Kanban)

export type StageId =
  | "LEADS_NOVOS"
  | "ABORDAGEM_ENVIADA"
  | "ABORDAGEM_RESPONDIDA"
  | "PERGUNTA_ENVIADA"
  | "PERGUNTA_RESPONDIDA"
  | "CTA_REALIZADO"
  | "ACEITOU_CALL"
  | "AGENDAMENTO_COMPLETO"
  | "COMPARECEU"
  | "NO_SHOW"
  | "REAGENDAR"
  | "FECHADO_GANHO"
  | "PERDIDO";

export const STAGES: Array<{ id: StageId; label: string }> = [
  { id: "LEADS_NOVOS", label: "Leads novos" },
  { id: "ABORDAGEM_ENVIADA", label: "Abordagem enviada" },
  { id: "ABORDAGEM_RESPONDIDA", label: "Abordagem respondida" },
  { id: "PERGUNTA_ENVIADA", label: "Pergunta enviada" },
  { id: "PERGUNTA_RESPONDIDA", label: "Pergunta respondida" },
  { id: "CTA_REALIZADO", label: "CTA realizado" },
  { id: "ACEITOU_CALL", label: "Aceitou call" },
  { id: "AGENDAMENTO_COMPLETO", label: "Agendamento completo" },
  { id: "COMPARECEU", label: "Compareceu" },
  { id: "NO_SHOW", label: "No-show" },
  { id: "REAGENDAR", label: "Reagendar" },
  { id: "FECHADO_GANHO", label: "Fechado (ganho)" },
  { id: "PERDIDO", label: "Perdido" },
];

const byId = new Map(STAGES.map((s) => [s.id, s.label]));

export function stageLabel(id: string) {
  return byId.get(id as StageId) ?? id;
}

/**
 * Normaliza estágios antigos/variantes para os IDs oficiais acima.
 * Isso evita “sumir lead” quando o app evolui e muda nomes.
 */
export function normalizeStageId(raw: string): StageId {
  const direct = String(raw || "").trim() as StageId;
  if (byId.has(direct)) return direct;

  const s = String(raw || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");

  // Variantes antigas (português) -> IDs oficiais
  const map: Record<string, StageId> = {
    "leads novos": "LEADS_NOVOS",
    "leads novos (social)": "LEADS_NOVOS",
    "lead novo": "LEADS_NOVOS",

    "abordagem enviada": "ABORDAGEM_ENVIADA",
    "abordagem respondida": "ABORDAGEM_RESPONDIDA",

    "pergunta enviada": "PERGUNTA_ENVIADA",
    "pergunta respondida": "PERGUNTA_RESPONDIDA",

    "cta realizado": "CTA_REALIZADO",
    "aceitou call": "ACEITOU_CALL",
    "agendamento completo": "AGENDAMENTO_COMPLETO",
    "compareceu": "COMPARECEU",
    "no show": "NO_SHOW",
    "no-show": "NO_SHOW",
    "reagendar": "REAGENDAR",

    "fechado ganho": "FECHADO_GANHO",
    "fechado (ganho)": "FECHADO_GANHO",

    "perdido": "PERDIDO",
  };

  if (map[s]) return map[s];

  // Heurística: contém termos
  if (s.includes("lead") && s.includes("novo")) return "LEADS_NOVOS";
  if (s.includes("abordagem") && s.includes("envi")) return "ABORDAGEM_ENVIADA";
  if (s.includes("abordagem") && s.includes("respond")) return "ABORDAGEM_RESPONDIDA";
  if (s.includes("pergunta") && s.includes("envi")) return "PERGUNTA_ENVIADA";
  if (s.includes("pergunta") && s.includes("respond")) return "PERGUNTA_RESPONDIDA";
  if (s.includes("cta")) return "CTA_REALIZADO";
  if (s.includes("aceitou") && s.includes("call")) return "ACEITOU_CALL";
  if (s.includes("agend")) return "AGENDAMENTO_COMPLETO";
  if (s.includes("comparec")) return "COMPARECEU";
  if (s.replace(/[^a-z]/g, "").includes("noshow")) return "NO_SHOW";
  if (s.includes("reagend")) return "REAGENDAR";
  if (s.includes("ganho") || s.includes("fechad")) return "FECHADO_GANHO";
  if (s.includes("perdid")) return "PERDIDO";

  // Fallback seguro: sempre joga pra “Leads novos”
  return "LEADS_NOVOS";
}
