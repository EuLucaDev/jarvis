"""Mãos pela câmera, no núcleo (fora da interface), até duas mãos, 30 quadros/s.

O reconhecimento vem de um motor trocável (hands_motor.py): Apple Vision no Mac, RTMPose no Windows/Linux,
MediaPipe de reserva. Daqui para baixo é igual para todos:
  - a mão é seguida pela POSIÇÃO de um quadro para o outro (e não pelo rótulo esquerda/direita, que troca à toa);
    uma mão que some por alguns quadros volta com a pinça e o filtro como estavam;
  - o lado da mão sai de uma votação ao longo dos quadros (ou, se o motor não diz, do jeito que a mão chegou);
  - ponteiro filtrado com One Euro; cursor que fecha conforme a pinça (`forca` 0..1);
  - palma virada para a pessoa (`costas`), para o menu da palma;
  - limites da pinça, lado da palma e área da câmera vêm da calibração (store "maos_calibracao").

Cada quadro vira, para as telas:
  {"type": "maos", "hands": [{x, y, pinch, forca, costas, torcao, micro, spread, pose, palm, cal}], "pts": [...]}
  {"type": "gesto", "acao": "...", "rotulo": "..."}      (microgestos, pinça do médio, deslizes e poses paradas)
x/y: o ponteiro, pela base do indicador e do dedo médio (os nós dos dedos não se mexem ao fazer a pinça,
então o ponteiro fica parado na hora do clique); espelhado e esticado para a tela inteira (0..1).
ax/ay (só com pinça): onde o ponteiro estava logo ANTES da pinça começar, que é onde o clique deve cair.
`cal` (medidas cruas: abertura da pinça, lado da palma, ponto na câmera) alimenta a tela de calibração.
A câmera também serve para a Gemini "ver" (último quadro em JPEG).
"""

import asyncio
import logging
import math
import threading
import time
from typing import Any

from . import store
from .hands_motor import escolher, pose_dos_pontos
from .proativo import presenca
from .hub import hub

log = logging.getLogger("jarvis.hands")

AREA = (0.2, 0.8, 0.18, 0.78)  # miolo do quadro da câmera que vira a tela inteira (x0, x1, y0, y1), sem calibrar
SUMIR_S = 0.3  # mão que some por menos que isto continua a mesma (pinça e filtro mantidos)
LARGURA, ALTURA = 1280, 720

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


def calibracao() -> dict[str, Any]:
    """Calibração salva (ou os padrões): pinça fecha/abre (em tamanhos de mão), palma invertida, área da câmera."""
    c = store.get("maos_calibracao") or {}
    area = c.get("area") if isinstance(c.get("area"), list) and len(c["area"]) == 4 else list(AREA)
    return {"fecha": float(c.get("fecha", 0.25)), "abre": float(c.get("abre", 0.4)),
            "inverter_palma": bool(c.get("inverter_palma", False)), "area": area, "feita": bool(c)}


