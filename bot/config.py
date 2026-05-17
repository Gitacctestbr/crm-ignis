"""Carrega e valida variáveis de ambiente do bot."""
from __future__ import annotations

import logging
import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")


def _required(name: str) -> str:
    val = os.environ.get(name, "").strip()
    if not val:
        raise RuntimeError(
            f"Variável de ambiente obrigatória ausente: {name}\n"
            f"Copie bot/.env.example para bot/.env e preencha."
        )
    return val


TELEGRAM_BOT_TOKEN = _required("TELEGRAM_BOT_TOKEN")
ANTHROPIC_API_KEY = _required("ANTHROPIC_API_KEY")
SUPABASE_URL = _required("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = _required("SUPABASE_SERVICE_ROLE_KEY")

MODEL_PRIMARY = os.getenv("MODEL_PRIMARY", "claude-haiku-4-5-20251001").strip()
MODEL_FALLBACK = os.getenv("MODEL_FALLBACK", "claude-sonnet-4-6").strip()

MAX_CONCURRENT_OCR_GLOBAL = int(os.getenv("MAX_CONCURRENT_OCR_GLOBAL", "20"))
MAX_CONCURRENT_OCR_PER_CHAT = int(os.getenv("MAX_CONCURRENT_OCR_PER_CHAT", "3"))

LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=LOG_LEVEL,
    format="%(asctime)s  %(levelname)-7s  %(name)s  %(message)s",
    datefmt="%H:%M:%S",
)
