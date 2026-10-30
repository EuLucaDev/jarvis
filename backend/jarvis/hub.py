"""Barramento de eventos: todas as telas conectadas recebem o mesmo estado."""

import asyncio
import contextvars
import logging
import time
import uuid
from typing import Any

from fastapi import WebSocket

log = logging.getLogger("jarvis.hub")

MAX_CARDS = 10

# conversa fora da tela (Telegram): os cartões que as ferramentas criam vão para esta lista, e não para as telas
coletor: contextvars.ContextVar[list[dict[str, Any]] | None] = contextvars.ContextVar("coletor", default=None)


class Hub:
    def __init__(self) -> None:
        self.clients: dict[WebSocket, dict[str, Any]] = {}
        self.cards: list[dict[str, Any]] = []
        self.status: dict[str, Any] = {"voice": "off"}
        self._lock = asyncio.Lock()
        # cartões do briefing que entram durante a fala: (palavras antes do cartão, tipo, dados)
        self.pending_sequence: list[tuple[int, str, dict[str, Any]]] = []
        self.tasks: list[dict[str, Any]] = []  # tarefas passadas a outras IAs (agents.py)
        self.pointed: dict[str, Any] | None = None  # o que a mão está apontando no HUD ("isso aqui")
        self.focus_until = 0.0  # modo foco a dois: avisos esperam até aqui
        self.focus_queue: list[dict[str, Any]] = []
        self.guardados: dict[str, dict[str, Any]] = {}  # cartões das conversas fora da tela (para virar imagem)
        self.plan_card: str | None = None  # cartão do plano que está sendo executado
        # pedidos para o app (mostrar o HUD, ir para o canto, abrir a memória): o app busca em /api/app/comandos,
        # assim funciona mesmo com todas as janelas escondidas
        self.app_queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()

    def app_cmd(self, acao: str, **dados: Any) -> None:
        self.app_queue.put_nowait({"acao": acao, **dados})

    async def join(self, ws: WebSocket, info: dict[str, Any]) -> None:
        self.clients[ws] = info
        await ws.send_json({"type": "sync", "cards": self.cards, "status": self.status, "tarefas": self.tasks})

    def leave(self, ws: WebSocket) -> None:
        self.clients.pop(ws, None)

    async def broadcast(self, msg: dict[str, Any]) -> None:
        dead = []
        for ws in list(self.clients):
            try:
                await ws.send_json(msg)
            except Exception:  # noqa: BLE001 - cliente caiu no meio do envio
                dead.append(ws)
        for ws in dead:
            self.leave(ws)

    def count(self, role: str) -> int:
        return sum(1 for info in self.clients.values() if info.get("role") == role)

    async def play_sequence(self, wps: float = 3.0) -> None:
        """Sem HUD para marcar o ritmo (chat, painel): solta os cartões por tempo estimado."""
        fila, self.pending_sequence = self.pending_sequence, []
        start = asyncio.get_running_loop().time()
        for words, kind, data in fila:
            wait = words / wps - (asyncio.get_running_loop().time() - start)
            if wait > 0:
                await asyncio.sleep(wait)
            await self.show_card(kind, data)

    async def set_status(self, **fields: Any) -> None:
        self.status = {**self.status, **fields}
        await self.broadcast({"type": "status", **self.status})

    async def show_card(self, kind: str, data: dict[str, Any]) -> dict[str, Any]:
        card = {
            "id": uuid.uuid4().hex[:8],
            "kind": kind,
            "at": time.strftime("%H:%M"),
            "data": data,
        }
        lista = coletor.get()
        if lista is not None:
            lista.append(card)
            self.guardados[card["id"]] = card
            if len(self.guardados) > 200:
                self.guardados.pop(next(iter(self.guardados)))
            return card
        async with self._lock:
            self.cards = (self.cards + [card])[-MAX_CARDS:]
        await self.broadcast({"type": "card", "card": card})
        return card

    async def update_card(self, card_id: str, data: dict[str, Any]) -> dict[str, Any] | None:
        card = next((c for c in self.cards if c["id"] == card_id), None) or self.guardados.get(card_id)
        if not card:
            return None
        card["data"] = data
        await self.broadcast({"type": "card.update", "card": card})
        return card

    async def close_card(self, card_id: str) -> None:
        self.cards = [c for c in self.cards if c["id"] != card_id]
        await self.broadcast({"type": "card.close", "id": card_id})

    async def clear_cards(self) -> None:
        self.cards = []
        await self.broadcast({"type": "cards.clear"})


hub = Hub()
