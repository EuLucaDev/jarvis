"""Jarvis presente: sabe quando a pessoa está na frente do computador e puxa conversa por conta própria.

Presença (com a câmera ligada): um rosto ou uma mão no quadro, conferido uma vez por segundo (Vision no Mac,
detector de rosto do MediaPipe no resto). Sem ninguém por 90 s = ausente: a interface escurece e o que ele
tinha para dizer fica guardado. Voltou depois de 5 min fora = cumprimenta e conta o que guardou.

Falar sem ser chamado (ajuste "proativo", campo nivel):
  presente    (padrão) avisos, cliente que respondeu, tempo demais na mesma janela, pausa depois de muito tempo
  importante  só avisos de agenda, contas e o que for urgente
  cartao      nada de voz: cartão discreto; só urgente fala
  desligado   nada
Nunca fala no horário de silêncio dos alertas, no modo foco (o que não é urgente espera) nem com a pessoa fora.
No máximo uma fala por iniciativa a cada 6 min (urgente fura a fila).
"""

from __future__ import annotations

import asyncio
import logging
import sys
import time
from typing import Any

from . import store
from .hub import hub

log = logging.getLogger("jarvis.proativo")

AUSENTE_S = 90
VOLTOU_DEPOIS_S = 5 * 60
INTERVALO_S = 6 * 60
PAUSA_S = 100 * 60  # tempo seguido na frente do computador para sugerir uma pausa
JANELA_LONGA_S = 50 * 60


def _nivel() -> str:
    return (store.get("proativo") or {}).get("nivel", "presente")


# ---------------------------------------------------------------- presença


class Presenca:
    def __init__(self) -> None:
        self.presente = True
        self.desde = time.time()  # desde quando está presente (ou ausente)
        self.visto = time.time()  # última vez que viu alguém
        self._det = None
        self._det_falhou = False
        self._ultimo = 0.0
        self.loop: asyncio.AbstractEventLoop | None = None

    def _detector(self):
        if self._det or self._det_falhou:
            return self._det
        try:
            if sys.platform == "darwin":
                import Vision

                req = Vision.VNDetectFaceRectanglesRequest.alloc().init()
                self._det = ("vision", req)
            else:
                import mediapipe as mp
                from mediapipe.tasks.python import BaseOptions, vision

                from .hands_motor import MODELOS

                det = vision.FaceDetector.create_from_options(vision.FaceDetectorOptions(
                    base_options=BaseOptions(model_asset_path=str(MODELOS / "rosto.tflite")), min_detection_confidence=0.5))
                self._det = ("mp", (mp, det))
        except Exception as exc:  # noqa: BLE001
            log.info("sem detector de rosto (%s): presença só pelas mãos", exc)
            self._det_falhou = True
        return self._det

    def _tem_rosto(self, bgr) -> bool:
        d = self._detector()
        if not d:
            return False
        import cv2

        pequeno = cv2.resize(bgr, (480, int(480 * bgr.shape[0] / bgr.shape[1])))
        if d[0] == "vision":
            import Quartz
            import Vision

            rgba = cv2.cvtColor(pequeno, cv2.COLOR_BGR2RGBA)
            h, w = rgba.shape[:2]
            prov = Quartz.CGDataProviderCreateWithData(None, rgba.tobytes(), h * w * 4, None)
            cg = Quartz.CGImageCreate(w, h, 8, 32, w * 4, Quartz.CGColorSpaceCreateDeviceRGB(), Quartz.kCGImageAlphaNoneSkipLast,
                                      prov, None, False, Quartz.kCGRenderingIntentDefault)
            Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(cg, None).performRequests_error_([d[1]], None)
            return bool(d[1].results())
        mp, det = d[1]
        img = mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(pequeno, cv2.COLOR_BGR2RGB))
        return bool(det.detect(img).detections)

    def quadro(self, bgr, tem_mao: bool) -> None:
        """Chamado pela thread da câmera; olha no máximo uma vez por segundo."""
        agora = time.time()
        if agora - self._ultimo < 1.0:
            return
        self._ultimo = agora
        try:
            alguem = tem_mao or self._tem_rosto(bgr)
        except Exception as exc:  # noqa: BLE001
            log.debug("presença: %s", exc)
            return
        if alguem:
            self.visto = agora
        if alguem and not self.presente:
            fora = agora - self.desde
            self.presente, self.desde = True, agora
            self._evento(True, fora)
        elif not alguem and self.presente and agora - self.visto > AUSENTE_S:
            self.presente, self.desde = False, self.visto
            self._evento(False, 0)

    def camera_desligou(self) -> None:
        if not self.presente:
            self.presente, self.desde = True, time.time()
            self._evento(True, 0)

    def _evento(self, presente: bool, fora_s: float) -> None:
        if self.loop:
            asyncio.run_coroutine_threadsafe(_mudou(presente, fora_s), self.loop)


presenca = Presenca()


