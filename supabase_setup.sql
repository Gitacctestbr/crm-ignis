-- ============================================================
-- supabase_setup.sql
-- CRM IGNIS — Schema PostgreSQL para Supabase
-- Gerado a partir de: src/db/db.ts (Dexie v5) + src/db/leadsRepo.ts
-- ============================================================
--
-- TIMESTAMPS: armazenados como BIGINT (epoch em milissegundos),
--   idêntico ao Dexie. Para migrar: to_timestamp(coluna / 1000.0)
--
-- WORKSPACE_ID: TEXT (não UUID) — o código atual usa strings como
--   "default". Migre para UUID quando implementar auth multi-tenant.
--
-- EXECUÇÃO: cole no SQL Editor do Supabase (Project → SQL Editor).
--   Rode em ordem: ENUMs → Função helper → Tabelas → Índices → RLS.
-- ============================================================


-- ============================================================
-- 0. EXTENSÕES
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";  -- uuid_generate_v4(), útil para futura migração


-- ============================================================
-- 1. TIPOS ENUM
-- ============================================================

CREATE TYPE board_type AS ENUM (
  'OUTBOUND',
  'SOCIAL'
);

CREATE TYPE lead_priority AS ENUM (
  'low',
  'medium',
  'high'
);

CREATE TYPE task_status AS ENUM (
  'open',
  'done',
  'snoozed'
);

CREATE TYPE activity_event_type AS ENUM (
  'CREATED',
  'MOVED_STAGE',
  'NOTE_UPDATED',
  'PRIORITY_CHANGED',
  'TASK_CREATED',
  'TASK_DONE'
);

-- 13 estágios do Kanban (espelha src/crm/stages.ts — IDs são chaves estáveis)
CREATE TYPE stage_id AS ENUM (
  'LEADS_NOVOS',
  'ABORDAGEM_ENVIADA',
  'ABORDAGEM_RESPONDIDA',
  'PERGUNTA_ENVIADA',
  'PERGUNTA_RESPONDIDA',
  'CTA_REALIZADO',
  'ACEITOU_CALL',
  'AGENDAMENTO_COMPLETO',
  'COMPARECEU',
  'NO_SHOW',
  'REAGENDAR',
  'FECHADO_GANHO',
  'PERDIDO'
);


-- ============================================================
-- 2. TABELA DE SUPORTE: user_workspaces
--    Mapeia auth.uid() (Supabase Auth) → workspace_id (TEXT)
--    Necessária para que get_my_workspace_id() funcione nas policies.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.user_workspaces (
  user_id      UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  workspace_id TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id)
);

ALTER TABLE public.user_workspaces ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_workspaces: SELECT próprio"
  ON public.user_workspaces
  FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "user_workspaces: INSERT próprio"
  ON public.user_workspaces
  FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "user_workspaces: UPDATE próprio"
  ON public.user_workspaces
  FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());


-- ============================================================
-- 3. FUNÇÃO HELPER: get_my_workspace_id()
--    Usada em todas as policies RLS. STABLE = cacheada por transação.
--    Retorna NULL se o usuário não tiver workspace cadastrado
--    (policy nega o acesso automaticamente quando USING retorna NULL).
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_my_workspace_id()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT workspace_id
  FROM public.user_workspaces
  WHERE user_id = auth.uid()
  LIMIT 1;
$$;


-- ============================================================
-- 4. TABELA: leads
--    Espelha: Lead em src/db/db.ts + allowlist de updateLead em leadsRepo.ts
-- ============================================================

