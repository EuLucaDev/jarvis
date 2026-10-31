"""Contas, site, launcher e loja de versões da portaria (jarvis.agcunae.com).

- Contas: uma conta = um Jarvis na nuvem (perfil). O administrador cria a conta (nome e e-mail) e a pessoa define
  a senha num link de primeiro acesso. Senha guardada com scrypt. Conta pausada perde o acesso na hora (site,
  launcher, nuvem e Telegram).
- Site (/site): entrar, baixar o launcher, código do Telegram, trocar a senha; o admin cria, pausa e apaga contas,
  vê os computadores (sistema, versão, último uso) e configura o robô do Telegram.
- Launcher: entra com e-mail e senha e recebe um acesso só daquele computador (o mesmo que o Jarvis usa para a
  nuvem); consulta a versão mais nova, baixa o manifesto e os arquivos (só os que mudaram) e informa o que está
  instalado.
- Loja de versões: a compilação automática manda o manifesto (cada arquivo com o hash) e só os arquivos que a loja
  ainda não tem; os arquivos ficam no R2 privado (ou no volume, sem R2) e são entregues por link temporário.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import tempfile
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse

router = APIRouter()
SESSAO_S = 30 * 86400
LINK_S = 7 * 86400
SISTEMAS = ("mac", "windows", "linux")
PRODUTOS = ("jarvis", "launcher", "instalador")
EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _p():  # a portaria (import tardio: ela importa este módulo)
    from . import portaria

    return portaria


# ---------------------------------------------------------------- senhas, tokens


def hash_senha(senha: str) -> str:
    sal = secrets.token_bytes(16)
    h = hashlib.scrypt(senha.encode(), salt=sal, n=2**14, r=8, p=1, dklen=32)
    return f"scrypt${base64.b64encode(sal).decode()}${base64.b64encode(h).decode()}"


def confere_senha(senha: str, guardada: str | None) -> bool:
    if not guardada or not guardada.startswith("scrypt$"):
        return False
    _, sal, h = guardada.split("$")
    novo = hashlib.scrypt(senha.encode(), salt=base64.b64decode(sal), n=2**14, r=8, p=1, dklen=32)
    return hmac.compare_digest(novo, base64.b64decode(h))


def _h(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


_tentativas: dict[str, list[float]] = {}


def _limite(chave: str, maximo: int = 8, janela: int = 600) -> None:
    agora = time.time()
    lista = [t for t in _tentativas.get(chave, []) if agora - t < janela]
    if len(lista) >= maximo:
        raise HTTPException(429, "Muitas tentativas. Espere alguns minutos.")
    lista.append(agora)
    _tentativas[chave] = lista


# ---------------------------------------------------------------- registro (versão 2)


def migrar_e_iniciar() -> None:
    """Começa do zero na primeira vez com contas: os perfis antigos vão para uma pasta guardada (não se apagam)."""
    p = _p()
    r = p.ler()
    if r.get("versao") != 2:
        guardado = p.DADOS / f"antigo-{time.strftime('%Y%m%d-%H%M%S')}"
        guardado.mkdir(parents=True, exist_ok=True)
        if (p.DADOS / "perfis").exists():
            shutil.move(str(p.DADOS / "perfis"), str(guardado / "perfis"))
        if p.REGISTRO.exists():
            shutil.move(str(p.REGISTRO), str(guardado / "portaria.json"))
        r = {"versao": 2, "contas": {}, "perfis": {}, "codigos": {}, "links": {}, "sessoes": {},
             "telegram": {"segredo": secrets.token_urlsafe(24)}, "versoes": {}}
        p.log.info("registro novo (contas); o anterior ficou em %s", guardado.name)
    email = os.getenv("PORTARIA_ADMIN_EMAIL", "").strip().lower()
    senha = os.getenv("PORTARIA_ADMIN_SENHA", "")
    if email and not any(c.get("admin") for c in r["contas"].values()):
        _criar_conta(r, os.getenv("PORTARIA_ADMIN_NOME", "Administrador"), email, admin=True, senha=senha or None)
        p.log.info("conta do administrador criada: %s", email)
    r.setdefault("telegram", {}).setdefault("segredo", secrets.token_urlsafe(24))
    for k in ("contas", "perfis", "codigos", "links", "sessoes", "versoes"):
        r.setdefault(k, {})
    p.gravar(r)


def _criar_conta(r: dict[str, Any], nome: str, email: str, admin: bool = False, senha: str | None = None) -> str:
    p = _p()
    pid, _ = p._novo_perfil(r, nome)  # noqa: SLF001 - o perfil na nuvem nasce junto
    cid = f"c{secrets.token_hex(5)}"
    r["contas"][cid] = {"nome": nome, "email": email, "senha": hash_senha(senha) if senha else None, "admin": admin,
                        "ativa": True, "perfil": pid, "criado": time.strftime("%Y-%m-%d %H:%M"), "ultimo_uso": None,
                        "dispositivos": {}}
    return cid


def conta_do_perfil(r: dict[str, Any], pid: str) -> tuple[str, dict[str, Any]] | None:
    return next(((k, c) for k, c in r["contas"].items() if c.get("perfil") == pid), None)


def perfil_do_acesso(token: str) -> tuple[str, dict[str, Any]] | None:
    """Acesso de um computador (launcher/Jarvis) → perfil, só se a conta estiver ativa."""
    p = _p()
    r = p.ler()
    h = _h(token)
    for cid, c in r["contas"].items():
        for d in c.get("dispositivos", {}).values():
            if d.get("token") and hmac.compare_digest(d["token"], h):
                if not c.get("ativa"):
                    raise HTTPException(403, "Conta pausada. Fale com quem cuida do Jarvis.")
                return c["perfil"], r["perfis"][c["perfil"]]
    for pid, pf in r["perfis"].items():  # acesso pelo /token do Telegram
        if pf.get("token") and hmac.compare_digest(pf["token"], h):
            cc = conta_do_perfil(r, pid)
            if cc and not cc[1].get("ativa"):
                raise HTTPException(403, "Conta pausada.")
            return pid, pf
    return None


def conta_ativa_do_tg(r: dict[str, Any], pid: str) -> bool:
    cc = conta_do_perfil(r, pid)
    return not cc or bool(cc[1].get("ativa"))


# ---------------------------------------------------------------- sessão do site


def _sessao(request: Request) -> tuple[str, dict[str, Any]]:
    tok = request.cookies.get("jv_sessao", "")
    if not tok:
        raise HTTPException(401)
    r = _p().ler()
    s = r["sessoes"].get(_h(tok))
    if not s or s["expira"] < time.time():
        raise HTTPException(401)
    c = r["contas"].get(s["conta"])
    if not c or not c.get("ativa"):
        raise HTTPException(401)
    return s["conta"], c


def _admin(request: Request) -> tuple[str, dict[str, Any]]:
    cid, c = _sessao(request)
    if not c.get("admin"):
        raise HTTPException(403)
    return cid, c


def _publica(cid: str, c: dict[str, Any]) -> dict[str, Any]:
    return {"id": cid, "nome": c["nome"], "email": c["email"], "admin": c.get("admin", False), "ativa": c.get("ativa", True),
            "criado": c.get("criado"), "ultimo_uso": c.get("ultimo_uso"), "senha_definida": bool(c.get("senha")),
            "dispositivos": [{"id": k, "sistema": d.get("sistema"), "nome": d.get("nome"), "jarvis": d.get("jarvis"),
                              "launcher": d.get("launcher"), "visto": d.get("visto")} for k, d in c.get("dispositivos", {}).items()]}


@router.post("/api/site/entrar")
async def site_entrar(request: Request, response: Response):
    corpo = await request.json()
    email = str(corpo.get("email", "")).strip().lower()
    _limite(f"site:{request.client.host if request.client else ''}:{email}")
    p = _p()
    r = p.ler()
    cid, c = next(((k, x) for k, x in r["contas"].items() if x["email"] == email), (None, None))
    if not c or not confere_senha(str(corpo.get("senha", "")), c.get("senha")):
        raise HTTPException(401, "E-mail ou senha não conferem.")
    if not c.get("ativa"):
        raise HTTPException(403, "Conta pausada. Fale com quem cuida do Jarvis.")
    tok = secrets.token_urlsafe(32)
    r["sessoes"] = {k: v for k, v in r["sessoes"].items() if v["expira"] > time.time()}
    r["sessoes"][_h(tok)] = {"conta": cid, "expira": time.time() + SESSAO_S}
    c["ultimo_uso"] = time.strftime("%Y-%m-%d %H:%M")
    p.gravar(r)
    response.set_cookie("jv_sessao", tok, max_age=SESSAO_S, httponly=True, secure=p.URL.startswith("https://"), samesite="lax")
    return {"ok": True, "conta": _publica(cid, c)}


@router.post("/api/site/sair")
async def site_sair(request: Request, response: Response):
    tok = request.cookies.get("jv_sessao", "")
    if tok:
        p = _p()
        r = p.ler()
        r["sessoes"].pop(_h(tok), None)
        p.gravar(r)
    response.delete_cookie("jv_sessao")
    return {"ok": True}


@router.get("/api/site/eu")
async def site_eu(request: Request):
    cid, c = _sessao(request)
    p = _p()
    r = p.ler()
    pf = r["perfis"].get(c["perfil"], {})
    return {**_publica(cid, c), "telegram_ligado": bool(pf.get("tg")), "robo": r.get("telegram", {}).get("usuario"),
            "versoes": {s: _ultima(r, "jarvis", s) for s in SISTEMAS},
            "launcher": {s: bool(_ultima(r, "instalador", s)) for s in SISTEMAS}}


@router.post("/api/site/senha")
async def site_senha(request: Request):
    cid, c = _sessao(request)
    corpo = await request.json()
    if not confere_senha(str(corpo.get("atual", "")), c.get("senha")):
        raise HTTPException(400, "A senha atual não confere.")
    nova = str(corpo.get("nova", ""))
    if len(nova) < 8:
        raise HTTPException(400, "Use pelo menos 8 caracteres.")
    p = _p()
    r = p.ler()
    r["contas"][cid]["senha"] = hash_senha(nova)
    p.gravar(r)
    return {"ok": True}


@router.get("/api/site/primeiro-acesso/{token}")
async def primeiro_acesso_ver(token: str):
    r = _p().ler()
    lk = r["links"].get(_h(token))
    if not lk or lk["expira"] < time.time():
        raise HTTPException(404, "Link vencido ou já usado. Peça um novo.")
    c = r["contas"].get(lk["conta"])
    if not c:
        raise HTTPException(404)
    return {"nome": c["nome"], "email": c["email"]}


@router.post("/api/site/primeiro-acesso/{token}")
async def primeiro_acesso(token: str, request: Request, response: Response):
    corpo = await request.json()
    senha = str(corpo.get("senha", ""))
    if len(senha) < 8:
        raise HTTPException(400, "Use pelo menos 8 caracteres.")
    p = _p()
    r = p.ler()
    lk = r["links"].pop(_h(token), None)
    if not lk or lk["expira"] < time.time():
        raise HTTPException(404, "Link vencido ou já usado. Peça um novo.")
    c = r["contas"][lk["conta"]]
    c["senha"] = hash_senha(senha)
    tok = secrets.token_urlsafe(32)
    r["sessoes"][_h(tok)] = {"conta": lk["conta"], "expira": time.time() + SESSAO_S}
    p.gravar(r)
    response.set_cookie("jv_sessao", tok, max_age=SESSAO_S, httponly=True, secure=p.URL.startswith("https://"), samesite="lax")
    return {"ok": True}


def _codigo_telegram(r: dict[str, Any], pid: str) -> dict[str, Any]:
    p = _p()
    cod = p._codigo()  # noqa: SLF001
    r["codigos"] = {k: v for k, v in r["codigos"].items() if v["expira"] > time.time()}
    r["codigos"][cod] = {"tipo": "vincular", "perfil": pid, "nome": "", "expira": time.time() + LINK_S}
    robo = r.get("telegram", {}).get("usuario")
    return {"codigo": cod, "link": f"https://t.me/{robo}?start={cod}" if robo else None, "robo": robo}


@router.post("/api/site/telegram")
async def site_telegram(request: Request):
    _, c = _sessao(request)
    p = _p()
    r = p.ler()
    out = _codigo_telegram(r, c["perfil"])
    p.gravar(r)
    return out


# ---------------------------------------------------------------- administração


@router.get("/api/site/admin/contas")
async def admin_contas(request: Request):
    _admin(request)
    r = _p().ler()
    p = _p()
    return [{**_publica(k, c), "nuvem_no_ar": bool(p._nucleos.get(c["perfil"]) and p._nucleos[c["perfil"]].poll() is None),  # noqa: SLF001
             "telegram_ligado": bool(r["perfis"].get(c["perfil"], {}).get("tg"))} for k, c in r["contas"].items()]


def _novo_link(r: dict[str, Any], cid: str) -> str:
    tok = secrets.token_urlsafe(24)
    r["links"] = {k: v for k, v in r["links"].items() if v["expira"] > time.time() and v["conta"] != cid}
    r["links"][_h(tok)] = {"conta": cid, "expira": time.time() + LINK_S}
    return f"{_p().URL}/site/primeiro-acesso/{tok}"


@router.post("/api/site/admin/contas")
async def admin_criar(request: Request):
    _admin(request)
    corpo = await request.json()
    nome = str(corpo.get("nome", "")).strip()
    email = str(corpo.get("email", "")).strip().lower()
    if not nome or not EMAIL.match(email):
        raise HTTPException(400, "Informe o nome e um e-mail válido.")
    p = _p()
    r = p.ler()
    if any(c["email"] == email for c in r["contas"].values()):
        raise HTTPException(400, "Já existe uma conta com esse e-mail.")
    cid = _criar_conta(r, nome, email)
    link = _novo_link(r, cid)
    p.gravar(r)
    p._subir(r["contas"][cid]["perfil"], r["perfis"][r["contas"][cid]["perfil"]])  # noqa: SLF001
    return {"ok": True, "conta": _publica(cid, r["contas"][cid]), "link": link}


@router.post("/api/site/admin/contas/{cid}/{acao}")
async def admin_acao(cid: str, acao: str, request: Request):
    meu, _ = _admin(request)
    p = _p()
    r = p.ler()
    c = r["contas"].get(cid)
    if not c:
        raise HTTPException(404)
    if acao in ("pausar", "ativar"):
        if cid == meu:
            raise HTTPException(400, "Você não pode pausar a sua própria conta.")
        c["ativa"] = acao == "ativar"
        if acao == "pausar":
            r["sessoes"] = {k: v for k, v in r["sessoes"].items() if v["conta"] != cid}
        p.gravar(r)
        return {"ok": True, "conta": _publica(cid, c)}
    if acao == "link":
        link = _novo_link(r, cid)
        p.gravar(r)
        return {"ok": True, "link": link}
    if acao == "computador":
        did = (await request.json()).get("dispositivo")
        c.get("dispositivos", {}).pop(did, None)
        p.gravar(r)
        return {"ok": True}
    raise HTTPException(404)


@router.delete("/api/site/admin/contas/{cid}")
async def admin_apagar(cid: str, request: Request):
    meu, _ = _admin(request)
    corpo = await request.json()
    p = _p()
    r = p.ler()
    c = r["contas"].get(cid)
    if not c:
        raise HTTPException(404)
    if cid == meu:
        raise HTTPException(400, "Você não pode apagar a sua própria conta.")
    if str(corpo.get("confirmar_email", "")).strip().lower() != c["email"]:
        raise HTTPException(400, "Para apagar, digite o e-mail da conta.")
    pid = c["perfil"]
    proc = p._nucleos.pop(pid, None)  # noqa: SLF001
    if proc and proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(15)
        except Exception:  # noqa: BLE001
            proc.kill()
    # os dados vão para a lixeira da portaria por 30 dias (o backup diário também os tem)
    lixo = p.DADOS / "apagados"
    lixo.mkdir(exist_ok=True)
    pasta = p.DADOS / "perfis" / pid
    if pasta.exists():
        shutil.move(str(pasta), str(lixo / f"{pid}-{time.strftime('%Y%m%d-%H%M%S')}"))
    r["perfis"].pop(pid, None)
    r["contas"].pop(cid, None)
    r["sessoes"] = {k: v for k, v in r["sessoes"].items() if v["conta"] != cid}
    r["links"] = {k: v for k, v in r["links"].items() if v["conta"] != cid}
    p.gravar(r)
    return {"ok": True}


@router.put("/api/site/admin/telegram")
async def admin_telegram(request: Request):
    _admin(request)
    return await _p().configurar_robo(str((await request.json()).get("token", "")).strip())


@router.get("/api/site/admin/versoes")
async def admin_versoes(request: Request):
    _admin(request)
    r = _p().ler()
    return {prod: {s: [{k: v for k, v in x.items() if k != "manifesto"} for x in r["versoes"].get(f"{prod}:{s}", [])][-10:][::-1]
                   for s in SISTEMAS} for prod in PRODUTOS}


def limpar_apagados() -> None:
    lixo = _p().DADOS / "apagados"
    if not lixo.exists():
        return
    for d in lixo.iterdir():
        if time.time() - d.stat().st_mtime > 30 * 86400:
            shutil.rmtree(d, ignore_errors=True)


# ---------------------------------------------------------------- launcher


def _acesso(request: Request) -> tuple[str, dict[str, Any], str, dict[str, Any], str]:
    tok = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
    if not tok:
        raise HTTPException(401)
    p = _p()
    r = p.ler()
    h = _h(tok)
    for cid, c in r["contas"].items():
        for did, d in c.get("dispositivos", {}).items():
            if d.get("token") and hmac.compare_digest(d["token"], h):
                if not c.get("ativa"):
                    raise HTTPException(403, "Conta pausada. Fale com quem cuida do Jarvis.")
                return cid, c, did, d, c["perfil"]
    raise HTTPException(401)


@router.post("/api/launcher/entrar")
async def launcher_entrar(request: Request):
    corpo = await request.json()
    email = str(corpo.get("email", "")).strip().lower()
    _limite(f"launcher:{request.client.host if request.client else ''}:{email}")
    p = _p()
    r = p.ler()
    cid, c = next(((k, x) for k, x in r["contas"].items() if x["email"] == email), (None, None))
    if not c or not confere_senha(str(corpo.get("senha", "")), c.get("senha")):
        raise HTTPException(401, "E-mail ou senha não conferem.")
    if not c.get("ativa"):
        raise HTTPException(403, "Conta pausada. Fale com quem cuida do Jarvis.")
    disp = corpo.get("dispositivo") or {}
    did = re.sub(r"[^A-Za-z0-9_-]", "", str(disp.get("id") or secrets.token_hex(8)))[:40]
    sistema = disp.get("sistema") if disp.get("sistema") in SISTEMAS else "?"
    tok = f"jv_{secrets.token_urlsafe(32)}"
    c.setdefault("dispositivos", {})[did] = {"sistema": sistema, "nome": str(disp.get("nome", ""))[:60], "token": _h(tok),
                                             "visto": time.strftime("%Y-%m-%d %H:%M"), "jarvis": None, "launcher": disp.get("launcher")}
    c["ultimo_uso"] = time.strftime("%Y-%m-%d %H:%M")
    p.gravar(r)
    return {"token": tok, "perfil": c["perfil"], "nome": c["nome"], "url": p.URL, "dispositivo": did}


def _ultima(r: dict[str, Any], produto: str, sistema: str) -> dict[str, Any] | None:
    lista = r["versoes"].get(f"{produto}:{sistema}") or []
    if not lista:
        return None
    v = lista[-1]
    return {k: v[k] for k in ("versao", "data", "notas", "tamanho", "arquivos") if k in v}


@router.get("/api/launcher/estado")
async def launcher_estado(request: Request, sistema: str = ""):
    cid, c, did, d, pid = _acesso(request)
    p = _p()
    r = p.ler()
    s = sistema if sistema in SISTEMAS else d.get("sistema")
    pf = r["perfis"].get(pid, {})
    tg = None
    if not pf.get("tg") and r.get("telegram", {}).get("usuario"):
        tg = _codigo_telegram(r, pid)
        p.gravar(r)
    return {"conta": {"nome": c["nome"], "email": c["email"], "admin": c.get("admin", False)}, "perfil": pid, "url": p.URL,
            "jarvis": _ultima(r, "jarvis", s), "launcher": _ultima(r, "launcher", s),
            "telegram": {"ligado": bool(pf.get("tg")), "robo": r.get("telegram", {}).get("usuario"), "link": tg and tg["link"]}}


@router.post("/api/launcher/ping")
async def launcher_ping(request: Request):
    cid, c, did, d, pid = _acesso(request)
    corpo = await request.json()
    p = _p()
    r = p.ler()
    dd = r["contas"][cid]["dispositivos"][did]
    for k in ("jarvis", "launcher"):
        if corpo.get(k):
            dd[k] = str(corpo[k])[:20]
    dd["visto"] = r["contas"][cid]["ultimo_uso"] = time.strftime("%Y-%m-%d %H:%M")
    p.gravar(r)
    return {"ok": True}


@router.get("/api/launcher/manifesto/{produto}/{sistema}")
async def launcher_manifesto(produto: str, sistema: str, request: Request, versao: str = ""):
    _acesso(request)
    if produto not in PRODUTOS or sistema not in SISTEMAS:
        raise HTTPException(404)
    r = _p().ler()
    lista = r["versoes"].get(f"{produto}:{sistema}") or []
    v = next((x for x in reversed(lista) if not versao or x["versao"] == versao), None)
    if not v:
        raise HTTPException(404, "Ainda não há versão para este sistema.")
    return json.loads(_manifesto_arquivo(produto, sistema, v["versao"]).read_text())


@router.get("/api/launcher/arquivo/{sha}")
async def launcher_arquivo(sha: str, request: Request):
    _acesso(request)
    return _entregar_objeto(sha)


# ---------------------------------------------------------------- loja de versões


def _loja() -> Path:
    d = _p().DADOS / "loja"
    (d / "manifestos").mkdir(parents=True, exist_ok=True)
    (d / "objetos").mkdir(parents=True, exist_ok=True)
    return d


def _manifesto_arquivo(produto: str, sistema: str, versao: str) -> Path:
    return _loja() / "manifestos" / f"{produto}-{sistema}-{re.sub(r'[^0-9A-Za-z._-]', '', versao)}.json"


def _r2():
    if not all(os.getenv(k) for k in ("R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET")):
        return None, None
    import boto3

    s3 = boto3.client("s3", endpoint_url=os.getenv("R2_ENDPOINT"), aws_access_key_id=os.getenv("R2_ACCESS_KEY_ID"),
                      aws_secret_access_key=os.getenv("R2_SECRET_ACCESS_KEY"), region_name="auto")
    return s3, os.getenv("R2_BUCKET")


def _chave(sha: str) -> str:
    return f"versoes/objetos/{sha[:2]}/{sha}"


def _conhecidos() -> set[str]:
    """Hashes que a loja já tem (lista local): conferir no R2 arquivo por arquivo pesava na VPS."""
    f = _loja() / "conhecidos.txt"
    return set(f.read_text().split()) if f.exists() else set()


def _anotar(hashes: set[str]) -> None:
    f = _loja() / "conhecidos.txt"
    novos = hashes - _conhecidos()
    if novos:
        with f.open("a") as out:
            out.write("".join(f"{h}\n" for h in sorted(novos)))


def _tem(sha: str) -> bool:
    if sha in _conhecidos() or (_loja() / "objetos" / sha).exists():
        return True
    s3, b = _r2()
    if not s3:
        return False
    try:
        s3.head_object(Bucket=b, Key=_chave(sha))
        return True
    except Exception:  # noqa: BLE001
        return False


def _entregar_objeto(sha: str):
    if not re.fullmatch(r"[0-9a-f]{64}", sha):
        raise HTTPException(404)
    local = _loja() / "objetos" / sha
    if local.exists():
        return FileResponse(local, media_type="application/octet-stream")
    s3, b = _r2()
    if not s3:
        raise HTTPException(404)
    url = s3.generate_presigned_url("get_object", Params={"Bucket": b, "Key": _chave(sha)}, ExpiresIn=3600)
    return RedirectResponse(url, status_code=302)


def _ci(request: Request) -> None:
    esperado = os.getenv("LOJA_TOKEN", "")
    if not esperado or not hmac.compare_digest(request.headers.get("x-loja-token", ""), esperado):
        raise HTTPException(403)


@router.post("/api/loja/preparar")
async def loja_preparar(request: Request):
    """A compilação manda os hashes; a loja responde quais faltam e, para cada um, um link assinado de envio
    direto para o R2 (os arquivos não passam pela VPS; aqui só se assina um texto)."""
    _ci(request)
    hashes = sorted({h for h in (await request.json()).get("hashes", []) if re.fullmatch(r"[0-9a-f]{64}", h)})
    conhecidos = _conhecidos()
    faltam = [h for h in hashes if h not in conhecidos and not (_loja() / "objetos" / h).exists()]
    s3, b = _r2()
    if not s3:  # sem R2 (testes): o envio vem para cá mesmo
        return {"faltam": faltam, "envio": {h: None for h in faltam}}
    envio = {h: s3.generate_presigned_url("put_object", Params={"Bucket": b, "Key": _chave(h)}, ExpiresIn=6 * 3600) for h in faltam}
    return {"faltam": faltam, "envio": envio}


@router.put("/api/loja/objeto/{sha}")
async def loja_objeto(sha: str, request: Request):
    _ci(request)
    if not re.fullmatch(r"[0-9a-f]{64}", sha):
        raise HTTPException(400)
    hsh = hashlib.sha256()
    with tempfile.NamedTemporaryFile(delete=False, dir=_loja()) as tmp:
        async for parte in request.stream():
            hsh.update(parte)
            tmp.write(parte)
    if hsh.hexdigest() != sha:
        os.unlink(tmp.name)
        raise HTTPException(400, "hash não confere")
    s3, b = _r2()
    if s3:
        import asyncio

        await asyncio.to_thread(s3.upload_file, tmp.name, b, _chave(sha))
        os.unlink(tmp.name)
    else:
        os.replace(tmp.name, _loja() / "objetos" / sha)
    _anotar({sha})
    return {"ok": True}


@router.post("/api/loja/publicar")
async def loja_publicar(request: Request):
    """Manifesto de uma versão: {produto, sistema, versao, notas, arquivos: [{caminho, sha, tamanho, modo} | {caminho, link}]}."""
    _ci(request)
    m = await request.json()
    produto, sistema, versao = m.get("produto"), m.get("sistema"), str(m.get("versao", ""))
    if produto not in PRODUTOS or sistema not in SISTEMAS or not versao:
        raise HTTPException(400)
    hashes = {a["sha"] for a in m.get("arquivos", []) if a.get("sha")}
    # a compilação conferiu cada envio (o R2 recusa link vencido e o hash vai no nome); sem R2, confere aqui
    s3, _ = _r2()
    if not s3:
        faltando = [h for h in hashes if not (_loja() / "objetos" / h).exists()]
        if faltando:
            raise HTTPException(400, f"{len(faltando)} arquivos ainda não foram enviados")
    _anotar(hashes)
    _manifesto_arquivo(produto, sistema, versao).write_text(json.dumps(m, ensure_ascii=False))
    p = _p()
    r = p.ler()
    lista = [x for x in r["versoes"].get(f"{produto}:{sistema}", []) if x["versao"] != versao]
    lista.append({"versao": versao, "data": time.strftime("%Y-%m-%d %H:%M"), "notas": m.get("notas", ""),
                  "tamanho": sum(a.get("tamanho", 0) for a in m.get("arquivos", [])), "arquivos": len(m.get("arquivos", [])),
                  "instalador": m.get("instalador")})
    r["versoes"][f"{produto}:{sistema}"] = lista[-20:]
    p.gravar(r)
    return {"ok": True}


@router.get("/api/site/baixar/{sistema}")
async def site_baixar(sistema: str, request: Request):
    """Instalador do launcher para o sistema (só para quem entrou no site)."""
    _sessao(request)
    if sistema not in SISTEMAS:
        raise HTTPException(404)
    r = _p().ler()
    lista = r["versoes"].get(f"instalador:{sistema}") or []
    if not lista:
        raise HTTPException(404, "O instalador deste sistema ainda não foi publicado.")
    m = json.loads(_manifesto_arquivo("instalador", sistema, lista[-1]["versao"]).read_text())
    a = m["arquivos"][0]
    resp = _entregar_objeto(a["sha"])
    if isinstance(resp, FileResponse):
        resp.headers["content-disposition"] = f'attachment; filename="{Path(a["caminho"]).name}"'
        return resp
    s3, b = _r2()
    url = s3.generate_presigned_url("get_object", Params={"Bucket": b, "Key": _chave(a["sha"]),
                                                          "ResponseContentDisposition": f'attachment; filename="{Path(a["caminho"]).name}"'},
                                    ExpiresIn=3600)
    return RedirectResponse(url, status_code=302)


# ---------------------------------------------------------------- páginas do site


def _web() -> Path:
    from .config import CODE_ROOT

    return CODE_ROOT / "frontend" / "dist"


@router.get("/")
async def raiz():
    return RedirectResponse("/site")


@router.get("/site")
@router.get("/site/{resto:path}")
async def site(resto: str = ""):
    idx = _web() / "index.html"
    if not idx.exists():
        return JSONResponse({"erro": "interface não encontrada"}, status_code=500)
    return FileResponse(idx, headers={"Cache-Control": "no-cache"})


@router.get("/assets/{arquivo:path}")
async def assets(arquivo: str):
    f = (_web() / "assets" / arquivo).resolve()
    if not f.is_file() or (_web() / "assets").resolve() not in f.parents:
        raise HTTPException(404)
    return FileResponse(f, headers={"Cache-Control": "public, max-age=31536000, immutable"})
