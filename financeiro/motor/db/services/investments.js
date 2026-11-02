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
// Preço unitário e câmbio não são dinheiro: cripto, frações e ativos baratos
// precisam das casas decimais. O arredondamento em centavos fica só nos totais.
const roundPrice = value => Math.round(toNumber(value) * 100000000) / 100000000;
const roundRate = value => Math.round(toNumber(value) * 1000000) / 1000000;

// Tipos de operação. Entrada/saída de dinheiro da posição, eventos sem dinheiro
// e eventos que ainda não têm tratamento próprio (precisam de registro manual
// em partes, para não criar ganho que não existiu).
const OPERATION_TYPES = ['COMPRA', 'VENDA', 'APORTE', 'RESGATE', 'AMORTIZACAO', 'BONIFICACAO', 'DESDOBRAMENTO', 'GRUPAMENTO'];
const BUY_TYPES = ['COMPRA', 'APORTE'];
const SELL_TYPES = ['VENDA', 'RESGATE'];
const CASH_IN_TYPES = [...SELL_TYPES, 'AMORTIZACAO'];
const NO_CASH_TYPES = ['BONIFICACAO', 'DESDOBRAMENTO', 'GRUPAMENTO'];
const UNSUPPORTED_EVENTS = {
  INCORPORACAO: 'incorporação', CISAO: 'cisão', CONVERSAO: 'conversão de classe', SUBSCRICAO: 'subscrição',
  DIREITO: 'direito de subscrição', FUSAO: 'fusão', TROCA: 'troca de ativos'
};
// De onde vem o dinheiro de uma compra (ou para onde vai o de uma venda):
// EXTERNO = de fora da carteira (conta, salário…); CAIXA = do saldo parado na
// própria carteira (venda anterior, provento que ficou na corretora).
const CASH_SOURCES = ['EXTERNO', 'CAIXA'];
const DUPLICATE_WINDOW_MS = 120000;

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
    const sign = CASH_IN_TYPES.includes(operation.operationType) ? -1 : 1;
    if (![...BUY_TYPES, ...CASH_IN_TYPES].includes(operation.operationType)) continue;
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
  let amortized = 0;
  let fees = 0;

  for (const operation of [...operations].sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.createdAt).localeCompare(String(b.createdAt)))) {
    const type = operation.operationType;
    const qty = Math.abs(toNumber(operation.quantity));
    const fee = Math.abs(toNumber(operation.fees));
    const exchange = Math.max(0.000001, toNumber(operation.exchangeRate) || 1);
    const gross = qty * toNumber(operation.unitPrice) * exchange;
    const cashIn = CASH_IN_TYPES.includes(type);
    const total = Math.abs(toNumber(operation.totalAmount)) || (cashIn ? Math.max(0, gross - fee) : gross + fee);
    if (!NO_CASH_TYPES.includes(type)) fees += fee;
    if (BUY_TYPES.includes(type)) {
      quantity += qty;
      costBasis += total;
      grossPurchases += total;
    } else if (['BONIFICACAO', 'DESDOBRAMENTO'].includes(type)) {
      // Mais cotas pelo mesmo custo total: o preço médio cai, nenhum ganho aparece.
      quantity += qty;
    } else if (type === 'GRUPAMENTO') {
      // Menos cotas pelo mesmo custo total (quantity = cotas que deixaram de existir).
      quantity = Math.max(0, quantity - qty);
    } else if (type === 'AMORTIZACAO') {
      // Devolução de capital: abate do custo; só o que passar do custo é ganho.
      const removed = Math.min(costBasis, total);
      costBasis -= removed;
      amortized += total;
      realizedProfit += total - removed;
    } else if (SELL_TYPES.includes(type)) {
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
  const price = toNumber(item.currentPrice);
  // Como a posição foi avaliada. O relatório mostra isso: preço de mercado com
  // data, preço digitado, só o custo ou o saldo informado — nunca um zero.
  let valuation;
  let marketValue;
  if (quoted && quantity > 0 && price > 0) {
    marketValue = quantity * price * exchangeRate;
    valuation = item.quoteSource === 'Operação' ? 'preco_operacao'
      : item.quoteUpdatedAt && item.quoteSource && item.quoteSource !== 'Informado' ? 'cotacao' : 'preco_informado';
  } else if (quoted && hasOperations) {
    marketValue = quantity > 0 ? costBasis : 0;
    valuation = quantity > 0 ? 'custo' : 'zerada';
  } else if (!quoted && item.quoteSource === 'Informado' && price > 0) {
    // Valor que a pessoa leu no app do banco, na data informada; o que entrou
    // ou saiu depois dessa data é somado/abatido pelo valor da operação.
    const since = dateOnly(item.quoteUpdatedAt || '');
    const after = operations.filter(op => since && dateOnly(op.date) > since);
    marketValue = price + after.reduce((total, op) => {
      const value = Math.abs(toNumber(op.totalAmount));
      if (BUY_TYPES.includes(op.operationType)) return total + value;
      if (CASH_IN_TYPES.includes(op.operationType)) return total - value;
      return total;
    }, 0);
    marketValue = Math.max(0, marketValue);
    valuation = after.length ? 'informado_ajustado' : 'informado';
  } else if (!quoted && hasOperations) {
    marketValue = contractualValue(operations, item.annualRate) || costBasis;
    valuation = toNumber(item.annualRate) > 0 ? 'contrato' : 'custo';
  } else {
    marketValue = toNumber(item.currentAmount);
    valuation = 'saldo_informado';
  }

  const incomeReceived = sum(incomeRows.filter(row => row.status !== 'PREVISTO'), 'totalAmount');
  const incomeExpected = sum(incomeRows.filter(row => row.status === 'PREVISTO'), 'totalAmount');
  const unrealizedProfit = marketValue - costBasis;
  const totalProfit = unrealizedProfit + realizedProfit + incomeReceived;
  const profitability = costBasis > 0 ? (totalProfit / costBasis) * 100 : 0;

  return {
    ...item,
    type, assetClass: type, classLabel: classMeta(type).label,
    quoted, hasOperations, quantity: roundQuantity(quantity), valuation,
    // O consolidado é sempre em reais; para ativos externos o custo já inclui
    // o câmbio histórico informado em cada operação.
    averagePrice: quantity > 0 ? roundPrice(costBasis / quantity) : 0,
    costBasis: roundCurrency(costBasis), grossPurchases: roundCurrency(grossPurchases),
    currentAmount: roundCurrency(marketValue), marketValue: roundCurrency(marketValue),
    realizedProfit: roundCurrency(realizedProfit), unrealizedProfit: roundCurrency(unrealizedProfit),
    amortized: roundCurrency(amortized), fees: roundCurrency(fees),
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
    currentPrice: roundPrice(data.currentPrice || data.initialPrice || 0),
    exchangeRate: roundRate(data.exchangeRate || 1),
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
    currentPrice: roundPrice(merged.currentPrice),
    exchangeRate: roundRate(merged.exchangeRate) || 1,
    maturityDate: merged.maturityDate ? dateOnly(merged.maturityDate) : '',
    autoQuote: merged.autoQuote === 'false' || merged.autoQuote === false ? 0 : 1
  });
}

