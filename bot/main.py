"""
IGNIS BOT - CRM
Worker do Telegram que recebe prints do Instagram e cria leads no Supabase.

Fluxo:
  1. Cliente manda print → bot baixa imagem
  2. Calcula SHA-256 → cache lookup (zero custo se duplicata)
  3. Chama Claude Haiku 4.5 (fallback Sonnet 4.6)
  4. upsert_lead no Supabase (idempotente, soft-restore)
  5. Sobe imagem pro Storage SE needs_review
  6. Responde resumo no chat

Comandos:
  /start <ws_id>   — vincula chat ao workspace via deep-link
  /trocar          — admin: alterna entre workspaces vinculados
  /atual           — mostra qual workspace tá ativo agora
  /desconectar     — remove vínculo ativo
  /ajuda /status   — info
"""
from __future__ import annotations

import asyncio
import logging
import time
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Optional

from aiogram import Bot, Dispatcher, F
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.filters import Command, CommandObject, CommandStart
from aiogram.types import (
    CallbackQuery,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    Message,
)

import db
from config import (
    MAX_CONCURRENT_OCR_PER_CHAT,
    TELEGRAM_BOT_TOKEN,
)
from ocr import OCRResult, extract

log = logging.getLogger("ignis-bot")


# ─── Estado em memória ───────────────────────────────────────────────
# Para 10 clientes não precisa de Redis — dict é suficiente. Se cair,
# a única perda é o "buffer de álbum em curso" — Telegram redelivera.

_chat_semaphores: dict[int, asyncio.Semaphore] = {}


def _semaphore_for(chat_id: int) -> asyncio.Semaphore:
    if chat_id not in _chat_semaphores:
        _chat_semaphores[chat_id] = asyncio.Semaphore(MAX_CONCURRENT_OCR_PER_CHAT)
    return _chat_semaphores[chat_id]


@dataclass
class AlbumBuffer:
    """Buffer para agrupar fotos enviadas como álbum (media_group)."""
    chat_id: int
    messages: list[Message] = field(default_factory=list)
    timer_task: Optional[asyncio.Task] = None
    processing: bool = False


# media_group_id → buffer
_album_buffers: dict[str, AlbumBuffer] = {}
_album_lock = asyncio.Lock()


# ─── Bot setup ────────────────────────────────────────────────────────

bot = Bot(
    token=TELEGRAM_BOT_TOKEN,
    default=DefaultBotProperties(parse_mode=ParseMode.HTML),
)
dp = Dispatcher()


# ─── Comandos ─────────────────────────────────────────────────────────

@dp.message(CommandStart(deep_link=True))
async def on_start_with_arg(message: Message, command: CommandObject) -> None:
    """Vínculo via deep-link: t.me/IgnisCRM_bot?start=ws_<workspace_id>"""
    raw_arg = (command.args or "").strip()
    workspace_id = raw_arg[3:] if raw_arg.startswith("ws_") else raw_arg

    if not workspace_id:
        await message.answer(
            "❌ Link de vinculação inválido. Pede um novo no painel do CRM "
            "(botão 'Conectar Telegram')."
        )
        return

    chat_id = message.chat.id

    if not await db.workspace_exists(workspace_id):
        await message.answer(
            "❌ Workspace não encontrado. Esse link aponta pra um cadastro "
            "que não existe mais. Pede outro no CRM."
        )
        return

    await db.link_workspace(chat_id, workspace_id)
    name = await db.get_workspace_name(workspace_id) or workspace_id[:8]

    await message.answer(
        f"✅ <b>Conectado ao workspace '{name}'!</b>\n\n"
        "Manda os prints do Instagram aqui que eu transformo em lead automaticamente.\n\n"
        "💡 <b>Dica de qualidade:</b> pra OCR perfeito, manda como <b>arquivo</b> "
        "(clipe 📎 → arquivo → escolhe o print). Senão o Telegram comprime e pode "
        "afetar leitura de username em fonte pequena.\n\n"
        "Comandos: /atual /trocar /desconectar /ajuda"
    )


@dp.message(CommandStart())
async def on_start_no_arg(message: Message) -> None:
    chat_id = message.chat.id
    workspace_id = await db.get_active_workspace(chat_id)
    if workspace_id:
        name = await db.get_workspace_name(workspace_id) or workspace_id[:8]
        await message.answer(
            f"👋 Você já tá conectado ao workspace <b>'{name}'</b>.\n\n"
            "Manda os prints à vontade.\n\n"
            "Comandos: /atual /trocar /desconectar /ajuda"
        )
    else:
        await message.answer(
            "👋 Olá! Pra começar, abre o CRM, clica em <b>'Conectar Telegram'</b> "
            "e me manda o link mágico que aparece lá."
        )


