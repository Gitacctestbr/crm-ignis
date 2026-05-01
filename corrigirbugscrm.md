# Manual de Sobrevivência — Bugs no CRM IGNIS

> Skill compilada após o incidente do Split Brain (Painel Flutuante × Kanban × Dexie).
> Estas são as **5 Regras de Ouro** que protegem a arquitetura do IGNIS-CRM contra
> a classe de bugs que custou horas para diagnosticar. Antes de propor qualquer
> correção em camada de dados, sincronia entre telas ou normalização de input,
> releia este arquivo.

---

## Contexto do incidente que originou esta skill

A extensão tem **três contextos JS distintos** que precisam ver o mesmo banco:

| Contexto | Origem | Acessa Dexie diretamente? |
|---|---|---|
| Background Service Worker | `chrome-extension://...` | Sim |
| Dashboard / SidePanel / Popup | `chrome-extension://...` | Sim |
| `DmLeadPanel` (content script) | `instagram.com` | **Não** — IDB é por origem |

O bug-mãe foi a **Fratura de Estado** (Split Brain): leads existiam no Kanban
mas o Painel Flutuante os ignorava, e movimentações no Kanban não chegavam ao
Painel. As causas foram **estruturais**, não pontuais — daí a necessidade
destas regras.

---

## Regra 1 — Single Source of Truth (A Tela Obedece o Banco)

A UI **reage** ao banco. Nunca o contrário.

**Como aplicar:**
- Em páginas da extensão (Dashboard, SidePanel) → use `useLiveQuery` do
  `dexie-react-hooks`. Ele se reinscreve automaticamente em qualquer escrita
  da Dexie, em qualquer contexto.
- Em content scripts (que **não** podem abrir Dexie no `chrome-extension://`)
  → escute `chrome.runtime.onMessage` para `CRM_IGNIS_DB_UPDATED` e refetch
  via RPC contra o `background.ts`.
- Toda função de mutação no `leadsRepo.ts` **deve** disparar broadcast cruzado
  (`chrome.runtime.sendMessage` para páginas + `chrome.tabs.sendMessage` para
  content scripts) ao final do commit.

**Anti-padrões proibidos:**
- ❌ `setInterval` polling em estado de UI (gera flicker, drift e bateria).
- ❌ Botão de "Atualizar" para o usuário clicar.
- ❌ Pedir F5 / reload da extensão para ver mudança.
- ❌ Escrever no banco de um lado e fazer cache local do outro lado sem
  invalidação cruzada.

**Sintoma típico de violação:** "Mexi no Kanban e o Painel não atualizou."

---

## Regra 2 — Migrações Seguras via Engine

Limpezas em massa de dados legados (remover `@`, lowercase, dedup de username)
são **migrações de schema**, não rotinas de aplicação.

**Como aplicar:**
- Toda mudança que precisa varrer e re-escrever a tabela existente exige um
  novo `this.version(N).stores({...}).upgrade(async (tx) => {...})` em
  `src/db/db.ts`.
- O upgrade hook roda **dentro da transação interna do Dexie** — atomicidade
  e isolamento garantidos pelo motor.
- Helpers usados no hook devem ser **frozen-in-time**: definidos inline,
  nunca importados de outros arquivos. Se `stages.ts` ou `canonicalUsername`
  mudarem no futuro, a migração legada deve continuar produzindo o mesmo
  resultado histórico.
- Nunca mute uma versão já existente — sempre incremente.

**Anti-padrões proibidos:**
- ❌ Rodar limpeza de dados em `background.ts`. Service workers MV3
  **hibernam** após poucos segundos de inatividade — uma rotina pode ser
  morta no meio.
- ❌ Limpar dados em `useEffect` ao montar uma tela. A limpeza só roda se a
  tela for aberta, e roda repetidamente.
- ❌ Limpeza disparada por timer (`setInterval`).
- ❌ Misturar lógica de migração com lógica de aplicação no mesmo método do
  repositório.

**Sintoma típico de violação:** "Os dados antigos só limpam se eu abrir a tela
X" ou "às vezes a limpeza não roda."

---

## Regra 3 — Zero Falhas Silenciosas (No Swallowed Exceptions)

Se o banco bloqueou ou recusou uma escrita, o usuário precisa **ver**.

**Como aplicar:**
- Toda função de mutação retorna um discriminated union explícito (`{ status:
  "created" | "exists" | "blocked", lead }`) — nunca um `boolean` ou um
  `lead | null` ambíguo.
- Cada caller verifica o `status` e dispara um Toast/Alert correspondente
  ("⚠️ Lead já existe", "🔒 Dia fechado — edição bloqueada", etc.).
