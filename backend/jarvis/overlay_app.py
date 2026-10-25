"""Cursor do Jarvis por cima de todas as janelas (processo à parte, com AppKit).

Recebe comandos JSON por linha no stdin:
  {"cmd": "point", "x": 100, "y": 200, "label": "Clicando em Enviar"}  → anima o cursor até lá
  {"cmd": "label", "text": "Escrevendo…"}                              → troca a legenda
  {"cmd": "hide"}                                                      → some (também some sozinho após 6 s parado)
E escreve "esc" no stdout quando o Luca aperta Esc (para o Jarvis parar o que está fazendo).

A janela não recebe cliques (ignoresMouseEvents) e aparece em todos os espaços.
Rodar: python -m jarvis.overlay_app
"""

import json
import sys
import threading
import time

import AppKit
import objc
import Quartz
from PyObjCTools import AppHelper

W, H = 260, 64
CIANO = AppKit.NSColor.colorWithSRGBRed_green_blue_alpha_(0.37, 0.83, 1.0, 1.0)


class CursorView(AppKit.NSView):
    label = ""

    def isFlipped(self):
        return True

    def drawRect_(self, _rect):
        # seta do cursor
        p = AppKit.NSBezierPath.bezierPath()
        p.moveToPoint_((4, 2))
        p.lineToPoint_((4, 24))
        p.lineToPoint_((10, 18))
        p.lineToPoint_((15, 28))
        p.lineToPoint_((19, 26))
        p.lineToPoint_((14, 16))
        p.lineToPoint_((22, 16))
        p.closePath()
        sombra = AppKit.NSShadow.alloc().init()
        sombra.setShadowColor_(CIANO)
        sombra.setShadowBlurRadius_(10)
        sombra.set()
        CIANO.setFill()
        p.fill()
        AppKit.NSColor.whiteColor().setStroke()
        p.setLineWidth_(1.2)
        p.stroke()
        # etiqueta "Jarvis · ação"
        texto = "Jarvis" + (f" · {self.label}" if self.label else "")
        attrs = {
            AppKit.NSFontAttributeName: AppKit.NSFont.systemFontOfSize_weight_(11.5, AppKit.NSFontWeightSemibold),
            AppKit.NSForegroundColorAttributeName: AppKit.NSColor.colorWithSRGBRed_green_blue_alpha_(0.02, 0.07, 0.16, 1),
        }
        s = AppKit.NSAttributedString.alloc().initWithString_attributes_(texto, attrs)
        tw = min(W - 30, s.size().width + 16)
        AppKit.NSShadow.alloc().init().set()
        pill = AppKit.NSBezierPath.bezierPathWithRoundedRect_xRadius_yRadius_(((22, 28), (tw, 22)), 11, 11)
        CIANO.setFill()
        pill.fill()
        s.drawInRect_(((30, 31), (tw - 12, 18)))


def origin(x, y):
    """Coordenadas do Quartz (topo à esquerda do principal) → do AppKit (base à esquerda)."""
    main_h = AppKit.NSScreen.screens()[0].frame().size.height
    return (x - 3, main_h - y - H + 2)


class Overlay(AppKit.NSObject):
    def init(self):
        self = objc.super(Overlay, self).init()
        self.win = AppKit.NSPanel.alloc().initWithContentRect_styleMask_backing_defer_(
            ((0, 0), (W, H)), AppKit.NSWindowStyleMaskBorderless | AppKit.NSWindowStyleMaskNonactivatingPanel, AppKit.NSBackingStoreBuffered, False
        )
        self.win.setOpaque_(False)
        self.win.setBackgroundColor_(AppKit.NSColor.clearColor())
        self.win.setIgnoresMouseEvents_(True)
        self.win.setHasShadow_(False)
        self.win.setLevel_(AppKit.NSScreenSaverWindowLevel)
        self.win.setCollectionBehavior_(
            AppKit.NSWindowCollectionBehaviorCanJoinAllSpaces | AppKit.NSWindowCollectionBehaviorStationary | AppKit.NSWindowCollectionBehaviorFullScreenAuxiliary
        )
        self.view = CursorView.alloc().initWithFrame_(((0, 0), (W, H)))
        self.win.setContentView_(self.view)
        self.last = 0.0
        return self

    def point_(self, d):
        self.view.label = d.get("label", "")
        self.view.setNeedsDisplay_(True)
        alvo = origin(d["x"], d["y"])
        if not self.win.isVisible():
            # aparece a partir do mouse do Luca, para dar a sensação de "outro cursor saindo dali"
            p = Quartz.CGEventGetLocation(Quartz.CGEventCreate(None))
            self.win.setFrameOrigin_(origin(p.x, p.y))
            self.win.orderFrontRegardless()
        AppKit.NSAnimationContext.beginGrouping()
        AppKit.NSAnimationContext.currentContext().setDuration_(0.4)
        self.win.animator().setFrameOrigin_(alvo)
        AppKit.NSAnimationContext.endGrouping()
        self.last = time.time()

    def label_(self, d):
        self.view.label = d.get("text", "")
        self.view.setNeedsDisplay_(True)
        if self.win.isVisible():
            self.last = time.time()

    def hide_(self, _d):
        self.win.orderOut_(None)

    def tick_(self, _t):
        if self.win.isVisible() and time.time() - self.last > 6:
            self.win.orderOut_(None)


def main():
    app = AppKit.NSApplication.sharedApplication()
    app.setActivationPolicy_(AppKit.NSApplicationActivationPolicyAccessory)  # sem ícone no Dock
    ov = Overlay.alloc().init()
    AppKit.NSTimer.scheduledTimerWithTimeInterval_target_selector_userInfo_repeats_(1.0, ov, "tick:", None, True)

    def on_key(ev):
        if ev.keyCode() == 53:  # Esc
            print("esc", flush=True)

    AppKit.NSEvent.addGlobalMonitorForEventsMatchingMask_handler_(AppKit.NSEventMaskKeyDown, on_key)

    def read():
        for line in sys.stdin:
            try:
                d = json.loads(line)
            except ValueError:
                continue
            sel = {"point": "point:", "label": "label:", "hide": "hide:"}.get(d.get("cmd"))
            if sel:
                ov.performSelectorOnMainThread_withObject_waitUntilDone_(sel, d, False)
        AppHelper.callAfter(app.terminate_, None)  # o servidor fechou: sai junto

    threading.Thread(target=read, daemon=True).start()
    AppHelper.runEventLoop()


if __name__ == "__main__":
    main()
