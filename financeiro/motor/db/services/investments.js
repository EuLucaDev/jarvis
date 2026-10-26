'use strict';

const repo = require('../repository');
const accounts = require('./accounts');
const { logActivity } = require('./catalog');
const { generateId, now, toNumber, roundCurrency, required, dateOnly, sum, addMonths, monthKey, formatBRL } = require('../utils');

// ---------------------------------------------------------------------------
// Investimentos
// ---------------------------------------------------------------------------

const ASSET_CLASSES = [
  { value: 'ACAO', label: 'Ações', quoted: true, market: 'BR' },
  { value: 'FII', label: 'Fundos imobiliários', quoted: true, market: 'BR' },
  { value: 'FIAGRO', label: 'Fiagros', quoted: true, market: 'BR' },
  { value: 'ETF', label: 'ETFs nacionais', quoted: true, market: 'BR' },
  { value: 'BDR', label: 'BDRs', quoted: true, market: 'BR' },
  { value: 'STOCK', label: 'Stocks', quoted: true, market: 'US' },
  { value: 'REIT', label: 'REITs', quoted: true, market: 'US' },
  { value: 'ETF_INTERNACIONAL', label: 'ETFs internacionais', quoted: true, market: 'US' },
  { value: 'CRIPTO', label: 'Criptomoedas', quoted: true, market: 'GLOBAL' },
  { value: 'TESOURO_DIRETO', label: 'Tesouro Direto', quoted: true, market: 'BR' },
  { value: 'CDB', label: 'CDB / RDB', quoted: false, market: 'BR' },
  { value: 'LCI_LCA', label: 'LCI / LCA', quoted: false, market: 'BR' },
  { value: 'CRI_CRA', label: 'CRI / CRA', quoted: false, market: 'BR' },
  { value: 'DEBENTURE', label: 'Debêntures', quoted: false, market: 'BR' },
  { value: 'FUNDO', label: 'Fundos de investimento', quoted: false, market: 'BR' },
  { value: 'PREVIDENCIA', label: 'Previdência privada', quoted: false, market: 'BR' },
  { value: 'POUPANCA', label: 'Poupança', quoted: false, market: 'BR' },
  { value: 'RESERVA_EMERGENCIA', label: 'Reserva de emergência', quoted: false, market: 'BR' },
  { value: 'RENDA_FIXA', label: 'Outros de renda fixa', quoted: false, market: 'BR' },
  { value: 'OUTROS', label: 'Outros investimentos', quoted: false, market: 'BR' }
];

const LEGACY_CLASSES = { FUNDO_IMOBILIARIO: 'FII', RENDA_VARIAVEL: 'ACAO' };
const classMeta = type => ASSET_CLASSES.find(item => item.value === (LEGACY_CLASSES[type] || type))
  || { value: type || 'OUTROS', label: String(type || 'Outros').replaceAll('_', ' '), quoted: false, market: 'BR' };
const roundQuantity = value => Math.round(toNumber(value) * 100000000) / 100000000;

function rawList() {
  return repo.all('investments', 'status, name COLLATE NOCASE');
}

function listOperations(filters = {}) {
  let items = repo.all('investment_operations', 'date DESC, created_at DESC');
  if (filters.investmentId) items = items.filter(item => item.investmentId === filters.investmentId);
  if (filters.year) items = items.filter(item => String(item.date).startsWith(String(filters.year)));
  return items;
}

function listIncome(filters = {}) {
  let items = repo.all('investment_income', 'payment_date DESC, created_at DESC');
  if (filters.investmentId) items = items.filter(item => item.investmentId === filters.investmentId);
  if (filters.year) items = items.filter(item => String(item.paymentDate).startsWith(String(filters.year)));
  return items;
}

function daysBetween(from, to = dateOnly(now())) {
  const start = new Date(`${dateOnly(from)}T12:00:00`);
  const end = new Date(`${dateOnly(to)}T12:00:00`);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return 0;
  return Math.max(0, Math.round((end - start) / 86400000));
}

