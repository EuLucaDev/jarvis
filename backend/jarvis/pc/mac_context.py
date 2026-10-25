"""O que a pessoa está fazendo agora, pela Acessibilidade do macOS: app e janela da frente, endereço da aba,
texto selecionado, o que está embaixo do mouse e os botões/links da janela (para clicar pelo nome).

Tudo local e só quando o Jarvis precisa (ferramentas `contexto_atual` e `clicar`); nada é guardado aqui.
"""

import difflib
import logging
import subprocess
import time
import unicodedata
from typing import Any

import AppKit
from ApplicationServices import (
    AXUIElementCopyAttributeValue,
    AXUIElementCopyElementAtPosition,
    AXUIElementCreateApplication,
    AXUIElementCreateSystemWide,
    AXUIElementPerformAction,
    AXUIElementSetAttributeValue,
    AXValueGetValue,
    kAXValueCGPointType,
    kAXValueCGSizeType,
)

from . import mac_input as desktop

log = logging.getLogger("jarvis.context")

BROWSERS = {"Google Chrome", "Brave Browser", "Safari", "Arc", "Microsoft Edge", "Chromium"}
CHROMIUM = {"Google Chrome", "Brave Browser", "Arc", "Microsoft Edge", "Chromium", "Code", "Slack", "Discord", "Notion", "Figma"}
ACIONAVEIS = {
    "AXButton", "AXLink", "AXMenuItem", "AXMenuBarItem", "AXCheckBox", "AXRadioButton", "AXTab", "AXPopUpButton",
    "AXTextField", "AXTextArea", "AXComboBox", "AXSearchField", "AXCell", "AXRow", "AXDisclosureTriangle", "AXImage",
}
PAPEL = {"AXButton": "botão", "AXLink": "link", "AXMenuItem": "menu", "AXCheckBox": "caixa", "AXRadioButton": "opção",
         "AXTab": "aba", "AXPopUpButton": "lista", "AXTextField": "campo", "AXTextArea": "texto", "AXSearchField": "busca",
         "AXComboBox": "lista", "AXCell": "célula", "AXRow": "linha", "AXImage": "imagem", "AXMenuBarItem": "menu"}


def _get(el, attr):
    try:
        err, val = AXUIElementCopyAttributeValue(el, attr, None)
        return val if err == 0 else None
    except Exception:  # noqa: BLE001
        return None


def _norm(s: str) -> str:
    s = unicodedata.normalize("NFD", (s or "").lower())
    return " ".join("".join(c for c in s if unicodedata.category(c) != "Mn").split())


def front() -> tuple[str, int]:
    a = AppKit.NSWorkspace.sharedWorkspace().frontmostApplication()
    return str(a.localizedName()), int(a.processIdentifier())


def _app_el(pid: int, nome: str):
    app = AXUIElementCreateApplication(pid)
    if nome in CHROMIUM:
        # apps Chromium/Electron só expõem a página para a Acessibilidade quando pedem
        AXUIElementSetAttributeValue(app, "AXManualAccessibility", True)
    return app


def _frame(el) -> tuple[float, float, float, float] | None:
    pos, size = _get(el, "AXPosition"), _get(el, "AXSize")
    if pos is None or size is None:
        return None
    ok1, p = AXValueGetValue(pos, kAXValueCGPointType, None)
    ok2, s = AXValueGetValue(size, kAXValueCGSizeType, None)
    if not (ok1 and ok2):
        return None
    return p.x, p.y, s.width, s.height


def _label(el) -> str:
    for attr in ("AXTitle", "AXDescription", "AXValue", "AXHelp", "AXPlaceholderValue"):
        v = _get(el, attr)
        if isinstance(v, str) and v.strip():
            return v.strip()[:120]
    title_el = _get(el, "AXTitleUIElement")
    if title_el is not None:
        v = _get(title_el, "AXValue") or _get(title_el, "AXTitle")
        if isinstance(v, str):
            return v.strip()[:120]
    return ""


def browser_url(app: str) -> str | None:
    if app not in BROWSERS:
        return None
    script = (
        f'tell application "{app}" to get URL of current tab of front window'
        if app == "Safari"
        else f'tell application "{app}" to get URL of active tab of front window'
    )
    r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=4)
    return r.stdout.strip() or None


