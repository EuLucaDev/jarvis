"""Motores de reconhecimento das mãos, todos com a mesma saída: até duas mãos com os 21 pontos na ordem do
MediaPipe (pulso, polegar 1-4, indicador 5-8, médio 9-12, anelar 13-16, mindinho 17-20), em 0..1 do quadro
(sem espelhar), a confiança, o lado ("Left"/"Right" como o MediaPipe chama, ou None) e a pose, se o motor dá.

  vision     Mac: o reconhecimento de mão da Apple (Vision), no Neural Engine, ~7 ms por quadro em 720p.
  rtm        Windows/Linux: RTMPose (detector RTMDet + 21 pontos, onnxruntime). O detector só roda quando falta
             mão ou a cada poucos quadros; no resto a caixa vem dos pontos do quadro anterior (como o MediaPipe).
  mediapipe  Reserva nos três: o Gesture Recognizer do Google (o motor até a 2.7).

`escolher("auto")` pega o melhor que existir no sistema e cai para o próximo se um não abrir.
"""

from __future__ import annotations

import logging
import math
import sys
from dataclasses import dataclass, field

from .config import CODE_ROOT

log = logging.getLogger("jarvis.maos")

MODELOS = CODE_ROOT / "models" if (CODE_ROOT / "models").exists() else CODE_ROOT / "backend" / "models"  # app ou repo
NOMES = {"auto": "Automático", "vision": "Apple Vision (Mac)", "rtm": "RTMPose", "mediapipe": "MediaPipe (Google)"}


@dataclass
class Deteccao:
    pts: list[tuple[float, float]]  # 21 pontos, 0..1 do quadro, sem espelhar
    conf: float
    lado: str | None = None  # "Left"/"Right" no rótulo do MediaPipe (quadro sem espelhar), ou None
    pose: str = ""  # pose pronta do motor (só o MediaPipe dá); senão hands.py calcula
    extra: dict = field(default_factory=dict)


class Motor:
    nome = "?"

    def detectar(self, bgr, t_ms: int) -> list[Deteccao]:  # pragma: no cover - interface
        raise NotImplementedError

    def fechar(self) -> None:
        pass


# ---------------------------------------------------------------- Apple Vision (Mac)


class MotorVision(Motor):
    nome = "vision"

    def __init__(self) -> None:
        import Quartz
        import Vision

        self.Q, self.V = Quartz, Vision
        self.req = Vision.VNDetectHumanHandPoseRequest.alloc().init()
        self.req.setMaximumHandCount_(2)
        J = Vision
        self.juntas = [
            J.VNHumanHandPoseObservationJointNameWrist,
            J.VNHumanHandPoseObservationJointNameThumbCMC, J.VNHumanHandPoseObservationJointNameThumbMP,
            J.VNHumanHandPoseObservationJointNameThumbIP, J.VNHumanHandPoseObservationJointNameThumbTip,
            J.VNHumanHandPoseObservationJointNameIndexMCP, J.VNHumanHandPoseObservationJointNameIndexPIP,
            J.VNHumanHandPoseObservationJointNameIndexDIP, J.VNHumanHandPoseObservationJointNameIndexTip,
            J.VNHumanHandPoseObservationJointNameMiddleMCP, J.VNHumanHandPoseObservationJointNameMiddlePIP,
            J.VNHumanHandPoseObservationJointNameMiddleDIP, J.VNHumanHandPoseObservationJointNameMiddleTip,
            J.VNHumanHandPoseObservationJointNameRingMCP, J.VNHumanHandPoseObservationJointNameRingPIP,
            J.VNHumanHandPoseObservationJointNameRingDIP, J.VNHumanHandPoseObservationJointNameRingTip,
            J.VNHumanHandPoseObservationJointNameLittleMCP, J.VNHumanHandPoseObservationJointNameLittlePIP,
            J.VNHumanHandPoseObservationJointNameLittleDIP, J.VNHumanHandPoseObservationJointNameLittleTip,
        ]
        self.espaco = Quartz.CGColorSpaceCreateDeviceRGB()

    def _cg(self, bgr):
        import cv2

        rgba = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGBA)
        h, w = rgba.shape[:2]
        Q = self.Q
        prov = Q.CGDataProviderCreateWithData(None, rgba.tobytes(), h * w * 4, None)
        return Q.CGImageCreate(w, h, 8, 32, w * 4, self.espaco, Q.kCGImageAlphaNoneSkipLast, prov, None, False,
                               Q.kCGRenderingIntentDefault)

    def detectar(self, bgr, t_ms: int) -> list[Deteccao]:
        V = self.V
        handler = V.VNImageRequestHandler.alloc().initWithCGImage_options_(self._cg(bgr), None)
        ok, _ = handler.performRequests_error_([self.req], None)
        if not ok:
            return []
        out = []
        for o in self.req.results() or []:
            pontos, _ = o.recognizedPointsForJointsGroupName_error_(V.VNHumanHandPoseObservationJointsGroupNameAll, None)
            if not pontos:
                continue
            pts, confs = [], []
            for j in self.juntas:
                p = pontos.get(j) if hasattr(pontos, "get") else pontos[j]
                if p is None:
                    break
                loc = p.location()
                pts.append((float(loc.x), 1.0 - float(loc.y)))  # Vision tem a origem embaixo
                confs.append(float(p.confidence()))
            if len(pts) != 21:
                continue
            quir = o.chirality() if hasattr(o, "chirality") else 0
            lado = "Left" if quir == V.VNChiralityLeft else "Right" if quir == V.VNChiralityRight else None
            # pontos escondidos vêm com confiança baixa: a média dos que importam para o ponteiro e a pinça
            conf = sum(confs[i] for i in (0, 4, 5, 8, 9)) / 5
            out.append(Deteccao(pts, conf, lado))
        return out


