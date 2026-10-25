"""Tarefas passadas a outras IAs do Luca, que rodam no Mac com a assinatura dele.

- claude: Claude Code (`claude -p`), com os MCPs dele (ElevenLabs, Google Drive, Canva…) para criar coisas.
- codex: Codex CLI (`codex exec`) logado com o ChatGPT; escreve só dentro da pasta da tarefa.
- chatgpt: pergunta rápida ao ChatGPT pelo Codex, só leitura; a resposta volta falada.

Cada tarefa ganha uma pasta própria em ~/Jarvis/Tarefas, e é só lá que os agentes podem escrever. Nada de
comando livre: o Claude Code roda sem Bash (só edição de arquivos e as ferramentas liberadas), e o Codex roda
no sandbox dele. Quando termina, o Jarvis avisa em voz e mostra o resultado num cartão.
"""

import asyncio
import datetime as dt
import logging
import os
import re
import shutil
import time
import unicodedata
import uuid
from pathlib import Path
from typing import Any

from . import store
from .hub import hub

log = logging.getLogger("jarvis.agents")

ROOT = Path.home() / "Jarvis" / "Tarefas"
LIMITE_S = {"claude": 20 * 60, "codex": 20 * 60, "chatgpt": 4 * 60}
NOMES = {"claude": "Claude Code", "codex": "Codex", "chatgpt": "ChatGPT"}
_procs: dict[str, asyncio.subprocess.Process] = {}
# o serviço (launchd) não herda o PATH do terminal; os CLIs costumam morar nestes lugares
_PATH = os.pathsep.join([
    str(Path.home() / ".local" / "bin"), "/opt/homebrew/bin", "/usr/local/bin", os.environ.get("PATH", "/usr/bin:/bin"),
])


def _which(nome: str) -> str | None:
    return shutil.which(nome, path=_PATH)


def disponiveis() -> dict[str, bool]:
    return {"claude": bool(_which("claude")), "codex": bool(_which("codex")), "chatgpt": bool(_which("codex"))}


def _slug(texto: str) -> str:
    sem_acento = unicodedata.normalize("NFD", texto.lower()).encode("ascii", "ignore").decode()
    s = re.sub(r"[^a-z0-9]+", "-", sem_acento).strip("-")
    return s[:40] or "tarefa"


