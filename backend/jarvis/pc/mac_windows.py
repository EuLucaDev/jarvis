"""Janelas de qualquer app com a mão: mirar (borda azul), pegar, arrastar, redimensionar e jogar para outro monitor.

A lista de janelas vem do Quartz (o que está na tela, da frente para trás, sem as do próprio Jarvis) e o
movimento é pela Acessibilidade (AXPosition/AXSize), com a permissão do app Jarvis. Coordenadas em pontos
globais (topo à esquerda do monitor principal). As camadas do app desenham a borda pelo evento "janela.realce".
"""

import asyncio
import logging
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import Quartz
from ApplicationServices import (
    AXUIElementCopyAttributeValue,
    AXUIElementCreateApplication,
    AXUIElementPerformAction,
    AXUIElementSetAttributeValue,
    AXValueCreate,
    AXValueGetValue,
    kAXValueCGPointType,
    kAXValueCGSizeType,
)

log = logging.getLogger("jarvis.windows")

PROPRIOS = {"Jarvis", "Electron", "Python", "Dock", "Window Server", "Control Center", "Central de Controle", "Notification Center", "Central de Notificações"}

_grab: dict[str, Any] | None = None  # janela segura: elemento AX, quadro original, deslocamento do dedo
_fila = ThreadPoolExecutor(1, thread_name_prefix="janelas")  # uma operação por vez, na ordem em que chegaram


async def run(fn, *args):
    return await asyncio.get_running_loop().run_in_executor(_fila, fn, *args)


def _get(el, attr):
    err, v = AXUIElementCopyAttributeValue(el, attr, None)
    return v if err == 0 else None


def _frame(el) -> tuple[float, float, float, float] | None:
    p, s = _get(el, "AXPosition"), _get(el, "AXSize")
    if p is None or s is None:
        return None
    _, pt = AXValueGetValue(p, kAXValueCGPointType, None)
    _, sz = AXValueGetValue(s, kAXValueCGSizeType, None)
    return pt.x, pt.y, sz.width, sz.height


def displays() -> list[tuple[float, float, float, float]]:
    err, ids, n = Quartz.CGGetActiveDisplayList(16, None, None)
    out = []
    for i in ids[:n]:
        b = Quartz.CGDisplayBounds(i)
        out.append((b.origin.x, b.origin.y, b.size.width, b.size.height))
    return out


def main_display() -> tuple[float, float, float, float]:
    b = Quartz.CGDisplayBounds(Quartz.CGMainDisplayID())
    return b.origin.x, b.origin.y, b.size.width, b.size.height


def to_global(nx: float, ny: float) -> tuple[float, float]:
    """Mão (0..1 do monitor principal) → pontos globais."""
    x, y, w, h = main_display()
    return x + nx * w, y + ny * h


def window_at(x: float, y: float) -> dict[str, Any] | None:
    infos = Quartz.CGWindowListCopyWindowInfo(Quartz.kCGWindowListOptionOnScreenOnly | Quartz.kCGWindowListExcludeDesktopElements, Quartz.kCGNullWindowID) or []
    for w in infos:  # da frente para trás
        if w.get("kCGWindowLayer", 1) != 0 or w.get("kCGWindowAlpha", 1) < 0.1:
            continue
        dono = str(w.get("kCGWindowOwnerName", ""))
        if dono in PROPRIOS:
            continue
        b = w.get("kCGWindowBounds") or {}
        bx, by, bw, bh = b.get("X", 0), b.get("Y", 0), b.get("Width", 0), b.get("Height", 0)
        if bw < 80 or bh < 60:
            continue
        if bx <= x <= bx + bw and by <= y <= by + bh:
            return {"pid": int(w["kCGWindowOwnerPID"]), "app": dono, "titulo": str(w.get("kCGWindowName") or ""), "frame": (bx, by, bw, bh)}
    return None


