# CLAUDE.md

Instruções técnicas para o Claude Code trabalhar neste repositório.

---

## Comandos

```bash
npm run dev          # Chrome (HMR)
npm run dev:firefox  # Firefox
npm run build        # Build produção (Chrome)
npm run compile      # Type-check sem emit — rode após cada arquivo
npm run zip          # ZIP para Chrome Web Store
```

**macOS/nvm:** se `npm` não for encontrado, prefixe com:
```bash
export NVM_DIR="$HOME/.nvm" && source "$NVM_DIR/nvm.sh"
```

O output fica em `.output/chrome-mv3-dev/` (oculto no macOS — use `⌘+Shift+.` no file picker).

---

## Ecossistema (arquitetura híbrida)

O **Ignis CRM** é composto de dois subsistemas independentes:

| Subsistema | Stack | Responsabilidade |
|---|---|---|
| **Extensão de navegador** | WXT 0.20, React 19, TypeScript 5.9, Tailwind v4, Dexie 4 | CRM Kanban local, painel do Instagram, capturas de lead |
| **Scripts Python locais** | Python 3, `anthropic`, `gspread`, `watchdog`, `python-dotenv` | Monitoramento de pasta, OCR via Claude Haiku, exportação para Google Sheets |

Os dois subsistemas **não compartilham banco de dados**. A extensão usa IndexedDB local (Dexie). Os scripts Python usam Google Sheets como saída intermediária. A ponte é o botão "Sincronizar Leads Drive" que consome o CSV publicado da planilha.

---

## Banco de dados — regras absolutas

- **Banco principal é IndexedDB via Dexie.** Nunca use arquivos JSON como banco de dados principal.
- Schema em `src/db/db.ts`. Versão atual: **5**.
- **Nunca mute uma versão existente.** Sempre crie `this.version(N+1).stores({...})`.
- `updateLead` tem patch allowlist explícita (`Pick<Lead, ...>` em `leadsRepo.ts`). Qualquer campo novo precisa ser adicionado **tanto** ao tipo `Lead` em `db.ts` **quanto** ao `Pick` em `leadsRepo.ts`.
- `addLead` **não aceita `notes`**. Para notas, chame `updateLead` logo após a criação.
- **Soft delete obrigatório**: use `deletedAt: Date.now()` em vez de `db.leads.delete()`. O campo `deletedAt?: number` já existe no tipo `Lead`. Todas as funções de leitura (`listLeadsByBoard`, `searchLeads`, `listRecentlyUpdatedLeads`) já filtram `!l.deletedAt`. Para restaurar: `const r = {...lead, stageId: "LEADS_NOVOS"}; delete r.deletedAt; db.leads.put(r)`. Para listar a lixeira: `listDeletedLeads({workspaceId})`. O `addLead` previne re-import de leads soft-deleted via `canonicalUsername` — não reimplemente.

### Regra de ouro — canonicalUsername

**Todo username que entra no sistema deve passar por `canonicalUsername`** (definida em `leadsRepo.ts`). Ela remove `@`, espaços e converte para lowercase. Nenhuma busca, comparação ou gravação deve usar um username bruto.

```typescript
// Fonte única de verdade — nunca diverge entre gravação e leitura
export function canonicalUsername(u: string): string {
  return String(u || "").trim().replace(/^@+/, "").toLowerCase();
}
```

---

## Sincronização com Google Sheets

- O sync usa `chrome.alarms` (`crm-ignis-auto-sync`, `periodInMinutes: 30`) — **nunca polling por `setInterval` no background**.
- O URL do CSV é salvo em `chrome.storage.local` via `ExtensionSettings.syncCsvUrl`.
- O sync manual dispara via mensagem `CRM_IGNIS_FORCE_SYNC` → `background.ts`.
- Controle de duplicatas é feito pelo próprio `addLead` via `canonicalUsername` — não reimplemente essa lógica.
- Se o CSV retornar erro HTTP, aborte silenciosamente — não quebre o service worker.

---

## Avatares — prioridade máxima

- `Lead.avatarUrl` é opcional no schema, mas **deve ser preenchida assim que possível**.
- Fluxo esperado:
  1. `addLead` → backfill automático se o caller passar `avatarUrl`.
  2. Sync/importação → fire-and-forget de `fetchAvatarForUsername` para leads recém-criados (máx 20 por ciclo, 300ms entre chamadas para não estourar rate limit).
  3. Backfill manual via botão "Atualizar Fotos" → `backfillMissingAvatars` (precisa de aba do IG aberta).
