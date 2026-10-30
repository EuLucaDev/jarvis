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
                "temas": {"type": "ARRAY", "items": {"type": S},
                          "description": "1 ou 2 temas curtos do mapa (pessoa, projeto, lugar, assunto). Reuse os que já existem."},
            },
            "required": ["texto", "tipo"],
        },
    ),
    types.FunctionDeclaration(
        name="mostrar_memoria",
        description=(
            "Abre o mapa da memória na tela: ele no centro, os temas e as memórias interligadas. Use para "
            "'mostre minha memória', 'o que você sabe sobre mim' ou 'sobre X' (foco = o tema ou assunto)."
        ),
        parameters={"type": "OBJECT", "properties": {"foco": {"type": S, "description": "Tema ou assunto para destacar, opcional."}}},
    ),
    types.FunctionDeclaration(
        name="buscar_memorias",
        description="Procura na memória o que você já sabe sobre um assunto ou sobre ele. Use antes de dizer que não sabe.",
        parameters={"type": "OBJECT", "properties": {"consulta": {"type": S}}, "required": ["consulta"]},
    ),
    types.FunctionDeclaration(
        name="esquecer",
        description="Apaga da memória uma coisa específica que ele pedir para esquecer (para apagar tudo, use zerar).",
        parameters={"type": "OBJECT", "properties": {"descricao": {"type": S}}, "required": ["descricao"]},
    ),
    types.FunctionDeclaration(
        name="zerar",
        description=(
            "Zera dados do Jarvis: memoria (tudo o que ele aprendeu), historico (conversas, atividade, cartões), "
            "financeiro (todos os dados financeiros) ou tudo (como instalação nova: inclui ajustes e a chave). "
            "Antes guarda um backup por 30 dias (dá para desfazer). Primeiro chame sem confirmado para saber o que "
            "será apagado, diga isso a ele e pergunte; só depois do sim chame com confirmado=true."
        ),
        parameters={"type": "OBJECT", "properties": {
            "o_que": {"type": "ARRAY", "items": {"type": S, "enum": ["memoria", "historico", "financeiro", "tudo"]}},
            "confirmado": {"type": "BOOLEAN"}}, "required": ["o_que"]},
    ),
    types.FunctionDeclaration(
        name="desfazer_zerar",
        description="Desfaz o último zerar (restaura a memória, o histórico, o financeiro e os ajustes do backup). Ou lista os backups.",
        parameters={"type": "OBJECT", "properties": {"acao": {"type": S, "enum": ["desfazer", "listar"]}}},
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
        name="abrir_app",
        description="Abre um aplicativo do computador pelo nome.",
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
            "'Documentos/Contratos', 'Mesa/notas.md'. Ações: criar_pasta; criar_arquivo (conteudo = o texto; sem "
            "extensão vira .txt); ler (texto de txt, md, PDF, Word, PowerPoint, Excel, para ler ou resumir); listar "
            "(o que tem na pasta); abrir (arquivo ou pasta no app padrão; procura pelo nome); buscar (procura e "
            "abre); renomear (novo_nome); mover e copiar (destino = pasta); compactar (.zip); organizar (separa "
            "por tipo); lixeira (apagar: vai para a Lixeira, recuperável). Organizar, lixeira e substituir arquivo "
            "exigem confirmação: chame sem confirmado, conte o plano e repita com confirmado=true depois do sim."
        ),
        parameters={
            "type": "OBJECT",
            "properties": {
                "acao": {"type": S, "enum": ["criar_pasta", "criar_arquivo", "ler", "listar", "abrir", "abrir_pasta", "buscar",
                                              "renomear", "mover", "copiar", "compactar", "organizar", "lixeira"]},
                "caminho": {"type": S, "description": "Pasta ou arquivo."},
                "conteudo": {"type": S, "description": "Texto do arquivo (criar_arquivo)."},
                "novo_nome": {"type": S},
                "destino": {"type": S, "description": "Pasta de destino (mover, copiar)."},
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
        name="abrir_painel",
        description=(
            "Abre na tela principal um painel grande: agenda (agenda, relógio e clima), comunicacoes "
            "(e-mails e transcrição), radar (notícias por tema), nucleo (sistema do Mac), cameras. "
            "Use 'fechar' para voltar à esfera. Funciona mesmo com um monitor só."
        ),
        parameters={
            "type": "OBJECT",
            "properties": {"visao": {"type": S, "enum": ["agenda", "comunicacoes", "radar", "nucleo", "cameras", "fechar"]}},
            "required": ["visao"],
        },
    ),
    types.FunctionDeclaration(
        name="executar_protocolo",
        description=(
            "Executa um protocolo (rotina com nome, do painel ou criada por voz com rotinas): abre apps e sites, ajusta "
            "volume e brilho, roda atalhos, liga a casa, abre painéis. Ex.: 'modo foco', 'protocolo trabalho'."
        ),
        parameters={"type": "OBJECT", "properties": {"nome": {"type": S}}, "required": ["nome"]},
    ),
    types.FunctionDeclaration(
        name="financeiro_lancar",
        description=(
            "Lança um gasto ou uma entrada AVULSA no financeiro (para o que repete todo mês use financeiro_fixa) e mostra o cartão com Desfazer (salva na hora). frase = o que "
            "ele disse, inteiro ('paguei 80 no mercado ontem no crédito do Nubank em 2x'); o leitor tira valor, data, "
            "forma, parcelas, conta/cartão e categoria. Os outros campos só se ele disser algo que a frase não tem ou "
            "corrigir (categoria dita vira regra para as próximas vezes)."
        ),
        parameters={
            "type": "OBJECT",
            "properties": {
                "frase": {"type": S},
                "tipo": {"type": S, "enum": ["gasto", "entrada"]},
                "valor": {"type": N},
                "conta": {"type": S, "description": "Conta bancária pelo nome (Inter, Itaú…)."},
                "cartao": {"type": S, "description": "Cartão pelo nome (Nubank…)."},
                "forma": {"type": S, "enum": ["pix", "debito", "dinheiro", "credito", "vale"]},
                "parcelas": {"type": "INTEGER"},
                "data": {"type": S, "description": "AAAA-MM-DD."},
                "categoria": {"type": S},
                "descricao": {"type": S},
            },
            "required": ["frase"],
        },
    ),
    types.FunctionDeclaration(
        name="financeiro_fixa",
        description=(
            "Despesa fixa ou receita fixa: o que se repete TODO MÊS (aluguel, condomínio, internet, academia, "
            "assinatura, salário, mesada). Use esta (e não financeiro_lancar) quando ele disser fixa, todo mês, mensal, "
            "recorrente. criar já lança no mês atual (vai para o A pagar). listar mostra as fixas; remover pede o sim."
        ),
        parameters={
            "type": "OBJECT",
            "properties": {
                "acao": {"type": S, "enum": ["criar", "listar", "pausar", "retomar", "editar", "remover"]},
                "tipo": {"type": S, "enum": ["despesa", "receita"]},
                "nome": {"type": S, "description": "Ex.: Aluguel, Internet, Salário."},
                "valor": {"type": N},
                "dia": {"type": "INTEGER", "description": "Dia do mês em que vence (ou cai)."},
                "categoria": {"type": S},
                "conta": {"type": S},
                "cartao": {"type": S},
                "forma": {"type": S, "enum": ["pix", "debito", "dinheiro", "credito", "vale"]},
                "lancar_este_mes": {"type": "BOOLEAN", "description": "NÃO passe, a menos que ele diga explicitamente se já entra neste mês. Sem isto: entra neste mês se o dia ainda não passou, senão no próximo."},
                "confirmado": {"type": "BOOLEAN"},
            },
            "required": ["tipo"],
        },
    ),
    types.FunctionDeclaration(
        name="financeiro_lancamentos",
        description="Mostra lançamentos (gastos e entradas) de um mês com filtros: texto (ex.: Uber, mercado), categoria, data, valor, tipo. Use para 'o que eu gastei ontem', 'meus gastos com Uber este mês'.",
        parameters={"type": "OBJECT", "properties": {"mes": {"type": S, "description": "AAAA-MM; vazio = este mês."}, "texto": {"type": S},
                                                      "categoria": {"type": S}, "data": {"type": S, "description": "AAAA-MM-DD."},
                                                      "valor": {"type": N}, "tipo": {"type": S, "enum": ["gasto", "entrada", "todos"]}}},
    ),
    types.FunctionDeclaration(
        name="financeiro_editar",
        description=(
            "Corrige ou apaga um lançamento já feito: acha pelo texto/data/valor (o mais recente que bater) e muda "
            "valor, categoria, data ou descrição, ou apaga (pede o sim). Ex.: 'o mercado de ontem foi 92', 'aquele Uber "
            "era trabalho', 'apaga o iFood de hoje'. Categoria corrigida vira regra para o mesmo lugar."
        ),
        parameters={"type": "OBJECT", "properties": {"acao": {"type": S, "enum": ["alterar", "apagar"]}, "texto": {"type": S},
                                                      "data": {"type": S}, "valor_atual": {"type": N}, "mes": {"type": S},
                                                      "novo_valor": {"type": N}, "nova_categoria": {"type": S}, "nova_data": {"type": S},
                                                      "nova_descricao": {"type": S}, "confirmado": {"type": "BOOLEAN"}},
                    "required": ["acao"]},
    ),
    types.FunctionDeclaration(
        name="financeiro_orcamento",
        description="Orçamento por categoria: ver (como está), definir (categoria + valor por mês), remover, sugerir (pelo histórico, pela mediana dos últimos meses).",
        parameters={"type": "OBJECT", "properties": {"acao": {"type": S, "enum": ["ver", "definir", "remover", "sugerir"]},
                                                      "categoria": {"type": S}, "valor": {"type": N}}, "required": ["acao"]},
    ),
    types.FunctionDeclaration(
        name="financeiro_regra",
        description="Regras de categoria: 'Uber é sempre transporte' (criar: termo + categoria; já aplica nos lançamentos sem categoria) ou listar.",
        parameters={"type": "OBJECT", "properties": {"acao": {"type": S, "enum": ["criar", "listar"]}, "termo": {"type": S},
                                                      "categoria": {"type": S}, "tipo": {"type": S, "enum": ["gasto", "entrada"]}}, "required": ["acao"]},
    ),
    types.FunctionDeclaration(
        name="financeiro_fatura",
        description="Detalhe da fatura de um cartão (compras e parcelas do mês) e o limite usado/disponível.",
        parameters={"type": "OBJECT", "properties": {"cartao": {"type": S}, "mes": {"type": S, "description": "AAAA-MM; vazio = a próxima a vencer."}}},
    ),
    types.FunctionDeclaration(
        name="financeiro_investir",
        description="Investimentos: resumo da carteira, aportar ou resgatar (valor, de qual investimento, conta).",
        parameters={"type": "OBJECT", "properties": {"acao": {"type": S, "enum": ["resumo", "aportar", "resgatar"]}, "investimento": {"type": S},
                                                      "valor": {"type": N}, "conta": {"type": S}, "data": {"type": S}}, "required": ["acao"]},
    ),
    types.FunctionDeclaration(
        name="financeiro_avancado",
        description=(
            "Modo avançado: qualquer coisa do financeiro que as outras ferramentas não fazem (metas e itens, editar "
            "contas e cartões, investimentos novos, relatórios, backup, anexos…). catalogo sem assunto lista as áreas; "
            "com assunto (ex.: goals, reports, investments) mostra as operações e os campos. executar roda uma "
            "operação com args na ordem dos parametros; escrita só com confirmado=true depois do sim."
        ),
        parameters={"type": "OBJECT", "properties": {"acao": {"type": S, "enum": ["catalogo", "executar"]}, "assunto": {"type": S},
                                                      "operacao": {"type": S}, "args_json": {"type": S, "description": "Lista JSON com os argumentos na ordem dos parametros, ex.: [\"goal_123\", {\"name\": \"Buffet\", \"plannedAmount\": 800}]"},
                                                      "confirmado": {"type": "BOOLEAN"}}, "required": ["acao"]},
    ),
    types.FunctionDeclaration(
        name="financeiro_consultar",
        description=(
            "Consulta o financeiro e mostra um cartão: resumo_mes (entrou, saiu, sobrou, maiores categorias), "
            "gastos_categoria (categoria = 'mercado', 'comida'…), saldos (contas), a_pagar (dias = 7 por padrão), "
            "faturas (abertas), orcamento (quanto de cada orçamento já foi e se vai estourar), metas, assinaturas "
            "(gastos que se repetem e aumentos de preço), fechamento (passo a passo do fim do mês), proximas_acoes."
        ),
        parameters={
            "type": "OBJECT",
            "properties": {
                "assunto": {"type": S, "enum": ["resumo_mes", "gastos_categoria", "saldos", "a_pagar", "faturas", "orcamento",
                                                 "metas", "assinaturas", "fechamento", "proximas_acoes"]},
                "mes": {"type": S, "description": "AAAA-MM; vazio = este mês."},
                "categoria": {"type": S},
                "dias": {"type": "INTEGER"},
            },
            "required": ["assunto"],
        },
    ),
    types.FunctionDeclaration(
        name="financeiro_transferir",
        description="Transferência entre contas dele (não conta como gasto nem entrada).",
        parameters={"type": "OBJECT", "properties": {"valor": {"type": N}, "de": {"type": S}, "para": {"type": S}, "data": {"type": S}},
                    "required": ["valor", "de", "para"]},
    ),
    types.FunctionDeclaration(
        name="financeiro_pagar",
        description=(
            "Marca como paga uma conta do A pagar ('aluguel') ou paga a fatura de um cartão ('fatura do Nubank') por "
            "uma conta. Mexe no saldo: chame sem confirmado, diga o que vai pagar e repita com confirmado=true depois do sim."
        ),
        parameters={"type": "OBJECT", "properties": {"o_que": {"type": S}, "conta": {"type": S}, "confirmado": {"type": "BOOLEAN"}},
                    "required": ["o_que"]},
    ),
    types.FunctionDeclaration(
        name="financeiro_meta",
        description="Metas (caixinhas): guardar ou retirar dinheiro (sai/volta da conta), criar (valor = alvo, prazo AAAA-MM-DD) ou listar.",
        parameters={"type": "OBJECT", "properties": {"acao": {"type": S, "enum": ["guardar", "retirar", "criar", "listar"]},
                                                      "meta": {"type": S}, "valor": {"type": N}, "conta": {"type": S}, "prazo": {"type": S}},
                    "required": ["acao"]},
    ),
    types.FunctionDeclaration(
        name="financeiro_importar",
        description=(
            "Importa extratos e faturas (PDF, CSV, OFX ou foto; Inter, Nubank, Santander e Mercado Pago com leitor próprio) "
            "de arquivos ou de uma pasta ('Downloads', 'Mesa/extratos'). Primeiro mostra a prévia; só grava com "
            "confirmado=true depois do sim."
        ),
        parameters={"type": "OBJECT", "properties": {"arquivos": {"type": "ARRAY", "items": {"type": S}}, "pasta": {"type": S},
                                                      "confirmado": {"type": "BOOLEAN"}}},
    ),
    types.FunctionDeclaration(
        name="financeiro_cadastrar",
        description=(
            "Cadastra uma conta bancária (nome, saldo atual) ou um cartão (cartão de crédito: limite, dia_fechamento, "
            "dia_vencimento; vale: tipo_cartao 'vale refeição' ou 'vale alimentação' e saldo). cor: o nome da cor, se ele disser. "
            "Para editar um cartão ou conta já cadastrado (cor, limite, dias, nome, ativar/inativar), carregue financeiro_cadastros."
        ),
        parameters={"type": "OBJECT", "properties": {"o_que": {"type": S, "enum": ["conta", "cartao"]}, "nome": {"type": S}, "banco": {"type": S},
                                                      "saldo": {"type": N}, "tipo_cartao": {"type": S}, "limite": {"type": N},
                                                      "dia_fechamento": {"type": "INTEGER"}, "dia_vencimento": {"type": "INTEGER"},
                                                      "cor": {"type": S}},
                    "required": ["o_que", "nome"]},
    ),
    types.FunctionDeclaration(
        name="financeiro_desfazer",
        description="Desfaz o último lançamento, transferência ou depósito em meta que você fez por voz.",
        parameters={"type": "OBJECT", "properties": {}},
    ),
    types.FunctionDeclaration(
        name="financeiro_abrir",
        description="Abre a janela do financeiro numa página: visao_geral, lancamentos, a_pagar, carteira, investimentos, metas, relatorios, configuracoes.",
        parameters={"type": "OBJECT", "properties": {"pagina": {"type": S}}},
    ),
    types.FunctionDeclaration(
        name="rotinas",
        description=(
            "Cria, lista ou apaga rotinas (automações). criar: nome, passos e, se ele quiser no horário, hora (HH:MM) "
            "e dias (0=segunda … 6=domingo; vazio = todo dia); frases = jeitos de chamar; fala = o que você diz ao "
            "terminar. Tipos de passo: app (nome), link (endereço), aba (endereço ou pesquisa), janela (app:acao, "
            "ex.: Spotify:minimizar, Chrome:esquerda), pasta (caminho), volume (0-100), brilho, midia (tocar_pausar, "
            "proxima), espelho (ligar/desligar), camera (ligar/desligar), painel (agenda, comunicacoes, radar, "
            "nucleo, fechar), limpar, esperar (segundos), atalho (Atalhos do macOS), casa (Alexa dispositivo:ligar). "
            "Antes de criar, diga em uma frase o que a rotina vai fazer e quando."
        ),
        parameters={
            "type": "OBJECT",
            "properties": {
                "acao": {"type": S, "enum": ["criar", "listar", "apagar"]},
                "nome": {"type": S},
                "passos": {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {"tipo": {"type": S}, "valor": {"type": S}}, "required": ["tipo"]}},
                "hora": {"type": S},
                "dias": {"type": "ARRAY", "items": {"type": "INTEGER"}},
                "frases": {"type": "ARRAY", "items": {"type": S}},
                "fala": {"type": S},
            },
            "required": ["acao"],
        },
    ),
    types.FunctionDeclaration(
        name="delegar_tarefa",
        description=(
            "Passa uma tarefa para outra IA instalada neste computador, que roda em segundo plano: 'claude' (Claude Code, "
            "cria arquivos e usa MCPs como ElevenLabs e Google Drive), 'codex' (Codex com o ChatGPT dele, cria "
            "arquivos e código) ou 'chatgpt' (só pergunta e resposta). Os arquivos ficam em ~/Jarvis/Tarefas. "
            "claude e codex exigem confirmado=true depois do sim dele."
        ),
        parameters={
            "type": "OBJECT",
            "properties": {
                "agente": {"type": S, "enum": ["claude", "codex", "chatgpt"]},
                "tarefa": {"type": S, "description": "Pedido completo e autossuficiente, com todos os detalhes que ele deu."},
                "titulo": {"type": S, "description": "Nome curto da tarefa, até 6 palavras."},
                "confirmado": {"type": "BOOLEAN"},
            },
            "required": ["agente", "tarefa"],
        },
    ),
    types.FunctionDeclaration(
        name="consultar_tarefas",
        description="Mostra o andamento das tarefas passadas a outras IAs (rodando, feitas, com erro).",
        parameters={"type": "OBJECT", "properties": {}},
    ),
    types.FunctionDeclaration(
        name="digitar",
        description=(
            "Escreve um texto no Mac, à vista dele, como se fosse o teclado: num app (Notas, Mail, Chrome, Word, "
            "WhatsApp…) ou no campo onde o cursor está. Passe app para trazer o app à frente antes. Use enter=true "
            "para mandar/pesquisar no fim. Nunca digite senhas."
        ),
        parameters={
            "type": "OBJECT",
            "properties": {"texto": {"type": S}, "app": {"type": S, "description": "Nome do app, opcional."}, "enter": {"type": "BOOLEAN"}},
            "required": ["texto"],
        },
    ),
    types.FunctionDeclaration(
        name="teclas",
        description=(
            "Aperta uma tecla ou atalho no Mac, à vista: 'cmd+n' (novo), 'cmd+t' (nova aba), 'cmd+s', 'cmd+a', "
            "'enter', 'tab', 'esc', 'cima', 'baixo'. Passe app para trazer o app à frente antes. Atalhos que "
            "fecham ou apagam (cmd+q, cmd+delete) exigem confirmado=true depois do sim."
        ),
        parameters={
            "type": "OBJECT",
            "properties": {"atalho": {"type": S}, "app": {"type": S}, "confirmado": {"type": "BOOLEAN"}},
            "required": ["atalho"],
        },
    ),
    types.FunctionDeclaration(
        name="navegador",
        description=(
            "Navegador dele, à vista. nova_aba (valor = endereço ou termo); buscar (valor = o que pesquisar; site = "
            "youtube, imagens, maps, wikipedia, mercado livre, amazon, github, spotify, noticias ou vazio p/ Google); "
            "abrir_resultados (pesquisa e abre os 3 melhores resultados em abas); ler_pagina (texto da aba aberta, "
            "para ler em voz alta, resumir ou responder sobre ela; mostre o resumo num cartão se for longo); "
            "localizar (valor = palavra na página); fechar_aba, proxima_aba, aba_anterior, ir_para_aba (valor = número), "
            "reabrir_aba, voltar, avancar, recarregar, rolar_baixo, rolar_cima, zoom_mais, zoom_menos, zoom_normal, "
            "favoritar, nova_janela, janela_anonima, historico."
        ),
        parameters={
            "type": "OBJECT",
            "properties": {
                "acao": {"type": S, "enum": ["nova_aba", "buscar", "abrir_resultados", "ler_pagina", "localizar", "fechar_aba",
                                              "proxima_aba", "aba_anterior", "ir_para_aba", "reabrir_aba", "voltar", "avancar",
                                              "recarregar", "rolar_baixo", "rolar_cima", "zoom_mais", "zoom_menos", "zoom_normal",
                                              "favoritar", "nova_janela", "janela_anonima", "historico"]},
                "valor": {"type": S},
                "site": {"type": S},
            },
            "required": ["acao"],
        },
    ),
    types.FunctionDeclaration(
        name="contexto_atual",
        description=(
            "O que ele está fazendo agora no Mac: app e janela da frente, endereço da aba, texto selecionado, o que "
            "está embaixo do mouse e o que a mão dele aponta no HUD. Chame SEMPRE que ele disser 'isso', 'isso aqui', "
            "'esse texto', 'essa página', 'aqui', 'melhora', 'resume', 'traduz' sem dizer o quê."
        ),
        parameters={"type": "OBJECT", "properties": {"com_selecao": {"type": "BOOLEAN", "description": "false para não copiar a seleção."}}},
    ),
    types.FunctionDeclaration(
        name="olhar",
        description=(
            "Vai até uma parte da tela dele e olha (a esfera voa até lá e destaca a área), recebendo a imagem e os "
            "elementos dali. Use quando ele disser 'tá vendo essa barra lateral', 'olha esse canto', 'essa planilha', "
            "antes de alterar algo. regiao em relação à janela da frente, ou alvo com o nome de um elemento."
        ),
        parameters={
            "type": "OBJECT",
            "properties": {
                "regiao": {"type": S, "enum": ["janela", "barra_lateral", "barra_lateral_direita", "topo", "rodape", "centro",
                                                "canto_superior_esquerdo", "canto_superior_direito", "canto_inferior_esquerdo",
                                                "canto_inferior_direito", "mouse"]},
                "alvo": {"type": S, "description": "Nome de um botão, aba, coluna ou campo visível, opcional."},
            },
        },
    ),
    types.FunctionDeclaration(
        name="janela_jarvis",
        description="Janela do Jarvis: minimizar (vai para o canto como esfera pequena), esconder (só o ícone na barra de menus, segue ouvindo 'Jarvis' e palmas) ou mostrar.",
        parameters={"type": "OBJECT", "properties": {"acao": {"type": S, "enum": ["minimizar", "esconder", "mostrar"]}}, "required": ["acao"]},
    ),
    types.FunctionDeclaration(
        name="usar_menu",
        description=(
            "Usa a barra de menus de um app pelo nome, à vista: caminho = 'Arquivo > Exportar como PDF', "
            "'Formatar > Fonte > Negrito', 'Visualizar > Mostrar barra lateral'. app opcional (traz à frente). "
            "Se não achar, devolve as opções daquele nível."
        ),
        parameters={"type": "OBJECT", "properties": {"caminho": {"type": S}, "app": {"type": S}}, "required": ["caminho"]},
    ),
    types.FunctionDeclaration(
        name="controlar_janela",
        description=(
            "Mexe nas janelas de qualquer app aberto, à vista: minimizar, restaurar (volta da minimizada), focar "
            "(trazer para a frente), maximizar, tela_cheia, esquerda/direita (metade da tela), outro_monitor, fechar "
            "(a janela), esconder, sair (fecha o app inteiro, só com confirmado=true depois do sim). app = o nome que "
            "ele disser ('navegador', 'Chrome', 'Spotify', 'WhatsApp'); vazio = o app da frente. Para abrir um app "
            "use abrir_app; para a janela do próprio Jarvis use janela_jarvis."
        ),
        parameters={
            "type": "OBJECT",
            "properties": {
                "app": {"type": S},
                "acao": {"type": S, "enum": ["minimizar", "restaurar", "focar", "maximizar", "tela_cheia", "esquerda", "direita",
                                              "outro_monitor", "fechar", "esconder", "sair"]},
                "confirmado": {"type": "BOOLEAN"},
            },
            "required": ["acao"],
        },
    ),
    types.FunctionDeclaration(
        name="espelhar_tela",
        description=(
            "Espelho da tela: ligar (você passa a ver a tela dele o tempo todo, como numa chamada com a tela "
            "compartilhada, e ela aparece no HUD), desligar, ou ver (uma foto da tela agora; telas=todas para "
            "ver todos os monitores juntos)."
        ),
        parameters={"type": "OBJECT", "properties": {"acao": {"type": S, "enum": ["ligar", "desligar", "ver"]},
                                                     "telas": {"type": S, "enum": ["principal", "todas"]}}, "required": ["acao"]},
    ),
    types.FunctionDeclaration(
        name="substituir_selecao",
        description="Troca o texto selecionado no app da frente pelo novo (ou insere onde está o cursor), à vista. Use depois de contexto_atual para reescrever, traduzir ou corrigir.",
        parameters={"type": "OBJECT", "properties": {"texto": {"type": S}}, "required": ["texto"]},
    ),
    types.FunctionDeclaration(
        name="clicar",
        description=(
            "Clica num botão, link, aba, menu ou campo da janela da frente pelo nome que aparece na tela "
            "(ex.: 'Enviar', 'Nova mensagem', 'Arquivo'). O cursor do Jarvis vai até lá à vista. Se não achar, "
            "devolve as opções da tela. Passe app para trazer o app à frente antes."
        ),
        parameters={"type": "OBJECT", "properties": {"alvo": {"type": S}, "app": {"type": S}}, "required": ["alvo"]},
    ),
    types.FunctionDeclaration(
        name="mostrar_plano",
        description="Mostra na tela o plano de uma tarefa de vários passos no Mac antes de começar. Depois marque cada passo com atualizar_plano.",
        parameters={
            "type": "OBJECT",
            "properties": {"titulo": {"type": S}, "passos": {"type": "ARRAY", "items": {"type": S}}},
            "required": ["titulo", "passos"],
        },
    ),
    types.FunctionDeclaration(
        name="atualizar_plano",
        description="Marca um passo do plano na tela (número a partir de 1): fazendo, feito, pulado ou erro.",
        parameters={
            "type": "OBJECT",
            "properties": {"passo": {"type": N}, "estado": {"type": S, "enum": ["fazendo", "feito", "pulado", "erro"]}},
            "required": ["passo", "estado"],
        },
    ),
    types.FunctionDeclaration(
        name="parar",
        description="Para na hora o que você estiver fazendo no Mac (digitação, plano). Use quando ele disser 'espera', 'para', 'pera aí'.",
        parameters={"type": "OBJECT", "properties": {}},
    ),
    types.FunctionDeclaration(
        name="onde_parei",
        description="Linha do tempo do que ele fez no Mac nas últimas horas (apps, janelas, páginas). Para 'onde eu parei?' e 'volta para o que eu estava fazendo'.",
        parameters={"type": "OBJECT", "properties": {"horas": {"type": N}}},
    ),
    types.FunctionDeclaration(
        name="modo_foco",
        description="Foco a dois: segura os avisos não urgentes por X minutos e dá um resumo no fim. minutos=0 encerra.",
        parameters={"type": "OBJECT", "properties": {"minutos": {"type": N}}, "required": ["minutos"]},
    ),
    types.FunctionDeclaration(
        name="camera",
        description=(
            "Câmera do computador: ligar (ele passa a usar as mãos como ponteiro e você pode ver), desligar, "
            "ou ver (você recebe a imagem de agora para descrever)."
        ),
        parameters={"type": "OBJECT", "properties": {"acao": {"type": S, "enum": ["ligar", "desligar", "ver"]}}, "required": ["acao"]},
    ),
    types.FunctionDeclaration(
        name="fechar_cartoes",
        description="Remove todos os cartões da tela. Use quando pedirem para limpar ou fechar.",
        parameters={"type": "OBJECT", "properties": {}},
    ),
]