function recalculateInvestment(id) {
  const item = getById(id);
  const position = calculatePosition(item, listOperations({ investmentId: id }), listIncome({ investmentId: id }));
  // Sem operações, current_amount é o próprio registro do saldo aplicado (o
  // custo): uma avaliação informada não pode sobrescrevê-lo.
  repo.update('investments', id, position.hasOperations ? {
    quantity: position.quantity,
    averagePrice: position.averagePrice,
    currentAmount: position.marketValue
  } : { averagePrice: position.averagePrice });
  return position;
}

/**
 * Caixa da carteira: dinheiro que ficou dentro dela (vendas, amortizações e
 * proventos marcados como CAIXA) menos o que foi usado dela em compras.
 * Não é saldo bancário — o banco já conta o que saiu para ele.
 */
function cashBalance(operations = listOperations(), income = listIncome()) {
  let cash = 0;
  for (const op of operations) {
    if ((op.cashSource || 'EXTERNO') !== 'CAIXA') continue;
    const value = Math.abs(toNumber(op.totalAmount));
    if (BUY_TYPES.includes(op.operationType)) cash -= value;
    else if (CASH_IN_TYPES.includes(op.operationType)) cash += value;
  }
  for (const row of income) {
    if (row.status !== 'PREVISTO' && (row.destination || 'EXTERNO') === 'CAIXA') cash += toNumber(row.totalAmount);
  }
  return roundCurrency(cash);
}

function operationKey(data) {
  return String(data.externalKey || data.chave || '').trim().slice(0, 160);
}

/** Operação igual já gravada: pela chave, ou idêntica e gravada há instantes (repetição de voz/Telegram). */
function findDuplicate(data, operationType, quantity, unitPrice) {
  const key = operationKey(data);
  if (key) {
    const found = repo.query('SELECT * FROM investment_operations WHERE external_key = ?', [key])[0];
    return found ? repo.findById('investment_operations', found.id) : null;
  }
  const since = new Date(Date.now() - DUPLICATE_WINDOW_MS).toISOString();
  const rows = repo.query(
    `SELECT id FROM investment_operations WHERE investment_id = ? AND operation_type = ? AND date = ?
       AND ABS(quantity - ?) < 0.000000001 AND ABS(unit_price - ?) < 0.000000001 AND created_at >= ?`,
    [data.investmentId, operationType, dateOnly(data.date), quantity, unitPrice, since]
  );
  return rows[0] ? repo.findById('investment_operations', rows[0].id) : null;
}

