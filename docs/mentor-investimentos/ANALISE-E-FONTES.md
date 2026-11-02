# Análise dos materiais e fundamentos do mentor

Preparado em 02/11/2026. Escopo: dois textos enviados pelo usuário, pesquisa pública e inspeção limitada da arquitetura local para preparar instruções. Não houve implementação, acesso a carteira pessoal, operação financeira ou publicação.

## Conclusão

Os materiais fornecem uma boa direção pedagógica: começar com valores acessíveis, explicar negócios, acompanhar aportes e proventos, diversificar e manter disciplina. O prompt original, porém, transforma preferências do autor em regras universais e algumas simulações em conclusões de compra. Uma IA instruída literalmente dessa forma pode produzir recomendações excessivamente confiantes e números enganosos.

A solução preparada preserva a didática e acrescenta diagnóstico, fontes datadas, análise por classe, valuation com cenários e contabilidade de carteira. O acompanhamento semelhante ao Investidor10 depende de dados, histórico e ferramentas persistentes, além das instruções do modelo.

## O que foi e não foi verificado

Foram lidos os dois anexos integrais. Foram pesquisados fundamentos nas fontes abaixo e conferidos exemplos aritméticos do material. A arquitetura relevante do Jarvis foi consultada em código e documentação, sem executar seus fluxos.

Não foram assistidos nem conferidos individualmente os vídeos ou todas as playlists. O segundo texto não fornece URLs, datas e trechos verificáveis para os episódios. Portanto, compras atribuídas ao autor, valores das carteiras, números de episódios, retornos e alcance de metas continuam sendo alegações do resumo do Gemini. Não é possível concluir daqui quais erros vêm do canal e quais vieram da síntese. As cotações dos textos não foram tratadas como cotações de hoje.

## Correções importantes

### 1. Carteira ideal não é necessariamente 25% em cada caixa

