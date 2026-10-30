"""Gestos de atalho → ações, escolhidas pela pessoa no painel (Gestos).

Disponíveis: microgestos do polegar no indicador (Quest), pinça do dedo médio (pulseira da Meta), poses paradas
e deslizes da mão inteira. Começam todos desligados: menos gesto ligado = menos ação sem querer.
A pinça do indicador (selecionar, arrastar, rolar, menu da palma, girar) não entra aqui: é o ponteiro, sempre
igual (handControl.ts). Tudo roda no núcleo, então vale com o HUD escondido.
"""

import asyncio
import logging
from typing import Any

from . import store
from .hub import hub

log = logging.getLogger("jarvis.gestures")

GESTOS = {  # o que a pessoa faz → nome no painel
    "polegar_toque": "Toque do polegar no lado do indicador (mão fechada)",
    "polegar_duplo": "Toque duplo do polegar no indicador",
    "polegar_frente": "Polegar desliza no indicador, para a ponta",
    "polegar_tras": "Polegar desliza no indicador, para a base",
    "medio_toque": "Pinça do polegar com o dedo médio",
    "medio_duplo": "Pinça dupla com o dedo médio",
    "medio_segurar": "Segurar a pinça com o dedo médio",
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
    "voltar_contexto": "Voltar (fecha o cartão mais novo ou volta a página)",
    "alternar_hud": "Mostrar ou esconder o HUD",
    "trocar_app": "Trocar de app (como Cmd+Tab / Alt+Tab)",
    "rolar_cima": "Rolar para cima",
    "rolar_baixo": "Rolar para baixo",
    "ver_tela": "O Jarvis olha a sua tela",
}
PADRAO = {  # tudo desligado de início: o dia a dia é o ponteiro (handControl.ts); a pessoa liga o que quiser
    **{g: "nada" for g in GESTOS},
}
NAVEGADOR = {"aba_anterior", "proxima_aba", "voltar", "avancar"}


# padrões de antes da 2.8 (poses, deslizes e, na 2.7, microgestos ligados): o painel salvava o mapa inteiro, então quem nunca mexeu
# guardou estes valores; eles não valem mais como escolha da pessoa
_ANTIGO_27 = {"polegar_toque": "tocar_pausar", "polegar_duplo": "ouvir", "polegar_frente": "rolar_baixo",
              "polegar_tras": "rolar_cima", "medio_toque": "voltar_contexto", "medio_duplo": "alternar_hud",
              "medio_segurar": "trocar_app"}
_ANTIGO = {"Open_Palm": "mostrar_hud", "Closed_Fist": "fechar_cartoes", "Thumb_Up": "sim", "Thumb_Down": "nao",
           "Pointing_Up": "ouvir", "ILoveYou": "espelho", "deslize_esquerda": "aba_anterior",
           "deslize_direita": "proxima_aba", "deslize_cima": "mostrar_hud", "deslize_baixo": "minimizar_hud"}


def mapa() -> dict[str, str]:
    salvo = store.get("gestos") or {}
    return {**PADRAO, **{k: v for k, v in salvo.items() if k in GESTOS and v in ACOES and _ANTIGO.get(k) != v and _ANTIGO_27.get(k) != v}}


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
        elif acao == "ver_tela":
            from .screen import foto

            if not voice.session:
                await voice.start()
                for _ in range(40):
                    if voice.session:
                        break
                    await asyncio.sleep(0.25)
            img = await asyncio.to_thread(foto, False)
            if img and voice.session:
                await voice.send_image(img)
                await voice.ask("[Aviso do sistema] Ele pediu pelo gesto para você olhar a tela dele; a imagem acabou "
                                "de chegar. Diga numa frase o que vê e pergunte como pode ajudar.")
        elif acao == "alternar_hud":
            hub.app_cmd("alternar")
        elif acao == "voltar_contexto":
            if hub.cards:
                await hub.close_card(hub.cards[-1]["id"])
            else:
                from .pc.common import NAVEGADORES

                frente = (pc.front_app() or "").lower()
                if frente and any(n.lower() == frente or n.lower() in frente for n in NAVEGADORES):
                    from . import web

                    await asyncio.to_thread(web.acao, "voltar")
        elif acao == "trocar_app" and pc.permitido():
            await asyncio.to_thread(pc.press, "cmd+tab" if pc.SISTEMA == "mac" else "alt+tab")
        elif acao in ("rolar_cima", "rolar_baixo") and pc.permitido():
            await asyncio.to_thread(pc.scroll, 320 if acao == "rolar_cima" else -320)
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
