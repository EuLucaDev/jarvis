"""Verificação do mentor de investimentos nos três caminhos (voz/Telegram no computador, bolso, conta só Telegram).

Roda numa pasta descartável, com o motor financeiro de verdade (Node) e sem rede: nenhuma mensagem sai (o envio do
Telegram é trocado por uma lista), nenhuma carteira real é lida. `cd backend && uv run python testes/mentor.py`.
As contas da carteira (aporte ≠ lucro, caixa, proventos, venda, eventos, duplicidade) estão em
financeiro/motor/testes/verificar.js; aqui ficam os riscos dos canais.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path

BASE = Path(tempfile.mkdtemp(prefix="jarvis-mentor-"))
os.environ.update({"JARVIS_HOME": str(BASE / "home"), "JARVIS_TESTE": "1", "PORTARIA_DADOS": str(BASE / "portaria")})
(BASE / "portaria").mkdir(parents=True)
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

try:  # cifrado como na portaria, quando a biblioteca está (no grupo "nuvem"); sem ela, os arquivos ficam só compactados
    from cryptography.fernet import Fernet

    os.environ["PORTARIA_BACKUP_CHAVE"] = Fernet.generate_key().decode()
except ImportError:
    os.environ.pop("PORTARIA_BACKUP_CHAVE", None)

from jarvis import bolso, carteira, copia, finance, mentor, telegram, textos, tools  # noqa: E402
from jarvis.hub import coletor  # noqa: E402

ok, falhas = 0, []


def check(rotulo: str, obtido, esperado) -> None:
    global ok
    if obtido == esperado:
        ok += 1
    else:
        falhas.append(f"{rotulo}\n     esperado: {esperado!r}\n     obtido:   {obtido!r}")


def perto(rotulo: str, obtido, esperado, tol: float = 0.01) -> None:
    global ok
    if obtido is not None and abs(float(obtido) - float(esperado)) <= tol:
        ok += 1
    else:
        falhas.append(f"{rotulo}\n     esperado: ~{esperado}\n     obtido:   {obtido!r}")


def verdade(rotulo: str, v) -> None:
    check(rotulo, bool(v), True)


enviados: list = []


async def _enviar_falso(*a, **k):  # nada sai para o Telegram durante o teste
    enviados.append((a, k))


telegram.enviar = _enviar_falso
copia.pedir_copia = lambda: None


async def run(nome: str, args: dict) -> dict:
    cartoes: list = []
    token = coletor.set(cartoes)
    try:
        return await tools.run(nome, args)
    finally:
        coletor.reset(token)


async def operacoes() -> int:
    return len(await finance.chamar("investmentOperations:list", {}) or [])


async def computador() -> None:
    c = finance.chamar
    conta = await c("accounts:create", {"name": "Conta corrente", "bankName": "Banco", "accountType": "CONTA_DIGITAL", "initialBalance": 5000})
    await c("investments:create", {"type": "ETF", "symbol": "BOVA11", "name": "BOVA11", "institution": "Corretora A", "initialQuantity": 10,
                                   "initialPrice": 100, "purchaseDate": "2026-01-05", "bankAccountId": conta["id"], "autoQuote": False})

    # 12. "Onde investir R$ 300?" não grava; "comprei…" só com os campos claros
    n = await operacoes()
    plano = await run("investimentos_planejar", {"valor": 300, "metas_json": json.dumps({"renda_fixa": 50, "acoes_br": 50})})
    verdade("12: plano é simulação", plano.get("simulacao") and plano.get("nada_foi_gravado"))
    perto("12: plano divide o valor todo", sum(plano["divisao_por_grupo"].values()), 300)
    check("12: plano não grava operação", await operacoes(), n)
    sem_preco = await run("investimentos_registrar", {"operacao": "compra", "ativo": "BOVA11", "quantidade": 2})
    check("12: compra sem preço pede o preço", sem_preco.get("faltam"), ["preço unitário"])
    check("12: e não grava", await operacoes(), n)
    feita = await run("investimentos_registrar", {"operacao": "compra", "ativo": "BOVA11", "quantidade": 2, "preco": 100, "data": "2026-06-01",
                                                  "conta": "Conta corrente"})
    verdade("12: compra com tudo é registrada", feita.get("ok") and not feita.get("repetido"))
    check("12: uma operação a mais", await operacoes(), n + 1)
    de_novo = await run("investimentos_registrar", {"operacao": "compra", "ativo": "BOVA11", "quantidade": 2, "preco": 100, "data": "2026-06-01",
                                                    "conta": "Conta corrente"})
    verdade("8: repetida em seguida (timeout/voz) não duplica", de_novo.get("repetido"))
    check("8: continua uma a mais", await operacoes(), n + 1)
    novo = await run("investimentos_registrar", {"operacao": "compra", "ativo": "XPML11", "quantidade": 3, "preco": 110})
    verdade("ativo novo sem classe/corretora pergunta antes", "faltam" in novo and novo.get("nada_foi_gravado"))
    cdb = await run("investimentos_registrar", {"operacao": "aporte", "ativo": "CDB Banco X", "valor": 1000, "classe": "CDB", "instituicao": "Banco X",
                                                "data": "2026-03-01"})
    verdade("aporte por valor em renda fixa", cdb.get("ok"))
    await run("investimentos_registrar", {"operacao": "valor_atual", "ativo": "CDB Banco X", "valor": 1040, "data": "2026-10-31"})

    # 1 (no núcleo). Patrimônio e resultado vêm do motor e batem com a decomposição
    cart = await run("investimentos_carteira", {"visao": "resumo"})
    check("1: patrimônio = posições + caixa", cart["patrimonio"], 2240.0)
    check("1: do seu bolso = 1.000 + 200 + 1.000", cart["do_seu_bolso"]["liquido"], 2200.0)
    check("1: resultado só o que o CDB rendeu", cart["resultado"]["total"], 40.0)
    verdade("CDI: sem rede no teste, a comparação diz por que não veio", cart["rentabilidade"]["benchmark"].get("motivo"))
    verdade("6: lacunas dizem que o preço é o da última operação", any(l["codigo"] == "preco_operacao" for l in cart["lacunas"]))

    # 9. Mesma carteira na voz, no Telegram do computador e no bolso
    voz = await run("investimentos_carteira", {"visao": "completo"})
    from jarvis import agente

    resp = agente.Resposta()
    tg = await agente._ferramenta("investimentos_carteira", {"visao": "completo"}, {"investimentos"}, resp, "teste")  # noqa: SLF001
    copia_pc = await copia.montar()
    rel_copia = copia_pc["financeiro"]["investimentos"]["relatorio"]
    for k in ("patrimonio", "do_seu_bolso", "resultado", "proventos", "alocacao"):
        check(f"9: voz = Telegram ({k})", tg[k], voz[k])
        check(f"9: voz = cópia do bolso ({k})", rel_copia[k], voz[k])
    texto = textos.carteira(rel_copia)
    verdade("Telegram: carteira cabe numa mensagem", len(texto) < 4096)
    verdade("Telegram: grandezas separadas", "Do seu bolso" in texto and "Resultado dos investimentos" in texto and "Proventos" in texto)

    # 10. Computador desligado: cópia datada, pendência fora dos números, reconexão aplica uma vez
    pid = "pessoa_a"
    bolso.guardar_copia(pid, {**copia_pc, "gerado": copia_pc.get("gerado") or 0, "nome": "Teste", "chamar": "Teste"}, "chave-falsa")
    cb = bolso.copia(pid)
    r = bolso.Resposta()
    reg = await bolso._ferramenta(pid, 1, "registrar_investimento", {"operacao": "compra", "ativo": "BOVA11", "quantidade": 1, "preco": 105}, cb, r)  # noqa: SLF001
    verdade("10: registro no bolso vira pendência", reg.get("ok") and "pendência" in reg.get("registrado_em", ""))
    check("10: a data fica fixa na hora", bolso.pendencias(pid)[0]["args"]["data"], bolso._hoje(cb).isoformat())  # noqa: SLF001
    r = bolso.Resposta()
    vista = await bolso._ferramenta(pid, 1, "carteira_investimentos", {}, cb, r)  # noqa: SLF001
    verdade("10: a carteira diz de quando é a cópia", vista.get("copia_de"))
    check("10: os números ainda são os da cópia", vista["patrimonio"], voz["patrimonio"])
    verdade("10: a pendência aparece como pendente", vista.get("pendentes_de_sincronizacao"))
    verdade("10: a mensagem avisa a pendência", "Pendentes de sincronização" in r.mensagens[0]["texto"])
    n = await operacoes()
    itens = bolso.pendencias(pid)
    await copia.aplicar(itens)
    check("10: reconexão aplica a pendência", await operacoes(), n + 1)
    await copia.aplicar(itens)
    check("10: reconexão repetida não reaplica", await operacoes(), n + 1)
    from jarvis import store

    store.put("bolso_aplicadas", {})  # como se tivesse caído antes de anotar o que já aplicou
    await copia.aplicar(itens)
    check("10: nem se a anotação se perder (chave no motor)", await operacoes(), n + 1)

    # 11. Uma conta não vê a carteira nem as pendências da outra
    check("11: outra conta não tem cópia", bolso.copia("pessoa_b"), None)
    check("11: outra conta não vê pendências", bolso.pendencias("pessoa_b"), [])
    r = bolso.Resposta()
    alheia = await bolso._ferramenta("pessoa_b", 2, "carteira_investimentos", {}, {"financeiro": None}, r)  # noqa: SLF001
    verdade("11: sem cópia própria, sem números", "erro" in alheia)

    # A ferramenta antiga de aporte não cria "aporte avulso" fora da posição
    n = await operacoes()
    cotas = await run("financeiro_investir", {"acao": "aportar", "investimento": "BOVA11", "valor": 300, "conta": "Conta corrente"})
    verdade("aporte por valor em ativo de cotas é recusado (pede quantidade e preço)", cotas.get("nada_foi_gravado"))
    rf = await run("financeiro_investir", {"acao": "aportar", "investimento": "CDB Banco X", "valor": 200, "conta": "Conta corrente"})
    verdade("aporte em renda fixa com operações vira operação", rf.get("ok"))
    check("e entra na posição (uma operação a mais)", await operacoes(), n + 1)
    cart = await run("investimentos_carteira", {"visao": "lacunas"})
    verdade("sem lacuna de aporte avulso", not any(l["codigo"] == "aportes_avulsos" for l in cart["lacunas"]))


async def so_telegram() -> None:
    pid = "clara_teste"
    carteira.ativar(pid, "Clara Teste")
    carteira.cadastrar(pid, "conta", "Nubank", 3000)
    c = bolso.copia(pid)
    r = bolso.Resposta()

    async def reg(**a):
        return await bolso._ferramenta(pid, 3, "registrar_investimento", a, bolso.copia(pid), bolso.Resposta())  # noqa: SLF001

    verdade("só Telegram: registra na hora", (await reg(operacao="aporte", ativo="Tesouro Selic", valor=1000, classe="TESOURO_DIRETO",
                                                       instituicao="Nubank", data="2026-05-02", conta="Nubank")).get("ok"))
    await reg(operacao="valor_atual", ativo="Tesouro Selic", valor=1050, data="2026-10-30")
    rel = carteira.relatorio_investimentos(carteira.ler(pid))
    check("só Telegram: patrimônio pelo valor informado", rel["patrimonio"], 1050.0)
    check("só Telegram: do seu bolso", rel["do_seu_bolso"]["liquido"], 1000.0)
    check("só Telegram: resultado", rel["resultado"]["total"], 50.0)
    await reg(operacao="aporte", ativo="Tesouro Selic", valor=500, data="2026-11-01", conta="Nubank")
    rel = carteira.relatorio_investimentos(carteira.ler(pid))
    check("só Telegram 1: aporte aumenta o patrimônio", rel["patrimonio"], 1550.0)
    check("só Telegram 1: aporte não vira resultado", rel["resultado"]["total"], 50.0)
    check("só Telegram: saldo da conta desconta os aportes", carteira.saldos(carteira.ler(pid))["Nubank"], 1500.0)
    await reg(operacao="provento", ativo="Tesouro Selic", valor=20, data="2026-11-01", origem="caixa")
    rel = carteira.relatorio_investimentos(carteira.ler(pid))
    check("só Telegram 3: provento que fica soma no patrimônio", rel["patrimonio"], 1570.0)
    check("só Telegram 3: e não é aporte", rel["do_seu_bolso"]["liquido"], 1500.0)
    check("só Telegram: nada de pendência (grava na hora)", bolso.pendencias(pid), [])
    antes = len(carteira.ler(pid)["aportes"])
    await reg(operacao="compra", ativo="CDB Inter", valor=300, data="2026-11-02")
    await reg(operacao="compra", ativo="CDB Inter", valor=300, data="2026-11-02")
    check("só Telegram: o modelo repetir a chamada não grava duas vezes", len(carteira.ler(pid)["aportes"]), antes + 1)
    check("só Telegram: compra por valor sem conta sai da conta principal", carteira.saldos(carteira.ler(pid))["Nubank"], 1200.0)
    vista = await bolso._ferramenta(pid, 3, "carteira_investimentos", {}, bolso.copia(pid), r)  # noqa: SLF001
    check("só Telegram: a carteira vem da conta, sem 'cópia de'", vista.get("copia_de"), None)
    verdade("só Telegram: diz que não tem cotação", any(l["codigo"] == "sem_cotacao" for l in vista["lacunas"]))
    verdade("11: a conta só Telegram não aparece para outra", carteira.relatorio_investimentos(carteira.ler("pessoa_c"))["patrimonio"] == 0)
    del c


def calculos() -> None:
    perto("taxa mensal de 12% ao ano é 0,9489%", mentor.taxa_mensal(12), 0.9489, 0.0001)
    pd = mentor.potencial_desconto(100, 80)
    perto("13: potencial até o valor é 25%", pd["potencial_pct"], 25)
    perto("13: desconto sobre o valor é 20%", pd["desconto_pct"], 20)
    yf = mentor.calcular("yield_futuro", {"lpa": 2, "crescimento": 5, "anos": 5, "payout": 50, "yield_alvo": 8, "preco": 10})
    verdade("13: yield futuro rotulado como não sendo valor justo", "NÃO é valor justo" in yf["rotulo"])
    verdade("13: com preço, potencial e desconto separados", set(yf["comparacao_com_preco"]) == {"potencial_pct", "desconto_pct"})
    check("modelo de dividendos exige ke > g", "erro" in mentor.calcular("dividendos", {"dividendos": [1], "ke": 5, "g": 6}), True)
    perto("valor futuro sem juros = soma dos aportes", mentor.valor_futuro(100, 50, 0, 10), 600)
    perto("xirr do mentor = 10% (igual ao motor)", mentor.xirr([("2025-01-01", -1000), ("2026-01-01", 1100)]), 0.1, 1e-6)
    serie = {"2026-01-02": 0.05, "2026-01-05": 0.05, "2026-01-06": 0.05}
    perto("CDI: aporte rende a partir do dia útil seguinte", mentor.valor_no_cdi([("2026-01-02", 1000)], serie, "2026-01-06"), 1000 * 1.0005 ** 2, 1e-6)
    perto("CDI: retirada deixa de render", mentor.valor_no_cdi([("2026-01-01", 1000), ("2026-01-05", -500)], serie, "2026-01-06"),
          1000 * 1.0005 ** 3 - 500 * 1.0005, 1e-6)
    check("CDI: série que não cobre o período não compara", mentor.valor_no_cdi([("2025-06-01", 1000)], serie, "2026-01-06"), None)
    check("registro: CDB comprado por valor basta", mentor.faltam_registro({"operacao": "compra", "ativo": "CDB", "valor": 500}, cotado=False), [])
    check("registro: ação por valor pede cotas", mentor.faltam_registro({"operacao": "compra", "ativo": "PETR4", "valor": 500, "classe": "ACAO"}),
          ["quantidade", "preço unitário"])
    plano = mentor.plano_aporte(300, {"renda_fixa": 700, "acoes_br": 300}, {"renda_fixa": 50, "acoes_br": 50},
                                [{"ativo": "BOVA11", "grupo": "acoes_br", "preco": 120, "lote": 1}])
    check("plano: vai para o grupo abaixo da meta", list(plano["divisao_por_grupo"]), ["acoes_br"])
    check("plano: lotes inteiros, sobra declarada", (plano["compras"][0]["quantidade"], plano["sobra"]), (2.0, 60.0))


def ia_reserva() -> None:
    from jarvis import ia_texto

    check("reserva: chave da Groq reconhecida", ia_texto.provedor("gsk_abc"), "groq")
    check("reserva: chave da Gemini não é da reserva", ia_texto.provedor("AIzaXYZ"), None)
    conv = ia_texto.ferramentas([{"name": "lancar", "description": "x", "parameters": {"type": "OBJECT", "properties": {"v": {"type": "NUMBER"}},
                                                                                     "required": ["v"]}}])
    check("reserva: tipos no formato OpenAI", conv[0]["function"]["parameters"], {"type": "object", "properties": {"v": {"type": "number"}}, "required": ["v"]})
    check("reserva: só as ferramentas essenciais", [d["name"] for d in ia_texto.essenciais([{"name": "lancar"}, {"name": "abrir_app"}])], ["lancar"])


def prompts() -> None:
    from jarvis import agente, live

    voz, tg = live.system_prompt(), agente._prompt("Telegram")  # noqa: SLF001
    b = bolso._prompt({"nome": "A", "chamar": "A", "financeiro": {}, "gerado": 0})  # noqa: SLF001
    for nome, p in (("voz", voz), ("Telegram", tg), ("bolso", b)):
        verdade(f"14/3: regras do mentor no prompt ({nome})", mentor.ESSENCIAL in p)
        verdade(f"14: pergunta de conceito sem onboarding ({nome})", "sem pedir perfil" in p)
    verdade("bolso: diz que não tem cotação nem pesquisa", "não há cotação nem pesquisa" in b)
    verdade("voz: regra de confirmar só o ponto duvidoso", "confirme só o ponto duvidoso" in voz)
    verdade("nenhum canal vira outro personagem", all("Mentor da Riqueza" not in p for p in (voz, tg, b)))


async def main() -> None:
    try:
        calculos()
        ia_reserva()
        prompts()
        await computador()
        await so_telegram()
    finally:
        finance.motor.stop() if hasattr(finance.motor, "stop") else None
    check("nenhuma mensagem real saiu (só a lista do teste)", all(isinstance(x, tuple) for x in enviados), True)


if __name__ == "__main__":
    asyncio.run(main())
    print(f"\n  {ok} verificações ok · {len(falhas)} falha(s)\n")
    for f in falhas:
        print(f"  ✗ {f}\n")
    import shutil

    shutil.rmtree(BASE, ignore_errors=True)
    sys.exit(1 if falhas else 0)
