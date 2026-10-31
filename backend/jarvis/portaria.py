"""Portaria do Jarvis (jarvis.agcunae.com): o único processo da VPS, e leve.

O Jarvis roda no computador de cada pessoa. A VPS só:
- guarda as contas e o site (portaria_contas.py): login, admin, launcher e os links da loja de versões (R2);
- faz a ponte do Telegram: recebe as mensagens do robô (webhook) e entrega ao Jarvis do computador daquela conta,
  por uma conexão que o próprio Jarvis abre (WebSocket /api/ponte). Computador desligado: a mensagem fica numa fila
  (a pessoa recebe "guardei, respondo quando o Jarvis ligar") e é entregue quando ele conectar;
- repassa as respostas do Jarvis ao Telegram (/api/ponte/tg/...), só para as conversas da própria conta. O token do
  robô fica só aqui.
Nenhum dado de ninguém (financeiro, memória, conversa) fica na VPS. Backup diário do registro de contas (cifrado, no R2).

Variáveis: PORTARIA_DADOS (/dados), PORTARIA_URL (https pública), PORTARIA_ADMIN_EMAIL / PORTARIA_ADMIN_SENHA /
PORTARIA_ADMIN_NOME, PORTARIA_TELEGRAM_TOKEN (robô), PORTARIA_BACKUP_CHAVE (Fernet), LOJA_TOKEN,
R2_ENDPOINT / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET. Rodar: `python -m jarvis.portaria` (porta 8700).
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
import logging
import os
import secrets
import sys
import time
import zipfile
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import Response

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
log = logging.getLogger("jarvis.portaria")

DADOS = Path(os.getenv("PORTARIA_DADOS", "/dados"))
URL = os.getenv("PORTARIA_URL", "").rstrip("/")
PORTA = int(os.getenv("PORTARIA_PORTA", "8700"))
REGISTRO = DADOS / "portaria.json"
TG = os.getenv("PORTARIA_TG_API", "https://api.telegram.org")  # trocável só para testes
BACKUP_HORA = int(os.getenv("PORTARIA_BACKUP_HORA", "4"))
FILA_MAX = 50
# o que o Jarvis de um computador pode pedir ao robô (sempre numa conversa da própria conta)
METODOS = {"sendMessage", "sendPhoto", "sendDocument", "sendMediaGroup", "sendChatAction", "answerCallbackQuery",
           "editMessageReplyMarkup", "editMessageText", "deleteMessage", "sendVoice"}

# rodando como programa (python -m jarvis.portaria), este módulo é o __main__: sem isto, o "from . import portaria"
# de portaria_contas criaria uma segunda cópia (outro estado na memória)
if __name__ == "__main__":
    sys.modules.setdefault("jarvis.portaria", sys.modules[__name__])

app = FastAPI(title="Jarvis · portaria", docs_url=None, redoc_url=None, openapi_url=None)
from . import portaria_contas as contas  # noqa: E402 - o módulo usa funções daqui (import tardio lá dentro)

app.include_router(contas.router)
_ligados: dict[str, list[WebSocket]] = {}  # perfil → conexões do Jarvis (um por computador ligado)
_http: httpx.AsyncClient | None = None


def http() -> httpx.AsyncClient:
    global _http
    if _http is None:
        _http = httpx.AsyncClient(timeout=httpx.Timeout(60, connect=10))
    return _http


# ---------------------------------------------------------------- registro


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def ler() -> dict[str, Any]:
    if REGISTRO.exists():
        return json.loads(REGISTRO.read_text())
    return {"perfis": {}, "codigos": {}, "telegram": {}}


def gravar(r: dict[str, Any]) -> None:
    DADOS.mkdir(parents=True, exist_ok=True)
    tmp = REGISTRO.with_suffix(".tmp")
    tmp.write_text(json.dumps(r, ensure_ascii=False, indent=1))
    os.chmod(tmp, 0o600)
    tmp.replace(REGISTRO)


def _novo_perfil(r: dict[str, Any], nome: str, token: str | None = None) -> tuple[str, str]:
    """Perfil = a identidade de uma conta para o Telegram (os dados ficam no computador da pessoa)."""
    pid = f"p{secrets.token_hex(4)}"
    r["perfis"][pid] = {"nome": nome, "tg": [], "criado": time.strftime("%Y-%m-%d %H:%M")}
    return pid, ""


def perfil_do_token(request: Request) -> tuple[str, dict[str, Any]]:
    """Acesso de um computador (dado pelo launcher) → perfil, se a conta estiver ativa."""
    token = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
    achado = contas.perfil_do_acesso(token) if token else None
    if not achado:
        raise HTTPException(401)
    return achado


# ---------------------------------------------------------------- Telegram


def _tg_token() -> str:
    return ler().get("telegram", {}).get("token", "")


async def tg(metodo: str, dados: dict[str, Any]) -> dict[str, Any]:
    r = await http().post(f"{TG}/bot{_tg_token()}/{metodo}", json=dados)
    return r.json()


def _codigo() -> str:
    return "".join(secrets.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(8))


async def _sem_perfil(tg_id: int, chat: int, texto: str) -> None:
    """Quem ainda não é de nenhuma conta: só o código da conta (site ou launcher) liga o Telegram."""
    cod = texto.removeprefix("/start").strip().upper()
    r = ler()
    c = r["codigos"].get(cod)
    if not c or c["expira"] < time.time() or c.get("perfil") not in r["perfis"]:
        await tg("sendMessage", {"chat_id": chat, "text": "Este é um Jarvis particular. Para usar, entre no site do Jarvis com a sua conta e toque em \"Abrir no Telegram\"."})
        return
    pid = c["perfil"]
    r["perfis"][pid]["tg"] = sorted(set(r["perfis"][pid]["tg"]) | {tg_id})
    del r["codigos"][cod]
    gravar(r)
    nome = r["perfis"][pid]["nome"].split(" ")[0]
    await tg("sendMessage", {"chat_id": chat, "text": f"Pronto, {nome}. Este Telegram agora fala com o seu Jarvis. Mande /ajuda para ver o que eu faço."})


@app.post("/tg/{segredo}")
async def webhook(segredo: str, request: Request):
    tgc = ler().get("telegram", {})
    if not secrets.compare_digest(segredo, tgc.get("segredo", "")) or request.headers.get("x-telegram-bot-api-secret-token") != tgc.get("segredo"):
        raise HTTPException(403)
    upd = await request.json()
    asyncio.create_task(_entregar(upd))
    return {"ok": True}


def _fila(pid: str) -> Path:
    d = DADOS / "fila"
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{pid}.jsonl"


async def _entregar(upd: dict[str, Any]) -> None:
    try:
        origem = (upd.get("message") or upd.get("edited_message") or upd.get("callback_query") or {})
        de = origem.get("from") or {}
        chat = (origem.get("chat") or (origem.get("message") or {}).get("chat") or {})
        if chat.get("type") not in (None, "private"):
            return  # grupos não: o Jarvis é pessoal
        tg_id = de.get("id")
        if not tg_id:
            return
        r = ler()
        pid = next((k for k, p in r["perfis"].items() if tg_id in p["tg"]), None)
        texto = (origem.get("text") or "").strip()
        if not pid:
            await _sem_perfil(tg_id, chat["id"], texto)
            return
        if not contas.conta_ativa_do_tg(r, pid):
            await tg("sendMessage", {"chat_id": chat["id"], "text": "Sua conta do Jarvis está pausada. Fale com quem cuida dele."})
            return
        for ws in reversed(_ligados.get(pid, [])):  # o computador ligado mais recente
            try:
                await ws.send_json({"tipo": "telegram", "update": upd})
                return
            except Exception:  # noqa: BLE001 - conexão caída: tenta o próximo, senão vai para a fila
                continue
        # computador desligado: guarda e avisa (uma vez por leva)
        f = _fila(pid)
        linhas = f.read_text().splitlines() if f.exists() else []
        if not linhas and "callback_query" not in upd:
            await tg("sendMessage", {"chat_id": chat["id"], "text": "Seu Jarvis está desligado agora. Guardei a mensagem: ele responde assim que o computador ligar."})
        linhas = (linhas + [json.dumps(upd)])[-FILA_MAX:]
        f.write_text("\n".join(linhas) + "\n")
    except Exception:  # noqa: BLE001
        log.exception("entregar mensagem do Telegram")


# ---------------------------------------------------------------- ponte com o Jarvis de cada computador


@app.websocket("/api/ponte")
async def ponte(ws: WebSocket):
    token = ws.headers.get("authorization", "").removeprefix("Bearer ").strip()
    try:
        achado = contas.perfil_do_acesso(token) if token else None
    except HTTPException:
        achado = None
    if not achado:
        await ws.close(code=4401)
        return
    pid, _ = achado
    await ws.accept()
    _ligados.setdefault(pid, []).append(ws)
    log.info("Jarvis conectado (%s); %d computador(es)", pid, len(_ligados[pid]))
    try:
        f = _fila(pid)
        if f.exists():  # o que chegou enquanto ele estava desligado
            for linha in f.read_text().splitlines():
                if linha.strip():
                    await ws.send_json({"tipo": "telegram", "update": json.loads(linha)})
            f.unlink()
        while True:
            msg = await ws.receive_json()
            if msg.get("tipo") == "ping":
                await ws.send_json({"tipo": "pong"})
    except (WebSocketDisconnect, RuntimeError):
        pass
    except Exception:  # noqa: BLE001
        log.exception("ponte")
    finally:
        if ws in _ligados.get(pid, []):
            _ligados[pid].remove(ws)
        log.info("Jarvis desconectado (%s)", pid)


def conectado(pid: str) -> bool:
    return bool(_ligados.get(pid))


@app.post("/api/ponte/tg/{metodo}")
async def ponte_tg(metodo: str, request: Request):
    """O Jarvis do computador responde pelo robô: só métodos de conversa e só nas conversas da própria conta."""
    pid, perfil = perfil_do_token(request)
    if metodo not in METODOS or not _tg_token():
        raise HTTPException(403)
    tipo = request.headers.get("content-type", "")
    url = f"{TG}/bot{_tg_token()}/{metodo}"
    if tipo.startswith("multipart/"):
        form = await request.form()
        campos, arquivos = {}, {}
        for k, v in form.multi_items():
            if hasattr(v, "read"):
                arquivos[k] = (v.filename or k, await v.read(), v.content_type or "application/octet-stream")
            else:
                campos[k] = v
        chat = campos.get("chat_id")
        if metodo != "answerCallbackQuery" and str(chat) not in {str(x) for x in perfil["tg"]}:
            raise HTTPException(403, "conversa de outra conta")
        r = await http().post(url, data=campos, files=arquivos, timeout=120)
    else:
        dados = await request.json()
        chat = dados.get("chat_id")
        if metodo != "answerCallbackQuery" and str(chat) not in {str(x) for x in perfil["tg"]}:
            raise HTTPException(403, "conversa de outra conta")
        r = await http().post(url, json=dados)
    return Response(r.content, status_code=200, media_type="application/json")


@app.get("/api/ponte/tg-arquivo")
async def ponte_arquivo(file_id: str, request: Request):
    perfil_do_token(request)
    info = (await http().get(f"{TG}/bot{_tg_token()}/getFile", params={"file_id": file_id})).json()
    if not info.get("ok"):
        raise HTTPException(404)
    r = await http().get(f"{TG}/file/bot{_tg_token()}/{info['result']['file_path']}", timeout=120)
    return Response(r.content, media_type="application/octet-stream")


# ---------------------------------------------------------------- status para o Jarvis e o robô


@app.get("/health")
@app.get("/saude")
async def saude():
    return {"ok": True, "contas": len(ler().get("contas", {})), "computadores_ligados": sum(len(v) for v in _ligados.values())}


@app.get("/nuvem/eu")
async def eu(request: Request):
    pid, p = perfil_do_token(request)
    r = ler()
    tgc = r.get("telegram", {})
    cc = contas.conta_do_perfil(r, pid)
    link = None
    if not p["tg"] and tgc.get("usuario"):  # código da conta para ligar o Telegram com um toque
        link = contas._codigo_telegram(r, pid)["link"]  # noqa: SLF001
        gravar(r)
    return {"perfil": pid, "nome": p["nome"], "dono": bool(cc and cc[1].get("admin")), "telegram_ligado": bool(p["tg"]),
            "robo": tgc.get("usuario"), "robo_configurado": bool(tgc.get("token")), "telegram_link": link,
            "email": cc[1]["email"] if cc else None}


async def configurar_robo(token: str) -> dict[str, Any]:
    """Token do robô (do @BotFather): confere, guarda, liga o webhook e os comandos. Um robô para todas as contas."""
    me = (await http().get(f"{TG}/bot{token}/getMe")).json()
    if not me.get("ok"):
        return {"ok": False, "erro": "O Telegram não reconheceu esse token. Copie de novo do @BotFather."}
    r = ler()
    r.setdefault("telegram", {}).update(token=token, usuario=me["result"]["username"])
    r["telegram"].setdefault("segredo", secrets.token_urlsafe(24))
    gravar(r)
    if not URL.startswith("https://"):
        return {"ok": False, "erro": "A portaria precisa de um endereço https (PORTARIA_URL) para o Telegram entregar as mensagens."}
    w = await tg("setWebhook", {"url": f"{URL}/tg/{r['telegram']['segredo']}", "secret_token": r["telegram"]["segredo"],
                                "allowed_updates": ["message", "edited_message", "callback_query"], "drop_pending_updates": True})
    await tg("setMyCommands", {"commands": [
        {"command": "hoje", "description": "Resumo do dia"}, {"command": "mes", "description": "Relatório do mês"},
        {"command": "contas", "description": "O que vence"}, {"command": "desfazer", "description": "Desfaz o último lançamento"},
        {"command": "esquecer", "description": "Começa a conversa do zero"}, {"command": "ajuda", "description": "O que o Jarvis faz aqui"}]})
    return {"ok": bool(w.get("ok")), "robo": me["result"]["username"], "erro": None if w.get("ok") else w.get("description")}


async def _robo_da_variavel() -> None:
    """PORTARIA_TELEGRAM_TOKEN (variável do Coolify): liga o robô sem precisar do painel, se ainda não for esse."""
    token = os.getenv("PORTARIA_TELEGRAM_TOKEN", "").strip()
    if not token or ler().get("telegram", {}).get("token") == token:
        return
    for _ in range(10):
        try:
            log.info("robô do Telegram pela variável: %s", await configurar_robo(token))
            return
        except Exception as exc:  # noqa: BLE001
            log.warning("robô do Telegram: %s", exc)
            await asyncio.sleep(10)


# ---------------------------------------------------------------- backup diário (só o registro de contas)


def montar_backup() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.write(REGISTRO, "portaria.json")
        conhecidos = DADOS / "loja" / "conhecidos.txt"
        if conhecidos.exists():
            zf.write(conhecidos, "loja/conhecidos.txt")
        for m in (DADOS / "loja" / "manifestos").glob("*.json") if (DADOS / "loja" / "manifestos").exists() else []:
            zf.write(m, f"loja/manifestos/{m.name}")
    dados = buf.getvalue()
    chave = os.getenv("PORTARIA_BACKUP_CHAVE", "")
    if chave:
        from cryptography.fernet import Fernet

        dados = Fernet(chave.encode()).encrypt(dados)
    return dados


async def _enviar_r2(nome: str, dados: bytes) -> bool:
    s3, bucket = contas._r2()  # noqa: SLF001
    if not s3:
        return False
    await asyncio.to_thread(s3.put_object, Bucket=bucket, Key=f"jarvis/{nome}", Body=dados)
    lista = await asyncio.to_thread(s3.list_objects_v2, Bucket=bucket, Prefix="jarvis/")
    for k in sorted(o["Key"] for o in lista.get("Contents", []))[:-30]:  # mantém 30 dias
        await asyncio.to_thread(s3.delete_object, Bucket=bucket, Key=k)
    return True


async def backups() -> None:
    feito = ""
    while True:
        hoje = time.strftime("%Y-%m-%d")
        if time.localtime().tm_hour >= BACKUP_HORA and feito != hoje and REGISTRO.exists():
            try:
                dados = await asyncio.to_thread(montar_backup)
                nome = f"jarvis-{hoje}.zip{'.enc' if os.getenv('PORTARIA_BACKUP_CHAVE') else ''}"
                if not await _enviar_r2(nome, dados):
                    pasta = DADOS / "backups"
                    pasta.mkdir(exist_ok=True)
                    (pasta / nome).write_bytes(dados)
                    for velho in sorted(pasta.glob("jarvis-*"))[:-7]:
                        velho.unlink()
                feito = hoje
                log.info("backup %s (%d KB)", nome, len(dados) // 1024)
            except Exception:  # noqa: BLE001
                log.exception("backup falhou")
            contas.limpar_apagados()
        await asyncio.sleep(600)


@app.on_event("startup")
async def inicio() -> None:
    contas.migrar_e_iniciar()
    asyncio.create_task(backups())
    asyncio.create_task(_robo_da_variavel())


def main() -> None:
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=PORTA, log_level="info", ws_ping_interval=25, ws_ping_timeout=20)  # noqa: S104


if __name__ == "__main__":
    main()