async def _mudou(presente: bool, fora_s: float) -> None:
    await hub.broadcast({"type": "presenca", "presente": presente})
    log.info("presença: %s", "chegou" if presente else "saiu")
    if presente and fora_s >= VOLTOU_DEPOIS_S:
        guardado, _fila[:] = list(_fila), []
        minutos = int(fora_s // 60)
        if guardado:
            await falar(f"Ele voltou depois de {minutos} minutos fora. Dê boas-vindas e conte em poucas frases o que "
                        f"aconteceu: " + "; ".join(guardado[:6]), urgente=True, guardar=False)
        elif _nivel() == "presente":
            await falar(f"Ele acabou de voltar para o computador depois de {minutos} minutos fora. "
                        "Dê boas-vindas em uma frase curta, sem perguntar nada.", urgente=True, guardar=False)


# ---------------------------------------------------------------- falar por iniciativa

_fila: list[str] = []  # o que ficou para depois (pessoa fora, intervalo, foco)
_ultima_fala = 0.0


def _pode_falar(urgente: bool) -> str | None:
    """None = pode; senão o motivo para guardar."""
    from . import alerts

    if not presenca.presente:
        return "fora"
    if alerts._quiet(alerts._cfg()):  # noqa: SLF001
        return "silencio"
    if hub.focus_until and time.time() < hub.focus_until and not urgente:
        return "foco"
    if not urgente and time.time() - _ultima_fala < INTERVALO_S:
        return "intervalo"
    return None


async def falar(texto: str, urgente: bool = False, guardar: bool = True, categoria: str = "geral") -> bool:
    """Fala por iniciativa própria (ou guarda para depois). Devolve se falou."""
    global _ultima_fala
    from .live import voice

    nivel = _nivel()
    if nivel == "desligado":
        return False
    if nivel == "importante" and not urgente and categoria not in ("aviso", "agenda", "financeiro"):
        return False
    if nivel == "cartao" and not urgente:
        await hub.broadcast({"type": "sugestao", "id": f"p{int(time.time())}", "texto": texto[:160], "pedido": texto})
        return False
    motivo = _pode_falar(urgente)
    if motivo:
        if guardar and motivo in ("fora", "intervalo"):
            _fila[:] = (_fila + [texto])[-10:]
        return False
    _ultima_fala = time.time()
    msg = ("[Aviso do sistema, não é o usuário falando. Fale com ele por iniciativa sua, em uma ou duas frases "
           f"naturais, no seu estilo, sem ler isto ao pé da letra.] {texto}")
    try:
        if voice.session:
            await voice.send_text(msg)
        else:
            await voice.ask(msg)
        return True
    except Exception as exc:  # noqa: BLE001
        log.warning("não consegui falar por iniciativa: %s", exc)
        return False


# ---------------------------------------------------------------- o que vale puxar conversa

_ditos: set[str] = set()
_notif_vistas: set[str] = set()
_notif_primeira = True


async def _janela_longa() -> None:
    from . import activity

    if not activity._last or time.time() - activity._since < JANELA_LONGA_S:  # noqa: SLF001
        return
    app, janela = activity._last  # noqa: SLF001
    chave = f"longa:{app}:{janela}:{time.strftime('%Y-%m-%d')}"
    if chave in _ditos:
        return
    _ditos.add(chave)
    minutos = int((time.time() - activity._since) // 60)  # noqa: SLF001
    await falar(f"Ele está há {minutos} minutos seguidos em {app} ({janela[:60]}). Ofereça ajuda concreta para terminar "
                "isso ou sugira uma pausa curta, em uma frase.")


async def _pausa() -> None:
    if not presenca.presente or time.time() - presenca.desde < PAUSA_S:
        return
    chave = f"pausa:{int(presenca.desde)}"
    if chave in _ditos:
        return
    _ditos.add(chave)
    horas = (time.time() - presenca.desde) / 3600
    await falar(f"Ele está há {horas:.1f} horas na frente do computador sem sair. Sugira com leveza uma pausa de "
                "alguns minutos (água, alongar), em uma frase.")


async def _sistemas() -> None:
    """Novidades nos sistemas conectados (ex.: cliente que respondeu no WorkFlow)."""
    global _notif_primeira
    from . import sistemas

    for s in sistemas.lista():
        if not s.get("ativo", True):
            continue
        c = await sistemas.carregar(s)
        if not any(f["name"] == "notificacoes" for f in c.get("ferramentas", [])):
            continue
        r = await sistemas.executar(f"{s['prefixo']}__notificacoes", {"acao": "ver"})
        itens = r.get("resultado") if r.get("ok") else None
        if not isinstance(itens, list):
            continue
        novas = []
        for n in itens:
            chave = f"{s['id']}:{n.get('titulo')}:{n.get('quando')}"
            if chave not in _notif_vistas and not n.get("lida"):
                _notif_vistas.add(chave)
                novas.append(n)
        if _notif_primeira:
            continue  # o que já estava lá quando o Jarvis abriu não vira fala
        if novas:
            resumo = "; ".join(f"{n.get('titulo')}" + (f" ({n.get('quem')})" if n.get("quem") else "") for n in novas[:4])
            if not presenca.presente:  # fora do computador: a novidade vai para o Telegram
                from . import telegram

                if await telegram.avisar(f"Novidade no {s['nome']}", resumo):
                    continue
            await falar(f"Chegou novidade no {s['nome']}: {resumo}. Conte em uma frase e pergunte se ele quer ver.",
                        categoria="sistema")
    _notif_primeira = False


async def loop() -> None:
    await asyncio.sleep(45)
    tick = 0
    while True:
        try:
            if _nivel() == "presente":
                await _janela_longa()
                await _pausa()
            if tick % 3 == 0 and _nivel() in ("presente", "importante", "cartao"):
                await _sistemas()
            # o que ficou guardado pelo intervalo sai quando der
            if _fila and presenca.presente and _pode_falar(False) is None:
                guardado, _fila[:] = list(_fila), []
                await falar("Coisas que ficaram para depois: " + "; ".join(guardado[:5]), guardar=False)
        except Exception as exc:  # noqa: BLE001 - laço de fundo não pode morrer
            log.warning("proativo: %s", exc)
        tick += 1
        await asyncio.sleep(60)


def descrever() -> dict[str, Any]:
    return {"nivel": _nivel(), "presente": presenca.presente, "desde": presenca.desde, "guardado": len(_fila)}
