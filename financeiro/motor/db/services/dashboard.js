'use strict';

const repo = require('../repository');
const accounts = require('./accounts');
const cards = require('./cards');
const investments = require('./investments');
const transactions = require('./transactions');
const catalog = require('./catalog');
const {
  MONTH_LABELS, toNumber, roundCurrency, sum, monthKey, addMonths,
  matchesPeriod, filterList, invoiceDueDate, dateOnly, now
} = require('../utils');

const goalsService = () => require('./goals');

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const percent = (part, total) => (total ? (toNumber(part) / toNumber(total)) * 100 : 0);

const BANK_METHODS = ['PIX', 'DEBITO', 'DINHEIRO'];

/**
 * Monta tudo que a visão geral precisa numa passada só. Todos os cálculos que
 * antes viviam espalhados no navegador (score, projeções, anomalias) rodam
 * aqui, contra o banco — mais rápido e sempre consistente.
 */
function getData(filters = {}) {
  const year = Number(filters.year) || new Date().getFullYear();
  const month = filters.month && filters.month !== 'all' ? Number(filters.month) : 'all';
  const scope = { ...filters, year, month };

  const allAccounts = accounts.list();
  const allIncomes = repo.all('incomes');
  const allExpenses = repo.all('expenses');
  const allContributions = repo.all('investment_contributions');
  const allInvestments = investments.list();
  const allCards = cards.list();
  const allInvoices = cards.getInvoices();
  const cardsById = new Map(allCards.map(card => [card.id, card]));

  const dueDateOf = invoice => {
    const card = cardsById.get(invoice.creditCardId);
    return card ? invoiceDueDate(invoice.referenceMonth, card.dueDay, card.closingDay) : `${invoice.referenceMonth}-01`;
  };

  // --- Recortes do período -------------------------------------------------
  const periodIncomes = filterList(allIncomes, scope);
  const periodExpenses = filterList(allExpenses, scope);
  const periodContributions = filterList(allContributions, scope);
  const periodInvoices = allInvoices.filter(invoice => {
    const reference = invoice.status === 'PAGA' && invoice.paidAt ? invoice.paidAt : dueDateOf(invoice);
    if (!matchesPeriod(reference, scope)) return false;
    return !scope.card || scope.card === 'all' || invoice.creditCardId === scope.card;
  });

  const paidBankExpenses = periodExpenses.filter(item => item.status === 'PAGO' && BANK_METHODS.includes(item.paymentMethod));
  const benefitExpenses = periodExpenses.filter(item => item.status === 'PAGO' && item.paymentMethod === 'VALE_BENEFICIO');
  const paidInvoices = periodInvoices.filter(item => item.status === 'PAGA');
  const openInvoices = periodInvoices.filter(item => item.status === 'ABERTA');

  // --- Totais --------------------------------------------------------------
  const totalIncome = roundCurrency(sum(periodIncomes, 'amount'));
  const bankOutflow = roundCurrency(
    sum(paidBankExpenses, 'amount') + sum(paidInvoices, 'totalAmount') + sum(periodContributions, 'amount')
  );
  const benefitConsumption = roundCurrency(sum(benefitExpenses, 'amount'));
  const totalOutflow = roundCurrency(bankOutflow + benefitConsumption);

  const bankBalance = roundCurrency(sum(allAccounts.filter(a => a.status === 'ATIVA'), 'currentBalance'));
  const investedBalance = roundCurrency(sum(allInvestments.filter(i => i.status === 'ATIVO'), 'currentAmount'));
  const benefitBalance = roundCurrency(
    sum(allCards.filter(c => c.status === 'ATIVO' && cards.isBenefit(c)), 'benefitBalance')
  );

  const openInvoiceTotal = roundCurrency(sum(openInvoices, 'totalAmount'));
  const pendingExpenses = periodExpenses.filter(item => item.status === 'PENDENTE' && item.paymentMethod !== 'CARTAO_CREDITO');
  const payable = roundCurrency(sum(pendingExpenses, 'amount') + openInvoiceTotal);
  const freeToSpend = roundCurrency(totalIncome - bankOutflow);
  const leftover = roundCurrency(totalIncome - totalOutflow);

  // --- Séries de 12 meses --------------------------------------------------
  const monthSeries = [];
  for (let index = 1; index <= 12; index++) {
    const monthScope = { year, month: index };
    const income = sum(allIncomes.filter(item => matchesPeriod(item.date, monthScope)), 'amount');
    const expense = sum(
      allExpenses.filter(item => item.status === 'PAGO' && item.paymentMethod !== 'CARTAO_CREDITO' && matchesPeriod(item.date, monthScope)),
      'amount'
    );
    const invoicesPaid = sum(
      allInvoices.filter(item => item.status === 'PAGA' && matchesPeriod(item.paidAt, monthScope)),
      'totalAmount'
    );
    const contributions = sum(allContributions.filter(item => matchesPeriod(item.date, monthScope)), 'amount');
    monthSeries.push({
      month: index,
      label: MONTH_LABELS[index - 1],
      income: roundCurrency(income),
      outflow: roundCurrency(expense + invoicesPaid + contributions),
      investment: roundCurrency(contributions),
      balance: roundCurrency(income - expense - invoicesPaid - contributions)
    });
  }

  // --- Evolução patrimonial ------------------------------------------------
  const initialBank = sum(allAccounts.filter(a => a.status === 'ATIVA'), 'initialBalance');
  const initialInvested = investedBalance - sum(allContributions, 'amount');
  const initialBenefits =
    benefitBalance + sum(allExpenses.filter(i => i.paymentMethod === 'VALE_BENEFICIO' && i.status === 'PAGO'), 'amount');
  let running = initialBank + initialInvested + initialBenefits;
  const balanceEvolution = monthSeries.map(item => {
    running += item.income - item.outflow + item.investment;
    return { month: item.month, label: item.label, value: roundCurrency(running) };
  });

  let investedRunning = initialInvested;
  const investmentEvolution = monthSeries.map(item => {
    investedRunning += item.investment;
    return { month: item.month, label: item.label, value: roundCurrency(investedRunning) };
  });

  // --- Distribuições -------------------------------------------------------
  /**
   * "Onde eu gastei" conta a compra no dia em que ela aconteceu, mesmo que a
   * fatura do cartão ainda não tenha sido paga.
   *
   * Antes só entravam as saídas com status PAGO — e como compra no crédito
   * fica PENDENTE até a fatura ser quitada, quem importava um ano de faturas
   * via o gráfico de categorias praticamente vazio. O fluxo de caixa continua
   * contando só o que saiu da conta; isto aqui é análise de consumo.
   */
  const categoryMap = {};
  for (const item of periodExpenses) {
    if (item.status !== 'PAGO' && item.paymentMethod !== 'CARTAO_CREDITO') continue;
    categoryMap[item.category] = (categoryMap[item.category] || 0) + toNumber(item.amount);
  }
  const expensesByCategory = Object.entries(categoryMap)
    .map(([name, value]) => ({ name, value: roundCurrency(value) }))
    .sort((a, b) => b.value - a.value);

  const invoicesByCard = allCards
    .filter(card => !cards.isBenefit(card))
    .map(card => ({
      id: card.id,
      name: card.name,
      color: card.color,
      value: roundCurrency(sum(openInvoices.filter(i => i.creditCardId === card.id), 'totalAmount'))
    }));

  const paymentMethodMap = {};
  for (const item of periodExpenses.filter(i => i.status === 'PAGO' || i.paymentMethod === 'CARTAO_CREDITO')) {
    paymentMethodMap[item.paymentMethod] = (paymentMethodMap[item.paymentMethod] || 0) + toNumber(item.amount);
  }

  const fixedTotal = roundCurrency(sum(periodExpenses.filter(i => i.type === 'FIXA'), 'amount'));
  const variableTotal = roundCurrency(sum(periodExpenses.filter(i => i.type !== 'FIXA'), 'amount'));

  const profile = catalog.getProfile() || { monthlyGoal: 0, emergencyReserveGoal: 0 };
  const base = {
    totalIncome, totalOutflow, bankOutflow, benefitConsumption,
    freeToSpend, leftover, savingRate: percent(freeToSpend, totalIncome)
  };

  return {
    period: { year, month },
    totalBalance: roundCurrency(bankBalance + investedBalance + benefitBalance),
    bankBalance, investedBalance, benefitBalance,
    ...base,
    openInvoiceTotal, payable,
    monthlyGoal: toNumber(profile.monthlyGoal),
    goalProgress: percent(freeToSpend, profile.monthlyGoal),
    counts: {
      incomes: periodIncomes.length,
      expenses: periodExpenses.length,
      contributions: periodContributions.filter(item => toNumber(item.amount) > 0).length,
      withdrawals: periodContributions.filter(item => toNumber(item.amount) < 0).length,
      openInvoices: openInvoices.length,
      pending: pendingExpenses.length
    },
    // Aporte e resgate são somados separados: um aporte negativo é um resgate,
    // e mostrar os dois juntos faria "Aportes" aparecer negativo na tela.
    contributionTotal: roundCurrency(sum(periodContributions.filter(item => toNumber(item.amount) > 0), 'amount')),
    withdrawalTotal: roundCurrency(Math.abs(sum(periodContributions.filter(item => toNumber(item.amount) < 0), 'amount'))),
    bankAccounts: allAccounts,
    cards: allCards.filter(card => !cards.isBenefit(card)),
    benefits: allCards.filter(cards.isBenefit),
    investments: allInvestments,
    incomesVsOutflowsByMonth: monthSeries,
    balanceEvolution,
    investmentEvolution,
    expensesByCategory,
    topExpenseCategories: expensesByCategory.slice(0, 6),
    invoicesByCard,
    expensesByPaymentMethod: Object.entries(paymentMethodMap).map(([name, value]) => ({ name, value: roundCurrency(value) })),
    fixedVsVariable: { fixed: fixedTotal, variable: variableTotal },
    recentActivities: catalog.listActivities(8),
    intelligence: getIntelligence(scope, base, profile),
    budgets: getBudgetStatus(scope),
    payables: transactions.listPayables(15).slice(0, 8),
    goals: goalsService().listGoals().filter(goal => goal.status === 'ATIVA').slice(0, 4)
  };
}