function contractualValue(operations, annualRate) {
  const rate = toNumber(annualRate) / 100;
  let total = 0;
  for (const operation of operations) {
    const sign = ['VENDA', 'RESGATE'].includes(operation.operationType) ? -1 : 1;
    if (!['COMPRA', 'APORTE', 'VENDA', 'RESGATE'].includes(operation.operationType)) continue;
    const principal = toNumber(operation.totalAmount) || toNumber(operation.quantity) * toNumber(operation.unitPrice);
    const factor = rate ? Math.pow(1 + rate, daysBetween(operation.date) / 365) : 1;
    total += sign * principal * factor;
  }
  return roundCurrency(Math.max(0, total));
}

function calculatePosition(item, operations = [], incomeRows = []) {
  let quantity = 0;
  let costBasis = 0;
  let realizedProfit = 0;
  let grossPurchases = 0;

  for (const operation of [...operations].sort((a, b) => String(a.date).localeCompare(String(b.date)))) {
    const qty = Math.abs(toNumber(operation.quantity));
    const fees = Math.abs(toNumber(operation.fees));
    const exchange = Math.max(0.000001, toNumber(operation.exchangeRate) || 1);
    const gross = qty * toNumber(operation.unitPrice) * exchange;
    const sale = ['VENDA', 'RESGATE'].includes(operation.operationType);
    const total = Math.abs(toNumber(operation.totalAmount)) || (sale ? Math.max(0, gross - fees) : gross + fees);
    if (['COMPRA', 'APORTE'].includes(operation.operationType)) {
      quantity += qty;
      costBasis += total;
      grossPurchases += total;
    } else if (['BONIFICACAO', 'DESDOBRAMENTO'].includes(operation.operationType)) {
      quantity += qty;
    } else if (['VENDA', 'RESGATE'].includes(operation.operationType)) {
      const sold = Math.min(quantity, qty);
      const average = quantity > 0 ? costBasis / quantity : 0;
      const removedCost = average * sold;
      realizedProfit += total - removedCost;
      quantity = Math.max(0, quantity - sold);
      costBasis = Math.max(0, costBasis - removedCost);
    }
  }

  // Carteiras antigas não tinham operações. O saldo permanece íntegro até o
  // usuário começar a informar quantidade/preço ou importar o histórico.
  const hasOperations = operations.length > 0;
  if (!hasOperations) {
    quantity = toNumber(item.quantity);
    costBasis = quantity > 0 && toNumber(item.averagePrice) > 0
      ? quantity * toNumber(item.averagePrice)
      : toNumber(item.currentAmount);
    grossPurchases = costBasis;
  }

  const type = item.assetClass || item.type;
  const quoted = classMeta(type).quoted;
  const exchangeRate = Math.max(0.000001, toNumber(item.exchangeRate) || 1);
  let marketValue = quoted && quantity > 0 && toNumber(item.currentPrice) > 0
    ? quantity * toNumber(item.currentPrice) * exchangeRate
    : toNumber(item.currentAmount);
  if (!quoted && hasOperations) marketValue = contractualValue(operations, item.annualRate) || costBasis;

  const incomeReceived = sum(incomeRows.filter(row => row.status !== 'PREVISTO'), 'totalAmount');
  const incomeExpected = sum(incomeRows.filter(row => row.status === 'PREVISTO'), 'totalAmount');
  const unrealizedProfit = marketValue - costBasis;
  const totalProfit = unrealizedProfit + realizedProfit + incomeReceived;
  const profitability = costBasis > 0 ? (totalProfit / costBasis) * 100 : 0;

  return {
    ...item,
    type, assetClass: type, classLabel: classMeta(type).label,
    quoted, hasOperations, quantity: roundQuantity(quantity),
    // O consolidado é sempre em reais; para ativos externos o custo já inclui
    // o câmbio histórico informado em cada operação.
    averagePrice: quantity > 0 ? roundCurrency(costBasis / quantity) : 0,
    costBasis: roundCurrency(costBasis), grossPurchases: roundCurrency(grossPurchases),
    currentAmount: roundCurrency(marketValue), marketValue: roundCurrency(marketValue),
    realizedProfit: roundCurrency(realizedProfit), unrealizedProfit: roundCurrency(unrealizedProfit),
    incomeReceived: roundCurrency(incomeReceived), incomeExpected: roundCurrency(incomeExpected),
    totalProfit: roundCurrency(totalProfit), profitability,
    allocation: 0
  };
}

