"""Ferramentas que o modelo de voz pode chamar. Cada uma projeta um cartão nas telas."""

import asyncio
import logging
from typing import Any

import httpx
from google.genai import types

from .config import settings
from .hub import hub
from .memory import TIPOS, memory

log = logging.getLogger("jarvis.tools")

S = "STRING"
N = "NUMBER"

FONTE = {
    "type": "OBJECT",
    "properties": {"titulo": {"type": S}, "url": {"type": S}},
    "required": ["titulo"],
}

DECLARATIONS = [
    types.FunctionDeclaration(
        name="mostrar_pesquisa",
        description=(
            "Projeta na tela principal um cartão com o resultado de uma pesquisa. Use sempre que "
            "a resposta trouxer fatos, números, comparações, placares, preços ou notícias, logo "
            "depois de pesquisar no Google. Fale o essencial em voz e deixe os detalhes no cartão."
        ),
        parameters={
            "type": "OBJECT",
            "properties": {
                "titulo": {"type": S, "description": "Manchete curta com a resposta principal."},
                "categoria": {"type": S, "description": "Ex.: 'Pesquisa · Eleição', 'Pesquisa · Mercado'."},
                "referencia": {"type": S, "description": "Contexto de data/fonte do dado, uma frase."},
                "grupo": {"type": S, "description": "Rótulo da comparação, ex.: 'Primeiro turno · Brasil'."},
                "progresso": {"type": S, "description": "Situação do dado, ex.: '99,9% apurado'. Opcional."},
                "itens": {
                    "type": "ARRAY",
                    "description": "Linhas comparáveis (candidatos, times, produtos). Até 5.",
                    "items": {
                        "type": "OBJECT",
                        "properties": {
                            "rotulo": {"type": S},
                            "valor": {"type": N, "description": "Percentual de 0 a 100 para a barra."},
                            "valor_texto": {"type": S, "description": "Valor como deve aparecer, ex.: '47%'."},
                            "detalhe": {"type": S},
                            "etiqueta": {"type": S, "description": "Situação curta, ex.: 'Vai ao segundo turno'."},
                        },
                        "required": ["rotulo"],
                    },
                },
                "resumo": {"type": S, "description": "Parágrafo de 2 a 4 frases."},
                "pontos": {"type": "ARRAY", "items": {"type": S}, "description": "Até 4 fatos curtos."},
                "fontes": {"type": "ARRAY", "items": FONTE},
            },
            "required": ["titulo", "resumo"],
        },
    ),
    types.FunctionDeclaration(
        name="consultar_clima",
        description=(
            "Busca a previsão do tempo de hoje e projeta um cartão de clima. Use quando perguntarem "
            f"sobre tempo, temperatura ou chuva. Sem cidade, usa {settings.city}."
        ),
        parameters={
            "type": "OBJECT",
            "properties": {"cidade": {"type": S}},
        },
    ),
    types.FunctionDeclaration(
        name="mostrar_lista",
        description=(
            "Projeta um cartão de lista: passos, opções, tarefas, recomendações ou qualquer "
            "resposta que fica melhor como itens."
        ),
        parameters={
            "type": "OBJECT",
            "properties": {
                "titulo": {"type": S},
                "categoria": {"type": S},
                "itens": {
                    "type": "ARRAY",
                    "items": {
                        "type": "OBJECT",
                        "properties": {
                            "titulo": {"type": S},
                            "detalhe": {"type": S},
                            "etiqueta": {"type": S},
                        },
                        "required": ["titulo"],
                    },
                },
            },
            "required": ["titulo", "itens"],
        },
    ),
    types.FunctionDeclaration(
        name="lembrar",
        description=(
            "Guarda algo na memória de longo prazo. Use quando ele pedir para lembrar, quando contar "
            "um fato estável sobre si (trabalho, família, projetos, gostos, rotina) ou quando corrigir você."
        ),
        parameters={
            "type": "OBJECT",
            "properties": {
                "texto": {"type": S, "description": "Uma frase autossuficiente, na terceira pessoa."},
                "tipo": {"type": S, "enum": list(TIPOS), "description": "; ".join(f"{k}: {v}" for k, v in TIPOS.items())},
            },
            "required": ["texto", "tipo"],
        },
    ),
    types.FunctionDeclaration(
        name="buscar_memorias",
        description="Procura na memória o que você já sabe sobre um assunto ou sobre ele. Use antes de dizer que não sabe.",
        parameters={"type": "OBJECT", "properties": {"consulta": {"type": S}}, "required": ["consulta"]},
    ),
    types.FunctionDeclaration(
        name="esquecer",
        description="Apaga da memória o que ele pedir para esquecer.",
        parameters={"type": "OBJECT", "properties": {"descricao": {"type": S}}, "required": ["descricao"]},
    ),
    types.FunctionDeclaration(
        name="fechar_cartoes",
        description="Remove todos os cartões da tela. Use quando pedirem para limpar ou fechar.",
        parameters={"type": "OBJECT", "properties": {}},
    ),
]

SEARCH_DECL = types.FunctionDeclaration(
    name="pesquisar_web",
    description=(
        "Pesquisa na internet e devolve resultados com título, trecho, data e link. Use para qualquer "
        "fato atual, notícia, preço, placar ou dado que você não tenha certeza. Depois, mostre o "
        "resultado com mostrar_pesquisa citando as fontes."
    ),
    parameters={
        "type": "OBJECT",
        "properties": {
            "consulta": {"type": S},
            "tipo": {"type": S, "enum": ["geral", "noticias"], "description": "noticias para fatos recentes."},
        },
        "required": ["consulta"],
    },
)

