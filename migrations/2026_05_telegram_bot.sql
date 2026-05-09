-- ============================================================
-- 2026_05_telegram_bot.sql
-- Migração incremental — habilita o bot do Telegram como porta de
-- entrada de leads (substitui o sync via Google Sheets).
--
-- COMO RODAR:
--   1. Abra o painel do Supabase → SQL Editor → New query
--   2. Cole TODO o conteúdo deste arquivo
--   3. Aperte "Run"
--
-- IDEMPOTENTE: pode rodar várias vezes sem erro.
-- REVERSÍVEL: bloco final (comentado) tem o "drop" de tudo.
-- ============================================================


-- ============================================================
-- 1. Coluna workspace_name em user_workspaces
--    Nome humano do workspace (ex: "Studio Beauty VT") — usado pelo
--    bot pra confirmar vinculação ("✓ Conectado a 'Studio Beauty VT'").
-- ============================================================

ALTER TABLE public.user_workspaces
  ADD COLUMN IF NOT EXISTS workspace_name TEXT;


-- ============================================================
-- 2. Colunas novas em leads
--
--    needs_review        — lead com OCR ambíguo. UI mostra badge ⚠️.
--    created_by_chat_id  — qual chat do Telegram capturou esse lead.
--    original_print_url  — URL da imagem original (Supabase Storage)
--                          quando needs_review=true. Preview pra SDR
--                          corrigir manualmente.
--    extraction_obs      — texto da observação do OCR ("OBS: nome
--                          parcialmente coberto"). Mostrado ao SDR.
-- ============================================================

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS needs_review        BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS created_by_chat_id  BIGINT,
  ADD COLUMN IF NOT EXISTS original_print_url  TEXT,
  ADD COLUMN IF NOT EXISTS extraction_obs      TEXT;

-- Índice parcial: SDR consulta "leads pra revisar" frequentemente.
CREATE INDEX IF NOT EXISTS leads_workspace_needs_review
  ON public.leads (workspace_id, updated_at DESC)
  WHERE needs_review = true AND deleted_at IS NULL;


-- ============================================================
-- 3. Tabela: telegram_links
--    Vinculação entre chat_id do Telegram e workspace_id do CRM.
--
--    1 chat_id pode ter N linhas (admin Gustavo é SDR de vários
--    clientes), mas só 1 pode ter is_active=true por vez.
--
--    Quando o cliente troca de celular, marcamos a antiga is_active=false
--    e criamos uma nova — preserva histórico/auditoria.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.telegram_links (
  chat_id        BIGINT      NOT NULL,
  workspace_id   TEXT        NOT NULL,
  is_active      BOOLEAN     NOT NULL DEFAULT true,
  linked_at      BIGINT      NOT NULL,
  unlinked_at    BIGINT,
  -- chat_id+workspace_id é a identidade lógica
  PRIMARY KEY (chat_id, workspace_id)
);

-- Garante: máximo 1 vínculo ativo por chat_id (regra do /trocar)
CREATE UNIQUE INDEX IF NOT EXISTS telegram_links_one_active_per_chat
  ON public.telegram_links (chat_id)
  WHERE is_active = true;

-- Lookup reverso: dado um workspace, listar chat_ids vinculados
CREATE INDEX IF NOT EXISTS telegram_links_workspace
  ON public.telegram_links (workspace_id)
  WHERE is_active = true;

ALTER TABLE public.telegram_links ENABLE ROW LEVEL SECURITY;

-- Policies: usuário lê/atualiza só vínculos do próprio workspace.
-- INSERT é feito pelo worker via service_role_key (bypass RLS).
CREATE POLICY "telegram_links: SELECT próprio workspace"
  ON public.telegram_links FOR SELECT
  USING (workspace_id = public.get_my_workspace_id());

CREATE POLICY "telegram_links: UPDATE próprio workspace"
  ON public.telegram_links FOR UPDATE
  USING (workspace_id = public.get_my_workspace_id())
  WITH CHECK (workspace_id = public.get_my_workspace_id());


-- ============================================================
-- 4. Tabela: print_cache
--    Cache de hash SHA-256 das imagens já processadas.
--    Antes de chamar Claude, o worker checa se o hash já foi processado.
--    Hit = zero custo, bot responde "já processado: @fulano".
--
--    Composto: mesmo print pode ser válido em workspaces diferentes
--    (raríssimo, mas preserva isolamento).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.print_cache (
  image_hash         TEXT    NOT NULL,    -- SHA-256 hex (64 chars)
  workspace_id       TEXT    NOT NULL,
  lead_id            TEXT,                -- NULL = OCR falhou; preenchido = lead criado
  extracted_username TEXT,                -- pra responder rápido sem nova chamada Claude
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
-- 5. Tabela: telegram_invites  (DESABILITADA — preparada pra futuro)
--
--    Hoje (fase 1, ambiente controlado, ~10 clientes), o link de
--    vinculação é direto: t.me/IgnisCRM_bot?start=ws_<workspace_id>
--    Risco de vazamento mitigado por confiança no canal de entrega.
--
--    Quando virar ambiente menos controlado, esta tabela permite
--    gerar tokens descartáveis com TTL de 15 min.
--
--    Pra ativar no futuro: o frontend gera um row aqui ao clicar
--    "Conectar Telegram" e o link vira t.me/IgnisCRM_bot?start=<token>
--    O bot consome o token, marca consumed_at, e cria a vinculação.
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
-- 6. Storage bucket: print_review
--    Imagens de leads que falharam OCR ficam aqui pra UI exibir
--    como preview. Convenção de path: {workspace_id}/{lead_id}.{ext}
--
--    Bucket privado: leitura só pelo dono do workspace via signed URL.
-- ============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'print_review',
  'print_review',
  false,
  10485760,  -- 10 MB
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;

-- Policy: usuário lê só imagens do próprio workspace
-- (path tem que começar com workspace_id/, ex: "abc-123/lead_xyz.jpg")
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
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
-- VERIFICAÇÃO PÓS-MIGRAÇÃO
-- Cole isto separado depois de rodar o SQL acima pra conferir:
-- ============================================================
--
--   SELECT column_name, data_type
--   FROM information_schema.columns
--   WHERE table_schema='public' AND table_name='leads'
--     AND column_name IN ('needs_review','created_by_chat_id','original_print_url','extraction_obs');
--
--   SELECT table_name FROM information_schema.tables
--   WHERE table_schema='public'
--     AND table_name IN ('telegram_links','print_cache','telegram_invites');
--
--   SELECT id FROM storage.buckets WHERE id='print_review';
--
-- Esperado: 4 linhas + 3 linhas + 1 linha. Se faltou alguma, alguma
-- parte falhou silenciosamente — me avisa pra investigar.


-- ============================================================
-- ROLLBACK (descomente o bloco abaixo SE precisar desfazer)
-- ============================================================
--
-- DROP POLICY IF EXISTS "print_review: SELECT próprio workspace" ON storage.objects;
-- DELETE FROM storage.buckets WHERE id = 'print_review';
--
-- DROP TABLE IF EXISTS public.telegram_invites CASCADE;
-- DROP TABLE IF EXISTS public.print_cache       CASCADE;
-- DROP TABLE IF EXISTS public.telegram_links    CASCADE;
--
-- DROP INDEX IF EXISTS public.leads_workspace_needs_review;
-- ALTER TABLE public.leads
--   DROP COLUMN IF EXISTS extraction_obs,
--   DROP COLUMN IF EXISTS original_print_url,
--   DROP COLUMN IF EXISTS created_by_chat_id,
--   DROP COLUMN IF EXISTS needs_review;
--
-- ALTER TABLE public.user_workspaces DROP COLUMN IF EXISTS workspace_name;
