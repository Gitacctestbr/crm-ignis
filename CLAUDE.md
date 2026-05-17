# CLAUDE.md

Instruções técnicas pro Claude Code trabalhar neste repositório.

---

## Comandos

```bash
npm run dev          # Chrome (HMR)
npm run dev:firefox  # Firefox
npm run build        # Build produção — output em .output/chrome-mv3
npm run compile      # Type-check sem emit
npm run zip          # ZIP do build (usado no deploy via VPS)
```

**macOS/nvm:** se `npm` não for encontrado: `export NVM_DIR="$HOME/.nvm" && source "$NVM_DIR/nvm.sh"`.

---

## Arquitetura

Extensão Chrome MV3 (WXT + React 19 + TypeScript + Tailwind v4). **Banco único: Supabase (PostgreSQL).** Não existe mais Dexie/IndexedDB local — toda escrita/leitura é HTTP. **Auth obrigatório** (Supabase Auth email/senha): sem sessão, operações em `background.ts` viram no-op; na UI lançam erro.

Multi-tenant por workspace. Convenção: `workspace_id === auth.uid()` (TEXT). RLS no Supabase isola entre usuários. A função `get_my_workspace_id()` no Postgres é o que toda policy consulta — mexer nela mexe em tudo.

UI reativa por broadcast: ao escrever, repos enviam `CRM_IGNIS_DB_UPDATED` via `chrome.runtime.sendMessage`. `useReactiveQuery` (em `src/utils/`) escuta e re-roda a query. **Se você escrever no Supabase sem passar pelo repo, a UI não atualiza.**

**Captura de leads via celular = bot do Telegram.** Pasta `bot/` (Python async com aiogram) roda na VPS via systemd, recebe prints, OCR via Claude Haiku 4.5 (fallback Sonnet 4.6 quando ambíguo), grava lead direto no Supabase. Deep-link: `t.me/IgnisCRM_bot?start=ws_<workspace_id>`. Tabelas: `telegram_links`, `print_cache`, `telegram_invites`. Sync via Google Sheets foi descontinuado.

---

## Design & UI

**Sempre invoque a skill `/design-agent` antes de criar/redesenhar componente, mudar layout, mexer em CSS/estilo inline, ou escolher cor/fonte.** Ela tem as regras não-negociáveis (hierarquia, tipografia, espaçamento, contraste) e o catálogo de bugs visuais conhecidos.

**Tokens canônicos em `assets/theme.css`** — fonte única de verdade. Use `rgb(var(--accent))`, `var(--radius)`, etc. Nunca hard-code `#ff7a18`. Cores em formato R G B (espaço separado) pra suportar alpha modifier do Tailwind.

**Fonte:** Inter via `@fontsource/inter` (weights 400/500/600/700/800). Importada em `assets/main.css` antes do `tailwindcss`. Não usar Google Fonts CDN (CSP de extensão pode bloquear) nem self-host artesanal.

**Identidade:** dark com gradiente sutil (laranja Ignis `#ea7c30` + teal acento `#2dd4bf`), glassmorphism leve, raios 10-14px, sombras `0 4-12px rgba(0,0,0,0.30-0.45)`. Tom "Notion-dark + alma Ignis": minimalista, espaçoso, legível.

**Popup (`entrypoints/popup/App.tsx`):** redesenhado em fluxo de views type-driven (`home` → `choose-funnel` → `preview` → `importing` → `done`). 3 ações: Abrir Kanban, Subir lista, Logout (footer). Ao tocar nele, preserve esse paradigma.

---

## Banco — regras absolutas

- **Schema canônico em `supabase_setup.sql`.** Migrações são SQL no painel do Supabase. Não existe `version(N+1)` (era Dexie).
- Adicionar/alterar coluna: editar `supabase_setup.sql` → rodar SQL incremental no painel → **revisar policies RLS** se a coluna afeta isolamento.
- `updateLead` tem patch allowlist explícita. Campo novo precisa entrar em **4 lugares**: tipo `Lead` em `db.ts`, tipo `LeadRow` em `leadsRepo.ts`, `Pick` da assinatura, e mappers `rowToLead`/`leadToRow`.
- `addLead` **não aceita `notes`** — chame `updateLead` logo após criar.
- **Soft delete obrigatório:** `deleted_at = Date.now()`, nunca `DELETE`. Funções de leitura já filtram. `addLead` previne re-import de soft-deleted via `canonicalUsername`.
- **Mapping snake_case ↔ camelCase** acontece DENTRO de cada repo (`rowTo*`/`*ToRow`). Nunca espalhe pela UI.