// ---------------------------------------------------------------------------
// Inteligência financeira
// ---------------------------------------------------------------------------

function paidByCategory(year, month) {
  const key = `${year}-${String(month).padStart(2, '0')}`;
  const map = {};
  for (const item of repo.query(
    `SELECT category, SUM(amount) AS total FROM expenses WHERE status = 'PAGO' AND substr(date, 1, 7) = ? GROUP BY category`,
    [key]
  )) {
    map[item.category || 'Outros'] = toNumber(item.total);
  }
  return map;
}

function averageMonthlyIncome(year) {
  const rows = repo.query(
    `SELECT substr(date, 1, 7) AS ref, SUM(amount) AS total FROM incomes WHERE substr(date, 1, 4) = ? GROUP BY ref`,
    [String(year)]
  );
  const active = rows.map(r => toNumber(r.total)).filter(v => v > 0);
  return active.length ? roundCurrency(sum(active) / active.length) : 0;
}

/**
 * Score de 0 a 100 combinando três coisas que realmente importam:
 * quanto sobra (40), o tamanho da reserva (35) e quanto da renda já está
 * comprometida com despesas fixas (25).
 */
function healthScore(scope, base, profile) {
  const income = averageMonthlyIncome(scope.year);
  const savingPart = (clamp(base.savingRate, 0, 30) / 30) * 40;

  const reserve = repo.query(`SELECT * FROM investments WHERE type = 'RESERVA_EMERGENCIA' LIMIT 1`)[0];
  const reservePart = clamp(percent(reserve?.currentAmount || 0, profile.emergencyReserveGoal) / 100, 0, 1) * 35;

  const fixedTotal = sum(transactions.listFixedExpenses().filter(f => f.status === 'ATIVA'), 'estimatedAmount');
  const commitment = income ? fixedTotal / income : 1;
  const commitmentPart = clamp(1 - commitment / 0.6, 0, 1) * 25;

  const score = clamp(Math.round(savingPart + reservePart + commitmentPart), 0, 100);
  const [label, tone] =
    score >= 85 ? ['Excelente', 'success'] :
    score >= 70 ? ['Saudável', 'success'] :
    score >= 45 ? ['Regular', 'warning'] : ['Atenção', 'danger'];

  return {
    score, label, tone,
    parts: { saving: savingPart, reserve: reservePart, commitment: commitmentPart },
    commitmentRate: income ? percent(fixedTotal, income) : 0,
    averageIncome: income,
    fixedTotal: roundCurrency(fixedTotal)
  };
}

