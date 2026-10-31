"""Jarvis na nuvem: o notebook e o servidor como um Jarvis só.

No servidor (cada perfil tem o seu núcleo, atrás da portaria), o financeiro e a memória moram lá e o Telegram fala
com ele. No notebook, com a nuvem ligada (Painel → Nuvem e Telegram):
  - o financeiro passa a ser o da nuvem: `fin()` encaminha cada operação (arquivos locais, como extratos, sobem antes);
  - a memória fica nos dois e se sincroniza a cada poucos minutos (a mais nova vence; apagar = desativar);
  - o notebook manda sinal de vida enquanto está em uso, para os avisos irem para ele e não para o Telegram;
  - ao ligar a primeira vez, os ajustes (nome, cidade, chave, sistemas) e o financeiro do notebook sobem para a nuvem.
Sem internet, o financeiro avisa que está fora do ar (nada se perde: a nuvem tem tudo e o backup diário).
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import sqlite3
import time
from pathlib import Path
from typing import Any

import httpx

from . import store

log = logging.getLogger("jarvis.nuvem")

NA_NUVEM = bool(os.getenv("JARVIS_NUVEM"))  # este núcleo É a nuvem (servidor)
SYNC_S = 180
VIDA_S = 60


# ---------------------------------------------------------------- notebook: ligação


def cfg() -> dict[str, Any]:
    c = store.get("nuvem") or {}
    if not NA_NUVEM:
        c = _do_launcher(c)
    return c


def _do_launcher(c: dict[str, Any]) -> dict[str, Any]:
    """O launcher deixa o acesso da conta em nuvem-launcher.json: o Jarvis já nasce ligado (e segue a conta se trocar)."""
    from .config import HOME

    f = HOME / "nuvem-launcher.json"
    try:
        dados = json.loads(f.read_text()) if f.exists() else None
    except (OSError, ValueError):
        dados = None
    if not dados or not dados.get("token"):
        return c
    if c.get("token") == dados["token"] and c.get("ativo", True):
        return c
    trocou_conta = c.get("perfil") and c.get("perfil") != dados.get("perfil")
    novo = {**({} if trocou_conta else c), "url": dados["url"], "token": dados["token"], "perfil": dados["perfil"], "ativo": True,
            "pelo_launcher": True}
    store.put("nuvem", novo)
    log.info("ligado à nuvem pela conta do launcher (%s)", dados.get("email", ""))
    return novo


def ligado() -> bool:
    c = cfg()
    return not NA_NUVEM and bool(c.get("url") and c.get("token") and c.get("perfil") and c.get("ativo", True))


def _url(caminho: str) -> str:
    c = cfg()
    return f"{c['url'].rstrip('/')}/p/{c['perfil']}{caminho}"


def _cab() -> dict[str, str]:
    return {"authorization": f"Bearer {cfg()['token']}"}


_cliente: httpx.AsyncClient | None = None


def _http() -> httpx.AsyncClient:
    global _cliente
    if _cliente is None:
        _cliente = httpx.AsyncClient(timeout=httpx.Timeout(120, connect=10))
    return _cliente


async def chamar(metodo: str, caminho: str, **kw: Any) -> Any:
    headers = {**_cab(), **kw.pop("headers", {})}
    r = await _http().request(metodo, _url(caminho), headers=headers, **kw)
    if r.status_code == 401:
        raise RuntimeError("A nuvem recusou o acesso (token inválido). Reconecte em Painel → Nuvem e Telegram.")
    r.raise_for_status()
    return r.json() if r.content else None


async def _subir_arquivo(caminho: Path) -> str:
    with caminho.open("rb") as f:
        r = await chamar("POST", "/api/nuvem/arquivo", files={"arquivo": (caminho.name, f.read())})
    return r["caminho"]


async def _trocar_arquivos(v: Any) -> Any:
    """Caminhos de arquivos do notebook (extratos, comprovantes) viram caminhos na nuvem."""
    if isinstance(v, str) and len(v) < 1024 and os.path.isabs(v) and Path(v).is_file():
        return await _subir_arquivo(Path(v))
    if isinstance(v, list):
        return [await _trocar_arquivos(x) for x in v]
    return v


async def fin(canal: str, *args: Any) -> Any:
    """Uma operação do financeiro, feita na nuvem."""
    from .finance import FinErro

    try:
        args2 = [await _trocar_arquivos(a) for a in args]
        corpo = await chamar("POST", f"/api/fin/c/{canal}", content=json.dumps({"args": args2}, ensure_ascii=False),
                             headers={"content-type": "application/json"})
    except httpx.HTTPError as exc:
        raise FinErro(f"O financeiro está na nuvem e ela não respondeu ({type(exc).__name__}). Confira a internet.") from exc
    if not corpo.get("ok"):
        raise FinErro(corpo.get("error") or "Erro no financeiro.")
    return corpo.get("data")


# ---------------------------------------------------------------- memória: os dois lados


def _db() -> sqlite3.Connection:
    from .memory import DB_PATH

    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    return con


def _linha(r: sqlite3.Row) -> dict[str, Any]:
    d = dict(r)
    if d.get("vetor") is not None:
        d["vetor"] = base64.b64encode(d["vetor"]).decode()
    return d


def exportar(desde: float) -> dict[str, list[dict[str, Any]]]:
    from .memory import memory  # garante as tabelas

    memory  # noqa: B018
    with _db() as con:
        return {
            "memorias": [_linha(r) for r in con.execute("select * from memorias where atualizada > ?", (desde,))],
            "temas": [_linha(r) for r in con.execute("select * from temas where criado > ?", (desde,))],
            "ligacoes": [_linha(r) for r in con.execute("select * from ligacoes where criada > ?", (desde,))],
        }


def importar(dados: dict[str, list[dict[str, Any]]]) -> int:
    """Junta memórias que vieram do outro lado (a versão mais nova de cada uma vence)."""
    n = 0
    with _db() as con:
        for m in dados.get("memorias", []):
            vet = base64.b64decode(m["vetor"]) if m.get("vetor") else None
            atual = con.execute("select atualizada from memorias where id = ?", (m["id"],)).fetchone()
            if atual and atual[0] >= m["atualizada"]:
                continue
            con.execute("insert or replace into memorias (id, tipo, texto, vetor, fonte, criada, atualizada, usos, ativa) values (?,?,?,?,?,?,?,?,?)",
                        (m["id"], m["tipo"], m["texto"], vet, m.get("fonte", "conversa"), m["criada"], m["atualizada"], m.get("usos", 0), m.get("ativa", 1)))
            n += 1
        for t in dados.get("temas", []):
            vet = base64.b64decode(t["vetor"]) if t.get("vetor") else None
            con.execute("insert or ignore into temas (id, nome, tipo, pai, vetor, criado) values (?,?,?,?,?,?)",
                        (t["id"], t["nome"], t.get("tipo", "assunto"), t.get("pai"), vet, t["criado"]))
        for li in dados.get("ligacoes", []):
            con.execute("insert or ignore into ligacoes (a, b, rotulo, peso, criada) values (?,?,?,?,?)",
                        (li["a"], li["b"], li.get("rotulo", "relacionado"), li.get("peso", 1), li["criada"]))
    return n


async def sincronizar_memoria() -> dict[str, int]:
    """Notebook ↔ nuvem: manda o que mudou aqui, recebe o que mudou lá."""
    c = cfg()
    desde = float(c.get("memoria_em", 0))
    agora = time.time()
    meu = await asyncio.to_thread(exportar, desde)
    r = await chamar("POST", "/api/memoria/sync", json={"desde": desde, **meu})
    recebidas = await asyncio.to_thread(importar, r or {})
    store.put("nuvem", {**cfg(), "memoria_em": agora - 5})
    return {"enviadas": len(meu["memorias"]), "recebidas": recebidas}


# ---------------------------------------------------------------- notebook: ligar pela primeira vez


async def subir_tudo(substituir: bool = False) -> dict[str, Any]:
    """Ajustes, sistemas e o financeiro do notebook vão para a nuvem (com backup lá antes de substituir).

    O financeiro só sobe se o da nuvem estiver vazio: depois de ligado, o notebook usa o da nuvem e o local fica
    parado no tempo; subir de novo apagaria o que entrou pelo Telegram. substituir=True força (com backup lá)."""
    from . import finance
    from .config import CONFIG_FILE

    out: dict[str, Any] = {}
    conf = json.loads(CONFIG_FILE.read_text()) if CONFIG_FILE.exists() else {}
    enviar = {k: conf.get(k) for k in ("gemini_api_key", "user_name", "tratamento", "city", "voice", "text_model") if conf.get(k)}
    try:
        from .config import settings

        enviar["fuso"] = settings.fuso
    except Exception:  # noqa: BLE001
        pass
    await chamar("POST", "/api/nuvem/config", json={"config": enviar, "sistemas": store.get("sistemas") or {},
                                                    "proativo": store.get("proativo") or {}})
    out["ajustes"] = True
    # financeiro: cópia consistente do banco local (o motor faz o backup) e restauração lá
    contas_nuvem = await fin("accounts:list") or []
    gastos_nuvem = await fin("expenses:list", {}) or []
    if (contas_nuvem or gastos_nuvem) and not substituir:
        out["financeiro"] = {"ok": False, "motivo": "A nuvem já tem um financeiro com dados; o do notebook não substituiu o de lá."}
    elif finance.motor.disponivel(local=True):
        await asyncio.to_thread(finance.motor.start)
        bkp = await finance.motor.chamar("backup:create")
        caminho = Path(bkp["path"] if isinstance(bkp, dict) else bkp)
        with caminho.open("rb") as f:
            r = await chamar("POST", "/api/nuvem/financeiro", files={"arquivo": (caminho.name, f.read())})
        out["financeiro"] = r
        finance.motor.stop()
    out["memoria"] = await sincronizar_memoria()
    store.put("nuvem", {**cfg(), "subido": time.strftime("%Y-%m-%d %H:%M")})
    return out


async def _mandar_ajustes() -> None:
    """Ajustes e chave da Gemini mudaram (configuração inicial, painel): a nuvem da conta recebe."""
    from .config import CONFIG_FILE

    conf = json.loads(CONFIG_FILE.read_text()) if CONFIG_FILE.exists() else {}
    enviar = {k: conf.get(k) for k in ("gemini_api_key", "user_name", "tratamento", "city", "voice", "text_model") if conf.get(k)}
    try:
        from .config import settings

        enviar["fuso"] = settings.fuso
    except Exception:  # noqa: BLE001
        pass
    await chamar("POST", "/api/nuvem/config", json={"config": enviar, "sistemas": store.get("sistemas") or {},
                                                    "proativo": store.get("proativo") or {}})


async def loop() -> None:
    """Notebook: na primeira ligação sobe tudo; depois manda os ajustes quando mudam, sinal de vida e memória."""
    from .config import CONFIG_FILE

    ultimo_sync = 0.0
    conf_em = 0.0
    while True:
        if ligado():
            try:
                if not cfg().get("subido"):
                    await subir_tudo()  # o financeiro só sobe se o da nuvem estiver vazio
                    conf_em = CONFIG_FILE.stat().st_mtime if CONFIG_FILE.exists() else 0
                elif CONFIG_FILE.exists() and CONFIG_FILE.stat().st_mtime != conf_em:
                    conf_em = CONFIG_FILE.stat().st_mtime
                    await _mandar_ajustes()
                from .proativo import presenca

                if presenca.presente:
                    await chamar("POST", "/api/nuvem/presenca", json={"em": time.time()})
                if time.time() - ultimo_sync > SYNC_S:
                    ultimo_sync = time.time()
                    await sincronizar_memoria()
            except Exception as exc:  # noqa: BLE001 - sem internet: tenta de novo depois
                log.info("nuvem fora do ar: %s", str(exc)[:120])
        await asyncio.sleep(VIDA_S)