### Regra de ouro — `canonicalUsername`

Todo username (gravação, busca, comparação) **deve passar por `canonicalUsername`** (em `leadsRepo.ts`). Remove `@`, espaços, lowercase. Existe `CHECK` no Postgres rejeitando `username_lower` fora do canônico — pular = erro hard no banco.

---

## Auth

- Cliente em `src/utils/supabaseClient.ts`. Sessão persiste via storage adapter pro `chrome.storage.local` (porque `localStorage` não funciona em service worker).
- Use `getCurrentWorkspaceId()` em UI (lança se sem sessão); use `getCurrentUserId()` em `background.ts` (retorna null — no-op é melhor que crash do service worker).
- `AuthProvider` faz upsert idempotente em `user_workspaces` ao logar (mapeia `auth.uid()` → workspace_id).
- **Logout disponível no popup** (footer "Sair"). Após `signOut()`, AuthGate detecta ausência de sessão e renderiza `LoginScreen` automaticamente. Sem reload manual.

---

## Avatares

- `Lead.avatarUrl` opcional, mas preencha assim que possível. CDN URLs do Instagram expiram em semanas — `LeadAvatar` cai pra iniciais. Usuário roda backfill manual (botão "Atualizar fotos" no dashboard) pra refrescar.
- `backfillMissingAvatars` precisa de aba do IG aberta. Cap de 20 leads, delay 300ms por requisição. Nunca faça em loop apertado (rate limit do IG).

---

## Build & Deploy

A extensão **não vai pra Chrome Web Store**. Fluxo:

1. **Push pro GitHub** (Claude faz quando o usuário pede): `git add <arquivos> && git commit -m "..." && git push origin <branch>`. Stage seletivo, nunca `-A` (evita commitar `.env`, sensíveis, untracked acidental).
2. **Build na VPS via SSH** (host/user/path em memória privada do Claude — não neste arquivo):
   ```bash
   ssh <vps-user>@<vps-host> "cd <project-path> && git pull && npm install && npm run zip"
   ```
3. **Download do ZIP via `scp`:** `scp '<vps>:<path>/.output/*.zip' ~/Desktop/` (aspas no caminho remoto — o zsh local expande o glob senão).
4. **Load unpacked** em cada Chrome: extrai ZIP → `chrome://extensions` → "Modo de desenvolvedor" → "Carregar sem compactação". Login Supabase puxa os leads.

### Segurança do `.env`

- Anon key embutida no JS é pública por design (RLS protege). OK.
- `.env` na VPS **NUNCA pode ficar em pasta acessível pela web**. Mantenha fora do document root.
- O ZIP de build não contém `.env`.
- **Hostname/IP da VPS não vai em arquivo versionado** — fica na memória privada do Claude.

---

## Mensagens content ↔ background

Antes de criar nova mensagem, grep `CRM_IGNIS_` em `entrypoints/background.ts` — **reutilize** antes de inventar. Convenções:

- `CRM_IGNIS_DB_UPDATED` — broadcast crítico (toda escrita dispara; UIs com `useReactiveQuery` ouvem).
- `CRM_IGNIS_TOAST` — exibe toast em qualquer UI aberta.
- `CRM_IGNIS_FORCE_SYNC` — **removido** (era do sync de Sheets — descontinuado).
- Mensagens que dependem de auth checam `getCurrentUserId()` e respondem `{ ok: false, reason: "Não autenticado." }` se ausente.

---

## Instagram (`content.ts`) — regras absolutas

- **Identificação via URL de perfil** (`instagram.com/{username}/`) — use `parseInstagram.ts`.
- **Avatar via `web_profile_info`** (mensagens `CRM_IGNIS_GET_PROFILE_META` / `CRM_IGNIS_FETCH_AVATAR`).
- **NUNCA fazer scraping de DOM em `/direct/t/...`** — DOM ofuscado, captura o usuário logado em vez do lead. Na DM identificação é sempre **manual** (busca por nome/@).
- **NUNCA usar classes CSS ofuscadas do IG** (`x1qjc9v5` etc.) — mudam diariamente.
- Tailwind **não funciona** em content script — use inline `React.CSSProperties`.
- **Overlays fixos** (painel, botão flutuante): Shadow DOM com `z-index:2147483647` (isola CSS do IG). **Badges inline:** sem Shadow DOM, anchor em `header img` (`img?.closest('a[role="link"]') ?? img?.parentElement`).

---

## Padrão obrigatório: MutationObserver + geração-counter

