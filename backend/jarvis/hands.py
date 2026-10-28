"""Mãos pela câmera, no núcleo (fora da interface): MediaPipe Gesture Recognizer, até duas mãos, 30 quadros/s.

Cada quadro vira, para as telas:
  {"type": "maos", "hands": [{x, y, pinch, spread, pose, palm}], "pts": [...]}   (pts = esqueleto, a cada 2 quadros)
  {"type": "gesto", "acao": "...", "rotulo": "..."}                             (deslizes e poses paradas)
x/y: o ponteiro, pela base do indicador e do dedo médio (os nós dos dedos não se mexem ao fazer a pinça,
então o ponteiro fica parado na hora do clique); espelhado e esticado para a tela inteira (0..1).
ax/ay (só com pinça): onde o ponteiro estava logo ANTES da pinça começar, que é onde o clique deve cair.
A pinça só conta firme (~100 ms, com histerese); mãos pequenas ou duvidosas são ignoradas.
A câmera também serve para a Gemini "ver" (último quadro em JPEG).
"""

import asyncio
import logging
import math
import threading
import time
from typing import Any

from . import store
from .config import CODE_ROOT
from .hub import hub

log = logging.getLogger("jarvis.hands")

MODELO = CODE_ROOT / "models" / "gesture_recognizer.task"
AREA = (0.18, 0.82, 0.22, 0.78)  # miolo do quadro da câmera que vira a tela inteira (x0, x1, y0, y1)

POSES = {  # pose → segundos parada para valer (a ação de cada uma é escolhida no painel: gestures.py)
    "Open_Palm": 1.4,
    "Closed_Fist": 0.7,
    "Thumb_Up": 0.6,
    "Thumb_Down": 0.6,
    "Pointing_Up": 1.3,  # mais tempo: apontar parado também acontece ao mirar
    "ILoveYou": 0.8,
}


def _clamp(v: float) -> float:
    return min(1.0, max(0.0, v))


def _dist(a, b) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


def _tela(p) -> tuple[float, float]:
    x0, x1, y0, y1 = AREA
    return _clamp((p[0] - x0) / (x1 - x0)), _clamp((p[1] - y0) / (y1 - y0))


