"""Configuração do Jarvis: pasta de dados do usuário e config.json (escrito pela configuração inicial).

Funciona igual no Mac, Windows e Linux, empacotado (PyInstaller, dentro do app) ou rodando do código.
A pasta de dados vem de JARVIS_HOME (o app passa a dele) ou do padrão de cada sistema:
  Mac      ~/Library/Application Support/Jarvis
  Windows  %APPDATA%\\Jarvis
  Linux    ~/.local/share/jarvis
"""

import json
import os
import shutil
import sys
from pathlib import Path
from typing import Any

FROZEN = getattr(sys, "frozen", False)
CODE_ROOT = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parents[2]))  # repo (dev) ou pasta do executável


def _home() -> Path:
    if os.getenv("JARVIS_HOME"):
        return Path(os.environ["JARVIS_HOME"])
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Jarvis"
    if sys.platform == "win32":
        return Path(os.getenv("APPDATA", Path.home() / "AppData" / "Roaming")) / "Jarvis"
    return Path(os.getenv("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "jarvis"


HOME = _home()
HOME.mkdir(parents=True, exist_ok=True)
DATA = HOME / "data"
DATA.mkdir(exist_ok=True)
CONFIG_FILE = HOME / "config.json"

DEFAULTS: dict[str, Any] = {
    "configurado": False,
    "gemini_api_key": "",
    "user_name": "",
    "city": "",
    "voice": "Charon",
    "live_model": "gemini-3.8-live",
    "text_model": "gemini-3.8-flash",
    "search": "duckduckgo",  # "google" usa a busca embutida da Gemini (exige faturamento)
    "camera_auto": True,  # câmera (gestos) liga junto com o app
    "port": 8765,
}

# chaves do .env antigo (versão 1) que viram config.json na primeira vez
_LEGACY_ENV = {"GEMINI_API_KEY": "gemini_api_key", "JARVIS_USER_NAME": "user_name", "JARVIS_CITY": "city", "JARVIS_VOICE": "voice",
               "GEMINI_LIVE_MODEL": "live_model", "GEMINI_TEXT_MODEL": "text_model", "JARVIS_SEARCH": "search"}


def _migrate_v1(cfg: dict[str, Any]) -> dict[str, Any]:
    """Jarvis 1 no mesmo Mac: traz a chave, o nome, a cidade e a memória (uma vez só)."""
    for root in (Path.home() / "Documents" / "jarvis", CODE_ROOT):
        env, db = root / ".env", root / "data" / "jarvis.db"
        if env.exists() and not cfg.get("gemini_api_key"):
            for line in env.read_text(errors="ignore").splitlines():
                k, _, v = line.partition("=")
                if k.strip() in _LEGACY_ENV and v.strip():
                    cfg[_LEGACY_ENV[k.strip()]] = v.strip()
        if db.exists() and not (DATA / "jarvis.db").exists():
            shutil.copy2(db, DATA / "jarvis.db")
    return cfg


class Settings:
    """Lê o config.json a cada acesso alterado: a configuração inicial e o painel valem na hora."""

    def __init__(self) -> None:
        self._cfg: dict[str, Any] = {}
        self._mtime = -1.0
        if not CONFIG_FILE.exists():
            self.save(_migrate_v1(dict(DEFAULTS)))
        self._load()

    def _load(self) -> None:
        try:
            mtime = CONFIG_FILE.stat().st_mtime
        except OSError:
            mtime = 0
        if mtime != self._mtime:
            try:
                self._cfg = {**DEFAULTS, **json.loads(CONFIG_FILE.read_text())}
            except (OSError, ValueError):
                self._cfg = dict(DEFAULTS)
            self._mtime = mtime

    def save(self, cfg: dict[str, Any]) -> None:
        tmp = CONFIG_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps({**DEFAULTS, **cfg}, ensure_ascii=False, indent=2))
        tmp.replace(CONFIG_FILE)
        if sys.platform != "win32":
            os.chmod(CONFIG_FILE, 0o600)  # tem a chave da IA

    def update(self, **fields: Any) -> None:
        self._load()
        self.save({**self._cfg, **fields})
        self._load()

    def public(self) -> dict[str, Any]:
        self._load()
        out = dict(self._cfg)
        out["tem_chave"] = bool(out.pop("gemini_api_key", ""))
        return out

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        self._load()
        if name in self._cfg:
            return self._cfg[name]
        raise AttributeError(name)

    @property
    def city(self) -> str:  # noqa: D102 - a cidade padrão do clima, se ele não preencher
        self._load()
        return self._cfg.get("city") or "São Paulo"

    @property
    def user_name(self) -> str:  # noqa: D102
        self._load()
        return self._cfg.get("user_name") or "Senhor"

    @property
    def web_dist(self) -> Path:
        return CODE_ROOT / ("web" if FROZEN else "frontend/dist")


settings = Settings()
