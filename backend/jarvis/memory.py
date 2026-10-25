"""Memória de longo prazo do Jarvis em mapa (estilo Obsidian): local, em SQLite, sem custo.

- No centro fica a pessoa ("eu"). Em volta, temas (trabalho, família, um projeto, um lugar…) ligados a ela ou a
  um tema maior. Cada memória (uma frase) se liga aos seus temas e às memórias parecidas.
- Cada memória e cada tema têm um vetor de significado (embedding gratuito da Gemini).
- Buscar começa pelas memórias e temas mais parecidos com a pergunta e segue as ligações: o que já está
  interligado vem junto, sem varrer tudo.
- As conversas ficam registradas; ao fim de cada sessão, um modelo de texto relê a conversa, extrai o que vale
  lembrar e encaixa cada item nos temas. Depois, `organize` liga o que ficou solto.
- A memória também vira uma pasta de notas Markdown com [[ligações]] (`Memória/`), que abre no Obsidian.
"""

import array
import asyncio
import json
import logging
import math
import re
import sqlite3
import time
import unicodedata
import uuid

from google import genai
from google.genai import types

from .config import DATA, HOME, settings

log = logging.getLogger("jarvis.memory")

DB_PATH = DATA / "jarvis.db"
VAULT = HOME / "Memória"
EMBED_MODEL = "gemini-embedding-001"
EMBED_DIM = 768
SAME_THRESHOLD = 0.9  # acima disso é a mesma memória: atualiza em vez de duplicar
RELATED = 0.74  # memórias parecidas a partir daqui ganham uma ligação
TEMA_AUTO = 0.62  # memória sem tema vai para o tema mais parecido a partir daqui
EU = "eu"
MARCA = "<!-- escrito pelo Jarvis -->"  # só notas com esta marca são reescritas ou apagadas na pasta

TIPOS = {
    "perfil": "Fatos estáveis sobre o usuário (trabalho, família, lugares, projetos, rotina).",
    "preferencia": "Como ele gosta das coisas e das respostas.",
    "correcao": "Algo em que o Jarvis errou e foi corrigido.",
    "licao": "Como o Jarvis deve agir melhor da próxima vez.",
    "nota": "Qualquer outra coisa que ele pediu para lembrar.",
}
TIPOS_TEMA = ["pessoa", "projeto", "trabalho", "lugar", "assunto", "rotina", "gosto", "saude", "jarvis"]

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
create table if not exists temas (
  id text primary key,
  nome text not null,
  tipo text not null default 'assunto',
  pai text,
  vetor blob,
  criado real not null
);
create table if not exists ligacoes (
  a text not null,
  b text not null,
  rotulo text not null default 'relacionado',
  peso real not null default 1,
  criada real not null,
  primary key (a, b)
);
create index if not exists ligacoes_b on ligacoes (b);
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


def _slug(nome: str) -> str:
    s = unicodedata.normalize("NFKD", nome.lower()).encode("ascii", "ignore").decode()
    return "t:" + (re.sub(r"[^a-z0-9]+", "-", s).strip("-") or "tema")


def _eu() -> str:
    """Nome do centro do mapa: o nome da pessoa ou "Eu"."""
    return settings.public().get("user_name") or "Eu"


def _link(con: sqlite3.Connection, a: str, b: str, rotulo: str = "relacionado", peso: float = 1.0) -> None:
    if a == b:
        return
    a, b = sorted((a, b)) if rotulo == "relacionado" else (a, b)
    con.execute(
        "insert into ligacoes (a, b, rotulo, peso, criada) values (?,?,?,?,?) "
        "on conflict(a, b) do update set peso = max(peso, excluded.peso), rotulo = excluded.rotulo",
        (a, b, rotulo, peso, time.time()),
    )