if settings.search == "google":
    TOOLS = [types.Tool(google_search=types.GoogleSearch()), types.Tool(function_declarations=DECLARATIONS)]
else:
    TOOLS = [types.Tool(function_declarations=[SEARCH_DECL, *DECLARATIONS])]


def _google_news(consulta: str) -> list[dict[str, Any]]:
    """Google Notícias por RSS: grátis, sem chave, ordenado por relevância nos últimos 7 dias."""
    import email.utils
    import xml.etree.ElementTree as ET

    r = httpx.get(
        "https://news.google.com/rss/search",
        params={"q": f"{consulta} when:7d", "hl": "pt-BR", "gl": "BR", "ceid": "BR:pt-419"},
        timeout=10,
        follow_redirects=True,
    )
    out = []
    for item in ET.fromstring(r.text).findall("./channel/item")[:8]:
        title = item.findtext("title") or ""
        source = item.findtext("source") or ""
        if source and title.endswith(f" - {source}"):
            title = title[: -len(source) - 3]
        date = item.findtext("pubDate")
        try:
            date = email.utils.parsedate_to_datetime(date).strftime("%d/%m/%Y %H:%M") if date else None
        except (TypeError, ValueError):
            pass
        out.append({"titulo": title, "fonte": source, "data": date, "url": item.findtext("link")})
    return out


def _search(consulta: str, tipo: str) -> list[dict[str, Any]]:
    from ddgs import DDGS

    if tipo == "noticias":
        try:
            res = _google_news(consulta)
            if res:
                return res
        except Exception as exc:  # noqa: BLE001
            log.warning("google news falhou: %s", exc)
        rows = DDGS().news(consulta, region="br-pt", max_results=6)
        return [
            {"titulo": r.get("title"), "trecho": r.get("body"), "url": r.get("url"),
             "fonte": r.get("source"), "data": r.get("date"), "imagem": r.get("image")}
            for r in rows
        ]
    rows = DDGS().text(consulta, region="br-pt", max_results=6)
    return [{"titulo": r.get("title"), "trecho": r.get("body"), "url": r.get("href")} for r in rows]


async def fetch_weather(city: str) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=10) as http:
        geo = await http.get(
            "https://geocoding-api.open-meteo.com/v1/search",
            params={"name": city, "count": 1, "language": "pt", "format": "json"},
        )
        found = (geo.json().get("results") or [None])[0]
        if not found:
            return {"erro": f"Não encontrei a cidade {city}."}
        fc = await http.get(
            "https://api.open-meteo.com/v1/forecast",
            params={
                "latitude": found["latitude"],
                "longitude": found["longitude"],
                "current": "temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m",
                "daily": "temperature_2m_max,temperature_2m_min,precipitation_probability_max",
                "timezone": "auto",
                "forecast_days": 1,
            },
        )
        d = fc.json()
    cur, day = d["current"], d["daily"]
    texto, icone = WMO.get(cur["weather_code"], ("Tempo instável", "cloud"))
    return {
        "cidade": found["name"],
        "regiao": found.get("admin1", ""),
        "temperatura": round(cur["temperature_2m"], 1),
        "sensacao": round(cur["apparent_temperature"], 1),
        "condicao": texto,
        "icone": icone,
        "minima": round(day["temperature_2m_min"][0], 1),
        "maxima": round(day["temperature_2m_max"][0], 1),
        "chuva": day["precipitation_probability_max"][0],
        "umidade": cur["relative_humidity_2m"],
        "vento": round(cur["wind_speed_10m"], 1),
    }


async def run(name: str, args: dict[str, Any]) -> dict[str, Any]:
    """Executa a ferramenta e devolve o que o modelo deve saber para falar."""
    args = args or {}
    try:
        if name == "mostrar_pesquisa":
            card = await hub.show_card("pesquisa", args)
            return {"ok": True, "cartao": card["id"], "instrucao": "Cartão na tela. Resuma em voz em até 3 frases."}
        if name == "mostrar_lista":
            card = await hub.show_card("lista", args)
            return {"ok": True, "cartao": card["id"]}
        if name == "consultar_clima":
            data = await fetch_weather(args.get("cidade") or settings.city)
            if "erro" not in data:
                await hub.show_card("clima", data)
            return data
        if name == "pesquisar_web":
            res = await asyncio.to_thread(_search, args.get("consulta", ""), args.get("tipo", "geral"))
            return {"resultados": res} if res else {"erro": "A busca não trouxe resultados."}
        if name == "lembrar":
            res = await memory.add(args.get("tipo", "nota"), args.get("texto", ""), fonte="pedido")
            return {"ok": True, **res}
        if name == "buscar_memorias":
            return {"memorias": await memory.search(args.get("consulta", ""))}
        if name == "esquecer":
            gone = await memory.forget(args.get("descricao", ""))
            return {"apagadas": gone} if gone else {"erro": "Não encontrei nada parecido na memória."}
        if name == "fechar_cartoes":
            await hub.clear_cards()
            return {"ok": True}
    except Exception as exc:  # noqa: BLE001 - erro vira resposta falável
        log.exception("ferramenta %s falhou", name)
        return {"erro": f"A ferramenta {name} falhou: {exc}"}
    return {"erro": f"Ferramenta desconhecida: {name}"}
