# Estudo: o Jarvis mexendo em tudo no financeiro e no WorkFlow

28/10/2026. O objetivo é que qualquer coisa possível pela tela também seja possível pela voz, com segurança.

## Onde estamos

| Sistema | O que ele sabe fazer | O que a voz alcança hoje |
|---|---|---|
| Financeiro (motor da Carteira) | 137 operações | ~35 (lançar, fixas, consultar, transferir, pagar, metas, importar, cadastrar, desfazer) |
| WorkFlow Cunae | 231 rotas | 39 ações pelo MCP (resumo do dia, tarefas, projetos, agenda, clientes, Inbox de pedidos, aprovações, financeiro, relatório, cronômetro, apagar) |

## O problema de "uma ferramenta por coisa"

Fazer 137 + 231 ferramentas de voz não funciona. A Gemini Live já tem 86 ferramentas por sessão, e cada ferramenta a mais deixa o modelo rápido mais confuso: escolhe errado ou não escolhe nenhuma. Foi o caso da despesa fixa que virou saída comum. Por isso a proposta é usar **duas camadas**.

1. **Ações de voz (curadas):** as 20 a 30 coisas mais faladas de cada sistema, com nomes simples e campos em português. Rápidas e certeiras.
2. **Modo avançado (cobre 100%):** em cada sistema, duas ferramentas.
   - `catalogo(assunto)` devolve as operações daquele assunto, com os campos que cada uma pede, gerado sozinho a partir do código (Zod no WorkFlow, `router.js` no financeiro).
   - `executar(operação, campos)` roda qualquer uma delas, com as mesmas permissões e regras da tela.
   - A voz usa o modo avançado quando não existe uma ação pronta. Toda escrita pelo modo avançado pede confirmação, porque é ali que o modelo mais pode errar um campo.

Além disso, **ferramentas por assunto**: a sessão começa com as ações essenciais. As do financeiro e as do WorkFlow entram quando a conversa chega no assunto, recarregando a sessão sem perder a conversa (a retomada da Gemini Live já existe). Isso devolve precisão à voz.

## Financeiro: o que falta, por prioridade

**Alta (uso diário)**
| Área | Exemplos de frase | Operações |
|---|---|---|
| Editar e apagar lançamentos | "muda o mercado de ontem para 92", "apaga o iFood de hoje", "aquele Uber era trabalho" | expenses/incomes update e delete, bulkUpdate |
| Ver lançamentos | "o que eu gastei ontem?", "meus gastos com Uber este mês" | expenses/incomes list, reports ledger |
| Orçamento | "coloca 800 de orçamento para mercado", "sugere um orçamento pelo meu histórico" | budgets get/save, insights suggestBudgets |
| Despesa fixa: pausar e editar | "pausa a academia", "o aluguel agora é 1.900" | fixedExpenses toggle/update, recurringIncomes toggle/update |
| Faturas | "detalha a fatura do Nubank", "quanto já usei do limite" | invoices details, cards usedLimit |
| Categorias e regras | "Uber é sempre transporte", "cria a categoria Pet" | rules save/list, categories create |

**Média**
| Área | Exemplos | Operações |
|---|---|---|
| Investimentos | "aportei 500 no Tesouro", "como está minha carteira?", "vendi 10 ações da Petrobras" | investments, contributions, investmentOperations, portfolio, marketData |
| Metas completas | "na meta casamento, adiciona buffet de 800", "marca a aliança como paga" | goals items, itemPay, update |
| Relatórios | "compara outubro com o do ano passado", "quanto gastei por categoria no ano" | reports full/categories/comparison, sameMonthLastYear |
| Contas e cartões | "atualiza o limite do Nubank", "desativa a conta antiga", "recarrega o vale 600" | accounts/cards update/toggle, topUp |
| Calendário | "como fica meu saldo até o fim do mês?" | insights calendar (saldo projetado) |
| Comprovantes | "anexa essa foto ao lançamento" | attachments, statement readFile (OCR) |

