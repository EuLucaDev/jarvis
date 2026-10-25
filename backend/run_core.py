"""Ponto de entrada do núcleo empacotado (PyInstaller).

  jarvis-core              sobe o núcleo (o app Jarvis chama assim)
  jarvis-core --verificar  confere se o pacote está inteiro (modelos de mão e de voz, áudio, interface) e sai
"""

import json
import multiprocessing
import os
import sys

# o MediaPipe puxa o matplotlib, que monta um cache de fontes: fica na pasta do Jarvis (uma vez só)
if os.getenv("JARVIS_HOME"):
    os.environ.setdefault("MPLCONFIGDIR", os.path.join(os.environ["JARVIS_HOME"], "mpl"))
os.environ.setdefault("GLOG_minloglevel", "2")  # menos mensagens do MediaPipe no log


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
    out["interface"] = "ok" if (settings.web_dist / "index.html").exists() else f"ERRO sem {settings.web_dist}"
    out["versao"] = (CODE_ROOT / "VERSION").read_text().strip() if (CODE_ROOT / "VERSION").exists() else "?"
    print(json.dumps(out, ensure_ascii=False))
    return 1 if any(v.startswith("ERRO") for v in out.values()) else 0


if __name__ == "__main__":
    multiprocessing.freeze_support()
    if "--verificar" in sys.argv:
        sys.exit(verificar())
    from jarvis.app import main

    main()