/**
 * A carteira com posição, preço médio e rentabilidade de cada ativo.
 *
 * Reconstrói tudo a partir das operações e dos proventos, e é chamada em
 * cadeia — pela carga da tela, pelo resumo do patrimônio, pelas metas ligadas
 * a investimento. Mesma memória de curta duração dos saldos: vale até a
 * próxima escrita no banco.
 */
let listCache = { version: -1, value: null };

function list() {
  if (listCache.value && listCache.version === repo.version()) return listCache.value;
  const computed = computeList();
  listCache = { version: repo.version(), value: computed };
  return computed;
}

function computeList() {
  const operations = listOperations();
  const income = listIncome();
  const items = rawList().map(item => calculatePosition(
    item,
    operations.filter(operation => operation.investmentId === item.id),
    income.filter(row => row.investmentId === item.id)
  ));
  const total = sum(items.filter(item => item.status === 'ATIVO'), 'marketValue');
  return items.map(item => ({ ...item, allocation: total > 0 ? (item.marketValue / total) * 100 : 0 }));
}

function getById(id) {
  const item = repo.findById('investments', id);
  if (!item) throw new Error('Investimento não encontrado.');
  return item;
}

function create(data) {
  required(data, ['type', 'institution']);
  const meta = classMeta(data.type);
  const symbol = String(data.symbol || '').trim();
  if (meta.quoted && !symbol) throw new Error('Informe o código do ativo para buscar a cotação automática.');
  const item = {
    id: generateId('investment'),
    name: String(data.name || symbol || meta.label).trim(),
    type: data.type,
    assetClass: data.type,
    symbol: meta.market === 'BR' ? symbol.toUpperCase() : symbol,
    providerId: String(data.providerId || '').trim(),
    institution: String(data.institution).trim(),
    currentAmount: roundCurrency(data.currentAmount || 0),
    goalAmount: roundCurrency(data.goalAmount),
    quantity: 0,
    averagePrice: 0,
    currentPrice: roundCurrency(data.currentPrice || data.initialPrice || 0),
    exchangeRate: roundCurrency(data.exchangeRate || 1),
    currency: data.currency || (meta.market === 'US' ? 'USD' : 'BRL'),
    market: data.market || meta.market,
    benchmark: data.benchmark || '',
    annualRate: toNumber(data.annualRate),
    maturityDate: data.maturityDate ? dateOnly(data.maturityDate) : '',
    purchaseDate: data.purchaseDate ? dateOnly(data.purchaseDate) : dateOnly(now()),
    autoQuote: data.autoQuote === 'false' || data.autoQuote === false ? 0 : 1,
    status: data.status || 'ATIVO',
    notes: data.notes || '',
    createdAt: now(),
    updatedAt: now()
  };
  if (item.currentAmount < 0 || item.goalAmount < 0) throw new Error('Os valores do investimento não podem ser negativos.');
  repo.transaction(() => {
    repo.insert('investments', item);
    if (toNumber(data.initialQuantity) > 0 && toNumber(data.initialPrice) > 0) {
      createOperationCore({
        investmentId: item.id, operationType: 'COMPRA', quantity: data.initialQuantity,
        unitPrice: data.initialPrice, fees: data.initialFees || 0,
        date: data.purchaseDate || dateOnly(now()), bankAccountId: data.bankAccountId || '',
        institution: item.institution, description: 'Posição inicial'
      });
    } else if (!meta.quoted && toNumber(data.currentAmount) > 0) {
      createOperationCore({
        investmentId: item.id, operationType: 'APORTE', quantity: 1,
        unitPrice: data.currentAmount, fees: 0, date: data.purchaseDate || dateOnly(now()),
        bankAccountId: data.bankAccountId || '', institution: item.institution, description: 'Aplicação inicial'
      });
    }
    logActivity('INVESTMENT_CREATED', `Investimento ${item.name} cadastrado`, 'investment', item.id);
  });
  return item;
}

