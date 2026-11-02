'use strict';

/**
 * Acompanhamento da carteira de investimentos: as contas que o mentor do Jarvis
 * usa, feitas aqui (determinísticas, testáveis), nunca pelo modelo de linguagem.
 *
 * Perímetro: as posições cadastradas + o caixa da carteira (dinheiro de vendas
 * e proventos que ficou nela). Fluxo externo é dinheiro que cruza esse
 * perímetro: compra paga com dinheiro de fora, venda/amortização/provento que
 * sai para a conta. Compra com o caixa, provento reinvestido e transferência
 * entre contas bancárias não são aporte.
 *
 *   resultado = patrimônio atual − entradas externas + saídas externas
 *             = não realizado + realizado + proventos recebidos
 *
 * O relatório diz como cada posição foi avaliada e de quando é o preço, e lista
 * o que falta (lacunas) em vez de preencher com zero ou com estimativa.
 */

const repo = require('../repository');
const investments = require('./investments');
const { generateId, now, toNumber, roundCurrency, dateOnly, sum, addMonths } = require('../utils');

// Grupos da política (as quatro caixas de estudo + reserva, cripto e outros).
const GROUPS = {
  reserva: { label: 'Reserva de emergência', classes: ['RESERVA_EMERGENCIA'] },
  renda_fixa: { label: 'Renda fixa', classes: ['TESOURO_DIRETO', 'CDB', 'LCI_LCA', 'CRI_CRA', 'DEBENTURE', 'RENDA_FIXA', 'POUPANCA'] },
  acoes_br: { label: 'Ações e ETFs Brasil', classes: ['ACAO', 'ETF', 'RENDA_VARIAVEL'] },
  fii_fiagro: { label: 'FIIs e Fiagros', classes: ['FII', 'FIAGRO', 'FUNDO_IMOBILIARIO'] },
  exterior: { label: 'Exterior', classes: ['BDR', 'STOCK', 'REIT', 'ETF_INTERNACIONAL'] },
  cripto: { label: 'Cripto', classes: ['CRIPTO'] },
  outros: { label: 'Outros (fundos, previdência…)', classes: ['FUNDO', 'PREVIDENCIA', 'OUTROS'] }
};
const LIQUIDITY_TO_CHECK = new Set(['PREVIDENCIA', 'CRI_CRA', 'DEBENTURE', 'FUNDO', 'LCI_LCA', 'CDB']);
const STALE_DAYS = { CRIPTO: 1 };
const STALE_DEFAULT = 4; // fim de semana + feriado
const CONCENTRATION_REFERENCE = 20; // % — só referência quando não há limite aprovado

const VALUATION_LABEL = {
  cotacao: 'cotação de mercado', cotacao_antiga: 'cotação antiga', preco_informado: 'preço digitado (sem data de cotação)',
  preco_operacao: 'preço da última operação (não é cotação)',
  custo: 'sem cotação: avaliado pelo custo', zerada: 'posição zerada', informado: 'valor informado por você',
  informado_ajustado: 'valor informado + operações depois dele', contrato: 'estimado pela taxa do contrato',
  saldo_informado: 'saldo informado (sem operações)'
};

function groupOf(type, policy) {
  const override = policy?.classes?.[type];
  if (override && GROUPS[override]) return override;
  return Object.keys(GROUPS).find(key => GROUPS[key].classes.includes(type)) || 'outros';
}

const daysBetween = (from, to) => Math.round((new Date(`${dateOnly(to)}T12:00:00`) - new Date(`${dateOnly(from)}T12:00:00`)) / 86400000);

// ---------------------------------------------------------------------------
// Perfil e política (versões; a mais alta vale)
// ---------------------------------------------------------------------------

const KINDS = { PERFIL: 'PERFIL', POLITICA: 'POLITICA' };

function currentVersion(kind) {
  const row = repo.query(
    'SELECT * FROM investment_profile_versions WHERE kind = ? ORDER BY version DESC LIMIT 1', [kind]
  )[0];
  if (!row) return null;
  let data = {};
  try { data = JSON.parse(row.data || '{}'); } catch { data = {}; }
  return { version: row.version, data, reason: row.reason || '', createdAt: row.created_at };
}

