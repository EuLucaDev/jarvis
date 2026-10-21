"""Ajustes editáveis pelo painel, guardados no mesmo SQLite local da memória."""

import copy
import json
import sqlite3
import time
from typing import Any

from .config import settings
from .memory import DB_PATH

DEFAULTS: dict[str, Any] = {
    "briefing": {
        "gmail": [],  # [{"email": "...", "senha_app": "..."}]
        "agendas": [],  # [{"nome": "...", "url": "https://...ics"}]
        "temas": ["tecnologia", "novos modelos de IA", "política"],
        "fontes": [],  # domínios preferidos, ex.: "g1.globo.com"
        "cidade": settings.city,
        "fuso": "America/Maceio",
        "atualizar_min": 15,
        "clima": True,
        "noticias_por_tema": 3,
    },
    "telas": [
        {"id": "centro", "nome": "Centro de Comando", "widgets": ["orbe", "agenda", "emails", "cartoes", "sistema"]},
        {"id": "radar", "nome": "Radar de Notícias", "widgets": ["noticias:tecnologia", "noticias:novos modelos de IA", "transcricao", "sessao"]},
    ],
    "cameras": [],  # [{"id": "garagem", "nome": "Garagem", "url": "rtsp://... ou http://.../snapshot.jpg"}]
    "atalhos": [],  # nomes de Atalhos do macOS que o Jarvis pode rodar
    "alexa": {"token": "", "dispositivos": []},  # [{"nome": "luz da sala", "ligar": "luz-on", "desligar": "luz-off"}]
    "mercado": {"ativos": ["^BVSP", "BRL=X", "BTC-USD", "PETR4.SA", "VALE3.SA"]},
    "rosto": {"descritores": [], "nome": "Luca"},  # reconhecimento facial local
    "presenca": {"briefing_auto": True, "ultimo_briefing": ""},
}

SECRET_FIELDS = {"senha_app", "token"}


def _db() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB_PATH)
    con.execute("create table if not exists ajustes (chave text primary key, valor text not null, em real not null)")
    return con


def get(key: str) -> Any:
    with _db() as con:
        row = con.execute("select valor from ajustes where chave = ?", (key,)).fetchone()
    base = copy.deepcopy(DEFAULTS.get(key))
    if not row:
        return base
    val = json.loads(row[0])
    if isinstance(base, dict) and isinstance(val, dict):
        return {**base, **val}
    return val


def put(key: str, value: Any) -> None:
    with _db() as con:
        con.execute(
            "insert into ajustes (chave, valor, em) values (?,?,?) "
            "on conflict(chave) do update set valor = excluded.valor, em = excluded.em",
            (key, json.dumps(value, ensure_ascii=False), time.time()),
        )


def masked(value: Any) -> Any:
    """Cópia para o navegador: senhas viram um marcador."""
    if isinstance(value, dict):
        return {k: ("••••" if k in SECRET_FIELDS and v else masked(v)) for k, v in value.items()}
    if isinstance(value, list):
        return [masked(v) for v in value]
    return value


def merge_secrets(new: Any, old: Any) -> Any:
    """Ao salvar do painel, senha vazia ou mascarada mantém a anterior."""
    if isinstance(new, dict) and isinstance(old, dict):
        out = {}
        for k, v in new.items():
            if k in SECRET_FIELDS and (not v or v == "••••"):
                out[k] = old.get(k, "")
            else:
                out[k] = merge_secrets(v, old.get(k))
        return out
    if isinstance(new, list) and isinstance(old, list):
        # contas são casadas pelo e-mail
        by_mail = {o.get("email"): o for o in old if isinstance(o, dict)}
        return [merge_secrets(n, by_mail.get(n.get("email"), {})) if isinstance(n, dict) else n for n in new]
    return new