class Memory:
    def __init__(self) -> None:
        self._vault_task: asyncio.Task | None = None

    @property
    def client(self) -> genai.Client | None:
        from .llm import client

        return client()

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

    # ---------- temas ----------

    async def tema(self, nome: str, tipo: str = "assunto", pai: str | None = None) -> str:
        """Id do tema (cria se não existir), ligado ao tema pai ou à pessoa."""
        nome = " ".join(nome.split())[:60]
        tid = _slug(nome)
        with _db() as con:
            if con.execute("select 1 from temas where id = ?", (tid,)).fetchone():
                return tid
        vec = await self._embed(nome, "RETRIEVAL_DOCUMENT")
        pai_id = _slug(pai) if pai and _slug(pai) != tid else None
        with _db() as con:
            if pai_id and not con.execute("select 1 from temas where id = ?", (pai_id,)).fetchone():
                pai_id = None
            con.execute(
                "insert or ignore into temas (id, nome, tipo, pai, vetor, criado) values (?,?,?,?,?,?)",
                (tid, nome[:1].upper() + nome[1:], tipo if tipo in TIPOS_TEMA else "assunto", pai_id, _pack(vec), time.time()),
            )
            _link(con, tid, pai_id or EU, "parte de")
        return tid

    def temas(self) -> list[dict]:
        with _db() as con:
            rows = con.execute(
                """select t.id, t.nome, t.tipo, t.pai, count(l.a) as n from temas t
                   left join ligacoes l on l.b = t.id and l.rotulo = 'sobre'
                   group by t.id order by n desc, t.nome"""
            ).fetchall()
        return [dict(r) for r in rows]

    # ---------- memórias ----------

    async def add(self, tipo: str, texto: str, fonte: str = "conversa", temas: list[str] | None = None) -> dict:
        tipo = tipo if tipo in TIPOS else "nota"
        texto = texto.strip()
        vec = await self._embed(texto, "RETRIEVAL_DOCUMENT")
        now = time.time()
        acao, mid = "criada", None
        parecidas: list[tuple[float, str]] = []
        with _db() as con:
            if vec:
                for row in con.execute("select id, vetor from memorias where ativa = 1 and vetor is not null"):
                    c = _cos(vec, _unpack(row["vetor"]))
                    if c >= SAME_THRESHOLD and mid is None:
                        mid, acao = row["id"], "atualizada"
                    elif c >= RELATED:
                        parecidas.append((c, row["id"]))
            if mid:
                con.execute("update memorias set texto = ?, tipo = ?, vetor = ?, atualizada = ? where id = ?",
                            (texto, tipo, _pack(vec), now, mid))
            else:
                mid = uuid.uuid4().hex[:10]
                con.execute(
                    "insert into memorias (id, tipo, texto, vetor, fonte, criada, atualizada) values (?,?,?,?,?,?,?)",
                    (mid, tipo, texto, _pack(vec), fonte, now, now),
                )
            for c, other in sorted(parecidas, reverse=True)[:4]:
                _link(con, mid, other, "relacionado", round(c, 3))
        ids = [await self.tema(t) for t in (temas or []) if t and t.strip()]
        if not ids and vec:
            ids = self._tema_parecido(vec)
        with _db() as con:
            for tid in ids[:3]:
                _link(con, mid, tid, "sobre")
            if not ids and tipo in ("perfil", "preferencia"):
                _link(con, mid, EU, "sobre")
        self._vault_later()
        return {"id": mid, "acao": acao, "temas": [self._nome(t) for t in ids[:3]]}

    def _tema_parecido(self, vec: list[float]) -> list[str]:
        with _db() as con:
            rows = con.execute("select id, vetor from temas where vetor is not null").fetchall()
        best = max(((_cos(vec, _unpack(r["vetor"])), r["id"]) for r in rows), default=(0.0, ""))
        return [best[1]] if best[0] >= TEMA_AUTO else []

    def _nome(self, tid: str) -> str:
        with _db() as con:
            r = con.execute("select nome from temas where id = ?", (tid,)).fetchone()
        return r["nome"] if r else tid

    async def search(self, consulta: str, limit: int = 6) -> list[dict]:
        """Mais parecidas com a pergunta + o que está ligado a elas (mesmo tema, ligação direta)."""
        vec = await self._embed(consulta, "RETRIEVAL_QUERY")
        with _db() as con:
            rows = {r["id"]: r for r in con.execute("select * from memorias where ativa = 1")}
            links = con.execute("select a, b, rotulo, peso from ligacoes").fetchall()
            temas = con.execute("select id, nome, vetor from temas").fetchall()
        score: dict[str, float] = {}
        via: dict[str, str] = {}
        if vec:
            for mid, r in rows.items():
                if r["vetor"]:
                    c = _cos(vec, _unpack(r["vetor"]))
                    if c > 0.55:
                        score[mid] = c
            tema_hit = {t["id"]: _cos(vec, _unpack(t["vetor"])) for t in temas if t["vetor"]}
        else:
            words = [w for w in consulta.lower().split() if len(w) > 2]
            for mid, r in rows.items():
                n = sum(w in r["texto"].lower() for w in words)
                if n:
                    score[mid] = 0.5 + 0.1 * n
            tema_hit = {t["id"]: 0.7 for t in temas if any(w in t["nome"].lower() for w in words)}
        nomes = {t["id"]: t["nome"] for t in temas}
        viz: dict[str, list[tuple[str, float, str]]] = {}
        for ln in links:
            viz.setdefault(ln["a"], []).append((ln["b"], ln["peso"], ln["rotulo"]))
            viz.setdefault(ln["b"], []).append((ln["a"], ln["peso"], ln["rotulo"]))
        # temas que batem com a pergunta trazem as memórias deles
        for tid, c in tema_hit.items():
            if c < 0.6:
                continue
            for other, _, rot in viz.get(tid, []):
                if rot == "sobre" and other in rows and c * 0.9 > score.get(other, 0):
                    score[other], via[other] = c * 0.9, nomes.get(tid, "")
        # um passo pelas ligações a partir das melhores
        for mid, s in sorted(score.items(), key=lambda x: -x[1])[:4]:
            for other, peso, rot in viz.get(mid, []):
                if rot == "sobre" and other in nomes:  # vizinhas pelo mesmo tema
                    for m2, _, r2 in viz.get(other, []):
                        if r2 == "sobre" and m2 in rows and s * 0.7 > score.get(m2, 0):
                            score[m2], via[m2] = s * 0.7, nomes[other]
                elif other in rows and s * peso * 0.8 > score.get(other, 0):
                    score[other], via[other] = s * peso * 0.8, "ligada"
        hits = [mid for mid, _ in sorted(score.items(), key=lambda x: -x[1])[:limit]]
        if hits:
            with _db() as con:
                con.executemany("update memorias set usos = usos + 1 where id = ?", [(h,) for h in hits])
        out = []
        for h in hits:
            ts = [nomes[o] for o, _, rot in viz.get(h, []) if rot == "sobre" and o in nomes]
            out.append({"id": h, "tipo": rows[h]["tipo"], "texto": rows[h]["texto"], "temas": ts, **({"via": via[h]} if h in via else {})})
        return out

    async def forget(self, descricao: str) -> list[str]:
        hits = await self.search(descricao, limit=3)
        if not hits:
            return []
        self.delete(hits[0]["id"])
        return [hits[0]["texto"]]

    def all(self) -> list[dict]:
        with _db() as con:
            rows = con.execute(
                "select id, tipo, texto, fonte, criada, atualizada, usos from memorias where ativa = 1 order by atualizada desc"
            ).fetchall()
        return [dict(r) for r in rows]

    def delete(self, mid: str) -> None:
        with _db() as con:
            con.execute("update memorias set ativa = 0, atualizada = ? where id = ?", (time.time(), mid))
            con.execute("delete from ligacoes where a = ? or b = ?", (mid, mid))
        self._vault_later()

    async def edit(self, mid: str, texto: str | None = None, tipo: str | None = None) -> None:
        vec = await self._embed(texto.strip(), "RETRIEVAL_DOCUMENT") if texto else None
        with _db() as con:
            if texto:
                con.execute("update memorias set texto = ?, vetor = ?, atualizada = ? where id = ?", (texto.strip(), _pack(vec), time.time(), mid))
            if tipo in TIPOS:
                con.execute("update memorias set tipo = ? where id = ?", (tipo, mid))
        self._vault_later()

    def connect(self, a: str, b: str, rotulo: str = "relacionado") -> None:
        with _db() as con:
            _link(con, a, b, "sobre" if b.startswith("t:") or b == EU else rotulo)
        self._vault_later()

    def disconnect(self, a: str, b: str) -> None:
        with _db() as con:
            con.execute("delete from ligacoes where (a = ? and b = ?) or (a = ? and b = ?)", (a, b, b, a))
        self._vault_later()

    def delete_tema(self, tid: str) -> None:
        """Apaga só o tema; as memórias dele ficam (soltas, até a próxima organização)."""
        with _db() as con:
            con.execute("update temas set pai = null where pai = ?", (tid,))
            con.execute("delete from temas where id = ?", (tid,))
            con.execute("delete from ligacoes where a = ? or b = ?", (tid, tid))
        self._vault_later()

    def graph(self) -> dict:
        """Nós e ligações para o mapa (/memoria)."""
        with _db() as con:
            mems = con.execute("select id, tipo, texto, fonte, atualizada, usos from memorias where ativa = 1").fetchall()
            temas = con.execute("select id, nome, tipo, pai from temas").fetchall()
            links = con.execute("select a, b, rotulo, peso from ligacoes").fetchall()
        nodes = [{"id": EU, "grupo": "eu", "rotulo": _eu(), "texto": "Você"}]
        nodes += [{"id": t["id"], "grupo": "tema", "tipo": t["tipo"], "rotulo": t["nome"]} for t in temas]
        nodes += [{"id": m["id"], "grupo": "memoria", "tipo": m["tipo"], "rotulo": m["texto"][:48], "texto": m["texto"],
                   "fonte": m["fonte"], "atualizada": m["atualizada"], "usos": m["usos"]} for m in mems]
        ids = {n["id"] for n in nodes}
        ligadas = {ln["a"] for ln in links} | {ln["b"] for ln in links}
        out = [{"a": ln["a"], "b": ln["b"], "rotulo": ln["rotulo"], "peso": ln["peso"]} for ln in links if ln["a"] in ids and ln["b"] in ids]
        # memória sem ligação nenhuma fica presa à pessoa, para não flutuar solta
        out += [{"a": n["id"], "b": EU, "rotulo": "solta", "peso": 0.3} for n in nodes if n["grupo"] == "memoria" and n["id"] not in ligadas]
        return {"nodes": nodes, "links": out}

    def prompt_block(self, limit: int = 40) -> str:
        """O que o Jarvis já sabe, por tema, para entrar no prompt de cada sessão."""
        with _db() as con:
            rows = con.execute(
                """select m.id, m.tipo, m.texto, group_concat(t.nome, ', ') as temas from memorias m
                   left join ligacoes l on l.a = m.id and l.rotulo = 'sobre'
                   left join temas t on t.id = l.b
                   where m.ativa = 1 group by m.id
                   order by case m.tipo when 'correcao' then 0 when 'licao' then 1 when 'preferencia' then 2
                   when 'perfil' then 3 else 4 end, m.usos desc, m.atualizada desc limit ?""",
                (limit,),
            ).fetchall()
        if not rows:
            return "Você ainda não sabe nada sobre ele. Preste atenção e use a ferramenta lembrar."
        regras = [f"- [{r['tipo']}] {r['texto']}" for r in rows if r["tipo"] in ("correcao", "licao")]
        grupos: dict[str, list[str]] = {}
        for r in rows:
            if r["tipo"] not in ("correcao", "licao"):
                grupos.setdefault((r["temas"] or "Geral").split(",")[0], []).append(r["texto"])
        out = []
        if regras:
            out.append("Correções e lições (siga sempre):\n" + "\n".join(regras))
        out += [f"{nome}:\n" + "\n".join(f"- {t}" for t in itens) for nome, itens in grupos.items()]
        temas = [t["nome"] for t in self.temas()[:40]]
        if temas:
            out.append("Temas que já existem no mapa: " + ", ".join(temas))
        return "\n\n".join(out)

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

    async def _json(self, prompt: str, schema: dict) -> object | None:
        for model in (settings.text_model, "gemini-3.5-flash-lite"):
            try:
                r = await self.client.aio.models.generate_content(
                    model=model,
                    contents=prompt,
                    config=types.GenerateContentConfig(response_mime_type="application/json", response_schema=schema),
                )
                return json.loads(r.text or "null")
            except Exception as exc:  # noqa: BLE001
                log.warning("memória com %s falhou: %s", model, exc)
        return None

    async def reflect(self, sessao: str) -> list[dict]:
        """Relê a conversa e guarda o que vale lembrar, já nos temas. Roda ao fim de cada sessão."""
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
        nome = settings.user_name
        prompt = f"""Você cuida da memória de longo prazo do J.A.R.V.I.S., assistente pessoal de {nome}.
A memória é um mapa: {nome} no centro, temas em volta (pessoas, projetos, trabalho, lugares, assuntos, rotina,
gostos, saúde) e cada memória ligada a 1 ou 2 temas. Leia a conversa e extraia só o que continua útil depois.

Tipos:
{chr(10).join(f'- {k}: {v}' for k, v in TIPOS.items())}

Regras:
- Uma frase curta e autossuficiente por item, em português, na terceira pessoa ("{nome} trabalha com...").
- temas: 1 ou 2 nomes curtos. Reuse exatamente os nomes de temas que já existem; crie um novo só se nenhum servir.
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
                "properties": {"tipo": {"type": "STRING", "enum": list(TIPOS)}, "texto": {"type": "STRING"},
                               "temas": {"type": "ARRAY", "items": {"type": "STRING"}}},
                "required": ["tipo", "texto"],
            },
        }
        items = await self._json(prompt, schema) or []
        saved = []
        for it in items[:12] if isinstance(items, list) else []:
            if it.get("texto"):
                res = await self.add(it.get("tipo", "nota"), it["texto"], fonte="reflexao", temas=it.get("temas"))
                saved.append({**it, **res})
        log.info("reflexão da sessão %s: %d memórias", sessao, len(saved))
        await self.organize()
        return saved

    async def organize(self) -> int:
        """Liga as memórias soltas a temas e arruma os temas (qual faz parte de qual). Devolve quantas ligou."""
        if not self.client:
            return 0
        with _db() as con:
            soltas = con.execute(
                """select m.id, m.texto from memorias m where m.ativa = 1 and m.tipo not in ('correcao', 'licao')
                   and not exists (select 1 from ligacoes l where l.a = m.id and l.rotulo = 'sobre') limit 60"""
            ).fetchall()
        if not soltas:
            return 0
        temas = self.temas()
        prompt = f"""Organize a memória do J.A.R.V.I.S. sobre {settings.user_name} como um mapa de temas.
