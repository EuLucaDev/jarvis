'use strict';

const repo = require('../repository');
const accounts = require('./accounts');
const { logActivity } = require('./catalog');
const {
  generateId, now, toNumber, roundCurrency, required, dateOnly, sum, formatBRL
} = require('../utils');

/**
 * Metas: o objetivo, a caixinha e o plano.
 *
 * Investimento é onde o dinheiro está; meta é para que ele é. A diferença que
 * faz esta parte existir são três números que o app precisa manter separados:
 *
 *   guardado  tudo que já entrou na caixinha
 *   pago      os itens que já foram quitados com esse dinheiro
 *   livre     guardado − pago, o que ainda dá para usar
 *
 * Juntar R$ 5.000 e pagar a aliança de R$ 1.500 deixa R$ 3.500 livres, mas o
 * total juntado continua sendo R$ 5.000 — confundir os dois faz a pessoa achar
 * que poupou menos do que poupou.
 */

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

function investmentsById() {
  const investments = require('./investments');
  return new Map(investments.list().map(item => [item.id, item]));
}

/** Somatórios da caixinha e do plano, por meta. */
function totalsByGoal() {
  const deposits = new Map(
    repo.query('SELECT goal_id, SUM(amount) AS total FROM goal_deposits GROUP BY goal_id')
      .map(row => [row.goalId, roundCurrency(row.total)])
  );

  const planned = new Map();
  const paid = new Map();
  const paidFromGoal = new Map();
  const openItems = new Map();
  const counts = new Map();

  for (const item of repo.all('goal_items')) {
    counts.set(item.goalId, (counts.get(item.goalId) || 0) + 1);
    const plan = toNumber(item.plannedAmount);
    const isPaid = item.status === 'PAGO';
    const value = isPaid ? toNumber(item.paidAmount) : plan;
    planned.set(item.goalId, roundCurrency((planned.get(item.goalId) || 0) + value));
    if (isPaid) {
      paid.set(item.goalId, roundCurrency((paid.get(item.goalId) || 0) + toNumber(item.paidAmount)));
      if (item.paidSource === 'META') {
        paidFromGoal.set(item.goalId,
          roundCurrency((paidFromGoal.get(item.goalId) || 0) + toNumber(item.paidAmount)));
      }
    } else {
      const list = openItems.get(item.goalId) || [];
      list.push(item);
      openItems.set(item.goalId, list);
    }
  }

  return { deposits, planned, paid, paidFromGoal, openItems, counts };
}

function listGoals() {
  const investments = investmentsById();
  const totals = totalsByGoal();
  const today = now().slice(0, 10);

  return repo.all('goals', 'status, target_date, name COLLATE NOCASE').map(goal => {
    const linked = goal.investmentId ? investments.get(goal.investmentId) : null;
    // Meta ligada a investimento continua espelhando o saldo dele; as demais
    // somam a própria caixinha.
    const saved = linked
      ? roundCurrency(toNumber(linked.currentAmount))
      : roundCurrency(totals.deposits.get(goal.id) || 0);

    const target = roundCurrency(toNumber(goal.targetAmount));
    const paid = roundCurrency(totals.paid.get(goal.id) || 0);
    const paidFromGoal = roundCurrency(totals.paidFromGoal.get(goal.id) || 0);
    const planned = roundCurrency(totals.planned.get(goal.id) || 0);
    const free = roundCurrency(saved - paidFromGoal);
    const open = (totals.openItems.get(goal.id) || [])
      .slice()
      .sort((a, b) => String(a.dueDate || '9999').localeCompare(String(b.dueDate || '9999')));
    const remainingToPay = roundCurrency(Math.max(0, planned - paid));
    const missing = roundCurrency(Math.max(0, target - saved));
    const monthsLeft = goal.targetDate ? monthsBetween(today, goal.targetDate) : null;

    // Quanto ainda falta guardar por mês. A conta olha o que resta pagar
    // descontando o que já está na caixinha — dividir o alvo cheio pelo prazo
    // ignoraria justamente o dinheiro que a pessoa já juntou.
    const stillToFund = roundCurrency(Math.max(missing, Math.max(0, remainingToPay - free)));

    return {
      ...goal,
      savedAmount: saved,
      paidAmount: paid,
      paidFromGoal,
      freeAmount: free,
      plannedAmount: planned,
      remainingToPay,
      missing,
      // Quanto do objetivo já está coberto por dinheiro guardado.
      progress: target > 0 ? Math.min(100, (saved / target) * 100) : 0,
      // Quanto do plano já foi resolvido.
      planProgress: planned > 0 ? Math.min(100, (paid / planned) * 100) : 0,
      overPlanned: roundCurrency(Math.max(0, planned - target)),
      itemCount: totals.counts.get(goal.id) || 0,
      openItemCount: open.length,
      nextItem: open[0]
        ? { id: open[0].id, name: open[0].name, amount: toNumber(open[0].plannedAmount), dueDate: open[0].dueDate }
        : null,
      linkedInvestmentName: linked?.name || '',
      monthsLeft,
      requiredPerMonth: monthsLeft && monthsLeft > 0 ? roundCurrency(stillToFund / monthsLeft) : stillToFund
    };
  });
}