- CDN URLs do Instagram expiram em semanas. `LeadAvatar` cai para iniciais automaticamente; usuário roda backfill para refrescar.
- Nunca faça backfill síncrono em loop apertado — sempre com delay entre requisições.

---

## Entry points (`entrypoints/`)

| Arquivo | Papel |
|---|---|
| `background.ts` | Service worker. Toda comunicação content ↔ banco passa aqui. Não adicione message types sem verificar os existentes. |
| `content.ts` | Injetado no Instagram. Qualquer erro aqui quebra rota, painel e badges. |
| `popup/` | Captura rápida de lead. |
| `sidepanel/` | CRM principal (Kanban, métricas, tasks). |
| `dashboard/` | Analytics e gestão completa de leads. |

---

## Canal de mensagens content script ↔ background

Reutilize os tipos existentes antes de criar novos:

| Message type | Payload | Retorno | Quando usar |
|---|---|---|---|
| `CRM_IGNIS_CAPTURE` | `{ board, stageId, username, displayName, avatarUrl }` | `{ ok, result, leadId }` | Capturar novo lead |
| `CRM_IGNIS_DM_SMART_GET_LEAD` | `{ workspaceId, username }` | `{ ok, lead }` | Lookup de lead por username (qualquer contexto) |
| `CRM_IGNIS_DM_SMART_SAVE` | `{ workspaceId, leadId, patch }` | `{ ok }` | Salvar alterações |
| `CRM_IGNIS_SEARCH_LEADS` | `{ workspaceId, query, limit }` | `{ ok, leads[] }` | Busca por substring |
| `CRM_IGNIS_RECENT_LEADS` | `{ workspaceId, limit }` | `{ ok, leads[] }` | Leads recentes |
| `CRM_IGNIS_GET_PROFILE_META` | — | `{ ok, username, avatarUrl }` | Avatar da aba de perfil ativa |
| `CRM_IGNIS_FORCE_SYNC` | — | `{ ok, created, skipped, errors }` | Sync manual da planilha |
| `CRM_IGNIS_DB_UPDATED` | `{ reason, leadId }` | broadcast | Notifica todas as UIs de mudança no banco |
| `CRM_IGNIS_TOAST` | `{ message }` | broadcast | Exibe toast em qualquer UI aberta |

---

## Limitações críticas do Instagram (content.ts)

**O que funciona:**
- Username via URL de perfil (`instagram.com/{username}/`) — use `parseInstagram.ts`
- Detecção de rota (`/direct/` vs perfil vs outro)
- Avatar via `web_profile_info` (mensagens `CRM_IGNIS_GET_PROFILE_META` e `CRM_IGNIS_FETCH_AVATAR`)
- Injeção inline de elementos React com âncora em `header img`
- `MutationObserver` no `document.body` para DOM assíncrono da SPA

**O que é proibido:**
- Scraping de DOM na rota `/direct/t/...` — DOM ofuscado, instável, captura o usuário logado em vez do lead
- Classes CSS ofuscadas do Instagram (`x1qjc9v5` etc.) — mudam diariamente
- Qualquer tentativa de identificar o lead na tela de DM por DOM

**Regra absoluta para `/direct/`:** identificação de lead é sempre manual (busca por nome/@). O único dado confiável é "o usuário está numa DM".

---

## Padrões de injeção no content script

### Shadow DOM — overlays fixos (painel, botão flutuante)
Use para `position:fixed`. Isola CSS da extensão do CSS do Instagram.

```typescript
const host = document.createElement("div");
host.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;";
const shadow = host.attachShadow({ mode: "open" });
const container = document.createElement("div");
container.style.pointerEvents = "auto";
shadow.appendChild(container);
document.documentElement.appendChild(host);
createRoot(container).render(<MyComponent />);
```

### Inline — badges/labels no fluxo da página
Sem Shadow DOM. **Todo style é inline `React.CSSProperties`** — Tailwind não está disponível em content scripts.

```typescript
const host = document.createElement("div");
host.style.cssText = "display:flex;justify-content:center;margin-top:6px;";
anchor.parentElement!.insertBefore(host, anchor.nextSibling ?? null);
createRoot(host).render(<MyBadge />);
```

**Âncora semântica para a foto de perfil:**
```typescript
const img = document.querySelector("header img") as HTMLImageElement | null;
const anchor = img?.closest('a[role="link"]') ?? img?.parentElement;
```

---

