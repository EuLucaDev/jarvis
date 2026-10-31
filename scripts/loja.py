#!/usr/bin/env python3
"""Publica uma versão na loja do Jarvis (jarvis.agcunae.com), só com a biblioteca padrão do Python.

  loja.py publicar --produto jarvis --sistema mac --versao 2.10.0 --raiz caminho/Jarvis.app [--notas "..."]
  loja.py publicar --produto instalador --sistema mac --versao 1.0.0 --arquivo "Instalar Jarvis Launcher.pkg"

Monta o manifesto (cada arquivo com o sha256, o tamanho e se é executável; links simbólicos como links), pergunta à
loja quais arquivos ela ainda não tem, envia só esses e publica. Variáveis: LOJA_URL e LOJA_TOKEN.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import stat
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path


def sha256(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for bloco in iter(lambda: f.read(1 << 20), b""):
            h.update(bloco)
    return h.hexdigest()


def manifesto(raiz: Path) -> list[dict]:
    """Todos os arquivos e links da pasta (caminhos com /, em ordem)."""
    itens = []
    for p in sorted(raiz.rglob("*")):
        rel = p.relative_to(raiz).as_posix()
        if p.is_symlink():
            itens.append({"caminho": rel, "link": os.readlink(p)})
        elif p.is_file():
            modo = p.stat().st_mode
            itens.append({"caminho": rel, "sha": sha256(p), "tamanho": p.stat().st_size,
                          "exec": bool(modo & (stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH))})
    return itens


def chamar(metodo: str, caminho: str, corpo: bytes | None = None, arquivo: Path | None = None) -> dict:
    url = os.environ["LOJA_URL"].rstrip("/") + caminho
    headers = {"x-loja-token": os.environ["LOJA_TOKEN"], "content-type": "application/json"}
    if arquivo:
        headers["content-type"] = "application/octet-stream"
        headers["content-length"] = str(arquivo.stat().st_size)
    for tentativa in range(5):
        try:
            if arquivo:
                with arquivo.open("rb") as f:
                    req = urllib.request.Request(url, data=f, method=metodo, headers=headers)
                    with urllib.request.urlopen(req, timeout=600) as r:
                        return json.loads(r.read() or b"{}")
            req = urllib.request.Request(url, data=corpo, method=metodo, headers=headers)
            with urllib.request.urlopen(req, timeout=600) as r:
                return json.loads(r.read() or b"{}")
        except Exception as exc:  # noqa: BLE001
            if tentativa == 4:
                raise
            print(f"  tentando de novo ({exc})", file=sys.stderr)
    return {}


def publicar(a: argparse.Namespace) -> None:
    if a.arquivo:
        f = Path(a.arquivo)
        itens = [{"caminho": f.name, "sha": sha256(f), "tamanho": f.stat().st_size, "exec": False}]
        locais = {itens[0]["sha"]: f}
    else:
        raiz = Path(a.raiz)
        itens = manifesto(raiz)
        locais = {i["sha"]: raiz / i["caminho"] for i in itens if "sha" in i}
    total = sum(i.get("tamanho", 0) for i in itens)
    print(f"{a.produto}/{a.sistema} {a.versao}: {len(itens)} itens, {total / 1e6:.0f} MB")
    faltam = chamar("POST", "/api/loja/preparar", json.dumps({"hashes": sorted(locais)}).encode())["faltam"]
    print(f"  a loja não tem {len(faltam)} arquivos ({sum(locais[h].stat().st_size for h in faltam) / 1e6:.0f} MB); enviando")
    with ThreadPoolExecutor(6) as ex:
        for _ in ex.map(lambda h: chamar("PUT", f"/api/loja/objeto/{h}", arquivo=locais[h]), faltam):
            pass
    corpo = {"produto": a.produto, "sistema": a.sistema, "versao": a.versao, "notas": a.notas or "", "arquivos": itens}
    chamar("POST", "/api/loja/publicar", json.dumps(corpo).encode())
    print("  publicado")


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("publicar")
    p.add_argument("--produto", required=True, choices=["jarvis", "launcher", "instalador"])
    p.add_argument("--sistema", required=True, choices=["mac", "windows", "linux"])
    p.add_argument("--versao", required=True)
    p.add_argument("--raiz")
    p.add_argument("--arquivo")
    p.add_argument("--notas", default="")
    a = ap.parse_args()
    if not os.getenv("LOJA_URL") or not os.getenv("LOJA_TOKEN"):
        print("sem LOJA_URL/LOJA_TOKEN: nada publicado")
        return
    publicar(a)


if __name__ == "__main__":
    main()
