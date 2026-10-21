"""Notas: Obsidian (pasta local de Markdown) e Notion (API gratuita com token de integração)."""

import datetime as dt
import json
import re
from pathlib import Path
from typing import Any

import httpx

from .. import store

OBSIDIAN_CFG = Path.home() / "Library" / "Application Support" / "obsidian" / "obsidian.json"


def obsidian_vaults() -> list[str]:
    try:
        return [v["path"] for v in json.loads(OBSIDIAN_CFG.read_text()).get("vaults", {}).values()]
    except (OSError, ValueError, KeyError):
        return []


def _vault() -> Path | None:
    cfg = store.get("notas") or {}
    path = cfg.get("obsidian") or (obsidian_vaults() or [""])[0]
    p = Path(path) if path else None
    return p if p and p.is_dir() else None


def _snippet(text: str, terms: list[str]) -> str:
    low = text.lower()
    pos = min((low.find(t) for t in terms if low.find(t) >= 0), default=0)
    start = max(0, pos - 80)
    return " ".join(text[start : start + 260].split())


def search_obsidian(consulta: str, limite: int = 6) -> list[dict[str, Any]]:
    v = _vault()
    if not v:
        return []
    terms = [t for t in consulta.lower().split() if len(t) > 2] or [consulta.lower()]
    hits = []
    for f in v.rglob("*.md"):
        if "/." in str(f):
            continue
        try:
            text = f.read_text(errors="ignore")
        except OSError:
            continue
        hay = (f.stem + " " + text).lower()
        score = sum(hay.count(t) for t in terms) + 5 * sum(t in f.stem.lower() for t in terms)
        if score:
            hits.append((score, f, text))
    hits.sort(key=lambda h: (-h[0], -h[1].stat().st_mtime))
    return [
        {"fonte": "Obsidian", "titulo": f.stem, "caminho": str(f.relative_to(v)), "trecho": _snippet(t, terms)}
        for _, f, t in hits[:limite]
    ]


def read_obsidian(titulo: str) -> dict[str, Any]:
    v = _vault()
    if not v:
        return {"erro": "Cofre do Obsidian não encontrado. Configure em Conexões → Notas."}
    for f in v.rglob("*.md"):
        if f.stem.lower() == titulo.lower() or titulo.lower() in f.stem.lower():
            return {"titulo": f.stem, "texto": f.read_text(errors="ignore")[:6000]}
    return {"erro": f"Nota '{titulo}' não encontrada."}


def create_obsidian(titulo: str, texto: str) -> dict[str, Any]:
    v = _vault()
    if not v:
        return {"erro": "Cofre do Obsidian não encontrado. Configure em Conexões → Notas."}
    folder = v / "Jarvis"
    folder.mkdir(exist_ok=True)
    safe = re.sub(r'[\\/:*?"<>|]', "-", titulo).strip() or "Nota"
    f = folder / f"{safe}.md"
    if f.exists():
        f.write_text(f.read_text() + f"\n\n## {dt.datetime.now():%d/%m/%Y %H:%M}\n\n{texto}\n")
        return {"ok": True, "nota": f"Jarvis/{f.name}", "acao": "acrescentada"}
    f.write_text(f"# {titulo}\n\n{texto}\n\n— criada pelo Jarvis em {dt.datetime.now():%d/%m/%Y %H:%M}\n")
    return {"ok": True, "nota": f"Jarvis/{f.name}", "acao": "criada"}


def _notion() -> httpx.Client | None:
    token = (store.get("notas") or {}).get("notion_token")
    if not token:
        return None
    return httpx.Client(
        base_url="https://api.notion.com/v1",
        headers={"Authorization": f"Bearer {token}", "Notion-Version": "2022-06-28"},
        timeout=15,
    )


def search_notion(consulta: str, limite: int = 6) -> list[dict[str, Any]]:
    c = _notion()
    if not c:
        return []
    with c:
        r = c.post("/search", json={"query": consulta, "page_size": limite})
        if r.status_code != 200:
            return [{"fonte": "Notion", "erro": r.json().get("message", r.text)[:160]}]
        out = []
        for p in r.json().get("results", []):
            title = ""
            for prop in (p.get("properties") or {}).values():
                if prop.get("type") == "title":
                    title = "".join(t.get("plain_text", "") for t in prop.get("title", []))
            if not title and p.get("title"):
                title = "".join(t.get("plain_text", "") for t in p["title"])
            out.append({"fonte": "Notion", "titulo": title or "(sem título)", "url": p.get("url")})
        return out


def search(consulta: str) -> dict[str, Any]:
    res = search_obsidian(consulta) + search_notion(consulta)
    if not res and not _vault() and not _notion():
        return {"erro": "Nenhuma fonte de notas configurada. Conecte o Obsidian ou o Notion no painel."}
    return {"notas": res}
