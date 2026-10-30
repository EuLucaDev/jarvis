"""Mãos pela câmera, no núcleo (fora da interface): MediaPipe Gesture Recognizer, até duas mãos, 30 quadros/s.

O modelo de interação é o da Meta (Quest e a pulseira neural dos óculos Ray-Ban Display), adaptado à câmera:
  - ponteiro filtrado (filtro One Euro, como no Quest) e cursor que fecha conforme a pinça (`forca` 0..1);
  - pinça do indicador = selecionar; o resto (arrastar, rolar, menu da palma, girar) fica em handControl.ts;
  - costas da mão para a câmera = palma virada para você (`costas`): o botão do menu aparece na mão;
  - microgestos com a mão fechada: toque do polegar no lado do indicador (simples e duplo) e deslize do
    polegar ao longo dele (para a ponta / para trás);
  - pinça do polegar com o dedo médio: toque (voltar), toque duplo (mostrar/esconder o HUD), segurar (trocar
    de app);
  - `torcao`: o giro do punho, em graus, para o "pinçar e girar" (volume).

Cada quadro vira, para as telas:
  {"type": "maos", "hands": [{x, y, pinch, forca, costas, torcao, micro, spread, pose, palm}], "pts": [...]}
  {"type": "gesto", "acao": "...", "rotulo": "..."}      (microgestos, pinça do médio, deslizes e poses paradas)
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
LARG, ALT = AREA[1] - AREA[0], AREA[3] - AREA[2]

TOQUE_S = 0.35  # contato do polegar (ou do médio) até aqui = toque
DUPLO_S = 0.38  # segundo toque dentro disto = toque duplo
SEGURAR_S = 0.7  # pinça do médio mantida = segurar

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


def _seg(p, a, b) -> tuple[float, float]:
    """Distância de p ao segmento a→b e onde cai nele (0 = a, 1 = b)."""
    vx, vy = b[0] - a[0], b[1] - a[1]
    n = vx * vx + vy * vy or 1e-9
    t = ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / n
    tc = min(1.0, max(0.0, t))
    return math.hypot(p[0] - a[0] - vx * tc, p[1] - a[1] - vy * tc), t


class OneEuro:
    """Filtro One Euro (Casiez et al.): parado, corta o tremor; rápido, segue sem atraso."""

    def __init__(self, mincut: float = 1.2, beta: float = 18.0, dcut: float = 1.0) -> None:
        self.mincut, self.beta, self.dcut = mincut, beta, dcut
        self.x: float | None = None
        self.dx = 0.0
        self.t = 0.0

    @staticmethod
    def _a(cut: float, dt: float) -> float:
        r = 2 * math.pi * cut * dt
        return r / (r + 1)

    def __call__(self, x: float, t: float) -> float:
        if self.x is None:
            self.x, self.t = x, t
            return x
        dt = max(1e-3, t - self.t)
        self.t = t
        dx = (x - self.x) / dt
        self.dx += (dx - self.dx) * self._a(self.dcut, dt)
        self.x += (x - self.x) * self._a(self.mincut + self.beta * abs(self.dx), dt)
        return self.x


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
        self.centro = ((AREA[0] + AREA[1]) / 2, (AREA[2] + AREA[3]) / 2)  # "recentrar" muda o miolo da câmera

    def _tela(self, p) -> tuple[float, float]:
        x0, y0 = self.centro[0] - LARG / 2, self.centro[1] - ALT / 2
        return _clamp((p[0] - x0) / LARG), _clamp((p[1] - y0) / ALT)

    def recentrar(self) -> bool:
        """Como no Quest: o ponto onde a mão principal está agora vira o meio da tela."""
        s = next(iter(self.state.values()), None)
        if not s or "cru" not in s:
            return False
        cx, cy = s["cru"]
        self.centro = (min(1 - LARG / 2, max(LARG / 2, cx)), min(1 - ALT / 2, max(ALT / 2, cy)))
        return True

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
            cru = ((pts[5][0] + pts[9][0]) / 2, (pts[5][1] + pts[9][1]) / 2)
            bruto = self._tela(cru)
            palma = self._tela((sum(pts[j][0] for j in (0, 5, 9, 13, 17)) / 5, sum(pts[j][1] for j in (0, 5, 9, 13, 17)) / 5))
            s = self.state.get(key)
            if not s:
                s = {"x": bruto[0], "y": bruto[1], "px": palma[0], "py": palma[1], "pinch": False, "raw": False, "since": agora,
                     "spread": 1.0, "seen": agora, "trail": [], "hist": [], "ax": bruto[0], "ay": bruto[1],
                     "fx": OneEuro(), "fy": OneEuro(), "forca": 0.0, "costas": 0, "micro": None, "medio": None}
                self.state[key] = s
            s["cru"] = cru
            s["x"], s["y"] = s["fx"](bruto[0], agora), s["fy"](bruto[1], agora)
            s["hist"] = [p for p in s["hist"] if agora - p[0] < 0.5] + [(agora, s["x"], s["y"])]
            s["px"] += (palma[0] - s["px"]) * 0.5
            s["py"] += (palma[1] - s["py"]) * 0.5
            d = _dist(pts[4], pts[8]) / (tamanho or 1)
            s["spread"] += (d - s["spread"]) * 0.5
            # força da pinça para o cursor (o anel fecha conforme os dedos se aproximam, como no Quest)
            s["forca"] += (_clamp((0.95 - d) / 0.7) - s["forca"]) * 0.5
            # mão fechada (indicador e médio dobrados): é a pose dos microgestos, não do ponteiro
            fechada = _dist(pts[8], pts[0]) < _dist(pts[6], pts[0]) * 1.05 and _dist(pts[12], pts[0]) < _dist(pts[10], pts[0]) * 1.05
            # palma para você = costas da mão para a câmera (em coordenadas espelhadas, o sinal do produto vetorial
            # muda com o lado da mão; o MediaPipe chama de "Left" a mão direita quando o quadro não vem espelhado)
            v1 = (pts[5][0] - pts[0][0], pts[5][1] - pts[0][1])
            v2 = (pts[17][0] - pts[0][0], pts[17][1] - pts[0][1])
            cruz = (v1[0] * v2[1] - v1[1] * v2[0]) / (tamanho * tamanho or 1)
            frente = cruz * (1 if (hd and hd.category_name == "Left") else -1)
            alvo_costas = 1 if frente < -0.12 else 0 if frente > 0.05 else s["costas"]
            s["costas"] = alvo_costas
            torcao = math.degrees(math.atan2(pts[17][1] - pts[5][1], pts[17][0] - pts[5][0]))
            if fechada:
                self._micro(s, pts, tamanho, agora)
            else:
                s["micro"] = None
                self._medio(s, pts, tamanho, d, agora)
            if fechada:
                d = 9.0  # mão fechada nunca é pinça do ponteiro (o polegar encosta no indicador nos microgestos)
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
                   "forca": round(1.0 if pinca else min(0.95, s["forca"]), 3), "costas": bool(s["costas"]), "micro": fechada,
                   "torcao": round(torcao, 1),
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

    def _micro(self, s: dict[str, Any], pts, tamanho: float, agora: float) -> None:
        """Microgestos (Quest): polegar tocando o lado do indicador e deslizando ao longo dele."""
        dist, t = _seg(pts[4], pts[5], pts[7])
        dist /= tamanho or 1
        m = s["micro"]
        if m is None:
            m = s["micro"] = {"toque": False, "inicio": 0.0, "t0": 0.0, "deslizou": False, "pendente": 0.0}
        if not m["toque"] and dist < 0.28:
            m.update(toque=True, inicio=agora, t0=t, deslizou=False)
        elif m["toque"] and not m["deslizou"] and abs(t - m["t0"]) > 0.45:
            m["deslizou"] = True  # deslize do polegar: para a ponta do dedo ou de volta para a base
            self._acao("polegar_frente" if t > m["t0"] else "polegar_tras", agora, 0.35)
        elif m["toque"] and dist > 0.42:
            m["toque"] = False
            if not m["deslizou"] and agora - m["inicio"] < TOQUE_S:
                if m["pendente"] and agora - m["pendente"] < DUPLO_S:
                    m["pendente"] = 0.0
                    self._acao("polegar_duplo", agora, 0.5)
                else:
                    m["pendente"] = agora
        if m["pendente"] and agora - m["pendente"] >= DUPLO_S and not m["toque"]:
            m["pendente"] = 0.0
            self._acao("polegar_toque", agora, 0.4)

    def _medio(self, s: dict[str, Any], pts, tamanho: float, d_indicador: float, agora: float) -> None:
        """Pinça do polegar com o dedo médio (pulseira da Meta): toque, toque duplo e segurar."""
        d = _dist(pts[4], pts[12]) / (tamanho or 1)
        m = s["medio"]
        if m is None:
            m = s["medio"] = {"junto": False, "inicio": 0.0, "segurou": False, "pendente": 0.0}
        junto = (d < 0.38 and d_indicador > 0.45) if m["junto"] else (d < 0.24 and d_indicador > 0.5)
        if junto and not m["junto"]:
            m.update(junto=True, inicio=agora, segurou=False)
        elif junto and not m["segurou"] and agora - m["inicio"] > SEGURAR_S:
            m["segurou"] = True
            m["pendente"] = 0.0
            self._acao("medio_segurar", agora, 0.8)
        elif not junto and m["junto"]:
            m["junto"] = False
            if not m["segurou"] and agora - m["inicio"] < TOQUE_S:
                if m["pendente"] and agora - m["pendente"] < DUPLO_S:
                    m["pendente"] = 0.0
                    self._acao("medio_duplo", agora, 0.6)
                else:
                    m["pendente"] = agora
        if m["pendente"] and agora - m["pendente"] >= DUPLO_S and not m["junto"]:
            m["pendente"] = 0.0
            self._acao("medio_toque", agora, 0.4)

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
