"""Ponto de entrada do núcleo empacotado (PyInstaller).

  jarvis-core              sobe o núcleo (o app Jarvis chama assim)
  jarvis-core --verificar  confere se o pacote está inteiro (modelos de mão e de voz, áudio, interface) e sai
"""

import json
import multiprocessing
import os
import sys

# o MediaPipe puxa o matplotlib, que monta um cache de fontes: fica na pasta do Jarvis (uma vez só). Atribuição
# direta: o gancho do PyInstaller já apontou para uma pasta temporária, e aí o cache era refeito a cada início (15 s)
if os.getenv("JARVIS_HOME"):
    os.environ["MPLCONFIGDIR"] = os.path.join(os.environ["JARVIS_HOME"], "mpl")
    os.makedirs(os.environ["MPLCONFIGDIR"], exist_ok=True)
os.environ.setdefault("GLOG_minloglevel", "2")  # menos mensagens do MediaPipe no log


def _sem_sonecas() -> None:
    """Erro fatal (falha de memória numa biblioteca) vai para falhas.log; no Mac, sem App Nap em segundo plano."""
    import faulthandler

    if os.getenv("JARVIS_HOME"):
        f = open(os.path.join(os.environ["JARVIS_HOME"], "falhas.log"), "a", encoding="utf-8")  # noqa: SIM115
        faulthandler.enable(f)
    if sys.platform == "darwin":
        try:
            from Foundation import NSProcessInfo

            # 0x00FFFFFF = NSActivityUserInitiated, menos o "impedir o Mac de dormir"
            _sem_sonecas.token = NSProcessInfo.processInfo().beginActivityWithOptions_reason_(0x00FFFFFF & ~0x100000, "Jarvis ouvindo")
        except Exception:  # noqa: BLE001
            pass


def verificar() -> int:
    from jarvis.config import CODE_ROOT, settings

    out: dict[str, str] = {}
    try:
        from mediapipe.tasks.python import BaseOptions, vision

        from jarvis.hands import MODELO

        vision.GestureRecognizer.create_from_options(
            vision.GestureRecognizerOptions(base_options=BaseOptions(model_asset_path=str(MODELO)), running_mode=vision.RunningMode.VIDEO)
        ).close()
        out["maos"] = "ok"
    except Exception as exc:  # noqa: BLE001
        out["maos"] = f"ERRO {exc}"
    try:
        import vosk

        from jarvis.listener import MODELO as VOSK

        vosk.SetLogLevel(-1)
        vosk.Model(str(VOSK))
        out["voz_offline"] = "ok"
    except Exception as exc:  # noqa: BLE001
        out["voz_offline"] = f"ERRO {exc}"
    try:
        import sounddevice

        out["audio"] = f"ok ({sounddevice.get_portaudio_version()[1]})"
    except Exception as exc:  # noqa: BLE001
        out["audio"] = f"ERRO {exc}"
    try:
        from jarvis import pc

        out["controle_pc"] = f"ok ({pc.SISTEMA})"
    except Exception as exc:  # noqa: BLE001
        out["controle_pc"] = f"ERRO {exc}"
    try:
        import subprocess

        from jarvis import finance

        node = finance._node()  # noqa: SLF001
        if not node:
            out["financeiro"] = "ERRO sem Node"
        else:
            r = subprocess.run([node, "-e", "require('better-sqlite3'); require('./db/router'); console.log('ok')"], cwd=finance.MOTOR,
                               capture_output=True, text=True, timeout=60)
            out["financeiro"] = "ok" if r.stdout.strip() == "ok" else f"ERRO {(r.stderr or r.stdout)[-200:]}"
    except Exception as exc:  # noqa: BLE001
        out["financeiro"] = f"ERRO {exc}"
    out["interface"] = "ok" if (settings.web_dist / "index.html").exists() else f"ERRO sem {settings.web_dist}"
    out["versao"] = (CODE_ROOT / "VERSION").read_text().strip() if (CODE_ROOT / "VERSION").exists() else "?"
    print(json.dumps(out, ensure_ascii=False))
    return 1 if any(v.startswith("ERRO") for v in out.values()) else 0


if __name__ == "__main__":
    multiprocessing.freeze_support()
    if "--verificar" in sys.argv:
        sys.exit(verificar())
    _sem_sonecas()
    from jarvis.app import main

    main()