class Hands:
    def __init__(self) -> None:
        self.loop: asyncio.AbstractEventLoop | None = None
        self.on = False
        self.erro: str | None = None
        self.motor_nome = ""
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._jpeg: bytes | None = None
        self.viewers = 0
        self.area = (0.0, 0.0, 1920.0, 1080.0)  # área de trabalho inteira (todos os monitores), revista a cada 5 s
        self._area_em = 0.0
        self.state: dict[str, dict[str, Any]] = {}
        self._prox_id = 1
        self.pose = ""
        self.pose_since = 0.0
        self.pose_anchor = (0.0, 0.0)
        self.cooldown = 0.0
        self.cal = calibracao()

    # ---------- calibração e área da câmera ----------

    def recalibrar(self) -> None:
        self.cal = calibracao()

    def _tela(self, p) -> tuple[float, float]:
        x0, x1, y0, y1 = self.cal["area"]
        return _clamp((p[0] - x0) / ((x1 - x0) or 1)), _clamp((p[1] - y0) / ((y1 - y0) or 1))

    def recentrar(self) -> bool:
        """Como no Quest: o ponto onde a mão principal está agora vira o meio da tela (vale até reiniciar)."""
        s = self._principal()
        if not s:
            return False
        x0, x1, y0, y1 = self.cal["area"]
        lx, ly = x1 - x0, y1 - y0
        cx = min(1 - lx / 2, max(lx / 2, s["cru"][0]))
        cy = min(1 - ly / 2, max(ly / 2, s["cru"][1]))
        self.cal["area"] = [cx - lx / 2, cx + lx / 2, cy - ly / 2, cy + ly / 2]
        return True

    def _principal(self) -> dict[str, Any] | None:
        vivas = [s for s in self.state.values() if s.get("visto_agora")]
        return min(vivas, key=lambda s: s["nasceu"]) if vivas else None

    # ---------- ciclo de vida ----------

    def bind(self, loop: asyncio.AbstractEventLoop) -> None:
        self.loop = loop
        if store.get("camera").get("ligada", True):
            self.start()
            if not self.cal["feita"]:  # quem já usava antes da calibração: um lembrete, depois que as telas abrirem
                loop.call_later(25, lambda: self._emit({
                    "type": "alerta", "id": "calibrar-maos", "titulo": "Calibre as suas mãos", "nivel": "media",
                    "texto": "Leva menos de um minuto e deixa a pinça e o menu da palma certeiros: Painel → Gestos → Calibrar agora.",
                    "at": time.strftime("%H:%M")}))

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
        presenca.camera_desligou()  # sem câmera não dá para saber: conta como presente
        self._emit({"type": "camera", "ligada": False})
        self._emit({"type": "maos", "hands": [], "pts": []})

    def reiniciar(self) -> None:
        """Troca de motor: desliga e liga de novo (o motor é lido dos ajustes ao ligar)."""
        if self.on:
            self.stop()
            if self._thread:
                self._thread.join(timeout=3)
            self.start()

    def latest_jpeg(self) -> bytes | None:
        return self._jpeg

    def _emit(self, msg: dict[str, Any]) -> None:
        if self.loop:
            asyncio.run_coroutine_threadsafe(hub.broadcast(msg), self.loop)

    def _run(self) -> None:
        try:
            import cv2
        except Exception as exc:  # noqa: BLE001
            self.erro = f"câmera indisponível: {exc}"
            self.on = False
            return
        try:
            motor = escolher((store.get("maos") or {}).get("motor", "auto"))
        except Exception as exc:  # noqa: BLE001
            self.erro = f"reconhecimento das mãos indisponível: {exc}"
            self.on = False
            self._emit({"type": "camera", "ligada": False, "erro": self.erro})
            return
        self.motor_nome = motor.nome
        cap = cv2.VideoCapture(0)
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, LARGURA)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, ALTURA)
        cap.set(cv2.CAP_PROP_FPS, 30)
        if not cap.isOpened():
            self.erro = "Não consegui abrir a câmera (está em uso ou sem permissão)."
            self.on = False
            self._emit({"type": "camera", "ligada": False, "erro": self.erro})
            motor.fechar()
            return
        self.erro = None
        self.recalibrar()
        log.info("câmera e mãos no ar (motor %s)", motor.nome)
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
                    menor = cv2.resize(frame, (640, int(640 * frame.shape[0] / frame.shape[1])))
                    ok2, buf = cv2.imencode(".jpg", cv2.flip(menor, 1), [cv2.IMWRITE_JPEG_QUALITY, 70])
                    self._jpeg = buf.tobytes() if ok2 else None
                if agora - self._area_em > 5:  # monitor plugado ou tirado: a mão passa a alcançar a área nova
                    self._area_em = agora
                    try:
                        from . import pc

                        self.area = pc.desktop_bounds()
                    except Exception:  # noqa: BLE001
                        pass
                try:
                    dets = motor.detectar(frame, int((agora - t0) * 1000))
                except Exception as exc:  # noqa: BLE001
                    log.warning("motor %s falhou num quadro: %s", motor.nome, exc)
                    dets = []
                asp = frame.shape[1] / frame.shape[0]
                hands, pts = self._process(dets, asp, agora)
                presenca.quadro(frame, bool(dets))  # alguém na frente? (no máximo uma vez por segundo)
                quadro += 1
                if hands or tinha_mao:
                    self._emit({"type": "maos", "hands": hands, "pts": pts if quadro % 2 == 0 else None})
                tinha_mao = bool(hands)
                espera = 1 / 30 - (time.monotonic() - agora)
                if espera > 0:
                    time.sleep(espera)
        finally:
            motor.fechar()
            cap.release()
            log.info("câmera desligada")

    # ---------- de detecções a mãos seguidas ----------

    def _casar(self, dets, agora: float) -> list[tuple[dict[str, Any], Any, list]]:
        """Cada detecção vai para a mão seguida mais perto (ou vira uma nova). Devolve (estado, detecção, pts)."""
        cands = []
        for d in dets:
            pts = [(1 - x, y) for x, y in d.pts]  # espelhado, como num espelho
            centro = (sum(pts[j][0] for j in (0, 5, 9, 13, 17)) / 5, sum(pts[j][1] for j in (0, 5, 9, 13, 17)) / 5)
            cands.append((d, pts, centro))
        livres = dict(self.state)
        pares = sorted(((_dist(c[2], s["centro"]), k, i) for i, c in enumerate(cands) for k, s in livres.items()), key=lambda x: x[0])
        usados_c, usados_k, out = set(), set(), []
        for dist, k, i in pares:
            if i in usados_c or k in usados_k or dist > 0.25:
                continue
            usados_c.add(i)
            usados_k.add(k)
            out.append((self.state[k], cands[i][0], cands[i][1], cands[i][2]))
        for i, c in enumerate(cands):
            if i in usados_c or len(self.state) >= 4:
                continue
            k = f"m{self._prox_id}"
            self._prox_id += 1
            self.state[k] = {"key": k, "nasceu": agora, "seen": agora, "votos": 0, "lado": None, "centro": c[2]}
            out.append((self.state[k], c[0], c[1], c[2]))
        for k, s in list(self.state.items()):
            s["visto_agora"] = False
            if k not in usados_k and not any(o[0] is s for o in out) and agora - s.get("ultimo", agora) > SUMIR_S:
                del self.state[k]
        for s, *_ in out:
            s["visto_agora"] = True
            s["ultimo"] = agora
        return [(s, d, pts) for s, d, pts, _ in out]

    def _process(self, dets, asp: float, agora: float) -> tuple[list[dict[str, Any]], list[list[list[float]]]]:
        hands: list[dict[str, Any]] = []
        pts_all: list[list[list[float]]] = []
        cal = self.cal
        for s, det, pts in self._casar(dets, agora):
            g = [(x * asp, y) for x, y in pts]  # proporção certa para medir distâncias e ângulos
            tamanho = _dist(g[0], g[9])
            if tamanho < 0.08 or det.conf < 0.3:
                s["visto_agora"] = False
                continue  # mão pequena (no fundo) ou duvidosa
            cru = ((pts[5][0] + pts[9][0]) / 2, (pts[5][1] + pts[9][1]) / 2)
            bruto = self._tela(cru)
            palma = self._tela((sum(pts[j][0] for j in (0, 5, 9, 13, 17)) / 5, sum(pts[j][1] for j in (0, 5, 9, 13, 17)) / 5))
            s["centro"] = (sum(pts[j][0] for j in (0, 5, 9, 13, 17)) / 5, sum(pts[j][1] for j in (0, 5, 9, 13, 17)) / 5)
            if "x" not in s:
                s.update(x=bruto[0], y=bruto[1], px=palma[0], py=palma[1], pinch=False, raw=False, since=agora, spread=1.0,
                         trail=[], hist=[], ax=bruto[0], ay=bruto[1], fx=OneEuro(), fy=OneEuro(), forca=0.0, costas=0,
                         micro=None, medio=None, frente=0.0)
            s["cru"] = cru
            s["x"], s["y"] = s["fx"](bruto[0], agora), s["fy"](bruto[1], agora)
            s["hist"] = [p for p in s["hist"] if agora - p[0] < 0.5] + [(agora, s["x"], s["y"])]
            s["px"] += (palma[0] - s["px"]) * 0.5
            s["py"] += (palma[1] - s["py"]) * 0.5

            # lado da mão: votação (o rótulo do motor oscila); sem rótulo, decide pela pose em que a mão chegou
            v1 = (g[5][0] - g[0][0], g[5][1] - g[0][1])
            v2 = (g[17][0] - g[0][0], g[17][1] - g[0][1])
            cruz = (v1[0] * v2[1] - v1[1] * v2[0]) / (tamanho * tamanho or 1)
            if det.lado:
                s["votos"] = max(-20, min(20, s["votos"] + (1 if det.lado == "Left" else -1)))
                if abs(s["votos"]) >= 3 or s["lado"] is None:
                    s["lado"] = "Left" if s["votos"] >= 0 else "Right"
            elif s["lado"] is None:
                # a mão chega apontando, com a palma para a câmera: o lado é o que dá "palma para a câmera" agora
                s["lado"] = "Right" if cruz > 0 else "Left"
            # palma virada para a pessoa (costas da mão para a câmera); o sinal pode ser invertido pela calibração
            frente = cruz * (1 if s["lado"] == "Left" else -1) * (-1 if cal["inverter_palma"] else 1)
            s["frente"] += (frente - s["frente"]) * 0.4
            s["costas"] = 1 if s["frente"] > 0.15 else 0 if s["frente"] < 0.03 else s["costas"]
            torcao = math.degrees(math.atan2(g[17][1] - g[5][1], g[17][0] - g[5][0]))

            d = _dist(g[4], g[8]) / (tamanho or 1)
            s["spread"] += (d - s["spread"]) * 0.5
            fecha, abre = cal["fecha"], cal["abre"]
            s["forca"] += (_clamp((abre * 2.2 - d) / (abre * 2.2 - fecha)) - s["forca"]) * 0.5
            fechada = _dist(g[8], g[0]) < _dist(g[6], g[0]) * 1.05 and _dist(g[12], g[0]) < _dist(g[10], g[0]) * 1.05
            if fechada:
                self._micro(s, g, tamanho, agora)
            else:
                s["micro"] = None
                self._medio(s, g, tamanho, d, agora)
            dp = 9.0 if fechada else d  # mão fechada nunca é pinça do ponteiro
            quer = dp < abre if s["raw"] else dp < fecha  # histerese
            if quer != s["raw"]:
                s["raw"], s["since"] = quer, agora
            if s["raw"] != s["pinch"] and agora - s["since"] > (0.07 if s["raw"] else 0.06):
                s["pinch"] = s["raw"]
                if s["pinch"]:  # o clique vale onde o ponteiro estava antes dos dedos começarem a fechar
                    antes = [p for p in s["hist"] if p[0] <= s["since"] - 0.06]
                    _, s["ax"], s["ay"] = antes[-1] if antes else (0, s["x"], s["y"])
            pose = det.pose or pose_dos_pontos(g)
            s["trail"] = [t for t in s["trail"] if agora - t[2] < 0.32] + [(s["px"], s["py"], agora)]
            pinca = s["pinch"] and agora - s["seen"] > 0.15  # mão recém-chegada não clica
            dx, dy, dw, dh = self.area
            mao = {"key": s["key"], "x": round(s["x"], 4), "y": round(s["y"], 4), "pinch": pinca, "spread": round(s["spread"], 3),
                   "forca": round(1.0 if pinca else min(0.95, s["forca"]), 3), "costas": bool(s["costas"]), "micro": fechada,
                   "torcao": round(torcao, 1), "pose": pose, "palm": [round(s["px"], 4), round(s["py"], 4)],
                   "cal": {"d": round(d, 3), "frente": round(frente * (-1 if cal["inverter_palma"] else 1), 3),
                           "cx": round(cru[0], 4), "cy": round(cru[1], 4)},
                   # ponto na área de trabalho inteira (todos os monitores), em pontos globais: cada camada pega o seu
                   "gx": round(dx + s["x"] * dw, 1), "gy": round(dy + s["y"] * dh, 1)}
            if pinca:
                mao["ax"], mao["ay"] = round(s["ax"], 4), round(s["ay"], 4)
                mao["gax"], mao["gay"] = round(dx + s["ax"] * dw, 1), round(dy + s["ay"] * dh, 1)
            hands.append((s["nasceu"], mao))
            pts_all.append([[round(x, 3), round(y, 3)] for x, y in pts])
        hands.sort(key=lambda h: h[0])  # mão principal = a que está há mais tempo na câmera
        out = [h for _, h in hands]
        self._gestures(out, agora)
        return out, pts_all

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