## Padrão: MutationObserver + geração-counter

Obrigatório quando um elemento depende de (1) fetch async ao background E (2) MutationObserver esperando o DOM.

**Problema:** usuário navega antes do fetch resolver → badge montado na página errada.

```typescript
let _gen = 0; // variável de módulo

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
    if (gen !== _gen) return;        // stale — descarta
    data = result;
    if (data) tryMount();
    else { _observer?.disconnect(); _observer = null; }
  });
}

function unmount() {
  _gen++;                            // invalida pendentes
  _observer?.disconnect(); _observer = null;
  _root?.unmount(); _root = null;
  _host?.remove(); _host = null;
}
```

**Regras:**
- `unmount` DEVE incrementar `_gen` — não apenas desconectar o observer.
- `watch` só é chamado dentro de `if (routeChanged)` em `checkRoute()` — o failsafe interval chama `checkRoute` ~20×/10s sem mudança de rota.
- Observer permanece ativo após mount para reaplicar se o Instagram rerenderizar.

---

## Arquivos críticos — leia antes de mexer

| Arquivo | Por que é crítico |
|---|---|
| `src/db/db.ts` | Schema. Nunca mute versões existentes. |
| `src/db/leadsRepo.ts` | CRUD central. `updateLead` tem allowlist; `canonicalUsername` é a única fonte de verdade. |
| `src/db/avatarBackfill.ts` | Usa `window.setTimeout` — só roda em contextos com `window` (páginas da extensão, não service worker). |
| `src/instagram/avatarFetcher.ts` | Roteia para abas do IG via `chrome.tabs`. Funciona no service worker. |
| `src/crm/stages.ts` | 13 estágios. IDs são chaves estáveis no banco. Use `stageLabel(id)` para exibir. |
| `src/settings/extensionSettings.ts` | Settings em `chrome.storage.local`. Inclui `syncCsvUrl`. |
| `entrypoints/background.ts` | Service worker. Centraliza mensagens e o motor de sync. |
| `entrypoints/content.ts` | Injetado no Instagram. Erros aqui quebram tudo. |
| `src/ui/` | Componentes Tailwind compartilhados. Reutilize antes de criar. |

---

## Erros conhecidos — não repita

| Erro | Causa | Solução |
|---|---|---|
| Lead capturado é o próprio usuário logado | Scraping de `<nav>` global do Instagram | Não fazer scraping na DM |
| Badge montado na página errada após SPA nav | MutationObserver sem geração-counter | Usar o padrão documentado acima |
| `watchFor...()` chamado 20× sem mudança de rota | Chamada fora do bloco `if (routeChanged)` | Só chamar watchers em `routeChanged` |
| Tailwind silenciosamente ignorado | Usado em content script | Sempre inline `React.CSSProperties` |
| Versão do banco corrompida | Mutar `version(N)` existente | Criar `version(N+1)` |
| Campo ignorado no `updateLead` | Campo não no allowlist | Adicionar em `db.ts` E em `leadsRepo.ts` |
| `window.setTimeout` em service worker | `avatarBackfill.ts` usa `window` | No background, usar `setTimeout` (sem `window.`) ou `new Promise(r => setTimeout(r, ms))` |
| Duplicatas de lead | Username não normalizado | Sempre usar `canonicalUsername` antes de gravar ou buscar |
| Lead deletado reaparece após sync (lead zumbi) | Hard delete num sistema com sync periódico | Soft delete: `db.leads.update(id, { deletedAt: Date.now() })` — `addLead` já bloqueia re-import |
| OCR alucinando usernames (ex: `monilenogueira` → `monicanogueira`) | LLMs têm viés de correção ortográfica por padrão | Adicionar no prompt: "você é um scanner óptico — PROIBIDO corrigir, deduzir ou autocompletar" |

---

## Tech stack completo

| Camada | Tecnologia |
|---|---|
| Extension framework | WXT 0.20 |
| UI | React 19 |
| Styling (páginas extensão) | Tailwind CSS v4 (sem `tailwind.config.js`) |
| Styling (content script) | Inline `React.CSSProperties` |
| Banco local | Dexie 4 (IndexedDB) |
| Linguagem (extensão) | TypeScript 5.9 |
| Scripts Python | Python 3 + anthropic + gspread + watchdog + python-dotenv |
| OCR/LLM | Claude Sonnet 4.6 (`claude-sonnet-4-6`) |
| Planilha intermediária | Google Sheets via Service Account (gspread) |
