'use strict';

const repo = require('../repository');
const accounts = require('./accounts');
const cards = require('./cards');
const transactions = require('./transactions');
const investments = require('./investments');
const catalog = require('./catalog');
// paidByCategory vive no dashboard porque é lá que ela nasceu; reaproveitar
// evita duas versões da mesma consulta divergirem com o tempo.
const { paidByCategory } = require('./dashboard');
const { normalize } = require('./parser');
const { toNumber, roundCurrency, dateOnly, addMonths, monthKey, sum, MONTH_LABELS } = require('../utils');

const goalsService = () => require('./goals');

/**
 * Análises que só fazem sentido com histórico:
 *
 *   Assinaturas       — o que se repete todo mês, e quando o preço subiu.
 *   Fechamento do mês — a lista curta do que falta resolver.
 *   Calendário        — os vencimentos no mês e como o saldo evolui até o fim.
 *
 * Tudo derivado dos lançamentos que já existem; nada aqui grava no banco.
 */

// ---------------------------------------------------------------------------
// Assinaturas e gastos recorrentes
// ---------------------------------------------------------------------------

/** Reduz "EBN *SPOTIFY 07/26" e "Ebn *Spotify" ao mesmo identificador. */
function subscriptionKey(description) {
  return normalize(description)
    .replace(/\b\d{2}\/\d{2}\b/g, ' ')
    .replace(/\bparcela\s*\d+\s*\/\s*\d+/g, ' ')
    .replace(/\b\d{4,}\b/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(compra|internacional|em|no|na|de|do|da|pagamento|mensalidade|assinatura|br|ltda|sa)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 3)
    .join(' ');
}

/**
 * Encontra o que se repete mês a mês.
 *
 * O critério é conservador de propósito: precisa aparecer em pelo menos três
 * meses diferentes, com valores próximos. Sem isso, "mercado" viraria
 * "assinatura" só porque você vai ao mercado todo mês.
 */
function detectSubscriptions(options = {}) {
  const minMonths = options.minMonths || 3;
  const expenses = repo.query(
    `SELECT id, description, amount, date, category, payment_method, credit_card_id
       FROM expenses WHERE date >= ? ORDER BY date`,
    [addMonths(dateOnly(new Date()), -(options.lookbackMonths || 14))]
  );

  const groups = new Map();
  for (const expense of expenses) {
    const key = subscriptionKey(expense.description);
    if (key.length < 3) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(expense);
  }

  const today = dateOnly(new Date());
  const currentMonth = monthKey(today);
  const results = [];

  for (const [key, items] of groups) {
    const months = [...new Set(items.map(item => monthKey(item.date)))].sort();
    if (months.length < minMonths) continue;

    const amounts = items.map(item => toNumber(item.amount));
    const average = sum(amounts) / amounts.length;
    if (average <= 0) continue;

    // Valores muito instáveis não são assinatura, são consumo variável.
    const deviation = Math.sqrt(sum(amounts.map(value => (value - average) ** 2)) / amounts.length);
    if (deviation / average > 0.35) continue;

    // Precisa ser mensal: no máximo um lançamento por mês, na média.
    if (items.length > months.length * 1.6) continue;

    const sorted = [...items].sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const latest = sorted.at(-1);
    const previous = sorted.length > 1 ? sorted.at(-2) : null;

    const lastAmount = toNumber(latest.amount);
    const previousAmount = previous ? toNumber(previous.amount) : lastAmount;
    const change = roundCurrency(lastAmount - previousAmount);

    const monthsSinceLast = monthsBetween(monthKey(latest.date), currentMonth);

    results.push({
      key,
      name: cleanName(latest.description),
      category: latest.category,
      amount: roundCurrency(lastAmount),
      averageAmount: roundCurrency(average),
      months: months.length,
      firstSeen: sorted[0].date,
      lastSeen: latest.date,
      day: Number(String(latest.date).slice(8, 10)),
      yearlyCost: roundCurrency(lastAmount * 12),
      priceChange: Math.abs(change) >= 0.5 ? { amount: change, from: previousAmount, to: lastAmount } : null,
      // Não aparece há dois meses ou mais: provavelmente foi cancelada.
      status: monthsSinceLast >= 2 ? 'inativa' : 'ativa',
      monthsSinceLast,
      isNew: months.length <= minMonths && monthsSinceLast === 0,
      onCard: latest.paymentMethod === 'CARTAO_CREDITO'
    });
  }

  results.sort((a, b) => b.amount - a.amount);

  const active = results.filter(item => item.status === 'ativa');
  return {
    subscriptions: results,
    active,
    monthlyTotal: roundCurrency(sum(active, 'amount')),
    yearlyTotal: roundCurrency(sum(active, 'yearlyCost')),
    priceIncreases: active.filter(item => item.priceChange?.amount > 0),
    inactive: results.filter(item => item.status === 'inativa')
  };
}