class Hands:
    def __init__(self) -> None:
        self.loop: asyncio.AbstractEventLoop | None = None
        self.on = False
        self.erro: str | None = None
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._jpeg: bytes | None = None
        self.viewers = 0
        self.area = (0.0, 0.0, 1920.0, 1080.0)  # área de trabalho inteira (todos os monitores), revista a cada 5 s
        self._area_em = 0.0  # telas mostrando o vídeo ao vivo (aí o JPEG sai a cada quadro, não a cada segundo)
        self.state: dict[str, dict[str, Any]] = {}
        self.pose = ""
        self.pose_since = 0.0
        self.pose_anchor = (0.0, 0.0)
        self.cooldown = 0.0

    def bind(self, loop: asyncio.AbstractEventLoop) -> None:
        self.loop = loop
        if store.get("camera").get("ligada", True):
            self.start()

    def start(self) -> None:
        if self.on:
            self._emit({"type": "camera", "ligada": True, "erro": self.erro})
            return
        self._stop.clear()
        self.on = True
        self._thread = threading.Thread(target=self._run, daemon=True, name="maos")
        self._thread.start()
        self._emit({"type": "camera", "ligada": True})

    def stop(self) -> None:
        self._stop.set()
        self.on = False
        self._emit({"type": "camera", "ligada": False})
        self._emit({"type": "maos", "hands": [], "pts": []})

    def latest_jpeg(self) -> bytes | None:
        return self._jpeg

    def _emit(self, msg: dict[str, Any]) -> None:
        if self.loop:
            asyncio.run_coroutine_threadsafe(hub.broadcast(msg), self.loop)

    def _run(self) -> None:
        try:
            import cv2
            import mediapipe as mp
            from mediapipe.tasks.python import BaseOptions, vision
        except Exception as exc:  # noqa: BLE001
            self.erro = f"reconhecimento das mãos indisponível: {exc}"
            self.on = False
            return
        cap = cv2.VideoCapture(0)
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
        if not cap.isOpened():
            self.erro = "Não consegui abrir a câmera (está em uso ou sem permissão)."
            self.on = False
            self._emit({"type": "camera", "ligada": False, "erro": self.erro})
            return
        rec = vision.GestureRecognizer.create_from_options(vision.GestureRecognizerOptions(
            base_options=BaseOptions(model_asset_path=str(MODELO)), running_mode=vision.RunningMode.VIDEO, num_hands=2,
            min_hand_detection_confidence=0.6, min_tracking_confidence=0.5,
        ))
        self.erro = None
        log.info("câmera e mãos no ar")
        t0 = time.monotonic()
        quadro = 0
        ultimo_jpeg = 0.0
        tinha_mao = False
        try:
            while not self._stop.is_set():
                ok, frame = cap.read()
                if not ok:
                    time.sleep(0.05)
                    continue
                agora = time.monotonic()
                if agora - ultimo_jpeg > (0.06 if self.viewers else 1.0):  # vídeo ao vivo ou um quadro por segundo para a Gemini
                    ultimo_jpeg = agora
                    ok2, buf = cv2.imencode(".jpg", cv2.flip(frame, 1), [cv2.IMWRITE_JPEG_QUALITY, 70])
                    self._jpeg = buf.tobytes() if ok2 else None
                if agora - self._area_em > 5:  # monitor plugado ou tirado: a mão passa a alcançar a área nova
                    self._area_em = agora
                    try:
                        from . import pc

                        self.area = pc.desktop_bounds()
                    except Exception:  # noqa: BLE001
                        pass
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                res = rec.recognize_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb), int((agora - t0) * 1000))
                hands, pts = self._process(res, agora)
                quadro += 1
                if hands or tinha_mao:
                    self._emit({"type": "maos", "hands": hands, "pts": pts if quadro % 2 == 0 else None})
                tinha_mao = bool(hands)
                espera = 1 / 30 - (time.monotonic() - agora)
                if espera > 0:
                    time.sleep(espera)
        finally:
            rec.close()
            cap.release()
            log.info("câmera desligada")

    def _process(self, res, agora: float) -> tuple[list[dict[str, Any]], list[list[list[float]]]]:
        hands: list[dict[str, Any]] = []
        pts_all: list[list[list[float]]] = []
        vistas = set()
        for i, lm in enumerate(res.hand_landmarks or []):
            hd = res.handedness[i][0] if res.handedness and i < len(res.handedness) and res.handedness[i] else None
            key = hd.category_name if hd else f"m{i}"
            pts = [(1 - p.x, p.y) for p in lm]  # espelhado, como num espelho
            tamanho = _dist(pts[0], pts[9])
            if key in vistas or tamanho < 0.07 or (hd and hd.score < 0.7):
                continue  # mão pequena (no fundo) ou duvidosa: era o que "pegava" do nada
            vistas.add(key)
            bruto = _tela(((pts[5][0] + pts[9][0]) / 2, (pts[5][1] + pts[9][1]) / 2))
            palma = _tela((sum(pts[j][0] for j in (0, 5, 9, 13, 17)) / 5, sum(pts[j][1] for j in (0, 5, 9, 13, 17)) / 5))
            s = self.state.get(key)
            if not s:
                s = {"x": bruto[0], "y": bruto[1], "px": palma[0], "py": palma[1], "pinch": False, "raw": False, "since": agora,
                     "spread": 1.0, "seen": agora, "trail": [], "hist": [], "ax": bruto[0], "ay": bruto[1]}
                self.state[key] = s
            vel = math.hypot(bruto[0] - s["x"], bruto[1] - s["y"])
            if vel > 0.0025:  # zona morta: a mão parada não faz o ponteiro tremer
                a = min(0.85, max(0.18, vel * 9))  # devagar = suave e preciso, rápido = sem atraso
                s["x"] += (bruto[0] - s["x"]) * a
                s["y"] += (bruto[1] - s["y"]) * a
            s["hist"] = [p for p in s["hist"] if agora - p[0] < 0.5] + [(agora, s["x"], s["y"])]
            s["px"] += (palma[0] - s["px"]) * 0.5
            s["py"] += (palma[1] - s["py"]) * 0.5
            d = _dist(pts[4], pts[8]) / (tamanho or 1)
            s["spread"] += (d - s["spread"]) * 0.5
            quer = d < 0.4 if s["raw"] else d < 0.25  # histerese
            if quer != s["raw"]:
                s["raw"], s["since"] = quer, agora
            if s["raw"] != s["pinch"] and agora - s["since"] > (0.08 if s["raw"] else 0.07):
                s["pinch"] = s["raw"]
                if s["pinch"]:  # o clique vale onde o ponteiro estava antes dos dedos começarem a fechar
                    antes = [p for p in s["hist"] if p[0] <= s["since"] - 0.06]
                    _, s["ax"], s["ay"] = antes[-1] if antes else (0, s["x"], s["y"])
            pose = ""
            if res.gestures and i < len(res.gestures) and res.gestures[i] and res.gestures[i][0].score > 0.65:
                pose = res.gestures[i][0].category_name
            s["trail"] = [t for t in s["trail"] if agora - t[2] < 0.32] + [(s["px"], s["py"], agora)]
            pinca = s["pinch"] and agora - s["seen"] > 0.25  # mão recém-chegada não clica
            dx, dy, dw, dh = self.area
            mao = {"key": key, "x": round(s["x"], 4), "y": round(s["y"], 4), "pinch": pinca, "spread": round(s["spread"], 3),
                   "pose": pose, "palm": [round(s["px"], 4), round(s["py"], 4)],
                   # ponto na área de trabalho inteira (todos os monitores), em pontos globais: cada camada pega o seu
                   "gx": round(dx + s["x"] * dw, 1), "gy": round(dy + s["y"] * dh, 1)}
            if pinca:
                mao["ax"], mao["ay"] = round(s["ax"], 4), round(s["ay"], 4)
                mao["gax"], mao["gay"] = round(dx + s["ax"] * dw, 1), round(dy + s["ay"] * dh, 1)
            hands.append(mao)
            pts_all.append([[round(x, 3), round(y, 3)] for x, y in pts])
        for k in list(self.state):
            if k not in vistas:
                del self.state[k]
        hands.sort(key=lambda h: 0 if h["key"] == "Right" else 1)  # mão principal primeiro
        self._gestures(hands, agora)
        return hands, pts_all

    def _gestures(self, hands: list[dict[str, Any]], agora: float) -> None:
        h = hands[0] if len(hands) == 1 else None
        s = self.state.get(h["key"]) if h else None
        # deslize: mão aberta, sem pinça, andou muito em pouco tempo
        if h and s and not h["pinch"] and len(s["trail"]) > 3 and h["pose"] in ("Open_Palm", ""):
            fx, fy, _ = s["trail"][0]
            dx, dy = s["px"] - fx, s["py"] - fy
            if abs(dx) > 0.3 and abs(dx) > abs(dy) * 1.8:
                s["trail"] = []
                self._acao("deslize_esquerda" if dx < 0 else "deslize_direita", agora)
            elif abs(dy) > 0.28 and abs(dy) > abs(dx) * 1.8:
                s["trail"] = []
                self._acao("deslize_cima" if dy < 0 else "deslize_baixo", agora)
        # pose parada
        nome = h["pose"] if h and not h["pinch"] else ""
        if nome != self.pose:
            self.pose, self.pose_since = nome, agora
            self.pose_anchor = tuple(h["palm"]) if h else (0.0, 0.0)
        elif nome in POSES and h:
            if _dist(h["palm"], self.pose_anchor) > 0.06:
                self.pose_since, self.pose_anchor = agora, tuple(h["palm"])
            elif agora - self.pose_since >= POSES[nome]:
                self.pose_since = agora + 1000  # exige soltar e repetir
                self._acao(nome, agora, 1.6)

    def _acao(self, gesto: str, agora: float, espera: float = 0.9) -> None:
        from . import gestures

        if agora < self.cooldown:
            return
        acao = gestures.acao_de(gesto)
        if acao == "nada":
            return
        self.cooldown = agora + espera
        rotulo = f"{gestures.GESTOS[gesto]} · {gestures.ACOES[acao]}"
        self._emit({"type": "gesto", "gesto": gesto, "acao": acao, "rotulo": rotulo})
        if self.loop:
            asyncio.run_coroutine_threadsafe(gestures.executar(acao), self.loop)


hands = Hands()
