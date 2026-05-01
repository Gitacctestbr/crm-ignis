# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Chrome development server with HMR
npm run dev:firefox  # Firefox development server
npm run build        # Production build (Chrome)
npm run build:firefox
npm run zip          # Distributable ZIP for Chrome Web Store
npm run compile      # TypeScript type-check only (no emit)
```

No lint or test framework is configured. Type-check with `npm run compile`.

### macOS / nvm note

Node is installed via nvm. If `npm` is not found in a non-interactive shell (e.g., CI or subprocess), prefix commands with:

```bash
export NVM_DIR="$HOME/.nvm" && source "$NVM_DIR/nvm.sh"
```

The extension output lands in `.output/chrome-mv3-dev/` (dot-prefixed, hidden by default on macOS). To load it in Chrome via "Load Unpacked", press `⌘ + Shift + .` in the file picker to toggle hidden file visibility.

## Architecture

**Ignis CRM** is a browser extension (Chrome/Firefox) built with [WXT](https://wxt.dev/), React 19, and TypeScript. It's a local Kanban CRM for managing Instagram leads with two boards: Outbound and Social Selling.

### Entry Points (`entrypoints/`)

WXT maps each file here to an extension manifest entry:
- `background.ts` — service worker; handles lead capture messages from content script and DM smart features
- `content.ts` — injected into Instagram pages; scrapes profile metadata (username, avatar)
- `popup/` — small action popup for quick capture
- `sidepanel/` — main CRM UI (Kanban board, metrics, tasks)
- `dashboard/` — full-page analytics and lead management

### Data Layer (`src/db/`)

All persistence is local via **Dexie** (IndexedDB wrapper). No server or cloud sync.
- `db.ts` — schema definitions: `Lead`, `Task`, `ActivityEvent`, `DailyMetrics`
- `leadsRepo.ts` — all lead CRUD and query functions
- `metricsRepo.ts` — daily KPI tracking (messages sent/received, CTAs, follow-ups)
- `backup.ts` — JSON export/import for backup-restore

Leads are scoped by `workspaceId` (currently hardcoded to `"default"`).

**DB versioning:** schema changes require a new `this.version(N).stores({...})` block in `db.ts` — never mutate an existing version. Current version is **3**.

**`updateLead` patch allowlist:** the `patch` parameter uses an explicit `Pick<Lead, ...>` in `leadsRepo.ts`. Any new `Lead` field that should be patchable must be added both to the `Lead` type in `db.ts` **and** to the `Pick` union in `leadsRepo.ts`.

### Domain Logic (`src/crm/`)

`stages.ts` defines the 13-stage sales pipeline shared by both boards. Stage IDs are stable keys used in the DB; display labels are in Portuguese.

### Instagram Integration (`src/instagram/`)

`parseInstagram.ts` handles URL parsing and username extraction. Avatar fetching uses the `web_profile_info` Instagram API endpoint with DOM fallback.

#### ⚠️ Limitações críticas do content.ts — leia antes de qualquer feature de integração

O `content.ts` é injetado no Instagram, mas sua capacidade de leitura é restrita:

**O que funciona hoje:**
- Extração de username via URL do perfil (`instagram.com/{username}/`)
- Detecção de rota: sabe quando o usuário está em `/direct/` ou num perfil

**O que NÃO funciona e NUNCA funcionou:**
- Busca ou exibição de avatar/foto do lead — não existe em nenhuma parte do CRM
- Na tela de DMs (`instagram.com/direct/t/{thread_id}/`), a URL não contém o username do lead — o `content.ts` é cego quanto a *com quem* o usuário está conversando. Qualquer tentativa de scraping de DOM nessa rota é instável e proibida
- A extensão não faz nenhuma leitura confiável do DOM do Instagram além da URL

**Regra absoluta para features na rota `/direct/`:**
- Nunca tentar detectar o username do lead via scraping de DOM na DM
- Toda identificação de lead nessa rota é manual (busca por nome ou @ no painel)
- O único dado confiável disponível na DM é: "o usuário está numa DM" (detecção de rota via URL)

**Antes de implementar qualquer feature de integração com Instagram:**
1. Verifique em qual rota a feature precisa funcionar
2. Se for em `/direct/`: identificação de lead é sempre manual, sem scraping
3. Se for em `/username/`: username disponível via URL, use `parseInstagram.ts`

### Shared UI (`src/ui/`)

Headless functional components styled with **Tailwind CSS v4**. Reuse these before creating new ones.

### Main App (`src/app/SidePanelApp.tsx`)

Top-level orchestrator for the side panel; manages view routing and state between the Kanban board, metrics panel, and task list.

## Key Configuration

- `wxt.config.ts` — extension manifest, permissions (`sidePanel`, `tabs`, `downloads`, `unlimitedStorage`), host permissions for `instagram.com`
- `tsconfig.json` — strict TypeScript
- Tailwind is integrated via `@tailwindcss/vite` (v4 approach, no `tailwind.config.js`)

## Tech Stack

| Layer | Library |
|---|---|
| Extension framework | WXT 0.20 |
| UI | React 19 |
| Styling | Tailwind CSS 4 |
| Database | Dexie 4 (IndexedDB) |
| Language | TypeScript 5.9 |