/** A meta com tudo que ela tem dentro — é o que a tela de detalhe usa. */
function getGoal(id) {
  const goal = listGoals().find(item => item.id === id);
  if (!goal) throw new Error('Meta não encontrada.');
  return {
    ...goal,
    items: listItems(id),
    deposits: listDeposits(id)
  };
}

const listItems = goalId =>
  repo.query('SELECT * FROM goal_items WHERE goal_id = ? ORDER BY position, created_at', [goalId]);

const listDeposits = goalId =>
  repo.query('SELECT * FROM goal_deposits WHERE goal_id = ? ORDER BY date DESC, created_at DESC', [goalId]);

function monthsBetween(fromDate, toDate) {
  const [fy, fm] = String(fromDate).split('-').map(Number);
  const [ty, tm] = String(toDate).split('-').map(Number);
  if (!ty) return null;
  return Math.max(0, (ty - fy) * 12 + (tm - fm));
}

/** Uma meta que já nasce (ou é editada para) com o valor completo é concluída. */
function resolveGoalStatus(saved, target, current = 'ATIVA') {
  if (current === 'ARQUIVADA') return current;
  return toNumber(saved) >= toNumber(target) ? 'CONCLUIDA' : 'ATIVA';
}

/** Recalcula o status e o espelho de saved_amount depois de mexer na caixinha. */
function syncGoal(goalId) {
  const goal = repo.findById('goals', goalId);
  if (!goal) return null;
  const saved = goal.investmentId
    ? toNumber(listGoals().find(item => item.id === goalId)?.savedAmount)
    : roundCurrency(sum(repo.query('SELECT amount FROM goal_deposits WHERE goal_id = ?', [goalId]), 'amount'));
  const status = resolveGoalStatus(saved, goal.targetAmount, goal.status);
  const updated = repo.update('goals', goalId, { savedAmount: roundCurrency(saved), status });
  if (status === 'CONCLUIDA' && goal.status !== 'CONCLUIDA') {
    logActivity('GOAL_COMPLETED', `Meta ${goal.name} concluída!`, 'goal', goalId);
  }
  return updated;
}

// ---------------------------------------------------------------------------
// A meta
// ---------------------------------------------------------------------------

function createGoal(data) {
  required(data, ['name', 'targetAmount']);
  return repo.transaction(() => {
    const item = {
      id: generateId('goal'),
      name: String(data.name).trim(),
      targetAmount: roundCurrency(data.targetAmount),
      savedAmount: 0,
      targetDate: data.targetDate ? dateOnly(data.targetDate) : '',
      investmentId: data.investmentId || '',
      color: data.color || '#d7ff37',
      icon: data.icon || '🎯',
      status: 'ATIVA',
      notes: data.notes || '',
      createdAt: now(),
      updatedAt: now()
    };
    if (item.targetAmount <= 0) throw new Error('O valor da meta deve ser maior que zero.');
    repo.insert('goals', item);
    logActivity('GOAL_CREATED', `Meta ${item.name} criada`, 'goal', item.id);

    // Dinheiro que já estava guardado antes de criar a meta entra como o
    // primeiro depósito, para que o histórico da caixinha comece completo.
    const initial = roundCurrency(data.savedAmount);
    if (initial > 0) {
      deposit(item.id, {
        amount: initial,
        bankAccountId: data.initialFromAccountId || '',
        date: now().slice(0, 10),
        description: 'Valor já guardado'
      });
    }
    return syncGoal(item.id) || item;
  });
}

function updateGoal(id, data) {
  const current = repo.findById('goals', id);
  if (!current) throw new Error('Meta não encontrada.');
  const merged = { ...current, ...data };
  repo.update('goals', id, {
    ...merged,
    // savedAmount é espelho dos depósitos: nunca vem do formulário.
    savedAmount: toNumber(current.savedAmount),
    targetAmount: roundCurrency(merged.targetAmount),
    targetDate: merged.targetDate ? dateOnly(merged.targetDate) : ''
  });
  return syncGoal(id);
}

/**
 * Apagar a meta devolve o dinheiro da caixinha para as contas de origem — as
 * linhas de depósito somem com a meta (ON DELETE CASCADE) e o saldo volta
 * sozinho. Itens pagos deixam de existir como item, mas as despesas que eles
 * geraram continuam no histórico do mês: aquilo aconteceu de verdade.
 */