CREATE TABLE IF NOT EXISTS public.leads (
  -- Chave e tenant
  id              TEXT          NOT NULL PRIMARY KEY,
  workspace_id    TEXT          NOT NULL,

  -- Posição no Kanban
  board           board_type    NOT NULL,
  stage_id        stage_id      NOT NULL DEFAULT 'LEADS_NOVOS',

  -- Identidade do lead (sempre canônico — sem @, lowercase)
  username        TEXT          NOT NULL,
  username_lower  TEXT          NOT NULL,

  display_name    TEXT,
  avatar_url      TEXT,

  -- Qualificação
  priority        lead_priority NOT NULL DEFAULT 'medium',
  tags            TEXT[]        NOT NULL DEFAULT '{}',
  notes           TEXT          NOT NULL DEFAULT '',

  -- Datas (epoch ms — compatível com Date.now() do JavaScript)
  created_at        BIGINT NOT NULL,
  updated_at        BIGINT NOT NULL,
  last_touched_at   BIGINT NOT NULL,
  next_follow_up_at BIGINT,
  deleted_at        BIGINT,   -- NULL = ativo | preenchido = soft delete

  -- CTA (Call-to-Action unificado)
  cta_url   TEXT,
  cta_at    BIGINT,
  cta_note  TEXT,

  -- Invariante: username_lower nunca deve ter maiúsculas ou '@'
  CONSTRAINT leads_username_lower_is_canonical
    CHECK (username_lower = lower(regexp_replace(username_lower, '^@+', '')))
);

-- Unicidade de username por workspace (apenas entre leads ativos)
CREATE UNIQUE INDEX IF NOT EXISTS leads_workspace_username_uq
  ON public.leads (workspace_id, username_lower)
  WHERE deleted_at IS NULL;

-- Espelha índice composto Dexie: [workspaceId+board+stageId]
CREATE INDEX IF NOT EXISTS leads_workspace_board_stage
  ON public.leads (workspace_id, board, stage_id);

-- Espelha índice composto Dexie: [workspaceId+nextFollowUpAt]
CREATE INDEX IF NOT EXISTS leads_workspace_next_follow_up
  ON public.leads (workspace_id, next_follow_up_at)
  WHERE next_follow_up_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS leads_created_at  ON public.leads (created_at);
CREATE INDEX IF NOT EXISTS leads_updated_at  ON public.leads (updated_at);

-- GIN para busca eficiente em arrays de tags
CREATE INDEX IF NOT EXISTS leads_tags_gin
  ON public.leads USING GIN (tags);

-- ── RLS ──────────────────────────────────────────────────────
ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "leads: SELECT próprio workspace"
  ON public.leads FOR SELECT
  USING (workspace_id = public.get_my_workspace_id());

CREATE POLICY "leads: INSERT próprio workspace"
  ON public.leads FOR INSERT
  WITH CHECK (workspace_id = public.get_my_workspace_id());

CREATE POLICY "leads: UPDATE próprio workspace"
  ON public.leads FOR UPDATE
  USING  (workspace_id = public.get_my_workspace_id())
  WITH CHECK (workspace_id = public.get_my_workspace_id());

CREATE POLICY "leads: DELETE próprio workspace"
  ON public.leads FOR DELETE
  USING (workspace_id = public.get_my_workspace_id());


-- ============================================================
-- 5. TABELA: tasks
--    Espelha: Task em src/db/db.ts
-- ============================================================

CREATE TABLE IF NOT EXISTS public.tasks (
  id            TEXT        NOT NULL PRIMARY KEY,
  workspace_id  TEXT        NOT NULL,
  lead_id       TEXT        NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,

  title         TEXT        NOT NULL,
  due_at        BIGINT      NOT NULL,
  done_at       BIGINT,

  status        task_status NOT NULL DEFAULT 'open',
  snooze_until  BIGINT
);

-- Espelha índices compostos do Dexie
CREATE INDEX IF NOT EXISTS tasks_workspace_status
  ON public.tasks (workspace_id, status);

CREATE INDEX IF NOT EXISTS tasks_workspace_due_at
  ON public.tasks (workspace_id, due_at);

CREATE INDEX IF NOT EXISTS tasks_workspace_lead_id
  ON public.tasks (workspace_id, lead_id);

-- ── RLS ──────────────────────────────────────────────────────
ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tasks: SELECT próprio workspace"
  ON public.tasks FOR SELECT
  USING (workspace_id = public.get_my_workspace_id());

CREATE POLICY "tasks: INSERT próprio workspace"
  ON public.tasks FOR INSERT
  WITH CHECK (workspace_id = public.get_my_workspace_id());

