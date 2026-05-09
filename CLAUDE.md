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

Extensão Chrome MV3 (WXT + React + TypeScript). **Banco único: Supabase (PostgreSQL).** Não existe mais Dexie/IndexedDB local — toda escrita/leitura é HTTP. **Auth obrigatório** (Supabase Auth email/senha): sem sessão, operações em `background.ts` viram no-op; na UI lançam erro.

Multi-tenant por workspace. Convenção: `workspace_id === auth.uid()` (TEXT). RLS no Supabase isola entre usuários. A função `get_my_workspace_id()` no Postgres é o que toda policy consulta — mexer nela mexe em tudo.

UI reativa por broadcast: ao escrever, repos enviam `CRM_IGNIS_DB_UPDATED` via `chrome.runtime.sendMessage`. `useReactiveQuery` (em `src/utils/`) escuta e re-roda a query. **Se você escrever no Supabase sem passar pelo repo, a UI não atualiza.**

Scripts Python em `scripts/` fazem OCR via Claude e exportam pra Google Sheets. Independentes da extensão. Ponte = sync Sheets→**Supabase** (não mais Dexie) via `chrome.alarms` a cada 30 min ou manual via `CRM_IGNIS_FORCE_SYNC`.

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

---

## Avatares

- `Lead.avatarUrl` opcional, mas preencha assim que possível.
- Backfill manual (`backfillMissingAvatars`) precisa de aba do IG aberta. Sync auto faz fire-and-forget pra leads novos com cap de 20 e 300ms de delay.
- **CDN URLs do Instagram expiram em semanas.** `LeadAvatar` cai pra iniciais; usuário roda backfill pra refrescar.
- Nunca faça backfill em loop apertado — sempre delay entre requisições (rate limit do IG).

---

## Build & Deploy

A extensão **não vai pra Chrome Web Store**. Fluxo:

1. **Push pro GitHub** (Claude faz quando o usuário pede): `git add -A && git commit -m "..." && git push origin <branch>`.
2. **Build na VPS via SSH** (host/user/path em memória privada do Claude — não neste arquivo):
   ```bash
   ssh <vps-user>@<vps-host>
   cd <project-path>
   git pull && npm install && npm run zip
   ```
3. **Download do ZIP via `scp`:** `scp <vps>:<path>/.output/*.zip ~/Desktop/`
4. **Load unpacked** em cada Chrome: extrai ZIP → `chrome://extensions` → "Modo de desenvolvedor" → "Carregar sem compactação".
5. Login Supabase puxa os leads.

### Segurança do `.env`

- Anon key embutida no JS é pública por design (RLS protege). OK.
- `.env` na VPS **NUNCA pode ficar em pasta acessível pela web** (`public_html`). Mantenha fora do document root.
- O ZIP de build não contém `.env` — distribua sem medo.
- **Hostname/IP da VPS não vai em arquivo versionado** — alvo de SSH brute-force. Fica na memória privada do Claude.

---

## Mensagens content ↔ background

Antes de criar nova mensagem, grep `CRM_IGNIS_` em `entrypoints/background.ts` — **reutilize** antes de inventar. Convenções:

- `CRM_IGNIS_DB_UPDATED` é o broadcast crítico (toda escrita dispara; UIs com `useReactiveQuery` ouvem).
- `CRM_IGNIS_TOAST` exibe toast em qualquer UI aberta.
- Mensagens que dependem de auth devem checar `getCurrentUserId()` e responder `{ ok: false, reason: "Não autenticado." }` se ausente.

---

## Instagram (`content.ts`) — regras absolutas

