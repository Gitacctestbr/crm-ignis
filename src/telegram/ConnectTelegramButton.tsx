import React from "react";
import { useReactiveQuery } from "../utils/useReactiveQuery";
import { isWorkspaceConnected } from "./connectionRepo";
import { BOT_DISPLAY_NAME, BOT_USERNAME, buildConnectLink } from "./config";

type Props = {
  workspaceId: string;
  /** Estilo do botão: 'header' (compacto) ou 'banner' (grande). */
  variant?: "header" | "banner";
};

/**
 * Botão "Conectar Telegram" + modal com link mágico e QR code.
 * Mostra estado: 🟢 conectado | 🟡 desconectado.
 * Reativo: re-roda a query ao receber CRM_IGNIS_DB_UPDATED.
 */
export function ConnectTelegramButton({ workspaceId, variant = "header" }: Props) {
  const [open, setOpen] = React.useState(false);

  const { data: connected = false } = useReactiveQuery<boolean>(
    () => isWorkspaceConnected(workspaceId),
    [workspaceId],
  );

  if (variant === "banner" && connected) {
    return null; // já tá conectado, banner some
  }

  const buttonStyle: React.CSSProperties = variant === "header"
    ? {
        fontSize: 11,
        padding: "6px 12px",
        borderRadius: 999,
        border: connected
          ? "1px solid rgba(34,197,94,0.45)"
          : "1px solid rgba(234,124,48,0.45)",
        background: connected ? "rgba(34,197,94,0.08)" : "rgba(234,124,48,0.08)",
        color: connected ? "rgb(74,222,128)" : "rgb(251,191,36)",
        cursor: "pointer",
        fontWeight: 500,
      }
    : {
        width: "100%",
        padding: "12px 16px",
        borderRadius: 12,
        border: "1px solid rgba(234,124,48,0.4)",
        background:
          "linear-gradient(135deg, rgba(234,124,48,0.12) 0%, rgba(234,124,48,0.04) 100%)",
        color: "rgb(251,191,36)",
        cursor: "pointer",
        fontSize: 13,
        fontWeight: 500,
        textAlign: "left" as const,
        display: "flex",
        alignItems: "center",
        gap: 12,
      };

  return (
    <>
      <button onClick={() => setOpen(true)} style={buttonStyle}>
        {variant === "header" ? (
          <>{connected ? "🟢" : "📲"} Telegram</>
        ) : (
          <>
            <span style={{ fontSize: 24 }}>📲</span>
            <span style={{ flex: 1 }}>
              <div style={{ fontWeight: 600 }}>Conecta seu Telegram</div>
              <div style={{ fontSize: 11, opacity: 0.75 }}>
                Pra capturar leads do celular tirando print
              </div>
            </span>
            <span>›</span>
          </>
        )}
      </button>

      {open && (
        <ConnectModal
          workspaceId={workspaceId}
          connected={connected}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function ConnectModal({
  workspaceId,
  connected,
  onClose,
}: {
  workspaceId: string;
  connected: boolean;
  onClose: () => void;
}) {
  const link = buildConnectLink(workspaceId);
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(link)}`;
  const [copied, setCopied] = React.useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback discreto
      window.prompt("Copia esse link manualmente:", link);
    }
  }

  function handleOpenTelegram() {
    chrome.tabs.create({ url: link, active: true });
  }

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
          border: "1px solid rgba(234,124,48,0.3)",
          borderRadius: 16,
          maxWidth: 400,
          width: "100%",
          padding: 24,
          color: "#e5e5e7",
          fontFamily: "-apple-system, system-ui, sans-serif",
          maxHeight: "92vh",
          overflowY: "auto",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <div style={{ fontSize: 16, fontWeight: 600 }}>
            {connected ? "🟢 Telegram conectado" : "📲 Conectar Telegram"}
          </div>
          <button
            onClick={onClose}
            style={{
              background: "transparent",
              border: "none",
              color: "#86868b",
              fontSize: 22,
              cursor: "pointer",
              padding: 0,
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>

        <div style={{ fontSize: 13, color: "#a1a1aa", marginBottom: 16, lineHeight: 1.5 }}>
          {connected ? (
            <>
              Seu workspace já está conectado a um chat do Telegram. Pra adicionar
              <b> outro celular </b> (multi-operador) ou <b>trocar</b>, clica no link
              abaixo no celular novo.
            </>
          ) : (
            <>
              <b>1.</b> Abre esse link no <b>celular</b> (ou escaneia o QR)<br />
              <b>2.</b> Aperta <b>"Iniciar"</b> na conversa com {BOT_DISPLAY_NAME}<br />
              <b>3.</b> Pronto. Manda print de perfil do Instagram que vira lead.
            </>
          )}
        </div>

        <div
          style={{
            background: "#fff",
            padding: 8,
            borderRadius: 12,
            display: "flex",
            justifyContent: "center",
            marginBottom: 12,
          }}
        >
          <img src={qrUrl} alt="QR code" width={240} height={240} style={{ display: "block" }} />
        </div>

        <div
          style={{
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 8,
            padding: "8px 12px",
            fontSize: 11,
            fontFamily: "ui-monospace, SF Mono, Menlo, monospace",
            color: "#a1a1aa",
            wordBreak: "break-all",
            marginBottom: 8,
          }}
        >
          {link}
        </div>

        <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          <button
            onClick={handleCopy}
            style={{
              flex: 1,
              padding: "10px",
              borderRadius: 10,
              border: "1px solid rgba(255,255,255,0.12)",
              background: copied ? "rgba(34,197,94,0.15)" : "rgba(255,255,255,0.04)",
              color: copied ? "rgb(74,222,128)" : "#e5e5e7",
              fontSize: 12,
              cursor: "pointer",
              transition: "all 0.15s",
            }}
          >
            {copied ? "✓ Copiado" : "Copiar link"}
          </button>
          <button
            onClick={handleOpenTelegram}
            style={{
              flex: 1,
              padding: "10px",
              borderRadius: 10,
              border: "1px solid rgba(234,124,48,0.4)",
              background: "rgba(234,124,48,0.12)",
              color: "rgb(251,191,36)",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            Abrir no Telegram
          </button>
        </div>

        <div
          style={{
            fontSize: 11,
            color: "#71717a",
            background: "rgba(255,255,255,0.03)",
            padding: "10px 12px",
            borderRadius: 8,
            lineHeight: 1.5,
          }}
        >
          <b>⚠️ Não compartilhe esse link.</b> Quem clicar nele vincula o celular ao seu
          CRM. Em caso de dúvida sobre acesso, fala com o suporte.
          <br />
          <br />
          Bot: <b>@{BOT_USERNAME}</b>
        </div>
      </div>
    </div>
  );
}