@dp.message(Command("atual"))
async def on_atual(message: Message) -> None:
    workspace_id = await db.get_active_workspace(message.chat.id)
    if not workspace_id:
        await message.answer("⛓️‍💥 Nenhum workspace conectado. Use /start com o link do CRM.")
        return
    name = await db.get_workspace_name(workspace_id) or workspace_id[:8]
    await message.answer(f"📍 Atual: <b>{name}</b>")


@dp.message(Command("trocar"))
async def on_trocar(message: Message) -> None:
    chat_id = message.chat.id
    links = await db.list_linked_workspaces(chat_id)

    if not links:
        await message.answer("⛓️‍💥 Você não tem nenhum workspace vinculado. Use /start com o link do CRM.")
        return

    if len(links) == 1:
        ws_id = links[0]["workspace_id"]
        name = await db.get_workspace_name(ws_id) or ws_id[:8]
        await message.answer(
            f"📍 Você só tem 1 workspace vinculado: <b>{name}</b>.\n"
            "Pra adicionar outro, abre o CRM dele e usa /start com o link."
        )
        return

    # Monta keyboard inline
    buttons: list[list[InlineKeyboardButton]] = []
    for link in links:
        ws_id = link["workspace_id"]
        name = await db.get_workspace_name(ws_id) or ws_id[:8]
        prefix = "🟢 " if link["is_active"] else "⚪ "
        buttons.append(
            [InlineKeyboardButton(text=f"{prefix}{name}", callback_data=f"sw:{ws_id}")]
        )
    kb = InlineKeyboardMarkup(inline_keyboard=buttons)
    await message.answer("Escolhe o workspace ativo:", reply_markup=kb)


@dp.callback_query(F.data.startswith("sw:"))
async def on_switch_callback(cb: CallbackQuery) -> None:
    workspace_id = cb.data[3:] if cb.data else ""
    chat_id = cb.from_user.id

    if not workspace_id or not await db.workspace_exists(workspace_id):
        await cb.answer("Workspace inválido", show_alert=True)
        return

    await db.link_workspace(chat_id, workspace_id)
    name = await db.get_workspace_name(workspace_id) or workspace_id[:8]
    await cb.answer(f"✓ Agora enviando pra '{name}'")
    if cb.message:
        await cb.message.edit_text(f"📍 Atual: <b>{name}</b>")


@dp.message(Command("desconectar"))
async def on_desconectar(message: Message) -> None:
    workspace_id = await db.disconnect_chat(message.chat.id)
    if not workspace_id:
        await message.answer("Nada conectado. ✌️")
    else:
        name = await db.get_workspace_name(workspace_id) or workspace_id[:8]
        await message.answer(f"🔌 Desconectado de <b>'{name}'</b>.")


@dp.message(Command("ajuda"))
@dp.message(Command("help"))
async def on_ajuda(message: Message) -> None:
    await message.answer(
        "<b>IGNIS BOT - CRM</b>\n\n"
        "Manda print de perfil do Instagram que eu crio lead no CRM automaticamente.\n\n"
        "<b>Comandos:</b>\n"
        "/atual — qual workspace tá ativo\n"
        "/trocar — alterna entre workspaces vinculados\n"
        "/desconectar — desvincula o ativo\n"
        "/status — diagnóstico\n\n"
        "<b>Dicas:</b>\n"
        "• Manda como <b>arquivo</b> 📎 pra OCR perfeito (sem compressão)\n"
        "• Pode mandar álbum de até 10 prints de uma vez\n"
        "• Print que falhar OCR aparece no CRM com selo ⚠️ pra você corrigir"
    )


@dp.message(Command("status"))
async def on_status(message: Message) -> None:
    workspace_id = await db.get_active_workspace(message.chat.id)
    name = (await db.get_workspace_name(workspace_id) if workspace_id else None) or "—"
    await message.answer(
        f"<b>Status</b>\n"
        f"chat_id: <code>{message.chat.id}</code>\n"
        f"workspace ativo: <b>{name}</b>\n"
        f"workspace_id: <code>{workspace_id or '—'}</code>"
    )


# ─── Processamento de prints ─────────────────────────────────────────

@dataclass
class ProcessOutcome:
    status: str       # 'created' | 'restored' | 'exists' | 'invalid' | 'review' | 'error'
    username: Optional[str] = None
    reason: Optional[str] = None