Para cada memória solta abaixo, diga de 1 a 2 temas curtos (reuse os existentes sempre que servir) e, para
temas novos, o tipo ({', '.join(TIPOS_TEMA)}) e, se fizer sentido, o tema maior de que fazem parte.

Temas que já existem: {', '.join(t['nome'] for t in temas) or 'nenhum'}

Memórias soltas:
{chr(10).join(f"{r['id']}: {r['texto']}" for r in soltas)}"""
        schema = {
            "type": "OBJECT",
            "properties": {
                "memorias": {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {
                    "id": {"type": "STRING"}, "temas": {"type": "ARRAY", "items": {"type": "STRING"}}}, "required": ["id", "temas"]}},
                "temas_novos": {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {
                    "nome": {"type": "STRING"}, "tipo": {"type": "STRING", "enum": TIPOS_TEMA}, "parte_de": {"type": "STRING"}},
                    "required": ["nome", "tipo"]}},
            },
            "required": ["memorias"],
        }
        res = await self._json(prompt, schema)
        if not isinstance(res, dict):
            return 0
        for t in res.get("temas_novos") or []:
            if t.get("nome"):
                await self.tema(t["nome"], t.get("tipo", "assunto"), t.get("parte_de"))
        validas = {r["id"] for r in soltas}
        n = 0
        for m in res.get("memorias") or []:
            if m.get("id") not in validas:
                continue
            for nome in (m.get("temas") or [])[:2]:
                tid = await self.tema(nome)
                with _db() as con:
                    _link(con, m["id"], tid, "sobre")
                n += 1
        log.info("organização da memória: %d ligações novas", n)
        self._vault_later()
        return n

    async def reflect_pending(self) -> None:
        """Sessões que terminaram sem reflexão (ex.: app fechado no meio) e memórias ainda soltas."""
        with _db() as con:
            ids = [r["id"] for r in con.execute(
                "select id from sessoes where refletida = 0 and inicio < ?", (time.time() - 600,)
            )]
        for sid in ids:
            await self.reflect(sid)
            await asyncio.sleep(1)
        await self.organize()
        self._vault_later()

    # ---------- pasta de notas (Obsidian) ----------

    def _vault_later(self) -> None:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        if self._vault_task and not self._vault_task.done():
            return
        self._vault_task = loop.create_task(self._vault_soon())

    async def _vault_soon(self) -> None:
        await asyncio.sleep(3)
        await asyncio.to_thread(self.write_vault)

    def write_vault(self) -> None:
        """Uma nota por tema (com as memórias e [[ligações]]) e a nota da pessoa no centro."""
        g = self.graph()
        nomes = {n["id"]: n["rotulo"] for n in g["nodes"] if n["grupo"] != "memoria"}
        nomes[EU] = _eu()
        mems = {n["id"]: n for n in g["nodes"] if n["grupo"] == "memoria"}
        arquivo = {tid: re.sub(r'[\\/:*?"<>|]', "-", nome) for tid, nome in nomes.items()}
        por_tema: dict[str, list[str]] = {}
        filhos: dict[str, list[str]] = {}
        relacionadas: dict[str, list[str]] = {}
        for ln in g["links"]:
            a, b, rot = ln["a"], ln["b"], ln["rotulo"]
            if a in mems and b in nomes:
                por_tema.setdefault(b, []).append(a)
            elif a in nomes and b in nomes and rot == "parte de":
                filhos.setdefault(b, []).append(a)
            elif a in mems and b in mems:
                relacionadas.setdefault(a, []).append(b)
                relacionadas.setdefault(b, []).append(a)
        temas_de = {m: [t for t, ms in por_tema.items() if m in ms] for m in mems}
        try:
            VAULT.mkdir(exist_ok=True)
            vivos = set()
            for tid, nome in nomes.items():
                linhas = [f"# {nome}", ""]
                if tid != EU:
                    pai = next((p for p, fs in filhos.items() if tid in fs), EU)
                    linhas += [f"Parte de [[{arquivo[pai]}]]", ""]
                if filhos.get(tid):
                    linhas += ["## Temas", *[f"- [[{arquivo[f]}]]" for f in filhos[tid]], ""]
                if por_tema.get(tid):
                    linhas.append("## O que o Jarvis sabe")
                    for m in por_tema[tid]:
                        outros = [arquivo[t] for t in temas_de[m] if t != tid]
                        extra = " · " + ", ".join(f"[[{o}]]" for o in outros) if outros else ""
                        linhas.append(f"- {mems[m]['texto']}{extra}")
                nome_arq = f"{arquivo[tid]}.md"
                (VAULT / nome_arq).write_text("\n".join(linhas) + "\n\n" + MARCA + "\n", encoding="utf-8")
                vivos.add(nome_arq)
            for f in VAULT.glob("*.md"):  # tema apagado: some a nota (só as que o Jarvis escreveu)
                if f.name not in vivos and MARCA in f.read_text(encoding="utf-8", errors="ignore"):
                    f.unlink()
        except OSError as exc:
            log.warning("não consegui escrever a pasta da memória: %s", exc)


memory = Memory()
