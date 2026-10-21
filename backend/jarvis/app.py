"""Servidor do Jarvis: API do painel, WebSocket de eventos/voz e o frontend compilado."""

import asyncio
import base64
import collections
import datetime as dt
import json
import logging
import time
from typing import Any

from fastapi import Body, FastAPI, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import briefing, chat, store, system
from .config import settings
from .demo import run_demo
from .hub import hub
from .live import VoiceBridge
from .memory import TIPOS, memory, _db

# ---------- logs em memória para a página Logs ----------
LOGS: collections.deque[dict[str, Any]] = collections.deque(maxlen=400)


class _Ring(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        if record.name.startswith(("jarvis", "uvicorn.error")):
            LOGS.append({"em": time.strftime("%H:%M:%S", time.localtime(record.created)), "nivel": record.levelname, "origem": record.name, "texto": record.getMessage()[:500]})


logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
logging.getLogger().addHandler(_Ring())
for noisy in ("httpx", "primp", "google_genai.models"):
    logging.getLogger(noisy).setLevel(logging.WARNING)
log = logging.getLogger("jarvis")

app = FastAPI(title="J.A.R.V.I.S.")
voice: VoiceBridge | None = None  # só um navegador fica com o microfone por vez
demo_task: asyncio.Task | None = None
BOOT = time.time()


async def telemetry_loop() -> None:
    while True:
        if hub.count("tela") or hub.count("admin"):
            await hub.broadcast({"type": "telemetria", **await asyncio.to_thread(system.telemetry)})
        await asyncio.sleep(2)


@app.on_event("startup")
async def startup():
    asyncio.create_task(memory.reflect_pending())
    asyncio.create_task(briefing.refresh_loop())
    asyncio.create_task(telemetry_loop())
    from . import alerts

    asyncio.create_task(alerts.loop())
    log.info("Jarvis no ar em http://localhost:%s", settings.port)


# ---------- estado ----------


@app.get("/health")
async def health():
    return {"ok": True}


@app.get("/api/status")
async def status():
    return {
        **hub.status,
        "model": settings.live_model,
        "text_model": settings.text_model,
        "search": settings.search,
        "voice_name": settings.voice,
        "city": settings.city,
        "has_key": bool(settings.gemini_api_key),
        "screens": hub.count("tela"),
        "clients": len(hub.clients),
        "cards": len(hub.cards),
        "uptime_min": round((time.time() - BOOT) / 60),
        "memorias": len(memory.all()),
    }


@app.get("/api/sistema")
async def sistema():
    return await asyncio.to_thread(system.telemetry)


@app.get("/api/logs")
async def logs():
    return list(LOGS)[::-1]


@app.post("/api/demo")
async def demo():
    global demo_task
    if demo_task and not demo_task.done():
        return JSONResponse({"ok": False, "erro": "Demonstração já em andamento."}, status_code=409)
    demo_task = asyncio.create_task(run_demo())
    return {"ok": True}


# ---------- chat ----------


@app.post("/api/chat")
async def api_chat(body: dict = Body(...)):
    return await chat.reply(body.get("historico", []), body.get("texto", ""))


# ---------- briefing ----------


@app.get("/api/briefing")
async def get_briefing():
    return store.get("briefing_ultimo") or {}


@app.post("/api/briefing/gerar")
async def gerar_briefing():
    return await briefing.build(force=True)


@app.post("/api/briefing/apresentar")
async def apresentar_briefing():
    """Mostra os cartões do último briefing no HUD, sem voz (botão do painel)."""
    data = store.get("briefing_ultimo") or await briefing.build()
    await hub.clear_cards()
    _, fila = briefing.sequence(data)
    hub.pending_sequence = [(i * 4, k, d) for i, (_, k, d) in enumerate(fila)]
    asyncio.create_task(hub.play_sequence(wps=3.3))
    return {"ok": True, "cartoes": len(fila)}


# ---------- ajustes ----------

EDITABLE = {"briefing", "telas", "cameras", "atalhos", "alexa", "mercado", "presenca", "monitores", "alertas", "notas"}


@app.get("/api/ajustes/{chave}")
async def get_ajuste(chave: str):
    if chave not in EDITABLE:
        raise HTTPException(404)
    return store.masked(store.get(chave))


@app.put("/api/ajustes/{chave}")
async def put_ajuste(chave: str, valor: Any = Body(...)):
    if chave not in EDITABLE:
        raise HTTPException(404)
    store.put(chave, store.merge_secrets(valor, store.get(chave)))
    if chave == "telas":
        await hub.broadcast({"type": "telas.config", "telas": store.get("telas")})
    return store.masked(store.get(chave))


@app.post("/api/ajustes/briefing/testar")
async def testar_fontes():
    """Testa cada fonte configurada e diz o que respondeu."""
    from .sources import agenda as agenda_src
    from .sources import gmail as gmail_src

    cfg = store.get("briefing")
    out = []
    for acc in cfg.get("gmail", []):
        try:
            res = await asyncio.to_thread(gmail_src.fetch, acc, 24, 3)
            out.append({"fonte": acc["email"], "ok": True, "detalhe": f"{res['total']} não lidos nas últimas 24 h"})
        except Exception as exc:  # noqa: BLE001
            out.append({"fonte": acc.get("email"), "ok": False, "detalhe": str(exc)[:160]})
    for ag in cfg.get("agendas", []):
        try:
            evs = await agenda_src.fetch([ag], cfg.get("fuso", "America/Maceio"))
            out.append({"fonte": ag.get("nome") or "Agenda", "ok": True, "detalhe": f"{len(evs)} compromissos hoje"})
        except Exception as exc:  # noqa: BLE001
            out.append({"fonte": ag.get("nome") or "Agenda", "ok": False, "detalhe": str(exc)[:160]})
    return out


@app.get("/api/atalhos/disponiveis")
async def atalhos_disponiveis():
    return await asyncio.to_thread(system.shortcuts_available)


# ---------- saúde, notas, mensagens ----------


@app.get("/api/saude")
async def saude():
    from .sources import health

    data = store.get("saude") or {}
    return {**data, "resumo": health.summary(data) if data else {}}


@app.post("/api/saude/importar")
async def importar_saude(arquivo: UploadFile):
    from .config import ROOT
    from .sources import health

    dest = ROOT / "data" / "saude" / "exportacao"
    dest.parent.mkdir(parents=True, exist_ok=True)
    with dest.open("wb") as fh:
        while chunk := await arquivo.read(1 << 20):
            fh.write(chunk)
    try:
        data = await asyncio.to_thread(health.parse, dest)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(400, f"Não consegui ler a exportação: {exc}") from exc
    finally:
        dest.unlink(missing_ok=True)  # guarda só o resumo
    store.put("saude", data)
    return {"ok": True, "resumo": health.summary(data)}


@app.get("/api/notas/cofres")
async def cofres():
    from .sources import notes

    return {"obsidian": notes.obsidian_vaults()}


@app.get("/api/permissoes")
async def permissoes():
    import sys
    from pathlib import Path

    from .sources import imessage

    return {"mensagens": await asyncio.to_thread(imessage.has_access), "python": str(Path(sys.executable).resolve())}


@app.post("/api/reiniciar")
async def reiniciar():
    """Reinicia o serviço (necessário depois de dar permissões novas ao Python)."""
    import os
    import subprocess

    subprocess.Popen(
        ["/bin/sh", "-c", f"sleep 1; launchctl kickstart -k gui/{os.getuid()}/com.jarvis.servidor"],
        start_new_session=True,
    )
    return {"ok": True}


# ---------- alertas ----------


@app.get("/api/alertas")
async def alertas_recentes():
    from . import alerts

    return alerts.RECENT[::-1]


@app.post("/api/alertas/teste")
async def alerta_teste():
    from . import alerts

    return await alerts.notify("Teste de alerta", "Assim chega um aviso do Jarvis.", "info")


# ---------- monitores ----------


@app.get("/api/monitores")
async def monitores():
    from . import launcher

    return {"plano": await asyncio.to_thread(launcher.plan), "ajustes": store.get("monitores")}


@app.post("/api/monitores/abrir")
async def abrir_monitores(body: dict = Body(default={})):
    from . import launcher

    try:
        return {"abertas": await asyncio.to_thread(launcher.open_all, body.get("tela_cheia"))}
    except RuntimeError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.post("/api/monitores/fechar")
async def fechar_monitores():
    from . import launcher

    await asyncio.to_thread(launcher.close_all)
    return {"ok": True}


# ---------- mercado ----------


@app.get("/api/mercado")
async def mercado(periodo: str = "1mo"):
    from . import market

    return await market.quotes(None, periodo)


# ---------- rosto e presença ----------


@app.get("/api/rosto")
async def rosto():
    r = store.get("rosto")
    return {"nome": r.get("nome"), "amostras": len(r.get("descritores", [])), "descritores": r.get("descritores", [])}


@app.put("/api/rosto")
async def salvar_rosto(body: dict = Body(...)):
    descs = [d for d in body.get("descritores", []) if isinstance(d, list) and len(d) == 128]
    if not descs:
        raise HTTPException(400, "Nenhuma amostra válida.")
    r = store.get("rosto")
    r["descritores"] = (r.get("descritores", []) + descs)[-12:] if body.get("adicionar") else descs
    if body.get("nome"):
        r["nome"] = body["nome"]
    store.put("rosto", r)
    return {"ok": True, "amostras": len(r["descritores"])}


@app.delete("/api/rosto")
async def apagar_rosto():
    store.put("rosto", {**store.get("rosto"), "descritores": []})
    return {"ok": True}


def _deve_briefing() -> bool:
    p = store.get("presenca")
    hoje = dt.date.today().isoformat()
    return bool(p.get("briefing_auto")) and p.get("ultimo_briefing") != hoje and 5 <= dt.datetime.now().hour < 12


@app.get("/api/presenca")
async def presenca():
    return {"briefing": _deve_briefing()}


@app.post("/api/presenca/briefing")
async def marcar_briefing():
    store.put("presenca", {**store.get("presenca"), "ultimo_briefing": dt.date.today().isoformat()})
    return {"ok": True}


# ---------- câmeras ----------


@app.get("/api/cameras/{cid}/foto")
async def camera_foto(cid: str):
    cam = next((c for c in system.cameras() if c.get("id") == cid), None)
    if not cam:
        raise HTTPException(404)
    try:
        jpeg = await system.snapshot(cam)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, str(exc)[:200]) from exc
    return Response(jpeg, media_type="image/jpeg", headers={"Cache-Control": "no-store"})


