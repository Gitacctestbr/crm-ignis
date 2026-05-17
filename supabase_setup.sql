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
  user_id        UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  workspace_id   TEXT        NOT NULL,
  workspace_name TEXT,        -- nome humano (ex: "Studio Beauty VT") — preenchido no signup
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
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

  -- Bot Telegram: rastreabilidade + revisão manual
  needs_review        BOOLEAN NOT NULL DEFAULT false,  -- OCR ambíguo → SDR revisa
  created_by_chat_id  BIGINT,                          -- qual chat capturou (multi-operador)
  original_print_url  TEXT,                            -- preview da imagem original (Storage)
  extraction_obs      TEXT,                            -- texto da observação do OCR

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

-- SDR consulta "leads pra revisar" frequentemente — índice parcial é barato
CREATE INDEX IF NOT EXISTS leads_workspace_needs_review
  ON public.leads (workspace_id, updated_at DESC)
  WHERE needs_review = true AND deleted_at IS NULL;

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
-- 8. TABELA: telegram_links
--    Vincula chat_id do Telegram ↔ workspace_id do CRM.
--    1 chat_id pode ter N linhas (admin SDR de múltiplos clientes),
--    mas só 1 com is_active=true (regra do /trocar).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.telegram_links (
  chat_id        BIGINT      NOT NULL,
  workspace_id   TEXT        NOT NULL,
  is_active      BOOLEAN     NOT NULL DEFAULT true,
  linked_at      BIGINT      NOT NULL,
  unlinked_at    BIGINT,
  PRIMARY KEY (chat_id, workspace_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS telegram_links_one_active_per_chat
  ON public.telegram_links (chat_id)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS telegram_links_workspace
  ON public.telegram_links (workspace_id)
  WHERE is_active = true;

ALTER TABLE public.telegram_links ENABLE ROW LEVEL SECURITY;

-- INSERT é feito pelo worker via service_role_key (bypassa RLS)
CREATE POLICY "telegram_links: SELECT próprio workspace"
  ON public.telegram_links FOR SELECT
  USING (workspace_id = public.get_my_workspace_id());

CREATE POLICY "telegram_links: UPDATE próprio workspace"
  ON public.telegram_links FOR UPDATE
  USING (workspace_id = public.get_my_workspace_id())
  WITH CHECK (workspace_id = public.get_my_workspace_id());


-- ============================================================
-- 9. TABELA: print_cache
--    Cache de SHA-256 de imagens já processadas.
--    Hit antes de chamar Claude = zero custo de OCR redundante.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.print_cache (
  image_hash         TEXT    NOT NULL,    -- SHA-256 hex
  workspace_id       TEXT    NOT NULL,
  lead_id            TEXT,                -- NULL = OCR falhou
  extracted_username TEXT,
  processed_at       BIGINT  NOT NULL,
  PRIMARY KEY (image_hash, workspace_id)
);

CREATE INDEX IF NOT EXISTS print_cache_workspace_processed_at
  ON public.print_cache (workspace_id, processed_at DESC);

ALTER TABLE public.print_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "print_cache: SELECT próprio workspace"
  ON public.print_cache FOR SELECT
  USING (workspace_id = public.get_my_workspace_id());


-- ============================================================
-- 10. TABELA: telegram_invites  (PREPARADA — não usada na fase 1)
--
--    Hoje (ambiente controlado, ~10 clientes) o link de start é
--    direto t.me/IgnisCRM_bot?start=ws_<workspace_id>.
--
--    Quando virar ambiente menos controlado, ativa essa tabela:
--    frontend gera token UUID descartável com TTL de 15 min, bot
--    consome e marca consumed_at.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.telegram_invites (
  token         UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  TEXT    NOT NULL,
  expires_at    BIGINT  NOT NULL,
  consumed_at   BIGINT,
  created_at    BIGINT  NOT NULL
);

CREATE INDEX IF NOT EXISTS telegram_invites_workspace
  ON public.telegram_invites (workspace_id);

ALTER TABLE public.telegram_invites ENABLE ROW LEVEL SECURITY;

CREATE POLICY "telegram_invites: SELECT próprio workspace"
  ON public.telegram_invites FOR SELECT
  USING (workspace_id = public.get_my_workspace_id());

CREATE POLICY "telegram_invites: INSERT próprio workspace"
  ON public.telegram_invites FOR INSERT
  WITH CHECK (workspace_id = public.get_my_workspace_id());


-- ============================================================
-- 11. STORAGE BUCKET: print_review
--    Imagens de leads needs_review=true ficam aqui pra preview.
--    Path: {workspace_id}/{lead_id}.{ext}
-- ============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'print_review',
  'print_review',
  false,
  10485760,
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'print_review: SELECT próprio workspace'
  ) THEN
    CREATE POLICY "print_review: SELECT próprio workspace"
      ON storage.objects FOR SELECT
      USING (
        bucket_id = 'print_review'
        AND (storage.foldername(name))[1] = public.get_my_workspace_id()
      );
  END IF;
END $$;


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
-- Tabelas (8):
--   user_workspaces    — mapeamento auth.uid() → workspace_id
--   leads              — leads do CRM com soft delete, CTA e flag de revisão
--   tasks              — tarefas vinculadas a leads
--   activity_events    — log de eventos (era "events" no Dexie)
--   daily_metrics      — métricas diárias por board
--   telegram_links     — vínculo chat_id ↔ workspace (bot Telegram)
--   print_cache        — hash SHA-256 de prints já processados (anti-duplicata)
--   telegram_invites   — preparada pra futuro (tokens descartáveis)
--
-- Storage:
--   bucket "print_review" — imagens de leads needs_review=true
--
-- Índices (~22):
--   Espelham todos os índices compostos do Dexie v5.
--   Índice GIN em leads.tags para busca em arrays.
--   Índice parcial leads.needs_review pra fila de revisão do SDR.
--
-- RLS ativado em todas as tabelas + bucket Storage.
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