function update(id, data) {
  const current = getById(id);
  const merged = { ...current, ...data };
  return repo.update('investments', id, {
    ...data,
    assetClass: data.type || current.assetClass || current.type,
    symbol: String(data.symbol ?? current.symbol ?? '').trim(),
    providerId: String(data.providerId ?? current.providerId ?? '').trim(),
    currentAmount: roundCurrency(merged.currentAmount),
    goalAmount: roundCurrency(merged.goalAmount),
    annualRate: toNumber(merged.annualRate),
    exchangeRate: toNumber(merged.exchangeRate) || 1,
    maturityDate: merged.maturityDate ? dateOnly(merged.maturityDate) : '',
    autoQuote: merged.autoQuote === 'false' || merged.autoQuote === false ? 0 : 1
  });
}

function recalculateInvestment(id) {
  const item = getById(id);
  const position = calculatePosition(item, listOperations({ investmentId: id }), listIncome({ investmentId: id }));
  repo.update('investments', id, {
    quantity: position.quantity,
    averagePrice: position.averagePrice,
    currentAmount: position.marketValue
  });
  return position;
}

function createOperationCore(data) {
  required(data, ['investmentId', 'operationType', 'date']);
  const investment = getById(data.investmentId);
  if (investment.status !== 'ATIVO') throw new Error('O investimento selecionado está inativo.');
  const operationType = String(data.operationType).toUpperCase();
  const allowed = ['COMPRA', 'VENDA', 'APORTE', 'RESGATE', 'BONIFICACAO', 'DESDOBRAMENTO'];
  if (!allowed.includes(operationType)) throw new Error('Tipo de operação inválido.');

  const quantity = roundQuantity(data.quantity);
  const unitPrice = roundCurrency(data.unitPrice);
  const exchangeRate = Math.max(0.000001, toNumber(data.exchangeRate) || toNumber(investment.exchangeRate) || 1);
  const fees = roundCurrency(Math.abs(toNumber(data.fees)));
  if (!(quantity > 0)) throw new Error('Informe uma quantidade maior que zero.');
  if (!['BONIFICACAO', 'DESDOBRAMENTO'].includes(operationType) && !(unitPrice > 0)) {
    throw new Error('Informe o preço unitário da operação.');
  }
  const isOutflow = ['COMPRA', 'APORTE'].includes(operationType);
  const isFinancial = !['BONIFICACAO', 'DESDOBRAMENTO'].includes(operationType);
  const grossAmount = quantity * unitPrice * exchangeRate;
  const totalAmount = isFinancial
    ? roundCurrency(isOutflow ? grossAmount + fees : Math.max(0, grossAmount - fees))
    : 0;
  let contributionId = '';
  const bankAccountId = data.bankAccountId || '';
  if (bankAccountId && isFinancial) {
    const account = accounts.getById(bankAccountId);
    if (account.status !== 'ATIVA') throw new Error('A conta selecionada está inativa.');
    contributionId = generateId('contribution');
    repo.insert('investment_contributions', {
      id: contributionId,
      investmentId: investment.id,
      bankAccountId,
      amount: isOutflow ? totalAmount : -totalAmount,
      date: dateOnly(data.date),
      description: data.description || `${operationType} · ${investment.symbol || investment.name}`,
      notes: data.notes || '',
      createdAt: now(), updatedAt: now()
    });
  }
  const item = {
    id: generateId('investment-operation'), investmentId: investment.id, contributionId,
    operationType, quantity, unitPrice, exchangeRate, fees, totalAmount,
    date: dateOnly(data.date), bankAccountId, institution: data.institution || investment.institution || '',
    description: data.description || '', notes: data.notes || '', createdAt: now(), updatedAt: now()
  };
  repo.insert('investment_operations', item);
  recalculateInvestment(investment.id);
  if (bankAccountId) accounts.syncBalances();
  syncLinkedGoals();
  return item;
}

function createOperation(data) {
  return repo.transaction(() => {
    const item = createOperationCore(data);
    const investment = getById(item.investmentId);
    logActivity(
      'INVESTMENT_OPERATION_CREATED',
      `${item.operationType} de ${item.quantity} ${investment.symbol || investment.name}`,
      'investmentOperation', item.id
    );
    return item;
  });
}

