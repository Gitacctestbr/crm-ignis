#!/usr/bin/env python3
"""
Print Processor — Ignis CRM
Monitora uma pasta de prints do Instagram, extrai dados via Claude Haiku e salva no Google Sheets.

Configuração:
  Copie .env.example para .env na pasta scripts/ e preencha os valores.
  Execute: python print_processor.py
"""

import os
import sys
import json
import time
import shutil
import base64
import logging
import threading
from pathlib import Path
from datetime import datetime

from dotenv import load_dotenv
import anthropic
import gspread
from google.oauth2.service_account import Credentials
from watchdog.observers.polling import PollingObserver
from watchdog.events import FileSystemEventHandler, FileCreatedEvent, FileMovedEvent

# ── Carrega variáveis de ambiente do .env na mesma pasta deste script ──────────
load_dotenv(Path(__file__).parent / ".env")

# ┌─────────────────────────────────────────────────────────────────────────────┐
# │  CONFIGURAÇÃO — preencha o arquivo scripts/.env                             │
# └─────────────────────────────────────────────────────────────────────────────┘
WATCH_FOLDER             = os.getenv("WATCH_FOLDER", "")
PROCESSED_FOLDER         = os.getenv("PROCESSED_FOLDER", "")
ANTHROPIC_API_KEY        = os.getenv("ANTHROPIC_API_KEY", "")
GOOGLE_SHEETS_ID         = os.getenv("GOOGLE_SHEETS_ID", "")
GOOGLE_CREDENTIALS_PATH  = os.getenv("GOOGLE_CREDENTIALS_PATH", "")
GOOGLE_SHEET_TAB         = os.getenv("GOOGLE_SHEET_TAB", "Prints")

SUPPORTED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".gif"}

EXTRACTION_PROMPT = """Analise este print de perfil do Instagram e extraia as informações em JSON.

Retorne APENAS um objeto JSON válido, sem markdown, sem texto adicional, com esta estrutura exata:
{
  "username": "nome_do_usuario",
  "link": "https://www.instagram.com/nome_do_usuario/",
  "nome": "Nome de exibição ou nome completo",
  "bio": "Texto da bio completo",
  "seguidores": "valor como aparece na tela (ex: 1.234 ou 12K)",
  "seguindo": "valor como aparece na tela"
}

REGRAS ABSOLUTAS DE EXTRAÇÃO VERBATIM — sem exceções:
1. Copie cada caractere EXATAMENTE como aparece na imagem, letra por letra.
2. PROIBIDO corrigir grafia: se a imagem mostra "monilenogueira", retorne "monilenogueira" — não "monicanogueira" nem qualquer variação com letras diferentes.
3. PROIBIDO autocompletar: nunca deduza letras que estejam parcialmente visíveis, cobertas ou cortadas.
4. PROIBIDO interpretar: você é um scanner óptico, não um editor de texto. Copie; não corrija.
5. Se houver qualquer dúvida sobre um caractere ou o texto estiver cortado: prefixe username e link com "OBS: ".
6. Campos não visíveis no print devem ter valor "" (string vazia).
7. O campo "link" deve ser construído como https://www.instagram.com/{username}/ usando o username exato extraído (sem @).
8. Retorne SOMENTE o JSON, sem ```json ou qualquer outro marcador."""


def validate_config() -> None:
    missing = [
        name for name, val in [
            ("WATCH_FOLDER", WATCH_FOLDER),
            ("PROCESSED_FOLDER", PROCESSED_FOLDER),
            ("ANTHROPIC_API_KEY", ANTHROPIC_API_KEY),
            ("GOOGLE_SHEETS_ID", GOOGLE_SHEETS_ID),
            ("GOOGLE_CREDENTIALS_PATH", GOOGLE_CREDENTIALS_PATH),
        ]
        if not val
    ]
    if missing:
        raise EnvironmentError(
            f"Variáveis não configuradas: {', '.join(missing)}\n"
            "Copie scripts/.env.example para scripts/.env e preencha os valores."
        )
    if not Path(WATCH_FOLDER).is_dir():
        raise FileNotFoundError(f"WATCH_FOLDER não existe: {WATCH_FOLDER}")
    if not Path(GOOGLE_CREDENTIALS_PATH).is_file():
        raise FileNotFoundError(f"Credenciais não encontradas: {GOOGLE_CREDENTIALS_PATH}")


def get_sheets_client() -> gspread.Client:
    scopes = [
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/drive.file",
    ]
    creds = Credentials.from_service_account_file(GOOGLE_CREDENTIALS_PATH, scopes=scopes)
    return gspread.authorize(creds)


def extract_data_from_image(image_path: Path) -> dict:
    ext = image_path.suffix.lower()
    media_type_map = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
        ".gif": "image/gif",
    }
    media_type = media_type_map.get(ext, "image/jpeg")

    with open(image_path, "rb") as f:
        image_data = base64.standard_b64encode(f.read()).decode("utf-8")

    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
    message = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=1024,
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": media_type,
                            "data": image_data,
                        },
                    },
                    {
                        "type": "text",
                        "text": EXTRACTION_PROMPT,
                    },
                ],
            }
        ],
    )

    raw = message.content[0].text.strip()
    # Remove markdown fence caso o modelo ignore a instrução
    if raw.startswith("```"):
        raw = raw.split("\n", 1)[1].rsplit("```", 1)[0].strip()

    return json.loads(raw)


