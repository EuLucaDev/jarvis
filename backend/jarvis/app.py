"""Núcleo do Jarvis: API, WebSocket de eventos e as páginas da interface (HUD, camada, configuração, painel).

O app (Tauri) abre este processo e as janelas apontam para ele. Aqui vivem a voz, o ouvido, as mãos e o
controle do computador, então as permissões do sistema ficam com o app Jarvis.
"""

import asyncio
import collections
import json
import logging
import os
import sys
import time
from typing import Any

from fastapi import Body, FastAPI, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import briefing, chat, pc, store, system
from .audio import audio
from .config import CODE_ROOT, DATA, HOME, settings
from .demo import run_demo
from .hands import hands
from .hub import hub
from .listener import estado as ouvido_estado
from .listener import ouvido
from .live import voice
from .screen import espelho
from .memory import TIPOS, VAULT as MEMORIA_PASTA, _db, memory

# ---------- logs em memória (página Sistema) e em arquivo ----------
LOGS: collections.deque[dict[str, Any]] = collections.deque(maxlen=400)


class _Ring(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        if record.name.startswith(("jarvis", "uvicorn.error")):
            LOGS.append({"em": time.strftime("%H:%M:%S", time.localtime(record.created)), "nivel": record.levelname,
                         "origem": record.name, "texto": record.getMessage()[:500]})


logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s",
                    handlers=[logging.StreamHandler(), logging.FileHandler(HOME / "jarvis.log", encoding="utf-8")])
logging.getLogger().addHandler(_Ring())
for noisy in ("httpx", "primp", "google_genai.models", "absl"):
    logging.getLogger(noisy).setLevel(logging.WARNING)
log = logging.getLogger("jarvis")

VERSION = (CODE_ROOT / "VERSION").read_text().strip() if (CODE_ROOT / "VERSION").exists() else "2.0.0"
app = FastAPI(title="J.A.R.V.I.S.")
demo_task: asyncio.Task | None = None
BOOT = time.time()


async def telemetry_loop() -> None:
    while True:
        if hub.count("admin") or hub.count("hud"):
            await hub.broadcast({"type": "telemetria", **await asyncio.to_thread(system.telemetry)})
        await asyncio.sleep(2)


@app.on_event("startup")
async def startup():
    loop = asyncio.get_running_loop()
    from . import activity, alerts, overlay

    overlay.bind_loop(loop)
    espelho.bind(loop)
    teste = bool(os.getenv("JARVIS_TESTE"))  # testes e compilação: sem microfone, câmera nem ouvido
    if not teste:
        audio.start()
    voice.bind(loop)
    if not teste:
        ouvido.start(loop)
        hands.bind(loop)
    asyncio.create_task(memory.reflect_pending())
    asyncio.create_task(briefing.refresh_loop())
    asyncio.create_task(telemetry_loop())
    asyncio.create_task(alerts.loop())
    asyncio.create_task(activity.loop())
    log.info("Jarvis %s no ar em http://127.0.0.1:%s (%s)", VERSION, settings.port, pc.SISTEMA)


@app.on_event("shutdown")
async def shutdown():
    espelho.stop()
    hands.stop()
    audio.stop()


# ---------- estado e configuração inicial ----------


@app.get("/health")
async def health():
    return {"ok": True, "versao": VERSION}


@app.get("/api/status")
async def status():
    return {
        **hub.status,
        "versao": VERSION,
        "sistema": pc.SISTEMA,
        "model": settings.live_model,
        "text_model": settings.text_model,
        "search": settings.search,
        "voice_name": settings.voice,
        "city": settings.city,
        "has_key": bool(settings.gemini_api_key),
        "configurado": bool(settings.configurado),
        "camera": hands.on,
        "camera_erro": hands.erro,
        "audio_erro": audio.erro,
        "ouvido": ouvido_estado,
        "clients": len(hub.clients),
        "cards": len(hub.cards),
        "uptime_min": round((time.time() - BOOT) / 60),
        "memorias": len(memory.all()),
        "pasta": str(HOME),
    }


@app.get("/api/setup")
async def setup_get():
    return {**settings.public(), "sistema": pc.SISTEMA, "pasta": str(HOME)}