function createOperationCore(data) {
  required(data, ['investmentId', 'operationType', 'date']);
  const investment = getById(data.investmentId);
  if (investment.status !== 'ATIVO') throw new Error('O investimento selecionado está inativo.');
  const operationType = String(data.operationType).toUpperCase();
  if (UNSUPPORTED_EVENTS[operationType]) {
    throw new Error(`A carteira ainda não calcula ${UNSUPPORTED_EVENTS[operationType]} sozinha. Registre em partes (venda/compra ou bonificação) conforme o informe da empresa, para não criar ganho que não existiu.`);
  }
  if (!OPERATION_TYPES.includes(operationType)) throw new Error('Tipo de operação inválido.');

  const quantity = roundQuantity(data.quantity);
  const unitPrice = roundPrice(data.unitPrice);
  const exchangeRate = Math.max(0.000001, roundRate(data.exchangeRate) || toNumber(investment.exchangeRate) || 1);
  const fees = roundCurrency(Math.abs(toNumber(data.fees)));
  const isFinancial = !NO_CASH_TYPES.includes(operationType);
  if (operationType === 'AMORTIZACAO') {
    if (!(toNumber(data.totalAmount) > 0 || (quantity > 0 && unitPrice > 0))) throw new Error('Informe o valor recebido na amortização.');
  } else {
    if (!(quantity > 0)) throw new Error('Informe uma quantidade maior que zero.');
    if (isFinancial && !(unitPrice > 0)) throw new Error('Informe o preço unitário da operação.');
  }
  const cashSource = String(data.cashSource || 'EXTERNO').toUpperCase();
  if (!CASH_SOURCES.includes(cashSource)) throw new Error('Origem do dinheiro inválida (EXTERNO ou CAIXA).');
  const bankAccountId = cashSource === 'CAIXA' ? '' : (data.bankAccountId || '');
  if (cashSource === 'CAIXA' && data.bankAccountId) {
    throw new Error('Com o dinheiro do caixa da carteira, não informe conta bancária: o banco não é movimentado.');
  }

  const isOutflow = BUY_TYPES.includes(operationType);
  const grossAmount = quantity * unitPrice * exchangeRate;
  const totalAmount = !isFinancial ? 0
    : operationType === 'AMORTIZACAO' && toNumber(data.totalAmount) > 0 ? roundCurrency(data.totalAmount)
    : roundCurrency(isOutflow ? grossAmount + fees : Math.max(0, grossAmount - fees));
  if (cashSource === 'CAIXA' && isOutflow) {
    const cash = cashBalance();
    if (totalAmount - cash > 0.005) {
      throw new Error(`O caixa da carteira tem ${formatBRL(cash)}; a compra custa ${formatBRL(totalAmount)}. Registre a diferença como dinheiro de fora (EXTERNO).`);
    }
  }
  let contributionId = '';
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
    cashSource: isFinancial ? cashSource : 'EXTERNO', externalKey: operationKey(data),
    description: data.description || '', notes: data.notes || '', createdAt: now(), updatedAt: now()
  };
  repo.insert('investment_operations', item);
  // Sem cotação mais nova que a operação, o preço negociado é o último preço
  // conhecido do ativo (com a data): evita avaliar pelo preço digitado antigo e
  // mostrar ganho/prejuízo que não existiu.
  const quoted = classMeta(investment.assetClass || investment.type).quoted;
  if (quoted && [...BUY_TYPES, ...SELL_TYPES].includes(operationType) && unitPrice > 0
      && (!investment.quoteUpdatedAt || dateOnly(item.date) >= dateOnly(investment.quoteUpdatedAt))) {
    repo.update('investments', investment.id, { currentPrice: unitPrice, exchangeRate, quoteSource: 'Operação', quoteUpdatedAt: item.date });
  }
  recalculateInvestment(investment.id);
  if (bankAccountId) accounts.syncBalances();
  syncLinkedGoals();
  return item;
}

