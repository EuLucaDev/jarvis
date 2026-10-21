"""Chat por texto do painel: mesmo Jarvis, mesmas ferramentas, modelo de texto gratuito."""

import asyncio
import logging
from typing import Any

from google.genai import types

from . import llm, tools
from .config import settings
from .hub import hub
from .live import system_prompt

log = logging.getLogger("jarvis.chat")


async def reply(history: list[dict[str, str]], text: str) -> dict[str, Any]:
    client = llm.client()
    if not client:
        return {"resposta": "Falta a chave GEMINI_API_KEY no .env.", "ferramentas": []}
    contents: list[types.Content] = [
        types.Content(role="user" if h["papel"] == "usuario" else "model", parts=[types.Part(text=h["texto"])])
        for h in history[-12:]
    ]
    contents.append(types.Content(role="user", parts=[types.Part(text=text)]))
    config = types.GenerateContentConfig(
        system_instruction=system_prompt() + "\nVocê está no chat por texto do painel: pode usar listas curtas e markdown simples.",
        tools=[types.Tool(function_declarations=tools.TOOLS[-1].function_declarations)],
        automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
    )
    used: list[str] = []
    for model in (settings.text_model, llm.FALLBACK):
        try:
            for _ in range(6):
                r = await client.aio.models.generate_content(model=model, contents=contents, config=config)
                calls = r.function_calls or []
                if not calls:
                    return {"resposta": r.text or "", "ferramentas": used}
                contents.append(r.candidates[0].content)
                parts = []
                for fc in calls:
                    used.append(fc.name)
                    res = await tools.run(fc.name, dict(fc.args or {}))
                    res.pop("_imagem", None)
                    parts.append(types.Part.from_function_response(name=fc.name, response=res))
                if hub.pending_sequence:
                    asyncio.create_task(hub.play_sequence(wps=3.3))
                contents.append(types.Content(role="user", parts=parts))
            return {"resposta": "Parei depois de muitas ferramentas seguidas. Pode reformular?", "ferramentas": used}
        except Exception as exc:  # noqa: BLE001
            log.warning("chat com %s falhou: %s", model, str(exc)[:160])
    return {"resposta": "Os modelos de texto estão indisponíveis agora. Tente de novo em instantes.", "ferramentas": used}