@app.post("/api/setup/testar")
async def setup_testar(body: dict = Body(...)):
    """Confere a chave da Gemini antes de salvar (uma chamada pequena ao modelo de texto)."""
    from google import genai

    chave = (body.get("chave") or "").strip()
    if not chave:
        return {"ok": False, "erro": "Cole a chave."}
    try:
        c = genai.Client(api_key=chave)
        await c.aio.models.generate_content(model=settings.text_model, contents="Responda só: ok")
        return {"ok": True}
    except Exception as exc:  # noqa: BLE001
        msg = str(exc)
        if "API_KEY_INVALID" in msg or "API key not valid" in msg:
            return {"ok": False, "erro": "Essa chave não é válida. Copie de novo no Google AI Studio."}
        if "429" in msg or "RESOURCE_EXHAUSTED" in msg:
            return {"ok": True, "aviso": "A chave funciona, mas a cota grátis do dia acabou; amanhã volta."}
        return {"ok": False, "erro": f"Não consegui testar agora: {msg[:200]}"}


@app.post("/api/setup")
async def setup_salvar(body: dict = Body(...)):
    campos = {k: v for k, v in body.items() if k in ("gemini_api_key", "user_name", "tratamento", "city", "voice", "camera_auto") and v is not None}
    if "gemini_api_key" in campos:
        campos["gemini_api_key"] = str(campos["gemini_api_key"]).strip()
    settings.update(**campos, configurado=True)
    store.put("camera", {**store.get("camera"), "ligada": bool(settings.camera_auto)})
    if settings.camera_auto:
        await asyncio.to_thread(hands.start)
    await hub.broadcast({"type": "configurado"})
    return settings.public()


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


@app.post("/api/reiniciar")
async def reiniciar():
    """Sai; o app Jarvis sobe o núcleo de novo (já com permissões novas, se acabou de liberar)."""
    asyncio.get_running_loop().call_later(0.8, os._exit, 0)
    return {"ok": True}


# ---------- voz, câmera, permissões ----------


@app.post("/api/voz/{acao}")
async def voz(acao: str, body: dict = Body(default={})):
    if acao == "ligar":
        await voice.start()
    elif acao == "desligar":
        await voice.stop()
    elif acao == "perguntar" and body.get("texto"):
        await voice.ask(body["texto"])
    else:
        raise HTTPException(404)
    return {"ok": True}


@app.post("/api/camera/{acao}")
async def camera(acao: str):
    if acao not in ("ligar", "desligar"):
        raise HTTPException(404)
    store.put("camera", {**store.get("camera"), "ligada": acao == "ligar"})
    await asyncio.to_thread(hands.start if acao == "ligar" else hands.stop)
    return {"ok": True, "camera": hands.on, "erro": hands.erro}


def _mjpeg(fonte, pegar, fps: float) -> StreamingResponse:
    """Vídeo MJPEG a partir do último quadro de uma fonte (câmera ou espelho da tela)."""

    async def quadros():
        fonte.viewers += 1
        ultimo = None
        try:
            while True:
                q = pegar()
                if q and q is not ultimo:
                    ultimo = q
                    yield b"--q\r\nContent-Type: image/jpeg\r\nContent-Length: " + str(len(q)).encode() + b"\r\n\r\n" + q + b"\r\n"
                await asyncio.sleep(1 / fps)
        finally:
            fonte.viewers -= 1

    return StreamingResponse(quadros(), media_type="multipart/x-mixed-replace; boundary=q", headers={"Cache-Control": "no-store"})


@app.get("/api/camera/ao-vivo")
async def camera_ao_vivo():
    """Vídeo da câmera para o HUD e o quadradinho do canto."""
    return _mjpeg(hands, hands.latest_jpeg, 15)


@app.get("/api/tela/ao-vivo")
async def tela_ao_vivo():
    """O que o Jarvis está vendo da tela (espelho ligado)."""
    return _mjpeg(espelho, espelho.latest, 4)


@app.post("/api/tela/{acao}")
async def tela(acao: str):
    if acao not in ("ligar", "desligar"):
        raise HTTPException(404)
    if acao == "ligar":
        espelho.start()
        if voice.session:
            await voice.send_text("[Aviso do sistema, não é o usuário falando.] O espelho da tela foi ligado: a partir de agora você vê a tela dele.")
    else:
        espelho.stop()
    return espelho.estado()


@app.get("/api/app/comandos")
async def app_comandos():
    """O app (Tauri) pergunta aqui o que fazer com as janelas; espera até 20 s por um pedido."""
    try:
        primeiro = await asyncio.wait_for(hub.app_queue.get(), timeout=20)
    except asyncio.TimeoutError:
        return []
    out = [primeiro]
    while not hub.app_queue.empty():
        out.append(hub.app_queue.get_nowait())
    return out


