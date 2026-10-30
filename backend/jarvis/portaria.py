"""Portaria do Jarvis na nuvem: o processo principal do servidor.

- Um núcleo do Jarvis por pessoa (perfil), cada um com a sua pasta (financeiro, memória, ajustes), em
  `<dados>/perfis/<id>`. A portaria sobe os núcleos, reinicia se caírem e é a única porta para fora.
- Telegram: recebe as mensagens do robô (webhook) e entrega ao núcleo da pessoa que escreveu (pelo número da conta
  do Telegram). Quem não é de nenhum perfil só consegue usar um código de convite. Guarda o token do robô: os núcleos
  falam com o Telegram por aqui (/interno/tg/...).
- Notebook: /p/<perfil>/... encaminha para o núcleo daquele perfil, com o token da pessoa (Bearer).
- Convites: o dono cria um convite (Painel → Nuvem e Telegram); quem abre o robô com o código ganha um perfil
  novo, vazio, só dele. "/token" no Telegram dá o acesso para ligar o Jarvis do computador da pessoa a esse perfil.
- Backup diário de todos os perfis, criptografado, no R2 (ou na própria pasta, se o R2 não estiver configurado).

Variáveis: PORTARIA_DADOS (/dados), PORTARIA_URL (https pública), PORTARIA_ADMIN_TOKEN (acesso do dono),
PORTARIA_ADMIN_NOME, PORTARIA_BACKUP_CHAVE (Fernet), R2_ENDPOINT / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET.
Rodar: `python -m jarvis.portaria` (porta 8700).
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
import logging
import os
import secrets
import sqlite3
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
log = logging.getLogger("jarvis.portaria")

DADOS = Path(os.getenv("PORTARIA_DADOS", "/dados"))
URL = os.getenv("PORTARIA_URL", "").rstrip("/")
PORTA = int(os.getenv("PORTARIA_PORTA", "8700"))
REGISTRO = DADOS / "portaria.json"
SEGREDO = secrets.token_urlsafe(24)  # entre a portaria e os núcleos (muda a cada início)
TG = os.getenv("PORTARIA_TG_API", "https://api.telegram.org")  # trocável só para testes
BACKUP_HORA = int(os.getenv("PORTARIA_BACKUP_HORA", "4"))

app = FastAPI(title="Jarvis · portaria", docs_url=None, redoc_url=None, openapi_url=None)
_nucleos: dict[str, subprocess.Popen] = {}
_http: httpx.AsyncClient | None = None


def http() -> httpx.AsyncClient:
    global _http
    if _http is None:
        _http = httpx.AsyncClient(timeout=httpx.Timeout(180, connect=10))
    return _http


# ---------------------------------------------------------------- registro


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def ler() -> dict[str, Any]:
    if REGISTRO.exists():
        return json.loads(REGISTRO.read_text())
    return {"perfis": {}, "codigos": {}, "telegram": {}, "admin": None}


def gravar(r: dict[str, Any]) -> None:
    DADOS.mkdir(parents=True, exist_ok=True)
    tmp = REGISTRO.with_suffix(".tmp")
    tmp.write_text(json.dumps(r, ensure_ascii=False, indent=1))
    os.chmod(tmp, 0o600)
    tmp.replace(REGISTRO)


def _novo_perfil(r: dict[str, Any], nome: str, token: str | None = None) -> tuple[str, str]:
    pid = f"p{secrets.token_hex(4)}"
    token = token or f"jv_{secrets.token_urlsafe(32)}"
    portas = {p["porta"] for p in r["perfis"].values()}
    porta = next(n for n in range(8800, 8900) if n not in portas)
    r["perfis"][pid] = {"nome": nome, "token": _hash(token), "porta": porta, "tg": [], "criado": time.strftime("%Y-%m-%d %H:%M")}
    pasta = DADOS / "perfis" / pid
    pasta.mkdir(parents=True, exist_ok=True)
    # a chave da Gemini do dono vale para os perfis novos até a pessoa ter a dela
    adm = r.get("admin")
    conf_adm = DADOS / "perfis" / adm / "config.json" if adm else None
    conf = {"configurado": True, "user_name": nome, "tratamento": ""}  # pelo nome; a pessoa pode pedir "senhora" etc.
    if conf_adm and conf_adm.exists():
        chave = json.loads(conf_adm.read_text()).get("gemini_api_key")
        if chave:
            conf["gemini_api_key"] = chave
        conf["fuso"] = json.loads(conf_adm.read_text()).get("fuso", "America/Sao_Paulo")
    (pasta / "config.json").write_text(json.dumps(conf, ensure_ascii=False))
    os.chmod(pasta / "config.json", 0o600)
    return pid, token


def iniciar_registro() -> None:
    r = ler()
    adm_token = os.getenv("PORTARIA_ADMIN_TOKEN", "")
    if not r["perfis"] and adm_token:
        pid, _ = _novo_perfil(r, os.getenv("PORTARIA_ADMIN_NOME", "Dono"), adm_token)
        r["admin"] = pid
        log.info("perfil do dono criado: %s", pid)
    if not r.get("telegram", {}).get("segredo"):
        r.setdefault("telegram", {})["segredo"] = secrets.token_urlsafe(24)
    gravar(r)


def perfil_do_token(request: Request) -> tuple[str, dict[str, Any]]:
    auth = request.headers.get("authorization", "")
    token = auth.removeprefix("Bearer ").strip()
    if not token:
        raise HTTPException(401)
    h = _hash(token)
    r = ler()
    for pid, p in r["perfis"].items():
        if secrets.compare_digest(p["token"], h):
            return pid, p
    raise HTTPException(401)


def _admin(request: Request) -> str:
    pid, _ = perfil_do_token(request)
    if pid != ler().get("admin"):
        raise HTTPException(403, "Só o dono do Jarvis pode fazer isso.")
    return pid


# ---------------------------------------------------------------- núcleos


def _subir(pid: str, p: dict[str, Any]) -> None:
    env = {**os.environ, "JARVIS_HOME": str(DADOS / "perfis" / pid), "JARVIS_PORT": str(p["porta"]), "JARVIS_NUVEM": "1",
           "JARVIS_PORTARIA_URL": f"http://127.0.0.1:{PORTA}", "JARVIS_PORTARIA_SEGREDO": SEGREDO}
    for k in ("PORTARIA_ADMIN_TOKEN", "PORTARIA_BACKUP_CHAVE", "R2_SECRET_ACCESS_KEY", "R2_ACCESS_KEY_ID"):
        env.pop(k, None)  # segredos da portaria não descem para os núcleos
    log_f = open(DADOS / "perfis" / pid / "nucleo.log", "a", encoding="utf-8")  # noqa: SIM115 - fica aberto com o processo
    _nucleos[pid] = subprocess.Popen([sys.executable, "-m", "jarvis.app"], env=env, stdout=log_f, stderr=subprocess.STDOUT,
                                     cwd=str(Path(__file__).resolve().parents[1]))
    log.info("núcleo %s (%s) na porta %s", pid, p["nome"], p["porta"])


async def vigiar() -> None:
    while True:
        for pid, p in ler()["perfis"].items():
            proc = _nucleos.get(pid)
            if proc is None or proc.poll() is not None:
                if proc is not None:
                    log.warning("núcleo %s caiu (código %s); subindo de novo", pid, proc.returncode)
                _subir(pid, p)
        await asyncio.sleep(10)


async def _nucleo(pid: str, metodo: str, caminho: str, **kw: Any) -> httpx.Response:
    p = ler()["perfis"][pid]
    headers = {**kw.pop("headers", {}), "x-segredo": SEGREDO}
    for tentativa in range(30):  # o núcleo pode estar subindo
        try:
            return await http().request(metodo, f"http://127.0.0.1:{p['porta']}{caminho}", headers=headers, **kw)
        except httpx.ConnectError:
            if tentativa == 29:
                raise
            await asyncio.sleep(1)
    raise RuntimeError("inalcançável")


# ---------------------------------------------------------------- Telegram


def _tg_token() -> str:
    return ler().get("telegram", {}).get("token", "")


async def tg(metodo: str, dados: dict[str, Any]) -> dict[str, Any]:
    r = await http().post(f"{TG}/bot{_tg_token()}/{metodo}", json=dados)
    return r.json()


def _codigo() -> str:
    return "".join(secrets.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(8))


async def _sem_perfil(tg_id: int, chat: int, texto: str, nome_tg: str) -> None:
    """Alguém que ainda não é de nenhum perfil: só um código (de convite ou de ligar a própria conta) entra."""
    cod = texto.removeprefix("/start").strip().upper()
    r = ler()
    c = r["codigos"].get(cod)
    if not c or c["expira"] < time.time():
        await tg("sendMessage", {"chat_id": chat, "text": "Este é um Jarvis particular. Para entrar, peça um convite a quem cuida dele e mande o código aqui."})
        return
    if c["tipo"] == "vincular":
        pid = c["perfil"]
    else:  # convite: perfil novo, só desta pessoa
        pid, _ = _novo_perfil(r, c.get("nome") or nome_tg)
        _subir(pid, r["perfis"][pid])
    r["perfis"][pid]["tg"] = sorted(set(r["perfis"][pid]["tg"]) | {tg_id})
    del r["codigos"][cod]
    gravar(r)
    nome = r["perfis"][pid]["nome"]
    boas = (f"Pronto, {nome}. Este Telegram agora é o seu Jarvis." if c["tipo"] == "vincular" else
            f"Bem-vindo(a), {nome}. Este é o seu Jarvis: o financeiro, a memória e as conversas aqui são só seus.\n\n"
            "Para começar, me diga quais contas e cartões você usa (ex.: \"tenho conta no Nubank com 1.200 e cartão Inter de 3 mil, "
            "fecha dia 5 e vence dia 12\"). Mande /ajuda para ver o que eu faço.")
    await tg("sendMessage", {"chat_id": chat, "text": boas})


async def _token_pelo_telegram(pid: str, chat: int) -> None:
    """/token: acesso novo para ligar o Jarvis do computador a este perfil (o anterior deixa de valer)."""
    r = ler()
    token = f"jv_{secrets.token_urlsafe(32)}"
    r["perfis"][pid]["token"] = _hash(token)
    gravar(r)
    await tg("sendMessage", {"chat_id": chat, "parse_mode": "HTML", "text":
         "Para ligar o Jarvis do seu computador: Painel → Nuvem e Telegram, cole estes dois.\n\n"
         f"Endereço: <code>{URL}</code>\nToken: <code>{token}</code>\n\nGuarde só no Jarvis. Mandar /token de novo troca o acesso."})


@app.post("/tg/{segredo}")
async def webhook(segredo: str, request: Request):
    tgc = ler().get("telegram", {})
    if not secrets.compare_digest(segredo, tgc.get("segredo", "")) or request.headers.get("x-telegram-bot-api-secret-token") != tgc.get("segredo"):
        raise HTTPException(403)
    upd = await request.json()
    asyncio.create_task(_entregar(upd))
    return {"ok": True}


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
            await _sem_perfil(tg_id, chat["id"], texto, de.get("first_name") or "")
            return
        if texto.split(" ")[0] == "/token":
            await _token_pelo_telegram(pid, chat["id"])
            return
        await _nucleo(pid, "POST", "/api/telegram/update", json=upd)
    except Exception:  # noqa: BLE001
        log.exception("entregar mensagem do Telegram")


def _interno(request: Request) -> None:
    if not secrets.compare_digest(request.headers.get("x-segredo", ""), SEGREDO):
        raise HTTPException(403)


@app.post("/interno/tg/{metodo}")
async def interno_tg(metodo: str, request: Request):
    _interno(request)
    if not _tg_token():
        return JSONResponse({"ok": False, "description": "robô sem token"})
    tipo = request.headers.get("content-type", "")
    url = f"{TG}/bot{_tg_token()}/{metodo}"
    if tipo.startswith("multipart/"):
        r = await http().post(url, content=await request.body(), headers={"content-type": tipo})
    else:
        r = await http().post(url, json=await request.json())
    return JSONResponse(r.json(), status_code=200)


@app.get("/interno/tg-arquivo")
async def interno_arquivo(file_id: str, request: Request):
    _interno(request)
    info = (await http().get(f"{TG}/bot{_tg_token()}/getFile", params={"file_id": file_id})).json()
    if not info.get("ok"):
        raise HTTPException(404)
    r = await http().get(f"{TG}/file/bot{_tg_token()}/{info['result']['file_path']}")
    return Response(r.content, media_type="application/octet-stream")


# ---------------------------------------------------------------- painel do dono (pelo notebook)


@app.get("/health")
@app.get("/saude")
async def saude():
    return {"ok": True, "perfis": len(ler()["perfis"]), "nucleos": sum(1 for p in _nucleos.values() if p.poll() is None)}


@app.get("/nuvem/eu")
async def eu(request: Request):
    pid, p = perfil_do_token(request)
    r = ler()
    tgc = r.get("telegram", {})
    return {"perfil": pid, "nome": p["nome"], "dono": pid == r.get("admin"), "telegram_ligado": bool(p["tg"]),
            "robo": tgc.get("usuario"), "robo_configurado": bool(tgc.get("token"))}


@app.put("/nuvem/telegram")
async def config_telegram(request: Request):
    _admin(request)
    token = str((await request.json()).get("token", "")).strip()
    me = (await http().get(f"{TG}/bot{token}/getMe")).json()
    if not me.get("ok"):
        return {"ok": False, "erro": "O Telegram não reconheceu esse token. Copie de novo do @BotFather."}
    r = ler()
    r["telegram"].update(token=token, usuario=me["result"]["username"])
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


@app.post("/nuvem/codigo")
async def novo_codigo(request: Request):
    """vincular: liga o Telegram de quem pede ao próprio perfil. convite (só o dono): perfil novo para outra pessoa."""
    pid, _ = perfil_do_token(request)
    corpo = await request.json()
    tipo = corpo.get("tipo", "vincular")
    if tipo == "convite":
        _admin(request)
    r = ler()
    cod = _codigo()
    r["codigos"] = {k: v for k, v in r["codigos"].items() if v["expira"] > time.time()}
    r["codigos"][cod] = {"tipo": tipo, "perfil": pid if tipo == "vincular" else None, "nome": corpo.get("nome", ""),
                         "expira": time.time() + 7 * 86400}
    gravar(r)
    robo = r.get("telegram", {}).get("usuario")
    return {"codigo": cod, "link": f"https://t.me/{robo}?start={cod}" if robo else None, "vale_dias": 7}


@app.get("/nuvem/perfis")
async def perfis(request: Request):
    _admin(request)
    r = ler()
    return [{"perfil": k, "nome": p["nome"], "telegram": bool(p["tg"]), "criado": p["criado"], "dono": k == r.get("admin"),
             "no_ar": bool(_nucleos.get(k) and _nucleos[k].poll() is None)} for k, p in r["perfis"].items()]


@app.delete("/nuvem/perfis/{alvo}/telegram")
async def desligar_telegram(alvo: str, request: Request):
    _admin(request)
    r = ler()
    if alvo in r["perfis"]:
        r["perfis"][alvo]["tg"] = []
        gravar(r)
    return {"ok": True}


# ---------------------------------------------------------------- notebook → núcleo do perfil

SEM_CABECALHO = {"host", "authorization", "content-length", "connection", "accept-encoding"}


@app.api_route("/p/{pid}/{caminho:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
async def encaminhar(pid: str, caminho: str, request: Request):
    dono, _ = perfil_do_token(request)
    if dono != pid:
        raise HTTPException(403)
    if not caminho.startswith("api/"):
        raise HTTPException(404)
    cab = {k: v for k, v in request.headers.items() if k.lower() not in SEM_CABECALHO}
    r = await _nucleo(pid, request.method, f"/{caminho}", content=await request.body(), headers=cab, params=dict(request.query_params))
    return Response(r.content, status_code=r.status_code, media_type=r.headers.get("content-type"))


# ---------------------------------------------------------------- backup diário


def _copia_consistente(origem: Path, zf: zipfile.ZipFile, nome: str) -> None:
    if origem.suffix in (".db", ".sqlite", ".sqlite3"):
        with tempfile.NamedTemporaryFile(suffix=".db") as tmp:
            src, dst = sqlite3.connect(origem), sqlite3.connect(tmp.name)
            with dst:
                src.backup(dst)
            src.close()
            dst.close()
            zf.write(tmp.name, nome)
    else:
        zf.write(origem, nome)


def montar_backup() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.write(REGISTRO, "portaria.json")
        for f in (DADOS / "perfis").rglob("*"):
            if f.is_file() and not any(p in f.parts for p in ("ocr", "entrada")) and f.suffix not in (".log", ".tmp") and not f.name.endswith(("-wal", "-shm")):
                _copia_consistente(f, zf, str(f.relative_to(DADOS)))
    dados = buf.getvalue()
    chave = os.getenv("PORTARIA_BACKUP_CHAVE", "")
    if chave:
        from cryptography.fernet import Fernet

        dados = Fernet(chave.encode()).encrypt(dados)
    return dados


async def _enviar_r2(nome: str, dados: bytes) -> bool:
    if not all(os.getenv(k) for k in ("R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET")):
        return False
    import boto3

    s3 = boto3.client("s3", endpoint_url=os.getenv("R2_ENDPOINT"), aws_access_key_id=os.getenv("R2_ACCESS_KEY_ID"),
                      aws_secret_access_key=os.getenv("R2_SECRET_ACCESS_KEY"), region_name="auto")
    bucket = os.getenv("R2_BUCKET")
    await asyncio.to_thread(s3.put_object, Bucket=bucket, Key=f"jarvis/{nome}", Body=dados)
    # mantém 30 dias
    lista = await asyncio.to_thread(s3.list_objects_v2, Bucket=bucket, Prefix="jarvis/")
    antigos = sorted(o["Key"] for o in lista.get("Contents", []))[:-30]
    for k in antigos:
        await asyncio.to_thread(s3.delete_object, Bucket=bucket, Key=k)
    return True


async def backups() -> None:
    feito = ""
    while True:
        hoje = time.strftime("%Y-%m-%d")
        if time.localtime().tm_hour >= BACKUP_HORA and feito != hoje and (DADOS / "perfis").exists():
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
        await asyncio.sleep(600)


@app.on_event("startup")
async def inicio() -> None:
    iniciar_registro()
    asyncio.create_task(vigiar())
    asyncio.create_task(backups())


@app.on_event("shutdown")
async def fim() -> None:
    for proc in _nucleos.values():
        proc.terminate()


def main() -> None:
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=PORTA, log_level="info")  # noqa: S104 - a portaria é a porta de fora


if __name__ == "__main__":
    main()