def _cmd(agente: str, tarefa: str, pasta: Path) -> list[str]:
    cfg = store.get("agentes")
    if agente == "claude":
        ferramentas = ["Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "WebFetch", *cfg.get("claude_ferramentas", [])]
        return [
            _which("claude") or "claude", "-p", tarefa,
            "--output-format", "text",
            "--permission-mode", "acceptEdits",
            "--allowedTools", *ferramentas,
        ]
    sandbox = "read-only" if agente == "chatgpt" else "workspace-write"
    # o modelo do config.toml pode não valer para login do ChatGPT; este vale
    modelo = cfg.get("codex_modelo") or "gpt-5.6-sol"
    esforco = "low" if agente == "chatgpt" else "medium"
    return [
        _which("codex") or "codex", "exec", "-m", modelo, "-c", f'model_reasoning_effort="{esforco}"',
        "--skip-git-repo-check", "--sandbox", sandbox, "-C", str(pasta),
        "-o", str(pasta / "resposta.md"),
        tarefa,
    ]


def _prompt(agente: str, tarefa: str) -> str:
    if agente == "chatgpt":
        return f"Responda em português do Brasil, direto e em até 8 frases. Não crie nem altere arquivos.\n\n{tarefa}"
    return (
        f"{tarefa}\n\n"
        "Regras: trabalhe só nesta pasta. Salve aqui o que criar (arquivos, imagens, áudios, textos). "
        "No fim, responda em português do Brasil com um resumo de até 3 frases do que fez e onde ficou."
    )


async def iniciar(agente: str, tarefa: str, titulo: str | None = None) -> dict[str, Any]:
    if agente not in NOMES:
        return {"erro": f"Agente desconhecido: {agente}. Use claude, codex ou chatgpt."}
    if not disponiveis()[agente]:
        return {"erro": f"{NOMES[agente]} não está instalado neste Mac."}
    tid = uuid.uuid4().hex[:6]
    titulo = (titulo or tarefa)[:80]
    pasta = ROOT / f"{dt.date.today().isoformat()}-{_slug(titulo)}-{tid}"
    pasta.mkdir(parents=True, exist_ok=True)
    # repositório próprio: sem ele o git sobe até a pasta pessoal (que é um repo) e o agente trava varrendo tudo
    git = await asyncio.create_subprocess_exec("git", "init", "-q", cwd=pasta, env={**os.environ, "PATH": _PATH})
    await git.wait()
    (pasta / "pedido.md").write_text(f"# {titulo}\n\nAgente: {NOMES[agente]}\n\n{tarefa}\n")
    t = {"id": tid, "agente": agente, "titulo": titulo, "estado": "rodando", "pasta": str(pasta), "inicio": time.strftime("%H:%M")}
    hub.tasks = ([t] + hub.tasks)[:12]
    await hub.broadcast({"type": "tarefa", "tarefa": t})
    asyncio.create_task(_rodar(t, agente, _prompt(agente, tarefa), pasta))
    return {"ok": True, "tarefa": tid, "agente": NOMES[agente], "pasta": str(pasta)}


async def _rodar(t: dict[str, Any], agente: str, prompt: str, pasta: Path) -> None:
    saida, erro = "", ""
    try:
        proc = await asyncio.create_subprocess_exec(
            *_cmd(agente, prompt, pasta), cwd=pasta, env={**os.environ, "PATH": _PATH},
            stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        _procs[t["id"]] = proc
        out, err = await asyncio.wait_for(proc.communicate(), LIMITE_S[agente])
        saida, erro = out.decode(errors="replace").strip(), err.decode(errors="replace").strip()
        resposta = pasta / "resposta.md"
        if resposta.exists() and resposta.read_text().strip():
            saida = resposta.read_text().strip()  # codex: só a mensagem final, sem o log
        ok = proc.returncode == 0 and bool(saida)
    except TimeoutError:
        _procs.get(t["id"]) and _procs[t["id"]].kill()
        ok, erro = False, "passou do tempo limite"
    except Exception as exc:  # noqa: BLE001
        ok, erro = False, str(exc)
    finally:
        _procs.pop(t["id"], None)
    if saida:
        (pasta / "resultado.md").write_text(saida + "\n")
    if erro:
        (pasta / "registro.log").write_text(erro[-20000:] + "\n")
    if not ok:
        # o log do Codex começa com cabeçalho; o que interessa é a linha de erro
        linhas = [x for x in erro.splitlines() if "ERROR" in x or "error" in x.lower()]
        erro = (linhas[-1] if linhas else erro[-300:]).strip()
    t.update(estado="feito" if ok else "erro", resumo=_curto(saida if ok else (erro or saida or "sem resposta")))
    await hub.broadcast({"type": "tarefa", "tarefa": t})
    log.info("tarefa %s (%s) terminou: %s", t["id"], agente, t["estado"])
    await _avisar(t, agente, saida if ok else "", erro)


def _curto(texto: str, n: int = 160) -> str:
    linha = " ".join(texto.split())
    return linha if len(linha) <= n else linha[: n - 1] + "…"


async def _avisar(t: dict[str, Any], agente: str, saida: str, erro: str) -> None:
    nome = NOMES[agente]
    if saida:
        await hub.show_card("pesquisa", {
            "categoria": f"Tarefa · {nome}",
            "titulo": t["titulo"],
            "resumo": saida[:1500],
            "referencia": f"Pasta: {t['pasta']}" if agente != "chatgpt" else f"Resposta do {nome}",
        })
    from .live import voice as bridge

    if bridge and bridge.session:
        if saida:
            texto = (
                f"[Aviso do sistema, não é o usuário falando. A tarefa que você passou ao {nome} terminou. "
                f"Conte o resultado em até 3 frases; o cartão já está na tela.] {t['titulo']}: {saida[:2500]}"
            )
        else:
            texto = f"[Aviso do sistema, não é o usuário falando. A tarefa passada ao {nome} falhou; diga em uma frase.] {t['titulo']}: {erro[:300]}"
        await bridge.send_text(texto)
        return
    from . import alerts

    await alerts.notify(f"Tarefa · {nome}", _curto(saida or f"Falhou: {erro}", 120), "info" if saida else "alta", falar=False)


async def cancelar(tid: str) -> bool:
    p = _procs.get(tid)
    if not p:
        return False
    p.kill()
    return True