async def _download_image(message: Message) -> tuple[bytes, str]:
    """
    Baixa a imagem maior disponível.
    Foto comum (compressed): pega a maior resolução do array `photo`.
    Documento (uncompressed): pega `document` se for image/*.
    """
    if message.photo:
        photo = message.photo[-1]  # maior resolução
        file = await bot.get_file(photo.file_id)
        buf = await bot.download_file(file.file_path)
        return buf.read(), "image/jpeg"

    if message.document and message.document.mime_type and message.document.mime_type.startswith("image/"):
        file = await bot.get_file(message.document.file_id)
        buf = await bot.download_file(file.file_path)
        return buf.read(), message.document.mime_type

    raise ValueError("Mensagem não contém imagem")


async def _process_one(
    image_bytes: bytes,
    media_type: str,
    workspace_id: str,
    chat_id: int,
) -> ProcessOutcome:
    """
    Pipeline completa pra um único print.
    Retorna ProcessOutcome — chamador agrega em resumo.
    """
    image_hash = db.sha256_hex(image_bytes)

    # Camada 1: cache de hash → zero custo
    cached = await db.cache_lookup(image_hash, workspace_id)
    if cached and cached.get("lead_id"):
        return ProcessOutcome(
            status="exists",
            username=cached.get("extracted_username"),
        )

    # Camada 2: OCR via Claude
    try:
        async with _semaphore_for(chat_id):
            result: OCRResult = await extract(image_bytes, media_type)
    except Exception as e:
        log.exception("OCR falhou")
        return ProcessOutcome(status="error", reason=f"OCR error: {e}")

    if not result.valid:
        # Não é perfil do IG — registra cache pra não tentar de novo
        await db.cache_store(image_hash, workspace_id, lead_id=None, extracted_username=None)
        return ProcessOutcome(status="invalid", reason=result.reason)

    # Camada 3: upsert_lead
    needs_review = result.confidence == "low"

    if needs_review:
        # Username é "OBS: ..." — gera placeholder único pra respeitar
        # o NOT NULL + UNIQUE + canonical CHECK do schema.
        # SDR vai corrigir via UI (Fase 3).
        placeholder = f"_revisar_{chat_id}_{int(time.time() * 1000)}"
        username_to_save = placeholder
        display_name = "(revisar OCR)"
        extraction_obs = result.obs or "OCR ambíguo"
    else:
        username_to_save = result.username or ""
        display_name = result.display_name
        extraction_obs = None

    if not username_to_save:
        return ProcessOutcome(status="error", reason="username vazio")

    try:
        upserted = await db.upsert_lead(
            workspace_id=workspace_id,
            username=username_to_save,
            display_name=display_name,
            bio=result.bio,
            followers=result.followers,
            following=result.following,
            chat_id=chat_id,
            needs_review=needs_review,
            extraction_obs=extraction_obs,
        )
    except Exception as e:
        log.exception("upsert_lead falhou")
        return ProcessOutcome(status="error", reason=f"DB error: {e}")

    lead = upserted["lead"]
    lead_id = lead["id"]

    # Pra leads needs_review, sobe a imagem pra Storage e atualiza original_print_url
    if needs_review:
        try:
            path = await db.upload_print_review(workspace_id, lead_id, image_bytes, media_type)
            # Salva path no lead (UI vai gerar signed URL)
            def _patch():
                db._client.table("leads").update({"original_print_url": path}).eq("id", lead_id).execute()
            await asyncio.to_thread(_patch)
        except Exception as e:
            log.warning("Falha ao subir imagem pra Storage (lead criado mesmo assim): %s", e)

    # Cache: grava SÓ depois do INSERT confirmado (problema 10 — sem perda)
    await db.cache_store(
        image_hash,
        workspace_id,
        lead_id=lead_id,
        extracted_username=username_to_save,
    )

    return ProcessOutcome(
        status=upserted["status"],
        username=username_to_save if not needs_review else None,
    )


# ─── Single photo / document handler ─────────────────────────────────

@dp.message(F.photo | F.document)
async def on_image(message: Message) -> None:
    # Documento que não é imagem? Ignora silenciosamente.
    if message.document and not (message.document.mime_type or "").startswith("image/"):
        return

    chat_id = message.chat.id
    workspace_id = await db.get_active_workspace(chat_id)
    if not workspace_id:
        await message.answer(
            "⛓️‍💥 Nenhum workspace conectado.\n"
            "Abre o CRM, clica em 'Conectar Telegram' e me manda o link mágico."
        )
        return

    # Álbum (media_group): agrupa antes de processar
    if message.media_group_id:
        await _enqueue_album(message, workspace_id)
        return

    # Print único
    await _process_and_reply(message, workspace_id, [message])


