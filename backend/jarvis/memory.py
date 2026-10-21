"""Memória de longo prazo do Jarvis: local, em SQLite, sem custo.

- Cada memória tem um tipo e um vetor de significado (embedding gratuito da Gemini) para busca por sentido.
- As conversas ficam registradas; ao fim de cada sessão, um modelo de texto relê a conversa e extrai
  fatos novos sobre o usuário, preferências, correções e lições (como o Jarvis deve agir melhor).
- As memórias mais importantes entram no prompt de cada nova sessão.
"""

import array
import asyncio
import json
import logging
import math
import sqlite3
import time
import uuid

from google import genai
from google.genai import types

from .config import ROOT, settings

log = logging.getLogger("jarvis.memory")

DB_PATH = ROOT / "data" / "jarvis.db"
EMBED_MODEL = "gemini-embedding-001"
EMBED_DIM = 768
SAME_THRESHOLD = 0.9  # acima disso é a mesma memória: atualiza em vez de duplicar

TIPOS = {
    "perfil": "Fatos estáveis sobre o usuário (trabalho, família, lugares, projetos, rotina).",
    "preferencia": "Como ele gosta das coisas e das respostas.",
    "correcao": "Algo em que o Jarvis errou e foi corrigido.",
    "licao": "Como o Jarvis deve agir melhor da próxima vez.",
    "nota": "Qualquer outra coisa que ele pediu para lembrar.",
}

SCHEMA = """
create table if not exists memorias (
  id text primary key,
  tipo text not null,
  texto text not null,
  vetor blob,
  fonte text not null default 'conversa',
  criada real not null,
  atualizada real not null,
  usos integer not null default 0,
  ativa integer not null default 1
);
create table if not exists conversas (
  id integer primary key autoincrement,
  sessao text not null,
  papel text not null,
  texto text not null,
  em real not null
);
create table if not exists sessoes (
  id text primary key,
  inicio real not null,
  refletida integer not null default 0
);
"""


def _db() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    con.executescript(SCHEMA)
    return con


def _pack(vec: list[float] | None) -> bytes | None:
    return array.array("f", vec).tobytes() if vec else None


def _unpack(blob: bytes | None) -> list[float] | None:
    if not blob:
        return None
    a = array.array("f")
    a.frombytes(blob)
    return a.tolist()


