"""Configuração lida do .env na raiz do projeto."""

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[2]
load_dotenv(ROOT / ".env")


@dataclass(frozen=True)
class Settings:
    gemini_api_key: str = os.getenv("GEMINI_API_KEY", "")
    live_model: str = os.getenv("GEMINI_LIVE_MODEL", "gemini-3.8-live")
    text_model: str = os.getenv("GEMINI_TEXT_MODEL", "gemini-3.8-flash")
    # "duckduckgo" é grátis; "google" usa a busca embutida da Gemini (exige faturamento ativo)
    search: str = os.getenv("JARVIS_SEARCH", "duckduckgo")
    voice: str = os.getenv("JARVIS_VOICE", "Charon")
    city: str = os.getenv("JARVIS_CITY", "Maceió")
    user_name: str = os.getenv("JARVIS_USER_NAME", "Luca")
    port: int = int(os.getenv("PORT", "8000"))
    frontend_dist: Path = ROOT / "frontend" / "dist"


settings = Settings()