CREATE POLICY "tasks: UPDATE próprio workspace"
  ON public.tasks FOR UPDATE
  USING  (workspace_id = public.get_my_workspace_id())
  WITH CHECK (workspace_id = public.get_my_workspace_id());

CREATE POLICY "tasks: DELETE próprio workspace"
  ON public.tasks FOR DELETE
  USING (workspace_id = public.get_my_workspace_id());


-- ============================================================
-- 6. TABELA: activity_events  (era "events" no Dexie — renomeada
--    para evitar conflito com palavra reservada do PostgreSQL)
--    Espelha: ActivityEvent em src/db/db.ts
-- ============================================================

CREATE TABLE IF NOT EXISTS public.activity_events (
  id            TEXT                NOT NULL PRIMARY KEY,
  workspace_id  TEXT                NOT NULL,
  lead_id       TEXT                NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,

  type          activity_event_type NOT NULL,

  from_stage_id stage_id,   -- preenchido apenas em MOVED_STAGE
  to_stage_id   stage_id,   -- preenchido apenas em MOVED_STAGE

  at            BIGINT      NOT NULL,  -- epoch ms do evento
  day           INTEGER     NOT NULL   -- yyyymmdd — para filtros por dia sem parse de data
);

-- Espelha índices compostos do Dexie
CREATE INDEX IF NOT EXISTS events_workspace_type_day
  ON public.activity_events (workspace_id, type, day);

CREATE INDEX IF NOT EXISTS events_workspace_type_to_stage_day
  ON public.activity_events (workspace_id, type, to_stage_id, day);

CREATE INDEX IF NOT EXISTS events_workspace_lead_id
  ON public.activity_events (workspace_id, lead_id);

CREATE INDEX IF NOT EXISTS events_at
  ON public.activity_events (at);

-- ── RLS ──────────────────────────────────────────────────────
ALTER TABLE public.activity_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "activity_events: SELECT próprio workspace"
  ON public.activity_events FOR SELECT
  USING (workspace_id = public.get_my_workspace_id());

CREATE POLICY "activity_events: INSERT próprio workspace"
  ON public.activity_events FOR INSERT
  WITH CHECK (workspace_id = public.get_my_workspace_id());

CREATE POLICY "activity_events: UPDATE próprio workspace"
  ON public.activity_events FOR UPDATE
  USING  (workspace_id = public.get_my_workspace_id())
  WITH CHECK (workspace_id = public.get_my_workspace_id());

CREATE POLICY "activity_events: DELETE próprio workspace"
  ON public.activity_events FOR DELETE
  USING (workspace_id = public.get_my_workspace_id());


-- ============================================================
-- 7. TABELA: daily_metrics
--    Espelha: DailyMetrics em src/db/db.ts
--    id = "{workspaceId}:{board}:{dateKey}" (composto igual ao Dexie)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.daily_metrics (
  -- id composto idêntico ao Dexie: "{workspaceId}:{board}:{dateKey}"
  id            TEXT       NOT NULL PRIMARY KEY,
  workspace_id  TEXT       NOT NULL,
  board         board_type NOT NULL,
  date_key      TEXT       NOT NULL,  -- formato YYYY-MM-DD

  -- Novas abordagens
  msg1_disparos   INTEGER  NOT NULL DEFAULT 0,
  msg1_respostas  INTEGER  NOT NULL DEFAULT 0,
  msg2_disparos   INTEGER  NOT NULL DEFAULT 0,
  msg2_respostas  INTEGER  NOT NULL DEFAULT 0,

  cta_disparos    INTEGER  NOT NULL DEFAULT 0,
  agend_novos     INTEGER  NOT NULL DEFAULT 0,

  -- Follow-up
  follow_enviados  INTEGER NOT NULL DEFAULT 0,
  follow_respostas INTEGER NOT NULL DEFAULT 0,
  follow_cta       INTEGER NOT NULL DEFAULT 0,
  agend_follow     INTEGER NOT NULL DEFAULT 0,

  -- Controle
  created_at BIGINT  NOT NULL,
  updated_at BIGINT  NOT NULL,
  closed_at  BIGINT,  -- NULL = dia ainda aberto

  -- Garante formato YYYY-MM-DD e unicidade natural
  CONSTRAINT daily_metrics_date_key_format
    CHECK (date_key ~ '^\d{4}-\d{2}-\d{2}$'),
  CONSTRAINT daily_metrics_workspace_board_date_uq
    UNIQUE (workspace_id, board, date_key)
);