Usar quando o mount depende de (1) fetch async ao background **E** (2) MutationObserver esperando o DOM. Sem isso, badge monta em página errada após SPA nav.

**Receita:** `let _gen = 0;` no módulo. `watch(username)` chama `unmount()` primeiro, captura `const gen = ++_gen;`, e cada callback async testa `if (gen !== _gen) return;` antes de mutar DOM. `unmount()` SEMPRE faz `_gen++` pra invalidar pendentes. `watch` só é chamado dentro de `if (routeChanged)` em `checkRoute()` — o failsafe interval chama `checkRoute` ~20×/10s sem mudança de rota; sem o gate, watcher remonta sem motivo. Referência viva: `entrypoints/content.ts`.

---

## Bot Telegram (canal principal)

`bot/` é Python async (aiogram + supabase-py) na VPS via systemd. Não é parte do build da extensão; é processo separado. **OCR em camadas (economia + zero perda):** SHA-256 → `print_cache` (hit = $0) → Haiku 4.5 → escala pra Sonnet 4.6 se Haiku marca `OBS:` → se Sonnet também marca, lead com `needs_review=true` + imagem no bucket `print_review` (SDR corrige via `reviewLead`).

Worker usa **service_role_key** (bypassa RLS) — sempre passar `workspace_id` explicitamente em INSERTs. `telegram_links (chat_id, workspace_id, is_active)` — só 1 ativo por chat (regra do `/trocar`).

**Rotacionar token:** @BotFather → `/revoke` → atualizar `bot/.env` na VPS → `systemctl restart ignis-bot`. Adicionar campo OCR no lead: mesmos 4 lugares do `updateLead`.

---

## Tasks (feature pendente)

Tabela `tasks` existe em `supabase_setup.sql` mas **não tem `tasksRepo.ts`**. Quando implementar: padrão de `leadsRepo.ts` — mappers snake/camel, allowlist no update, broadcast após escrita.

---

## Erros conhecidos — não repita

| Erro | Causa | Solução |
|---|---|---|
| Lead capturado é o próprio usuário logado | Scraping de DOM da DM | Identificação manual em `/direct/` |
| Badge monta na página errada após SPA nav | MutationObserver sem `_gen` | Receita acima |
| Watcher chamado 20× sem mudança de rota | Chamada fora de `if (routeChanged)` | Gate em `routeChanged` |
| Tailwind silenciosamente ignorado | Usado em content script | `React.CSSProperties` inline |
| Operação no banco falha sem feedback | Sessão Supabase ausente/expirada | `getCurrentUserId()` no bg, `getCurrentWorkspaceId()` na UI |
| Campo ignorado no `updateLead` | Faltou em algum dos 4 lugares | Atualizar `Lead`, `LeadRow`, `Pick`, mappers |
| Usuário vê leads de outro workspace | RLS errada ou `user_workspaces` vazio | Conferir policy + linha em `user_workspaces` |
| `window.setTimeout` em service worker | `avatarBackfill.ts` usa `window` | No bg, `setTimeout` direto |
| Duplicatas de lead | Username não normalizado | `canonicalUsername` antes de gravar/buscar |
| Lead deletado reaparece após sync | Hard delete | Soft delete via `deleted_at` |
| OCR alucinando usernames | Viés de correção das LLMs | Prompt: "scanner óptico — PROIBIDO corrigir" |
| Popup encolhe e quebra texto palavra-a-palavra | Root sem `min-width` (Chrome ajusta ao conteúdo) | `min-width: 360px` no container raiz |
| Login parece de outro app | LoginScreen herdou tema diferente | Coerência: usar tokens do `theme.css`, fonte Inter, mesma identidade |
| Ícone genérico de quebra-cabeças na barra | PNGs do template WXT não foram trocados | Substituir `public/icon/{16,32,48,96,128}.png` |
| Bug visual em popup mas não em dashboard | Largura/contexto diferente entre entrypoints | Testar em todos os contextos onde o componente roda |
| Glob não expande em SCP remoto | zsh local expande antes de mandar | Aspas: `scp 'user@host:path/*.zip' .` |
| Bot Python: `supabase-py` rejeita `sb_secret_*` | Versões < 2.18 só validam JWT antigo | Pinar `supabase>=2.18.0` |
| Bot Python: aiogram conflita com supabase | `aiogram<3.15` exige `pydantic<2.10` | Pinar `aiogram>=3.15.0` |
| `.env` exposto pela web | Em `public_html` na VPS | Fora do document root |
| Hostname/IP da VPS em arquivo versionado | "Pra ficar mais cômodo" | Memória privada do Claude |