function validatePolicy(data) {
  const metas = data.metas || {};
  for (const [group, pct] of Object.entries(metas)) {
    if (!GROUPS[group] || group === 'reserva') throw new Error(`Grupo desconhecido na política: ${group}. Use: ${Object.keys(GROUPS).filter(g => g !== 'reserva').join(', ')}.`);
    if (!(toNumber(pct) >= 0 && toNumber(pct) <= 100)) throw new Error(`Meta de ${group} fora de 0–100%.`);
  }
  const total = Object.values(metas).reduce((acc, pct) => acc + toNumber(pct), 0);
  if (Object.keys(metas).length && Math.abs(total - 100) > 0.5) {
    throw new Error(`As metas somam ${Math.round(total * 10) / 10}%; precisam somar 100% (a reserva fica fora da conta).`);
  }
  for (const key of ['limite_ativo_pct', 'limite_instituicao_pct', 'limite_cripto_pct']) {
    if (data[key] !== undefined && !(toNumber(data[key]) > 0 && toNumber(data[key]) <= 100)) throw new Error(`${key} precisa estar entre 0 e 100.`);
  }
}

function saveVersion(kind, data = {}, reason = '') {
  if (!KINDS[kind]) throw new Error('Tipo inválido (PERFIL ou POLITICA).');
  const payload = data && typeof data === 'object' ? data : {};
  if (kind === 'PERFIL' && payload.consentimento !== true) {
    throw new Error('Para guardar o perfil, a pessoa precisa autorizar (consentimento: true).');
  }
  if (kind === 'POLITICA') {
    validatePolicy(payload);
    if (payload.aprovada !== true) throw new Error('A política só vale depois que a pessoa aprovar (aprovada: true).');
  }
  return repo.transaction(() => {
    const current = currentVersion(kind);
    const version = (current?.version || 0) + 1;
    repo.insert('investment_profile_versions', {
      id: generateId('investment-profile'), kind, version, data: JSON.stringify(payload),
      reason: String(reason || '').slice(0, 300), createdAt: now(), updatedAt: now()
    });
    return currentVersion(kind);
  });
}

function history(kind) {
  const rows = repo.query(
    `SELECT kind, version, reason, created_at FROM investment_profile_versions ${kind ? 'WHERE kind = ?' : ''} ORDER BY kind, version DESC`,
    kind ? [kind] : []
  );
  return rows.map(row => ({ kind: row.kind, version: row.version, reason: row.reason, createdAt: row.created_at }));
}

const currentProfile = () => currentVersion('PERFIL');
const currentPolicy = () => currentVersion('POLITICA');
const saveProfile = (data, reason) => saveVersion('PERFIL', data, reason);
const savePolicy = (data, reason) => saveVersion('POLITICA', data, reason);

// ---------------------------------------------------------------------------
// Fluxos externos
// ---------------------------------------------------------------------------

/**
 * Cada dinheiro que cruzou o perímetro da carteira, com data.
 * amount > 0 = entrou de fora (aporte); < 0 = saiu (resgate, venda ou provento para a conta).
 * inferred = saldo antigo sem histórico (valor conhecido, data incerta).
 */
