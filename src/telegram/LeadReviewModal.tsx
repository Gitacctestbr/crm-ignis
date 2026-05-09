import React from "react";
import type { Lead } from "../db/db";
import { reviewLead, deleteLead } from "../db/leadsRepo";
import { supabase } from "../utils/supabaseClient";

type Props = {
  workspaceId: string;
  lead: Lead;
  onClose: () => void;
};

/**
 * Tela de correção de lead em revisão.
 * Mostra a imagem original (signed URL do bucket print_review) ao lado
 * do form. SDR digita o username correto e confirma.
 *
 * Se o username corrigido já existe ativo, descarta o placeholder e
 * avisa "já existia em <stage>" — comportamento equivalente ao addLead.
 */
export function LeadReviewModal({ workspaceId, lead, onClose }: Props) {
  const [username, setUsername] = React.useState(lead.displayName === "(revisar OCR)" ? "" : lead.username || "");
  const [displayName, setDisplayName] = React.useState(
    lead.displayName === "(revisar OCR)" ? "" : (lead.displayName || ""),
  );
  const [notes, setNotes] = React.useState(lead.notes || "");
  const [imageUrl, setImageUrl] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [info, setInfo] = React.useState<string | null>(null);

  // Gera signed URL pra imagem original (vale por 1h)
  React.useEffect(() => {
    if (!lead.originalPrintUrl) {
      setImageUrl(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const { data, error: e } = await supabase.storage
          .from("print_review")
          .createSignedUrl(lead.originalPrintUrl as string, 3600);
        if (cancelled) return;
        if (e || !data?.signedUrl) {
          console.warn("[CRM IGNIS] signed URL falhou:", e);
          setImageUrl(null);
        } else {
          setImageUrl(data.signedUrl);
        }
      } catch (err) {
        console.warn("[CRM IGNIS] signed URL throw:", err);
        if (!cancelled) setImageUrl(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [lead.originalPrintUrl]);

  async function handleSave() {
    setError(null);
    setInfo(null);
    if (!username.trim()) {
      setError("Username obrigatório.");
      return;
    }
    setBusy(true);
    try {
      const result = await reviewLead({
        workspaceId,
        leadId: lead.id,
        username: username.trim(),
        displayName: displayName.trim() || undefined,
        notes,
      });

      if (!result) {
        setError("Lead não encontrado.");
        return;
      }
      if (result.status === "merged_into_existing") {
        setInfo(
          `🔁 @${result.existingLead.username} já existia (${result.existingLead.stageId}). Esse placeholder foi descartado.`,
        );
        // Fecha após delay pra usuário ler
        setTimeout(onClose, 1800);
        return;
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleDiscard() {
    if (!confirm("Descartar esse lead? Não dá pra desfazer (vai pra lixeira).")) return;
    setBusy(true);
    try {
      await deleteLead({ workspaceId, leadId: lead.id });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.85)",
        zIndex: 10000,
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
          border: "1px solid rgba(251,191,36,0.4)",
          borderRadius: 16,
          maxWidth: 540,
          width: "100%",
          maxHeight: "92vh",
          overflowY: "auto",
          padding: 20,
          color: "#e5e5e7",
          fontFamily: "-apple-system, system-ui, sans-serif",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div style={{ fontSize: 16, fontWeight: 600 }}>⚠️ Revisar lead</div>
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

        {lead.extractionObs && (
          <div
            style={{
              fontSize: 12,
              color: "rgb(251,191,36)",
              background: "rgba(251,191,36,0.08)",
              border: "1px solid rgba(251,191,36,0.25)",
              borderRadius: 8,
              padding: "8px 12px",
              marginBottom: 12,
              lineHeight: 1.5,
            }}
          >
            <b>Dúvida do scanner:</b> {lead.extractionObs}
          </div>
        )}

        {imageUrl ? (
          <div
            style={{
              background: "#000",
              borderRadius: 10,
              overflow: "hidden",
              marginBottom: 14,
              maxHeight: 320,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <img
              src={imageUrl}
              alt="Print original"
              style={{ width: "100%", height: "auto", maxHeight: 320, objectFit: "contain" }}
            />
          </div>
        ) : (
          <div
            style={{
              fontSize: 11,
              color: "#71717a",
              background: "rgba(255,255,255,0.03)",
              borderRadius: 8,
              padding: "10px 12px",
              marginBottom: 12,
              textAlign: "center",
            }}
          >
            Imagem original não disponível
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 11, color: "#a1a1aa", fontWeight: 500 }}>Username (sem @)</span>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="ex: monilenogueira"
              style={inputStyle}
              autoFocus
            />
          </label>

          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 11, color: "#a1a1aa", fontWeight: 500 }}>Nome (opcional)</span>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Nome de exibição"
              style={inputStyle}
            />
          </label>

          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 11, color: "#a1a1aa", fontWeight: 500 }}>Notas</span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={4}
              style={{ ...inputStyle, minHeight: 80, resize: "vertical", fontFamily: "inherit" }}
            />
          </label>
        </div>

        {error && (
          <div
            style={{
              marginTop: 10,
              fontSize: 12,
              color: "rgb(248,113,113)",
              background: "rgba(248,113,113,0.08)",
              border: "1px solid rgba(248,113,113,0.25)",
              borderRadius: 8,
              padding: "8px 12px",
            }}
          >
            {error}
          </div>
        )}

        {info && (
          <div
            style={{
              marginTop: 10,
              fontSize: 12,
              color: "rgb(74,222,128)",
              background: "rgba(74,222,128,0.08)",
              border: "1px solid rgba(74,222,128,0.25)",
              borderRadius: 8,
              padding: "8px 12px",
            }}
          >
            {info}
          </div>
        )}

        <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
          <button
            onClick={handleDiscard}
            disabled={busy}
            style={{
              padding: "10px 14px",
              borderRadius: 10,
              border: "1px solid rgba(248,113,113,0.35)",
              background: "rgba(248,113,113,0.08)",
              color: "rgb(248,113,113)",
              fontSize: 12,
              cursor: busy ? "default" : "pointer",
              opacity: busy ? 0.5 : 1,
            }}
          >
            Descartar
          </button>
          <div style={{ flex: 1 }} />
          <button
            onClick={onClose}
            disabled={busy}
            style={{
              padding: "10px 14px",
              borderRadius: 10,
              border: "1px solid rgba(255,255,255,0.12)",
              background: "rgba(255,255,255,0.04)",
              color: "#e5e5e7",
              fontSize: 12,
              cursor: busy ? "default" : "pointer",
            }}
          >
            Cancelar
          </button>
          <button
            onClick={handleSave}
            disabled={busy}
            style={{
              padding: "10px 18px",
              borderRadius: 10,
              border: "1px solid rgba(234,124,48,0.5)",
              background: "rgba(234,124,48,0.18)",
              color: "rgb(251,191,36)",
              fontSize: 12,
              fontWeight: 500,
              cursor: busy ? "default" : "pointer",
              opacity: busy ? 0.5 : 1,
            }}
          >
            {busy ? "Salvando…" : "✓ Salvar"}
          </button>
        </div>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  height: 40,
  padding: "0 12px",
  borderRadius: 8,
  border: "1px solid rgba(255,255,255,0.1)",
  background: "rgba(0,0,0,0.4)",
  color: "#e5e5e7",
  fontSize: 13,
  outline: "none",
  fontFamily: "inherit",
};