def _cos(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


class Memory:
    def __init__(self) -> None:
        self.client = genai.Client(api_key=settings.gemini_api_key) if settings.gemini_api_key else None

    async def _embed(self, text: str, task: str) -> list[float] | None:
        if not self.client:
            return None
        try:
            r = await self.client.aio.models.embed_content(
                model=EMBED_MODEL,
                contents=text,
                config=types.EmbedContentConfig(task_type=task, output_dimensionality=EMBED_DIM),
            )
            return list(r.embeddings[0].values)
        except Exception as exc:  # noqa: BLE001 - sem vetor, a busca cai para texto
            log.warning("embedding falhou: %s", exc)
            return None

    # ---------- memórias ----------

    async def add(self, tipo: str, texto: str, fonte: str = "conversa") -> dict:
        tipo = tipo if tipo in TIPOS else "nota"
        texto = texto.strip()
        vec = await self._embed(texto, "RETRIEVAL_DOCUMENT")
        now = time.time()
        with _db() as con:
            if vec:
                for row in con.execute("select id, vetor from memorias where ativa = 1 and vetor is not null"):
                    if _cos(vec, _unpack(row["vetor"])) >= SAME_THRESHOLD:
                        con.execute(
                            "update memorias set texto = ?, tipo = ?, vetor = ?, atualizada = ? where id = ?",
                            (texto, tipo, _pack(vec), now, row["id"]),
                        )
                        return {"id": row["id"], "acao": "atualizada"}
            mid = uuid.uuid4().hex[:10]
            con.execute(
                "insert into memorias (id, tipo, texto, vetor, fonte, criada, atualizada) values (?,?,?,?,?,?,?)",
                (mid, tipo, texto, _pack(vec), fonte, now, now),
            )
        return {"id": mid, "acao": "criada"}

    async def search(self, consulta: str, limit: int = 6) -> list[dict]:
        vec = await self._embed(consulta, "RETRIEVAL_QUERY")
        with _db() as con:
            rows = con.execute("select * from memorias where ativa = 1").fetchall()
            if vec:
                scored = [(_cos(vec, _unpack(r["vetor"])) if r["vetor"] else 0.0, r) for r in rows]
                scored = [s for s in scored if s[0] > 0.55]
            else:
                words = [w for w in consulta.lower().split() if len(w) > 2]
                scored = [(sum(w in r["texto"].lower() for w in words), r) for r in rows]
                scored = [s for s in scored if s[0] > 0]
            scored.sort(key=lambda s: s[0], reverse=True)
            hits = [r for _, r in scored[:limit]]
            if hits:
                con.executemany("update memorias set usos = usos + 1 where id = ?", [(r["id"],) for r in hits])
        return [{"id": r["id"], "tipo": r["tipo"], "texto": r["texto"]} for r in hits]

    async def forget(self, descricao: str) -> list[str]:
        hits = await self.search(descricao, limit=3)
        if not hits:
            return []
        best = hits[0]
        with _db() as con:
            con.execute("update memorias set ativa = 0, atualizada = ? where id = ?", (time.time(), best["id"]))
        return [best["texto"]]

    def all(self) -> list[dict]:
        with _db() as con:
            rows = con.execute(
                "select id, tipo, texto, fonte, criada, atualizada, usos from memorias where ativa = 1 order by atualizada desc"
            ).fetchall()
        return [dict(r) for r in rows]

    def delete(self, mid: str) -> None:
        with _db() as con:
            con.execute("update memorias set ativa = 0, atualizada = ? where id = ?", (time.time(), mid))

    def prompt_block(self, limit: int = 40) -> str:
        """O que o Jarvis já sabe, para entrar no prompt de cada sessão."""
        with _db() as con:
            rows = con.execute(
                """select tipo, texto from memorias where ativa = 1
                   order by case tipo when 'correcao' then 0 when 'licao' then 1 when 'preferencia' then 2
                   when 'perfil' then 3 else 4 end, usos desc, atualizada desc limit ?""",
                (limit,),
            ).fetchall()
        if not rows:
            return "Você ainda não sabe nada sobre ele. Preste atenção e use a ferramenta lembrar."
        return "\n".join(f"- [{r['tipo']}] {r['texto']}" for r in rows)

    # ---------- conversas e reflexão ----------

    def start_session(self) -> str:
        sid = uuid.uuid4().hex[:12]
        with _db() as con:
            con.execute("insert into sessoes (id, inicio) values (?, ?)", (sid, time.time()))
        return sid

    def log_turn(self, sessao: str, papel: str, texto: str) -> None:
        texto = " ".join(texto.split())
        if not texto:
            return
        with _db() as con:
            con.execute(
                "insert into conversas (sessao, papel, texto, em) values (?,?,?,?)",
                (sessao, papel, texto, time.time()),
            )

    async def reflect(self, sessao: str) -> list[dict]:
        """Relê a conversa e guarda o que vale lembrar. Roda ao fim de cada sessão."""
        if not self.client:
            return []
        with _db() as con:
            turns = con.execute(
                "select papel, texto from conversas where sessao = ? order by id", (sessao,)
            ).fetchall()
            con.execute("update sessoes set refletida = 1 where id = ?", (sessao,))
        if len(turns) < 2:
            return []
        transcript = "\n".join(f"{'Usuário' if t['papel'] == 'usuario' else 'Jarvis'}: {t['texto']}" for t in turns)
        prompt = f"""Você cuida da memória de longo prazo do J.A.R.V.I.S., assistente pessoal de {settings.user_name}.
Leia a conversa e extraia só o que continua útil em conversas futuras.

Tipos:
{chr(10).join(f'- {k}: {v}' for k, v in TIPOS.items())}

Regras:
- Uma frase curta e autossuficiente por item, em português, na terceira pessoa ("{settings.user_name} trabalha com...").
- Nada passageiro (clima de hoje, a pergunta do momento) nem o que já está na memória atual.
- Em "licao", diga como o Jarvis deve agir diferente, a partir de reclamações, correções ou do que funcionou mal.
- Se nada valer, devolva lista vazia.

Memória atual:
{self.prompt_block(80)}

Conversa:
{transcript[-12000:]}"""
        schema = {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {"tipo": {"type": "STRING", "enum": list(TIPOS)}, "texto": {"type": "STRING"}},
                "required": ["tipo", "texto"],
            },
        }
        items: list[dict] = []
        for model in (settings.text_model, "gemini-3.5-flash-lite"):
            try:
                r = await self.client.aio.models.generate_content(
                    model=model,
                    contents=prompt,
                    config=types.GenerateContentConfig(response_mime_type="application/json", response_schema=schema),
                )
                items = json.loads(r.text or "[]")
                break
            except Exception as exc:  # noqa: BLE001
                log.warning("reflexão com %s falhou: %s", model, exc)
        saved = []
        for it in items[:12]:
            if it.get("texto"):
                res = await self.add(it.get("tipo", "nota"), it["texto"], fonte="reflexao")
                saved.append({**it, **res})
        log.info("reflexão da sessão %s: %d memórias", sessao, len(saved))
        return saved

    async def reflect_pending(self) -> None:
        """Sessões que terminaram sem reflexão (ex.: servidor desligado no meio)."""
        with _db() as con:
            ids = [r["id"] for r in con.execute(
                "select id from sessoes where refletida = 0 and inicio < ?", (time.time() - 600,)
            )]
        for sid in ids:
            await self.reflect(sid)
            await asyncio.sleep(1)


memory = Memory()
