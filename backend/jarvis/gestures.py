"""Gestos de atalho (poses paradas e deslizes da mão) → ações, escolhidas pela pessoa no painel (Gestos).

As poses vêm do MediaPipe (hands.py). A pinça (clicar, arrastar, ajustar) e os dois dedos (rolar) não entram
aqui: são o ponteiro, sempre iguais. Tudo roda no núcleo, então vale com o HUD escondido.
"""

import asyncio
import logging
from typing import Any

from . import store
from .hub import hub

log = logging.getLogger("jarvis.gestures")

GESTOS = {  # o que a pessoa faz → nome no painel
    "Open_Palm": "Mão aberta parada",
    "Closed_Fist": "Punho fechado",
    "Thumb_Up": "Polegar para cima",
    "Thumb_Down": "Polegar para baixo",
    "Pointing_Up": "Indicador para cima",
    "ILoveYou": "Chifrinho (polegar, indicador e mindinho)",
    "deslize_esquerda": "Deslizar a mão para a esquerda",
    "deslize_direita": "Deslizar a mão para a direita",
    "deslize_cima": "Deslizar a mão para cima",
    "deslize_baixo": "Deslizar a mão para baixo",
}
ACOES = {
    "nada": "Nada",
    "ouvir": "Falar com o Jarvis (começa a ouvir)",
    "parar": "Parar o que o Jarvis está fazendo",
    "mostrar_hud": "Mostrar o HUD",
    "minimizar_hud": "HUD para o canto",
    "fechar_cartoes": "Fechar os cartões",
    "sim": "Responder sim",
    "nao": "Responder não",
    "aba_anterior": "Aba anterior (no navegador)",
    "proxima_aba": "Próxima aba (no navegador)",
    "voltar": "Voltar a página (no navegador)",
    "avancar": "Avançar a página (no navegador)",
    "espelho": "Ligar/desligar o espelho da tela",
    "tocar_pausar": "Música: tocar ou pausar",
    "proxima_musica": "Música: próxima",
    "musica_anterior": "Música: anterior",
    "volume_mais": "Volume +10",
    "volume_menos": "Volume -10",
    "minimizar_janela": "Minimizar a janela da frente",
    "maximizar_janela": "Maximizar a janela da frente",
    "memoria": "Abrir o mapa da memória",
}
PADRAO = {
    "Open_Palm": "mostrar_hud",
    "Closed_Fist": "fechar_cartoes",
    "Thumb_Up": "sim",
    "Thumb_Down": "nao",
    "Pointing_Up": "ouvir",
    "ILoveYou": "espelho",
    "deslize_esquerda": "aba_anterior",
    "deslize_direita": "proxima_aba",
    "deslize_cima": "mostrar_hud",
    "deslize_baixo": "minimizar_hud",
}
NAVEGADOR = {"aba_anterior", "proxima_aba", "voltar", "avancar"}


def mapa() -> dict[str, str]:
    return {**PADRAO, **{k: v for k, v in (store.get("gestos") or {}).items() if k in GESTOS and v in ACOES}}


def acao_de(gesto: str) -> str:
    return mapa().get(gesto, "nada")


async def executar(acao: str) -> None:
    from . import pc, system
    from .live import voice

    try:
        if acao == "ouvir":
            await voice.start()
        elif acao == "parar":
            from . import overlay

            overlay.stop("gesto")
        elif acao == "mostrar_hud":
            hub.app_cmd("mostrar")
        elif acao == "minimizar_hud":
            hub.app_cmd("minimizar")
        elif acao == "memoria":
            hub.app_cmd("memoria", foco="")
        elif acao == "fechar_cartoes":
            await hub.clear_cards()
        elif acao in ("sim", "nao"):
            if voice.session:
                await voice.ask("Sim" if acao == "sim" else "Não")
        elif acao in NAVEGADOR:
            # só no navegador que já está na frente: deslizar a mão em outro app não deve puxar o navegador
            from .pc.common import NAVEGADORES

            frente = (pc.front_app() or "").lower()
            if frente and any(n.lower() == frente or n.lower() in frente for n in NAVEGADORES):
                from . import web

                await asyncio.to_thread(web.acao, acao)
        elif acao == "espelho":
            from .screen import espelho

            await asyncio.to_thread(espelho.stop if espelho.on else espelho.start)
        elif acao in ("tocar_pausar", "proxima_musica", "musica_anterior"):
            await asyncio.to_thread(system.media, {"proxima_musica": "proxima", "musica_anterior": "anterior"}.get(acao, acao))
        elif acao in ("volume_mais", "volume_menos"):
            await asyncio.to_thread(_volume, 10 if acao == "volume_mais" else -10)
        elif acao in ("minimizar_janela", "maximizar_janela"):
            await asyncio.to_thread(pc.janela_app, "", "minimizar" if acao == "minimizar_janela" else "maximizar")
    except Exception as exc:  # noqa: BLE001
        log.warning("gesto %s falhou: %s", acao, exc)


def _volume(delta: int) -> None:
    import subprocess
    import sys

    if sys.platform == "darwin":
        subprocess.run(["osascript", "-e", f"set volume output volume ((output volume of (get volume settings)) + {delta})"],
                       capture_output=True, timeout=5)
        return
    from pynput.keyboard import Controller, Key

    kb = Controller()
    tecla = Key.media_volume_up if delta > 0 else Key.media_volume_down
    for _ in range(max(1, abs(delta) // 2)):  # cada toque muda ~2%
        kb.press(tecla)
        kb.release(tecla)


def descrever() -> dict[str, Any]:
    return {"gestos": GESTOS, "acoes": ACOES, "mapa": mapa(), "padrao": PADRAO}