def selected_text(copiar: bool = True) -> str:
    """Texto selecionado no app da frente: pela Acessibilidade e, se o app não contar, copiando (Cmd+C)
    e devolvendo a área de transferência como estava."""
    nome, pid = front()
    app = _app_el(pid, nome)
    foco = _get(app, "AXFocusedUIElement")
    if foco is not None:
        sel = _get(foco, "AXSelectedText")
        if isinstance(sel, str) and sel.strip():
            return sel
    if not copiar or desktop.front_is_jarvis():
        return ""
    pb = AppKit.NSPasteboard.generalPasteboard()
    antes = pb.stringForType_(AppKit.NSPasteboardTypeString)
    marca = pb.changeCount()
    desktop.press("cmd+c")
    for _ in range(12):
        time.sleep(0.05)
        if pb.changeCount() != marca:
            break
    texto = pb.stringForType_(AppKit.NSPasteboardTypeString) if pb.changeCount() != marca else ""
    if pb.changeCount() != marca and antes is not None:
        pb.clearContents()
        pb.setString_forType_(antes, AppKit.NSPasteboardTypeString)
    return str(texto or "")


def replace_selection(texto: str) -> dict[str, Any]:
    """Troca o texto selecionado (ou insere no cursor) colando, à vista, e devolve a área de transferência."""
    if not desktop.permitido():
        return {"erro": "Sem permissão de Acessibilidade."}
    if desktop.front_is_jarvis():
        return {"erro": "A janela da frente é o próprio Jarvis; volte para o app onde está o texto."}
    pb = AppKit.NSPasteboard.generalPasteboard()
    antes = pb.stringForType_(AppKit.NSPasteboardTypeString)
    pb.clearContents()
    pb.setString_forType_(texto[: desktop.MAX_TEXTO], AppKit.NSPasteboardTypeString)
    desktop.press("cmd+v")
    time.sleep(0.4)
    if antes is not None:
        pb.clearContents()
        pb.setString_forType_(antes, AppKit.NSPasteboardTypeString)
    return {"ok": True, "app": front()[0]}


def under_mouse() -> dict[str, Any] | None:
    x, y = desktop.position()
    err, el = AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), x, y, None)
    if err != 0 or el is None:
        return None
    role = _get(el, "AXRole") or ""
    return {"tipo": PAPEL.get(role, role.replace("AX", "").lower()), "texto": _label(el)}


def elements(limite: int = 250) -> list[dict[str, Any]]:
    """Botões, links, abas, campos… da janela da frente (e da barra de menus), com posição."""
    nome, pid = front()
    app = _app_el(pid, nome)
    raizes = [r for r in (_get(app, "AXFocusedWindow"), _get(app, "AXMenuBar")) if r is not None]
    out: list[dict[str, Any]] = []
    fim = time.time() + 2.5
    pilha = [(r, 0) for r in raizes]
    vistos = 0
    while pilha and len(out) < limite and time.time() < fim and vistos < 4000:
        el, nivel = pilha.pop()
        vistos += 1
        role = _get(el, "AXRole") or ""
        if role in ACIONAVEIS:
            rotulo = _label(el)
            fr = _frame(el)
            if rotulo and fr and fr[2] > 2 and fr[3] > 2:
                out.append({"el": el, "papel": PAPEL.get(role, role), "rotulo": rotulo, "frame": fr})
        if nivel < 40 and role not in ("AXMenuItem",):
            for filho in reversed(_get(el, "AXChildren") or []):
                pilha.append((filho, nivel + 1))
    return out


def find_element(alvo: str) -> dict[str, Any] | None:
    lista = elements()
    if not lista:
        return None
    a = _norm(alvo)
    # 1) igual, 2) contém, 3) parecido
    for e in lista:
        if _norm(e["rotulo"]) == a:
            return e
    contem = [e for e in lista if a and a in _norm(e["rotulo"])]
    if contem:
        return min(contem, key=lambda e: len(e["rotulo"]))
    nomes = [_norm(e["rotulo"]) for e in lista]
    hit = difflib.get_close_matches(a, nomes, n=1, cutoff=0.6)
    return lista[nomes.index(hit[0])] if hit else None


