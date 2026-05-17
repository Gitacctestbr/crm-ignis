# Relatório: Sistema de Importação e Armazenamento de Leads — Ignis CRM

**Versão:** 1.0  
**Data:** 2026-05-08  
**Público:** Desenvolvedor Senior

---

## 1. Visão Geral da Arquitetura

O **Ignis CRM** é uma extensão de navegador Chrome + scripts Python que gerencia leads de redes sociais. Há **dois subsistemas independentes** que se comunicam via CSV:

```
┌────────────────────────────────────────────────────────────────┐
│                  IGNIS CRM — ARQUITETURA HÍBRIDA               │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  ┌──────────────────────┐          ┌──────────────────────┐   │
│  │ EXTENSÃO CHROME      │          │  SCRIPTS PYTHON      │   │
│  ├──────────────────────┤          ├──────────────────────┤   │
│  │ • React 19 + Dexie   │          │ • OCR (Claude Haiku) │   │
│  │ • Banco: Supabase    │          │ • Watchdog           │   │
│  │ • UI: Kanban/Painel  │◄────────►│ • gspread            │   │
│  │ • IndexedDB (cache)  │  CSV via │ • Exporta Google     │   │
│  │                      │  Sheets  │   Sheets             │   │
│  └──────────────────────┘          └──────────────────────┘   │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

**Banco de dados:** PostgreSQL (Supabase) com sincronização via Google Sheets.

---

## 2. Fluxo de Importação de Leads

### 2.1 Ponto de Entrada: Google Sheets → CSV Publicado

A extensão sincroniza leads a partir de um **CSV publicado** de uma planilha Google Sheets:

```
┌─────────────────────────────────────────────────────────────┐
│ Google Sheets (Arquivo → Publicar na web → CSV)             │
│ URL: https://docs.google.com/spreadsheets/d/.../export?... │
└─────────────────────────────────────────────────────────────┘
                          ↓
          ┌───────────────────────────────┐
          │ Salvo em chrome.storage.local  │
          │ Chave: syncCsvUrl              │
          └───────────────────────────────┘
                          ↓
          ┌───────────────────────────────┐
          │ Auto-sync a cada 30 minutos    │
          │ (chrome.alarms)                │
          │ Ou sync manual via botão       │
          └───────────────────────────────┘
                          ↓
          ┌───────────────────────────────┐
          │ background.ts → syncLeads...() │
          └───────────────────────────────┘
```

**Localização do código:** `entrypoints/background.ts:99-195`

---

## 3. Formato Esperado do CSV

### 3.1 Estrutura Básica

A extensão espera um CSV com **5 colunas** (na ordem):

| Coluna | Nome | Tipo | Obrigatório | Exemplo |
|--------|------|------|-------------|---------|
| 1 | **Link / Username** | String | ✅ Sim | `instagram.com/joaozinho` ou `@joaozinho` |
| 2 | **Nome (displayName)** | String | ❌ Não | `João Silva` |
| 3 | **Bio** | String | ❌ Não | `Empreendedor tech | 📍 São Paulo` |
| 4 | **Seguidores** | String/Number | ❌ Não | `15.2K` ou `15200` |
| 5 | **Seguindo** | String/Number | ❌ Não | `842` |

### 3.2 Exemplo de CSV Válido

```csv
instagram.com/joaozinho,João Silva,Empreendedor tech,15.2K,842
instagram.com/mariatech,Maria Santos,Designer | UX/UI,8.5K,320
@carlos.dev,Carlos Oliveira,Desenvolvedor Python,3.2K,512
https://instagram.com/ana.psicologia,Ana Souza,,45K,210
```

### 3.3 Detecção de Cabeçalho

**Comportamento especial:** Se a primeira linha contém uma URL do Instagram ou começa com `http`, a extensão **assume que não há cabeçalho** e processa todas as linhas como dados:

```typescript
const firstCell = String(rows[0]?.[0] ?? "").toLowerCase();
const dataRows =
  firstCell.includes("instagram.com") || firstCell.startsWith("http")
    ? rows                    // Processa tudo
    : rows.slice(1);          // Pula primeira linha (cabeçalho)
