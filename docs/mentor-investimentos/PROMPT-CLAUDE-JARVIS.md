# Pedido pronto para o Claude — integrar o mentor no Jarvis

Envie este texto ao Claude com acesso ao repositório e anexe `PROMPT-CHATGPT.md`. O arquivo `ANALISE-E-FONTES.md` serve de justificativa e referência. Este pedido autoriza implementação e validação local; publicação deve ser solicitada separadamente.

---
INÍCIO DO PEDIDO

Quero implementar no Jarvis um mentor de investimentos que ensine do zero, pesquise ativos, ajude a planejar aportes e acompanhe minha carteira e sua evolução. Ele precisa funcionar na voz e no Telegram, com regras financeiras consistentes e apresentação adequada a cada canal.

Use o arquivo anexo `PROMPT-CHATGPT.md` como especificação de comportamento e metodologia. O conteúdo entre INÍCIO e FIM é o núcleo do mentor; adapte sua identidade ao Jarvis e seus mecanismos reais. O arquivo `ANALISE-E-FONTES.md` documenta problemas dos resumos do Gemini e as correções. Não incorpore os resumos como verdade, lista de recomendações ou carteira do usuário.

## 1. Analise a base antes de alterar

Leia as instruções aplicáveis, `CLAUDE.md` e os módulos envolvidos. Preserve identidade, interface, arquitetura, privacidade e comportamento financeiro existentes. Não abra o app no Mac para testar se a instrução local continuar proibindo isso.

Uma inspeção em 02/11/2026 localizou estes pontos, que você deve conferir novamente:

- `backend/jarvis/live.py`: composição do prompt de voz.
- `backend/jarvis/agente.py`: prompt e ferramentas de conversa por texto/Telegram no computador.
- `backend/jarvis/bolso.py`: respostas no Telegram quando o computador está desligado.
- `backend/jarvis/carteira.py`: modalidade de conta somente Telegram.
- `backend/jarvis/textos.py`: estilo das respostas financeiras em texto.
- `backend/jarvis/tools.py`: ferramentas e carregamento por assunto.
- `backend/jarvis/finance.py`, `finance_voz.py` e `finance_completo.py`: integração com o motor e assunto `financeiro_investimentos`.
- `backend/jarvis/market.py`: cotações via Yahoo Finance; na leitura consultada, o retorno não incluía horário da cotação e arredondava preços, portanto não basta como fonte de precisão para todas as classes de ativos.
- `financeiro/motor/db/schema.sql`, `router.js` e `catalogo.js`: dados e operações existentes de investimentos, aportes, compras/vendas, rendimentos e snapshots.
- `backend/jarvis/copia.py`: cópia para o bolso e aplicação de pendências.

Esses pontos são pistas de integração, não prova de funcionalidade completa. Verifique cálculos, formato de dados, isolamento e o caminho real de cada canal.

## 2. Resultado esperado

O usuário deve conseguir dizer, por voz ou Telegram:

- “Quero aprender a investir do zero.”
- “Explique Tesouro IPCA+ e o que acontece se eu vender antes.”
- “Pesquise esse fundo e diga quais riscos eu deveria entender.”
- “Compare estas duas aplicações para uma meta daqui a dois anos.”
- “Tenho R$ 300 para aportar; faça um plano usando minha carteira.”
- “Comprei duas cotas de [ativo] por [preço] em [data]; registre.”
- “Quanto veio do meu bolso e quanto foi resultado dos investimentos?”
- “Como evoluíram minha carteira e os proventos?”
- “Quais concentrações e dados desatualizados precisam de atenção?”

Pesquisas e simulações não criam operações reais. Não implemente negociação, PIX, saques ou credenciais de corretora. O acompanhamento deve usar os dados efetivamente disponíveis e declarar lacunas.

## 3. Núcleo compartilhado e contexto

Mantenha uma única especificação financeira versionada, reutilizada pelos caminhos de voz, texto no computador e bolso. Pode usar instruções compactas permanentes e conteúdo detalhado carregado por assunto para respeitar latência e limites de contexto. A regra financeira não deve divergir entre canais.