function deleteOperation(id) {
  return repo.transaction(() => {
    const item = repo.findById('investment_operations', id);
    if (!item) throw new Error('Operação não encontrada.');
    if (item.contributionId) repo.remove('investment_contributions', item.contributionId);
    repo.remove('investment_operations', id);
    recalculateInvestment(item.investmentId);
    if (item.bankAccountId) accounts.syncBalances();
    syncLinkedGoals();
    return true;
  });
}

function portfolioSummary() {
  const assets = list().filter(item => item.status === 'ATIVO');
  const income = listIncome();
  const marketValue = sum(assets, 'marketValue');
  const investedAmount = sum(assets, 'costBasis');
  const incomeReceived = sum(income.filter(row => row.status !== 'PREVISTO'), 'totalAmount');
  const realizedProfit = sum(assets, 'realizedProfit');
  const totalProfit = marketValue - investedAmount + realizedProfit + incomeReceived;
  const allocations = Object.values(assets.reduce((groups, item) => {
    const key = item.assetClass || item.type;
    if (!groups[key]) groups[key] = { type: key, label: item.classLabel, value: 0, count: 0 };
    groups[key].value += item.marketValue;
    groups[key].count++;
    return groups;
  }, {})).map(group => ({
    ...group, value: roundCurrency(group.value), percent: marketValue > 0 ? (group.value / marketValue) * 100 : 0
  })).sort((a, b) => b.value - a.value);
  const snapshots = repo.all('investment_snapshots', 'reference_date ASC');
  return {
    marketValue: roundCurrency(marketValue), investedAmount: roundCurrency(investedAmount),
    totalProfit: roundCurrency(totalProfit), profitability: investedAmount > 0 ? (totalProfit / investedAmount) * 100 : 0,
    incomeReceived: roundCurrency(incomeReceived), realizedProfit: roundCurrency(realizedProfit),
    dayChange: marketValue > 0 ? assets.reduce((total, item) => total + item.marketValue * toNumber(item.dayChangePercent), 0) / marketValue : 0,
    assetsCount: assets.length, institutionsCount: new Set(assets.map(item => item.institution).filter(Boolean)).size,
    lastQuoteAt: assets.map(item => item.quoteUpdatedAt).filter(Boolean).sort().at(-1) || '',
    allocations, snapshots
  };
}

function recordSnapshot() {
  const summary = portfolioSummary();
  const referenceDate = dateOnly(now());
  const current = repo.query('SELECT id FROM investment_snapshots WHERE reference_date = ?', [referenceDate])[0];
  const payload = {
    referenceDate, investedAmount: summary.investedAmount, marketValue: summary.marketValue,
    incomeTotal: summary.incomeReceived, updatedAt: now()
  };
  if (current) return repo.update('investment_snapshots', current.id, payload);
  return repo.insert('investment_snapshots', { id: generateId('investment-snapshot'), ...payload, createdAt: now() });
}

async function refreshMarketData() {
  const market = require('./market');
  const quotes = await market.refreshQuotes();
  const income = await market.syncIncome();
  for (const item of rawList()) recalculateInvestment(item.id);
  recordSnapshot();
  return { ...quotes, income };
}

function marketStatus() {
  return require('./market').status();
}

function toggleStatus(id) {
  const item = getById(id);
  return repo.update('investments', id, { status: item.status === 'ATIVO' ? 'INATIVO' : 'ATIVO' });
}

function remove(id) {
  const item = getById(id);
  const contributions = repo.count('investment_contributions', 'investment_id = ?', [id]);
  const operations = repo.count('investment_operations', 'investment_id = ?', [id]);
  if (contributions > 0 || operations > 0) {
    throw new Error(`${item.name} tem histórico financeiro. Inative em vez de excluir para preservar os cálculos.`);
  }
  return repo.remove('investments', id);
}

// ---------------------------------------------------------------------------
// Aportes
//
// Um aporte move dinheiro da conta bancária para o investimento: reduz o saldo
// da conta e aumenta o valor investido. Não é uma "despesa" — por isso não
// aparece como saída na lista de lançamentos, só no fluxo do dashboard.
// ---------------------------------------------------------------------------