```

**Implicação prática:**
- ✅ **Recomendado:** Comece direto com dados, sem cabeçalho
- ⚠️ **Alternativa:** Se quiser cabeçalho, primeira célula DEVE conter texto que não pareça URL

---

## 4. Fluxo de Processamento de Dados

### 4.1 Etapas da Sincronização

```python
Para cada linha do CSV:
  1. Extrai username da coluna 1 (link ou @username)
     └─ Trata URLs: instagram.com/{username}/
     └─ Remove @ automático
     └─ Converte para lowercase (canonicalização)
  
  2. Valida username
     └─ Se vazio → erro, pula linha
  
  3. Cria lead no banco com:
     ├─ workspaceId (do usuário logado)
     ├─ username (canonicalizado, obrigatório)
     ├─ displayName (coluna 2, opcional)
     ├─ board: "OUTBOUND" (sempre)
     ├─ stageId: "LEADS_NOVOS" (sempre)
     ├─ priority: "medium" (padrão)
     └─ Timestamps (createdAt, updatedAt, lastTouchedAt)
  
  4. Cria nota consolidada com colunas 3, 4, 5:
     └─ Bio: {bio}
     └─ Seguidores: {seguidores}
     └─ Seguindo: {seguindo}
     └─ Salva via updateLead após criar o lead
  
  5. Tenta buscar avatar (background, fire-and-forget)
     └─ Máximo 20 leads por ciclo
     └─ Delay de 300ms entre requisições
     └─ Não bloqueia sync se falhar
```

---

## 5. Schema de Dados — Leads

### 5.1 Tipo TypeScript `Lead`

```typescript
type Lead = {
  // Identificação
  id: string;                      // UUID gerado
  workspaceId: string;             // ID do usuário autenticado
  
  // Classificação
  board: "OUTBOUND" | "SOCIAL";    // Sempre "OUTBOUND" via CSV
  stageId: string;                 // ID do estágio (13 opções)
  
  // Dados do Usuário
  username: string;                // Username canonicalizado (lowercase, sem @)
  usernameLower: string;           // Cópia de username (redundância)
  displayName?: string;            // Nome amigável (bio, label)
  avatarUrl?: string;              // URL da foto de perfil
  
  // Metadados de Prioridade
  priority: "low" | "medium" | "high";  // "medium" por padrão
  tags: string[];                  // Array de tags customizadas
  
  // Conteúdo
  notes: string;                   // Notas consolidadas (bio + seguidores + seguindo)
  
  // Timestamps (milliseconds desde epoch)
  createdAt: number;               // Data de criação
  updatedAt: number;               // Última modificação
  lastTouchedAt: number;           // Último contato/movimento
  nextFollowUpAt?: number;         // Próximo follow-up agendado
  deletedAt?: number;              // Soft delete (se preenchido, lead é "deletado")
  
  // Call-to-Action (CTA)
  ctaUrl?: string;                 // URL enviada para o lead
  ctaAt?: number;                  // Timestamp do CTA
  ctaNote?: string;                // Nota sobre o CTA
};
```

### 5.2 Tabela PostgreSQL (schema real)

```sql
CREATE TABLE leads (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  board TEXT NOT NULL,              -- "OUTBOUND" | "SOCIAL"
  stage_id TEXT NOT NULL,
  username TEXT NOT NULL,
  username_lower TEXT NOT NULL,     -- Índice único: (workspace_id, username_lower) WHERE deleted_at IS NULL
  display_name TEXT,
  avatar_url TEXT,
  priority TEXT NOT NULL,           -- "low", "medium", "high"
  tags TEXT[] DEFAULT '{}'::TEXT[],
  notes TEXT DEFAULT '',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  last_touched_at BIGINT NOT NULL,
  next_follow_up_at BIGINT,
  deleted_at BIGINT,
  cta_url TEXT,
  cta_at BIGINT,
  cta_note TEXT
);

-- Índice de unicidade (impede duplicatas):
CREATE UNIQUE INDEX leads_workspace_username_unique 
  ON leads(workspace_id, username_lower) 
  WHERE deleted_at IS NULL;