# ---------------------------------------------------------------- RTMPose (Windows / Linux)


class MotorRTM(Motor):
    nome = "rtm"
    REDETECTAR = 8  # quadros

    def __init__(self) -> None:
        from rtmlib import RTMDet, RTMPose

        det, pose = MODELOS / "rtm" / "detector.onnx", MODELOS / "rtm" / "pontos.onnx"
        if not det.exists() or not pose.exists():
            raise RuntimeError("modelos do RTMPose não estão no app")
        self.det = RTMDet(str(det), model_input_size=(320, 320), backend="onnxruntime", device="cpu")
        self.pose = RTMPose(str(pose), model_input_size=(256, 256), backend="onnxruntime", device="cpu")
        self.caixas: list[list[float]] = []
        self.quadro = 0

    def detectar(self, bgr, t_ms: int) -> list[Deteccao]:
        import numpy as np

        h, w = bgr.shape[:2]
        self.quadro += 1
        if not self.caixas or self.quadro % self.REDETECTAR == 0:
            caixas = [list(map(float, b[:4])) for b in self.det(bgr)][:4]
            # junta o que o detector achou com o que já se seguia (a mão seguida não some num quadro ruim)
            for c in self.caixas:
                if not any(_iou(c, d) > 0.3 for d in caixas):
                    caixas.append(c)
            self.caixas = caixas[:2]
        if not self.caixas:
            return []
        kps, scs = self.pose(bgr, bboxes=self.caixas)
        out, novas = [], []
        for kp, sc in zip(kps, scs):
            sc = np.asarray(sc, dtype=float)
            conf = float(np.mean(sc[[0, 4, 5, 8, 9]]))
            if conf < 0.35:
                continue
            xs, ys = kp[:, 0], kp[:, 1]
            x0, x1, y0, y1 = float(xs.min()), float(xs.max()), float(ys.min()), float(ys.max())
            lado = max(x1 - x0, y1 - y0) * 1.35
            cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
            novas.append([max(0, cx - lado / 2), max(0, cy - lado / 2), min(w, cx + lado / 2), min(h, cy + lado / 2)])
            out.append(Deteccao([(float(x) / w, float(y) / h) for x, y in kp[:21]], min(1.0, conf)))
        self.caixas = novas
        return out