function listContributions(filters = {}) {
  const items = repo.all('investment_contributions', 'date DESC, created_at DESC');
  if (!filters.year) return items;
  return items.filter(item => {
    const [year, month] = String(item.date).split('-');
    if (String(year) !== String(filters.year)) return false;
    if (filters.month && filters.month !== 'all' && Number(month) !== Number(filters.month)) return false;
    return true;
  });
}

function createContribution(data) {
  return repo.transaction(() => {
    required(data, ['investmentId', 'bankAccountId', 'amount', 'date']);
    const investment = getById(data.investmentId);
    const account = accounts.getById(data.bankAccountId);
    if (investment.status !== 'ATIVO') throw new Error('O investimento selecionado está inativo.');
    if (account.status !== 'ATIVA') throw new Error('A conta selecionada está inativa.');

    // Valor negativo é resgate: o dinheiro volta do investimento para a conta.
    // O cálculo de saldo já subtrai a soma dos aportes, então um aporte
    // negativo credita a conta e reduz o investimento, exatamente como deve.
    const amount = roundCurrency(data.amount);
    if (amount === 0) throw new Error('Informe um valor diferente de zero.');

    const item = {
      id: generateId('contribution'),
      investmentId: data.investmentId,
      bankAccountId: data.bankAccountId,
      amount,
      date: dateOnly(data.date),
      description: data.description || (roundCurrency(data.amount) > 0 ? 'Aporte' : 'Resgate'),
      notes: data.notes || '',
      createdAt: now(),
      updatedAt: now()
    };
    repo.insert('investment_contributions', item);
    repo.update('investments', investment.id, {
      currentAmount: roundCurrency(Math.max(0, toNumber(investment.currentAmount) + amount))
    });
    logActivity(
      amount > 0 ? 'INVESTMENT_CONTRIBUTION_CREATED' : 'INVESTMENT_WITHDRAWAL',
      `${amount > 0 ? 'Aporte' : 'Resgate'} de ${formatBRL(Math.abs(amount))} ${amount > 0 ? 'em' : 'de'} ${investment.name}`,
      'investmentContribution', item.id
    );
    accounts.syncBalances();
    syncLinkedGoals();
    return item;
  });
}

function deleteContribution(id) {
  return repo.transaction(() => {
    const contribution = repo.findById('investment_contributions', id);
    if (!contribution) throw new Error('Aporte não encontrado.');
    const investment = repo.findById('investments', contribution.investmentId);
    if (investment) {
      repo.update('investments', investment.id, {
        currentAmount: roundCurrency(Math.max(0, toNumber(investment.currentAmount) - toNumber(contribution.amount)))
      });
    }
    repo.remove('investment_contributions', id);
    accounts.syncBalances();
    syncLinkedGoals();
    return true;
  });
}

/** Média de aporte dos últimos N meses — base das projeções. */
function averageMonthlyContribution(months = 6) {
  const contributions = repo.all('investment_contributions');
  let total = 0;
  for (let index = 1; index <= months; index++) {
    const reference = monthKey(addMonths(now().slice(0, 10), -index));
    total += sum(contributions.filter(item => monthKey(item.date) === reference), 'amount');
  }
  return months ? roundCurrency(total / months) : 0;
}

/**
 * Metas que espelham um investimento têm o status revisto quando o saldo dele
 * muda. O resto da vida das metas mora em goals.js.
 */
function syncLinkedGoals() {
  const goals = require('./goals');
  for (const goal of goals.listGoals()) {
    if (!goal.investmentId) continue;
    const shouldBe = goals.resolveGoalStatus(goal.savedAmount, goal.targetAmount, goal.status);
    if (goal.status !== shouldBe) goals.syncGoal(goal.id);
  }
}

module.exports = {
  ASSET_CLASSES,
  list,
  getById,
  create,
  update,
  toggleStatus,
  remove,
  listOperations,
  createOperation,
  deleteOperation,
  listIncome,
  portfolioSummary,
  recordSnapshot,
  refreshMarketData,
  marketStatus,
  listContributions,
  createContribution,
  deleteContribution,
  averageMonthlyContribution
};