def _ax_window(info: dict[str, Any]):
    app = AXUIElementCreateApplication(info["pid"])
    bx, by, bw, bh = info["frame"]
    melhor, dist = None, 1e9
    for win in _get(app, "AXWindows") or []:
        fr = _frame(win)
        if not fr:
            continue
        d = abs(fr[0] - bx) + abs(fr[1] - by) + abs(fr[2] - bw) + abs(fr[3] - bh)
        if d < dist:
            melhor, dist = win, d
    return melhor if dist < 40 else None


def _set_pos(el, x: float, y: float) -> None:
    AXUIElementSetAttributeValue(el, "AXPosition", AXValueCreate(kAXValueCGPointType, Quartz.CGPoint(x, y)))


def _set_size(el, w: float, h: float) -> None:
    AXUIElementSetAttributeValue(el, "AXSize", AXValueCreate(kAXValueCGSizeType, Quartz.CGSize(w, h)))


def aim(nx: float, ny: float) -> dict[str, Any] | None:
    info = window_at(*to_global(nx, ny))
    return {"x": info["frame"][0], "y": info["frame"][1], "w": info["frame"][2], "h": info["frame"][3], "app": info["app"], "titulo": info["titulo"]} if info else None


def grab(nx: float, ny: float) -> dict[str, Any]:
    global _grab
    gx, gy = to_global(nx, ny)
    info = window_at(gx, gy)
    if not info:
        return {"erro": "Nenhuma janela embaixo da mão."}
    el = _ax_window(info)
    if el is None:
        return {"erro": f"Não consegui segurar a janela de {info['app']} (falta Acessibilidade?)."}
    fr = _frame(el) or info["frame"]
    _grab = {"el": el, "orig": fr, "dedo": (gx, gy), "app": info["app"], "titulo": info["titulo"], "t": time.time()}
    AXUIElementPerformAction(el, "AXRaise")  # vem para a frente, como quando se clica na barra de título
    return {"ok": True, **_view(fr)}


def _view(fr) -> dict[str, Any]:
    g = _grab or {}
    return {"x": fr[0], "y": fr[1], "w": fr[2], "h": fr[3], "app": g.get("app", ""), "titulo": g.get("titulo", "")}


def move(nx: float, ny: float) -> dict[str, Any] | None:
    """Arrasta mantendo o ponto onde o dedo pegou."""
    if not _grab:
        return None
    gx, gy = to_global(nx, ny)
    ox, oy, w, h = _grab["orig"]
    dx, dy = gx - _grab["dedo"][0], gy - _grab["dedo"][1]
    x, y = ox + dx, max(25, oy + dy)  # não some embaixo da barra de menus
    _set_pos(_grab["el"], x, y)
    return _view((x, y, w, h))


def scale(f: float) -> dict[str, Any] | None:
    """Ajuste de tamanho: escala do quadro original, a partir do centro, dentro do monitor."""
    if not _grab:
        return None
    ox, oy, w, h = _grab["orig"]
    cx, cy = ox + w / 2, oy + h / 2
    tela = next((d for d in displays() if d[0] <= cx < d[0] + d[2] and d[1] <= cy < d[1] + d[3]), main_display())
    nw = min(tela[2], max(320, w * f))
    nh = min(tela[3] - 25, max(220, h * f))
    x = min(max(tela[0], cx - nw / 2), tela[0] + tela[2] - nw)
    y = min(max(tela[1] + 25, cy - nh / 2), tela[1] + tela[3] - nh)
    _set_size(_grab["el"], nw, nh)
    _set_pos(_grab["el"], x, y)
    real = _frame(_grab["el"]) or (x, y, nw, nh)
    return _view(real)


