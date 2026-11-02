# Mentor de investimentos no Jarvis — o que foi implementado

Implementado em 02/11/2026 a partir de `PROMPT-CLAUDE-JARVIS.md` (pedido) e `PROMPT-CHATGPT.md` (metodologia). Lançado no Jarvis 2.13.0.

## Como usar

O Jarvis continua sendo o J.A.R.V.I.S.; a mentoria é uma capacidade dele. Funciona por voz, pelo Telegram com o computador ligado, pelo Telegram com o computador desligado (Jarvis de bolso) e na conta só Telegram.

| Pedido | O que acontece |
|---|---|
| "Quero aprender a investir do zero", "o que é CDI?" | Responde direto, sem pedir perfil nem consultar a carteira. Para ensinar a fundo, carrega a metodologia do tema. |
| "Explique Tesouro IPCA+ e o que acontece se eu vender antes" | Metodologia de renda fixa. Fato atual (taxa, regra) só depois de pesquisar, com fonte e data. |
| "Pesquise esse fundo e diga os riscos" | `pesquisar_web` (com o computador ligado), seguindo a ordem de fontes da metodologia. |
| "Compare estas duas aplicações para daqui a dois anos" | Metodologia + contas em `investimentos_calcular` (taxa equivalente, juro real, valor futuro). |
| "Tenho R$ 300 para aportar; faça um plano" | `investimentos_planejar`: **simulação**, nada é gravado. Usa a carteira e a política aprovada; sem política, pede a divisão ou usa uma hipótese dita por ele. |
| "Comprei duas cotas de BOVA11 a R$ 120 hoje" | `investimentos_registrar`: só grava com ativo, quantidade, preço e data. Ativo novo pede classe e corretora. Repetir o mesmo pedido não duplica. |
| "Quanto veio do meu bolso e quanto foi resultado?" | `investimentos_carteira`: os números vêm do motor, com patrimônio, aportes líquidos, resultado e proventos separados. |
| "Como evoluíram minha carteira e os proventos?" | A mesma ferramenta, visões `evolucao` e `proventos`. |
| "O que precisa de atenção?" | Visão `lacunas`: cotações antigas, preço de compra no lugar de cotação, saldo sem histórico, câmbio, proventos a confirmar, concentração. |
| "Meu CDB está valendo R$ 1.230" | `investimentos_registrar` com `valor_atual`: avalia investimentos sem cotação pública. |
| "Guarde meu perfil" / "aprove essa divisão" | `investimentos_perfil`: só com autorização (perfil) ou aprovação (política). Cada mudança vira uma versão nova, com histórico. |

Na voz, a resposta fica em uma a três frases e os detalhes vão para o cartão. No Telegram, a carteira chega como mensagem no visual de app de banco (`textos.carteira`).

## Onde está cada coisa

- **Regras únicas para os três caminhos:** `backend/jarvis/mentor.py`, versão `VERSAO`.
  - `ESSENCIAL`: fica sempre no prompt da voz (`live.py`), do Telegram (`agente.py`) e do bolso (`bolso.py`).
  - `metodologia(tema)`: 15 temas carregados só quando o pedido precisa.
  - `calcular`: cálculos determinísticos.
  - `faltam_registro`: a mesma regra de campos obrigatórios em todos os canais.
  - `visao`: o recorte e o `aviso_obrigatorio`.
  - `plano_da_carteira`: o plano de aporte.
- **Contas da carteira (fonte única):** `financeiro/motor/db/services/portfolio.js`, operação `portfolio:report`.
  - Perímetro = posições + caixa da carteira.
  - Resultado = patrimônio − entradas externas + saídas externas = não realizado + realizado + proventos. O relatório confere essa identidade (`result.check`).
  - Rentabilidade: XIRR pelos fluxos datados. A comparação entre fotos do patrimônio aparece rotulada como **aproximação** do TWR, nunca como TWR.
  - Sem base confiável, não calcula taxa e explica o motivo.
- **Motor (`investments.js`):**
  - Preço unitário e câmbio com 8 e 6 casas (cripto e frações). Arredondamento em centavos só nos totais.
  - Origem do dinheiro de cada operação: `EXTERNO` (de fora) ou `CAIXA` (do caixa da carteira, que não pode ficar negativo). Destino de cada provento.
  - Grupamento e amortização. Incorporação, cisão, subscrição e afins são recusados com explicação.
  - Chave contra repetição, mais bloqueio de operação idêntica em até 2 minutos.
  - Proventos manuais; valor informado para renda fixa.
  - O preço da última operação avalia a posição só quando não há cotação mais nova.
  - O câmbio não vira 1 quando a fonte falha.
