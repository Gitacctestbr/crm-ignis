import { defineConfig } from "wxt";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  modules: ["@wxt-dev/module-react"],

  manifest: {
    name: "CRM IGNIS",
    description: "CRM Kanban local para leads do Instagram (uso interno).",

    // IMPORTANTE: a Chrome Web Store exige aumentar a versão a cada novo envio
    version: "0.0.2",

    // Só permissões usadas HOJE
    permissions: ["sidePanel", "tabs", "downloads", "unlimitedStorage", "storage", "alarms"],
    optional_permissions: ["notifications"],

    host_permissions: [
      "https://www.instagram.com/*",
      "https://instagram.com/*",
      "https://i.instagram.com/*",
      // CDN do IG — necessário para baixar bytes da foto de perfil de dentro do
      // content script e converter pra data URL. Sem essas permissões, fetch
      // dispara CORS error e a foto nunca carrega no card.
      "https://*.cdninstagram.com/*",
      "https://*.fbcdn.net/*",
    ],

    action: {
      default_title: "CRM IGNIS",
      default_popup: "popup.html",
    },

    side_panel: {
      default_path: "sidepanel.html",
    },
  },

  vite: () => ({
    plugins: [tailwindcss()],
  }),
});