@app.get("/api/permissoes")
async def permissoes():
    out: dict[str, Any] = {"sistema": pc.SISTEMA, "acessibilidade": pc.permitido(), "camera": hands.on and not hands.erro,
                           "microfone": audio.erro is None}
    if sys.platform == "darwin":
        from .sources import imessage

        out["mensagens"] = await asyncio.to_thread(imessage.has_access)
    return out


@app.post("/api/permissoes/acessibilidade")
async def pedir_acessibilidade():
    return {"ok": await asyncio.to_thread(pc.pedir_permissao)}


@app.get("/api/despertar")
async def despertar_estado():
    return {**store.get("despertar"), **ouvido_estado}


@app.post("/api/olhar")
async def olhar_teste(body: dict = Body(...)):
    """Manda a esfera até uma área da tela (teste da camada)."""
    from . import overlay

    overlay.look(float(body.get("x", 200)), float(body.get("y", 200)), float(body.get("w", 300)), float(body.get("h", 200)),
                 body.get("label", "Estou vendo"), body.get("modo", "olhar"))
    return {"ok": True}


# ---------- chat e briefing ----------


@app.post("/api/chat")
async def api_chat(body: dict = Body(...)):
    return await chat.reply(body.get("historico", []), body.get("texto", ""))


@app.get("/api/briefing")
async def get_briefing():
    return store.get("briefing_ultimo") or {}


@app.post("/api/briefing/gerar")
async def gerar_briefing():
    return await briefing.build(force=True)


@app.post("/api/briefing/apresentar")
async def apresentar_briefing():
    """Mostra os cartões do último briefing, sem voz (botão do painel)."""
    data = store.get("briefing_ultimo") or await briefing.build()
    await hub.clear_cards()
    _, fila = briefing.sequence(data)
    hub.pending_sequence = [(i * 4, k, d) for i, (_, k, d) in enumerate(fila)]
    asyncio.create_task(hub.play_sequence(wps=3.3))
    return {"ok": True, "cartoes": len(fila)}


# ---------- ajustes ----------

EDITABLE = {"despertar", "briefing", "cameras", "atalhos", "alexa", "mercado", "presenca", "alertas", "notas", "protocolos",
            "agentes", "atividade", "ambiente", "camera", "voz"}


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
            evs = await agenda_src.fetch([ag], settings.fuso)
            out.append({"fonte": ag.get("nome") or "Agenda", "ok": True, "detalhe": f"{len(evs)} compromissos hoje"})
        except Exception as exc:  # noqa: BLE001
            out.append({"fonte": ag.get("nome") or "Agenda", "ok": False, "detalhe": str(exc)[:160]})
    return out


@app.get("/api/atalhos/disponiveis")
async def atalhos_disponiveis():
    return await asyncio.to_thread(system.shortcuts_available)


# ---------- saúde, notas ----------


@app.get("/api/saude")
async def saude():
    from .sources import health

    data = store.get("saude") or {}
    return {**data, "resumo": health.summary(data) if data else {}}


@app.post("/api/saude/importar")
async def importar_saude(arquivo: UploadFile):
    from .sources import health

    dest = DATA / "saude" / "exportacao"
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


# ---------- alertas, protocolos, tarefas, mercado ----------


@app.get("/api/alertas")
async def alertas_recentes():
    from . import alerts

    return alerts.RECENT[::-1]


@app.post("/api/alertas/teste")
async def alerta_teste():
    from . import alerts

    return await alerts.notify("Teste de alerta", "Assim chega um aviso do Jarvis.", "info")


@app.get("/api/protocolos/tipos")
async def protocolos_tipos():
    from . import protocols

    return protocols.TIPOS


@app.post("/api/protocolos/executar")
async def protocolos_executar(body: dict = Body(...)):
    from . import protocols

    return await protocols.run(body.get("nome", ""))


@app.get("/api/tarefas")
async def tarefas():
    from . import agents

    return {"tarefas": hub.tasks, "disponiveis": agents.disponiveis(), "pasta": str(agents.ROOT)}


@app.post("/api/tarefas")
async def nova_tarefa(body: dict = Body(...)):
    from . import agents

    if not body.get("tarefa"):
        raise HTTPException(400, "Descreva a tarefa.")
    return await agents.iniciar(body.get("agente", "chatgpt"), body["tarefa"], body.get("titulo"))


@app.post("/api/tarefas/{tid}/cancelar")
async def cancelar_tarefa(tid: str):
    from . import agents

    return {"ok": await agents.cancelar(tid)}


@app.get("/api/mercado")
async def mercado(periodo: str = "1mo"):
    from . import market

    return await market.quotes(None, periodo)


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


