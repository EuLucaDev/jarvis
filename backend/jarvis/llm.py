"""Chamadas ao modelo de texto (grátis) com reserva quando o principal está sobrecarregado."""

import json
import logging
from typing import Any

from google import genai
from google.genai import types

from .config import settings

log = logging.getLogger("jarvis.llm")
FALLBACK = "gemini-3.5-flash-lite"

_client = genai.Client(api_key=settings.gemini_api_key) if settings.gemini_api_key else None


def client() -> genai.Client | None:
    return _client


async def generate_json(prompt: str, schema: dict[str, Any]) -> Any:
    if not _client:
        raise RuntimeError("Sem GEMINI_API_KEY")
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