function externalFlows(positions, operations, income, contributions) {
  const flows = [];
  const withOps = new Set(positions.filter(p => p.hasOperations).map(p => p.id));
  const nameOf = id => { const p = positions.find(x => x.id === id); return p ? (p.symbol || p.name) : id; };
  for (const op of operations) {
    if ((op.cashSource || 'EXTERNO') !== 'EXTERNO') continue;
    const value = Math.abs(toNumber(op.totalAmount));
    if (!value) continue;
    if (['COMPRA', 'APORTE'].includes(op.operationType)) flows.push({ date: op.date, amount: value, kind: op.operationType, investmentId: op.investmentId, asset: nameOf(op.investmentId) });
    else if (['VENDA', 'RESGATE', 'AMORTIZACAO'].includes(op.operationType)) flows.push({ date: op.date, amount: -value, kind: op.operationType, investmentId: op.investmentId, asset: nameOf(op.investmentId) });
  }
  for (const row of income) {
    if (row.status === 'PREVISTO' || (row.destination || 'EXTERNO') !== 'EXTERNO') continue;
    flows.push({ date: row.paymentDate, amount: -toNumber(row.totalAmount), kind: 'PROVENTO', investmentId: row.investmentId, asset: nameOf(row.investmentId) });
  }
  const linked = new Set(operations.map(op => op.contributionId).filter(Boolean));
  const stray = [];
  for (const position of positions.filter(p => !p.hasOperations)) {
    const mine = contributions.filter(c => c.investmentId === position.id && !linked.has(c.id));
    for (const c of mine) flows.push({ date: c.date, amount: toNumber(c.amount), kind: toNumber(c.amount) > 0 ? 'APORTE' : 'RESGATE', investmentId: position.id, asset: nameOf(position.id) });
    const residual = roundCurrency(toNumber(position.costBasis) - sum(mine, 'amount'));
    if (Math.abs(residual) > 0.005) {
      flows.push({ date: dateOnly(position.purchaseDate || position.createdAt), amount: residual, kind: 'SALDO_SEM_HISTORICO', investmentId: position.id, asset: nameOf(position.id), inferred: true });
    }
  }
  for (const c of contributions) {
    if (!linked.has(c.id) && withOps.has(c.investmentId)) stray.push({ date: c.date, amount: toNumber(c.amount), asset: nameOf(c.investmentId) });
  }
  flows.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return { flows, stray };
}

// ---------------------------------------------------------------------------
// XIRR (taxa interna dos fluxos datados)
// ---------------------------------------------------------------------------

/** cashflows: [{date, amount}] do ponto de vista da pessoa (aporte negativo, valor final positivo). */
function xirr(cashflows) {
  const list = cashflows.filter(f => Math.abs(toNumber(f.amount)) > 0.000001);
  if (list.length < 2 || !list.some(f => f.amount > 0) || !list.some(f => f.amount < 0)) return null;
  const t0 = new Date(`${dateOnly(list[0].date)}T12:00:00`).getTime();
  const years = list.map(f => (new Date(`${dateOnly(f.date)}T12:00:00`).getTime() - t0) / (365 * 86400000));
  const npv = rate => list.reduce((acc, f, i) => acc + f.amount / Math.pow(1 + rate, years[i]), 0);
  // Bissecção num intervalo largo: lenta mas não diverge (Newton se perde com fluxos irregulares).
  let low = -0.9999;
  let high = 100;
  let fLow = npv(low);
  const fHigh = npv(high);
  if (!Number.isFinite(fLow) || !Number.isFinite(fHigh) || fLow * fHigh > 0) return null;
  for (let i = 0; i < 300; i++) {
    const mid = (low + high) / 2;
    const fMid = npv(mid);
    if (Math.abs(fMid) < 1e-9) return mid;
    if (fLow * fMid < 0) high = mid;
    else { low = mid; fLow = fMid; }
  }
  return (low + high) / 2;
}

// ---------------------------------------------------------------------------
// Relatório
// ---------------------------------------------------------------------------

function valuationOf(position, today) {
  if (position.valuation !== 'cotacao') return position.valuation;
  const limit = STALE_DAYS[position.assetClass] ?? STALE_DEFAULT;
  return daysBetween(position.quoteUpdatedAt, today) > limit ? 'cotacao_antiga' : 'cotacao';
}

function snapshotData() {
  const positions = investments.list();
  const operations = investments.listOperations();
  const income = investments.listIncome();
  const cash = investments.cashBalance(operations, income);
  const { flows } = externalFlows(positions, operations, income, investments.listContributions());
  const today = dateOnly(now());
  const coverage = {};
  for (const p of positions) if (toNumber(p.marketValue) > 0) {
    const v = valuationOf(p, today);
    coverage[v] = (coverage[v] || 0) + 1;
  }
  return { cash, externalNet: roundCurrency(sum(flows, 'amount')), coverage, inferred: flows.some(f => f.inferred) };
}

