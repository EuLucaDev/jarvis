"""Barramento de eventos: todas as telas conectadas recebem o mesmo estado."""

import asyncio
import logging
import time
import uuid
from typing import Any

from fastapi import WebSocket

log = logging.getLogger("jarvis.hub")

MAX_CARDS = 8


class Hub:
    def __init__(self) -> None:
        self.clients: dict[WebSocket, dict[str, Any]] = {}
        self.cards: list[dict[str, Any]] = []
        self.status: dict[str, Any] = {"voice": "off"}
        self._lock = asyncio.Lock()

    async def join(self, ws: WebSocket, info: dict[str, Any]) -> None:
        self.clients[ws] = info
        await ws.send_json({"type": "sync", "cards": self.cards, "status": self.status})

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
        async with self._lock:
            self.cards = (self.cards + [card])[-MAX_CARDS:]
        await self.broadcast({"type": "card", "card": card})
        return card

    async def close_card(self, card_id: str) -> None:
        self.cards = [c for c in self.cards if c["id"] != card_id]
        await self.broadcast({"type": "card.close", "id": card_id})

    async def clear_cards(self) -> None:
        self.cards = []
        await self.broadcast({"type": "cards.clear"})


hub = Hub()
