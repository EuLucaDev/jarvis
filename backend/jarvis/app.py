"""Servidor do Jarvis: API, WebSocket de eventos/voz e o frontend compilado."""

import asyncio
import json
import logging

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .config import settings
from .demo import run_demo
from .hub import hub
from .live import VoiceBridge
from .memory import memory

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
log = logging.getLogger("jarvis")

app = FastAPI(title="J.A.R.V.I.S.")
voice: VoiceBridge | None = None  # só um navegador fica com o microfone por vez
demo_task: asyncio.Task | None = None


@app.on_event("startup")
async def startup():
    asyncio.create_task(memory.reflect_pending())


@app.get("/api/memorias")
async def memorias():
    return memory.all()


@app.delete("/api/memorias/{mid}")
async def apagar_memoria(mid: str):
    memory.delete(mid)
    return {"ok": True}


@app.get("/health")
async def health():
    return {"ok": True}


@app.get("/api/status")
async def status():
    return {
        **hub.status,
        "model": settings.live_model,
        "has_key": bool(settings.gemini_api_key),
        "screens": len(hub.clients),
        "cards": len(hub.cards),
    }


@app.post("/api/demo")
async def demo():
    global demo_task
    if demo_task and not demo_task.done():
        return JSONResponse({"ok": False, "erro": "Demonstração já em andamento."}, status_code=409)
    demo_task = asyncio.create_task(run_demo())
    return {"ok": True}


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    global voice
    await ws.accept()
    await hub.join(ws, {"role": ws.query_params.get("role", "screen")})
    mine: VoiceBridge | None = None
    try:
        while True:
            msg = await ws.receive()
            if msg.get("type") == "websocket.disconnect":
                break
            if msg.get("bytes") is not None:
                if mine:
                    await mine.send_audio(msg["bytes"])
                continue
            data = json.loads(msg.get("text") or "{}")
            kind = data.get("type")
            if kind == "voice.start":
                if voice and voice is not mine:
                    await voice.stop()
                mine = voice = mine or VoiceBridge(ws)
                await mine.start()
            elif kind == "voice.stop" and mine:
                await mine.stop()
            elif kind == "text" and data.get("text"):
                if mine and mine.session:
                    await mine.send_text(data["text"])
            elif kind == "card.close" and data.get("id"):
                await hub.close_card(data["id"])
            elif kind == "cards.clear":
                await hub.clear_cards()
    except WebSocketDisconnect:
        pass
    finally:
        hub.leave(ws)
        if mine:
            await mine.stop()
            if voice is mine:
                voice = None


if settings.frontend_dist.exists():
    app.mount("/assets", StaticFiles(directory=settings.frontend_dist / "assets"), name="assets")

    @app.get("/{path:path}")
    async def spa(path: str):
        file = settings.frontend_dist / path
        if path and file.is_file():
            return FileResponse(file)
        return FileResponse(settings.frontend_dist / "index.html")