function deleteGoal(id) {
  return repo.transaction(() => {
    const goal = repo.findById('goals', id);
    if (!goal) throw new Error('Meta não encontrada.');
    for (const item of listItems(id)) {
      if (item.expenseId) repo.update('goal_items', item.id, { expenseId: '' });
    }
    const removed = repo.remove('goals', id);
    logActivity('GOAL_DELETED', `Meta ${goal.name} excluída`, 'goal', id);
    accounts.syncBalances();
    return removed;
  });
}

// ---------------------------------------------------------------------------
// A caixinha
// ---------------------------------------------------------------------------

/**
 * Guardar (ou retirar, com valor negativo) dinheiro na meta.
 *
 * Sai da conta de verdade, como acontece quando você usa a caixinha do próprio
 * banco: o extrato também mostra esse dinheiro saindo da conta corrente, então
 * o saldo do app continua batendo com o do banco.
 */
function deposit(goalId, data = {}) {
  return repo.transaction(() => {
    const goal = repo.findById('goals', goalId);
    if (!goal) throw new Error('Meta não encontrada.');
    if (goal.investmentId) {
      throw new Error('Esta meta acompanha um investimento — registre um aporte no investimento.');
    }

    const amount = roundCurrency(data.amount);
    if (!amount) throw new Error('Informe um valor.');

    if (amount < 0) {
      const free = freeAmountOf(goalId);
      if (Math.abs(amount) > free + 0.001) {
        throw new Error(`Só dá para retirar ${formatBRL(free)} — o resto já foi usado em itens pagos.`);
      }
    }

    const bankAccountId = data.bankAccountId || '';
    if (bankAccountId) accounts.requireActive(bankAccountId);

    const item = {
      id: generateId('deposit'),
      goalId,
      bankAccountId,
      amount,
      date: dateOnly(data.date || now()),
      description: String(data.description || (amount > 0 ? 'Guardado na meta' : 'Retirada da meta')).trim(),
      notes: data.notes || '',
      createdAt: now(),
      updatedAt: now()
    };
    repo.insert('goal_deposits', item);
    logActivity(
      amount > 0 ? 'GOAL_DEPOSIT' : 'GOAL_WITHDRAW',
      `${formatBRL(Math.abs(amount))} ${amount > 0 ? 'guardados na' : 'retirados da'} meta ${goal.name}`,
      'goal', goalId
    );
    syncGoal(goalId);
    accounts.syncBalances();
    return item;
  });
}

function deleteDeposit(id) {
  return repo.transaction(() => {
    const item = repo.findById('goal_deposits', id);
    if (!item) throw new Error('Movimento não encontrado.');
    // Apagar um depósito não pode deixar a caixinha devendo o que já foi pago.
    if (toNumber(item.amount) > 0) {
      const free = freeAmountOf(item.goalId);
      if (toNumber(item.amount) > free + 0.001) {
        throw new Error(`Este valor já foi usado em itens pagos — sobram ${formatBRL(free)} livres.`);
      }
    }
    const removed = repo.remove('goal_deposits', id);
    syncGoal(item.goalId);
    accounts.syncBalances();
    return removed;
  });
}

/** Quanto ainda dá para usar: guardado menos o que os itens pagos consumiram. */
function freeAmountOf(goalId) {
  const saved = sum(repo.query('SELECT amount FROM goal_deposits WHERE goal_id = ?', [goalId]), 'amount');
  const used = sum(
    repo.query("SELECT paid_amount FROM goal_items WHERE goal_id = ? AND status = 'PAGO' AND paid_source = 'META'", [goalId]),
    'paidAmount'
  );
  return roundCurrency(saved - used);
}

// ---------------------------------------------------------------------------
// O plano: do que a meta é feita
// ---------------------------------------------------------------------------

function createItem(goalId, data = {}) {
  required(data, ['name']);
  const goal = repo.findById('goals', goalId);
  if (!goal) throw new Error('Meta não encontrada.');

  const last = repo.query('SELECT MAX(position) AS top FROM goal_items WHERE goal_id = ?', [goalId])[0];
  const item = {
    id: generateId('goalitem'),
    goalId,
    name: String(data.name).trim(),
    position: Number(last?.top || 0) + 1,
    plannedAmount: roundCurrency(data.plannedAmount),
    paidAmount: 0,
    category: data.category || '',
    dueDate: data.dueDate ? dateOnly(data.dueDate) : '',
    status: data.status === 'CONTRATADO' ? 'CONTRATADO' : 'PLANEJADO',
    paidSource: '',
    bankAccountId: '',
    paidDate: '',
    expenseId: '',
    notes: data.notes || '',
    createdAt: now(),
    updatedAt: now()
  };
  repo.insert('goal_items', item);
  return item;
}

