"""Zerar: apaga o que a pessoa pedir, sempre com backup antes (fica 30 dias e dá para desfazer).

Níveis (podem ir juntos):
  memoria     o mapa da memória (memórias, temas, ligações) e as notas que o Jarvis escreveu em Memória/
  historico   conversas, sessões, atividade, último bom dia, alertas, cartões na tela
  financeiro  todos os dados do financeiro (o motor guarda o próprio backup antes)
  tudo        os três e mais ajustes, chave, nome e calibração: como instalação nova (abre a configuração)

O backup é um .zip em <pasta do Jarvis>/backups/zerar-AAAAMMDD-HHMMSS.zip com a cópia do banco do Jarvis, a
pasta Memória/, o config.json e o caminho do backup do financeiro. `desfazer()` restaura o mais recente.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import time
import zipfile
from pathlib import Path
from typing import Any

from .config import CONFIG_FILE, HOME
from .hub import hub

log = logging.getLogger("jarvis.zerar")

BACKUPS = HOME / "backups"
GUARDAR_DIAS = 30
NIVEIS = {
    "memoria": "a memória do Jarvis (o que ele aprendeu sobre você)",
    "historico": "o histórico de conversas, a atividade e os cartões",
    "financeiro": "todos os dados do financeiro (contas, cartões, lançamentos, metas)",
    "tudo": "tudo, como uma instalação nova (inclui ajustes, chave da Gemini e calibração das mãos)",
}
TABELAS = {"memoria": ("ligacoes", "memorias", "temas"), "historico": ("conversas", "sessoes", "atividade")}
CHAVES_HISTORICO = ("briefing_ultimo", "alertas_estado", "protocolos_rodados", "presenca")


def _db_path() -> Path:
    from .memory import DB_PATH

    return DB_PATH


def descrever(niveis: list[str]) -> str:
    n = _normalizar(niveis)
    return "; ".join(NIVEIS[x] for x in n)


def _normalizar(niveis: list[str]) -> list[str]:
    n = [x for x in niveis if x in NIVEIS]
    return ["tudo"] if "tudo" in n else n


def _limpar_antigos() -> None:
    limite = time.time() - GUARDAR_DIAS * 86400
    for z in BACKUPS.glob("zerar-*.zip"):
        if z.stat().st_mtime < limite:
            z.unlink(missing_ok=True)


async def _backup(niveis: list[str]) -> Path:
    """Cópia de segurança antes de apagar (o banco por cópia consistente do SQLite, não por cópia de arquivo)."""
    BACKUPS.mkdir(parents=True, exist_ok=True)
    _limpar_antigos()
    destino = BACKUPS / f"zerar-{time.strftime('%Y%m%d-%H%M%S')}.zip"
    manifesto: dict[str, Any] = {"niveis": niveis, "em": time.strftime("%Y-%m-%d %H:%M:%S")}
    tmp = BACKUPS / "jarvis.db.tmp"
    src = sqlite3.connect(_db_path())
    dst = sqlite3.connect(tmp)
    with dst:
        src.backup(dst)
    src.close()
    dst.close()
    if "financeiro" in niveis or "tudo" in niveis:
        from . import finance

        try:
            manifesto["financeiro_backup"] = await finance.chamar("backup:create")
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(f"não consegui fazer o backup do financeiro ({exc}); nada foi apagado") from exc
    with zipfile.ZipFile(destino, "w", zipfile.ZIP_DEFLATED) as z:
        z.write(tmp, "jarvis.db")
        if CONFIG_FILE.exists():
            z.write(CONFIG_FILE, "config.json")
        from .memory import VAULT

        if VAULT.exists():
            for f in VAULT.rglob("*.md"):
                z.write(f, f"Memória/{f.relative_to(VAULT)}")
        z.writestr("manifesto.json", json.dumps(manifesto, ensure_ascii=False, default=str))
    tmp.unlink(missing_ok=True)
    return destino


async def zerar(niveis: list[str]) -> dict[str, Any]:
    niveis = _normalizar(niveis)
    if not niveis:
        return {"erro": "Diga o que zerar: memória, histórico, financeiro ou tudo."}
    try:
        bkp = await _backup(niveis)
    except Exception as exc:  # noqa: BLE001
        return {"erro": str(exc)}
    tudo = "tudo" in niveis
    feito = []
    con = sqlite3.connect(_db_path())
    with con:
        for nivel in ("memoria", "historico"):
            if tudo or nivel in niveis:
                for t in TABELAS[nivel]:
                    try:
                        con.execute(f"delete from {t}")  # noqa: S608 - nomes fixos acima
                    except sqlite3.OperationalError:
                        pass  # tabela ainda não existe
                feito.append(nivel)
        if tudo:
            con.execute("delete from ajustes")
        elif "historico" in niveis:
            con.executemany("delete from ajustes where chave = ?", [(k,) for k in CHAVES_HISTORICO])
    con.close()
    if tudo or "memoria" in niveis:
        from .memory import MARCA, VAULT

        if VAULT.exists():
            for f in VAULT.rglob("*.md"):
                try:
                    if MARCA in f.read_text(encoding="utf-8", errors="ignore"):
                        f.unlink()
                except OSError:
                    pass
    if tudo or "historico" in niveis:
        await hub.clear_cards()
    if tudo or "financeiro" in niveis:
        from . import finance

        try:
            await finance.chamar("data:reset")
            await finance.mudou()
            feito.append("financeiro")
        except Exception as exc:  # noqa: BLE001
            log.warning("zerar financeiro falhou: %s", exc)
    if tudo:
        CONFIG_FILE.unlink(missing_ok=True)  # as configurações releem o arquivo sozinhas
        from .hands import hands

        hands.recalibrar()
        feito.append("ajustes")
        hub.app_cmd("configuracao")  # abre a configuração inicial, como na primeira vez
    await _na_nuvem("/api/zerar", {"o_que": [x for x in ("memoria", "historico") if tudo or x in niveis], "confirmado": True})
    log.info("zerado: %s (backup %s)", feito, bkp.name)
    return {"ok": True, "zerado": feito, "backup": bkp.name, "guardado_dias": GUARDAR_DIAS}


def backups() -> list[dict[str, Any]]:
    if not BACKUPS.exists():
        return []
    out = []
    for z in sorted(BACKUPS.glob("zerar-*.zip"), reverse=True):
        try:
            with zipfile.ZipFile(z) as f:
                m = json.loads(f.read("manifesto.json"))
        except Exception:  # noqa: BLE001
            m = {}
        out.append({"arquivo": z.name, "em": m.get("em"), "niveis": m.get("niveis", [])})
    return out


async def desfazer(arquivo: str | None = None) -> dict[str, Any]:
    """Volta o último zerar (ou o backup pedido): banco do Jarvis, Memória/, config e o financeiro."""
    lista = backups()
    if not lista:
        return {"erro": "Não há nada zerado para desfazer (os backups ficam 30 dias)."}
    alvo = next((b for b in lista if b["arquivo"] == arquivo), lista[0]) if arquivo else lista[0]
    caminho = BACKUPS / alvo["arquivo"]
    with zipfile.ZipFile(caminho) as z:
        m = json.loads(z.read("manifesto.json"))
        tmp = BACKUPS / "restaurar.db"
        tmp.write_bytes(z.read("jarvis.db"))
        src = sqlite3.connect(tmp)
        dst = sqlite3.connect(_db_path())
        with dst:
            src.backup(dst)
        src.close()
        dst.close()
        tmp.unlink(missing_ok=True)
        if "config.json" in z.namelist():
            CONFIG_FILE.write_bytes(z.read("config.json"))
        from .memory import VAULT

        for nome in z.namelist():
            if nome.startswith("Memória/"):
                destino = VAULT / nome[len("Memória/"):]
                destino.parent.mkdir(parents=True, exist_ok=True)
                if not destino.exists():
                    destino.write_bytes(z.read(nome))
    if m.get("financeiro_backup"):
        from . import finance

        caminho_fin = m["financeiro_backup"].get("path") if isinstance(m["financeiro_backup"], dict) else m["financeiro_backup"]
        try:
            await finance.chamar("backup:restore", caminho_fin)
            await finance.mudou()
        except Exception as exc:  # noqa: BLE001
            return {"ok": True, "aviso": f"O Jarvis voltou, mas o financeiro não ({exc}).", "backup": alvo["arquivo"]}
    from .hands import hands

    hands.recalibrar()
    await _na_nuvem("/api/zerar/desfazer", {})
    return {"ok": True, "restaurado": alvo["niveis"], "de": alvo["em"]}


async def _na_nuvem(caminho: str, corpo: dict[str, Any]) -> None:
    """Com a nuvem ligada, a memória e o histórico de lá acompanham (senão a sincronização traria tudo de volta).
    O financeiro já é o da nuvem: o zerar dele vale lá direto."""
    from . import nuvem

    if not nuvem.ligado() or ("o_que" in corpo and not corpo["o_que"]):
        return
    try:
        await nuvem.chamar("POST", caminho, json=corpo)
        nuvem.store.put("nuvem", {**nuvem.cfg(), "memoria_em": time.time()})
    except Exception as exc:  # noqa: BLE001
        log.warning("zerar na nuvem falhou: %s", exc)