# ---------- memória e conversas ----------


@app.get("/api/memorias")
async def memorias():
    return {"tipos": TIPOS, "itens": memory.all()}


@app.post("/api/memorias")
async def nova_memoria(body: dict = Body(...)):
    if not body.get("texto"):
        raise HTTPException(400, "Texto vazio.")
    return await memory.add(body.get("tipo", "nota"), body["texto"], fonte="painel", temas=body.get("temas"))


@app.patch("/api/memorias/{mid}")
async def editar_memoria(mid: str, body: dict = Body(...)):
    await memory.edit(mid, body.get("texto"), body.get("tipo"))
    return {"ok": True}


@app.delete("/api/memorias/{mid}")
async def apagar_memoria(mid: str):
    memory.delete(mid)
    return {"ok": True}


# mapa da memória (/memoria): nós, ligações, busca que segue as ligações, organizar
@app.get("/api/memoria/mapa")
async def mapa_memoria():
    return memory.graph()


@app.get("/api/memoria/buscar")
async def buscar_memoria(q: str):
    return await memory.search(q, limit=12)


@app.post("/api/memoria/ligar")
async def ligar_memoria(body: dict = Body(...)):
    if not body.get("a") or not body.get("b"):
        raise HTTPException(400)
    if body.get("desligar"):
        memory.disconnect(body["a"], body["b"])
    else:
        memory.connect(body["a"], body["b"])
    return {"ok": True}


@app.post("/api/memoria/temas")
async def novo_tema(body: dict = Body(...)):
    if not body.get("nome"):
        raise HTTPException(400, "Nome vazio.")
    return {"id": await memory.tema(body["nome"], body.get("tipo", "assunto"), body.get("parte_de"))}


@app.delete("/api/memoria/temas/{tid}")
async def apagar_tema(tid: str):
    memory.delete_tema(tid)
    return {"ok": True}


@app.post("/api/memoria/organizar")
async def organizar_memoria():
    return {"ligadas": await memory.organize()}


@app.post("/api/memoria/pasta")
async def abrir_pasta_memoria():
    """Abre a pasta de notas da memória (dá para abrir como cofre no Obsidian)."""
    await asyncio.to_thread(memory.write_vault)
    await asyncio.to_thread(pc.open_path, str(MEMORIA_PASTA))
    return {"ok": True, "pasta": str(MEMORIA_PASTA)}


@app.post("/api/memoria/zerar")
async def zerar_memoria(body: dict = Body(...)):
    """Apaga toda a memória e as conversas guardadas (o painel pede para digitar APAGAR)."""
    if body.get("confirmar") != "APAGAR":
        raise HTTPException(400, "Confirmação ausente.")
    with _db() as con:
        for tabela in ("memorias", "temas", "ligacoes", "conversas", "sessoes"):
            con.execute(f"delete from {tabela}")  # noqa: S608 - nomes fixos
    await asyncio.to_thread(memory.write_vault)
    return {"ok": True}


@app.get("/api/conversas")
async def conversas(limite: int = 20):
    with _db() as con:
        sess = con.execute("select id, inicio, refletida from sessoes order by inicio desc limit ?", (limite,)).fetchall()
        out = []
        for s in sess:
            turns = con.execute("select papel, texto, em from conversas where sessao = ? order by id", (s["id"],)).fetchall()
            if turns:
                out.append({"id": s["id"], "inicio": time.strftime("%d/%m %H:%M", time.localtime(s["inicio"])),
                            "refletida": bool(s["refletida"]), "turnos": [dict(t) for t in turns]})
    return out


# ---------- WebSocket ----------


