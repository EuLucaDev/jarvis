'use strict';

/**
 * Verificação automática do app.
 *
 * Roda com `npm test` dentro de app/. Cria um banco descartável, exercita os
 * caminhos que quebram de verdade — saldo, fatura, parcela, estorno, leitura
 * de extrato, importação e o desfazer — e imprime o placar.
 *
 * Os documentos de exemplos/ são usados quando existem; são extratos reais e
 * ficam fora do pacote distribuído.
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'carteira-teste-'));
const root = path.resolve(__dirname, '..');
const database = require(path.join(root, 'db/database'));
database.open(base);

const load = name => require(path.join(root, 'db/services', name));
const { roundCurrency } = require(path.join(root, 'db/utils'));
const repo = require(path.join(root, 'db/repository'));
const setup = load('setup');
const accounts = load('accounts');
const cards = load('cards');
const transactions = load('transactions');
const investments = load('investments');
const parser = load('parser');
const banks = load('banks');
const statement = load('statement');
const importer = load('importer');
const categorizer = load('categorizer');
const insights = load('insights');
const goals = load('goals');
const dashboard = load('dashboard');

let ok = 0;
const failures = [];

function check(label, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (same) { ok++; return; }
  failures.push(`${label}\n     esperado: ${JSON.stringify(expected)}\n     obtido:   ${JSON.stringify(actual)}`);
}

const near = (label, actual, expected, tolerance = 0.01) => {
  if (Math.abs(Number(actual) - Number(expected)) <= tolerance) { ok++; return; }
  failures.push(`${label}\n     esperado: ~${expected}\n     obtido:   ${actual}`);
};

const truthy = (label, value) => check(label, Boolean(value), true);

/** Total pago no mês, do jeito que os relatórios contam. */
const paidNoMes = month => repo.query(
  "SELECT SUM(amount) AS total FROM expenses WHERE substr(date,1,7) = ? AND status = 'PAGO'",
  [month]
)[0]?.total || 0;

// ---------------------------------------------------------------------------