A composição precisa respeitar objetivo, prazo, liquidez, situação financeira e capacidade de perda. Uma pessoa que precisa do dinheiro em um ano e outra acumulando para aposentadoria não devem receber automaticamente a mesma carteira. O protocolo do mentor usa esses elementos antes de personalizar. [CVM: entenda o suitability](https://www.gov.br/investidor/pt-br/investir/antes-de-investir/respeite-o-seu-perfil-de-investidor/entenda-o-suitability).

Cripto pode ter alocação zero; FIIs e ações individuais também não são obrigatórios. Reserva de emergência não é caixa para comprar quedas. Um aporte pequeno não precisa ser pulverizado em muitas classes para parecer diversificado.

### 2. A fórmula de preço-teto do resumo não é valuation completo

`LPA atual × (1 + crescimento)^5 × payout / 8%` responde a uma hipótese de rendimento futuro sobre um preço pago. Não determina, isoladamente, valor justo presente. Faltam tratamento do tempo, risco, trajetória dos fluxos e sustentabilidade das premissas. Um modelo de dividendos avalia o valor presente de pagamentos futuros, com taxa compatível com o risco. [Damodaran/NYU: fundamentos de valuation](https://pages.stern.nyu.edu/~adamodar/New_Home_Page/lectures/val.html).

Isso não torna a fórmula inútil: ela pode ser um filtro de yield futuro, desde que identificada corretamente e acompanhada de análise. O problema está em converter automaticamente resultado positivo em “zona de compra”. O prompt permite reproduzir o cálculo solicitado, mas exige esse enquadramento e comparação com modelos adequados.

### 3. “Margem de segurança” estava misturada com potencial de alta

Se uma estimativa de valor é R$ 100 e o preço é R$ 80:

- potencial até a estimativa: `100 / 80 - 1 = 25%`;
- desconto em relação à estimativa: `1 - 80 / 100 = 20%`.

O resumo usa o primeiro cálculo e chama de margem de segurança. O mentor passa a nomear os dois separadamente e lembra que o próprio valor estimado é incerto.

### 4. Dividendos altos não comprovam bom retorno

Distribuições podem ser extraordinárias, resultar de venda de patrimônio, não se repetir ou acompanhar deterioração do ativo. Renda recebida deve ser analisada com sustentabilidade e variação patrimonial. Yield on cost mede renda sobre custo histórico e não é o retorno corrente do capital a mercado.

O relatório deve distinguir valorização, proventos, aportes e retiradas. Quando a série de preços ou índice já inclui reinvestimento dos proventos, somá-los novamente duplica retorno.

### 5. Final 3 não garante automaticamente tag along de 100%

O piso legal para ações ordinárias é de 80% nas hipóteses aplicáveis; segmentos e estatutos podem oferecer proteção superior. O Novo Mercado exige 100%. Assim, é preciso verificar a empresa e os direitos da classe, e não apenas o final do ticker. [B3: ITAG e proteção por tag along](https://borainvestir.b3.com.br/glossario/itag-b3-indice-de-acoes-com-tag-along-diferenciado/).

ON, PN e units exigem avaliação dos direitos efetivos, governança, preço e liquidez. O próprio material alterna preferência estrita por ON e exemplos com ITSA4 e KLBN4, o que reforça que essa preferência não deve virar uma proibição automática.

### 6. FGC não se limita a olhar R$ 250 mil em cada aplicativo

A garantia ordinária é limitada a R$ 250 mil por CPF/CNPJ e instituição ou conglomerado, com teto global de R$ 1 milhão em quatro anos. A exposição elegível precisa considerar as condições da cobertura e os rendimentos até o evento aplicável. Distribuidores distintos podem vender títulos do mesmo emissor. A lista de produtos cobertos importa: fundos, CRI e CRA, por exemplo, não recebem essa garantia. [FGC: produtos e limites](https://www.fgc.org.br/pt-br/sobre-garantia-fgc).

Manter margem abaixo do teto pode ser prudente, mas R$ 200 mil é um limite operacional escolhido, não o teto legal universal. Basileia de 13% isoladamente não prova segurança, e a qualidade do custodiante não substitui análise do emissor do crédito.

### 7. CDI não é uma subtração fixa da Selic

A taxa DI decorre de operações interfinanceiras e de uma metodologia própria. Proximidade histórica entre taxas não autoriza defini-la como Selic menos 0,10 ponto percentual. O mentor deve consultar a taxa pertinente e observar a convenção de capitalização. [B3: Depósito Interfinanceiro e taxa DI](https://www.b3.com.br/pt_br/produtos-e-servicos/registro/renda-fixa-e-valores-mobiliarios/deposito-interfinanceiro.htm).

### 8. Tesouro Selic não significa ausência absoluta de oscilação ou liquidez instantânea em qualquer horário

Na venda antecipada, os títulos do Tesouro seguem preços de mercado e regras de recompra/liquidação. O Tesouro Selic tem risco de mercado baixo em comparação a títulos longos prefixados e IPCA+, mas isso não deve virar promessa de preço invariável. [Tesouro Direto: regras e regulamento](https://www.tesourodireto.com.br/sobre-o-tesouro/regras-e-regulamento).

Prefixados também podem servir ao casamento de uma obrigação nominal com o vencimento; não só a uma aposta de queda da Selic. A indicação depende do objetivo e do risco de saída antecipada.

### 9. Conversão de taxa anual em mensal precisa de capitalização

Para taxa efetiva anual de 12%, a taxa mensal equivalente é `(1,12)^(1/12) - 1`, aproximadamente 0,9489%. Não existe divisor 12,5 universal. Rendimento líquido no resgate também depende de prazo, imposto e custos; não equivale automaticamente a pagamento mensal.

No exemplo SAC do texto, os juros de R$ 1.575 sobre R$ 270 mil resultam de `7% / 12`, convenção de taxa nominal anual com capitalização mensal. Se os 7% fossem taxa efetiva anual, a conversão seria diferente. Sem identificar a convenção, a comparação pode induzir erro.

### 10. Financiar versus alugar exige comparar os fluxos completos

Amortização forma patrimônio, mas não elimina entrada, seguros, manutenção, custos de transação e custo de oportunidade. A decisão não se resolve apenas comparando juros com aluguel. CET inclui encargos além da taxa anunciada. [Banco Central: cuidados e CET](https://www.bcb.gov.br/meubc/faqs/p/cuidados-na-hora-de-contratar-uma-operacao-de-credito?trk=article-ssr-frontend-pulse_little-text-block).

Amortizar ou investir pede cenários de prazo, risco, tributação e taxas futuras. Aplicar uma Selic elevada constante por 23 anos não prova superioridade sobre a amortização. O benefício de quitar dívida e a rentabilidade futura incerta de um investimento não têm necessariamente o mesmo risco.

### 11. FIIs/Fiagro não são renda mensal garantida e isenta sem condições

Os riscos incluem imóveis/crédito, concentração, liquidez, ocupação e gestão. Rendimentos podem variar. [CVM: principais riscos de FIIs](https://www.gov.br/investidor/pt-br/investir/tipos-de-investimentos/fundos-de-investimentos-imobiliarios-fii/principais-riscos).

A isenção de rendimentos para pessoa física tem requisitos legais; ela não significa isenção de todo ganho na venda de cotas. A legislação atualizada precisa prevalecer sobre cartilhas antigas — inclusive materiais oficiais antigos podem ainda mencionar um número de cotistas já alterado. [Lei 11.033, texto atualizado, art. 3º](https://www2.camara.leg.br/legin/fed/lei/2004/lei-11033-21-dezembro-2004-535177-normaatualizada-pl.html).

Dez cotas de R$ 10 e uma de R$ 100 representam o mesmo desembolso se esses forem os preços, mas não o mesmo risco se os fundos forem diferentes. Base nominal da cota não mede qualidade ou desconto.

Em fundos de fundos, camadas de taxas não são a mesma coisa que “dupla tributação”. O custo combinado deve ser comparado com o serviço de gestão e diversificação entregue.

### 12. Exterior e cripto pedem regras próprias

SIPC protege, sob condições e limites, ativos e caixa de clientes de corretoras participantes em situações de falha da corretora; não protege contra quedas de mercado nem promessa de desempenho. Não é equivalente à cobertura de depósito bancário. [SIPC: o que a proteção cobre](https://www.sipc.org/for-investors/introduction).

Impostos de aplicações financeiras e ativos virtuais no exterior dependem do enquadramento. Portanto, a frase “vendas de cripto até R$ 35 mil são sempre isentas” não pode ser usada como regra universal. É necessário verificar custódia/intermediação, natureza do ativo, evento e norma do período. [Receita Federal: perguntas e respostas sobre aplicações no exterior, inclusive ativos virtuais](https://www.gov.br/fazenda/pt-br/acesso-a-informacao/perguntas-frequentes/tributacao-offshore/perguntas-e-respostas-offshores-in-rfb-2-180-22-05-24.pdf).

Não foram fixados no prompt IOF, spreads, parceiro bancário, condição de resgate ou taxa de corretora retirados dos resumos. São informações mutáveis. Exchange não é autocustódia; produtos de rendimento e stablecoins acrescentam riscos; halving não determina retorno futuro.

### 13. Regras fiscais de dividendos precisam de data

O material não serve como tabela fiscal permanente. A Receita documenta mudanças com efeitos desde janeiro de 2026, incluindo IRRF de dividendos em situações previstas na Lei 15.270/2025. A aplicação depende de beneficiário, pagador, valores, transições e outras condições. O mentor consulta a regra vigente antes de calcular valores líquidos, sem estender uma regra de ações automaticamente a fundos. [Receita: orientação sobre retenção de lucros e dividendos](https://www.gov.br/receitafederal/pt-br/assuntos/noticias/2026/agosto/receita-federal-orienta-sobre-os-procedimentos-para-o-recolhimento-do-imposto-de-renda-retido-na-fonte-sobre-lucros-e-dividendos/).

### 14. Aportes constantes são úteis; DCA não vence sempre

Investir a renda à medida que ela chega é diferente de manter um montante já disponível em caixa e parcelá-lo. Parcelar pode ajudar no comportamento e na transição ao risco, mas reduz tempo de exposição ao mercado. A pesquisa histórica da Vanguard encontra vantagem frequente para aplicação de uma vez nas condições estudadas, sem garantir resultado futuro. [Vanguard: investir um montante ou parcelar](https://investor.vanguard.com/investor-resources-education/online-trading/dollar-cost-averaging-vs-lump-sum?lang=en).

### 15. Evolução patrimonial e rentabilidade são coisas diferentes

R$ 1.000 de carteira + R$ 500 de aporte = R$ 1.500, mesmo com resultado de investimentos zero. Para comparar desempenho sem distorção pelos fluxos, é necessária uma metodologia apropriada, como TWR com avaliações adequadas. Para a experiência pessoal com fluxos datados, MWR/XIRR pode ser útil. Não basta dividir a diferença do saldo pelos aportes. [GIPS: cálculo e tratamento de fluxos externos](https://www.gipsstandards.org/standards/gips-standards-for-firms/gips-standards-handbook-for-firms/).

A inclusão tardia de renda fixa pode mudar o perímetro e a medida da carteira. Isso não prova que uma perda anterior “virou lucro” sem refazer a base histórica de forma coerente. Proventos reinvestidos são resultado retido, não novos aportes externos.

## Outras fragilidades identificadas nos resumos

- Exemplo de aporte de R$ 328 composto por R$ 220 + R$ 31 + R$ 59: a soma é R$ 310. Faltam R$ 18 ou algum componente está errado.
- Exemplo de R$ 52 restantes usado para compras de R$ 25 + R$ 29: a soma é R$ 54. É preciso reconciliar caixa e custos, sem inventar a diferença.
- Reajuste de 10% chamado de “inflação oficial”: taxa fixa de aumento do aporte não substitui a inflação efetivamente medida.
- Descrição de impostos sobre receita depois do EBITDA e equivalência entre EBITDA e lucro operacional: a DRE pedagógica apresentada omite distinções relevantes. O mentor deve ensinar receita líquida, despesas, depreciação, resultado financeiro e tributos nas bases apropriadas.
- Referência a 15 ações eliminando um percentual fixo de risco: o resultado depende do universo, correlações e metodologia. Quantidade de tickers não assegura diversificação econômica.
- P/VP de qualquer FII descrito como valor de laudo dos imóveis: fundos de recebíveis têm composição patrimonial diferente.
- Proteção cambial tratada como ganho sempre favorável: diversificação internacional também pode apresentar perdas em reais por câmbio e mercado.
- Explicação monetária da inflação é uma analogia parcial: choques de oferta, demanda, expectativas, câmbio e transmissão de política monetária não se resumem à emissão de moeda.
- Renda passiva crescente e metas atribuídas ao autor não comprovam retorno dos ativos sem verificar os aportes, retiradas e o histórico completo.
- Projeções de décadas com yield/retorno fixo não demonstram renda sustentável. Precisam de cenários, inflação, custos, tributos e incerteza.

## Aplicação no Jarvis

A inspeção local confirmou pontos de prompt de voz e texto, ferramentas de pesquisa/mercado e um assunto de investimentos ligado ao motor financeiro. Também há fluxos distintos de Telegram no computador, bolso com cópia/pendências e conta somente Telegram. Não foi validado em execução se esses caminhos já cobrem o nível de precisão, histórico e desempenho exigido pelo mentor.

Por isso, o pedido ao Claude exige reaproveitar e verificar a base, manter o mesmo método entre canais, calcular fora do modelo, identificar cópias antigas e registrar operações sem duplicidade. O prompt comportamental sozinho não entrega atualização de mercado, alertas persistentes ou um painel completo.

## Como usar os arquivos

1. **ChatGPT:** abra `PROMPT-CHATGPT.md`, copie somente o trecho entre INÍCIO e FIM e envie na conversa. Também pode colocá-lo nas instruções de um projeto com espaço adequado e anexar sua carteira. A disponibilidade de busca, arquivos e memória depende do ambiente.
2. **Claude no Jarvis:** envie o trecho de `PROMPT-CLAUDE-JARVIS.md` com `PROMPT-CHATGPT.md` anexado, ou indique os caminhos locais se o Claude tiver acesso ao repositório. Inclua este documento para contexto da metodologia.
3. **Dados reais:** forneça os registros da sua própria carteira quando iniciar o acompanhamento. O conteúdo do canal não é sua carteira e não foi importado.

Este pacote entrega instruções e especificação de integração. O funcionamento no aplicativo dependerá da implementação e da validação posterior.
