"""Roteiro de demonstração: exercita estados, legenda e cartões sem precisar da Gemini.

O clima usa a previsão real do Open-Meteo; a pesquisa é um cartão de exemplo marcado como tal.
"""

import asyncio

from . import tools
from .config import settings
from .hub import hub

PESQUISA_EXEMPLO = {
    "titulo": "Cartão de pesquisa: exemplo de layout",
    "categoria": "Pesquisa · Demonstração",
    "referencia": "Dados fictícios só para mostrar como o cartão se organiza.",
    "grupo": "Comparação · Exemplo",
    "progresso": "100% simulado",
    "itens": [
        {"rotulo": "Opção A", "valor": 47, "valor_texto": "47%", "detalhe": "Cerca de 56 mil respostas", "etiqueta": "Lidera"},
        {"rotulo": "Opção B", "valor": 45, "valor_texto": "45%", "detalhe": "Cerca de 53 mil respostas", "etiqueta": "Segunda"},
        {"rotulo": "Opção C", "valor": 8, "valor_texto": "8%", "detalhe": "Cerca de 9 mil respostas"},
    ],
    "resumo": (
        "Quando a pergunta envolve dados, o Jarvis pesquisa, responde em voz em poucas frases e "
        "projeta aqui os números, o resumo e as fontes."
    ),
    "pontos": [
        "Barras mostram a proporção de cada item",
        "Etiquetas destacam a situação",
        "Fontes ficam no rodapé do cartão",
        "Cartões anteriores descem para a faixa inferior",
    ],
    "fontes": [{"titulo": "Exemplo", "url": "https://example.com"}],
}


async def _say(text: str, wpm: float = 2.6) -> None:
    for word in text.split(" "):
        await hub.broadcast({"type": "model.text", "text": word + " "})
        await asyncio.sleep(1 / wpm)


async def run_demo() -> None:
    await hub.clear_cards()
    await hub.set_status(voice="demo", error=None)
    await asyncio.sleep(1.2)
    await hub.broadcast({"type": "user.text", "text": "Jarvis, como está o tempo hoje?"})
    await asyncio.sleep(0.4)
    await hub.broadcast({"type": "tool", "name": "consultar_clima", "phase": "start"})
    clima = await tools.run("consultar_clima", {"cidade": settings.city})
    await hub.broadcast({"type": "tool", "name": "consultar_clima", "phase": "end"})
    if "erro" in clima:
        await _say(f"Senhor, não consegui a previsão agora: {clima['erro']}")
    else:
        await _say(
            f"Senhor, em {clima['cidade']} faz {str(clima['temperatura']).replace('.', ',')} graus, "
            f"{clima['condicao'].lower()}, com máxima de {str(clima['maxima']).replace('.', ',')} "
            f"e {clima['chuva']}% de chance de chuva."
        )
    await hub.broadcast({"type": "turn", "phase": "complete"})
    await asyncio.sleep(2.5)

    await hub.broadcast({"type": "user.text", "text": "E me mostra um exemplo de pesquisa."})
    await asyncio.sleep(0.5)
    await hub.broadcast({"type": "tool", "name": "google_search", "phase": "start"})
    await asyncio.sleep(1.8)
    await hub.broadcast({"type": "tool", "name": "google_search", "phase": "end"})
    await tools.run("mostrar_pesquisa", PESQUISA_EXEMPLO)
    await _say("Aqui está, Senhor. Os números ficam no cartão e eu falo só o essencial.")
    await hub.broadcast({"type": "turn", "phase": "complete"})
    await asyncio.sleep(1.5)
    await hub.set_status(voice="off")
