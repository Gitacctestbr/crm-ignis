"""
Camada de acesso ao Supabase via service_role_key.

⚠️ service_role BYPASSA RLS. Pra compensar, este módulo SEMPRE
inclui workspace_id explicitamente em INSERTs e filtra por
workspace_id em SELECTs/UPDATEs. Se um bug fizer escrever no
workspace errado, RLS não vai te salvar.

A lib supabase-py é síncrona — envelopamos em asyncio.to_thread
pra não bloquear o event loop do aiogram.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import time
import uuid
from typing import Optional

from supabase import Client, create_client

from config import SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL

log = logging.getLogger(__name__)

_client: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)


def _now_ms() -> int:
    return int(time.time() * 1000)


def _today_int() -> int:
    """yyyymmdd como int — bate com toDayKey() do TS."""
    t = time.localtime()
    return t.tm_year * 10000 + t.tm_mon * 100 + t.tm_mday


def canonical_username(u: str) -> str:
    """Espelha leadsRepo.canonicalUsername — fonte única de verdade."""
    return (u or "").strip().lstrip("@").lower()


def sha256_hex(image_bytes: bytes) -> str:
    return hashlib.sha256(image_bytes).hexdigest()


# ─── telegram_links ──────────────────────────────────────────────────

async def get_active_workspace(chat_id: int) -> Optional[str]:
    """Retorna workspace_id ativo pra esse chat, ou None se não vinculado."""
    def _q():
        return (
            _client.table("telegram_links")
            .select("workspace_id")
            .eq("chat_id", chat_id)
            .eq("is_active", True)
            .limit(1)
            .execute()
        )
    res = await asyncio.to_thread(_q)
    rows = res.data or []
    return rows[0]["workspace_id"] if rows else None


async def list_linked_workspaces(chat_id: int) -> list[dict]:
    """
    Lista todos os workspaces que esse chat já vinculou
    (ativos E inativos não-desconectados).
    """
    def _q():
        return (
            _client.table("telegram_links")
            .select("workspace_id, is_active, linked_at")
            .eq("chat_id", chat_id)
            .is_("unlinked_at", "null")
            .order("linked_at", desc=True)
            .execute()
        )
    res = await asyncio.to_thread(_q)
    return res.data or []


async def link_workspace(chat_id: int, workspace_id: str) -> None:
    """
    Vincula chat_id a workspace_id e marca como ativo.
    Desativa quaisquer outros vínculos ativos do mesmo chat (regra do /trocar).
    Idempotente: se já vinculou esse workspace, só reativa.
    """
    def _do():
        # Desativa todos os outros ativos desse chat
        _client.table("telegram_links").update({"is_active": False}).eq(
            "chat_id", chat_id
        ).eq("is_active", True).execute()

        # Upsert do novo vínculo
        _client.table("telegram_links").upsert(
            {
                "chat_id": chat_id,
                "workspace_id": workspace_id,
                "is_active": True,
                "linked_at": _now_ms(),
                "unlinked_at": None,
            },
            on_conflict="chat_id,workspace_id",
        ).execute()
    await asyncio.to_thread(_do)


async def disconnect_chat(chat_id: int) -> Optional[str]:
    """
    Desconecta o vínculo ativo desse chat.
    Retorna o workspace_id desconectado, ou None se não tinha.
    """
    workspace_id = await get_active_workspace(chat_id)
    if not workspace_id:
        return None

    def _do():
        _client.table("telegram_links").update(
            {"is_active": False, "unlinked_at": _now_ms()}
        ).eq("chat_id", chat_id).eq("workspace_id", workspace_id).execute()

    await asyncio.to_thread(_do)
    return workspace_id


async def get_workspace_name(workspace_id: str) -> Optional[str]:
    def _q():
        return (
            _client.table("user_workspaces")
            .select("workspace_name")
            .eq("workspace_id", workspace_id)
            .limit(1)
            .execute()
        )
    res = await asyncio.to_thread(_q)
    rows = res.data or []
    if not rows:
        return None
    return rows[0].get("workspace_name") or None


async def workspace_exists(workspace_id: str) -> bool:
    def _q():
        return (
            _client.table("user_workspaces")
            .select("workspace_id")
            .eq("workspace_id", workspace_id)
            .limit(1)
            .execute()
        )
    res = await asyncio.to_thread(_q)
    return bool(res.data)


# ─── print_cache ─────────────────────────────────────────────────────

async def cache_lookup(image_hash: str, workspace_id: str) -> Optional[dict]:
    """Retorna {lead_id, extracted_username, processed_at} se já processado."""
    def _q():
        return (
            _client.table("print_cache")
            .select("lead_id, extracted_username, processed_at")
            .eq("image_hash", image_hash)
            .eq("workspace_id", workspace_id)
            .limit(1)
            .execute()
        )
    res = await asyncio.to_thread(_q)
    rows = res.data or []
    return rows[0] if rows else None


async def cache_store(
    image_hash: str,
    workspace_id: str,
    lead_id: Optional[str],
    extracted_username: Optional[str],
) -> None:
    def _do():
        _client.table("print_cache").upsert(
            {
                "image_hash": image_hash,
                "workspace_id": workspace_id,
                "lead_id": lead_id,
                "extracted_username": extracted_username,
                "processed_at": _now_ms(),
            },
            on_conflict="image_hash,workspace_id",
        ).execute()
    await asyncio.to_thread(_do)


# ─── leads ───────────────────────────────────────────────────────────

class AddLeadResult(dict):
    """{'status': 'created'|'exists'|'restored', 'lead': {...}}"""


async def upsert_lead(
    *,
    workspace_id: str,
    username: str,
    display_name: Optional[str] = None,
    bio: Optional[str] = None,
    followers: Optional[str] = None,
    following: Optional[str] = None,
    chat_id: Optional[int] = None,
    needs_review: bool = False,
    original_print_url: Optional[str] = None,
    extraction_obs: Optional[str] = None,
) -> AddLeadResult:
    """
    Cria lead no workspace. Idempotente por (workspace_id, username_lower).
    Restaura lead soft-deleted ao receber novo print do mesmo username.

    Retorna:
      {'status': 'created', 'lead': {...}}
      {'status': 'exists',  'lead': {...}}   (não fez nada — duplicata)
      {'status': 'restored','lead': {...}}   (estava soft-deleted, voltou)
    """
    username_lower = canonical_username(username)
    if not username_lower:
        raise ValueError("username vazio após canonical")

    now = _now_ms()

    # 2 queries são mais robustas que ordering com nullsfirst (que varia por versão)
    def _lookup_active():
        return (
            _client.table("leads")
            .select("*")
            .eq("workspace_id", workspace_id)
            .eq("username_lower", username_lower)
            .is_("deleted_at", "null")
            .limit(1)
            .execute()
        )
    res = await asyncio.to_thread(_lookup_active)
    existing = (res.data or [None])[0]

    if not existing:
        def _lookup_deleted():
            return (
                _client.table("leads")
                .select("*")
                .eq("workspace_id", workspace_id)
                .eq("username_lower", username_lower)
                .not_.is_("deleted_at", "null")
                .order("deleted_at", desc=True)
                .limit(1)
                .execute()
            )
        res2 = await asyncio.to_thread(_lookup_deleted)
        existing = (res2.data or [None])[0]

    notes_parts = []
    if bio:
        notes_parts.append(f"Bio: {bio}")
    if followers:
        notes_parts.append(f"Seguidores: {followers}")
    if following:
        notes_parts.append(f"Seguindo: {following}")
    notes = "\n".join(notes_parts)

    if existing:
        if existing.get("deleted_at"):
            # Restaurar
            patch = {
                "deleted_at": None,
                "stage_id": "LEADS_NOVOS",
                "updated_at": now,
                "last_touched_at": now,
                "needs_review": needs_review,
                "extraction_obs": extraction_obs,
            }
            if display_name and not existing.get("display_name"):
                patch["display_name"] = display_name
            if notes and not existing.get("notes"):
                patch["notes"] = notes
            if original_print_url:
                patch["original_print_url"] = original_print_url
            if chat_id and not existing.get("created_by_chat_id"):
                patch["created_by_chat_id"] = chat_id

            def _restore():
                _client.table("leads").update(patch).eq("id", existing["id"]).execute()
            await asyncio.to_thread(_restore)

            existing.update(patch)
            return AddLeadResult(status="restored", lead=existing)

        # Já existe ativo — não duplica.
        return AddLeadResult(status="exists", lead=existing)

    # Criar novo
    lead_id = str(uuid.uuid4())
    row = {
        "id": lead_id,
        "workspace_id": workspace_id,
        "board": "OUTBOUND",
        "stage_id": "LEADS_NOVOS",
        "username": username_lower,
        "username_lower": username_lower,
        "display_name": display_name or None,
        "avatar_url": None,
        "priority": "medium",
        "tags": [],
        "notes": notes,
        "created_at": now,
        "updated_at": now,
        "last_touched_at": now,
        "needs_review": needs_review,
        "created_by_chat_id": chat_id,
        "original_print_url": original_print_url,
        "extraction_obs": extraction_obs,
    }

    def _insert():
        _client.table("leads").insert(row).execute()
        # Evento CREATED — fire-and-forget
        try:
            _client.table("activity_events").insert(
                {
                    "id": str(uuid.uuid4()),
                    "workspace_id": workspace_id,
                    "lead_id": lead_id,
                    "type": "CREATED",
                    "from_stage_id": None,
                    "to_stage_id": None,
                    "at": now,
                    "day": _today_int(),
                }
            ).execute()
        except Exception as e:
            log.warning("Falha ao gravar activity_event CREATED: %s", e)

    await asyncio.to_thread(_insert)
    return AddLeadResult(status="created", lead=row)


# ─── Storage (print_review bucket) ───────────────────────────────────

async def upload_print_review(
    workspace_id: str,
    lead_id: str,
    image_bytes: bytes,
    media_type: str = "image/jpeg",
) -> str:
    """
    Sobe imagem do print original pro bucket 'print_review'.
    Path: {workspace_id}/{lead_id}.{ext}
    Retorna: path do storage (não URL — UI gera signed URL na hora de exibir).
    """
    ext = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}.get(
        media_type, "jpg"
    )
    path = f"{workspace_id}/{lead_id}.{ext}"

    def _do():
        _client.storage.from_("print_review").upload(
            path=path,
            file=image_bytes,
            file_options={"content-type": media_type, "upsert": "true"},
        )
    await asyncio.to_thread(_do)
    return path
