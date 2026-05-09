"""
OCR de prints do Instagram via Claude.

Estratégia em camadas pra economizar tokens sem perder leads:
  1. Tenta com Haiku 4.5 (~5x mais barato que Sonnet)
  2. Se username/link voltar com 'OBS:' → escala pra Sonnet 4.6
  3. Se Sonnet também marcar 'OBS:' → retorna confidence='low'
     (worker grava lead com needs_review=true pra revisão manual)

Anti-alucinação: o prompt instrui o modelo a ser SCANNER ÓPTICO —
proibido corrigir grafia, autocompletar ou deduzir caracteres cobertos.
Esse é o aprendizado central do projeto: LLMs têm viés de "consertar"
texto que parece ortograficamente errado.
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
from dataclasses import dataclass
from typing import Literal, Optional

import anthropic

from config import ANTHROPIC_API_KEY, MODEL_FALLBACK, MODEL_PRIMARY

log = logging.getLogger(__name__)

_client = anthropic.AsyncAnthropic(api_key=ANTHROPIC_API_KEY)

PROMPT = """Você é um SCANNER ÓPTICO de prints do Instagram. Sua única função é EXTRAIR TEXTO EXATAMENTE como aparece na imagem. Você NÃO é editor, NÃO corrige grafia, NÃO autocompleta, NÃO deduz.

Analise a imagem e retorne APENAS um JSON válido (sem markdown, sem texto adicional, sem ```json).

CASO 1 — É um perfil do Instagram (tela de perfil ou cabeçalho de DM com username visível):
{
  "valid": true,
  "username": "username_exato_sem_arroba",
  "nome": "Nome de exibição como aparece",
  "bio": "Texto da bio completo",
  "seguidores": "valor como aparece na tela (ex: 1.234 ou 12K)",
  "seguindo": "valor como aparece na tela"
}

CASO 2 — NÃO é um perfil do Instagram (foto de paisagem, conversa de WhatsApp, screenshot da timeline/feed, story, reel, etc.):
{
  "valid": false,
  "reason": "descrição curta do que você vê na imagem"
}

REGRAS DE EXTRAÇÃO VERBATIM (zero exceções):
1. Copie cada caractere EXATAMENTE como aparece, letra por letra.
2. PROIBIDO corrigir grafia. Se a imagem mostra "monilenogueira", retorne "monilenogueira" — NUNCA "monicanogueira" nem qualquer variação.
3. PROIBIDO autocompletar caracteres parcialmente cobertos, cortados ou borrados.
4. PROIBIDO interpretar. Você é scanner óptico, não editor de texto.
5. Se houver QUALQUER dúvida sobre um caractere do USERNAME (ou nome/bio): prefixe o valor com "OBS: " e descreva a dúvida em poucas palavras.
   Exemplo: "OBS: caractere coberto entre 'mon' e 'lenogueira'"
6. Campos não visíveis no print devem ter valor "" (string vazia).
7. NÃO inclua "@" no campo username.
8. Retorne SOMENTE o JSON. Sem markdown. Sem ```json. Sem comentário."""


Confidence = Literal["high", "low", "invalid"]


@dataclass
class OCRResult:
    valid: bool
    confidence: Confidence
    username: Optional[str]
    display_name: Optional[str]
    bio: Optional[str]
    followers: Optional[str]
    following: Optional[str]
    obs: Optional[str]          # mensagem do OBS quando confidence='low'
    reason: Optional[str]       # por que valid=false
    model_used: str             # 'haiku' ou 'sonnet' (qual deu a resposta final)
    raw_response: str           # JSON cru do modelo (debug)


def _has_obs(value: Optional[str]) -> bool:
    return bool(value) and isinstance(value, str) and value.strip().upper().startswith("OBS:")


async def _call_model(model: str, image_b64: str, media_type: str) -> dict:
    """Chama Claude com retry exponencial em erros transitórios."""
    last_err: Optional[Exception] = None
    for attempt, delay in enumerate([0, 1, 4, 16]):
        if delay:
            await asyncio.sleep(delay)
        try:
            msg = await _client.messages.create(
                model=model,
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
                                    "data": image_b64,
                                },
                            },
                            {"type": "text", "text": PROMPT},
                        ],
                    }
                ],
            )
            raw = msg.content[0].text.strip()
            if raw.startswith("```"):
                raw = raw.split("\n", 1)[1].rsplit("```", 1)[0].strip()
            return {"parsed": json.loads(raw), "raw": raw}
        except (anthropic.APIConnectionError, anthropic.APIStatusError) as e:
            last_err = e
            log.warning("Anthropic erro transitório (tentativa %d): %s", attempt + 1, e)
            continue
        except json.JSONDecodeError as e:
            last_err = e
            log.warning("JSON inválido do modelo %s: %r", model, raw)
            continue
        except Exception as e:
            last_err = e
            log.exception("Erro inesperado chamando %s", model)
            break
    raise RuntimeError(f"Falha ao chamar Anthropic após retries: {last_err}")


def _result_from_parsed(parsed: dict, raw: str, model_short: str) -> OCRResult:
    if not parsed.get("valid"):
        return OCRResult(
            valid=False,
            confidence="invalid",
            username=None, display_name=None, bio=None,
            followers=None, following=None, obs=None,
            reason=str(parsed.get("reason") or "imagem não é perfil do Instagram"),
            model_used=model_short,
            raw_response=raw,
        )

    username = (parsed.get("username") or "").strip()
    has_obs = _has_obs(username)
    obs_text = username if has_obs else None

    return OCRResult(
        valid=True,
        confidence="low" if has_obs else "high",
        username=username,
        display_name=(parsed.get("nome") or "").strip() or None,
        bio=(parsed.get("bio") or "").strip() or None,
        followers=(parsed.get("seguidores") or "").strip() or None,
        following=(parsed.get("seguindo") or "").strip() or None,
        obs=obs_text,
        reason=None,
        model_used=model_short,
        raw_response=raw,
    )


async def extract(image_bytes: bytes, media_type: str = "image/jpeg") -> OCRResult:
    """
    Extrai dados do print do Instagram com fallback Haiku → Sonnet.

    Caminho feliz (~95%): só chama Haiku, custo ~$0.0015.
    Caminho de fallback (~5%): Haiku + Sonnet, custo ~$0.0095.
    Pior caso: ambos retornam OBS → grava lead com needs_review=true.
    """
    image_b64 = base64.standard_b64encode(image_bytes).decode("utf-8")

    # Camada 1 — Haiku
    haiku = await _call_model(MODEL_PRIMARY, image_b64, media_type)
    haiku_result = _result_from_parsed(haiku["parsed"], haiku["raw"], "haiku")

    if not haiku_result.valid:
        return haiku_result

    if haiku_result.confidence == "high":
        return haiku_result

    # Camada 2 — Haiku marcou OBS no username → escala pra Sonnet
    log.info("Haiku marcou OBS, escalando pra Sonnet: %s", haiku_result.obs)
    sonnet = await _call_model(MODEL_FALLBACK, image_b64, media_type)
    sonnet_result = _result_from_parsed(sonnet["parsed"], sonnet["raw"], "sonnet")

    return sonnet_result
