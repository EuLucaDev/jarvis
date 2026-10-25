"""Controle do computador à vista do usuário, com os mesmos comandos no Mac, no Windows e no Linux.

Cada sistema tem o seu módulo (mac.py, win.py, linux.py); todos expõem:

  permissões   permitido(), pedir_permissao(), cancel (parar a digitação em curso)
  mouse        position(), move(x, y), button(down, x, y), click(x, y), scroll(dy), main_bounds()
  teclado      type_text(texto), press(combo), type_into(texto, app, enter), keys_into(combo, app)
  apps         activate(app), open_app(nome), open_link(url), front_app(), front_window_title(), front_is_jarvis()
  navegador    browser(acao, valor), browser_url(app)
  tela         capture(x, y, w, h) -> JPEG
  janelas      win_run(fn, *args), win_aim(nx, ny), win_grab(nx, ny), win_move(nx, ny), win_scale(f), win_throw(direcao), win_release(cancelar)
  contexto     snapshot(apontado, com_selecao), look_at(regiao, alvo), click_named(alvo), selected_text(), replace_selection(texto)
  sistema      volume(n), media(acao), brightness(n), lock_screen(), clipboard_text()

Coordenadas sempre em pontos lógicos globais (topo à esquerda do monitor principal), como as janelas do app.
"""

import sys

if sys.platform == "darwin":
    from .mac import *  # noqa: F403
elif sys.platform == "win32":
    from .win import *  # noqa: F403
else:
    from .linux import *  # noqa: F403

SISTEMA = {"darwin": "mac", "win32": "windows"}.get(sys.platform, "linux")