- **Migração:** `2026-11-investment-mentor-v5` em `database.js`. Só acrescenta colunas e uma tabela de versões de perfil e política. Os padrões mantêm as contas antigas iguais.
- **Ferramentas no computador:** `backend/jarvis/investimentos.py`, no assunto "investimentos" (`tools.py`). O mesmo `compactar` alimenta voz, Telegram e a cópia do bolso.
- **Atualização diária** (`investimentos.loop`): com o computador ligado, uma vez por dia atualiza cotações e proventos e guarda a foto do patrimônio. É o que forma a evolução e a aproximação do TWR. Não é alerta: o Jarvis não avisa sozinho sobre a carteira.
- **Comparação com o CDI** (`investimentos._benchmark`): mostra quanto o mesmo dinheiro, nas mesmas datas, valeria a 100% do CDI. Usa a série diária do Banco Central (SGS 12), guardada por dia, sem imposto nem custos. Só aparece quando a taxa da carteira também é calculável.
- **Cotação com metadados:** `market.cotacoes` traz preço sem arredondar, moeda, bolsa, horário do dado, horário da coleta, fonte e atraso. Cache de 60 s. Falha vira erro, nunca um número.
- **Bolso** (`bolso.py`, `copia.py`):
  - A cópia leva o relatório da carteira.
  - O bolso mostra a carteira com a data da cópia e lista as operações registradas pelo celular como "pendentes de sincronização", fora dos números.
  - A pendência leva a data fixada e a chave `bolso:<id>`. Ao religar, entra uma vez, mesmo que a anotação de "já aplicado" se perca.
- **Conta só Telegram** (`carteira.py`): investimentos por valor.
  - Registra aplicação, resgate, provento (fica no investimento ou vai para a conta) e valor atual.
  - `relatorio_investimentos` devolve o mesmo formato do computador.
  - A ferramenta antiga `investir` saiu dessa conta, para haver um caminho só.

## Testes

- `cd financeiro/motor && npm test`: 148 verificações (76 antigas + 72 novas). Cobrem os cenários 1–8 do pedido, mais precisão, proventos a receber, política e perfil, fotos, XIRR, saldo sem histórico e valor informado.
- `cd backend && uv run python testes/mentor.py`: 80 verificações, com o motor de verdade numa pasta descartável e sem enviar mensagens. Cobrem:
  - 9: mesmos números na voz, no Telegram e na cópia;
  - 10: pendência, data fixa e reconexão que não reaplica;
  - 11: uma conta não vê a outra;
  - 12: simulação não grava; registro só com os campos;
  - 13: valuation rotulado;
  - 14: regras presentes nos três prompts;
  - além da conta só Telegram e dos cálculos.
- A compilação automática ganhou o passo "Mentor de investimentos" (`.github/workflows/build.yml`).
- **Validação com a Gemini de verdade:** feita com dados de teste numa pasta descartável e sem Telegram real.
  - Caminho do Telegram no computador: o conceito saiu sem ferramentas; o plano não gravou nada; a compra gravou uma operação; a pergunta da carteira usou o motor e deu o aviso.
  - Bolso, nos dois tipos de conta: a carteira saiu da cópia com a data; a compra virou pendência; a aplicação foi registrada na conta só Telegram; a pergunta de aprender saiu sem ferramentas.
- **Não validado:** voz ao vivo (Gemini Live), por pedido de não abrir o app neste Mac, e o Telegram real com mensagens entregues.

## O que ainda não existe

- **Importar nota de corretagem ou extrato da B3:** as operações entram uma a uma (voz ou Telegram) ou pela tela de investimentos.
- **Caixa na corretora sem venda ou provento antes:** dinheiro depositado direto na corretora não tem registro próprio. Uma compra com esse dinheiro entra como dinheiro de fora.
- **Proventos:** "anunciado" e "provisionado" ficam juntos como "previsto". Não há estimativa de proventos futuros (por decisão). Previsto com data passada aparece para confirmar, não vira recebido sozinho.
- **Eventos societários:** incorporação, cisão, conversão e subscrição precisam ser registrados em partes. A bonificação entra sem custo atribuído (não muda o resultado, mas pode importar para o imposto).
- **Benchmark:** só o CDI. Ibovespa e IPCA não são comparados.
- **TWR:** não há TWR exato. Seria preciso avaliar a carteira em cada data de aporte. Hoje há XIRR e a aproximação por fotos, que só existem quando as cotações são atualizadas.
- **Pesquisa e cotação no Jarvis de bolso:** não existem. Ele usa a cópia datada ou deixa o pedido para o computador.
- **Monitoramento automático e alertas de carteira:** não foram criados. O Jarvis não deve dizer que acompanha sozinho.
- **Conta só Telegram:** sem cotação, sem perfil e política guardados (o plano de aporte usa só metas ditas na hora) e sem caixa entre investimentos. Uma compra com o dinheiro de outro investimento mantém o total certo, mas não move o valor entre eles.
- **Tela própria do mentor no HUD:** não há. A carteira aparece no cartão do financeiro, e a tela de investimentos da Carteira continua sendo a de antes.