async def _janela(ws: WebSocket, kind: str, data: dict[str, Any], aviso: list[float]) -> None:
    """Mão nas janelas de qualquer app: mirar (borda azul), pegar, arrastar, ajustar, jogar para outro monitor."""
    if kind != "janela.mira" and not pc.permitido():
        if time.time() - aviso[0] > 15:
            aviso[0] = time.time()
            texto = ("Libere o Jarvis em Acessibilidade (Ajustes do Sistema → Privacidade e Segurança)." if pc.SISTEMA == "mac"
                     else "O sistema não deixou o Jarvis controlar janelas.")
            await ws.send_json({"type": "alerta", "id": "ax", "titulo": "Janelas com a mão", "texto": texto, "nivel": "alta",
                                "at": time.strftime("%H:%M")})
        return
    x, y = float(data.get("x", 0.5)), float(data.get("y", 0.5))
    estado, res = None, None
    if kind == "janela.mira":
        res, estado = await pc.win_run(pc.win_aim, x, y), "mira"
    elif kind == "janela.pegar":
        res = await pc.win_run(pc.win_grab, x, y)
        estado = "ajuste" if data.get("modo") == "ajuste" else "pegou"
        if res.get("erro"):
            await ws.send_json({"type": "janela.erro", "texto": res["erro"]})
            res = None
    elif kind == "janela.mover":
        res, estado = await pc.win_run(pc.win_move, x, y), "pegou"
    elif kind == "janela.ajustar":
        res, estado = await pc.win_run(pc.win_scale, float(data.get("escala", 1))), "ajuste"
    elif kind == "janela.jogar":
        res, estado = await pc.win_run(pc.win_throw, data.get("direcao", "direita")), "pegou"
        if res.get("erro"):
            res = None
    elif kind == "janela.soltar":
        res = await pc.win_run(pc.win_release, bool(data.get("cancelar")))
        estado = "cancelou" if data.get("cancelar") else "solta"
    await hub.broadcast({"type": "janela.realce", "estado": estado, "janela": res, "escala": data.get("escala")})


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    await hub.join(ws, {"role": ws.query_params.get("role", "hud")})
    await ws.send_json({"type": "camera", "ligada": hands.on, "erro": hands.erro})  # a câmera liga antes das telas
    await ws.send_json(espelho.estado())
    aviso = [0.0]  # aviso de permissão: no máximo um a cada 15 s
    try:
        while True:
            data = json.loads(await ws.receive_text() or "{}")
            kind = data.get("type", "")
            if kind == "voice.start":
                await voice.start()
            elif kind == "voice.stop":
                await voice.stop()
            elif kind == "text" and data.get("text"):
                await voice.ask(data["text"])
            elif kind == "card.close" and data.get("id"):
                await hub.close_card(data["id"])
            elif kind == "cards.clear":
                await hub.clear_cards()
            elif kind.startswith("janela.") and kind != "janela.realce":
                await _janela(ws, kind, data, aviso)
            elif kind == "clique" and pc.permitido():
                # pinça rápida fora do Jarvis: clique de verdade onde a mão aponta (0..1 do monitor principal)
                x0, y0, w, h = pc.main_bounds()
                await asyncio.to_thread(pc.click, x0 + float(data.get("x", 0.5)) * w, y0 + float(data.get("y", 0.5)) * h)
            elif kind == "rolar" and pc.permitido():
                await asyncio.to_thread(pc.scroll, max(-400, min(400, int(data.get("dy", 0)))))
            elif kind == "apontado":
                hub.pointed = {**data["alvo"], "em": time.time()} if data.get("alvo") else None
            elif kind == "copiar" and isinstance(data.get("texto"), str):
                await asyncio.to_thread(pc.set_clipboard, data["texto"][:20000])
            elif kind == "parar":
                from . import overlay

                overlay.stop("botão")
            elif kind == "mercado.periodo" and data.get("periodo") in ("1d", "5d", "1mo", "6mo", "1y"):
                from . import market

                card = next((c for c in hub.cards if c["id"] == data.get("id") and c["kind"] == "mercado"), None)
                if card:
                    simbolos = [a["simbolo"] for a in card["data"].get("ativos", []) if a.get("simbolo")]
                    cot = await market.quotes(simbolos or None, data["periodo"])
                    if cot:
                        await hub.update_card(card["id"], {**card["data"], "periodo": data["periodo"], "ativos": cot})
    except WebSocketDisconnect:
        pass
    except Exception as exc:  # noqa: BLE001
        log.warning("WebSocket caiu: %s", exc)
    finally:
        hub.leave(ws)


# ---------- páginas (HUD, camada, configuração, painel) ----------

WEB = settings.web_dist
if (WEB / "assets").exists():
    app.mount("/assets", StaticFiles(directory=WEB / "assets"), name="assets")


@app.get("/{path:path}")
async def spa(path: str):
    file = (WEB / path).resolve()
    if path and file.is_file() and WEB.resolve() in file.parents:
        return FileResponse(file)
    index = WEB / "index.html"
    if not index.exists():
        return JSONResponse({"erro": f"Interface não encontrada em {WEB}"}, status_code=500)
    return FileResponse(index, headers={"Cache-Control": "no-cache"})


def main() -> None:
    """Ponto de entrada do executável (o app Jarvis chama este)."""
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=int(os.getenv("JARVIS_PORT", settings.port)), log_level="warning")


if __name__ == "__main__":
    main()