function updateItem(id, data = {}) {
  const current = repo.findById('goal_items', id);
  if (!current) throw new Error('Item não encontrado.');
  if (current.status === 'PAGO' && 'plannedAmount' in data) {
    // O valor de um item pago é o que saiu, não o que estava previsto.
    delete data.plannedAmount;
  }
  const merged = { ...current, ...data };
  return repo.update('goal_items', id, {
    ...merged,
    name: String(merged.name).trim(),
    plannedAmount: roundCurrency(merged.plannedAmount),
    dueDate: merged.dueDate ? dateOnly(merged.dueDate) : ''
  });
}

function removeItem(id) {
  return repo.transaction(() => {
    const item = repo.findById('goal_items', id);
    if (!item) throw new Error('Item não encontrado.');
    if (item.status === 'PAGO') unpayItem(id);
    const removed = repo.remove('goal_items', id);
    accounts.syncBalances();
    return removed;
  });
}

function reorderItems(goalId, ids = []) {
  return repo.transaction(() => {
    ids.forEach((id, index) => {
      const item = repo.findById('goal_items', id);
      if (item && item.goalId === goalId) repo.update('goal_items', id, { position: index + 1 });
    });
    return listItems(goalId);
  });
}

/**
 * Marcar um item como pago.
 *
 * Pagar é o momento em que o dinheiro some de vez, então vira uma despesa de
 * verdade, com categoria e data, e aparece nos relatórios do mês. Guardar na
 * caixinha, antes, não era gasto — era só reservar.
 *
 * Vindo da caixinha, a despesa entra como META: ela conta no mês, mas não
 * desconta da conta bancária de novo, porque esse dinheiro já saiu de lá
 * quando foi guardado.
 */
function payItem(id, data = {}) {
  const transactions = require('./transactions');
  return repo.transaction(() => {
    const item = repo.findById('goal_items', id);
    if (!item) throw new Error('Item não encontrado.');
    if (item.status === 'PAGO') throw new Error('Este item já está pago.');

    const goal = repo.findById('goals', item.goalId);
    const amount = roundCurrency(data.amount ?? item.plannedAmount);
    if (amount <= 0) throw new Error('Informe quanto foi pago.');

    const source = data.source === 'CONTA' ? 'CONTA' : 'META';
    const date = dateOnly(data.date || now());
    const category = data.category || item.category || 'Outros';

    if (source === 'META') {
      const free = freeAmountOf(item.goalId);
      if (amount > free + 0.001) {
        throw new Error(
          `A caixinha tem ${formatBRL(free)} livres. Guarde mais ou pague este item pela conta.`
        );
      }
    } else if (!data.bankAccountId) {
      throw new Error('Escolha a conta que pagou.');
    }

    const expense = transactions.createExpense({
      description: `${goal?.name || 'Meta'} · ${item.name}`,
      category,
      paymentMethod: source === 'META' ? 'META' : (data.paymentMethod || 'DEBITO'),
      bankAccountId: source === 'META' ? '' : data.bankAccountId,
      goalId: item.goalId,
      amount,
      date,
      status: 'PAGO',
      notes: data.notes || ''
    });

    const updated = repo.update('goal_items', id, {
      status: 'PAGO',
      paidAmount: amount,
      paidSource: source,
      bankAccountId: source === 'CONTA' ? data.bankAccountId : '',
      paidDate: date,
      category,
      expenseId: expense.id
    });
    logActivity('GOAL_ITEM_PAID', `${item.name} pago na meta ${goal?.name || ''}`, 'goal', item.goalId);
    accounts.syncBalances();
    return updated;
  });
}

/** Desmarcar: apaga a despesa gerada e devolve o valor para a caixinha. */
function unpayItem(id) {
  const transactions = require('./transactions');
  return repo.transaction(() => {
    const item = repo.findById('goal_items', id);
    if (!item) throw new Error('Item não encontrado.');
    if (item.expenseId && repo.findById('expenses', item.expenseId)) {
      transactions.deleteExpense(item.expenseId);
    }
    const updated = repo.update('goal_items', id, {
      status: 'PLANEJADO', paidAmount: 0, paidSource: '', bankAccountId: '', paidDate: '', expenseId: ''
    });
    accounts.syncBalances();
    return updated;
  });
}

module.exports = {
  listGoals,
  getGoal,
  createGoal,
  updateGoal,
  deleteGoal,
  deposit,
  listDeposits,
  deleteDeposit,
  freeAmountOf,
  listItems,
  createItem,
  updateItem,
  removeItem,
  reorderItems,
  payItem,
  unpayItem,
  resolveGoalStatus,
  syncGoal
};