const cleanName = description => String(description)
  .replace(/\b\d{2}\/\d{2}\b/g, '')
  .replace(/\s+-\s*Parcela.*$/i, '')
  .replace(/\s{2,}/g, ' ')
  .trim();

function monthsBetween(from, to) {
  const [fy, fm] = String(from).split('-').map(Number);
  const [ty, tm] = String(to).split('-').map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

// ---------------------------------------------------------------------------
// Fechamento do mês
// ---------------------------------------------------------------------------

/**
 * A lista curta do que falta resolver no mês. Cada item traz a ação que o
 * app sabe executar, para virar um botão na tela.
 */
function monthClosing(referenceMonth) {
  const month = referenceMonth || monthKey(dateOnly(new Date()));
  const [year, monthNumber] = month.split('-').map(Number);
  const steps = [];

  // 1. Lançamentos sem categoria
  const uncategorized = repo.query(
    `SELECT id, description, amount, date FROM expenses
      WHERE substr(date,1,7) = ? AND (category = '' OR category = 'Outros' OR category IS NULL)
      ORDER BY amount DESC`,
    [month]
  );
  steps.push({
    id: 'categorias',
    title: 'Classificar lançamentos',
    done: uncategorized.length === 0,
    count: uncategorized.length,
    detail: uncategorized.length
      ? `${uncategorized.length} lançamento(s) sem categoria, somando ${roundCurrency(sum(uncategorized, 'amount'))}`
      : 'Tudo categorizado.',
    action: uncategorized.length ? { type: 'review-uncategorized', month } : null,
    items: uncategorized.slice(0, 8)
  });

  // 2. Contas vencidas
  const overdue = transactions.listPayables(400).filter(item => item.days < 0);
  steps.push({
    id: 'vencidas',
    title: 'Resolver contas vencidas',
    done: overdue.length === 0,
    count: overdue.length,
    detail: overdue.length
      ? `${overdue.length} conta(s) vencida(s), somando ${roundCurrency(sum(overdue, 'amount'))}`
      : 'Nenhuma conta vencida.',
    action: overdue.length ? { type: 'go', page: 'payables' } : null,
    items: overdue.slice(0, 8)
  });

  // 3. Despesas fixas do mês geradas
  const fixedActive = transactions.listFixedExpenses().filter(item => item.status === 'ATIVA');
  const generated = repo.count('expenses', "fixed_expense_id <> '' AND substr(date,1,7) = ?", [month]);
  steps.push({
    id: 'fixas',
    title: 'Gerar as despesas fixas do mês',
    done: fixedActive.length === 0 || generated >= fixedActive.length,
    count: Math.max(0, fixedActive.length - generated),
    detail: fixedActive.length === 0
      ? 'Nenhuma despesa fixa cadastrada.'
      : generated >= fixedActive.length
        ? `As ${fixedActive.length} despesas fixas já foram geradas.`
        : `${fixedActive.length - generated} de ${fixedActive.length} ainda não foram geradas.`,
    action: fixedActive.length && generated < fixedActive.length
      ? { type: 'generate-fixed', month } : null
  });

  // 4. Saldo conferido com o banco
  const activeAccounts = accounts.list().filter(item => item.status === 'ATIVA');
  steps.push({
    id: 'saldo',
    title: 'Conferir o saldo com o banco',
    done: false,
    count: activeAccounts.length,
    detail: activeAccounts.length
      ? `Compare: ${activeAccounts.map(item => `${item.name} ${formatShort(item.currentBalance)}`).join(' · ')}`
      : 'Nenhuma conta cadastrada.',
    action: activeAccounts.length ? { type: 'import' } : null,
    manual: true
  });

  // 5. Faturas em aberto do mês
  const openInvoices = cards.getInvoicesDetailed()
    .filter(invoice => invoice.status === 'ABERTA' && invoice.referenceMonth === month);
  steps.push({
    id: 'faturas',
    title: 'Pagar as faturas do mês',
    done: openInvoices.length === 0,
    count: openInvoices.length,
    detail: openInvoices.length
      ? `${openInvoices.length} fatura(s) em aberto, somando ${roundCurrency(sum(openInvoices, 'totalAmount'))}`
      : 'Nenhuma fatura em aberto neste mês.',
    action: openInvoices.length ? { type: 'go', page: 'wallet', tab: 'invoices' } : null,
    items: openInvoices.slice(0, 5)
  });

  const income = sum(repo.query('SELECT amount FROM incomes WHERE substr(date,1,7) = ?', [month]), 'amount');
  const spent = sum(repo.query(`SELECT amount FROM expenses WHERE status='PAGO' AND substr(date,1,7) = ?`, [month]), 'amount');
  const profile = catalog.getProfile() || { monthlyGoal: 0 };
  const leftover = roundCurrency(income - spent);

  return {
    month,
    label: `${MONTH_LABELS[monthNumber - 1]} de ${year}`,
    steps,
    pending: steps.filter(step => !step.done && !step.manual).length,
    summary: {
      income: roundCurrency(income),
      spent: roundCurrency(spent),
      leftover,
      goal: toNumber(profile.monthlyGoal),
      goalReached: profile.monthlyGoal > 0 && leftover >= toNumber(profile.monthlyGoal)
    }
  };
}

const formatShort = value => `R$ ${toNumber(value).toFixed(2).replace('.', ',')}`;

// ---------------------------------------------------------------------------
// Calendário e saldo projetado
// ---------------------------------------------------------------------------

/**
 * O mês dia a dia: o que já aconteceu, o que vence e como o saldo caminha
 * até o fim. É o que permite ver o aperto antes dele chegar.
 */
function monthCalendar(referenceMonth) {
  const month = referenceMonth || monthKey(dateOnly(new Date()));
  const [year, monthNumber] = month.split('-').map(Number);
  const daysInMonth = new Date(year, monthNumber, 0).getDate();
  const today = dateOnly(new Date());
  const firstWeekday = new Date(year, monthNumber - 1, 1).getDay();

  const days = Array.from({ length: daysInMonth }, (_, index) => ({
    day: index + 1,
    date: `${month}-${String(index + 1).padStart(2, '0')}`,
    events: [],
    income: 0,
    outflow: 0
  }));
  const byDate = new Map(days.map(day => [day.date, day]));

  const push = (date, event) => {
    const day = byDate.get(dateOnly(date));
    if (!day) return;
    day.events.push(event);
    if (event.isIncome) day.income = roundCurrency(day.income + event.amount);
    else day.outflow = roundCurrency(day.outflow + event.amount);
  };

  for (const item of repo.query('SELECT * FROM incomes WHERE substr(date,1,7) = ?', [month])) {
    push(item.date, { type: 'income', title: item.source, amount: toNumber(item.amount), isIncome: true, done: true });
  }
  for (const item of repo.query('SELECT * FROM expenses WHERE substr(date,1,7) = ?', [month])) {
    push(item.date, {
      type: item.status === 'PENDENTE' ? 'due' : 'expense',
      title: item.description,
      amount: toNumber(item.amount),
      isIncome: false,
      done: item.status === 'PAGO',
      category: item.category
    });
  }
  for (const invoice of cards.getInvoicesDetailed()) {
    if (monthKey(invoice.dueDate) !== month) continue;
    push(invoice.dueDate, {
      type: 'invoice',
      title: `Fatura ${invoice.cardName}`,
      amount: toNumber(invoice.totalAmount),
      isIncome: false,
      done: invoice.status === 'PAGA'
    });
  }

  // Saldo projetado: parte do saldo atual e caminha dia a dia, somando o que
  // ainda está por vir. Dias passados repetem o saldo de hoje.
  const startingBalance = sum(accounts.list().filter(item => item.status === 'ATIVA'), 'currentBalance');
  let running = startingBalance;
  let lowest = { balance: startingBalance, date: today };

  for (const day of days) {
    if (day.date > today) {
      const pending = day.events.filter(event => !event.done);
      running = roundCurrency(running + sum(pending.filter(e => e.isIncome), 'amount') - sum(pending.filter(e => !e.isIncome), 'amount'));
    }
    day.projectedBalance = roundCurrency(running);
    day.isPast = day.date < today;
    day.isToday = day.date === today;
    if (day.date >= today && day.projectedBalance < lowest.balance) {
      lowest = { balance: day.projectedBalance, date: day.date };
    }
  }

  return {
    month,
    label: `${MONTH_LABELS[monthNumber - 1]} de ${year}`,
    firstWeekday,
    days,
    startingBalance: roundCurrency(startingBalance),
    endingBalance: roundCurrency(running),
    lowestPoint: lowest.date > today ? lowest : null,
    // Aviso só quando o saldo realmente fica negativo em algum dia futuro.
    willGoNegative: lowest.balance < 0 ? lowest : null,
    totals: {
      income: roundCurrency(sum(days, 'income')),
      outflow: roundCurrency(sum(days, 'outflow')),
      pendingCount: days.reduce((total, day) => total + day.events.filter(event => !event.done).length, 0)
    }
  };
}

// ---------------------------------------------------------------------------
// O que fazer agora
// ---------------------------------------------------------------------------

/**
 * Cartão de sugestões da visão geral. Prioridade: o que dói primeiro
 * (vencido), depois o que evita erro (sem categoria), depois o que planeja.
 */
function nextActions() {
  const actions = [];
  const today = dateOnly(new Date());
  const month = monthKey(today);

  const payables = transactions.listPayables(400);
  const overdue = payables.filter(item => item.days < 0);
  const soon = payables.filter(item => item.days >= 0 && item.days <= 5);

  if (overdue.length) {
    actions.push({
      id: 'overdue', tone: 'danger', icon: '⚠',
      title: `${overdue.length} conta${overdue.length > 1 ? 's' : ''} vencida${overdue.length > 1 ? 's' : ''}`,
      detail: `${overdue[0].title} · ${formatShort(overdue[0].amount)}${overdue.length > 1 ? ` e mais ${overdue.length - 1}` : ''}`,
      action: { type: 'go', page: 'payables' }, label: 'Resolver'
    });
  }
  if (soon.length) {
    actions.push({
      id: 'soon', tone: 'warning', icon: '⌛',
      title: `${soon.length} vence${soon.length > 1 ? 'm' : ''} nos próximos dias`,
      detail: `${soon[0].title} · ${formatShort(soon[0].amount)} em ${soon[0].days} dia(s)`,
      action: { type: 'go', page: 'payables' }, label: 'Ver'
    });
  }

  const uncategorized = repo.count('expenses',
    "substr(date,1,7) = ? AND (category = '' OR category = 'Outros' OR category IS NULL)", [month]);
  if (uncategorized) {
    actions.push({
      id: 'uncategorized', tone: 'primary', icon: '◎',
      title: `${uncategorized} lançamento(s) sem categoria`,
      detail: 'Classificar agora ensina o app a acertar sozinho depois',
      action: { type: 'close-month' }, label: 'Classificar'
    });
  }

  const fixedActive = transactions.listFixedExpenses().filter(item => item.status === 'ATIVA').length;
  const generated = repo.count('expenses', "fixed_expense_id <> '' AND substr(date,1,7) = ?", [month]);
  if (fixedActive && generated < fixedActive) {
    actions.push({
      id: 'fixed', tone: 'blue', icon: '↻',
      title: 'Despesas fixas do mês ainda não geradas',
      detail: `${fixedActive - generated} de ${fixedActive} pendente(s)`,
      action: { type: 'generate-fixed', month }, label: 'Gerar'
    });
  }

  const budgets = repo.all('budgets');
  if (budgets.length) {
    const spent = repo.query(
      `SELECT category, SUM(amount) AS total FROM expenses
        WHERE status='PAGO' AND substr(date,1,7) = ? GROUP BY category`, [month]);
    const spentMap = new Map(spent.map(item => [item.category, toNumber(item.total)]));
    const daysLeft = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate() - Number(today.slice(8, 10));

    for (const budget of budgets) {
      const used = spentMap.get(budget.category) || 0;
      const limit = toNumber(budget.amount);
      if (!limit) continue;
      const percentage = (used / limit) * 100;
      if (percentage >= 80) {
        actions.push({
          id: `budget-${budget.category}`,
          tone: percentage >= 100 ? 'danger' : 'warning',
          icon: percentage >= 100 ? '!' : '◐',
          title: percentage >= 100
            ? `Orçamento de ${budget.category} estourado`
            : `${percentage.toFixed(0)}% do orçamento de ${budget.category}`,
          detail: percentage >= 100
            ? `${formatShort(used - limit)} acima do limite`
            : `Restam ${formatShort(limit - used)} e faltam ${daysLeft} dia(s) no mês`,
          action: { type: 'go', page: 'transactions' }, label: 'Ver gastos'
        });
      }
    }
  }

  const subscriptions = detectSubscriptions();
  if (subscriptions.priceIncreases.length) {
    const first = subscriptions.priceIncreases[0];
    actions.push({
      id: 'subscription-price', tone: 'warning', icon: '📈',
      title: `${first.name} aumentou`,
      detail: `de ${formatShort(first.priceChange.from)} para ${formatShort(first.priceChange.to)}`,
      action: { type: 'subscriptions' }, label: 'Ver assinaturas'
    });
  }

  const calendar = monthCalendar(month);
  if (calendar.willGoNegative) {
    actions.push({
      id: 'negative', tone: 'danger', icon: '📉',
      title: 'Seu saldo fica negativo neste mês',
      detail: `No dia ${Number(calendar.willGoNegative.date.slice(8, 10))}, com ${formatShort(calendar.willGoNegative.balance)}`,
      action: { type: 'calendar' }, label: 'Ver calendário'
    });
  }

  if (!actions.length) {
    const goals = goalsService().listGoals().filter(goal => goal.status === 'ATIVA');
    actions.push({
      id: 'ok', tone: 'success', icon: '✓',
      title: 'Está tudo em dia',
      detail: goals.length
        ? `Sua meta mais próxima: ${goals[0].name}, ${goals[0].progress.toFixed(0)}% concluída`
        : 'Nenhuma pendência. Que tal criar uma meta?',
      action: goals.length ? { type: 'go', page: 'investments', tab: 'goals' } : { type: 'add-goal' },
      label: goals.length ? 'Ver metas' : 'Criar meta'
    });
  }

  return actions.slice(0, 5);
}

// ---------------------------------------------------------------------------
// Orçamento sugerido pelo histórico
// ---------------------------------------------------------------------------

/**
 * Propõe um teto por categoria a partir do que você realmente gastou.
 *
 * Usa a MEDIANA dos últimos meses, não a média: um mês com uma compra grande
 * puxaria a média para cima e o teto viraria uma licença para gastar mais.
 * A mediana ignora esse extremo e representa o seu mês típico.
 */
function suggestBudgets(options = {}) {
  const months = options.months || 6;
  const today = dateOnly(new Date());
  const references = [];
  for (let index = 1; index <= months; index++) references.push(monthKey(addMonths(today, -index)));

  const rows = repo.query(
    `SELECT category, substr(date,1,7) AS ref, SUM(amount) AS total
       FROM expenses
      WHERE substr(date,1,7) IN (${references.map(() => '?').join(',')})
        AND (status = 'PAGO' OR payment_method = 'CARTAO_CREDITO')
      GROUP BY category, ref`,
    references
  );

  const byCategory = new Map();
  for (const row of rows) {
    const category = row.category || 'Outros';
    if (!byCategory.has(category)) byCategory.set(category, []);
    byCategory.get(category).push(toNumber(row.total));
  }

  const current = catalog.budgetMap();
  const suggestions = [];

  for (const [category, values] of byCategory) {
    // Categorias esporádicas não merecem teto: viram ruído na tela.
    if (values.length < 3) continue;

    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const median = sorted.length % 2
      ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2;
    if (median < 20) continue;

    // Arredonda para cima na dezena: um teto quebrado não ajuda ninguém.
    const suggested = Math.ceil((median * 1.05) / 10) * 10;

    suggestions.push({
      category,
      suggested,
      median: roundCurrency(median),
      min: roundCurrency(sorted[0]),
      max: roundCurrency(sorted.at(-1)),
      months: values.length,
      currentBudget: toNumber(current[category]) || null
    });
  }

  return suggestions.sort((a, b) => b.suggested - a.suggested);
}

/**
 * O mês está correndo mais rápido que o normal?
 *
 * Compara o quanto já foi gasto com a fração do mês que já passou. Gastar 60%
 * do orçamento no dia 10 é um alerta útil; no dia 25, é normal.
 */
function budgetPace(referenceMonth) {
  const month = referenceMonth || monthKey(dateOnly(new Date()));
  const today = dateOnly(new Date());
  const [year, monthNumber] = month.split('-').map(Number);
  const daysInMonth = new Date(year, monthNumber, 0).getDate();

  const isCurrentMonth = month === monthKey(today);
  const dayOfMonth = isCurrentMonth ? Number(today.slice(8, 10)) : daysInMonth;
  const elapsed = dayOfMonth / daysInMonth;

  const budgets = catalog.budgetMap();
  const spent = paidByCategory(year, monthNumber);
  const result = [];

  for (const [category, limit] of Object.entries(budgets)) {
    const used = toNumber(spent[category]);
    const value = toNumber(limit);
    if (!value) continue;

    const usedRate = used / value;
    // Projeção linear: mantendo o ritmo, onde o mês termina?
    const projected = elapsed > 0 ? roundCurrency(used / elapsed) : used;

    result.push({
      category, limit: value, used: roundCurrency(used),
      pct: usedRate * 100,
      elapsedPct: elapsed * 100,
      projected,
      daysLeft: daysInMonth - dayOfMonth,
      // Só é "rápido demais" com folga de 15% sobre o esperado, para não
      // alarmar por uma compra que só antecipou o mês.
      aheadOfPace: isCurrentMonth && elapsed < 0.9 && usedRate > elapsed * 1.15 && used > 0,
      willExceed: projected > value * 1.05
    });
  }

  return result.sort((a, b) => b.pct - a.pct);
}

// ---------------------------------------------------------------------------
// Mesmo mês do ano anterior
// ---------------------------------------------------------------------------

/**
 * Julho contra julho do ano passado, por categoria.
 *
 * Comparar com o mês anterior confunde sazonalidade com mudança de hábito:
 * dezembro sempre gasta mais que novembro. Contra o mesmo mês do ano anterior,
 * o que sobra é a mudança de verdade.
 */
function sameMonthLastYear(referenceMonth) {
  const month = referenceMonth || monthKey(dateOnly(new Date()));
  const [year, monthNumber] = month.split('-').map(Number);
  const previousMonth = `${year - 1}-${String(monthNumber).padStart(2, '0')}`;

  const current = paidByCategory(year, monthNumber);
  const previous = paidByCategory(year - 1, monthNumber);

  const categories = [...new Set([...Object.keys(current), ...Object.keys(previous)])];
  const rows = categories.map(category => {
    const now = roundCurrency(current[category] || 0);
    const before = roundCurrency(previous[category] || 0);
    return {
      category, current: now, previous: before,
      delta: roundCurrency(now - before),
      pct: before ? ((now - before) / before) * 100 : (now ? 100 : 0),
      isNew: before === 0 && now > 0,
      disappeared: now === 0 && before > 0
    };
  }).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  const currentTotal = roundCurrency(sum(Object.values(current)));
  const previousTotal = roundCurrency(sum(Object.values(previous)));

  return {
    month, previousMonth,
    label: `${MONTH_LABELS[monthNumber - 1]}/${year}`,
    previousLabel: `${MONTH_LABELS[monthNumber - 1]}/${year - 1}`,
    hasData: previousTotal > 0,
    currentTotal, previousTotal,
    delta: roundCurrency(currentTotal - previousTotal),
    pct: previousTotal ? ((currentTotal - previousTotal) / previousTotal) * 100 : 0,
    rows: rows.filter(row => Math.abs(row.delta) >= 1)
  };
}

// ---------------------------------------------------------------------------
// Gasto fora do padrão
// ---------------------------------------------------------------------------

/**
 * Avalia um gasto contra o histórico do mesmo estabelecimento e da categoria.
 *
 * Serve tanto na hora de lançar quanto na revisão de uma importação, para
 * destacar o que merece um segundo olhar antes de entrar.
 */
function checkOutlier(description, amount, category = null) {
  const value = Math.abs(toNumber(amount));
  if (!value) return null;

  const term = categorizerModule().significantTerm(description);
  const flags = [];

  if (term && term.length >= 3) {
    const similar = repo.query(
      `SELECT amount FROM expenses
        WHERE lower(description) LIKE ? AND amount > 0
        ORDER BY date DESC LIMIT 12`,
      [`%${term}%`]
    ).map(row => toNumber(row.amount));

    if (similar.length >= 3) {
      const average = sum(similar) / similar.length;
      if (average > 0 && value > average * 2 && value - average >= 30) {
        flags.push({
          type: 'acimaDoHabitual',
          message: `${value / average >= 3 ? 'Bem acima' : 'Acima'} do normal aqui: você costuma gastar ${formatShort(average)}`,
          average: roundCurrency(average), ratio: value / average
        });
      }
    } else if (similar.length === 0) {
      flags.push({ type: 'primeiraVez', message: 'Primeira vez que esse estabelecimento aparece' });
    }
  }

  if (category) {
    const today = dateOnly(new Date());
    const values = [];
    for (let index = 1; index <= 6; index++) {
      const reference = addMonths(today, -index);
      const [year, month] = reference.split('-').map(Number);
      const total = paidByCategory(year, month)[category];
      if (total) values.push(toNumber(total));
    }
    if (values.length >= 3) {
      const monthlyAverage = sum(values) / values.length;
      if (monthlyAverage > 0 && value > monthlyAverage * 0.6) {
        flags.push({
          type: 'grandeParaCategoria',
          message: `Sozinho já representa ${((value / monthlyAverage) * 100).toFixed(0)}% do que você costuma gastar em ${category} num mês inteiro`
        });
      }
    }
  }

  return flags.length ? { flags, amount: value } : null;
}

const categorizerModule = () => require('./categorizer');

module.exports = {
  detectSubscriptions, monthClosing, monthCalendar, nextActions, subscriptionKey,
  suggestBudgets, budgetPace, sameMonthLastYear, checkOutlier
};