async def _enqueue_album(message: Message, workspace_id: str) -> None:
    group_id = message.media_group_id  # type: ignore
    async with _album_lock:
        buf = _album_buffers.get(group_id)
        if buf is None:
            buf = AlbumBuffer(chat_id=message.chat.id)
            _album_buffers[group_id] = buf
        buf.messages.append(message)
        # (Re)agenda timer: 1.5s após a última foto chegar
        if buf.timer_task and not buf.timer_task.done():
            buf.timer_task.cancel()
        buf.timer_task = asyncio.create_task(_album_drain(group_id, workspace_id))


async def _album_drain(group_id: str, workspace_id: str) -> None:
    try:
        await asyncio.sleep(1.5)
    except asyncio.CancelledError:
        return

    async with _album_lock:
        buf = _album_buffers.pop(group_id, None)
    if not buf or not buf.messages:
        return

    msgs = sorted(buf.messages, key=lambda m: m.message_id)
    first = msgs[0]
    await _process_and_reply(first, workspace_id, msgs)


async def _process_and_reply(
    reply_to: Message,
    workspace_id: str,
    messages: list[Message],
) -> None:
    """Processa N mensagens em paralelo (até semáforo) e responde resumo único."""
    chat_id = reply_to.chat.id
    n = len(messages)

    if n > 1:
        await reply_to.answer(f"📥 Recebi <b>{n} prints</b>. Processando…")

    async def _one(msg: Message) -> ProcessOutcome:
        try:
            image_bytes, media_type = await _download_image(msg)
        except Exception as e:
            log.exception("Falha ao baixar imagem")
            return ProcessOutcome(status="error", reason=str(e))
        return await _process_one(image_bytes, media_type, workspace_id, chat_id)

    outcomes = await asyncio.gather(*[_one(m) for m in messages])

    created = sum(1 for o in outcomes if o.status == "created")
    restored = sum(1 for o in outcomes if o.status == "restored")
    exists = sum(1 for o in outcomes if o.status == "exists")
    review = sum(1 for o in outcomes if o.status == "created" and o.username is None)
    invalid = sum(1 for o in outcomes if o.status == "invalid")
    errors = sum(1 for o in outcomes if o.status == "error")

    # 'review' já tá contado dentro de 'created' — não duplica no resumo
    new_count = created + restored
    review_count = review

    lines = [f"✅ <b>{new_count} {'lead salvo' if new_count == 1 else 'leads salvos'}</b> no CRM."]
    if exists:
        lines.append(f"🔁 {exists} já {'existia' if exists == 1 else 'existiam'} (não duplicou).")
    if review_count:
        lines.append(
            f"⚠️ {review_count} com OCR ambíguo — aparece{'' if review_count == 1 else 'm'} "
            f"no CRM com badge ⚠️ pra você corrigir."
        )
    if invalid:
        lines.append(f"❌ {invalid} {'imagem' if invalid == 1 else 'imagens'} não {'era' if invalid == 1 else 'eram'} perfil do Instagram.")
    if errors:
        lines.append(f"💥 {errors} {'erro técnico' if errors == 1 else 'erros técnicos'} (tenta de novo, se persistir me avisa).")

    # Pra single print bem-sucedido, mostra @username
    if n == 1 and outcomes[0].status in {"created", "restored"} and outcomes[0].username:
        lines = [f"✅ <b>@{outcomes[0].username}</b> salvo em LEADS_NOVOS."]
        if outcomes[0].status == "restored":
            lines[0] = f"♻️ <b>@{outcomes[0].username}</b> restaurado em LEADS_NOVOS."
    elif n == 1 and outcomes[0].status == "exists" and outcomes[0].username:
        lines = [f"🔁 <b>@{outcomes[0].username}</b> já existia (não duplicou)."]
    elif n == 1 and outcomes[0].status == "invalid":
        lines = [f"❌ Não identifiquei perfil do Instagram nessa imagem."]
        if outcomes[0].reason:
            lines.append(f"<i>({outcomes[0].reason})</i>")

    await reply_to.answer("\n".join(lines))


# ─── Entry point ─────────────────────────────────────────────────────

async def main() -> None:
    log.info("IGNIS BOT iniciando…")
    log.info("Modelos: primary=%s, fallback=%s", "claude-haiku-4-5-20251001", "claude-sonnet-4-6")
    me = await bot.get_me()
    log.info("Bot conectado: @%s (id=%s)", me.username, me.id)
    await dp.start_polling(bot, allowed_updates=dp.resolve_used_update_types())


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except (KeyboardInterrupt, SystemExit):
        log.info("Encerrando.")
