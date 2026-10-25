"""Chamadas ao modelo de texto (grátis) com reserva quando o principal está sobrecarregado."""

import json
import logging
from typing import Any

from google import genai
from google.genai import types

from .config import settings

log = logging.getLogger("jarvis.llm")
FALLBACK = "gemini-3.5-flash-lite"

_cache: tuple[str, genai.Client] | None = None


def client() -> genai.Client | None:
    """Cliente da Gemini com a chave atual (a configuração inicial pode trocá-la com tudo rodando)."""
    global _cache
    key = settings.gemini_api_key
    if not key:
        return None
    if not _cache or _cache[0] != key:
        _cache = (key, genai.Client(api_key=key))
    return _cache[1]


async def generate_json(prompt: str, schema: dict[str, Any]) -> Any:
    _client = client()
    if not _client:
        raise RuntimeError("Sem a chave da Gemini (configuração inicial)")
    last: Exception | None = None
    for model in (settings.text_model, FALLBACK):
        try:
            r = await _client.aio.models.generate_content(
                model=model,
                contents=prompt,
                config=types.GenerateContentConfig(response_mime_type="application/json", response_schema=schema),
            )
            return json.loads(r.text or "null")
        except Exception as exc:  # noqa: BLE001
            last = exc
            log.warning("%s falhou: %s", model, str(exc)[:160])
    raise RuntimeError(f"Modelos de texto indisponíveis: {last}")