function report(options = {}) {
  const today = dateOnly(options.today || now());
  const policy = currentPolicy();
  const profile = currentProfile();
  const positions = investments.list();
  const operations = investments.listOperations();
  const income = investments.listIncome();
  const contributions = investments.listContributions();
  const cash = investments.cashBalance(operations, income);
  const { flows, stray } = externalFlows(positions, operations, income, contributions);
  const gaps = [];
  const gap = (code, text, items) => gaps.push({ code, text, ...(items ? { items } : {}) });

  const held = positions.filter(p => toNumber(p.marketValue) > 0.004 || toNumber(p.quantity) > 0);
  const assets = held.map(p => {
    const valuation = valuationOf(p, today);
    return {
      id: p.id, name: p.name, symbol: p.symbol || '', type: p.assetClass, classLabel: p.classLabel,
      group: groupOf(p.assetClass, policy?.data), institution: p.institution || '', status: p.status,
      currency: p.currency || 'BRL', quantity: p.quantity, averagePrice: p.averagePrice,
      price: toNumber(p.currentPrice) || null, exchangeRate: toNumber(p.exchangeRate) || 1,
      priceAt: p.quoteUpdatedAt || '', priceSource: p.quoteSource || '', valuation, valuationLabel: VALUATION_LABEL[valuation] || valuation,
      marketValue: p.marketValue, costBasis: p.costBasis, unrealized: p.unrealizedProfit, realized: p.realizedProfit,
      income: p.incomeReceived, incomeExpected: p.incomeExpected, maturityDate: p.maturityDate || ''
    };
  }).sort((a, b) => b.marketValue - a.marketValue);
  const closedRealized = positions.filter(p => !held.includes(p));

  const marketValue = roundCurrency(sum(assets, 'marketValue'));
  const equity = roundCurrency(marketValue + cash);
  const inflows = roundCurrency(sum(flows.filter(f => f.amount > 0), 'amount'));
  const outflows = roundCurrency(-sum(flows.filter(f => f.amount < 0), 'amount'));
  const netExternal = roundCurrency(inflows - outflows);
  const unrealized = roundCurrency(sum(positions, 'unrealizedProfit'));
  const realized = roundCurrency(sum(positions, 'realizedProfit'));
  const incomeReceived = roundCurrency(sum(income.filter(r => r.status !== 'PREVISTO'), 'totalAmount'));
  const result = roundCurrency(equity - netExternal);
  const fees = roundCurrency(sum(positions, 'fees'));

  // Janelas de fluxo e de proventos
  const monthStart = `${today.slice(0, 7)}-01`;
  const yearStart = `${today.slice(0, 4)}-01-01`;
  const last12 = addMonths(today, -12);
  const flowSum = from => roundCurrency(sum(flows.filter(f => f.date >= from && f.date <= today && !f.inferred), 'amount'));
  const received = income.filter(r => r.status !== 'PREVISTO');
  const incomeSum = from => roundCurrency(sum(received.filter(r => r.paymentDate >= from && r.paymentDate <= today), 'totalAmount'));
  const expected = income.filter(r => r.status === 'PREVISTO' && r.paymentDate >= today);
  const overdue = income.filter(r => r.status === 'PREVISTO' && r.paymentDate < today);
  const reinvestable = roundCurrency(sum(received.filter(r => r.destination === 'CAIXA'), 'totalAmount'));

  // Rentabilidade pelos fluxos datados (MWR / XIRR)
  let mwr = { method: 'XIRR (taxa interna dos aportes e retiradas datados)', value: null, annualized: null, periodDays: 0, reason: '' };
  const inferred = flows.filter(f => f.inferred);
  const unpriced = assets.filter(a => ['custo', 'preco_informado', 'preco_operacao', 'saldo_informado'].includes(a.valuation));
  if (!flows.length) mwr.reason = 'Ainda não há aportes registrados.';
  else if (inferred.length) mwr.reason = `${inferred.length} posição(ões) têm saldo sem histórico de datas; sem as datas dos aportes, a taxa seria inventada.`;
  else {
    const cashflows = [...flows.map(f => ({ date: f.date, amount: -f.amount })), { date: today, amount: equity }];
    const rate = xirr(cashflows);
    const span = daysBetween(flows[0].date, today);
    mwr.periodDays = span;
    const unpricedValue = sum(unpriced, 'marketValue');
    if (rate === null) mwr.reason = 'Os fluxos não permitem calcular uma taxa (sem entrada e saída de sinais opostos).';
    else if (span < 30) mwr.reason = 'Menos de 30 dias de histórico: taxa ainda sem significado.';
    else if (marketValue > 0 && unpricedValue / marketValue >= 0.5) mwr.reason = 'A maior parte da carteira não tem cotação de mercado: a taxa só repetiria os preços de compra. Atualize as cotações.';
    else {
      mwr.value = Math.pow(1 + rate, span / 365) - 1; // no período inteiro
      mwr.annualized = span >= 365 ? rate : null;
      if (unpriced.length) mwr.caveat = `${unpriced.length} posição(ões) sem cotação atual entram pelo custo ou preço digitado.`;
    }
  }

  // Rentabilidade entre fotos do patrimônio (aproximação do TWR)
  const snapshots = repo.all('investment_snapshots', 'reference_date ASC')
    .map(s => ({ date: s.referenceDate, marketValue: toNumber(s.marketValue), cash: toNumber(s.cashAmount), externalNet: s.externalNet === '' || s.externalNet === null ? null : toNumber(s.externalNet), coverage: s.coverage || '' }));
  const usable = snapshots.filter(s => s.externalNet !== null);
  const twrPoints = [...usable];
  if (!inferred.length && (!twrPoints.length || twrPoints.at(-1).date !== today)) twrPoints.push({ date: today, marketValue, cash, externalNet: netExternal });
  let twr = { method: 'Elos entre fotos do patrimônio, com os aportes de cada elo no fim dele (aproximação do TWR, não o TWR diário)', value: null, from: '', links: 0, reason: '' };
  if (inferred.length) twr.reason = 'Há saldo sem histórico de datas.';
  else if (twrPoints.length < 2) twr.reason = 'Precisa de pelo menos duas fotos do patrimônio (uma por atualização de cotações).';
  else {
    let factor = 1;
    let links = 0;
    for (let i = 1; i < twrPoints.length; i++) {
      const v0 = twrPoints[i - 1].marketValue + twrPoints[i - 1].cash;
      const v1 = twrPoints[i].marketValue + twrPoints[i].cash;
      const flow = twrPoints[i].externalNet - twrPoints[i - 1].externalNet;
      if (v0 <= 0) continue;
      factor *= (v1 - flow) / v0;
      links++;
    }
    if (links) { twr.value = factor - 1; twr.from = twrPoints[0].date; twr.links = links; }
    else twr.reason = 'As fotos não têm patrimônio positivo para encadear.';
  }

  // Alocação: a reserva aparece no consolidado, mas fica fora do denominador
  const reserve = roundCurrency(sum(assets.filter(a => a.group === 'reserva'), 'marketValue'));
  const investable = roundCurrency(equity - reserve);
  const targets = policy?.data?.metas || {};
  const byGroup = Object.keys(GROUPS).filter(g => g !== 'reserva').map(g => {
    const value = roundCurrency(sum(assets.filter(a => a.group === g), 'marketValue'));
    const pct = investable > 0 ? (value / investable) * 100 : 0;
    const target = targets[g] !== undefined ? toNumber(targets[g]) : null;
    return {
      group: g, label: GROUPS[g].label, value, pct,
      target, deviation: target === null ? null : pct - target,
      toTarget: target === null ? null : roundCurrency((target / 100) * investable - value)
    };
  }).filter(row => row.value > 0 || row.target !== null);
  if (cash > 0.004) byGroup.push({ group: 'caixa', label: 'Caixa da carteira', value: cash, pct: investable > 0 ? (cash / investable) * 100 : 0, target: null, deviation: null, toTarget: null });

  // Concentração
  const assetLimit = toNumber(policy?.data?.limite_ativo_pct) || null;
  const instLimit = toNumber(policy?.data?.limite_instituicao_pct) || null;
  const nonReserve = assets.filter(a => a.group !== 'reserva');
  const concentration = {
    denominator: 'carteira sem a reserva',
    assets: nonReserve.map(a => ({ name: a.symbol || a.name, pct: investable > 0 ? (a.marketValue / investable) * 100 : 0 }))
      .filter(a => a.pct >= (assetLimit || CONCENTRATION_REFERENCE)),
    limit: assetLimit, reference: assetLimit ? 'limite da política' : `referência de ${CONCENTRATION_REFERENCE}% (sem limite aprovado)`,
    institutions: Object.values(assets.reduce((acc, a) => {
      const key = a.institution || 'Sem instituição';
      acc[key] = acc[key] || { name: key, value: 0 };
      acc[key].value += a.marketValue;
      return acc;
    }, {})).map(i => ({ name: i.name, value: roundCurrency(i.value), pct: equity > 0 ? (i.value / equity) * 100 : 0 }))
      .sort((a, b) => b.value - a.value),
    institutionLimit: instLimit
  };
  const byCurrency = Object.values(assets.reduce((acc, a) => {
    acc[a.currency] = acc[a.currency] || { currency: a.currency, value: 0 };
    acc[a.currency].value += a.marketValue;
    return acc;
  }, {})).map(c => ({ ...c, value: roundCurrency(c.value) }));

  const liquidity = assets.filter(a => LIQUIDITY_TO_CHECK.has(a.type) || a.maturityDate)
    .map(a => ({ name: a.symbol || a.name, type: a.classLabel, maturityDate: a.maturityDate || '', note: a.maturityDate ? 'tem vencimento: venda antes segue preço de mercado/regras do produto' : 'liquidez a conferir no produto (carência, cotização, D+N)' }));

  // Lacunas: o que afeta os números e o que falta para eles serem completos
  if (inferred.length) gap('sem_historico', 'Posições com saldo, mas sem as compras datadas: entram no patrimônio e no "do seu bolso" pelo saldo, sem data.', inferred.map(f => f.asset));
  if (stray.length) gap('aportes_avulsos', 'Aportes avulsos em ativos que já têm operações: não entram na posição (registre como compra).', stray.map(s => `${s.asset} ${s.date}`));
  const stale = assets.filter(a => a.valuation === 'cotacao_antiga');
  if (stale.length) gap('cotacao_antiga', 'Cotações antigas: o valor dessas posições pode ter mudado.', stale.map(a => `${a.symbol || a.name} (${dateOnly(a.priceAt)})`));
  const atCost = assets.filter(a => a.valuation === 'custo');
  if (atCost.length) gap('sem_cotacao', 'Sem cotação: avaliadas pelo custo, não pelo mercado.', atCost.map(a => a.symbol || a.name));
  const typed = assets.filter(a => a.valuation === 'preco_informado');
  if (typed.length) gap('preco_informado', 'Preço digitado sem data de cotação (pode ser o preço da compra).', typed.map(a => a.symbol || a.name));
  const traded = assets.filter(a => a.valuation === 'preco_operacao');
  if (traded.length) gap('preco_operacao', 'Avaliadas pelo preço da última compra/venda, não por cotação: atualize as cotações para o valor de mercado.', traded.map(a => `${a.symbol || a.name} (${dateOnly(a.priceAt)})`));
  const fx = assets.filter(a => a.currency !== 'BRL' && a.exchangeRate <= 1.000001 && ['cotacao', 'cotacao_antiga', 'preco_informado', 'preco_operacao'].includes(a.valuation));
  if (fx.length) gap('cambio', 'Ativos em moeda estrangeira sem câmbio: o valor está na moeda original, não em reais.', fx.map(a => `${a.symbol || a.name} (${a.currency})`));
  if (overdue.length) gap('proventos_a_confirmar', 'Proventos previstos com data já passada: confirme se recebeu.', overdue.map(r => `${(positions.find(p => p.id === r.investmentId) || {}).symbol || ''} ${r.paymentDate}`.trim()));
  const inactive = assets.filter(a => a.status !== 'ATIVO');
  if (inactive.length) gap('inativo_com_saldo', 'Investimentos inativos que ainda têm saldo (entram no total).', inactive.map(a => a.symbol || a.name));
  if (cash < -0.004) gap('caixa_negativo', 'O caixa da carteira ficou negativo: alguma compra marcada como caixa não tem a venda/provento que a pagou.');
  if (operations.some(op => op.operationType === 'BONIFICACAO')) gap('bonificacao_custo', 'Bonificações entram sem custo atribuído: o resultado não muda, mas o custo para imposto pode precisar do valor informado pela empresa.');
  if (!policy) gap('sem_politica', 'Sem política de carteira aprovada: a alocação aparece sem metas.');

  const lastQuote = assets.map(a => a.priceAt).filter(Boolean).sort().at(-1) || '';
  const coverage = assets.reduce((acc, a) => { acc[a.valuation] = (acc[a.valuation] || 0) + 1; return acc; }, {});

  return {
    generatedAt: now(), today,
    perimeter: 'Posições cadastradas + caixa da carteira (vendas e proventos que ficaram nela). Saldo de conta bancária não entra.',
    equity, marketValue, cash, reserve, investable,
    external: {
      inflows, outflows, net: netExternal,
      month: flowSum(monthStart), year: flowSum(yearStart), last12: flowSum(last12),
      inferred: roundCurrency(sum(inferred, 'amount')), count: flows.length
    },
    result: {
      total: result, unrealized, realized, income: incomeReceived, fees,
      check: roundCurrency(result - (unrealized + realized + incomeReceived)),
      formula: 'patrimônio − entradas externas + saídas externas'
    },
    income: {
      received: { month: incomeSum(monthStart), year: incomeSum(yearStart), last12: incomeSum(last12), total: incomeReceived },
      expected: { total: roundCurrency(sum(expected, 'totalAmount')), items: expected.slice(0, 12).map(r => ({ asset: (positions.find(p => p.id === r.investmentId) || {}).symbol || '', date: r.paymentDate, value: r.totalAmount, type: r.incomeType })) },
      overdue: overdue.length,
      keptInCash: reinvestable,
      estimated: null,
      note: 'Recebidos, a receber (anunciados) e estimados ficam separados. O Jarvis não estima proventos futuros.'
    },
    performance: { mwr, twr, benchmark: null, benchmarkNote: 'Sem série de CDI/IPCA/Ibovespa guardada para a mesma janela: comparação não calculada.' },
    allocation: { denominator: 'patrimônio sem a reserva (inclui o caixa)', byGroup, hasPolicy: Boolean(policy) },
    concentration, byCurrency, liquidity,
    quotes: { last: lastQuote, coverage },
    assets, closedCount: closedRealized.length,
    evolution: snapshots.map(s => ({ date: s.date, equity: roundCurrency(s.marketValue + s.cash), marketValue: s.marketValue, externalNet: s.externalNet })),
    flows: options.withFlows ? flows : undefined,
    policy: policy ? { version: policy.version, createdAt: policy.createdAt, ...policy.data } : null,
    profile: profile ? { version: profile.version, createdAt: profile.createdAt, ...profile.data } : null,
    gaps,
    unsupported: Object.values(investments.UNSUPPORTED_EVENTS)
  };
}

module.exports = {
  GROUPS, groupOf, report, snapshotData, externalFlows, xirr,
  currentProfile, currentPolicy, saveProfile, savePolicy, history
};