# Ferramentas lentas que não travam a conversa: ele avisa que vai verificar e responde quando chegar.
NON_BLOCKING = {"pesquisar_web", "pensar"}

# Cérebro forte: a voz é rápida mas pensa pouco; pedidos difíceis vão para a Gemini Pro com raciocínio.
PENSAR_DECL = types.FunctionDeclaration(
    name="pensar",
    behavior=types.Behavior.NON_BLOCKING,
    description=(
        "Consulta um modelo mais forte, que raciocina com calma (leva alguns segundos). Use para o que exige "
        "pensar de verdade: análise, estratégia, decisão entre opções, contas e planejamento financeiro, plano "
        "de projeto, texto caprichado (proposta, e-mail importante, roteiro), explicação difícil, revisar um "
        "raciocínio; ou quando ele disser 'pensa melhor', 'pensa com calma'. Mande a pergunta completa e o "
        "contexto que você já tem (dados de ferramentas, o que ele disse antes). Diga numa frase que vai pensar; "
        "quando a resposta chegar, fale o essencial e mostre o detalhe num cartão (mostrar_lista ou mostrar_pesquisa)."
    ),
    parameters={
        "type": "OBJECT",
        "properties": {
            "pergunta": {"type": S, "description": "O que ele quer, completo."},
            "contexto": {"type": S, "description": "Dados e detalhes que ajudam (números, nomes, o que já se sabe)."},
            "formato": {"type": S, "description": "Como quer a resposta: lista de passos, texto pronto, comparação, número…"},
        },
        "required": ["pergunta"],
    },
)
# A Pro exige chave com faturamento (no grátis a cota dela é zero); sem ela, os Flash pensando no máximo
_CEREBRO_PAUSA: dict[str, float] = {}
CEREBROS = ["gemini-pro-latest", "gemini-3.1-pro-preview", "gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.5-flash", "gemini-flash-latest"]