# ---------- memória ----------


@app.get("/api/memorias")
async def memorias():
    return {"tipos": TIPOS, "itens": memory.all()}


@app.post("/api/memorias")
async def nova_memoria(body: dict = Body(...)):
    if not body.get("texto"):
        raise HTTPException(400, "Texto vazio.")
    return await memory.add(body.get("tipo", "nota"), body["texto"], fonte="painel")


@app.delete("/api/memorias/{mid}")
async def apagar_memoria(mid: str):
    memory.delete(mid)
    return {"ok": True}


@app.get("/api/conversas")
async def conversas(limite: int = 20):
    with _db() as con:
        sess = con.execute("select id, inicio, refletida from sessoes order by inicio desc limit ?", (limite,)).fetchall()
        out = []
        for s in sess:
            turns = con.execute("select papel, texto, em from conversas where sessao = ? order by id", (s["id"],)).fetchall()
            if turns:
                out.append({
                    "id": s["id"],
                    "inicio": time.strftime("%d/%m %H:%M", time.localtime(s["inicio"])),
                    "refletida": bool(s["refletida"]),
                    "turnos": [dict(t) for t in turns],
                })
    return out


# ---------- WebSocket ----------


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    global voice
    await ws.accept()
    await hub.join(ws, {"role": ws.query_params.get("role", "hud"), "tela": ws.query_params.get("tela")})
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
                hub.voice = mine
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
            elif kind == "sequence.show" and mine:
                await mine.show_planned(int(data.get("index", -1)))
            elif kind == "video.frame" and mine and data.get("jpeg"):
                await mine.send_image(base64.b64decode(data["jpeg"]))
            elif kind == "presenca":
                # passos do reconhecimento vão para todas as telas; reconhecido desbloqueia
                await hub.broadcast({"type": "presenca", "etapa": data.get("etapa")})
                if data.get("etapa") == "reconhecido":
                    await hub.set_screens("ativas")
            elif kind == "telas" and data.get("estado") in ("ativas", "bloqueadas"):
                await hub.set_screens(data["estado"])
    except WebSocketDisconnect:
        pass
    finally:
        hub.leave(ws)
        if mine:
            await mine.stop()
            if voice is mine:
                voice = None
            if hub.voice is mine:
                hub.voice = None


if settings.frontend_dist.exists():
    app.mount("/assets", StaticFiles(directory=settings.frontend_dist / "assets"), name="assets")

    @app.get("/{path:path}")
    async def spa(path: str):
        file = settings.frontend_dist / path
        if path and file.is_file():
            return FileResponse(file)
        return FileResponse(settings.frontend_dist / "index.html")
