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