Mantenha no contexto permanente as regras essenciais: não inventar dados; pesquisar fatos atuais; adaptar alocação ao perfil; separar simulação de registro; não operar dinheiro; proteger a reserva; não confundir aportes com rentabilidade.

Carregue por tarefa a metodologia necessária e os dados relevantes da conta: perfil, política aprovada, objetivo, posições, caixa, operações, pendências, última sincronização e preços datados. Não carregue histórico inteiro sem necessidade. Não misture fatos financeiros estruturados com memória narrativa.

Não substitua a personalidade do Jarvis pelo nome “Mentor da Riqueza”. Ele continua sendo Jarvis, com capacidade de mentoria. Evite preencher todas as respostas com avisos longos.

## 4. Integrações e pesquisa

Reutilize ferramentas existentes antes de criar outras. Valide seus contratos e retornos. Se faltarem capacidades, implemente o mínimo necessário dentro da arquitetura atual e exponha limitações.

Separe consultas a cotações, documentos e dados estruturados. Retorne, quando a fonte fornecer: ativo/identificador e mercado, moeda, preço com precisão adequada, horário do dado, horário de coleta, origem e atraso conhecido. Para balanços e relatórios, retorne período, publicação e documento. Nunca invente metadados ausentes.

Use fontes públicas confiáveis e timeouts, cache, limites e tratamento explícito de falhas. Busca vazia não vira um número. Armazene proveniência das análises e suas hipóteses; cache não transforma dado antigo em dado atual. Não adicione serviços pagos ou dependências de conta externa sem necessidade autorizada.

Não pressuponha que o bolso possua as mesmas ferramentas do computador. Onde não houver pesquisa atual, responda com o último dado identificado como antigo ou informe indisponibilidade. Um prompt não cria acesso à internet.

## 5. Dados e cálculos

Reaproveite o modelo existente e examine a qualidade dos registros antes de migrar. Não crie outro banco autoritativo para a mesma carteira. Faça migrações incrementais compatíveis e com preservação de dados, apenas se necessárias.

Use funções determinísticas, testáveis e independentes do modelo de linguagem para cálculos e reconciliação. Valores monetários e quantidades precisam de precisão compatível com cada instrumento; não use arredondamento de exibição nos cálculos. Trate múltiplas moedas sem conversão implícita.

Cubra o que já for suportado e identifique o que faltar para:

1. Posições, operações datadas, caixa e custos.
2. Fluxos externos versus transferências e negociações internas.
3. Proventos anunciados, provisionados, recebidos e reinvestidos.
4. Eventos corporativos e custo de aquisição.
5. Histórico de patrimônio com fonte e data das avaliações.
6. Resultado em reais e rentabilidade com método identificado.
7. Alocação e política por objetivo, com reserva segregada.
8. Perfil, restrições, consentimentos e trilha de revisão por usuário.

TWR exige dados adequados aos fluxos e avaliações; XIRR exige fluxos externos datados e valor final coerente. Não apresente cálculo simples como TWR nem fabrique série histórica. Sem base inicial confiável, inicie a série no ponto verificável e explique a cobertura.

Dados faltantes devem permanecer ausentes, não virar zero. Importações precisam de prevenção de duplicidade e conciliação. Preserve precisão de cripto e frações internacionais.

## 6. Voz e Telegram

Na voz, preserve respostas curtas e cartões de apoio. Resuma conclusão, principal risco e próximo passo. Não leia uma análise inteira nem URLs. Para registrar um dado ambíguo reconhecido por áudio, confirme ativo, quantidade ou valor duvidoso antes de gravar. Não peça confirmação de informação clara repetidamente.

No Telegram, preserve o estilo existente e use blocos que caibam no celular. Mostre patrimônio, aportes, resultado e proventos como grandezas distintas. Use o mecanismo existente de relatórios/botões quando apropriado; não invente botões que não respondem. Faça escape correto do HTML/Markdown e respeite os limites do envio.

Resumo por voz e relatório por Telegram só devem ser enviados ao mesmo usuário, por canal vinculado e mediante solicitação ou rotina autorizada. Não diga “enviei”, “salvei” ou “sincronizei” antes do retorno de sucesso.