function createOperation(data) {
  return repo.transaction(() => {
    const operationType = String(data.operationType || '').toUpperCase();
    const existing = findDuplicate(data, operationType, roundQuantity(data.quantity), roundPrice(data.unitPrice));
    if (existing) return { ...existing, duplicate: true };
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

/**
 * Provento registrado à mão (o automático vem de market.syncIncome).
 * RECEBIDO entra no resultado; PREVISTO só aparece como "a receber".
 * destination CAIXA = ficou na carteira (pode ser reinvestido sem virar aporte).
 */
function createIncome(data) {
  return repo.transaction(() => {
    required(data, ['investmentId', 'paymentDate']);
    const investment = getById(data.investmentId);
    const quantity = roundQuantity(data.quantity);
    const valuePerUnit = roundPrice(data.valuePerUnit);
    const totalAmount = roundCurrency(toNumber(data.totalAmount) || quantity * valuePerUnit);
    if (!(totalAmount > 0)) throw new Error('Informe o valor do provento.');
    const status = String(data.status || 'RECEBIDO').toUpperCase();
    if (!['RECEBIDO', 'PREVISTO'].includes(status)) throw new Error('Situação do provento inválida (RECEBIDO ou PREVISTO).');
    const destination = String(data.destination || 'EXTERNO').toUpperCase();
    if (!CASH_SOURCES.includes(destination)) throw new Error('Destino do provento inválido (EXTERNO ou CAIXA).');
    const paymentDate = dateOnly(data.paymentDate);
    const given = operationKey(data);
    if (given) {
      const found = repo.query('SELECT id FROM investment_income WHERE investment_id = ? AND external_key = ?', [investment.id, given])[0];
      if (found) return { ...repo.findById('investment_income', found.id), duplicate: true };
    } else {
      const since = new Date(Date.now() - DUPLICATE_WINDOW_MS).toISOString();
      const found = repo.query(
        'SELECT id FROM investment_income WHERE investment_id = ? AND payment_date = ? AND ABS(total_amount - ?) < 0.005 AND created_at >= ?',
        [investment.id, paymentDate, totalAmount, since]
      )[0];
      if (found) return { ...repo.findById('investment_income', found.id), duplicate: true };
    }
    const id = generateId('income-investment');
    const item = {
      id, investmentId: investment.id,
      incomeType: String(data.incomeType || 'DIVIDENDO').toUpperCase(),
      exDate: data.exDate ? dateOnly(data.exDate) : '', paymentDate, valuePerUnit, quantity, totalAmount,
      status, destination, source: 'manual', externalKey: given || `manual|${id}`,
      notes: data.notes || '', createdAt: now(), updatedAt: now()
    };
    repo.insert('investment_income', item);
    logActivity('INVESTMENT_INCOME_CREATED', `Provento de ${formatBRL(totalAmount)} de ${investment.symbol || investment.name}`, 'investmentIncome', id);
    return item;
  });
}

function deleteIncome(id) {
  const item = repo.findById('investment_income', id);
  if (!item) throw new Error('Provento não encontrado.');
  repo.remove('investment_income', id);
  return true;
}

/** Marca um provento previsto como recebido (e onde o dinheiro ficou). */
function confirmIncome(id, data = {}) {
  const item = repo.findById('investment_income', id);
  if (!item) throw new Error('Provento não encontrado.');
  const destination = String(data.destination || item.destination || 'EXTERNO').toUpperCase();
  if (!CASH_SOURCES.includes(destination)) throw new Error('Destino do provento inválido (EXTERNO ou CAIXA).');
  return repo.update('investment_income', id, {
    status: 'RECEBIDO', destination,
    totalAmount: toNumber(data.totalAmount) > 0 ? roundCurrency(data.totalAmount) : item.totalAmount
  });
}

/**
 * Valor de um investimento sem cotação pública (CDB, previdência, fundo…)
 * lido pela pessoa no app do banco, numa data. Vira a avaliação da posição.
 */
function setValuation(id, data = {}) {
  const item = getById(id);
  if (classMeta(item.assetClass || item.type).quoted) {
    throw new Error('Este ativo tem cotação pública; atualize pela cotação ou informe o preço unitário em currentPrice.');
  }
  const value = roundCurrency(data.value ?? data.valor);
  if (!(value >= 0)) throw new Error('Informe o valor atual do investimento.');
  const date = dateOnly(data.date || now());
  repo.update('investments', id, { currentPrice: value, quoteSource: 'Informado', quoteUpdatedAt: date });
  return recalculateInvestment(id);
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
  // A foto guarda também o caixa, o total líquido que entrou de fora até o dia e
  // a cobertura das cotações — é o que permite medir rentabilidade entre fotos.
  const report = require('./portfolio').snapshotData();
  const payload = {
    referenceDate, investedAmount: summary.investedAmount, marketValue: summary.marketValue,
    incomeTotal: summary.incomeReceived, cashAmount: report.cash, externalNet: report.externalNet,
    coverage: JSON.stringify(report.coverage), updatedAt: now()
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
  OPERATION_TYPES,
  UNSUPPORTED_EVENTS,
  classMeta,
  cashBalance,
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
  createIncome,
  deleteIncome,
  confirmIncome,
  setValuation,
  portfolioSummary,
  recordSnapshot,
  refreshMarketData,
  marketStatus,
  listContributions,
  createContribution,
  deleteContribution,
  averageMonthlyContribution
};