async function main() {
  setup.completeOnboarding({ name: 'Teste', monthlyGoal: 1000, emergencyReserveGoal: 0 });

  // --- Conta e saldo -------------------------------------------------------
  const conta = accounts.create({
    name: 'Conta teste', bankName: 'Inter', accountType: 'CONTA_DIGITAL', initialBalance: 1000
  });
  check('conta nasce com o saldo inicial', accounts.getBalance(conta.id), 1000);

  transactions.createIncome({
    source: 'Salário', category: 'Salário', bankAccountId: conta.id, amount: 500, date: '2026-03-05'
  });
  transactions.createExpense({
    description: 'Mercado', category: 'Mercado', paymentMethod: 'DEBITO',
    bankAccountId: conta.id, amount: 200, date: '2026-03-06', status: 'PAGO'
  });
  check('entrada e saída movem o saldo', accounts.getBalance(conta.id), 1300);

  const pendente = transactions.createExpense({
    description: 'Conta de luz', category: 'Moradia', paymentMethod: 'DEBITO',
    bankAccountId: conta.id, amount: 100, date: '2026-03-10', status: 'PENDENTE'
  });
  check('saída pendente ainda não saiu do saldo', accounts.getBalance(conta.id), 1300);
  transactions.markExpenseAsPaid(pendente.id);
  check('marcar como paga desconta do saldo', accounts.getBalance(conta.id), 1200);
  transactions.deleteExpense(pendente.id);
  check('apagar devolve o saldo', accounts.getBalance(conta.id), 1300);

  // --- Carteira por quantidade, preço médio e resultado -------------------
  const corretora = accounts.create({
    name: 'Conta investimentos', bankName: 'Banco teste', accountType: 'CONTA_DIGITAL', initialBalance: 1000
  });
  const mxrf = investments.create({
    type: 'FII', symbol: 'MXRF11', name: 'Maxi Renda', institution: 'Corretora teste',
    initialQuantity: 3, initialPrice: 10, exchangeRate: 1, purchaseDate: '2026-03-01',
    bankAccountId: corretora.id, autoQuote: false
  });
  let position = investments.list().find(item => item.id === mxrf.id);
  check('posição inicial guarda três cotas', position.quantity, 3);
  check('posição inicial calcula preço médio', position.averagePrice, 10);
  check('compra do ativo reduz saldo da conta', accounts.getBalance(corretora.id), 970);

  investments.update(mxrf.id, { currentPrice: 11, autoQuote: false });
  position = investments.list().find(item => item.id === mxrf.id);
  check('cotação valoriza o patrimônio da posição', position.marketValue, 33);
  check('rentabilidade não realizada é calculada', position.profitability, 10);

  const venda = investments.createOperation({
    investmentId: mxrf.id, operationType: 'VENDA', quantity: 1, unitPrice: 12,
    exchangeRate: 1, fees: 1, date: '2026-03-20', bankAccountId: corretora.id
  });
  position = investments.list().find(item => item.id === mxrf.id);
  check('venda reduz a quantidade', position.quantity, 2);
  check('venda credita o líquido na conta', accounts.getBalance(corretora.id), 981);
  check('venda calcula lucro realizado líquido', position.realizedProfit, 1);
  const portfolio = investments.portfolioSummary();
  truthy('resumo consolida alocação por classe', portfolio.allocations.some(item => item.type === 'FII'));
  const initialData = require(path.join(root, 'db/router')).getInitialData({ year: 2026, month: 3 });
  check('carga da interface inclui operações da carteira', initialData.investmentOperations.length, 2);
  truthy('carga da interface inclui resumo patrimonial', initialData.investmentPortfolio.marketValue > 0);
  check('catálogo cobre vinte classes de investimento', initialData.investmentClasses.length, 20);
  investments.deleteOperation(venda.id);
  check('excluir venda recompõe a quantidade', investments.list().find(item => item.id === mxrf.id).quantity, 3);

  // --- Cartão, parcelas e fatura -------------------------------------------
  const cartao = cards.create({
    name: 'Cartão teste', bankName: 'Nubank', cardType: 'CREDITO',
    limit: 5000, closingDay: 20, dueDay: 1
  });
  const compra = transactions.createExpense({
    description: 'Notebook', category: 'Compras', paymentMethod: 'CARTAO_CREDITO',
    creditCardId: cartao.id, amount: 3000, date: '2026-03-10', installments: 3
  });
  const parcelas = repo.query('SELECT * FROM card_installments WHERE credit_card_id = ?', [cartao.id]);
  check('compra em 3x gera 3 parcelas', parcelas.length, 3);
  check('cada parcela é um terço', parcelas.map(item => item.amount), [1000, 1000, 1000]);
  check('a primeira parcela cai no mês da compra',
    parcelas.map(item => item.invoiceMonth).sort(), ['2026-03', '2026-04', '2026-05']);
  check('compra no cartão não mexe no saldo da conta', accounts.getBalance(conta.id), 1300);

  const compraDepoisDoFechamento = transactions.createExpense({
    description: 'Fone', category: 'Compras', paymentMethod: 'CARTAO_CREDITO',
    creditCardId: cartao.id, amount: 300, date: '2026-03-25', installments: 1
  });
  const doFone = repo.query('SELECT * FROM card_installments WHERE purchase_id = ?',
    [repo.findById('expenses', compraDepoisDoFechamento.id).cardPurchaseId]);
  check('compra depois do fechamento cai na fatura seguinte', doFone[0].invoiceMonth, '2026-04');

  cards.rebuildInvoices();
  const faturaMarco = cards.getInvoicesDetailed(cartao.id).find(item => item.referenceMonth === '2026-03');
  check('a fatura soma as parcelas do mês', faturaMarco.totalAmount, 1000);
  check('vencimento do dia 1 pertence ao mês seguinte', faturaMarco.dueDate, '2026-04-01');

  cards.payInvoice(faturaMarco.id, conta.id);
  check('pagar a fatura desconta da conta', accounts.getBalance(conta.id), 300);
  check('a saída da compra vira PAGO só quando todas as parcelas fecham',
    repo.findById('expenses', compra.id).status, 'PENDENTE');

  const faturaAbril = cards.getInvoicesDetailed(cartao.id).find(item => item.referenceMonth === '2026-04');
  cards.payInvoice(faturaAbril.id, conta.id, 1300.05);
  check('o valor pago pelo extrato manda no total da fatura',
    cards.getInvoicesDetailed(cartao.id).find(item => item.referenceMonth === '2026-04').totalAmount, 1300.05);
  near('conta desconta exatamente o que foi pago', accounts.getBalance(conta.id), -1000.05);

  // --- Estorno --------------------------------------------------------------
  const antesDoEstorno = cards.getInvoicesDetailed(cartao.id)
    .find(item => item.referenceMonth === '2026-05').totalAmount;
  transactions.createCardRefund({
    description: 'Estorno Notebook', category: 'Compras',
    creditCardId: cartao.id, amount: 100, date: '2026-05-04'
  });
  cards.rebuildInvoices();
  const depoisDoEstorno = cards.getInvoicesDetailed(cartao.id)
    .find(item => item.referenceMonth === '2026-05').totalAmount;
  near('estorno abate a fatura, não credita a conta', depoisDoEstorno, antesDoEstorno - 100);

  // --- Edição em lote -------------------------------------------------------
  const lote = [1, 2, 3].map(index => transactions.createExpense({
    description: `Padaria ${index}`, category: 'Outros', paymentMethod: 'DEBITO',
    bankAccountId: conta.id, amount: 10, date: '2026-06-0' + index, status: 'PAGO'
  }));
  transactions.bulkUpdate(lote.map(item => item.id), { category: 'Alimentação' });
  check('edição em lote troca a categoria de todos',
    lote.map(item => repo.findById('expenses', item.id).category), ['Alimentação', 'Alimentação', 'Alimentação']);
  transactions.bulkDelete(lote.map(item => item.id));
  check('exclusão em lote apaga todos', lote.filter(item => repo.findById('expenses', item.id)).length, 0);

  // --- Texto livre ----------------------------------------------------------
  const frase = parser.parseEntry('paguei 340,50 no mercado ontem no crédito do nubank em 3x',
    { today: '2026-03-10', cards: [cartao], accounts: [conta] });
  check('valor com centavos', frase.amount, 340.5);
  check('"ontem" vira a data de ontem', frase.date, '2026-03-09');
  check('reconhece o cartão de crédito', frase.paymentMethod, 'CARTAO_CREDITO');
  check('reconhece o parcelamento', frase.installments, 3);
  check('reconhece que é saída', frase.isIncome, false);

  const semSeparador = parser.parseEntry('gastei 3200 no aluguel', { today: '2026-03-10' });
  check('3200 não vira 320', semSeparador.amount, 3200);

  const debitoAutomatico = parser.parseEntry('netflix 55 em debito automatico', { today: '2026-03-10' });
  check('débito automático não vira cartão', debitoAutomatico.paymentMethod, 'PIX');

  const entrada = parser.parseEntry('recebi 2500 de salário hoje', { today: '2026-03-10' });
  check('reconhece que é entrada', entrada.isIncome, true);

  // --- Categorização --------------------------------------------------------
  check('dicionário reconhece o comerciante',
    categorizer.categorize('IFOOD *PEDIDO', 'variableExpense').category, 'Alimentação');
  check('a maquininha não engole o nome: "MERCADO PAGO" não vira "mercado"',
    categorizer.significantTerm('MERCADO PAGO INSTITUICAO DE PAGAMENTO'), 'mercado pago');
  categorizer.learn('MERCADO PAGO', 'Compras', 'variableExpense', 'user');
  check('o app aprende o que você corrige',
    categorizer.categorize('MERCADO PAGO INSTITUICAO', 'variableExpense').category, 'Compras');

  // --- Valores dos bancos ---------------------------------------------------
  check('menos antes do R$', banks.parseBRL('-R$ 190,00'), -190);
  check('menos depois do número', banks.parseBRL('387,19-'), -387.19);
  check('letra D de débito', banks.parseBRL('1.234,56 D'), -1234.56);
  check('entre parênteses', banks.parseBRL('(45,00)'), -45);
  check('positivo continua positivo', banks.parseBRL('R$ 1.234,56'), 1234.56);

  // --- Orçamento e alertas --------------------------------------------------
  // Os meses são contados a partir de hoje: a sugestão olha os últimos seis, e
  // datas fixas fariam o teste passar hoje e falhar em janeiro.
  const mesAtras = count => {
    const date = new Date();
    date.setDate(1);
    date.setMonth(date.getMonth() - count);
    return date.toISOString().slice(0, 7);
  };

  for (const mes of [mesAtras(4), mesAtras(3), mesAtras(2)]) {
    transactions.createExpense({
      description: 'Feira', category: 'Mercado', paymentMethod: 'DEBITO',
      bankAccountId: conta.id, amount: 400, date: `${mes}-15`, status: 'PAGO'
    });
  }
  transactions.createExpense({
    description: 'Feira grande', category: 'Mercado', paymentMethod: 'DEBITO',
    bankAccountId: conta.id, amount: 4000, date: `${mesAtras(1)}-15`, status: 'PAGO'
  });
  const sugestoes = insights.suggestBudgets();
  const mercado = sugestoes.find(item => item.category === 'Mercado');
  truthy('sugere orçamento para a categoria usada', mercado);
  near('a sugestão usa a mediana, não a média inflada pelo mês atípico', mercado.suggested, 400, 250);

  const fora = insights.checkOutlier('Feira', 4000);
  truthy('gasto muito acima do normal é sinalizado',
    fora && fora.flags.some(item => item.type === 'acimaDoHabitual'));
  check('gasto dentro do padrão não incomoda', insights.checkOutlier('Feira', 410), null);

  // --- Metas: caixinha e plano ----------------------------------------------
  const carteira = accounts.create({
    name: 'Conta da meta', bankName: 'Nubank', accountType: 'CONTA_DIGITAL', initialBalance: 2000
  });
  const casamento = goals.createGoal({ name: 'Casamento', targetAmount: 20000, targetDate: mesAtras(-9) + '-30' });

  goals.deposit(casamento.id, { amount: 5000, bankAccountId: carteira.id, date: '2026-09-01' });
  check('guardar na meta tira o dinheiro da conta', accounts.getBalance(carteira.id), -3000);
  check('e entra na caixinha', goals.getGoal(casamento.id).savedAmount, 5000);

  const alianca = goals.createItem(casamento.id, { name: 'Aliança', plannedAmount: 1500, category: 'Compras' });
  goals.createItem(casamento.id, { name: 'Buffet', plannedAmount: 800 });
  goals.createItem(casamento.id, { name: 'Local', plannedAmount: 1500 });
  check('o plano soma os itens', goals.getGoal(casamento.id).plannedAmount, 3800);

  goals.payItem(alianca.id, { source: 'META', date: '2026-09-10' });
  const casada = goals.getGoal(casamento.id);
  check('pagar um item não apaga o que foi juntado', casada.savedAmount, 5000);
  check('o item pago sai do saldo livre', casada.freeAmount, 3500);
  check('e entra no total pago', casada.paidAmount, 1500);
  check('pagar pela caixinha não desconta da conta de novo', accounts.getBalance(carteira.id), -3000);

  const gerada = repo.query("SELECT * FROM expenses WHERE goal_id = ?", [casamento.id])[0];
  truthy('o item pago vira despesa do mês', gerada && gerada.paymentMethod === 'META');
  check('com a categoria escolhida no item', gerada.category, 'Compras');
  check('e aparece no relatório do mês', paidNoMes('2026-09') >= 1500, true);

  check('retirar mais do que está livre é barrado', (() => {
    try { goals.deposit(casamento.id, { amount: -4000, bankAccountId: carteira.id }); return 'passou'; }
    catch (error) { return 'barrado'; }
  })(), 'barrado');

  check('pagar item sem caixinha suficiente é barrado', (() => {
    const caro = goals.createItem(casamento.id, { name: 'Lua de mel', plannedAmount: 9000 });
    try { goals.payItem(caro.id, { source: 'META' }); return 'passou'; }
    catch (error) { goals.removeItem(caro.id); return 'barrado'; }
  })(), 'barrado');

  goals.unpayItem(alianca.id);
  const desfeita = goals.getGoal(casamento.id);
  check('desmarcar devolve o valor para o livre', desfeita.freeAmount, 5000);
  check('e apaga a despesa que tinha gerado', repo.count('expenses', 'goal_id = ?', [casamento.id]), 0);

  goals.updateGoal(casamento.id, { ...casamento, targetAmount: 3000 });
  truthy('plano acima do alvo é sinalizado',
    goals.getGoal(casamento.id).overPlanned > 0);
  goals.updateGoal(casamento.id, { ...casamento, targetAmount: 20000 });

  // Pagar pela conta é diferente: aí sim o dinheiro sai do banco.
  const local = goals.getGoal(casamento.id).items.find(item => item.name === 'Local');
  goals.payItem(local.id, { source: 'CONTA', bankAccountId: carteira.id, amount: 1500, date: '2026-09-12' });
  check('pagar pela conta desconta do banco', accounts.getBalance(carteira.id), -4500);
  check('e não consome a caixinha', goals.getGoal(casamento.id).freeAmount, 5000);

  const exportado = require(path.join(root, 'db/services/importExport')).exportData();
  truthy('a exportação leva a caixinha', (exportado.goal_deposits || []).length >= 1);
  truthy('e leva os itens do plano', (exportado.goal_items || []).length >= 3);

  goals.deleteGoal(casamento.id);
  check('excluir a meta devolve o dinheiro guardado', accounts.getBalance(carteira.id), 500);
  check('e leva a caixinha junto', repo.count('goal_deposits'), 0);

  // --- Documentos reais -----------------------------------------------------
  const exemplos = path.resolve(root, '../exemplos');
  const arquivos = fs.existsSync(exemplos)
    ? fs.readdirSync(exemplos).filter(name => /\.(pdf|csv|ofx|txt)$/i.test(name)).map(name => path.join(exemplos, name))
    : [];

  if (!arquivos.length) {
    console.log('  (exemplos/ vazio — a parte de importação foi pulada)');
  } else {
    const inter = arquivos.find(file => /INTER_EXTRATO/i.test(file));
    if (inter) {
      const lido = await statement.readFile(inter, { enrich: false });
      check('extrato do Inter é reconhecido pelo leitor próprio', lido.bankId, 'inter');
      truthy('o extrato do Inter rende centenas de linhas', lido.rows.length > 300);
      truthy('aplicação em CDB não é despesa',
        lido.rows.some(row => row.kind === 'investment'));
      check('nenhuma linha sem data', lido.rows.filter(row => !/^\d{4}-\d{2}-\d{2}$/.test(row.date)).length, 0);
      check('nenhuma linha com valor zero', lido.rows.filter(row => !(row.amount > 0)).length, 0);
    }

    const sessao = await importer.readBatch(arquivos);
    truthy('a leva inteira vira uma sessão só', sessao.total > 300);
    check('nada sem data na sessão',
      sessao.rows.filter(row => !/^\d{4}-\d{2}-\d{2}$/.test(row.date)).length, 0);

    const pagamentos = sessao.rows.filter(row => row.cardPayment);
    truthy('a saída do extrato que paga a fatura é reconhecida', pagamentos.length >= 1);

    const alvos = {};
    for (const alvo of importer.suggestTargets(sessao)) {
      alvos[alvo.fileName] = alvo.matchedId
        ? (alvo.documentType === 'fatura' ? { cardId: alvo.matchedId } : { accountId: alvo.matchedId })
        : { create: alvo.proposal };
    }
    const saldoPreImportacao = accounts.getBalance(conta.id);
    const relatorio = importer.commit(sessao, alvos);
    check('importação sem erros', relatorio.errors, []);
    truthy('importou centenas de lançamentos', relatorio.expenses + relatorio.incomes > 300);

    const pagas = cards.getInvoicesDetailed().filter(item => item.status === 'PAGA');
    truthy('a fatura casada ficou fechada', pagas.length >= 1);
    truthy('e ficou registrada como paga por uma conta', pagas.every(item => item.paidFromBankAccountId));

    for (const ajuste of relatorio.reconciled || []) {
      if (ajuste.alreadyMatched) continue;
      const conferida = accounts.list().find(item => item.name === ajuste.account);
      near(`saldo do app fecha com o extrato — ${ajuste.account}`, conferida.currentBalance, ajuste.declared);
    }

    // --- Desfazer ------------------------------------------------------------
    const manual = transactions.createExpense({
      description: 'Lançado depois', category: 'Outros', paymentMethod: 'DEBITO',
      bankAccountId: conta.id, amount: 42.5, date: '2026-08-01', status: 'PAGO'
    });
    const desfeito = importer.undoBatch(relatorio.batchId);
    truthy('desfazer remove o que a importação criou', (desfeito.removed.expenses || 0) > 100);
    truthy('o lançamento feito à mão depois sobrevive', Boolean(repo.findById('expenses', manual.id)));
    near('desfazer devolve a conta ao saldo de antes da importação (menos o que veio depois)',
      accounts.getBalance(conta.id), saldoPreImportacao - 42.5);
    check('desfazer duas vezes é barrado', (() => {
      try { importer.undoBatch(relatorio.batchId); return 'passou'; }
      catch (error) { return 'barrado'; }
    })(), 'barrado');
    check('a importação desfeita fica marcada',
      importer.listBatches().filter(item => item.undone).length, 1);
  }

  // --- Painel ---------------------------------------------------------------
  const painel = dashboard.getData({ year: 2026, month: 3 });
  truthy('o painel responde sem quebrar', painel && typeof painel === 'object');
  const comparacao = insights.sameMonthLastYear('2026-03');
  truthy('a comparação com o ano passado responde', comparacao && typeof comparacao === 'object');
  const fechamento = insights.monthClosing('2026-03');
  truthy('o fechamento do mês responde', fechamento && typeof fechamento === 'object');

  carteiraDoMentor();
}

