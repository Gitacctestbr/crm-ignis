import React from "react";
import { useReactiveQuery } from "../utils/useReactiveQuery";
import { listLeadsForReview } from "../db/leadsRepo";
import type { Lead } from "../db/db";
import { LeadReviewModal } from "./LeadReviewModal";

type Props = {
  workspaceId: string;
};

/**
 * Banner que aparece no topo do sidepanel quando há leads pendentes de revisão.
 * Clicar abre o modal com a lista (cada item leva pra tela de correção).
 *
 * Esconde quando não há leads em revisão (zero overhead visual no caso comum).
 */
export function ReviewBanner({ workspaceId }: Props) {
  const [open, setOpen] = React.useState(false);

  const { data: leads = [] } = useReactiveQuery<Lead[]>(
    () => listLeadsForReview({ workspaceId }),
    [workspaceId],
  );

  if (!leads.length) return null;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        style={{
          width: "100%",
          marginTop: 10,
          padding: "10px 14px",
          background:
            "linear-gradient(135deg, rgba(251,191,36,0.12), rgba(251,191,36,0.04))",
          border: "1px solid rgba(251,191,36,0.35)",
          borderRadius: 10,
          color: "rgb(251,191,36)",
          fontSize: 12,
          fontWeight: 500,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          textAlign: "left",
        }}
      >
        <span>
          ⚠️ <b>{leads.length} {leads.length === 1 ? "lead" : "leads"}</b>{" "}
          {leads.length === 1 ? "precisa" : "precisam"} de revisão (OCR ambíguo)
        </span>
        <span style={{ fontSize: 16 }}>›</span>
      </button>

      {open && (
        <ReviewListModal
          workspaceId={workspaceId}
          leads={leads}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function ReviewListModal({
  workspaceId,
  leads,
  onClose,
}: {
  workspaceId: string;
  leads: Lead[];
  onClose: () => void;
}) {
  const [selected, setSelected] = React.useState<Lead | null>(null);

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.7)",
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#0f0f12",
          border: "1px solid rgba(251,191,36,0.3)",
          borderRadius: 16,
          maxWidth: 480,
          width: "100%",
          maxHeight: "85vh",
          overflowY: "auto",
          padding: 20,
          color: "#e5e5e7",
          fontFamily: "-apple-system, system-ui, sans-serif",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div style={{ fontSize: 16, fontWeight: 600 }}>
            ⚠️ Leads pra revisar ({leads.length})
          </div>
          <button
            onClick={onClose}
            style={{
              background: "transparent",
              border: "none",
              color: "#86868b",
              fontSize: 22,
              cursor: "pointer",
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>

        <div style={{ fontSize: 12, color: "#a1a1aa", marginBottom: 14, lineHeight: 1.5 }}>
          O OCR não conseguiu identificar 100% do username. Confira a foto original
          e ajusta manualmente. Cada lead tem o motivo da dúvida do scanner.
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {leads.map((lead) => (
            <button
              key={lead.id}
              onClick={() => setSelected(lead)}
              style={{
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.08)",
                borderRadius: 10,
                padding: "10px 12px",
                color: "#e5e5e7",
                cursor: "pointer",
                textAlign: "left",
                display: "flex",
                gap: 10,
                alignItems: "center",
              }}
            >
              <div
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 999,
                  background: "rgba(251,191,36,0.15)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 16,
                  flexShrink: 0,
                }}
              >
                ⚠️
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500 }}>
                  {lead.displayName || "Sem nome"}
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: "#a1a1aa",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {lead.extractionObs || "OCR ambíguo"}
                </div>
              </div>
              <span style={{ color: "#71717a", fontSize: 14 }}>›</span>
            </button>
          ))}
        </div>
      </div>

      {selected && (
        <LeadReviewModal
          workspaceId={workspaceId}
          lead={selected}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