- `try/catch` nunca termina em `catch {}` vazio em código de domínio. Se for
  realmente "fire and forget" (ex.: broadcast de invalidação), o `catch`
  precisa de comentário explicando **por que** é seguro engolir.
- Erros inesperados → `console.error` + Toast de erro genérico. Nunca
  silencioso.

**Anti-padrões proibidos:**
- ❌ Função que diz "salvei!" sem ter salvado (ex.: bateu em duplicata e
  retornou o lead existente sem sinalizar).
- ❌ `catch {}` em fluxos de UI sem comentário de justificativa.
- ❌ Promises sem `.catch()` em handlers React (`void p` é OK; `p` solto não).
- ❌ `addLead` retornar o lead existente como se fosse criado.

**Sintoma típico de violação:** "O sistema disse que salvou, mas o Kanban
ignorou a ação."

---

## Regra 4 — Sanitização Centralizada

Regras de limpeza e formatação de input vivem em **um único helper exportado**.
O sistema inteiro importa e usa.

**Como aplicar:**
- `canonicalUsername(u)` em `src/db/leadsRepo.ts` é a fonte única para
  username. Aplicada em **toda** entrada — gravação E leitura — antes de
  qualquer comparação ou indexação.
- URLs do Instagram → `parseInstagramUsername` e `isDMRoute` em
  `src/instagram/parseInstagram.ts`. Não criar regex paralelo.
- Estágios → `normalizeStageId` em `src/crm/stages.ts`.
- Datas locais → `toLocalDayRange`, `todayDateKey` (pad com zeros, evitando
  bug de fuso UTC do `new Date("YYYY-MM-DD")`).

**Anti-padrões proibidos:**
- ❌ Reimplementar `.trim().replace(/^@+/, "").toLowerCase()` solto em outro
  arquivo. Se aparecer essa sequência fora do helper canônico, é bug
  esperando.
- ❌ Comparar `username` direto sem passar por `canonicalUsername` em ambos
  os lados.
- ❌ Ter um helper "parecido mas não igual" (ex.: um que faz lowercase, outro
  que não) — convergem para divergência.
- ❌ Sanitização inline com regex copiado entre arquivos.

**Sintoma típico de violação:** "Funcionou aqui mas não ali" — sinal de que
dois callers normalizaram diferente.

---

## Regra 5 — Fallbacks Defensivos (Não Confie em Índices Físicos)

Mesmo com migração formal e helper canônico, **dados legados podem ter
escapado**. Toda leitura crítica precisa de plano B em memória.

**Como aplicar:**
- `getLeadByUsername` e a checagem de duplicata em `addLead` **não** usam
  `.where("[workspaceId+usernameLower]").equals(...)`. Em vez disso, fazem
  `where("workspaceId").toArray()` e `find()` em memória, comparando via
  `canonicalUsername()` em **ambos** os lados (input e cada `l.usernameLower
  || l.username`).
- A escala da extensão (single-user, centenas de leads) torna o scan em
  memória barato. Performance perdida é trivial; consistência ganha é
  total.
- Padrão `searchLeads` é o template a seguir.

**Anti-padrões proibidos:**
- ❌ Confiar que o índice composto está sempre limpo. Um único lead salvo no
  passado com `@` ou maiúscula trava o lookup.
- ❌ Adicionar índice físico novo sem fallback em memória durante o período
  de transição (até que TODOS os usuários tenham rodado a migração).
- ❌ Usar índice direto (`.equals(...)`) em lookups de identidade
  (username, email, etc.) sem normalização defensiva nos dois lados.

**Sintoma típico de violação:** "Por que está retornando `null` se eu vejo
o registro no IndexedDB do DevTools?" — quase sempre é índice sujo + lookup
cego.

---

## Checklist antes de fechar qualquer PR

- [ ] Toda escrita no banco dispara `broadcastDbUpdated` (ou passa por uma
      função que dispara)?
- [ ] Toda leitura de identidade tem fallback em memória via canonicalizador?
- [ ] Mudança de schema → nova `version(N)` em `db.ts` com upgrade hook
      frozen-in-time?
- [ ] Sanitização nova → adicionada ao helper canônico, não inline?
- [ ] Erros e bloqueios viram Toast visível? Nenhum `catch {}` sem
      justificativa em comentário?
- [ ] Funciona sem F5? Funciona com a extensão recém-instalada (DB vazio) E
      com dados sujos legados?

---

*Última atualização: incidente do Split Brain — Painel Flutuante × Kanban.*