/**
 * Carteira do mentor de investimentos, num banco próprio (os números não se
 * misturam com os testes acima). Cada bloco é um risco do pedido do mentor.
 */
function carteiraDoMentor() {
  database.close();
  const base2 = fs.mkdtempSync(path.join(os.tmpdir(), 'carteira-mentor-'));
  database.open(base2);
  const portfolio = load('portfolio');
  const hoje = '2026-11-02';
  const rel = () => portfolio.report({ today: hoje });
  const ops = () => investments.listOperations().length;
  const falha = fn => { try { fn(); return ''; } catch (error) { return error.message; } };
  try {
    const banco = accounts.create({ name: 'Conta corrente', bankName: 'Banco', accountType: 'CONTA_DIGITAL', initialBalance: 5000 });
    const poupanca = accounts.create({ name: 'Outra conta', bankName: 'Banco 2', accountType: 'CONTA_DIGITAL', initialBalance: 0 });

    // 1. R$ 1.000 + aporte de R$ 500, sem oscilação: patrimônio 1.500 e resultado 0
    const etf = investments.create({ type: 'ETF', symbol: 'BOVA11', name: 'BOVA11', institution: 'Corretora A',
      initialQuantity: 10, initialPrice: 100, purchaseDate: '2026-01-02', bankAccountId: banco.id, autoQuote: false });
    investments.createOperation({ investmentId: etf.id, operationType: 'COMPRA', quantity: 5, unitPrice: 100, date: '2026-06-01', bankAccountId: banco.id });
    let r = rel();
    check('mentor 1: só com preço de compra, sem taxa inventada', r.performance.mwr.value, null);
    repo.update('investments', etf.id, { currentPrice: 100, quoteSource: 'Yahoo Finance', quoteUpdatedAt: `${hoje}T18:00:00Z` });
    r = rel();
    check('mentor 1: patrimônio = 1.000 + 500 de aporte', r.equity, 1500);
    check('mentor 1: aporte não vira resultado', r.result.total, 0);
    check('mentor 1: do bolso = 1.500', r.external.net, 1500);
    near('mentor 1: taxa pelos fluxos é 0%, não 50%', r.performance.mwr.value, 0, 1e-6);
    check('mentor 1: compra pela conta tira do saldo do banco', accounts.getBalance(banco.id), 3500);
    const mais = investments.createOperation({ investmentId: etf.id, operationType: 'COMPRA', quantity: 1, unitPrice: 120, date: '2026-06-10' });
    r = rel();
    check('mentor 1: cotação mais nova que a compra continua valendo', r.assets.find(a => a.id === etf.id).valuation, 'cotacao');
    check('mentor 1: 16 cotas a 100 menos 1.620 aplicados = −20', r.result.total, -20);
    investments.deleteOperation(mais.id);
    repo.update('investments', etf.id, { quoteSource: '', quoteUpdatedAt: '' });
    const mais2 = investments.createOperation({ investmentId: etf.id, operationType: 'COMPRA', quantity: 1, unitPrice: 120, date: '2026-06-10' });
    r = rel();
    check('mentor 1: sem cotação, comprar mais caro reavalia pelo preço da operação', r.assets.find(a => a.id === etf.id).valuation, 'preco_operacao');
    check('mentor 1: 16 cotas a 120 menos 1.620 aplicados = 300', r.result.total, 300);
    truthy('mentor 1: e avisa que não é cotação', r.gaps.some(g => g.code === 'preco_operacao'));
    investments.deleteOperation(mais2.id);
    repo.update('investments', etf.id, { currentPrice: 100, quoteSource: 'Yahoo Finance', quoteUpdatedAt: `${hoje}T18:00:00Z` });

    // 2. Compra com o caixa da carteira não é aporte nem aumenta o patrimônio
    investments.createOperation({ investmentId: etf.id, operationType: 'VENDA', quantity: 5, unitPrice: 100, date: '2026-07-01', cashSource: 'CAIXA' });
    check('mentor 2: venda para o caixa fica na carteira', rel().cash, 500);
    const fii = investments.create({ type: 'FII', symbol: 'HGLG11', name: 'HGLG11', institution: 'Corretora A', autoQuote: false, currentPrice: 100 });
    investments.createOperation({ investmentId: fii.id, operationType: 'COMPRA', quantity: 5, unitPrice: 100, date: '2026-07-02', cashSource: 'CAIXA' });
    r = rel();
    check('mentor 2: compra com caixa não muda o patrimônio', r.equity, 1500);
    check('mentor 2: compra com caixa não é aporte', r.external.net, 1500);
    check('mentor 2: caixa zerado depois da compra', r.cash, 0);
    truthy('mentor 2: caixa insuficiente é recusado', falha(() => investments.createOperation({
      investmentId: fii.id, operationType: 'COMPRA', quantity: 1, unitPrice: 100, date: '2026-07-03', cashSource: 'CAIXA' })).includes('caixa da carteira'));
    truthy('mentor 2: caixa com conta bancária é recusado', falha(() => investments.createOperation({
      investmentId: fii.id, operationType: 'VENDA', quantity: 1, unitPrice: 100, date: '2026-07-03', cashSource: 'CAIXA', bankAccountId: banco.id })).includes('conta bancária'));

    // 3. Provento recebido fica no caixa e é reinvestido: conta uma vez e não vira aporte
    investments.createIncome({ investmentId: fii.id, paymentDate: '2026-08-15', totalAmount: 30, status: 'RECEBIDO', destination: 'CAIXA' });
    r = rel();
    check('mentor 3: provento no caixa aumenta o patrimônio', r.equity, 1530);
    check('mentor 3: provento é resultado', r.result.total, 30);
    investments.createOperation({ investmentId: fii.id, operationType: 'COMPRA', quantity: 0.3, unitPrice: 100, date: '2026-08-16', cashSource: 'CAIXA' });
    r = rel();
    check('mentor 3: reinvestir não muda o patrimônio', r.equity, 1530);
    check('mentor 3: reinvestir não é aporte', r.external.net, 1500);
    check('mentor 3: provento contado uma vez', r.income.received.total, 30);
    check('mentor 3: resultado continua 30', r.result.total, 30);
    check('mentor 3: decomposição fecha', r.result.check, 0);

    // 4. Venda devolve dinheiro: custo e ganho separados, não "tudo lucro"
    const acao = investments.create({ type: 'ACAO', symbol: 'WEGE3', name: 'WEG', institution: 'Corretora B', autoQuote: false, currentPrice: 50 });
    investments.createOperation({ investmentId: acao.id, operationType: 'COMPRA', quantity: 10, unitPrice: 50, date: '2026-09-01' });
    const antes = rel().result.total;
    investments.createOperation({ investmentId: acao.id, operationType: 'VENDA', quantity: 10, unitPrice: 60, date: '2026-10-01' });
    r = rel();
    check('mentor 4: ganho da venda é 100, não 600', roundCurrency(r.result.total - antes), 100);
    check('mentor 4: realizado da posição', investments.list().find(i => i.id === acao.id).realizedProfit, 100);
    check('mentor 4: os 600 saem como fluxo externo', r.external.outflows, 600);
    check('mentor 4: decomposição fecha', r.result.check, 0);

    // 5. Transferência entre contas bancárias não é aporte nem resgate
    const fluxoAntes = rel().external.net;
    accounts.createTransfer({ fromAccountId: banco.id, toAccountId: poupanca.id, amount: 700, date: '2026-10-05' });
    check('mentor 5: transferência interna não mexe nos aportes', rel().external.net, fluxoAntes);

    // 6. Cotação antiga ou ausente: não inventa preço nem some do total
    repo.update('investments', etf.id, { currentPrice: 100, quoteSource: 'Yahoo Finance', quoteUpdatedAt: '2026-10-01T18:00:00Z' });
    r = rel();
    check('mentor 6: cotação de um mês atrás é antiga', r.assets.find(a => a.id === etf.id).valuation, 'cotacao_antiga');
    truthy('mentor 6: lacuna de cotação antiga', r.gaps.some(g => g.code === 'cotacao_antiga'));
    const stock = investments.create({ type: 'STOCK', symbol: 'AAPL', name: 'Apple', institution: 'Corretora EUA', autoQuote: false, currentPrice: 0, currency: 'USD' });
    investments.createOperation({ investmentId: stock.id, operationType: 'COMPRA', quantity: 0.5, unitPrice: 200, exchangeRate: 5.5, date: '2026-10-10' });
    r = rel();
    let semPreco = r.assets.find(a => a.id === stock.id);
    check('mentor 6: sem cotação, vale o preço da compra (com o câmbio dela)', semPreco.valuation, 'preco_operacao');
    check('mentor 6: em reais, pelo câmbio da operação', semPreco.marketValue, 550);
    repo.update('investments', stock.id, { currentPrice: 0, quoteSource: '', quoteUpdatedAt: '' });
    r = rel();
    semPreco = r.assets.find(a => a.id === stock.id);
    check('mentor 6: sem preço nenhum entra pelo custo', semPreco.valuation, 'custo');
    check('mentor 6: e continua no patrimônio', semPreco.marketValue, 550);
    truthy('mentor 6: lacuna de sem cotação', r.gaps.some(g => g.code === 'sem_cotacao'));
    truthy('mentor 6: custo já está em reais, sem alerta de câmbio', !r.gaps.some(g => g.code === 'cambio'));
    repo.update('investments', stock.id, { currentPrice: 210, exchangeRate: 1 });
    truthy('mentor 6: preço em dólar sem câmbio é sinalizado', rel().gaps.some(g => g.code === 'cambio'));

    // 7. Eventos societários preservam custo; os não suportados são recusados
    const div = investments.create({ type: 'ACAO', symbol: 'ITSA4', name: 'Itaúsa', institution: 'Corretora B', autoQuote: false, currentPrice: 10 });
    investments.createOperation({ investmentId: div.id, operationType: 'COMPRA', quantity: 100, unitPrice: 10, date: '2026-02-01' });
    investments.createOperation({ investmentId: div.id, operationType: 'DESDOBRAMENTO', quantity: 100, date: '2026-03-01' });
    investments.update(div.id, { currentPrice: 5 });
    let pos = investments.list().find(i => i.id === div.id);
    check('mentor 7: desdobramento dobra as cotas', pos.quantity, 200);
    check('mentor 7: sem ganho artificial', pos.unrealizedProfit, 0);
    check('mentor 7: preço médio cai pela metade', pos.averagePrice, 5);
    investments.createOperation({ investmentId: div.id, operationType: 'GRUPAMENTO', quantity: 100, date: '2026-04-01' });
    investments.update(div.id, { currentPrice: 10 });
    pos = investments.list().find(i => i.id === div.id);
    check('mentor 7: grupamento volta às 100 cotas', pos.quantity, 100);
    check('mentor 7: grupamento mantém o custo', pos.costBasis, 1000);
    truthy('mentor 7: incorporação é recusada com explicação', falha(() => investments.createOperation({
      investmentId: div.id, operationType: 'INCORPORACAO', quantity: 1, unitPrice: 1, date: '2026-04-02' })).includes('incorporação'));
    const papel = investments.create({ type: 'FII', symbol: 'KNCR11', name: 'KNCR11', institution: 'Corretora A', autoQuote: false, currentPrice: 90 });
    investments.createOperation({ investmentId: papel.id, operationType: 'COMPRA', quantity: 10, unitPrice: 100, date: '2026-05-01' });
    investments.createOperation({ investmentId: papel.id, operationType: 'AMORTIZACAO', totalAmount: 100, quantity: 0, date: '2026-05-20' });
    pos = investments.list().find(i => i.id === papel.id);
    check('mentor 7: amortização abate o custo', pos.costBasis, 900);
    check('mentor 7: amortização não é lucro', pos.realizedProfit, 0);
    check('mentor 7: decomposição fecha com eventos', rel().result.check, 0);

    // 8. Registro repetido (chave, timeout, Telegram) não duplica
    const n = ops();
    const primeira = investments.createOperation({ investmentId: div.id, operationType: 'COMPRA', quantity: 1, unitPrice: 10, date: '2026-10-20', externalKey: 'bolso:abc' });
    const repetida = investments.createOperation({ investmentId: div.id, operationType: 'COMPRA', quantity: 1, unitPrice: 10, date: '2026-10-20', externalKey: 'bolso:abc' });
    check('mentor 8: chave repetida devolve a mesma operação', repetida.id, primeira.id);
    truthy('mentor 8: e avisa que era repetida', repetida.duplicate);
    const semChave = investments.createOperation({ investmentId: div.id, operationType: 'COMPRA', quantity: 2, unitPrice: 10, date: '2026-10-21' });
    const deNovo = investments.createOperation({ investmentId: div.id, operationType: 'COMPRA', quantity: 2, unitPrice: 10, date: '2026-10-21' });
    check('mentor 8: idêntica em seguida não duplica', deNovo.id, semChave.id);
    check('mentor 8: só duas operações novas', ops(), n + 2);
    const prov = investments.createIncome({ investmentId: fii.id, paymentDate: '2026-10-15', totalAmount: 12, externalKey: 'tg:9' });
    check('mentor 8: provento com a mesma chave não duplica',
      investments.createIncome({ investmentId: fii.id, paymentDate: '2026-10-15', totalAmount: 12, externalKey: 'tg:9' }).id, prov.id);

    // Precisão: cripto e frações não são arredondadas a centavos
    const btc = investments.create({ type: 'CRIPTO', symbol: 'BTC', name: 'Bitcoin', institution: 'Exchange', autoQuote: false, currentPrice: 350000.12345678 });
    const opBtc = investments.createOperation({ investmentId: btc.id, operationType: 'COMPRA', quantity: 0.00012345, unitPrice: 350000.12345678, date: '2026-10-25' });
    check('precisão: quantidade de cripto preservada', opBtc.quantity, 0.00012345);
    check('precisão: preço unitário com 8 casas', opBtc.unitPrice, 350000.12345678);
    check('precisão: total em centavos', opBtc.totalAmount, 43.21);

    // Proventos a receber ficam separados dos recebidos
    investments.createIncome({ investmentId: fii.id, paymentDate: '2026-12-15', totalAmount: 9, status: 'PREVISTO' });
    r = rel();
    check('proventos: a receber separado', r.income.expected.total, 9);
    check('proventos: recebidos não incluem o previsto', r.income.received.total, 42);

    // Política e perfil: só com aprovação/consentimento, com versões
    truthy('política sem aprovação é recusada', falha(() => portfolio.savePolicy({ metas: { renda_fixa: 100 } })).includes('aprovar'));
    truthy('metas que não somam 100 são recusadas', falha(() => portfolio.savePolicy({ aprovada: true, metas: { renda_fixa: 50 } })).includes('100%'));
    truthy('perfil sem consentimento é recusado', falha(() => portfolio.saveProfile({ objetivo: 'aposentadoria' })).includes('autorizar'));
    portfolio.savePolicy({ aprovada: true, metas: { renda_fixa: 40, acoes_br: 30, fii_fiagro: 20, exterior: 10 }, limite_ativo_pct: 30 }, 'primeira');
    portfolio.savePolicy({ aprovada: true, metas: { renda_fixa: 50, acoes_br: 20, fii_fiagro: 20, exterior: 10 }, limite_ativo_pct: 30 }, 'mais conservadora');
    check('política: a última versão vale', portfolio.currentPolicy().version, 2);
    check('política: trilha de revisão', portfolio.history('POLITICA').length, 2);
    r = rel();
    const rf = r.allocation.byGroup.find(g => g.group === 'renda_fixa');
    check('alocação: meta da política aparece', rf.target, 50);
    truthy('alocação: falta renda fixa', rf.toTarget > 0);

    // Fotos do patrimônio e XIRR
    investments.recordSnapshot();
    const foto = repo.all('investment_snapshots').at(-1);
    truthy('foto guarda o total que veio de fora', foto.externalNet !== '' && foto.externalNet !== null);
    near('xirr: 1.000 que viram 1.100 em um ano = 10%', portfolio.xirr([{ date: '2025-01-01', amount: -1000 }, { date: '2026-01-01', amount: 1100 }]), 0.1, 1e-6);
    check('xirr: sem fluxo de sinal oposto não inventa taxa', portfolio.xirr([{ date: '2025-01-01', amount: -1000 }]), null);

    // Saldo antigo sem operações: entra no total, marcado, e trava a taxa
    investments.create({ type: 'CDB', name: 'CDB antigo', institution: 'Banco', currentAmount: 0, autoQuote: false });
    const cdb = investments.create({ type: 'PREVIDENCIA', name: 'Previdência', institution: 'Banco', autoQuote: false });
    repo.update('investments', cdb.id, { currentAmount: 2000 });
    r = rel();
    truthy('saldo sem histórico vira lacuna', r.gaps.some(g => g.code === 'sem_historico'));
    check('saldo sem histórico bloqueia a taxa', r.performance.mwr.value, null);
    investments.setValuation(cdb.id, { value: 2100, date: '2026-10-31' });
    r = rel();
    check('valor informado avalia a posição', r.assets.find(a => a.id === cdb.id).marketValue, 2100);
    check('valor informado não apaga o custo', r.assets.find(a => a.id === cdb.id).costBasis, 2000);
    check('decomposição fecha no fim', r.result.check, 0);
  } finally {
    database.close();
    fs.rmSync(base2, { recursive: true, force: true });
    database.open(base);
  }
}

main()
  .then(() => {
    console.log(`\n  ${ok} verificações ok · ${failures.length} falha(s)\n`);
    for (const failure of failures) console.log(`  ✗ ${failure}\n`);
    database.close();
    fs.rmSync(base, { recursive: true, force: true });
    process.exit(failures.length ? 1 : 0);
  })
  .catch(error => {
    console.error('\n  A verificação parou com erro:\n', error);
    database.close();
    fs.rmSync(base, { recursive: true, force: true });
    process.exit(1);
  });