- **Identificação via URL de perfil** (`instagram.com/{username}/`) — use `parseInstagram.ts`.
- **Avatar via `web_profile_info`** (mensagens `CRM_IGNIS_GET_PROFILE_META` / `CRM_IGNIS_FETCH_AVATAR`).
- **NUNCA fazer scraping de DOM em `/direct/t/...`** — DOM ofuscado, captura o usuário logado em vez do lead. Identificação na DM é sempre **manual** (busca por nome/@).
- **NUNCA usar classes CSS ofuscadas do IG** (`x1qjc9v5` etc.) — mudam diariamente.
- Tailwind **não funciona** em content script — use inline `React.CSSProperties`.
- **Overlays fixos** (painel, botão flutuante): Shadow DOM com `z-index:2147483647` (isola CSS do IG).
- **Badges inline** (no fluxo da página): sem Shadow DOM, anchor em `header img` (`img?.closest('a[role="link"]') ?? img?.parentElement`).

---

## Padrão obrigatório: MutationObserver + geração-counter

Use quando o mount depende de (1) fetch async ao background **E** (2) MutationObserver esperando o DOM. Sem isso, badge monta em página errada após SPA nav.

```typescript
let _gen = 0;

function watch(username: string) {
  unmount();
  const gen = ++_gen;
  let data: Data | null = null;

  const tryMount = () => {
    if (gen !== _gen) return;        // stale
    if (!data || _host?.isConnected) return;
    const anchor = document.querySelector("header img");
    if (!anchor) return;
    mount(anchor, data);
  };

  _observer = new MutationObserver(tryMount);
  _observer.observe(document.body, { childList: true, subtree: true });

  fetchFromBackground(username).then((result) => {
    if (gen !== _gen) return;
    data = result;
    if (data) tryMount();
    else _observer?.disconnect();
  });
}

function unmount() {
  _gen++;                            // CRÍTICO: invalida pendentes
  _observer?.disconnect(); _observer = null;
  _root?.unmount(); _root = null;
  _host?.remove(); _host = null;
}
```

**Regras:** `unmount` SEMPRE incrementa `_gen`. `watch` só é chamado dentro de `if (routeChanged)` em `checkRoute()` — o failsafe interval chama `checkRoute` ~20×/10s sem mudança de rota; sem o gate, watcher remonta sem motivo.

---

## Tasks (feature pendente)

A tabela `tasks` existe em `supabase_setup.sql` mas **não tem repo dedicado** (`tasksRepo.ts` ainda não existe). Quando implementar: siga o padrão de `leadsRepo.ts` — mappers snake/camel, allowlist no update, broadcast após escrita.

---

## Erros conhecidos — não repita

| Erro | Causa | Solução |
|---|---|---|
| Lead capturado é o próprio usuário logado | Scraping de `<nav>` do IG | Não fazer scraping na DM |
| Badge monta na página errada após SPA nav | MutationObserver sem `_gen` | Padrão acima |
| Watcher chamado 20× sem mudança de rota | Chamada fora de `if (routeChanged)` | Gate em `routeChanged` |
| Tailwind silenciosamente ignorado | Usado em content script | `React.CSSProperties` inline |
| Operação no banco falha sem feedback | Sessão Supabase ausente/expirada | `getCurrentUserId()` no bg, `getCurrentWorkspaceId()` na UI |
| Campo ignorado no `updateLead` | Faltou em algum dos 4 lugares | Atualizar `Lead`, `LeadRow`, `Pick`, mappers |
| Usuário vê leads de outro workspace | RLS errada ou `user_workspaces` vazio | Conferir policy + linha em `user_workspaces` |
| `window.setTimeout` em service worker | `avatarBackfill.ts` usa `window` | No bg, `setTimeout` direto ou `Promise` com timeout |
| Duplicatas de lead | Username não normalizado | `canonicalUsername` antes de gravar/buscar |
| Lead deletado reaparece após sync | Hard delete | Soft delete via `deleted_at` |
| OCR alucinando usernames | Viés de correção ortográfica das LLMs | Prompt: "scanner óptico — PROIBIDO corrigir/deduzir/autocompletar" |
| `.env` exposto pela web | Em `public_html` na VPS | Fora do document root ou bloqueio via `.htaccess` |
| Hostname/IP da VPS em arquivo versionado | "Pra ficar mais cômodo" | Memória privada do Claude, nunca em arquivo do repo |