def append_to_sheets(gc: gspread.Client, data: dict) -> None:
    sheet = gc.open_by_key(GOOGLE_SHEETS_ID).worksheet(GOOGLE_SHEET_TAB)
    row = [
        data.get("link", ""),        # A — Link
        data.get("nome", ""),        # B — Nome
        data.get("bio", ""),         # C — Bio
        data.get("seguidores", ""),  # D — Seguidores
        data.get("seguindo", ""),    # E — Seguindo
    ]
    sheet.append_row(row, value_input_option="USER_ENTERED")


def move_to_processed(image_path: Path) -> Path:
    dest_dir = Path(PROCESSED_FOLDER)
    dest_dir.mkdir(parents=True, exist_ok=True)

    dest = dest_dir / image_path.name
    if dest.exists():
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        dest = dest_dir / f"{image_path.stem}_{ts}{image_path.suffix}"

    shutil.move(str(image_path), str(dest))
    return dest


def process_image(image_path: Path, gc: gspread.Client) -> None:
    logging.info(f"Processando: {image_path.name}")
    data = extract_data_from_image(image_path)
    logging.info(f"  → username: {data.get('username', '?')}  nome: {data.get('nome', '')}")
    append_to_sheets(gc, data)
    logging.info("  → Salvo na planilha")
    dest = move_to_processed(image_path)
    logging.info(f"  → Movido para: {dest.name}")


class PrintEventHandler(FileSystemEventHandler):
    def __init__(self, gc: gspread.Client) -> None:
        super().__init__()
        self.gc = gc
        self._pending: set[str] = set()

    def on_created(self, event: FileCreatedEvent) -> None:
        if not event.is_directory:
            self._maybe_schedule(Path(event.src_path))

    def on_moved(self, event: FileMovedEvent) -> None:
        # Clientes de sync (Google Drive) criam arquivo temp e renomeiam no final
        if not event.is_directory:
            self._maybe_schedule(Path(event.dest_path))

    def _maybe_schedule(self, path: Path) -> None:
        if path.suffix.lower() not in SUPPORTED_EXTENSIONS:
            return
        key = str(path)
        if key in self._pending:
            return
        self._pending.add(key)
        threading.Thread(target=self._run, args=(path, key), daemon=True).start()

    def _run(self, path: Path, key: str) -> None:
        # Aguarda 2 s para garantir que o arquivo foi completamente gravado
        time.sleep(2)
        try:
            if path.exists():
                process_image(path, self.gc)
        except json.JSONDecodeError as e:
            logging.error(f"  ✗ JSON inválido na resposta do Haiku: {e}")
        except anthropic.APIError as e:
            logging.error(f"  ✗ Erro Anthropic API: {e}")
        except gspread.exceptions.APIError as e:
            logging.error(f"  ✗ Erro Google Sheets API: {e}")
        except Exception as e:
            logging.error(f"  ✗ Erro inesperado: {e}")
        finally:
            self._pending.discard(key)


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s  %(levelname)-8s  %(message)s",
        datefmt="%H:%M:%S",
    )

    try:
        validate_config()
    except (EnvironmentError, FileNotFoundError) as e:
        logging.critical(str(e))
        sys.exit(1)

    logging.info("Conectando ao Google Sheets…")
    gc = get_sheets_client()
    logging.info(f"✓ Conectado. Planilha: {GOOGLE_SHEETS_ID}  Aba: {GOOGLE_SHEET_TAB}")

    # Processa imagens que já estavam na pasta antes do script iniciar
    watch_path = Path(WATCH_FOLDER)
    existing = sorted(
        p for p in watch_path.iterdir()
        if p.is_file() and p.suffix.lower() in SUPPORTED_EXTENSIONS
    )
    if existing:
        logging.info(f"Processando {len(existing)} imagem(ns) já existente(s)…")
        for img in existing:
            try:
                process_image(img, gc)
            except Exception as e:
                logging.error(f"Erro em {img.name}: {e}")

    handler = PrintEventHandler(gc)
    # PollingObserver é mais confiável com pastas de sync de cloud (Google Drive)
    observer = PollingObserver(timeout=5)
    observer.schedule(handler, str(watch_path), recursive=False)
    observer.start()

    logging.info(f"\n✓ Monitorando: {watch_path}")
    logging.info(f"  Formatos: {', '.join(sorted(SUPPORTED_EXTENSIONS))}")
    logging.info(f"  Processados → {PROCESSED_FOLDER}")
    logging.info("  Ctrl+C para encerrar.\n")

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        logging.info("Encerrando…")
        observer.stop()
    observer.join()


if __name__ == "__main__":
    main()