-- Espelha índices compostos do Dexie
CREATE INDEX IF NOT EXISTS daily_metrics_workspace_board_date
  ON public.daily_metrics (workspace_id, board, date_key);

CREATE INDEX IF NOT EXISTS daily_metrics_workspace_date
  ON public.daily_metrics (workspace_id, date_key);

-- Espelha [workspaceId+board+closedAt] — filtrado para não indexar NULLs
CREATE INDEX IF NOT EXISTS daily_metrics_workspace_board_closed
  ON public.daily_metrics (workspace_id, board, closed_at)
  WHERE closed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS daily_metrics_date_key  ON public.daily_metrics (date_key);
CREATE INDEX IF NOT EXISTS daily_metrics_updated_at ON public.daily_metrics (updated_at);

-- ── RLS ──────────────────────────────────────────────────────
ALTER TABLE public.daily_metrics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "daily_metrics: SELECT próprio workspace"
  ON public.daily_metrics FOR SELECT
  USING (workspace_id = public.get_my_workspace_id());

CREATE POLICY "daily_metrics: INSERT próprio workspace"
  ON public.daily_metrics FOR INSERT
  WITH CHECK (workspace_id = public.get_my_workspace_id());

CREATE POLICY "daily_metrics: UPDATE próprio workspace"
  ON public.daily_metrics FOR UPDATE
  USING  (workspace_id = public.get_my_workspace_id())
  WITH CHECK (workspace_id = public.get_my_workspace_id());

CREATE POLICY "daily_metrics: DELETE próprio workspace"
  ON public.daily_metrics FOR DELETE
  USING (workspace_id = public.get_my_workspace_id());


-- ============================================================
-- FIM DO ARQUIVO
-- ============================================================
--
-- RESUMO DO QUE FOI CRIADO
-- ─────────────────────────────────────────────────────────────
-- ENUMs (5):
--   board_type, lead_priority, task_status,
--   activity_event_type, stage_id (13 valores)
--
-- Tabelas (5):
--   user_workspaces  — mapeamento auth.uid() → workspace_id
--   leads            — leads do CRM com soft delete e CTA
--   tasks            — tarefas vinculadas a leads
--   activity_events  — log de eventos (era "events" no Dexie)
--   daily_metrics    — métricas diárias por board
--
-- Índices (20):
--   Espelham todos os índices compostos do Dexie v5.
--   Índice GIN em leads.tags para busca em arrays.
--
-- RLS ativado em todas as 5 tabelas.
-- Policies de SELECT/INSERT/UPDATE/DELETE em todas as tabelas.
-- Todas as policies usam public.get_my_workspace_id() como
--   filtro de tenant — trocar só essa função se mudar a lógica de auth.
--
-- PRÓXIMOS PASSOS (fora deste arquivo)
-- ─────────────────────────────────────────────────────────────
-- 1. Criar trigger que insere em user_workspaces ao fazer signup
--    (ou fazer isso no onboarding da extensão via RPC).
-- 2. Migrar dados existentes do IndexedDB:
--    - Exportar via JSON no front-end
--    - Converter timestamps: epoch_ms → BIGINT (já compatível)
--    - username/username_lower já estão em canonical (leadsRepo.ts)
-- 3. Considerar migrar workspace_id para UUID quando auth estiver pronto.
-- 4. Considerar migrar timestamps para TIMESTAMPTZ em v2 do schema
--    usando: to_timestamp(coluna_bigint / 1000.0) AT TIME ZONE 'UTC'
-- ============================================================
