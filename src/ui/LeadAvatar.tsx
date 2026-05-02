import React from "react";

type Props = {
  username: string;
  avatarUrl?: string | null;
  size?: number;
  fontSize?: number;
  borderColor?: string;
  bgColor?: string;
  textColor?: string;
  style?: React.CSSProperties;
  onClick?: () => void;
  title?: string;
  className?: string;
};

/**
 * Avatar do lead. Renderiza a foto quando disponível e cai para iniciais
 * automaticamente quando:
 *   - avatarUrl está vazio
 *   - URL não começa com http (gravado errado)
 *   - o navegador falha em carregar a imagem (CDN do IG expirou a query string
 *     assinada — comportamento esperado depois de algumas semanas)
 *
 * Tudo via inline style para funcionar igual no Shadow DOM (DmLeadPanel injetado
 * no Instagram) e no React tree normal (popup, sidepanel, dashboard).
 */
export function LeadAvatar({
  username,
  avatarUrl,
  size = 32,
  fontSize,
  borderColor = "rgba(234,124,48,0.30)",
  bgColor = "rgba(234,124,48,0.10)",
  textColor = "rgb(234, 124, 48)",
  style,
  onClick,
  title,
  className,
}: Props) {
  const [broken, setBroken] = React.useState(false);

  React.useEffect(() => {
    setBroken(false);
  }, [avatarUrl]);

  const initial = (String(username || "?")[0] || "?").toUpperCase();
  const isValidSrc =
    typeof avatarUrl === "string" &&
    (avatarUrl.startsWith("http") || avatarUrl.startsWith("data:"));
  const hasImg = isValidSrc && !broken;
  const fs = fontSize ?? Math.max(9, Math.round(size * 0.42));

  const baseStyle: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: 999,
    border: `1px solid ${borderColor}`,
    background: bgColor,
    flexShrink: 0,
    display: "grid",
    placeItems: "center",
    overflow: "hidden",
    cursor: onClick ? "pointer" : undefined,
    ...style,
  };

  const role = onClick ? "button" : undefined;
  const ariaLabel = `@${username}`;

  if (hasImg) {
    return (
      <div
        style={baseStyle}
        title={title}
        onClick={onClick}
        role={role}
        aria-label={ariaLabel}
        className={className}
      >
        <img
          src={avatarUrl as string}
          alt={ariaLabel}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => {
            console.warn(
              "[CRM IGNIS][avatar] img falhou pra @" + username,
              "src prefix:",
              String(avatarUrl).slice(0, 60),
            );
            setBroken(true);
          }}
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
        />
      </div>
    );
  }

  return (
    <div
      style={{
        ...baseStyle,
        color: textColor,
        fontWeight: 800,
        fontSize: fs,
      }}
      title={title}
      onClick={onClick}
      role={role}
      aria-label={ariaLabel}
      className={className}
    >
      {initial}
    </div>
  );
}