**Baixa (administração)**: backup (criar e restaurar), exportar/importar dados, desfazer importação, perfil e preferências, apagar tudo. Estas ficam pela tela ou pelo modo avançado, sempre com confirmação.

## WorkFlow: o que falta, por prioridade

**Alta**
| Área | Exemplos | Rotas |
|---|---|---|
| Conversa com o cliente (Inbox de mensagens) | "o que a Nova Foods falou hoje?", "responde a Marca dizendo que entrega sexta" | inbox threads, messages, post, read |
| Notificações | "o que tem de novo?", "marca tudo como lido" | notifications |
| Entregas e aprovação | "manda o KV para aprovação da Nova Foods", "move o projeto para Aguardando aprovação" | approvals request, client-board move/pause, deliveries decide |
| Links de apresentação | "cria um link de apresentação do moodboard com senha" | share-links |
| Tarefas a fundo | "adiciona 3 posts de feed na tarefa", "essa depende da outra", "anexa esse link" | tasks items/links/dependencies |
| Horas | "quanto tempo gastei no projeto X esta semana?" | time list, reports |

**Média**
| Área | Exemplos | Rotas |
|---|---|---|
| Contatos e marca do cliente | "qual o WhatsApp da Marina da Nova Foods?", "adiciona contato" | clients contacts, brand-assets |
| Convites | "convida a Julia como designer", "dá acesso à cliente no portal" | invitations, clients users/invitations |
| Modelos | "cria um projeto de lançamento a partir do modelo" | templates |
| Contratos, faturas, despesas | "gera a fatura do contrato da Nova Foods", "lança despesa de 300 com freelancer" | finance contracts/invoices generate/expenses |
| Precificação | "quanto cobrar por um reels?" | pricing |
| Criativo | "cria uma nota com o briefing", "adiciona cena no storyboard" | notes, storyboards scenes, boards ops |

**Baixa**: arquivos (enviar exige o arquivo em mãos; dá para enviar o que está no Mac ou na tela), pastas, tags, serviços/catálogo, etapas do fluxo, configurações da organização.

## Ligando os dois sistemas (só o Jarvis consegue)

- **Fatura paga no WorkFlow vira entrada no financeiro pessoal**: "recebi da Nova Foods" registra o pagamento lá e a entrada aqui.
- **Despesa da agência ou pessoal**: "paguei 300 de freelancer" pergunta se é da agência (WorkFlow) ou pessoal (financeiro).
- **Bom dia completo**: prazos do WorkFlow e contas do financeiro no mesmo resumo.
- **Fechamento do mês**: o que entrou na agência e no pessoal, lado a lado.

## Segurança

- **Leitura:** sempre livre.
- **Criar e editar com ação pronta:** direto, com cartão e Desfazer.
- **Apagar, pagar, convidar, enviar mensagem ao cliente, qualquer escrita pelo modo avançado:** pede o "sim".
- No WorkFlow continuam valendo o token, as permissões do papel e o histórico "via Jarvis". No financeiro, os backups automáticos.
- Mensagem para cliente: o Jarvis lê o texto em voz alta antes de enviar.

## Plano em fases

| Fase | Entrega | Tamanho |
|---|---|---|
| 1 | Ferramentas por assunto (precisão) + modo avançado nos dois sistemas (catálogo + executar), cobrindo 100% | médio |
| 2 | Financeiro, prioridade alta: editar/apagar/ver lançamentos, orçamento, fixas, faturas, regras | médio |
| 3 | WorkFlow, prioridade alta: Inbox de mensagens, notificações, entregas/aprovação, links, tarefas a fundo, horas | médio |
| 4 | Ligações entre os dois (fatura → entrada, despesa agência/pessoal, bom dia e fechamento juntos) | pequeno |
| 5 | Prioridade média dos dois | grande |

As fases 1 a 3 já dão a sensação de "ele mexe em tudo"; o modo avançado cobre o resto desde a fase 1.