```

---

## 6. Regras de Validação e Normalização

### 6.1 Canonicalização de Username

**Regra de Ouro:** Todo username que entra no sistema deve passar por `canonicalUsername()`:

```typescript
export function canonicalUsername(u: string): string {
  return String(u || "")
    .trim()              // Remove espaços laterais
    .replace(/^@+/, "")  // Remove @ inicial (ex: @joao → joao)
    .toLowerCase();      // Converte para lowercase (ex: João → joão)
}
```

**Exemplos:**
| Input | Output |
|-------|--------|
| `@joao.silva` | `joao.silva` |
| `João Silva ` | `joão silva` |
| `INSTAGRAM.COM/MARIA` | `instagram.com/maria` |
| `  @@@pedro  ` | `pedro` |

### 6.2 Extração de Username de Link

Quando a coluna 1 contém uma URL, a extensão **extrai automaticamente** o username:

```typescript
function extractUsernameFromLink(link: string): string | null {
  const s = String(link || "").trim();
  if (!s) return null;
  
  // Trata formatos:
  // - https://instagram.com/joao
  // - instagram.com/joao/
  // - @joao
  // - joao (assume instagram.com)
  
  try {
    const url = new URL(s.startsWith("http") ? s : `https://${s}`);
    if (url.hostname.includes("instagram.com")) {
      const parts = url.pathname.split("/").filter(Boolean);
      return parts[0] || null;
    }
  } catch { /* regex fallback */ }
  
  // Fallback: regex simples
  const m = s.match(/instagram\.com\/([^/?#\s]+)/);
  return m?.[1] || null;
}
```

### 6.3 Validação de Avatar

Apenas URLs válidas são aceitas:

```typescript
const cleanAvatar =
  typeof input.avatarUrl === "string" &&
  (input.avatarUrl.startsWith("http") || input.avatarUrl.startsWith("data:"))
    ? input.avatarUrl
    : undefined;  // Rejeita valores inválidos silenciosamente
```

### 6.4 Proteção contra Duplicatas

**Mecanismo:** O índice único em PostgreSQL + verificação antecipada em TypeScript:

```typescript
// Busca pelo usernameLower no workspace
const { data: existingRows } = await supabase
  .from("leads")
  .select("*")
  .eq("workspace_id", input.workspaceId)
  .eq("username_lower", usernameLower)
  .is("deleted_at", null)           // Ignora deletados
  .limit(1);

if (existingRows && existingRows.length > 0) {
  // Lead já existe → retorna status "exists", não recria
  return { status: "exists", lead: existing };
}
```

**Implicação:** Se você roda sync duas vezes com o mesmo CSV, os leads não são duplicados. A segunda execução retorna `skipped: N`.

---

## 7. Os 13 Estágios de Um Lead

Cada lead navega entre estes estágios (Kanban):

| ID | Rótulo | Significado |
|----|--------|------------|
| `LEADS_NOVOS` | Leads novos | Novo capturado, não abordado |
| `ABORDAGEM_ENVIADA` | Abordagem enviada | Mensagem inicial enviada |
| `ABORDAGEM_RESPONDIDA` | Abordagem respondida | Lead respondeu ao contato |
| `PERGUNTA_ENVIADA` | Pergunta enviada | Pergunta de qualificação enviada |
| `PERGUNTA_RESPONDIDA` | Pergunta respondida | Lead respondeu pergunta |
| `CTA_REALIZADO` | CTA realizado | Call-to-action executado (link enviado) |
| `ACEITOU_CALL` | Aceitou call | Lead aceitou proposta de call/reunião |
| `AGENDAMENTO_COMPLETO` | Agendamento completo | Reunião agendada com data/hora |
| `COMPARECEU` | Compareceu | Lead compareceu à reunião |
| `NO_SHOW` | No-show | Lead não compareceu |
| `REAGENDAR` | Reagendar | Necessário agendar novamente |
| `FECHADO_GANHO` | Fechado (ganho) | Deal/venda fechada com sucesso |
| `PERDIDO` | Perdido | Lead descartado ou prospect perdido |

**Padrão na importação:** Todos os leads CSV começam em `LEADS_NOVOS`.

---

## 8. Retorno da Sincronização

Cada sincronização (manual ou automática) retorna um sumário:

```typescript
type SyncResult = {
  created: number;    // Leads novos criados
  skipped: number;    // Leads que já existiam
  errors: number;     // Erros ao processar (username inválido, etc.)
};
```

**Exemplo de saída:**
```json
{
  "created": 5,       // 5 novos leads
  "skipped": 2,       // 2 já existiam
  "errors": 1         // 1 linha inválida (sem username)
}
```

---

## 9. Fluxo de Busca/Atualização de Leads

Depois que um lead é criado via CSV, a extensão oferece APIs para:

### 9.1 Buscar Lead por Username
```typescript
await getLeadByUsername({
  workspaceId: "...",
  username: "@joao"  // Ou "joao" — normalizado automaticamente
});
```

### 9.2 Buscar Leads por Substring
```typescript
await searchLeads({
  workspaceId: "...",
  query: "maria",    // Busca em username e displayName (case-insensitive)
  limit: 10
});
```

### 9.3 Atualizar Lead
```typescript
await updateLead({
  workspaceId: "...",
  leadId: "uuid...",
  patch: {
    stageId: "ABORDAGEM_ENVIADA",
    notes: "Respondeu no WhatsApp",
    priority: "high",
    tags: ["vip", "hot"]
  }
});
```

---

## 10. Exemplo Prático: Importação Passo-a-Passo

### Cenário: Importar 3 leads de uma planilha

**Passo 1:** Criar planilha no Google Sheets

```
A                              | B              | C            | D     | E
instagram.com/joaozinho        | João Silva     | Empreendedor | 15K   | 842
https://instagram.com/maritech | Maria Santos   | Design UX    | 8.5K  | 320
@carlos.dev                    | Carlos Dev     | Python guy   | 3.2K  | 512
```

**Passo 2:** Publicar como CSV
- Arquivo → Publicar na web → Selecionar "CSV"
- Copiar URL → Ex: `https://docs.google.com/spreadsheets/d/.../export?format=csv`

**Passo 3:** Configurar na extensão
- Abrir settings da extensão Ignis CRM
- Colar URL em "Sync CSV URL"
- Salvar

**Passo 4:** Sincronizar (automático a cada 30 min ou manual via botão)

**Resultado esperado:**

```
✅ Sync realizado:
  • Criados: 3
  • Duplicados (pulados): 0
  • Erros: 0

Leads criados em "Leads novos":
  1. joaozinho (João Silva)
  2. maritech (Maria Santos)
  3. carlos.dev (Carlos Dev)

Notas preenchidas com: Bio + Seguidores + Seguindo
Avatares sendo baixados em background (300ms/cada)
```

---

## 11. Mapeamento: CSV → Lead (Campo a Campo)

| CSV Col | Campo TypeScript | Persistido em | Processamento |
|---------|------------------|---------------|---------------|
| 1 (Link) | `username` | `username` + `username_lower` | Extrai URL, canonicaliza |
| 2 (Nome) | `displayName` | `display_name` | Trim, opcional |
| 3 (Bio) | `notes` | `notes` | Consolida com cols 4 e 5 |
| 4 (Seguidores) | `notes` | `notes` | Texto "Seguidores: X" |
| 5 (Seguindo) | `notes` | `notes` | Texto "Seguindo: Y" |
| — | `board` | `board` | Sempre `OUTBOUND` |
| — | `stageId` | `stage_id` | Sempre `LEADS_NOVOS` |
| — | `priority` | `priority` | Sempre `medium` |
| — | `tags` | `tags` | Array vazio `[]` |
| — | `avatarUrl` | `avatar_url` | Buscado em background (optional) |
| — | `createdAt` | `created_at` | `Date.now()` |
| — | `updatedAt` | `updated_at` | `Date.now()` |
| — | `lastTouchedAt` | `last_touched_at` | `Date.now()` |

---

## 12. Soft Delete — Não Há Hard Delete

**Regra crítica:** Leads nunca são removidos fisicamente do banco. Ao invés:

```typescript
// Soft delete
await supabase
  .from("leads")
  .update({ deleted_at: Date.now() })
  .eq("id", leadId);

// Soft restore
await supabase
  .from("leads")
  .update({ deleted_at: null, stage_id: "LEADS_NOVOS", ... })
  .eq("id", leadId);
```

**Vantagem:** Se uma linha for deletada do CSV e sync rodar novamente, a extensão **não recria** o lead — ele permanece na lixeira.

---

## 13. Resumo de Fluxo Crítico

```
Arquivo CSV Publicado
  ↓
chrome.storage.local → syncCsvUrl
  ↓
Auto-sync a cada 30 min OU Manual via botão
  ↓
background.ts: syncLeadsFromSheets()
  ├─ Fetch CSV via HTTP
  ├─ Parse CSV com regex customizado
  ├─ Para cada linha:
  │   ├─ Extrai username (normaliza)
  │   ├─ Valida (não vazio)
  │   ├─ Busca duplicata (workspace + username_lower)
  │   ├─ Cria Lead ou retorna "exists"
  │   ├─ Consolida notas (bio + seguidores + seguindo)
  │   └─ Tenta buscar avatar (background)
  ├─ Retorna { created, skipped, errors }
  └─ Broadcast "DB_UPDATED" para todas as UIs
      ↓
      Kanban + Dashboard + SidePanel atualizam
```

---

## 14. Considerações Técnicas Para O Dev Senior

### Autenticação
- Todas as operações de leads são escoped ao `workspaceId` (que é o `auth.uid()` do Supabase)
- Sem usuário logado → sync retorna `{ created: 0, skipped: 0, errors: 0 }` silenciosamente

### Índices e Performance
- Índice único em `(workspace_id, username_lower)` onde `deleted_at IS NULL`
- Busca por substring usa `ilike` (case-insensitive) — sem índice GIN (escala é leads de 1 usuário)
- Timestamps em milliseconds (BIGINT) para precisão

### Transações
- Cada lead criado dispara um `ActivityEvent` do tipo `CREATED` (fire-and-forget)
- Se o event falhar, o lead já foi criado — trade-off consciente (histórico não-crítico)

### Broadcast Entre Abas
- Background envia `CRM_IGNIS_DB_UPDATED` para todas as abas abertas
- Content script, SidePanel e Dashboard escutam e recarregam dados

### Rate Limiting
- Avatar backfill: máx 20 por ciclo, 300ms entre chamadas (respeita IG)
- Nenhuma throttling no sync CSV (une-shot a cada 30 min)

### CSV Parser Customizado
- Suporta quoted values: `"nome, com vírgula"` → `nome, com vírgula`
- Suporta escaped quotes: `"nome ""famoso"""` → `nome "famoso"`
- Detecta auto se primeira linha é cabeçalho (heurística: contém URL?)

---

## 15. Troubleshooting

| Problema | Causa | Solução |
|----------|-------|---------|
| Leads não importam | URL do CSV inválido/vazio | Verifique `syncCsvUrl` em settings |
| Sync retorna 0 criados | Todos são duplicatas | Verifique `username_lower` já existe |
| Username extraído errado | URL não em formato reconhecido | Use `instagram.com/user` ou `@user` |
| Avatar em branco | Fetch falhou ou rate limit | Clique "Atualizar Fotos" manualmente |
| Notes truncadas | Campo notes muito grande | Postgres suporta TEXT (ilimitado) |
| Lead reaparece após deletar | Soft delete + re-import | Lixeira preserva deletados, sync não recria |

---

## 16. Conclusão

O sistema de importação de leads no Ignis CRM segue um padrão **simples mas robusto**:

1. **Fonte:** CSV publicado do Google Sheets (URL estática)
2. **Frequência:** Auto-sync a cada 30 min + sync manual
3. **Banco:** PostgreSQL (Supabase) com índices de unicidade
4. **Schema:** 16 campos por lead, soft delete, timestamps
5. **Validação:** Normalização de username, extração de URL, validação de avatar
6. **Proteção:** Índice único + verificação antecipada evita duplicatas
7. **Outputs:** Sumário de `{ created, skipped, errors }` + broadcast

Este design garante que:
- ✅ Leads nunca são duplicados
- ✅ Dados são sincronizados cross-tab
- ✅ Deletados permanecem recuperáveis
- ✅ Escala bem para uso single-user
- ✅ Batch imports rodam sem bloquear UI

---

**Dúvidas?** Leia `entrypoints/background.ts` linhas 99-195 (sync) e `src/db/leadsRepo.ts` (schema/validação).