No bolso com computador desligado, respeite a cópia disponível e a arquitetura de pendências. Indique data da cópia e condição “pendente de sincronização” quando aplicável. Preserve a exceção existente para contas somente Telegram, verificando o caminho autoritativo delas. Não transforme pendência em operação já persistida no motor. Evite reexecução em reconexão.

Mudança de canal não pode trocar o perfil, perder a política ou duplicar operações. O assunto deve ser reconhecido por intenção, sem exigir um comando rígido.

## 7. Relatórios e limites do produto

Entregue primeiro as experiências existentes necessárias ao mentor, sem redesenhar toda a aplicação. Para acompanhar a carteira, apresente:

- patrimônio e caixa, com cobertura e data das cotações;
- aportes/retiradas externos e resultado separados;
- proventos recebidos, a receber e estimados separados;
- alocação atual versus metas aprovadas;
- concentrações e liquidez;
- evolução observada e objetivos;
- benchmark apenas quando houver série comparável;
- lacunas, pendências e erros que afetem o relatório.

Sem histórico suficiente, não preencha gráficos ou rentabilidade com dados demonstrativos disfarçados de reais. Se criar algum componente visual necessário, siga as instruções de design do projeto e mantenha a identidade do Jarvis.

Monitoramento automático e alertas só podem ser anunciados se houver implementação, fonte, periodicidade, limites e ativação pelo usuário. Não assuma funcionamento contínuo com o computador desligado. Use as rotinas existentes quando possível; não programe recomendações diárias por padrão.

## 8. Verificação local obrigatória

Implemente testes de comportamento e cálculos para os riscos efetivamente introduzidos. Inclua, no mínimo:

1. R$ 1.000 iniciais + aporte externo de R$ 500, sem oscilação nem renda: patrimônio R$ 1.500 e resultado R$ 0, não 50% de retorno.
2. Compra com caixa já existente não aumenta aportes externos nem patrimônio por si só.
3. Provento recebido permanece em caixa e depois é reinvestido: não conta duas vezes e não vira aporte externo.
4. Venda retorna caixa; separe custo e ganho, e evite classificar todo o valor da venda como lucro.
5. Transferência interna no consolidado não conta como aporte nem resgate externos.
6. Fonte indisponível ou cotação antiga: não inventa preço nem omite posição do consolidado silenciosamente.
7. Eventos societários suportados preservam quantidade/custo sem ganho artificial; eventos não suportados são sinalizados.
8. Operação importada/repetida, timeout e repetição pelo Telegram não duplicam registro.
9. A mesma consulta em voz e Telegram usa a mesma carteira e produz os mesmos números.
10. Computador desligado: cópia antiga e pendência claramente identificadas; reconexão aplica uma vez; conta somente Telegram segue seu fluxo próprio.
11. Uma conta nunca lê ou altera carteira, fonte de dados privada ou pendência de outra conta.
12. “Onde investir R$ 300?” não grava compra; “comprei...” só registra após campos essenciais claros e retorno de sucesso.
13. Valuation por yield futuro é rotulado como tal; retorno total, desconto e potencial não são confundidos.
14. Pergunta educacional simples funciona sem consultar carteira ou exigir onboarding completo.

Execute as verificações já exigidas pelo projeto e as direcionadas à mudança. Não use carteira real como massa de teste, não movimente dinheiro e não dispare mensagens para pessoas durante os testes. Diferencie teste automatizado de validação real em voz e Telegram. Se não validar um canal, informe isso.

## 9. Escopo de entrega

Implemente localmente o núcleo e integrações necessárias, com documentação de uso e dos recursos ausentes. Não altere credenciais, não publique, não faça push/release/deploy nem provisione infraestrutura neste pedido. Se surgir uma etapa de infraestrutura, siga primeiro as instruções locais sobre `bash ~/.config/claude-deploy/check.sh` e `~/.config/claude-deploy/DEPLOY_PLAYBOOK.md`; credenciais ficam fora do repositório.

Ao concluir, informe comportamento entregue, arquivos alterados, testes executados, validações não realizadas e dependências externas pendentes. Não apresente como integrado o que ficou apenas em prompt ou documentação.

FIM DO PEDIDO