async def _pensar(a: dict[str, Any]) -> dict[str, Any]:
    from .llm import client
    from .memory import memory

    c = client()
    if not c:
        return {"erro": "Sem chave da Gemini."}
    prompt = f"""Você é o raciocínio do J.A.R.V.I.S., assistente de {settings.user_name}. Hoje é {time.strftime('%d/%m/%Y %H:%M')}.
Pense com cuidado e responda em português do Brasil, direto ao ponto, sem enrolação. A resposta vai ser
falada (o essencial primeiro, em 1 a 3 frases) e o detalhe mostrado na tela.
Se faltar um dado importante, diga qual e trabalhe com a melhor suposição, deixando isso claro. Não invente números.

O que se sabe sobre ele:
{memory.prompt_block(25)}

Pedido: {a.get('pergunta', '')}
Contexto: {a.get('contexto') or '—'}
Formato desejado: {a.get('formato') or 'o que for mais útil'}

Responda em JSON com: "fala" (o essencial para dizer em voz, até 3 frases), "titulo" (curto) e "detalhe"
(lista de itens curtos com o raciocínio, passos ou o texto pronto)."""
    schema = {"type": "OBJECT", "properties": {"fala": {"type": "STRING"}, "titulo": {"type": "STRING"},
                                               "detalhe": {"type": "ARRAY", "items": {"type": "STRING"}}},
              "required": ["fala", "detalhe"]}
    import json as _json

    inicio = time.monotonic()
    for modelo in CEREBROS:
        if _CEREBRO_PAUSA.get(modelo, 0) > time.time():
            continue  # sem cota ou sobrecarregado há pouco: nem tenta
        restante = 75 - (time.monotonic() - inicio)
        if restante < 8:
            break
        try:
            r = await asyncio.wait_for(c.aio.models.generate_content(
                model=modelo, contents=prompt,
                config=types.GenerateContentConfig(response_mime_type="application/json", response_schema=schema,
                                                   thinking_config=types.ThinkingConfig(thinking_budget=-1),
                                                   http_options=types.HttpOptions(retry_options=types.HttpRetryOptions(attempts=1))),
            ), timeout=min(45, restante))
            out = _json.loads(r.text or "{}")
            itens = [str(x) for x in out.get("detalhe") or []][:14]
            if itens:
                await hub.show_card("lista", {"titulo": out.get("titulo") or "Pensando com calma", "categoria": "Raciocínio",
                                              "itens": [{"titulo": x} for x in itens]})
            return {"fala": out.get("fala", ""), "detalhe": itens, "modelo": modelo,
                    "instrucao": "Fale a 'fala' com naturalidade. O detalhe já está num cartão na tela; não leia a lista inteira."}
        except Exception as exc:  # noqa: BLE001 - cota ou modelo indisponível: tenta o próximo
            msg = str(exc)
            # cota zero (a Pro no plano grátis) ou do dia: 6 h; limite por minuto: 1 min; sobrecarga/tempo: 2 min
            pausa = 21600 if ("limit: 0" in msg or "PerDay" in msg) else 60 if "429" in msg else 120
            _CEREBRO_PAUSA[modelo] = time.time() + pausa
            log.warning("pensar com %s falhou: %s", modelo, msg[:160] or type(exc).__name__)
    return {"erro": "Não consegui pensar com o modelo forte agora (cota ou instabilidade). Responda com o que você sabe."}

