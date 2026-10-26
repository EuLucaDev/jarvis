# Plano: financeiro dentro do Jarvis

Base: a Carteira Pessoal (app Electron + SQLite que o Luca colocou em `Sistema Financeiro.zip`).

## O que a Carteira já tem

- **Núcleo separado da tela**: `electron/db/` é Node puro (better-sqlite3, pdfjs-dist, tesseract.js), sem Electron. `router.js` expõe ~150 operações e `preload.js` é só a ponte da tela até elas. Tem 96 verificações (`npm test`).
- **26 tabelas**: contas, entradas, saídas, despesas e receitas fixas, transferências, cartões e benefícios, compras parceladas, parcelas e faturas, investimentos (aportes, operações, proventos, fotos de saldo), metas (caixinha e itens), orçamentos, anexos, regras de categoria, atividades e lotes de importação.
- **Inteligência sem IA**:
  - frase → lançamento (`parser.js`);
  - cerca de 200 comerciantes e as regras aprendidas (`categorizer.js`);
  - assinaturas, fechamento do mês, calendário e saldo projetado (`insights.js`);
  - orçamento pela mediana do histórico.
- **Importação**:
  - PDF, CSV e OFX, além de foto com OCR;
  - leitores sob medida para Inter, Nubank, Santander e Mercado Pago;
  - conciliação do pagamento da fatura, saldo inicial calculado e desfazer por lote.
- **Telas** (`renderer/`): visão geral, lançamentos, carteira, investimentos, metas, a pagar, relatórios e configurações; paleta de comandos.

## Decisões do Luca (26/10/2026)

1. **Reaproveitar o motor**: o núcleo da Carteira roda dentro do Jarvis. As telas dela abrem numa janela do Jarvis com o visual do HUD, e a voz comanda tudo.
2. **Lançar e mostrar**: um gasto falado é salvo na hora e aparece num cartão com o que ele entendeu, com o botão Desfazer.
3. **Começar do zero**: o financeiro do Jarvis começa vazio. A Carteira instalada fica como está.
4. **Proativo**: avisar contas vencendo, finanças no bom dia, alertas de orçamento e fechamento do mês.

## Como fica

```
app (Tauri) ── sobe ──> núcleo Python (8765) ── sobe ──> motor financeiro Node (porta interna)
                              │  /api/fin/<operação>  ──proxy──>  router da Carteira
                              │  ferramentas de voz "financeiro_*" ──> mesmas operações
interface: /financeiro (telas da Carteira, ponte trocada de IPC para HTTP) + cartões no HUD
```

- **Motor** (`financeiro/motor/`): os `db/` da Carteira mais um `servidor.js` pequeno (HTTP local, só em 127.0.0.1, com um token por sessão).
  - Recebe `POST /<operação>` com os argumentos e chama o router.
  - Os dados ficam em `<pasta do Jarvis>/financeiro/` (banco, backups e anexos). Os backups automáticos da Carteira continuam.
- **Núcleo Python** (`backend/jarvis/finance.py`):
  - sobe e vigia o motor;
  - repassa `/api/fin/*` e expõe as ferramentas de voz;
  - fica desligado se a pessoa desmarcar "Usar o financeiro" na configuração.
- **Telas** (`frontend/public/financeiro/`): o `renderer/` da Carteira com:
  - um `ponte.js` no lugar do `preload.js` (mesma `window.api`, por fetch);
  - abrir e salvar arquivo por `<input type=file>` e download;
  - um tema por cima no azul-noite com ciano do Jarvis.
  - Abre numa janela própria pela voz ("abre o financeiro"), pelo ícone e pelo painel.
- **Empacotamento**:
  - o Node oficial (binário por sistema) vai junto com o motor e as dependências;
  - o better-sqlite3 é compilado na própria máquina da compilação de cada sistema;
  - o idioma português do OCR vai embutido, para não baixar na hora;
  - as 96 verificações rodam na compilação. Fica de fora a parte de extratos reais, porque os PDFs de `exemplos/` são do Luca e não vão para o repositório.

## Voz

| Pedido | O que acontece |
|---|---|
| "Paguei 80 no mercado no crédito do Nubank em 2x" | Salva a compra parcelada no cartão; cartão no HUD com valor, categoria, cartão, parcelas e Desfazer. Ele fala uma frase. |
| "Recebi 3 mil de salário no Inter" | Entrada na conta. |
| "Passa 500 do Inter pro Nubank" | Transferência (não conta como gasto). |
| "Quanto gastei com comida esse mês?" / "Quanto tenho no Inter?" | Consulta; cartão com o número e o gráfico. |
| "O que vence essa semana?" | Lista do A pagar no HUD. |
| "Paga a fatura do Nubank pelo Inter" | Marca paga (pergunta antes: mexe em saldo). |
| "Guarda 200 na meta da viagem" | Caixinha da meta, sai da conta escolhida. |
| "Importa os extratos da pasta Downloads" | Lê os arquivos, mostra a prévia (quantos lançamentos, meses, faturas reconhecidas) e só grava depois do sim. |
| "Desfaz o último lançamento" | Apaga o último que ele criou. |
| "Abre o financeiro" / "Mostra o relatório do mês" | Janela do financeiro na página certa. |

Para entender o que foi dito, a Gemini preenche os campos (valor, conta, cartão, parcelas, data). O `parser.js` e o `categorizer.js` da Carteira completam o que faltar (categoria pelas regras aprendidas) e conferem os nomes de conta e cartão. Assim a mesma frase dá o mesmo resultado na voz e na barra rápida.

## Proativo

- **Contas vencendo**: o `alerts.py` consulta o A pagar a cada hora. Avisa no HUD e em voz 3 dias antes e no dia, uma vez por conta, respeitando o horário de silêncio.
- **Bom dia**: um segmento de finanças com o que vence hoje e na semana, o saldo das contas e como está o mês contra o orçamento. Tem cartão próprio.
- **Orçamento**: avisa quando uma categoria passa de 80% do orçamento antes do fim do mês (usando o ritmo de `insights`) e quando um gasto foge do padrão do estabelecimento.
- **Fechamento do mês**: no último dia, às 19h (dá para mudar), ele chama: "Vamos fechar outubro?". Segue o passo a passo do `insights` por voz: o que falta classificar, o que venceu, se as fixas foram geradas e se o saldo bate.

## Fases (todas entregues na versão 2.4.0)

1. **Motor no Jarvis**: servidor do motor, ponte no Python, dados na pasta do Jarvis, empacotamento nos 3 sistemas e as verificações na compilação.
2. **Telas**: janela "Financeiro" com as telas da Carteira, a ponte por HTTP e o tema do Jarvis. Abre pelo ícone, pelo painel e pela voz.
3. **Voz e cartões**: ferramentas `financeiro_*`, cartões no HUD (lançamento com Desfazer, resumo do mês, a pagar, meta) e o prompt.
4. **Proativo**: avisos, bom dia, orçamento e fechamento do mês.
5. **Importar por voz e arrastando**: arrastar extratos para o HUD ou pedir pela pasta, com prévia e confirmação.

## Cuidados

- `Sistema Financeiro.zip` e `exemplos/` têm extratos reais: ficam fora do git (`.gitignore`).
- Nada de dados do Luca no app entregue: o financeiro de cada pessoa começa vazio.
- O motor só ouve em 127.0.0.1 e exige um token. As únicas conexões externas são as cotações (brapi, Yahoo, CoinGecko), como na Carteira.
- Apagar lançamentos em lote e pagar fatura por voz pedem confirmação.