function monthComparison(scope) {
  const current = scope.month === 'all' ? new Date().getMonth() + 1 : Number(scope.month);
  const previousRef = addMonths(`${scope.year}-${String(current).padStart(2, '0')}-01`, -1).split('-');
  const currentMap = paidByCategory(scope.year, current);
  const previousMap = paidByCategory(Number(previousRef[0]), Number(previousRef[1]));

  const currentTotal = sum(Object.values(currentMap));
  const previousTotal = sum(Object.values(previousMap));
  const movers = [...new Set([...Object.keys(currentMap), ...Object.keys(previousMap)])]
    .map(category => ({ category, delta: roundCurrency((currentMap[category] || 0) - (previousMap[category] || 0)) }))
    .filter(item => Math.abs(item.delta) >= 1)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 5);

  return {
    currentTotal: roundCurrency(currentTotal),
    previousTotal: roundCurrency(previousTotal),
    currentMonth: current,
    previousMonth: Number(previousRef[1]),
    delta: roundCurrency(currentTotal - previousTotal),
    pct: previousTotal ? ((currentTotal - previousTotal) / previousTotal) * 100 : currentTotal ? 100 : 0,
    movers
  };
}

/** Em que mês a reserva de emergência fica pronta, no ritmo atual de aportes. */
function reserveProjection(profile) {
  const reserve = repo.query(`SELECT * FROM investments WHERE type = 'RESERVA_EMERGENCIA' LIMIT 1`)[0];
  const current = toNumber(reserve?.currentAmount);
  const goal = toNumber(profile.emergencyReserveGoal);
  if (goal <= 0) return { status: 'none' };
  if (current >= goal) return { status: 'done', current, goal, pct: 100 };

  const pace = investments.averageMonthlyContribution(6);
  const missing = roundCurrency(goal - current);
  if (pace <= 0) return { status: 'stalled', current, goal, missing, pct: percent(current, goal) };

  const months = Math.ceil(missing / pace);
  const target = addMonths(now().slice(0, 10), months);
  const [targetYear, targetMonth] = target.split('-');
  return {
    status: 'ok', current, goal, pace, months, missing,
    dateLabel: `${MONTH_LABELS[Number(targetMonth) - 1]}/${targetYear}`,
    pct: percent(current, goal)
  };
}