def throw(direcao: str) -> dict[str, Any]:
    """Joga a janela segura para o monitor ao lado, na mesma posição relativa (cabe inteira)."""
    if not _grab:
        return {"erro": "Nenhuma janela segura."}
    fr = _frame(_grab["el"]) or _grab["orig"]
    cx = fr[0] + fr[2] / 2
    telas = sorted(displays(), key=lambda d: d[0])
    atual = next((i for i, d in enumerate(telas) if d[0] <= cx < d[0] + d[2]), 0)
    alvo_i = atual - 1 if direcao == "esquerda" else atual + 1
    if not 0 <= alvo_i < len(telas):
        return {"erro": "Não há monitor desse lado."}
    a, b = telas[atual], telas[alvo_i]
    rx, ry = (fr[0] - a[0]) / a[2], (fr[1] - a[1]) / a[3]
    w, h = min(fr[2], b[2]), min(fr[3], b[3] - 25)
    x = min(b[0] + rx * b[2], b[0] + b[2] - w)
    y = max(b[1] + 25, min(b[1] + ry * b[3], b[1] + b[3] - h))
    _set_pos(_grab["el"], x, y)
    _set_size(_grab["el"], w, h)
    _grab["orig"] = (x, y, w, h)
    return {"ok": True, **_view((x, y, w, h))}


def release(cancel: bool = False) -> dict[str, Any] | None:
    """Solta. Cancelar devolve a janela ao quadro de quando foi pega."""
    global _grab
    if not _grab:
        return None
    if cancel:
        x, y, w, h = _grab["orig"]
        _set_size(_grab["el"], w, h)
        _set_pos(_grab["el"], x, y)
    fr = _frame(_grab["el"])
    out = _view(fr) if fr else None
    _grab = None
    return out


# ---------- janelas de qualquer app por voz ----------

def _apps_abertos():
    from AppKit import NSApplicationActivationPolicyRegular, NSWorkspace

    return [a for a in NSWorkspace.sharedWorkspace().runningApplications()
            if a.activationPolicy() == NSApplicationActivationPolicyRegular and str(a.localizedName() or "") not in PROPRIOS]


def _area_util(fr) -> tuple[float, float, float, float]:
    """Área útil (sem barra de menus e Dock) do monitor onde está o centro do quadro, em pontos globais."""
    from AppKit import NSScreen

    telas = NSScreen.screens()
    altura_principal = telas[0].frame().size.height
    cx, cy = (fr[0] + fr[2] / 2, fr[1] + fr[3] / 2) if fr else (0, 0)
    melhor = telas[0]
    for t in telas:
        f = t.frame()
        top = altura_principal - (f.origin.y + f.size.height)
        if f.origin.x <= cx < f.origin.x + f.size.width and top <= cy < top + f.size.height:
            melhor = t
    v = melhor.visibleFrame()
    return v.origin.x, altura_principal - (v.origin.y + v.size.height), v.size.width, v.size.height


def _janela_principal(ax_app):
    for attr in ("AXFocusedWindow", "AXMainWindow"):
        w = _get(ax_app, attr)
        if w is not None:
            return w
    ws = _get(ax_app, "AXWindows") or []
    return ws[0] if ws else None


