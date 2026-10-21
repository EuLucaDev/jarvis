"""Ferramentas que o modelo de voz pode chamar. Cada uma projeta um cartão nas telas."""

import asyncio
import logging
import time
from typing import Any

import httpx
from google.genai import types

from .config import settings
from .hub import hub
from . import store
from .memory import TIPOS, memory
from .sources import news as news_src

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
        name="briefing_bom_dia",
        description=(
            "Monta e apresenta o briefing da manhã: e-mails que pedem atenção, agenda, clima e notícias "
            "por tema. Use quando ele disser bom dia ou pedir o resumo do dia. Depois, leia o roteiro "
            "devolvido do começo ao fim, com naturalidade; os cartões aparecem sozinhos."
        ),
        parameters={"type": "OBJECT", "properties": {"atualizar": {"type": "BOOLEAN", "description": "true para buscar tudo de novo."}}},
    ),
    types.FunctionDeclaration(
        name="ativar_telas",
        description="Desbloqueia (ativar) ou bloqueia as telas adicionais. Ex.: 'ativar monitores', 'bloquear telas'.",
        parameters={"type": "OBJECT", "properties": {"acao": {"type": S, "enum": ["ativar", "bloquear"]}}, "required": ["acao"]},
    ),
    types.FunctionDeclaration(
        name="abrir_app",
        description="Abre um aplicativo do Mac pelo nome.",
        parameters={"type": "OBJECT", "properties": {"nome": {"type": S}}, "required": ["nome"]},
    ),
    types.FunctionDeclaration(
        name="abrir_link",
        description="Abre um site no navegador padrão do Mac.",
        parameters={"type": "OBJECT", "properties": {"url": {"type": S}}, "required": ["url"]},
    ),
    types.FunctionDeclaration(
        name="controlar_midia",
        description="Controla a música no Spotify ou no app Música.",
        parameters={"type": "OBJECT", "properties": {"acao": {"type": S, "enum": ["tocar_pausar", "proxima", "anterior"]}}, "required": ["acao"]},
    ),
    types.FunctionDeclaration(
        name="ajustar_volume",
        description="Ajusta o volume do Mac de 0 a 100.",
        parameters={"type": "OBJECT", "properties": {"nivel": {"type": N}}, "required": ["nivel"]},
    ),
    types.FunctionDeclaration(
        name="executar_atalho",
        description=(
            "Roda um Atalho do macOS liberado pelo usuário. É assim que você alcança o celular, a casa "
            "(HomeKit), a Alexa e outros serviços. Se não souber o nome exato, tente o mais parecido."
        ),
        parameters={
            "type": "OBJECT",
            "properties": {"nome": {"type": S}, "entrada": {"type": S, "description": "Texto opcional passado ao atalho."}},
            "required": ["nome"],
        },
    ),
    types.FunctionDeclaration(
        name="ver_camera",
        description="Mostra a imagem atual de uma câmera cadastrada e deixa você vê-la para descrever o que há nela.",
        parameters={"type": "OBJECT", "properties": {"nome": {"type": S}}, "required": ["nome"]},
    ),
    types.FunctionDeclaration(
        name="controlar_casa",
        description="Liga ou desliga um dispositivo da casa pela Alexa (Voice Monkey): luzes, ventilador, ar, tomadas.",
        parameters={
            "type": "OBJECT",
            "properties": {"dispositivo": {"type": S}, "acao": {"type": S, "enum": ["ligar", "desligar"]}},
            "required": ["dispositivo", "acao"],
        },
    ),
    types.FunctionDeclaration(
        name="criar_lembrete",
        description="Cria um lembrete no app Lembretes, que aparece no iPhone. Ex.: 'me lembre amanhã às 9h de ligar para o banco'.",
        parameters={
            "type": "OBJECT",
            "properties": {
                "texto": {"type": S},
                "quando": {"type": S, "description": "Data e hora ISO local, ex.: 2026-10-22T09:00. Omitir se não houver horário."},
            },
            "required": ["texto"],
        },
    ),
    types.FunctionDeclaration(name="bloquear_tela", description="Apaga e bloqueia a tela do Mac.", parameters={"type": "OBJECT", "properties": {}}),
    types.FunctionDeclaration(
        name="ajustar_brilho",
        description="Ajusta o brilho da tela de 5 a 100.",
        parameters={"type": "OBJECT", "properties": {"nivel": {"type": N}}, "required": ["nivel"]},
    ),
    types.FunctionDeclaration(
        name="arquivos",
        description=(
            "Pastas e arquivos dentro da pasta pessoal. Caminhos curtos: 'Projetos' (na Mesa), 'Downloads', "
            "'Documentos/Contratos'. Ações: criar_pasta, abrir_pasta, buscar (procura pelo nome e abre), "
            "organizar (separa por tipo; exige confirmação), compactar (gera .zip), lixeira (manda para a "
            "Lixeira; exige confirmação). Para organizar e lixeira, chame primeiro sem confirmado, conte o "
            "plano, e só repita com confirmado=true depois do sim dele."
        ),
        parameters={
            "type": "OBJECT",
            "properties": {
                "acao": {"type": S, "enum": ["criar_pasta", "abrir_pasta", "buscar", "organizar", "compactar", "lixeira"]},
                "caminho": {"type": S, "description": "Pasta ou nome do arquivo."},
                "confirmado": {"type": "BOOLEAN"},
            },
            "required": ["acao", "caminho"],
        },
    ),
    types.FunctionDeclaration(
        name="consultar_mercado",
        description="Cotações e gráfico de bolsa, câmbio e cripto. Sem ativos, usa a carteira configurada. Símbolos do Yahoo: PETR4.SA, ^BVSP, BRL=X, BTC-USD.",
        parameters={
            "type": "OBJECT",
            "properties": {"ativos": {"type": "ARRAY", "items": {"type": S}}, "periodo": {"type": S, "enum": ["1d", "5d", "1mo", "6mo", "1y"]}},
        },
    ),
    types.FunctionDeclaration(
        name="ler_mensagens",
        description="Lê mensagens recentes do iMessage/SMS do Mac (por padrão só as não lidas) e mostra num cartão. Pode filtrar por contato.",
        parameters={
            "type": "OBJECT",
            "properties": {"nao_lidas": {"type": "BOOLEAN"}, "de": {"type": S, "description": "Nome do contato ou grupo, opcional."}},
        },
    ),
    types.FunctionDeclaration(
        name="enviar_mensagem",
        description=(
            "Envia iMessage pelo app Mensagens. Sempre chame primeiro sem confirmado, leia o destinatário e o texto "
            "para ele, e só repita com confirmado=true depois do sim."
        ),
        parameters={
            "type": "OBJECT",
            "properties": {"para": {"type": S, "description": "Nome do contato ou número."}, "texto": {"type": S}, "confirmado": {"type": "BOOLEAN"}},
            "required": ["para", "texto"],
        },
    ),
    types.FunctionDeclaration(
        name="notas",
        description="Notas do Obsidian (local) e do Notion. Ações: buscar (procura), ler (abre uma nota do Obsidian pelo título), criar (cria ou acrescenta uma nota no Obsidian, na pasta Jarvis).",
        parameters={
            "type": "OBJECT",
            "properties": {
                "acao": {"type": S, "enum": ["buscar", "ler", "criar"]},
                "consulta": {"type": S, "description": "Termo de busca ou título da nota."},
                "texto": {"type": S, "description": "Conteúdo, para criar."},
            },
            "required": ["acao", "consulta"],
        },
    ),
    types.FunctionDeclaration(
        name="consultar_saude",
        description="Dados do app Saúde do iPhone (passos, sono, frequência em repouso, VFC, treinos) e cartão com o resumo. Os dados são da última exportação.",
        parameters={"type": "OBJECT", "properties": {}},
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


def _search(consulta: str, tipo: str) -> list[dict[str, Any]]:
    from ddgs import DDGS

    if tipo == "noticias":
        try:
            res = news_src.google_news(consulta)
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


# Códigos WMO do Open-Meteo -> (texto, ícone usado no frontend)
WMO = {
    0: ("Céu limpo", "sun"),
    1: ("Predomínio de sol", "sun"),
    2: ("Parcialmente nublado", "cloud-sun"),
    3: ("Nublado", "cloud"),
    45: ("Neblina", "fog"),
    48: ("Neblina", "fog"),
    51: ("Garoa fraca", "drizzle"),
    53: ("Garoa", "drizzle"),
    55: ("Garoa forte", "drizzle"),
    61: ("Chuva fraca", "rain"),
    63: ("Chuva", "rain"),
    65: ("Chuva forte", "rain"),
    80: ("Pancadas de chuva", "rain"),
    81: ("Pancadas de chuva", "rain"),
    82: ("Pancadas fortes", "rain"),
    95: ("Trovoadas", "storm"),
    96: ("Trovoadas com granizo", "storm"),
    99: ("Trovoadas com granizo", "storm"),
}


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
                data = {**data, "instrucao": "O cartão do clima já está na tela; não crie outro cartão."}
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
        if name == "briefing_bom_dia":
            from . import briefing

            loader = await hub.show_card("carregando", {"titulo": "Montando suas prioridades", "etapas": ["E-mails", "Agenda", "Clima", "Notícias"]})
            data = await briefing.build(force=bool(args.get("atualizar")))
            await hub.close_card(loader["id"])
            await hub.clear_cards()
            texto, fila = briefing.sequence(data)
            hub.pending_sequence = fila
            avisos = []
            if not data["configurado"]["gmail"]:
                avisos.append("Gmail ainda não configurado no painel.")
            if not data["configurado"]["agenda"]:
                avisos.append("Agenda ainda não configurada no painel.")
            return {"roteiro": texto, "avisos": avisos, "instrucao": "Leia o roteiro inteiro em voz, sem resumir nem pular."}
        if name == "ativar_telas":
            estado = "ativas" if args.get("acao") == "ativar" else "bloqueadas"
            await hub.set_screens(estado)
            return {"ok": True, "telas": estado, "conectadas": hub.count("tela")}
        if name in ("abrir_app", "abrir_link", "controlar_midia", "ajustar_volume", "executar_atalho"):
            from . import system

            fn = {
                "abrir_app": lambda: system.open_app(args.get("nome", "")),
                "abrir_link": lambda: system.open_link(args.get("url", "")),
                "controlar_midia": lambda: system.media(args.get("acao", "")),
                "ajustar_volume": lambda: system.volume(args.get("nivel", 50)),
                "executar_atalho": lambda: system.run_shortcut(args.get("nome", ""), args.get("entrada")),
            }[name]
            return await asyncio.to_thread(fn)
        if name in ("controlar_casa", "criar_lembrete", "bloquear_tela", "ajustar_brilho", "arquivos"):
            from . import system

            if name == "arquivos":
                acao, cam, ok = args.get("acao"), args.get("caminho", ""), bool(args.get("confirmado"))
                fn = {
                    "criar_pasta": lambda: system.create_folder(cam),
                    "abrir_pasta": lambda: system.open_folder(cam),
                    "buscar": lambda: system.find_file(cam),
                    "organizar": lambda: system.organize_folder(cam, ok),
                    "compactar": lambda: system.zip_folder(cam),
                    "lixeira": lambda: system.trash_item(cam, ok),
                }.get(acao)
                return await asyncio.to_thread(fn) if fn else {"erro": "Ação de arquivos desconhecida."}
            fn = {
                "controlar_casa": lambda: system.alexa(args.get("dispositivo", ""), args.get("acao", "ligar")),
                "criar_lembrete": lambda: system.create_reminder(args.get("texto", ""), args.get("quando")),
                "bloquear_tela": system.lock_screen,
                "ajustar_brilho": lambda: system.brightness(args.get("nivel", 70)),
            }[name]
            return await asyncio.to_thread(fn)
        if name == "consultar_mercado":
            from . import market

            cot = await market.quotes(args.get("ativos") or None, args.get("periodo", "1mo"))
            if not cot:
                return {"erro": "Não consegui as cotações agora."}
            await hub.show_card("mercado", {"titulo": "Mercado agora", "periodo": args.get("periodo", "1mo"), "ativos": cot})
            return {
                "cotacoes": [{k: q[k] for k in ("nome", "preco", "moeda", "variacao")} for q in cot],
                "instrucao": "O cartão do mercado já está na tela. Não chame mostrar_pesquisa; resuma em voz em até 2 frases.",
            }
        if name in ("ler_mensagens", "enviar_mensagem"):
            from .sources import imessage

            if name == "ler_mensagens":
                res = await asyncio.to_thread(imessage.recent, args.get("nao_lidas", True), 15, args.get("de"))
                if "erro" not in res:
                    await hub.show_card("mensagens", {"titulo": "Mensagens novas" if args.get("nao_lidas", True) else "Mensagens recentes", **res})
                    res["instrucao"] = "O cartão já está na tela. Resuma quem escreveu e o essencial; não leia tudo."
                return res
            return await asyncio.to_thread(imessage.send, args.get("para", ""), args.get("texto", ""), bool(args.get("confirmado")))
        if name == "notas":
            from .sources import notes

            acao, q = args.get("acao"), args.get("consulta", "")
            if acao == "buscar":
                res = await asyncio.to_thread(notes.search, q)
                if res.get("notas"):
                    await hub.show_card("lista", {"titulo": f"Notas sobre {q}", "categoria": "Notas · Busca", "itens": [
                        {"titulo": n.get("titulo"), "detalhe": n.get("trecho") or n.get("url") or "", "etiqueta": n.get("fonte")} for n in res["notas"]
                    ]})
                return res
            if acao == "ler":
                return await asyncio.to_thread(notes.read_obsidian, q)
            return await asyncio.to_thread(notes.create_obsidian, q, args.get("texto", ""))
        if name == "consultar_saude":
            from .sources import health

            data = store.get("saude")
            if not data:
                return {"erro": "Sem dados de saúde. Exporte do app Saúde do iPhone e importe em Painel → Saúde."}
            res = health.summary(data)
            await hub.show_card("saude", res)
            return {**res, "instrucao": "O cartão já está na tela; comente o principal em até 2 frases. Não é avaliação médica."}
        if name == "ver_camera":
            from . import system

            cam = system.find_camera(args.get("nome", ""))
            if not cam:
                return {"erro": "Câmera não cadastrada.", "cameras": [c.get("nome") for c in system.cameras()]}
            jpeg = await system.snapshot(cam)
            await hub.show_card("camera", {"id": cam["id"], "nome": cam["nome"], "ts": int(time.time())})
            return {"ok": True, "camera": cam["nome"], "_imagem": jpeg}
        if name == "fechar_cartoes":
            await hub.clear_cards()
            return {"ok": True}
    except Exception as exc:  # noqa: BLE001 - erro vira resposta falável
        log.exception("ferramenta %s falhou", name)
        return {"erro": f"A ferramenta {name} falhou: {exc}"}
    return {"erro": f"Ferramenta desconhecida: {name}"}