SEARCH_DECL = types.FunctionDeclaration(
    name="pesquisar_web",
    behavior=types.Behavior.NON_BLOCKING,
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
    TOOLS = [types.Tool(google_search=types.GoogleSearch()), types.Tool(function_declarations=[PENSAR_DECL, *DECLARATIONS])]
else:
    TOOLS = [types.Tool(function_declarations=[SEARCH_DECL, PENSAR_DECL, *DECLARATIONS])]


def por_assunto() -> bool:
    """Carregar as ferramentas do financeiro e dos sistemas só quando o assunto aparece (padrão: sim)."""
    return (store.get("voz") or {}).get("por_assunto", True) is not False


def assuntos_disponiveis() -> dict[str, str]:
    """Assunto → o que ele cobre (para a voz saber quando carregar)."""
    from . import sistemas

    from . import finance_completo

    out = {"financeiro": "dinheiro pessoal no dia a dia: lançar e ver gastos e entradas, contas fixas, faturas, orçamento, metas, "
                         "investimentos (resumo), extratos"}
    if finance_completo._catalogo:  # noqa: SLF001 - o resto do financeiro, por área, quando o motor está no ar
        out.update({k: f"financeiro a fundo: {v[0]}" for k, v in finance_completo.ASSUNTOS.items()})
    for s in sistemas.lista():
        if not s.get("ativo", True):
            continue
        base, areas = _sistema_partes(s)
        if base:
            out[s["prefixo"]] = f"o sistema {s['nome']} da pessoa (ações do dia a dia)"
        for area, d in areas.items():
            resumo = (d.description or "").split(". Operações")[0].split(": ", 1)[-1]
            out[f"{s['prefixo']}_{area}"] = f"o sistema {s['nome']} a fundo: {resumo}"
    return out


def _sistema_partes(s: dict) -> tuple[list, dict]:
    """Ações de um sistema MCP: as do dia a dia e as áreas (ações area_* cobrem todas as rotas, uma por área)."""
    from . import sistemas

    decls = sistemas.declaracoes_de(s)
    base = [d for d in decls if "__area_" not in (d.name or "")]
    areas = {(d.name or "").split("__area_", 1)[1]: d for d in decls if "__area_" in (d.name or "")}
    return base, areas


def todas(assuntos: set[str] | None = None) -> list[types.Tool]:
    """As ferramentas da sessão: as essenciais, mais as dos assuntos carregados (ou tudo, sem o modo por assunto)."""
    from . import sistemas

    tudo = not por_assunto()
    carregados = assuntos or set()
    *antes, ultima = TOOLS
    base = [d for d in (ultima.function_declarations or []) if tudo or "financeiro" in carregados or not (d.name or "").startswith("financeiro_")]
    extras = []
    for s in sistemas.lista():
        if not s.get("ativo", True):
            continue
        base_s, areas = _sistema_partes(s)
        if tudo or s["prefixo"] in carregados:
            extras += base_s
        extras += [d for area, d in areas.items() if tudo or f"{s['prefixo']}_{area}" in carregados]
    from . import finance_completo

    extras += [d for a in finance_completo.ASSUNTOS if tudo or a in carregados for d in finance_completo.declaracoes(a)]
    faltam = {k: v for k, v in assuntos_disponiveis().items() if k not in carregados}
    if not tudo and faltam:
        base.append(types.FunctionDeclaration(
            name="carregar_assunto",
            description=(
                "Carrega as ferramentas de um assunto antes de usar (leva um segundo; a conversa continua). Assuntos: "
                + "; ".join(f"{k} = {v}" for k, v in faltam.items())
                + ". Passe em pedido o que ele pediu, para você continuar logo depois."
            ),
            parameters={"type": "OBJECT", "properties": {"assunto": {"type": S, "enum": list(faltam)}, "pedido": {"type": S}},
                        "required": ["assunto", "pedido"]},
        ))
    return [*antes, types.Tool(function_declarations=[*base, *extras])]


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


# Ações que mexem no computador à vista: a esfera vai até a janela onde ele está mexendo (com o HUD
# minimizado, ela sai do canto, voa até lá e volta). ANTES = voa e depois faz; DEPOIS = faz e voa até o que abriu.
_ROTULO = {
    "abrir_app": lambda a: f"Abrindo {a.get('nome', '')}".strip(),
    "abrir_link": lambda a: "Abrindo o site",
    "digitar": lambda a: "Escrevendo",
    "teclas": lambda a: f"Teclando {a.get('atalho', '')}".strip(),
    "arquivos": lambda a: {"criar_pasta": "Criando a pasta", "criar_arquivo": "Criando o arquivo", "ler": "Lendo o arquivo",
                           "listar": "Olhando a pasta", "abrir": "Abrindo", "abrir_pasta": "Abrindo a pasta", "buscar": "Procurando",
                           "renomear": "Renomeando", "mover": "Movendo", "copiar": "Copiando", "compactar": "Compactando",
                           "organizar": "Organizando", "lixeira": "Mandando para a Lixeira"}.get(a.get("acao", ""), "Arquivos"),
    "usar_menu": lambda a: f"Menu {a.get('caminho', '')}".strip(),
}
_DEPOIS = {"abrir_app", "abrir_link"}


async def run(name: str, args: dict[str, Any]) -> dict[str, Any]:
    """Executa a ferramenta e devolve o que o modelo deve saber para falar."""
    args = args or {}
    from . import sistemas

    if name == "carregar_assunto":
        from .live import voice

        return voice.carregar(str(args.get("assunto", "")), str(args.get("pedido", "")))
    if name.startswith("fin_"):
        from . import finance_completo
        from .finance import FinErro

        try:
            return await finance_completo.run(name, args)
        except FinErro as exc:
            return {"erro": str(exc)}
    if sistemas.e_do_sistema(name):
        try:
            return await sistemas.executar(name, args)
        except Exception as exc:  # noqa: BLE001
            log.warning("sistema %s: %s", name, exc)
            return {"erro": f"Não consegui falar com o sistema: {str(exc)[:160]}"}
    rotulo = _ROTULO[name](args) if name in _ROTULO else ""
    if rotulo:
        from . import overlay

        if name not in _DEPOIS:
            await asyncio.to_thread(overlay.at_front, rotulo)
            await asyncio.sleep(0.5)  # dá tempo de a esfera chegar antes de agir
        try:
            res = await _run(name, args)
        finally:
            if name in _DEPOIS or (name == "arquivos" and args.get("acao") in ("abrir", "abrir_pasta", "buscar")):
                await asyncio.sleep(1.0)  # a janela nova aparece
                await asyncio.to_thread(overlay.at_front, rotulo)
            overlay.hide_later()
        return res
    return await _run(name, args)


async def _run(name: str, args: dict[str, Any]) -> dict[str, Any]:
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
        if name == "pensar":
            return await _pensar(args)
        if name == "pesquisar_web":
            res = await asyncio.to_thread(_search, args.get("consulta", ""), args.get("tipo", "geral"))
            return {"resultados": res} if res else {"erro": "A busca não trouxe resultados."}
        if name == "lembrar":
            res = await memory.add(args.get("tipo", "nota"), args.get("texto", ""), fonte="pedido", temas=args.get("temas"))
            return {"ok": True, **res}
        if name == "mostrar_memoria":
            foco = (args.get("foco") or "").strip()
            hub.app_cmd("memoria", foco=foco)
            g = memory.graph()
            temas = [n["rotulo"] for n in g["nodes"] if n["grupo"] == "tema"]
            res = {"ok": True, "memorias": sum(n["grupo"] == "memoria" for n in g["nodes"]), "temas": temas[:30]}
            if foco:
                res["sobre_o_foco"] = await memory.search(foco, limit=6)
            return {**res, "instrucao": "O mapa abriu na tela. Diga em uma ou duas frases o que tem lá (ou sobre o foco)."}
        if name == "buscar_memorias":
            return {"memorias": await memory.search(args.get("consulta", ""))}
        if name == "zerar":
            from . import zerar

            o_que = [x for x in (args.get("o_que") or []) if isinstance(x, str)]
            if not args.get("confirmado"):
                desc = zerar.descrever(o_que)
                if not desc:
                    return {"erro": "Pergunte o que ele quer zerar: memória, histórico, financeiro ou tudo."}
                return {"precisa_confirmar": True, "vai_apagar": desc, "backup": "fica 30 dias, dá para desfazer",
                        "instrucao": "Diga exatamente o que vai apagar, que guarda um backup por 30 dias, e pergunte se pode."}
            res = await zerar.zerar(o_que)
            if res.get("ok"):
                res["instrucao"] = ("Confirme numa frase o que foi zerado e que dá para desfazer pedindo 'desfaz o zerar'."
                                    + (" Diga que a configuração inicial vai abrir." if "ajustes" in res["zerado"] else ""))
            return res
        if name == "desfazer_zerar":
            from . import zerar

            if args.get("acao") == "listar":
                return {"backups": zerar.backups()}
            return await zerar.desfazer()
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
                    "criar_arquivo": lambda: system.create_file(cam, args.get("conteudo", ""), ok),
                    "ler": lambda: system.read_file(cam),
                    "listar": lambda: system.list_folder(cam),
                    "abrir": lambda: system.open_item(cam),
                    "renomear": lambda: system.rename_item(cam, args.get("novo_nome", "")),
                    "mover": lambda: system.move_item(cam, args.get("destino", "")),
                    "copiar": lambda: system.move_item(cam, args.get("destino", ""), copiar=True),
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
        if name in ("digitar", "teclas", "navegador"):
            from . import pc

            if name == "digitar":
                return await asyncio.to_thread(pc.type_into, args.get("texto", ""), args.get("app"), bool(args.get("enter")))
            if name == "teclas":
                return await asyncio.to_thread(pc.keys_into, args.get("atalho", ""), args.get("app"), bool(args.get("confirmado")))
            from . import web

            res = await asyncio.to_thread(web.acao, args.get("acao", ""), args.get("valor", ""), args.get("site", ""))
            if args.get("acao") == "ler_pagina" and res.get("ok"):
                res["instrucao"] = "Use o texto para o que ele pediu (ler, resumir, responder). Resumo longo: mostrar_lista ou mostrar_pesquisa."
            return res
        if name == "olhar":
            from . import pc

            return await asyncio.to_thread(pc.look_at, args.get("regiao"), args.get("alvo"))
        if name == "janela_jarvis":
            hub.app_cmd(args.get("acao", "minimizar"))
            return {"ok": True, "instrucao": "Confirme numa frase curta."}
        if name in ("contexto_atual", "substituir_selecao", "clicar"):
            from . import pc

            if name == "contexto_atual":
                p = hub.pointed if hub.pointed and time.time() - hub.pointed.get("em", 0) < 15 else None
                return await asyncio.to_thread(pc.snapshot, p, args.get("com_selecao", True) is not False)
            if name == "substituir_selecao":
                return await asyncio.to_thread(pc.replace_selection, args.get("texto", ""))
            if args.get("app"):
                r = await asyncio.to_thread(pc.activate, args["app"])
                if r.get("erro"):
                    return r
            return await asyncio.to_thread(pc.click_named, args.get("alvo", ""))
        if name == "mostrar_plano":
            passos = [{"texto": str(p), "estado": "pendente"} for p in (args.get("passos") or [])][:12]
            card = await hub.show_card("plano", {"titulo": args.get("titulo", "Plano"), "categoria": "Trabalhando junto", "passos": passos})
            hub.plan_card = card["id"]
            return {"ok": True, "instrucao": "Plano na tela. Diga em uma frase o que vai fazer e comece pelo passo 1, marcando com atualizar_plano."}
        if name == "atualizar_plano":
            card = next((c for c in hub.cards if c["id"] == getattr(hub, "plan_card", None)), None)
            if not card:
                return {"erro": "Nenhum plano na tela."}
            i = int(args.get("passo", 1)) - 1
            passos = [dict(p) for p in card["data"]["passos"]]
            if 0 <= i < len(passos):
                passos[i]["estado"] = args.get("estado", "feito")
                await hub.update_card(card["id"], {**card["data"], "passos": passos})
                from . import overlay

                if args.get("estado") == "fazendo":
                    overlay.label(passos[i]["texto"][:40])
            return {"ok": True}
        if name == "parar":
            from . import overlay

            overlay.stop("voz")
            return {"ok": True, "instrucao": "Parou. Diga 'parei' e pergunte se continua ou muda algo."}
        if name == "onde_parei":
            from . import activity

            res = await asyncio.to_thread(activity.recent, float(args.get("horas") or 8))
            if res["trechos"]:
                await hub.show_card("lista", {"titulo": "Onde você parou", "categoria": "Memória de trabalho", "itens": [
                    {"titulo": f"{t['app']} · {t['janela'][:70]}", "detalhe": t.get("url") or "", "etiqueta": f"{t['inicio']} · {t['minutos']} min"}
                    for t in res["trechos"][-6:][::-1]
                ]})
            return {**res, "instrucao": "Cartão na tela. Diga em 1 ou 2 frases onde ele parou; ofereça reabrir (abrir_app / navegador)."}
        if name == "modo_foco":
            minutos = float(args.get("minutos") or 0)
            hub.focus_until = time.time() + minutos * 60 if minutos > 0 else time.time() - 1
            await hub.broadcast({"type": "foco", "ate": hub.focus_until if minutos > 0 else 0})
            return {"ok": True, "instrucao": "Confirme numa frase. Avisos não urgentes ficam para o fim do foco."}
        if name == "usar_menu":
            from . import pc

            return await asyncio.to_thread(pc.usar_menu, args.get("caminho", ""), args.get("app"))
        if name == "controlar_janela":
            from . import pc

            if not pc.permitido():
                return {"erro": "Falta a permissão de Acessibilidade para o Jarvis (Ajustes do Sistema → Privacidade e Segurança → Acessibilidade)."}
            res = await asyncio.to_thread(pc.janela_app, args.get("app") or "", args.get("acao", ""), bool(args.get("confirmado")))
            return {**res, "instrucao": "Confirme numa frase curta."} if res.get("ok") else res
        if name == "espelhar_tela":
            from .screen import espelho

            acao = args.get("acao")
            if acao == "ligar":
                await asyncio.to_thread(espelho.start)
                return {"ok": True, "instrucao": "Diga numa frase que agora está vendo a tela dele. As imagens chegam sozinhas."}
            if acao == "desligar":
                await asyncio.to_thread(espelho.stop)
                return {"ok": True}
            from .screen import foto

            todas = args.get("telas") == "todas"
            img = (None if todas else espelho.latest()) or await asyncio.to_thread(foto, todas)
            if not img:
                return {"erro": "Não consegui ver a tela. No Mac, libere Gravação de Tela para o Jarvis."}
            return {"ok": True, "_imagem": img, "instrucao": "Você recebeu a tela de agora. Responda sobre o que ele perguntou."}
        if name == "camera":
            from .hands import hands

            acao = args.get("acao")
            if acao == "ligar":
                store.put("camera", {**store.get("camera"), "ligada": True})
                await asyncio.to_thread(hands.start)
                return {"ok": True, "instrucao": "Confirme numa frase. As mãos já funcionam como ponteiro."}
            if acao == "desligar":
                store.put("camera", {**store.get("camera"), "ligada": False})
                await asyncio.to_thread(hands.stop)
                return {"ok": True}
            img = hands.latest_jpeg()
            if not img:
                return {"erro": "A câmera está desligada. Peça para ligar a câmera."}
            return {"ok": True, "_imagem": img, "instrucao": "Você recebeu a imagem da câmera. Descreva o que vê em uma ou duas frases."}
        if name == "abrir_painel":
            visao = args.get("visao")
            await hub.broadcast({"type": "painel", "visao": None if visao == "fechar" else visao})
            return {"ok": True, "instrucao": "Painel na tela. Confirme numa frase curta, sem ler o conteúdo."}
        if name.startswith("financeiro_"):
            from . import finance_voz as fv
            from .finance import FinErro

            try:
                if name == "financeiro_abrir":
                    return fv.abrir(args.get("pagina"))
                if name == "financeiro_desfazer":
                    return await fv.desfazer()
                fn = {"financeiro_lancar": fv.lancar, "financeiro_fixa": fv.fixa, "financeiro_lancamentos": fv.lancamentos,
                      "financeiro_editar": fv.editar, "financeiro_orcamento": fv.orcamento, "financeiro_regra": fv.regra,
                      "financeiro_fatura": fv.fatura, "financeiro_investir": fv.investir, "financeiro_avancado": fv.avancado, "financeiro_consultar": fv.consultar, "financeiro_transferir": fv.transferir,
                      "financeiro_pagar": fv.pagar, "financeiro_meta": fv.meta, "financeiro_importar": fv.importar,
                      "financeiro_cadastrar": fv.cadastrar}[name]
                return await fn(args)
            except FinErro as exc:
                return {"erro": str(exc)}
        if name == "executar_protocolo":
            from . import protocols

            return await protocols.run(args.get("nome", ""))
        if name == "rotinas":
            from . import protocols

            acao = args.get("acao")
            if acao == "listar":
                return {"rotinas": protocols.describe()}
            if acao == "apagar":
                return protocols.remove(args.get("nome", ""))
            return protocols.save(args.get("nome", ""), args.get("passos") or [], args.get("frases"), args.get("fala", ""),
                                  args.get("hora"), args.get("dias"))
        if name == "delegar_tarefa":
            from . import agents

            agente = args.get("agente", "chatgpt")
            if agente in ("claude", "codex") and not args.get("confirmado"):
                return {
                    "precisa_confirmar": True,
                    "instrucao": "Leia o pedido para ele em uma frase e pergunte se pode mandar. Só chame de novo com confirmado=true depois do sim.",
                }
            res = await agents.iniciar(agente, args.get("tarefa", ""), args.get("titulo"))
            if "erro" not in res:
                res["instrucao"] = "Diga numa frase que passou a tarefa adiante e que avisa quando terminar. Não espere o resultado."
            return res
        if name == "consultar_tarefas":
            if not hub.tasks:
                return {"tarefas": [], "instrucao": "Nenhuma tarefa ainda."}
            await hub.show_card("lista", {"titulo": "Tarefas em andamento", "categoria": "Operações · Outras IAs", "itens": [
                {"titulo": t["titulo"], "detalhe": t.get("resumo") or t.get("pasta", ""), "etiqueta": t["estado"]} for t in hub.tasks[:6]
            ]})
            return {"tarefas": [{k: t.get(k) for k in ("titulo", "agente", "estado", "resumo")} for t in hub.tasks[:6]]}
    except Exception as exc:  # noqa: BLE001 - erro vira resposta falável
        log.exception("ferramenta %s falhou", name)
        return {"erro": f"A ferramenta {name} falhou: {exc}"}
    return {"erro": f"Ferramenta desconhecida: {name}"}