def _iou(a, b) -> float:
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    uni = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / uni if uni > 0 else 0.0


# ---------------------------------------------------------------- MediaPipe (reserva)


class MotorMediaPipe(Motor):
    nome = "mediapipe"

    def __init__(self) -> None:
        import mediapipe as mp
        from mediapipe.tasks.python import BaseOptions, vision

        self.mp = mp
        self.rec = vision.GestureRecognizer.create_from_options(vision.GestureRecognizerOptions(
            base_options=BaseOptions(model_asset_path=str(MODELOS / "gesture_recognizer.task")),
            running_mode=vision.RunningMode.VIDEO, num_hands=2,
            min_hand_detection_confidence=0.5, min_hand_presence_confidence=0.5, min_tracking_confidence=0.5,
        ))
        self.ultimo = -1

    def detectar(self, bgr, t_ms: int) -> list[Deteccao]:
        import cv2

        t_ms = max(t_ms, self.ultimo + 1)
        self.ultimo = t_ms
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        res = self.rec.recognize_for_video(self.mp.Image(image_format=self.mp.ImageFormat.SRGB, data=rgb), t_ms)
        out = []
        for i, lm in enumerate(res.hand_landmarks or []):
            hd = res.handedness[i][0] if res.handedness and i < len(res.handedness) and res.handedness[i] else None
            pose = ""
            if res.gestures and i < len(res.gestures) and res.gestures[i] and res.gestures[i][0].score > 0.6:
                pose = res.gestures[i][0].category_name
                pose = "" if pose == "None" else pose
            out.append(Deteccao([(p.x, p.y) for p in lm], hd.score if hd else 0.8, hd.category_name if hd else None, pose))
        return out

    def fechar(self) -> None:
        self.rec.close()


# ---------------------------------------------------------------- escolha

ORDEM = {"darwin": ["vision", "mediapipe"], "win32": ["rtm", "mediapipe"]}.get(sys.platform, ["rtm", "mediapipe"])
CLASSES = {"vision": MotorVision, "rtm": MotorRTM, "mediapipe": MotorMediaPipe}


def disponiveis() -> list[str]:
    return ["auto", *ORDEM]


def escolher(nome: str = "auto") -> Motor:
    """O motor pedido; se não abrir, o próximo da lista do sistema."""
    fila = ORDEM if nome in ("", "auto") else [nome, *[n for n in ORDEM if n != nome]]
    erros = []
    for n in fila:
        try:
            m = CLASSES[n]()
            log.info("motor das mãos: %s", n)
            return m
        except Exception as exc:  # noqa: BLE001
            erros.append(f"{n}: {exc}")
            log.warning("motor %s não abriu: %s", n, exc)
    raise RuntimeError("nenhum motor de mãos abriu (" + "; ".join(erros) + ")")


# ---------------------------------------------------------------- pose pelos pontos (motores sem pose pronta)


def _d(a, b) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


def pose_dos_pontos(p: list[tuple[float, float]]) -> str:
    """Pose simples a partir dos 21 pontos (em coordenadas com a proporção certa)."""
    w = p[0]
    esticado = [_d(p[t], w) > _d(p[j], w) * 1.12 for t, j in ((8, 6), (12, 10), (16, 14), (20, 18))]
    tam = _d(p[0], p[9]) or 1
    polegar_fora = _d(p[4], p[5]) / tam > 0.55 and _d(p[4], p[17]) > _d(p[3], p[17])
    ind, med, ane, mind = esticado
    if all(esticado) and polegar_fora:
        return "Open_Palm"
    if ind and med and not ane and not mind:
        return "Victory"
    if ind and not med and not ane and mind and polegar_fora:
        return "ILoveYou"
    if ind and not med and not ane and not mind:
        return "Pointing_Up"
    if not any(esticado):
        if polegar_fora:
            return "Thumb_Up" if p[4][1] < p[5][1] - tam * 0.3 else "Thumb_Down" if p[4][1] > p[17][1] + tam * 0.3 else "Closed_Fist"
        return "Closed_Fist"
    return ""
