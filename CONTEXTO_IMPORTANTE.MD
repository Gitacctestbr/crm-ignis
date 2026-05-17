# CONTEXTO_IMPORTANTE — Dossiê completo do Ignis CRM

> **Para LLMs lendo este arquivo:** este é o briefing completo do projeto Ignis CRM. Se o usuário pediu pra você ler isto, é porque ele quer que você tenha o panorama inteiro antes de qualquer trabalho técnico. Leia o documento todo. Os arquivos do código existem, mas o **porquê** das decisões está aqui.
>
> Este arquivo complementa o `CLAUDE.md`: o `CLAUDE.md` é regra operacional curta (o quê fazer); este é o contexto longo (o porquê e como chegamos aqui).

---

## ÍNDICE

1. [Sobre o usuário](#1-sobre-o-usuário)
2. [O Ignis CRM em 60 segundos](#2-o-ignis-crm-em-60-segundos)
3. [Arquitetura geral — os 3 mundos](#3-arquitetura-geral--os-3-mundos)
4. [A extensão Chrome (frontend)](#4-a-extensão-chrome-frontend)
5. [Supabase — o banco na nuvem](#5-supabase--o-banco-na-nuvem)
6. [A VPS Hostgator — papel real](#6-a-vps-hostgator--papel-real)
7. [Integração com Instagram](#7-integração-com-instagram)
8. [Sync com Google Sheets](#8-sync-com-google-sheets)
9. [Scripts Python (OCR de prints)](#9-scripts-python-ocr-de-prints)
10. [Fluxo de deploy completo](#10-fluxo-de-deploy-completo)
11. [Funcionalidades e estrutura do CRM](#11-funcionalidades-e-estrutura-do-crm)
12. [Histórico da migração para nuvem](#12-histórico-da-migração-para-nuvem)
13. [Erros conhecidos e armadilhas](#13-erros-conhecidos-e-armadilhas)
14. [O que está pendente](#14-o-que-está-pendente)
15. [Glossário pra leigos](#15-glossário-pra-leigos)

---

## 1. Sobre o usuário

**Quem:** Gustavo Bonifácio
- Email principal: `gustavobonifacio.2023@gmail.com`
- Email Google Drive (trabalho): `gustavo.imperiumgroup@gmail.com`

**Nível técnico:** vibecoder iniciante. Auto-descrição: *"completamente leigo em programação, sei o básico de vibecoding"*. Aprende construindo, não estudando teoria abstrata.

**Como ele trabalha com IA:**
- **Não digita comandos de terminal** — pede pra IA fazer (`"commita e empurra pro GitHub"`, `"sobe pra VPS"`, etc.)
- **Não conhece termos técnicos básicos** — build, deploy, schema, FTP vs SSH, migration, branch — tudo precisa ser explicado em linguagem cotidiana
- Usa Claude Code como **executor + arquiteto** ao mesmo tempo
- Comunica em **português brasileiro**
- Quando ele diz "não sei", é literal — não é falsa modéstia. É melhor investigar (zsh_history, git log, configs) do que insistir em pergunta técnica
- Quando ele diz "ok", "perfeito", "pode fazer" — é luz verde pra executar

**O que ele valoriza:**
- Honestidade sobre incertezas (ele prefere "não sei, vou investigar" a chute confiante)
- Avisos de segurança quando ele sugere algo arriscado (ex: hostname no GitHub público)
- Explicação do "porquê" das decisões, não só o "o quê"
- Quando uma decisão tem trade-off, ele quer saber o trade-off — não decisão pronta

**Implicações pra LLM em sessões futuras:**
- Antes de perguntar coisa técnica, investigue primeiro
- Use `AskUserQuestion` com opções concretas em vez de perguntas abertas
- Não use jargão sem explicar de lado
- Mantenha o português brasileiro
- Quando o trabalho cresce, divida em etapas pequenas e visíveis (TaskCreate)

---

## 2. O Ignis CRM em 60 segundos

**O que é:** uma ferramenta interna de **CRM** (Customer Relationship Management — gestão de relacionamento com cliente) focada em **prospecção via Instagram**.

**Quem usa:** atualmente single-user (só o Gustavo). A estrutura multi-tenant via `workspace_id` já existe no banco, então pode escalar pra equipe no futuro sem refatoração grande.

**O que ele faz:**
- **Capturar leads** direto do Instagram (de perfis e DMs)
- **Organizar num Kanban** com 13 estágios (`LEADS_NOVOS` → `FECHADO_GANHO` ou `PERDIDO`)
- **Gerenciar tasks** de follow-up (com data, status, snooze)
- **Acompanhar métricas diárias** (msgs enviadas, respostas, CTAs, agendamentos)
- **Importar leads em massa** a partir de uma planilha do Google Sheets
- **Ler prints** (screenshots da DM) e extrair os usernames via OCR (Claude Sonnet)

**Estado atual em 9 de maio de 2026 (fim do dia):**
- **Captura principal de leads = bot do Telegram (`@Ignis_crm_bot`).** Cliente tira print no celular → compartilha pro bot → lead aparece no CRM em ~3-5s. Validado em produção com 27 leads na sessão de 9/5.
- Banco **100% migrado de Dexie (local) para Supabase (nuvem)**.
- Bot rodando como **systemd service `ignis-bot.service`** na VPS Hostgator. Restart=always, MemoryMax=512M.
- **Sync via Google Sheets foi descontinuado.** Scripts Python OCR (`print_processor.py`) movidos pra `legacy/scripts/`.
- Auth via Supabase (email/senha) **funcionando**, com novo campo `workspace_name` (nome humano que o bot mostra na confirmação).
- Deploy é **unpacked extension** (não está na Chrome Web Store ainda).
- Build acontece na **VPS Hostgator** via SSH; ZIP é baixado pro Mac e instalado em cada Chrome.
- Branch ativa: `feat/telegram-bot-canal-principal` (a ser mergeada em `main` após validação de uso real).

---

## 3. Arquitetura geral — os 4 mundos

O projeto tem **4 mundos** que se comunicam por canais bem definidos:

```
┌──────────────────────┐         ┌──────────────────────────┐
│                      │         │                          │
│   Extensão Chrome    │  HTTPS  │   SUPABASE               │
│   (Mac/PC do user)   │ <─────> │   (PostgreSQL cloud)     │
│                      │         │                          │
│   - sidepanel        │         │   Tabelas:               │
│   - dashboard        │         │   - leads                │
│   - popup            │         │   - tasks                │
│   - content script   │         │   - activity_events      │
│   - background       │         │   - daily_metrics        │
│                      │         │   - user_workspaces      │
│   "Conectar Telegram"│         │   - telegram_links       │
│   gera link mágico   │         │   - print_cache          │
│   pro celular        │         │   - telegram_invites     │
│                      │         │                          │
│                      │         │   Storage bucket:        │
│                      │         │   - print_review         │
│                      │         │     (imagens needs_review)│
└──────┬───────────────┘         │                          │
       │                         │   Auth: email/senha      │
       │ DOM scrape +            │   RLS: por workspace_id  │
       │ injection (manual,      │                          │
       │ desktop)                │                          │
       ▼                         └──────────▲───────────────┘
┌──────────────────────┐                    │
│                      │                    │
│   Instagram          │                    │ HTTPS
│   (página web)       │                    │ (service_role)
│                      │                    │
│   - perfis           │         ┌──────────┴───────────────┐
│   - DMs              │         │                          │
│   - web_profile_info │         │   BOT TELEGRAM           │
│                      │         │   (worker na VPS)        │
└──────────────────────┘         │   /root/crm-ignis/bot/   │
                                 │   systemd: ignis-bot     │
                                 │                          │
                                 │   - aiogram async        │
                                 │   - Anthropic API        │
                                 │     (Haiku 4.5 + Sonnet) │
                                 │   - SHA-256 cache        │
                                 │                          │
                                 └──────────▲───────────────┘
                                            │
                                            │ HTTPS (long polling)
                                            │
                                 ┌──────────┴───────────────┐
                                 │   @Ignis_crm_bot         │
                                 │   no Telegram            │
                                 │                          │
                                 │   Cliente envia print    │
                                 │   do celular → bot       │
                                 └──────────────────────────┘
```

**Captura de leads tem 2 caminhos hoje:**
1. **Telegram (principal, mobile):** cliente tira print no celular → manda pro bot → OCR → lead direto no Supabase. ~3-5s.
2. **Extensão Chrome (secundário, desktop):** botão "Capturar lead da aba atual" no sidepanel quando cliente está navegando no IG no Chrome.

**A VPS Hostgator agora tem 2 papéis** (ambos em runtime):
- **(novo) Hospeda o worker do bot Telegram** — processo rodando 24/7 via systemd
- **(antigo) Servidor de build** — `npm run zip` quando precisa reinstalar a extensão

A VPS **nunca conversa diretamente com a extensão Chrome**. Mas agora **conversa com o Telegram** (long polling) e com **Supabase** (escrita via service_role_key). Mexer no código da extensão na VPS = continua sem efeito até gerar ZIP novo. Mexer no código do bot na VPS = `systemctl restart ignis-bot` aplica imediatamente.

### Os canais de comunicação real (em runtime)

| De → Para | Como |
|---|---|
| Extensão → Supabase | HTTPS via `@supabase/supabase-js` (todas as queries de domínio, com JWT do user) |
| Extensão → Instagram | Content script lê DOM + chama `web_profile_info` da API interna do IG |
| Bot Telegram → Telegram | `aiogram` async, long polling |
| Bot Telegram → Anthropic API | `anthropic` SDK async, OCR via **Haiku 4.5** (fallback Sonnet 4.6) |
| Bot Telegram → Supabase | `supabase-py` síncrono (envelopado em `asyncio.to_thread`), com **service_role_key** (bypassa RLS) |
| ~~Extensão → Google Sheets~~ | ~~Descontinuado em 9/5/2026~~ |
| ~~Scripts Python → Anthropic/Sheets~~ | ~~Descontinuado em 9/5/2026 (em `legacy/scripts/`)~~ |

### Os canais de "deploy" (off-line, manual)

| De → Para | Como |
|---|---|
| Mac (código novo) → GitHub | `git push` (Claude Code roda) |
| GitHub → VPS | `git pull` na VPS via SSH |
| VPS (build da extensão) → Mac | `scp` do ZIP gerado |
| Mac (ZIP) → Chrome | "Carregar sem compactação" no `chrome://extensions/` |
| VPS (deploy do bot) → bot rodando | `systemctl restart ignis-bot` (sem ZIP, sem reinstalação na máquina cliente) |

---

## 4. A extensão Chrome (frontend)

**Stack:**
- WXT 0.20 (framework de extensão moderno, alternativa ao Plasmo/CRXJS)
- React 19 + TypeScript 5.9
- Tailwind CSS v4 (sem `tailwind.config.js` — config inline)
- Dexie 4 — **só está nas dependências por inércia, não é mais usado**

**Manifest:** `manifest_version: 3` (MV3). Permissões pedidas:
- `sidePanel` — pra abrir o painel lateral do CRM
- `tabs` — pra rotear entre abas do Instagram
- `downloads` — pra exportar backup
- `unlimitedStorage` — herança do Dexie, não estritamente necessário hoje
- `storage` — pra `chrome.storage.local` (sessão Supabase + settings)
- `alarms` — pra agendar sync de 30 em 30 min
- `host_permissions`: instagram.com, *.cdninstagram.com, *.fbcdn.net (pra avatar fetch)

### Entry points (`entrypoints/`)

| Arquivo | O que é | Quando roda |
|---|---|---|
| `background.ts` | Service worker (não tem DOM, não tem `window`) | Sempre — Chrome o liga e desliga sob demanda |
| `content.ts` | Script injetado em páginas do Instagram | Quando você abre instagram.com em qualquer aba |
| `popup/App.tsx` | Pequeno popup que abre ao clicar no ícone | Quando você clica no ícone da extensão na barra do Chrome |
| `sidepanel/App.tsx` | CRM principal — Kanban, busca, tasks | Quando você abre o painel lateral |
| `dashboard/App.tsx` | Página de analytics + gestão completa | Aberto via botão "Dashboard" no sidepanel |

### Anatomia da pasta `src/`

```
src/
├── auth/
│   └── AuthContext.tsx       — Provider de sessão (Supabase Auth)
├── crm/
│   └── stages.ts             — Os 13 estágios do Kanban (IDs estáveis)
├── db/
│   ├── db.ts                 — Tipos compartilhados (Lead, Task, etc.). Sem schema Dexie.
│   ├── leadsRepo.ts          — CRUD de leads (todas as funções HTTP pro Supabase)
│   ├── metricsRepo.ts        — CRUD de métricas diárias
│   ├── avatarBackfill.ts     — Roda no DOM (não service worker), busca avatares em lote
│   └── backup.ts             — Export/import JSON (4 tabelas, modo merge ou replace)
├── instagram/
│   ├── parseInstagram.ts     — Extrai username de URL do IG
│   └── avatarFetcher.ts      — Chama web_profile_info via aba aberta do IG
├── settings/
│   └── extensionSettings.ts  — Settings em chrome.storage.local (inclui CSV URL)
├── ui/                       — Componentes React compartilhados (Tailwind)
└── utils/
    ├── supabaseClient.ts     — Cliente Supabase + adapter chrome.storage
    └── useReactiveQuery.ts   — Substituto de useLiveQuery (Dexie)
```

### O padrão `useReactiveQuery`

Substituto leve do `useLiveQuery` do Dexie. Roda a query no mount e re-roda quando recebe a mensagem `CRM_IGNIS_DB_UPDATED`. Isso mantém a UI "viva" sem usar Supabase Realtime — a sincronização entre abas/contextos vai pelo canal de mensagens da extensão.

**Regra crítica:** se você escrever direto no Supabase sem passar pelos repos (`leadsRepo.ts` etc.), a UI **não atualiza** porque ninguém disparou o broadcast.

---

## 5. Supabase — o banco na nuvem

### O que é Supabase (pra leigos)

Supabase é um **serviço de banco de dados + autenticação + APIs prontas**, hospedado na nuvem. Pense nele como "Firebase em PostgreSQL". Você cria um projeto no painel deles e ganha:
- Um **PostgreSQL** rodando pra você
- Um **sistema de login** (email/senha, magic link, OAuth)
- Uma **API REST + WebSocket** que você consome do frontend
- **Row Level Security (RLS)** — regras escritas em SQL que decidem quem pode ler/escrever cada linha

No Ignis CRM, usamos **PostgreSQL + Auth + RLS**. Não usamos Realtime (a sincronização vai pelo canal interno da extensão). Não usamos Storage (avatares vêm do CDN do Instagram).

### Histórico — de Dexie para Supabase

**Antes (versões 1 a 4):** o banco principal era **Dexie**, que é uma biblioteca pra usar IndexedDB (o banco que existe dentro do navegador). Os leads viviam **no navegador do usuário**. Vantagem: rápido, offline-first, zero infra. Desvantagem: cada Chrome tinha sua cópia, não dava pra usar em vários computadores.

**Depois (versão 5 / NUVEM em diante):** o Dexie foi **completamente removido** e substituído por Supabase. Os leads agora vivem na nuvem. Quando você loga em qualquer Chrome com seu email, os mesmos leads aparecem. Vantagem: multi-device. Desvantagem: precisa de internet, um pouco mais lento (HTTP em cada query).

### Como descobrir o projeto Supabase em uso

A URL e a chave anônima ficam no arquivo `.env` na raiz do projeto:
```
WXT_SUPABASE_URL=https://<project-ref>.supabase.co
WXT_SUPABASE_ANON_KEY=eyJhbGciOi...
```

A chave anônima (`anon key`) é **pública por design** — ela vai embutida no JavaScript que o usuário recebe. A segurança vem das **policies RLS** no Supabase, que verificam quem é o usuário antes de devolver dados.

### As tabelas (schema canônico em `supabase_setup.sql`)

| Tabela | O que guarda |
|---|---|
| `leads` | Cada lead capturado — username, board, stage_id, priority, tags, notes, CTA, deleted_at, etc. |
| `tasks` | Tarefas vinculadas a leads (título, dueAt, status, snoozeUntil) |
| `activity_events` | Log de eventos: lead criado, movido de stage, nota atualizada, etc. |
| `daily_metrics` | Métricas agregadas por dia + board (msg1Disparos, msg1Respostas, ctaDisparos, agendNovos, etc.) |
| `user_workspaces` | Mapeia `auth.uid()` (UUID) → `workspace_id` (TEXT). Convenção: workspace_id === auth.uid() em formato texto. |

### RLS (Row Level Security) — como funciona aqui

Cada tabela tem **policies** SELECT/INSERT/UPDATE/DELETE que verificam:
> "O `workspace_id` desta linha é igual ao workspace do usuário logado?"

A função `get_my_workspace_id()` faz essa lookup (consulta `user_workspaces` baseado em `auth.uid()`). Se você muda essa função, **muda todas as policies de uma vez** — cuidado.

### Auth flow

1. Usuário abre o sidepanel
2. `AuthGate` (componente) verifica sessão. Se não logado, mostra tela de login
3. Login chama `supabase.auth.signInWithPassword(email, password)`
4. Supabase devolve `session` com JWT
5. JWT é guardado em `chrome.storage.local` (via storage adapter customizado em `supabaseClient.ts`)
6. `AuthProvider` faz `upsert` em `user_workspaces` (idempotente — ok chamar várias vezes)
7. Todas as queries subsequentes mandam o JWT no header → Supabase aplica RLS

### Mapeamento snake_case ↔ camelCase

PostgreSQL usa `snake_case` (`workspace_id`, `created_at`). TypeScript usa `camelCase` (`workspaceId`, `createdAt`). A conversão acontece **dentro de cada repo**, em funções `rowTo*` e `*ToRow`. **Nunca** se espalha pela UI — a UI só vê camelCase.

### Convenções importantes

- **`workspace_id === auth.uid()`** (TEXT, não UUID, no schema atual)
- **Soft delete obrigatório:** `deleted_at = Date.now()`, nunca `DELETE`. Funções de leitura filtram `deleted_at IS NULL`.
- **Timestamps em BIGINT (epoch ms)** — não TIMESTAMPTZ. Compatível com `Date.now()` do JavaScript.
- **Username canônico:** sempre lowercase, sem `@`. Existe `CHECK` no Postgres rejeitando o que não é canônico — vide [seção 13](#13-erros-conhecidos-e-armadilhas).

---

## 6. A VPS Hostgator — papel real

### O que ela É

A VPS é um **servidor Linux** (Ubuntu) na Hostgator. Tem Node.js e Git instalados. Ela serve **3 propósitos**:

1. **Repositório central de código** — uma cópia do projeto (`git clone`)
2. **Servidor de build** — onde `npm run build` / `npm run zip` rodam
3. **Storage temporário** — onde o ZIP gerado fica até ser baixado

### O que ela NÃO É

- ❌ NÃO é um servidor web servindo a extensão
- ❌ NÃO conversa com Supabase
- ❌ NÃO conversa com Instagram
- ❌ NÃO conversa com Chrome em runtime
- ❌ NÃO atualiza nenhum usuário automaticamente

A extensão instalada **não sabe que a VPS existe**. Ela é uma frozen snapshot do código que foi compilado num determinado momento. Pra atualizar, precisa **gerar novo ZIP + reinstalar manualmente em cada Chrome**.

### Acesso (valores reais ficam na memória privada do Claude)

- Provedor: **Hostgator**
- Tipo: **VPS Linux**
- Acesso: **SSH** com chave (id_ed25519)
- Usuário: `root` (sem usuário não-root configurado — uma melhoria futura)
- Path do projeto: `/root/crm-ignis`
- **Hostname/IP fica fora dos arquivos versionados** — exposição em arquivo público facilita SSH brute-force. Está na memória local do Claude Code.

### Estrutura na VPS

```
/root/
├── crm-ignis/              ← projeto clonado do GitHub
│   ├── .env                ← Supabase URL + anon key
│   ├── .output/            ← gerado por npm run build/zip
│   │   └── *.zip           ← artefato final do build
│   ├── package.json
│   └── (resto do projeto)
└── (outras coisas do servidor)
```

### Coisa que descobrimos durante a sessão

Em 9 de maio de 2026, durante a tentativa de regerar a versão NUVEM, descobrimos que **a pasta `/root/crm-ignis` tinha sido apagada** em algum momento. Provavelmente uma limpeza manual. Solução: clonar fresh do GitHub e copiar `.env` local pra VPS via `scp`.

**Implicação:** o estado da VPS é **frágil**. Não tratamos a VPS como "permanente". Pra qualquer redeploy futuro, vale checar se a pasta existe e clonar de novo se preciso.

### Por que usar VPS pra build, em vez de buildar localmente no Mac?

Boa pergunta — não tem motivo técnico forte hoje. O Mac do Gustavo poderia fazer o `npm run build` perfeitamente. A escolha de usar a VPS parece ter vindo de:
- Centralizar a "fonte oficial" do código (o que GitHub já faz, mas tudo bem)
- Ter Node sempre disponível, independente do Mac estar ligado
- Talvez planejamento futuro de CI/CD ou auto-deploy

**Não há perda de qualidade em buildar local.** Se um dia quiser simplificar, vale revisitar essa decisão.

---

## 7. Integração com Instagram

> **Nota de status (9/5/2026):** essa integração continua existindo, mas hoje é **canal secundário** de captura. A entrada principal de leads é o bot do Telegram (vide seção 16). A integração com IG é usada quando o cliente está navegando no Chrome desktop e quer capturar um lead "à la carte".

### O que conseguimos fazer

- **Detectar URL de perfil** (`instagram.com/username`) e extrair o username (`parseInstagram.ts`)
- **Detectar quando o usuário está numa DM** (rota `/direct/`) — só pra mostrar UI relevante
- **Buscar avatar de qualquer username** chamando o endpoint interno `web_profile_info` do IG (precisa de uma aba do IG aberta e logada)
- **Injetar UI inline** na página do IG (badges nos perfis, botão flutuante)
- **Capturar leads** quando o usuário clica em "Capturar" no perfil

### O que NÃO funciona / é proibido

- ❌ **Scraping de DOM na rota `/direct/t/...`** (DM) — o DOM é ofuscado e instável. Tentativas anteriores capturaram **o usuário logado** em vez do lead, gerando bug clássico
- ❌ **Classes CSS ofuscadas do IG** (tipo `x1qjc9v5`) — mudam **diariamente**. Qualquer seletor que dependa delas vai quebrar
- ❌ **Tailwind em content script** — não funciona. Tem que usar inline `React.CSSProperties`

### A regra absoluta da DM

Identificação de lead na rota `/direct/` é **sempre manual** (busca por nome ou username). O único fato confiável é "o usuário está numa DM" — qualquer tentativa de inferir QUEM ele tá conversando vai capturar lixo.

### `web_profile_info` — o endpoint do avatar

Quando você abre uma aba do IG logado, é possível chamar:
```
https://i.instagram.com/api/v1/users/web_profile_info/?username=<u>
```
e ele responde com JSON contendo o avatar URL. **Mas isso só funciona dentro do contexto de uma aba do IG** (precisa dos cookies de sessão). É por isso que `avatarFetcher.ts` usa `chrome.tabs.sendMessage` pra pedir pro content script da aba do IG fazer a requisição.

### Avatares e expiração de CDN

URLs de avatar do Instagram (`*.cdninstagram.com`, `*.fbcdn.net`) **expiram em algumas semanas**. O componente `LeadAvatar` cai pra exibir as iniciais do nome quando o avatar quebra. Pra refrescar, o usuário roda **backfill manual** (botão "Atualizar Fotos" no dashboard) que itera leads sem avatar e busca de novo.

---

## 8. Sync com Google Sheets — DESCONTINUADO (9/5/2026)

> **Substituído pelo bot do Telegram.** Manter aqui só pra histórico.

### Por que foi removido

O fluxo Sheets dependia de:
1. Cliente criar/configurar planilha do Google
2. Cliente "publicar na web" pra gerar CSV público
3. Cliente colar URL no settings da extensão
4. Auto-sync rodar a cada 30 min (sempre atrasado)
5. Scripts Python rodarem no Mac do Gustavo (precisa Mac ligado)

Pra escalar pra 50 clientes isso era **inviável** — Mac ligado 24/7, criar 50 planilhas, configurar 50 vezes. O bot do Telegram resolve tudo isso: 1 worker centralizado na VPS, onboarding em ~30s por cliente (1 link mágico).

### O que aconteceu com o código

- **`scripts/`** (Python OCR + gspread) foi movido pra **`legacy/scripts/`** — código preservado, mas fora do fluxo. Não rodar a não ser pra fallback de emergência.
- **`background.ts`** — alarme `crm-ignis-auto-sync` removido + handler `CRM_IGNIS_FORCE_SYNC` removido + `chrome.alarms.clear` defensivo pra desativar em extensões antigas que ainda tinham o alarme criado.
- **Settings da extensão** — campo `syncCsvUrl` ainda existe no schema do `chrome.storage.local`, mas não é mais lido em lugar nenhum.
- **Botões "Sincronizar Leads Drive"** removidos do sidepanel e dashboard.
- **Função `syncLeadsFromSheets()`** ainda existe em `background.ts` mas nunca é chamada — fica como fallback técnico se um dia precisar voltar.

### Se um dia precisar reativar

Não-trivial. Reativar exige descomentar o alarme + restaurar o handler + restaurar UI. Mas se chegar nesse ponto, considera primeiro: o bot do Telegram realmente está fora? Ou seria mais barato consertar o bot?

---

## 9. Scripts Python (OCR de prints) — LEGADO (9/5/2026)

> **Substituído pelo bot do Telegram (vide seção 16).** Pasta `scripts/` foi renomeada pra `legacy/scripts/`.

### O que era

Um subsistema **independente** da extensão. Rodava no Mac do Gustavo. Pasta: `scripts/` (hoje em `legacy/scripts/`).

### Stack

- Python 3
- `anthropic` (SDK pra Claude API)
- `gspread` (SDK pra Google Sheets)
- `watchdog` (monitora pasta de arquivos)
- `python-dotenv` (lê `.env`)

### Fluxo

1. Gustavo tira um print de uma DM ou perfil do Instagram
2. Salva o print numa pasta monitorada
3. `watchdog` detecta o novo arquivo
4. Script manda o print pro Claude Sonnet 4.6 via Anthropic API
5. Claude faz OCR → devolve o username (e talvez nome)
6. Script grava na planilha Google Sheets via `gspread`
7. Daí o sync da extensão (a cada 30 min) puxa pra Supabase

### Detalhe importante: OCR não pode "alucinar"

LLMs têm **viés de correção ortográfica**. Sem prompt cuidadoso, o Claude vai "consertar" um username `monilenogueira` pra `monicanogueira` por achar que é mais natural. Isso quebra a busca depois.

**Solução:** o prompt explicitamente diz:
> *"Você é um scanner óptico — PROIBIDO corrigir, deduzir ou autocompletar. Reproduza exatamente o que vê, mesmo que pareça erro."*

### Credenciais

- `ANTHROPIC_API_KEY` em `scripts/.env`
- `credentials.json` (Service Account do Google) em algum lugar acessível pelo `gspread`

---

## 10. Fluxo de deploy completo

Existem **2 deploys distintos** hoje:

### A) Deploy da EXTENSÃO (quando Gustavo diz "sobe a versão nova pro meu Chrome")

Versão completa abaixo. Esse fluxo gera ZIP que precisa ser reinstalado em cada Chrome.

### B) Deploy do BOT (quando muda código em `bot/`)

Mais simples — sem ZIP, sem reinstalação cliente:

```bash
# Local: commit + push
git add bot/ && git commit -m "..." && git push

# VPS: pull + restart
ssh root@<vps> 'cd /root/crm-ignis && git pull && systemctl restart ignis-bot'

# Confirmar:
ssh root@<vps> 'journalctl -u ignis-bot -n 20 --since "1 min ago"'
# Esperado: "Bot conectado: @Ignis_crm_bot" e "Run polling"
```

Se mudou `bot/requirements.txt`:
```bash
ssh root@<vps> 'cd /root/crm-ignis/bot && ./venv/bin/pip install -r requirements.txt && systemctl restart ignis-bot'
```

---

### Versão completa — deploy da extensão

### Etapa 1 — Mac → GitHub

Claude Code roda (a pedido):
```bash
cd /Users/rovancastro/Desktop/ignis-crm
git add CLAUDE.md  # ou outros arquivos específicos
git commit -m "<mensagem>"
git push origin <branch>
```

(Com `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>` no final do commit.)

### Etapa 2 — GitHub → VPS

Claude SSH na VPS e roda:
```bash
ssh root@<vps-host>
cd /root/crm-ignis
# Se a pasta não existe (acontece — VPS é frágil):
#   git clone https://github.com/Gitacctestbr/crm-ignis.git crm-ignis
#   cd crm-ignis
git fetch origin
git checkout <branch-alvo>
git pull
```

### Etapa 3 — `.env` (se for clone fresh)

Se o `.env` na VPS não existe (foi limpo junto com a pasta), Claude copia o `.env` local pro VPS:
```bash
scp /Users/rovancastro/Desktop/ignis-crm/.env root@<vps-host>:/root/crm-ignis/.env
```

### Etapa 4 — Build na VPS

```bash
cd /root/crm-ignis
npm install   # se package.json mudou
npm run zip   # gera .output/<nome>.zip
```

Output esperado: `.output/wxt-react-starter-0.0.2-chrome.zip` (~283 KB).

### Etapa 5 — VPS → Mac

```bash
scp root@<vps-host>:/root/crm-ignis/.output/*.zip ~/Desktop/<nome-descritivo>.zip
```

### Etapa 6 — Mac → Chrome (manual, o usuário faz)

1. Extrair o ZIP (duplo-clique no Finder)
2. `chrome://extensions/`
3. Ativar "Modo de desenvolvedor" (canto superior direito)
4. **Remover a versão antiga** (botão "Remover" na extensão CRM IGNIS)
5. Clicar em "Carregar sem compactação"
6. Apontar pra **pasta extraída**
7. Logar com email/senha do Supabase

**Observação:** etapa 6 precisa ser feita em **cada Chrome** onde se usa a extensão. Não tem auto-update.

### Quanto tempo leva tudo

- Etapas 1-5 (Claude faz): **1 a 3 minutos**
- Etapa 6 (manual): **30 segundos a 1 minuto por Chrome**

---

## 11. Funcionalidades e estrutura do CRM

### Os 13 estágios do Kanban

Definidos em `src/crm/stages.ts`. **IDs são chaves estáveis no banco** — nunca renomear sem migration:

| Ordem | ID | Significado |
|---|---|---|
| 1 | `LEADS_NOVOS` | Acabou de entrar no funil |
| 2 | `ABORDAGEM_ENVIADA` | Primeira mensagem foi mandada |
| 3 | `ABORDAGEM_RESPONDIDA` | Lead respondeu a primeira msg |
| 4 | `PERGUNTA_ENVIADA` | SDR mandou a pergunta de qualificação |
| 5 | `PERGUNTA_RESPONDIDA` | Lead respondeu a pergunta |
| 6 | `CTA_REALIZADO` | CTA (call-to-action) foi enviado |
| 7 | `ACEITOU_CALL` | Lead aceitou marcar uma call |
| 8 | `AGENDAMENTO_COMPLETO` | Call agendada (data marcada) |
| 9 | `COMPARECEU` | Lead apareceu na call |
| 10 | `NO_SHOW` | Lead não apareceu na call |
| 11 | `REAGENDAR` | Vai remarcar |
| 12 | `FECHADO_GANHO` | Conversão! Virou cliente |
| 13 | `PERDIDO` | Não fechou |

### Boards

Cada lead pertence a um `board`:
- **`OUTBOUND`** — leads prospectados ativamente (DMs, planilhas)
- **`SOCIAL`** — leads inbound (vieram de conteúdo, recomendação, etc.)

### Campos do Lead

Definidos em `src/db/db.ts`. Espelhados em `supabase_setup.sql`:

| Campo | Tipo | Descrição |
|---|---|---|
| `id` | string (UUID) | Identificador único |
| `workspaceId` | string | Tenant (= `auth.uid()`) |
| `board` | `OUTBOUND` ou `SOCIAL` | |
| `stageId` | string | Um dos 13 IDs acima |
| `username` | string | Username do Instagram (canônico) |
| `usernameLower` | string | Mesma coisa em lowercase, com CHECK no Postgres |
| `displayName` | string? | Nome de exibição |
| `avatarUrl` | string? | URL do avatar (CDN do IG, expira) |
| `priority` | `low` / `medium` / `high` | Prioridade |
| `tags` | string[] | Tags livres |
| `notes` | string | Notas em texto livre |
| `createdAt` | number (epoch ms) | |
| `updatedAt` | number | |
| `lastTouchedAt` | number | Última interação |
| `nextFollowUpAt` | number? | Próximo follow-up agendado |
| `deletedAt` | number? | NULL = ativo, preenchido = soft delete |
| `ctaUrl` | string? | URL do CTA enviado |
| `ctaAt` | number? | Quando foi enviado |
| `ctaNote` | string? | Observação do CTA |

### Tasks

A tabela `tasks` existe no schema, mas **ainda não tem `tasksRepo.ts`** — feature pendente. Quando implementar, seguir o padrão de `leadsRepo.ts`:
- Mapping snake_case ↔ camelCase
- Allowlist no update
- Broadcast `CRM_IGNIS_DB_UPDATED` após escrita

### Métricas diárias (`daily_metrics`)

Cada dia × board tem uma linha com contadores:
- `msg1Disparos` / `msg1Respostas` — primeira abordagem
- `msg2Disparos` / `msg2Respostas` — segunda abordagem
- `ctaDisparos` — quantos CTAs foram enviados
- `agendNovos` — quantas calls foram agendadas
- `followEnviados` / `followRespostas` / `followCta` / `agendFollow` — métricas de follow-up

ID composto: `<workspaceId>:<board>:<dateKey>` onde `dateKey` é `YYYY-MM-DD`.

Tem uma noção de "fechar o dia" (`closedAt`) — depois de fechado, escritas viram no-op.

### Activity events

Log de eventos pra cada lead:
- `CREATED` — lead criado
- `MOVED_STAGE` — moveu de estágio (com `fromStageId` e `toStageId`)
- `NOTE_UPDATED` — notas mudaram
- `PRIORITY_CHANGED` — prioridade mudou
- `TASK_CREATED` / `TASK_DONE` — eventos de tasks (futuro)

Cada evento tem um `day` (YYYYMMDD inteiro) pra facilitar filtro por dia sem parse de data.

### Backup/restore

Tem um módulo `src/db/backup.ts` que exporta as 4 tabelas do workspace pra um JSON versionado. Suporta:
- **Modo merge** (default) — idempotente, importa por cima sem apagar
- **Modo replace** — apaga tudo do workspace antes de inserir

Útil pra mover dados entre projetos Supabase ou pra fazer snapshot manual.

---

## 12. Histórico da migração para nuvem

### O que aconteceu até a sessão de 9 de maio de 2026

**Fase 1 — Versão 1 e 2 (abril 2026):** Extensão funcional, banco em Dexie/IndexedDB. Cada Chrome tinha sua cópia dos leads.

**Fase 2 — Versão 3 (final de abril):** Rebranding visual, ainda Dexie.

**Fase 3 — Versão 4 (início de maio):** Captura de foto de perfil em base64, scripts Python OCR criados. Ainda Dexie.

**Fase 4 — Versão 5 / "DB ATT" (entre 4 e 5 de maio):** Migração do Dexie pro Supabase. Schema canônico criado em `supabase_setup.sql`. RLS configurado. Auth via email/senha. `useReactiveQuery` substitui `useLiveQuery`. **Esse é o salto qualitativo do projeto.**

**Fase 5 — `feat/foto-perfil-100-funciona` (8-9 de maio):** Refinamento de captura de avatar.

**Fase 6 — Sessão de 9 de maio de 2026 (manhã):** Atualização do `CLAUDE.md` pra refletir a nova arquitetura Supabase, criação da branch `CRM-IGNIS-NUVEM-09-05-2026`, redeploy completo da extensão.

**Fase 7 — Sessão de 9 de maio de 2026 (tarde/noite — esta):** Bot do Telegram entra como **canal principal de captura**, substituindo o sync de Sheets + scripts Python. Branch `feat/telegram-bot-canal-principal`. Validado em produção com 27 leads importados via celular do Gustavo. Esse é o salto qualitativo da escala — agora dá pra onboardar 50 clientes sem o Mac do Gustavo precisar estar ligado.

### Decisões importantes desta sessão (Fase 6 — manhã)

1. **Reescrita completa do `CLAUDE.md`** — o anterior descrevia Dexie como banco principal, totalmente desatualizado. Novo documenta Supabase, auth, deploy via VPS, segurança do `.env`.

2. **`CLAUDE.md` enxuto (176 linhas)** — aplicando o critério "Claude descobre lendo código? Corta." Mantivemos só o não-óbvio.

3. **Hostname da VPS NÃO vai no GitHub** — fica na memória privada do Claude. Risco de SSH brute-force se exposto.

4. **`.env` NUNCA dentro de pasta acessível pela web** na VPS. Anon key é pública por design (RLS protege), mas é boa prática esconder o arquivo.

5. **VPS é frágil** — descobrimos durante a sessão que a pasta `/root/crm-ignis` tinha sido apagada. Solução adotada: clonar fresh e copiar `.env` local de volta. Implicação: deploys futuros devem checar isso antes.

6. **Sales OS é separado** — existe uma pasta `/Users/rovancastro/Desktop/dashboard` com um projeto Next.js + FastAPI chamado "Sales OS" que **não é parte do Ignis CRM**. Tem outro Supabase. Ainda não foi deployado. Quando for, precisa de tratamento separado e atenção à segurança do `.env` (tem senha do Postgres em texto puro).

### Decisões importantes desta sessão (Fase 7 — tarde/noite)

1. **Adoção do bot do Telegram como canal principal** — depois de avaliar Drive/PWA/WhatsApp, escolhemos Telegram pelo balanço UX (2 toques pra mandar print) × custo (zero) × tempo de onboarding (~30s). Decisão de "1 bot único, N vínculos" em vez de "1 bot por cliente" — escalável e simples.

2. **Estratégia de OCR em camadas pra economizar tokens sem perder leads:**
   - Camada 1: SHA-256 da imagem → cache (zero custo em duplicata literal)
   - Camada 2: Haiku 4.5 padrão (~5x mais barato que Sonnet)
   - Camada 3: escala automaticamente pra Sonnet 4.6 SE Haiku marca `OBS:` no username
   - Camada 4: se Sonnet também marca `OBS:`, salva lead com `needs_review=true` + imagem original no bucket `print_review` pra SDR corrigir manualmente
   - Custo estimado pra 10 clientes × 50 prints/dia: ~$15-30/mês

3. **Sem token de vinculação descartável (por enquanto)** — link mágico hoje é direto: `t.me/Ignis_crm_bot?start=ws_<workspace_id>`. Risco de vazamento aceito porque ambiente é controlado (Gustavo conhece os 10 clientes pessoalmente). Tabela `telegram_invites` foi criada vazia, **preparada pra ativar no futuro** quando virar produto público.

4. **Lead com OCR ambíguo NÃO bloqueia o cliente** — em vez de pedir confirmação humana ao cliente no Telegram, salva no CRM com badge ⚠️ amarelo (`needs_review=true`) + imagem original anexada. SDR corrige no banner "X leads pra revisar" do sidepanel. Best of both worlds: cliente nunca espera, dado nunca se perde.

5. **Multi-operador por design** — 1 chat_id pode vincular a N workspaces. Útil pro próprio Gustavo que atua como SDR de vários clientes. Comando `/trocar` no bot abre inline keyboard pra ele alternar antes de mandar prints. Cliente normal nunca usa, UX dele é de 1 toque.

6. **Service role do Supabase no bot, sem tentar usar RLS no worker** — service_role bypassa RLS por design. Pra compensar, o código do bot SEMPRE inclui `workspace_id` explicitamente em INSERTs (defesa em profundidade). RLS continua protegendo o frontend.

7. **Sheets foi REMOVIDO, não deprecated** — eliminamos o caminho ativo (alarme + handler + botões) em vez de deixar coexistir, porque convivência adicionaria complexidade sem ganho real. Código permanece em `legacy/` pra fallback técnico.

8. **VPS continua frágil** — pasta `/root/crm-ignis/scripts/.env` com chave Anthropic não estava versionada nem na VPS, só no Mac. Solução: lemos do Mac local e jogamos via SSH heredoc no `bot/.env` da VPS. Aprendizado: futuros deploys precisam ter backup separado de credenciais.

9. **Pegadinhas de versão de lib (resolvidas no commit de fix):**
   - `supabase-py < 2.18` rejeita o novo formato `sb_secret_*` (só validava JWT)
   - `aiogram 3.13` exige `pydantic < 2.10`, conflito com supabase 2.18+
   - Solução: `supabase>=2.18.0` + `aiogram>=3.15.0` no `requirements.txt`

10. **Deploy do bot é "warm"** — diferente da extensão que precisa rebuild + redistribuição, o bot atualiza em segundos: `git pull && systemctl restart ignis-bot`. Mudou no servidor, mudou pra todo mundo. Isso muda profundamente o ciclo de iteração comparado com o que era antes.

### O que ficou desorganizado

- Não existe `tasksRepo.ts` ainda (tabela existe no schema)
- Não existe versionamento explícito de migrations SQL — quando o schema mudar, vai depender da disciplina de editar `supabase_setup.sql` + rodar SQL incremental no painel
- A pasta `/root/crm-ignis` na VPS pode sumir de novo — sem mecanismo de auto-deploy
- O Gustavo não tem o nome/email do git configurado direito (commit aparece como `gustavo bonifacio <rovancastro@MacBook-Air-de-Rovan.local>` em vez do email do GitHub)

---

## 13. Erros conhecidos e armadilhas

### Lista canônica (mantida em `CLAUDE.md` também)

| Erro | Causa | Solução |
|---|---|---|
| Lead capturado é o próprio usuário logado | Scraping de DOM da DM | Não fazer scraping em `/direct/` — identificar manualmente |
| Badge monta na página errada após SPA nav | MutationObserver sem geração-counter (`_gen`) | Padrão obrigatório do `_gen++` no `unmount` (vide CLAUDE.md) |
| Watcher chamado 20× sem mudança de rota | Chamada fora de `if (routeChanged)` em `checkRoute()` | Gate em `routeChanged` antes de chamar watchers |
| Tailwind silenciosamente ignorado | Usado em content script | `React.CSSProperties` inline, sempre |
| Operação no banco falha sem feedback claro | Sessão Supabase ausente/expirada | `getCurrentUserId()` no background (no-op se null), `getCurrentWorkspaceId()` na UI (lança erro) |
| Campo ignorado no `updateLead` | Faltou em algum dos 4 lugares | Atualizar tipo `Lead`, tipo `LeadRow`, `Pick` da assinatura, e mappers `rowToLead`/`leadToRow` |
| Usuário vê leads de outro workspace | RLS errada ou `user_workspaces` vazio | Conferir policy RLS + linha em `user_workspaces` |
| `window.setTimeout` em service worker | `avatarBackfill.ts` usa `window` mas service worker não tem | No background, `setTimeout` direto ou `Promise` com timeout |
| Duplicatas de lead | Username não normalizado | `canonicalUsername` antes de gravar/buscar |
| Lead deletado reaparece após sync | Hard delete num sistema com sync periódico | Soft delete via `deleted_at` |
| OCR alucinando usernames | Viés de correção ortográfica das LLMs | Prompt explícito: "scanner óptico — PROIBIDO corrigir/deduzir/autocompletar" |
| `.env` exposto pela web | `.env` em pasta `public_html` | Manter fora do document root ou bloquear via `.htaccess` |
| Hostname/IP da VPS em arquivo versionado | "Pra ficar mais cômodo" | Memória privada do Claude, nunca em arquivo do repo |
| Pasta `/root/crm-ignis` apagada | Limpeza manual sem aviso | Deploy script deve checar e clonar de novo se preciso |
| Bot retorna `0 leads salvos, X erros técnicos` | Chave Anthropic inválida/expirada | Logs mostram `401 invalid x-api-key` — gerar nova em console.anthropic.com |
| `supabase-py 2.10` rejeita `sb_secret_*` | Lib antiga só validava JWT | Pinar `supabase>=2.18.0` |
| `aiogram 3.13` conflita com supabase novo | Pydantic incompatível | Pinar `aiogram>=3.15.0` |
| `python3 -m venv` falha na VPS Ubuntu | Pacote `python3-venv` ausente | `apt-get install -y python3-venv python3.X-venv` |
| Bot aceita print mas não responde | Chat não vinculado a workspace | Cliente clica `/start <link>` antes de mandar prints |
| Lead com username `_revisar_<chat>_<ts>` | OCR ambíguo virou placeholder | Badge ⚠️ no Kanban — SDR corrige via banner "Revisar" |
| `git pull` na VPS aborta com "Please commit your changes" | Edição local conflita | `git checkout -- <arquivo>` ou `git stash` antes |

### Armadilhas de migração de schema

- **Adicionar coluna nova:** edite `supabase_setup.sql`, rode SQL incremental no painel (`ALTER TABLE`), revise se afeta policies RLS, atualize tipo `Lead`, tipo `LeadRow`, `Pick` do `updateLead`, mappers.
- **Renomear coluna:** evite. Se for inevitável, rode `ALTER TABLE ... RENAME COLUMN` E atualize todos os mappers no mesmo deploy.
- **Migração de dados:** sem ferramenta automatizada. Usar a função `backup.ts` (export → modificar JSON → import).

---

## 14. O que está pendente

### Backlog técnico

- [ ] **Criar `tasksRepo.ts`** — tabela existe, repo não. Bloqueia features de tarefas.
- [ ] **Configurar identidade Git do usuário** — commits ficam com `<rovancastro@MacBook-Air-de-Rovan.local>` em vez do email do GitHub.
- [ ] **Decidir destino da VPS** — agora ela é build server **E** runtime do bot. Migrar build pro Mac/CI/CD continua válido, mas o bot precisa ficar na VPS (ou serverless, mas hoje é VPS).
- [ ] **Pasta `migrations/` criada na Fase 7** — começamos versionamento incremental com `migrations/2026_05_telegram_bot.sql`. Próxima migration deve seguir nomenclatura `YYYY_MM_<descrição>.sql`.
- [ ] **Não-root user na VPS** — `root` é o atual. Boa prática criar usuário dedicado com sudo.
- [ ] **Backup automático** — `backup.ts` funciona manualmente. Vale agendar (talvez `chrome.alarms` exportando JSON pro `chrome.downloads`?).
- [ ] **Rotacionar tokens expostos em chat (Telegram + Anthropic)** antes de ir pra produção real com clientes pagantes. Os atuais foram colados na sessão de 9/5, ainda funcionam mas devem ser revogados.
- [ ] **PR da branch `feat/telegram-bot-canal-principal` em `main`** — depois que validação prolongada (alguns dias de uso) confirmar estabilidade.
- [ ] **Ativar `telegram_invites` (token descartável)** — quando passar de "ambiente controlado entre Gustavo e clientes que ele conhece" pra "público mais amplo". Tabela já existe.
- [ ] **Monitoramento de saúde do bot** — hoje, se o serviço cair, ninguém é avisado até cliente reclamar. Vale uptime check (UptimeRobot, Healthchecks.io).
- [ ] **Decidir sobre Sales OS** — projeto separado em `/Users/rovancastro/Desktop/dashboard` parado desde 7/5. Quando subir, atenção: `.env` tem senha do Postgres em texto puro.

### Backlog de produto

- [ ] **Tasks na UI** — modais, lista, snooze
- [ ] **Notificações nativas** (Chrome `notifications` API) — pra avisar de follow-ups
- [ ] **Publicação na Chrome Web Store** — pra ter auto-update
- [ ] **Multi-user / equipe** — estrutura permite, falta UI de convites e papel/permissão

### Decisões abertas

- **Quando publicar na Chrome Web Store?** Hoje é unpacked → distribuição manual. Quando crescer pra equipe, vale fazer.
- **Manter Google Sheets como intermediário?** Hoje é assim por inércia (scripts Python já escrevem nele). Alternativa: scripts Python escrevem direto no Supabase (eliminaria um hop, mas adiciona dependência do Anthropic→Supabase no Python).

---

## 15. Glossário pra leigos

Termos que apareceram neste documento e podem confundir:

| Termo | O que é, em linguagem direta |
|---|---|
| **Build** | Pegar o código-fonte (TypeScript, React) e transformar em arquivos que o navegador entende (HTML, JavaScript empacotado). É o "compilar" do mundo web. |
| **Deploy** | Fazer o software chegar no lugar onde ele vai rodar. Aqui significa "instalar a extensão nova no Chrome". |
| **Branch (Git)** | Uma linha de tempo paralela do código. Você pode mexer em uma branch sem afetar a `main`. Quando estiver pronto, mescla (merge) na main. |
| **Commit** | Um "ponto de salvamento" no histórico do código. Tem mensagem descritiva. |
| **Push (Git)** | Mandar seus commits pro GitHub (servidor remoto). |
| **Pull (Git)** | Puxar commits do GitHub pra cá. |
| **SSH** | Forma de logar num servidor remoto pelo terminal, com chave criptográfica em vez de senha. |
| **scp** | "Secure copy" — copia arquivos entre máquinas por SSH. |
| **VPS** | Virtual Private Server — um servidor Linux que você aluga. É como ter um computador dedicado na nuvem. |
| **Service worker** | Um JavaScript que roda em segundo plano no Chrome, sem ter uma página aberta. O `background.ts` é um. |
| **Content script** | Um JavaScript que o Chrome injeta dentro de uma página visitada (no nosso caso, dentro do Instagram). |
| **DOM** | Document Object Model — a árvore de elementos HTML de uma página. Quando você "scrapea" DOM, está lendo essa árvore. |
| **Schema** | A estrutura formal das tabelas no banco — nome de coluna, tipo, restrições. |
| **Migration** | Mudança no schema. Tipo "vou adicionar uma coluna `email` na tabela `users`". |
| **Soft delete** | Em vez de apagar uma linha do banco, marca um campo `deleted_at` com a data. Os SELECTs filtram. Permite "restaurar". |
| **RLS (Row Level Security)** | Regras escritas em SQL que decidem quem pode ler/escrever cada LINHA da tabela. No Supabase, é a defesa contra um usuário ver os dados de outro. |
| **Auth** | Autenticação — verificar quem é o usuário (login). |
| **Tenant / multi-tenant** | "Inquilino" — cada cliente/empresa que usa o software, isolado dos outros. Aqui o tenant é o `workspace_id`. |
| **CDN** | Content Delivery Network — rede de servidores que entregam imagens/arquivos rápido. URLs do `cdninstagram.com` são CDN do IG. |
| **JWT** | JSON Web Token — uma string criptografada que prova "eu sou o usuário X". O Supabase usa pra autenticar requisições. |
| **Anon key** | Chave de acesso "anônima" do Supabase. É pública (vai embutida no JS), mas não dá poder absoluto — RLS limita o que ela pode fazer. |
| **Service role key** | Chave de acesso "admin" do Supabase. Bypass RLS. **NUNCA** vai pro frontend. Só backend. |
| **Manifest V3 (MV3)** | Versão atual do formato de extensões do Chrome. Tem service worker em vez de background page. |
| **HMR** | Hot Module Replacement — quando você muda o código com `npm run dev`, o navegador atualiza só o que mudou, sem reload total. |
| **`npm install`** | Baixa as bibliotecas (dependências) do projeto pra pasta `node_modules/`. |
| **`npm run build`** | Roda o build de produção (gera arquivos otimizados). |
| **`npm run zip`** | Build + empacota tudo num ZIP pronto pra distribuição. |

---

## 16. Bot Telegram — guia operacional completo

### Visão de 30 segundos

`@Ignis_crm_bot` é UM bot que atende **todos** os clientes do Ignis CRM. Roda como worker Python na VPS (`/root/crm-ignis/bot/`) via systemd. Cliente vincula chat ao seu workspace clicando num link mágico (gerado no botão "Conectar Telegram" do CRM). Daí em diante: cliente tira print do IG → manda pro bot → lead entra no CRM em ~3-5s.

### Anatomia da pasta `bot/`

```
bot/
├── main.py             — entrypoint aiogram, todos os handlers, agrupamento de álbum
├── ocr.py              — Claude (Haiku 4.5 → fallback Sonnet 4.6), retry exponencial
├── db.py               — Supabase service role: links, cache, leads, Storage
├── config.py           — carrega/valida variáveis do .env
├── requirements.txt    — pinned: aiogram>=3.15, supabase>=2.18, anthropic, python-dotenv
├── .env.example        — template (real .env tem chmod 600 só na VPS, fora do Git)
├── ignis-bot.service   — systemd unit (Restart=always, MemoryMax=512M)
└── venv/               — virtualenv Python (criado no deploy, não versionado)
```

### Comandos do bot

| Comando | Quem usa | O que faz |
|---|---|---|
| `/start` (sem arg) | Qualquer cliente | Mostra status atual ou pede pra clicar no link mágico |
| `/start ws_<id>` (deep-link) | Cliente clica no link do CRM | Vincula chat ao workspace, marca como ativo |
| `/atual` | Todos | Mostra qual workspace tá ativo agora |
| `/trocar` | Admin SDR (Gustavo) | Inline keyboard com workspaces vinculados — escolhe pra qual mandar próximos prints |
| `/desconectar` | Cliente | Remove vínculo ativo (`is_active=false`, marca `unlinked_at`) |
| `/ajuda` | Qualquer um | Lista comandos + dica de envio como arquivo |
| `/status` | Debug | Mostra `chat_id` + workspace_id + workspace_name |

### Pipeline de processamento de print

```
Cliente manda print
    ↓
Bot baixa imagem (foto comprimida ou documento original)
    ↓
SHA-256 do bytes → print_cache lookup
    ├── HIT  → responde "já processado: @fulano" (zero custo Claude)
    └── MISS → continua
    ↓
Lookup workspace ativo via chat_id em telegram_links
    ↓
Claude Haiku 4.5 com PROMPT anti-alucinação ("scanner óptico")
    ↓
Resposta JSON parsed:
    ├── {"valid": false, ...} → bot responde "❌ não é IG"
    ├── username com "OBS:" → escala automaticamente pra Sonnet 4.6
    └── username limpo → continua
    ↓
upsert_lead no Supabase (idempotente):
    ├── Existe ativo → status="exists", não cria duplicata
    ├── Existe soft-deleted → status="restored", reativa
    └── Não existe → status="created", insere lead + activity_event
    ↓
Se needs_review=true: sobe imagem pro bucket print_review (path = workspace_id/lead_id.jpg)
    ↓
Grava print_cache (hash → lead_id) — SÓ depois do INSERT confirmado
    ↓
Bot responde resumo no chat
```

### Ack do Telegram = depois do INSERT

Regra crítica anti-perda: o bot só dá `ack` no `update_id` do Telegram **depois que o lead está confirmado no Supabase**. Se o serviço morre entre receber o print e gravar, Telegram refaz delivery na reconexão. Esse é o motivo pelo qual a perda de lead é praticamente impossível.

### Concorrência

- **Semáforo por chat:** `MAX_CONCURRENT_OCR_PER_CHAT=3` em `bot/.env`. Cliente manda álbum de 50 = processa em ondas de 3.
- **Sem pool global** explícito, mas o overhead de cada chamada Anthropic já limita naturalmente.
- **Álbum agrupado com debounce 1.5s:** Telegram entrega fotos do álbum 1 a 1, mas todas têm o mesmo `media_group_id`. Bot espera 1.5s sem chegar nova foto, daí processa lote junto e responde 1 mensagem só ("✅ X salvos, Y erros").

### Como conectar um cliente novo (operação)

1. Cliente cria conta no CRM (signup) — preenche "Nome do seu CRM" (workspace_name).
2. No sidepanel, header tem botão "📲 Telegram" amarelo.
3. Cliente clica → abre modal com QR code (link `t.me/Ignis_crm_bot?start=ws_<UUID-do-workspace>`).
4. Cliente escaneia QR no celular → abre Telegram → aperta "Iniciar".
5. Bot responde "✅ Conectado ao workspace 'Nome do CRM'!"
6. Botão no CRM muda pra 🟢 verde. Pronto.

### Como o admin (Gustavo) usa multi-workspace

1. Pede um link do CRM de cada cliente que ele atende como SDR.
2. Em cada link, faz `/start ws_<id>` no celular dele.
3. Quando vai trabalhar, manda `/trocar` no bot → escolhe cliente → começa a mandar prints.
4. Termina aquele cliente → `/trocar` → outro.

### Troubleshooting comum

| Sintoma | Diagnóstico provável | Comando pra investigar |
|---|---|---|
| Bot não responde | Serviço caiu | `ssh root@<vps> 'systemctl status ignis-bot'` |
| Bot responde "Nenhum workspace conectado" mas você vinculou | `is_active=false` na linha errada | Checar `telegram_links` no painel Supabase |
| "0 leads salvos, X erros técnicos" | Quase sempre Anthropic API key | `journalctl -u ignis-bot -n 50 \| grep 401` |
| OCR alucinando username | Modelo ignorando "scanner óptico" | Inspecionar `prompt` em `bot/ocr.py` — pode precisar reforçar |
| Lead aparece mas sem `display_name` | Print só tinha username, sem nome | Comportamento normal — SDR completa manualmente |
| Mesma imagem reenviada não responde "duplicata" | `print_cache` não tem o hash | Provavelmente serviço caiu antes de fazer cache_store — sintoma de retry parcial |

### Comandos úteis na VPS

```bash
# Status do serviço
ssh root@<vps> 'systemctl status ignis-bot'

# Logs ao vivo
ssh root@<vps> 'journalctl -u ignis-bot -f'

# Logs últimos 30 min sem ruído de HTTP
ssh root@<vps> 'journalctl -u ignis-bot --since "30 min ago" | grep -vE "httpx|aiogram\.dispatcher"'

# Reiniciar (depois de mudar código)
ssh root@<vps> 'cd /root/crm-ignis && git pull && systemctl restart ignis-bot'

# Reiniciar com requirements novos
ssh root@<vps> 'cd /root/crm-ignis/bot && ./venv/bin/pip install -r requirements.txt && systemctl restart ignis-bot'

# Ver .env (mascarado)
ssh root@<vps> 'cat /root/crm-ignis/bot/.env | sed "s/=\(.\{8\}\).*/=\1...REDACTED/"'
```

### Rotação de credenciais

Faz parte da disciplina de segurança. **3 segredos separados:**

1. **Token do bot Telegram:** `@BotFather` → `/revoke` → escolhe `@Ignis_crm_bot` → te dá novo. Atualiza `TELEGRAM_BOT_TOKEN` no `bot/.env` da VPS + `systemctl restart`.
2. **Anthropic API key:** [console.anthropic.com](https://console.anthropic.com) → API Keys → revoga atual + cria nova. Atualiza `ANTHROPIC_API_KEY` no `bot/.env`.
3. **Supabase service_role_key:** [supabase.com](https://supabase.com) → Settings → API → "Reveal" service_role. Pra rotacionar, a UI tem botão "Reset" (raro precisar). Atualiza `SUPABASE_SERVICE_ROLE_KEY` no `bot/.env`.

> **IMPORTANTE:** essas 3 chaves NUNCA devem ser coladas em conversa de chat (mesmo com Claude). Quando precisar, abre `bot/.env` direto via SSH e edita. As que estão hoje na VPS foram coladas em sessão de 9/5/2026 — devem ser rotacionadas antes de qualquer cliente pagante real.

### Onde NÃO mexer

- **Função `get_my_workspace_id()` no Postgres** — toda policy RLS depende dela. Mexer = mexer em todas as tabelas.
- **Constraint `leads_username_lower_is_canonical`** — proteção contra usernames com `@` ou caracteres errados. Pular = corromper banco.
- **Índice `telegram_links_one_active_per_chat`** — garante que `/trocar` funciona corretamente. Único parcial em `is_active=true`.
- **`upsert_lead` em `bot/db.py`** — lógica de idempotência (active OR soft-deleted) é frágil. Mudanças exigem testar restore + duplicata + lead novo.

---

## ENCERRAMENTO

Este arquivo é uma fotografia do projeto em **9 de maio de 2026 (atualizado no fim do dia, após Fase 7)**. Atualize quando algo grande mudar:

- Migração para outro provedor de banco
- Mudança no fluxo de deploy
- Novo subsistema (ex: Sales OS começar a se comunicar com Ignis CRM)
- Novo membro de equipe
- Decisão arquitetural importante

**Não atualize por mudanças pequenas** (campo novo numa tabela, bug corrigido, refactor). Pra isso o `CLAUDE.md`, o código e o git log já fazem o serviço.