def controlar(pedido: str, acao: str, confirmado: bool = False) -> dict[str, Any]:
    """Minimizar, fechar, maximizar, metade da tela, outro monitor… numa janela do app pedido (ou do da frente)."""
    from AppKit import NSApplicationActivateIgnoringOtherApps, NSWorkspace

    from .. import overlay
    from .common import ACOES_JANELA, escolher_app

    if acao not in ACOES_JANELA:
        return {"erro": f"Ação desconhecida: {acao}."}
    apps = _apps_abertos()
    frente = NSWorkspace.sharedWorkspace().frontmostApplication()
    nome_frente = str(frente.localizedName() or "") if frente else ""
    if nome_frente in PROPRIOS:
        nome_frente = ""
    nome = escolher_app(pedido, [str(a.localizedName()) for a in apps], nome_frente)
    if not nome:
        abertos = ", ".join(sorted({str(a.localizedName()) for a in apps})[:25])
        return {"erro": f"Não achei '{pedido}' aberto.", "apps_abertos": abertos}
    app = next(a for a in apps if str(a.localizedName()) == nome)
    if acao == "sair":
        if not confirmado:
            return {"precisa_confirmar": True, "instrucao": f"Pergunte se pode fechar o {nome} inteiro (algo não salvo pode pedir para salvar)."}
        app.terminate()
        return {"ok": True, "app": nome, "feito": "fechado"}
    if acao == "esconder":
        app.hide()
        return {"ok": True, "app": nome, "feito": "escondido"}
    ax = AXUIElementCreateApplication(app.processIdentifier())
    if acao == "restaurar":
        for w in _get(ax, "AXWindows") or []:
            if _get(w, "AXMinimized"):
                AXUIElementSetAttributeValue(w, "AXMinimized", False)
        app.unhide()
        app.activateWithOptions_(NSApplicationActivateIgnoringOtherApps)
        return {"ok": True, "app": nome, "feito": "de volta"}
    win = _janela_principal(ax)
    if win is None:
        if acao == "focar":
            app.activateWithOptions_(NSApplicationActivateIgnoringOtherApps)
            return {"ok": True, "app": nome}
        return {"erro": f"O {nome} não tem janela aberta."}
    fr = _frame(win)
    if fr:  # a esfera vai até a janela antes de mexer, à vista
        overlay.look(*fr, label=f"{ACOES_JANELA[acao]} · {nome}")
        time.sleep(0.45)
    if acao == "minimizar":
        AXUIElementSetAttributeValue(win, "AXMinimized", True)
    elif acao == "fechar":
        botao = _get(win, "AXCloseButton")
        if botao is None:
            return {"erro": "Essa janela não tem botão de fechar."}
        AXUIElementPerformAction(botao, "AXPress")
    elif acao == "tela_cheia":
        AXUIElementSetAttributeValue(win, "AXFullScreen", not bool(_get(win, "AXFullScreen")))
    else:
        app.activateWithOptions_(NSApplicationActivateIgnoringOtherApps)
        AXUIElementPerformAction(win, "AXRaise")
        if acao in ("maximizar", "esquerda", "direita"):
            x, y, w, h = _area_util(fr)
            if acao == "esquerda":
                w = w / 2
            elif acao == "direita":
                x, w = x + w / 2, w / 2
            _set_pos(win, x, y)
            _set_size(win, w, h)
        elif acao == "outro_monitor" and fr:
            telas = sorted(displays(), key=lambda d: d[0])
            if len(telas) < 2:
                return {"erro": "Só há um monitor."}
            cx = fr[0] + fr[2] / 2
            atual = next((i for i, d in enumerate(telas) if d[0] <= cx < d[0] + d[2]), 0)
            b = telas[(atual + 1) % len(telas)]
            a = telas[atual]
            w, h = min(fr[2], b[2]), min(fr[3], b[3] - 25)
            _set_pos(win, b[0] + (fr[0] - a[0]) / a[2] * b[2], max(b[1] + 25, b[1] + (fr[1] - a[1]) / a[3] * b[3]))
            _set_size(win, w, h)
    novo = _frame(win)
    if novo and acao not in ("minimizar", "fechar"):
        overlay.look(*novo, label=f"{ACOES_JANELA[acao]} · {nome}")
    else:
        overlay.hide()
    return {"ok": True, "app": nome, "feito": ACOES_JANELA[acao].lower()}


def apps_abertos() -> list[str]:
    return sorted({str(a.localizedName()).strip("\u200e\u200f") for a in _apps_abertos()})


def front_rect() -> tuple[float, float, float, float] | None:
    """Quadro da janela da frente (fora o Jarvis), em pontos globais: para onde a esfera voa."""
    infos = Quartz.CGWindowListCopyWindowInfo(Quartz.kCGWindowListOptionOnScreenOnly | Quartz.kCGWindowListExcludeDesktopElements, Quartz.kCGNullWindowID) or []
    for w in infos:
        if w.get("kCGWindowLayer", 1) != 0 or str(w.get("kCGWindowOwnerName", "")) in PROPRIOS:
            continue
        b = w.get("kCGWindowBounds") or {}
        if b.get("Width", 0) > 200 and b.get("Height", 0) > 120:
            return b["X"], b["Y"], b["Width"], b["Height"]
    return None