/** Saldo projetado em 30/60/90 dias: entrada média − fixas − faturas que vencem. */
function cashflowForecast(scope) {
  const bank = sum(accounts.list().filter(a => a.status === 'ATIVA'), 'currentBalance');
  const income = averageMonthlyIncome(scope.year);
  const fixed = sum(transactions.listFixedExpenses().filter(f => f.status === 'ATIVA'), 'estimatedAmount');
  const payables = transactions.listPayables(120);

  return [30, 60, 90].map(days => {
    const dueSoon = sum(payables.filter(item => item.days <= days && item.days >= 0), 'amount');
    return { days, value: roundCurrency(bank + (income - fixed) * (days / 30) - dueSoon) };
  });
}

/** Categorias que fugiram do padrão dos últimos 3 meses. */
function anomalies(scope) {
  const current = scope.month === 'all' ? new Date().getMonth() + 1 : Number(scope.month);
  const currentMap = paidByCategory(scope.year, current);
  const result = [];

  for (const [category, value] of Object.entries(currentMap)) {
    let total = 0;
    for (let index = 1; index <= 3; index++) {
      const ref = addMonths(`${scope.year}-${String(current).padStart(2, '0')}-01`, -index).split('-');
      total += paidByCategory(Number(ref[0]), Number(ref[1]))[category] || 0;
    }
    const average = total / 3;
    if (average > 0 && value > average * 1.3 && value - average >= 50) {
      result.push({ category, current: roundCurrency(value), average: roundCurrency(average), pct: ((value - average) / average) * 100 });
    }
  }
  return result.sort((a, b) => b.pct - a.pct).slice(0, 4);
}