def click(alvo: str) -> dict[str, Any]:
    """Clica num botão/link/aba pelo nome, à vista: o cursor do Jarvis vai até lá e aperta."""
    if not desktop.permitido():
        return {"erro": "Sem permissão de Acessibilidade."}
    if desktop.front_is_jarvis():
        return {"erro": "A janela da frente é o próprio Jarvis; diga em qual app clicar (abra-o antes)."}
    e = find_element(alvo)
    if not e:
        opcoes = [f"{x['papel']}: {x['rotulo']}" for x in elements(60)][:40]
        return {"erro": f"Não achei '{alvo}' na janela da frente.", "opcoes": opcoes}
    x, y, w, h = e["frame"]
    cx, cy = x + w / 2, y + h / 2
    from .. import overlay

    overlay.look(x, y, w, h, f"Clicando em {e['rotulo'][:40]}")
    time.sleep(1.1)  # deixa ver a esfera chegando antes do clique
    if AXUIElementPerformAction(e["el"], "AXPress") != 0:
        desktop.click(cx, cy)
    return {"ok": True, "clicou": e["rotulo"], "tipo": e["papel"], "app": front()[0]}


def front_window_frame() -> tuple[float, float, float, float] | None:
    nome, pid = front()
    win = _get(_app_el(pid, nome), "AXFocusedWindow")
    return _frame(win) if win is not None else None


# regiões que ele cita ("essa barra lateral", "canto de cima") em frações da janela da frente
REGIOES = {
    "janela": (0, 0, 1, 1), "barra_lateral": (0, 0, 0.24, 1), "barra_lateral_direita": (0.76, 0, 0.24, 1),
    "topo": (0, 0, 1, 0.18), "rodape": (0, 0.82, 1, 0.18), "centro": (0.2, 0.2, 0.6, 0.6),
    "canto_superior_esquerdo": (0, 0, 0.4, 0.35), "canto_superior_direito": (0.6, 0, 0.4, 0.35),
    "canto_inferior_esquerdo": (0, 0.65, 0.4, 0.35), "canto_inferior_direito": (0.6, 0.65, 0.4, 0.35),
}


def look_at(regiao: str | None = None, alvo: str | None = None, label: str = "Estou vendo") -> dict[str, Any]:
    """Vai até a área citada, mostra que está olhando e devolve o que há lá (texto dos elementos e uma imagem)."""
    from .. import overlay

    if desktop.front_is_jarvis():
        return {"erro": "A janela da frente é o próprio Jarvis; peça para ele ir ao app primeiro."}
    area = None
    if alvo:
        e = find_element(alvo)
        if e:
            area = e["frame"]
    if area is None and regiao == "mouse":
        mx, my = desktop.position()
        area = (mx - 160, my - 110, 320, 220)
    if area is None:
        win = front_window_frame()
        if not win:
            return {"erro": "Não achei a janela da frente."}
        fx, fy, fw, fh = REGIOES.get(regiao or "janela", REGIOES["janela"])
        area = (win[0] + win[2] * fx, win[1] + win[3] * fy, win[2] * fw, win[3] * fh)
    x, y, w, h = area
    overlay.look(x, y, w, h, label, "olhar")
    ax, ay, aw, ah = x, y, w, h
    dentro = [f"{e['papel']}: {e['rotulo']}" for e in elements(300) if ax <= e["frame"][0] + e["frame"][2] / 2 <= ax + aw and ay <= e["frame"][1] + e["frame"][3] / 2 <= ay + ah][:40]
    img = desktop.capture(x, y, w, h)
    out: dict[str, Any] = {"app": front()[0], "janela": desktop.front_window_title(), "area": regiao or alvo or "janela", "elementos": dentro}
    if img:
        out["_imagem"] = img
        out["instrucao"] = "Você recebeu a imagem da área. Diga que está vendo ('Estou vendo, Senhor') e o que percebe, curto."
    else:
        out["instrucao"] = "Sem imagem (falta a permissão de Gravação de Tela); use a lista de elementos."
    return out


def snapshot(pointed: dict[str, Any] | None = None, com_selecao: bool = True) -> dict[str, Any]:
    nome, _ = front()
    janela = desktop.front_window_title()
    out: dict[str, Any] = {"app": nome, "janela": janela}
    if not desktop.front_is_jarvis():
        from .. import overlay

        win = front_window_frame()
        if win:
            overlay.look(*win, "Olhando", "olhar")
    url = browser_url(nome)
    if url:
        out["endereco"] = url
    if desktop.front_is_jarvis():
        out["observacao"] = "A janela da frente é o HUD do Jarvis; o app em que ele trabalhava ficou atrás."
    elif com_selecao and desktop.permitido():
        sel = selected_text()
        if sel.strip():
            out["texto_selecionado"] = sel[:6000]
    if pointed:
        out["apontando_no_hud"] = pointed
    um = under_mouse() if desktop.permitido() else None
    if um and um.get("texto"):
        out["embaixo_do_mouse"] = um
    return out