/** Meses seguidos batendo a meta de sobra — a "sequência" das conquistas. */
function streak(profile) {
  const goal = toNumber(profile.monthlyGoal);
  if (goal <= 0) return 0;
  let count = 0;
  for (let index = 0; index < 24; index++) {
    const ref = monthKey(addMonths(now().slice(0, 10), -index));
    const income = sum(repo.query('SELECT amount FROM incomes WHERE substr(date,1,7) = ?', [ref]), 'amount');
    const spent = sum(repo.query(`SELECT amount FROM expenses WHERE status='PAGO' AND substr(date,1,7) = ?`, [ref]), 'amount');
    const left = income - spent;
    if (index === 0 && left === 0) continue;
    if (left >= goal) count++;
    else break;
  }
  return count;
}

function achievements(profile) {
  const reserve = repo.query(`SELECT * FROM investments WHERE type = 'RESERVA_EMERGENCIA' LIMIT 1`)[0];
  const reservePct = percent(reserve?.currentAmount || 0, profile.emergencyReserveGoal);
  const totalInvested = sum(investments.list().filter(i => i.status === 'ATIVO'), 'currentAmount');
  const currentStreak = streak(profile);
  const completedGoals = goalsService().listGoals().filter(goal => goal.status === 'CONCLUIDA').length;

  return {
    streak: currentStreak,
    list: [
      { icon: '🔥', title: 'Sequência no azul', desc: `${currentStreak} mês(es) batendo a meta`, done: currentStreak >= 1, progress: clamp(currentStreak / 6, 0, 1) },
      { icon: '🛡️', title: 'Meia reserva', desc: '50% da reserva de emergência', done: reservePct >= 50, progress: clamp(reservePct / 50, 0, 1) },
      { icon: '🏆', title: 'Reserva completa', desc: '100% da reserva de emergência', done: reservePct >= 100, progress: clamp(reservePct / 100, 0, 1) },
      { icon: '🌱', title: 'Investidor', desc: 'R$ 10 mil investidos', done: totalInvested >= 10000, progress: clamp(totalInvested / 10000, 0, 1) },
      { icon: '🎯', title: 'Realizador', desc: 'Primeira meta concluída', done: completedGoals >= 1, progress: clamp(completedGoals, 0, 1) }
    ]
  };
}

function getIntelligence(scope, base, profile) {
  return {
    health: healthScore(scope, base, profile),
    comparison: monthComparison(scope),
    reserve: reserveProjection(profile),
    forecast: cashflowForecast(scope),
    anomalies: anomalies(scope),
    achievements: achievements(profile)
  };
}

/** Progresso de cada orçamento no mês selecionado. */
function getBudgetStatus(scope) {
  const month = scope.month === 'all' ? new Date().getMonth() + 1 : Number(scope.month);
  const spent = paidByCategory(scope.year, month);
  const budgets = catalog.budgetMap();
  const categories = Object.keys(budgets).length
    ? Object.keys(budgets)
    : Object.keys(spent).sort((a, b) => spent[b] - spent[a]).slice(0, 4);

  return categories.map(category => {
    const limit = toNumber(budgets[category]);
    const used = roundCurrency(spent[category] || 0);
    const pct = limit ? clamp((used / limit) * 100, 0, 100) : 0;
    return {
      category, limit, used, pct,
      remaining: roundCurrency(Math.max(0, limit - used)),
      over: limit > 0 && used > limit ? roundCurrency(used - limit) : 0,
      tone: !limit ? 'none' : used >= limit ? 'over' : used >= limit * 0.8 ? 'warn' : 'ok'
    };
  });
}

module.exports = { getData, paidByCategory, averageMonthlyIncome, getBudgetStatus };
