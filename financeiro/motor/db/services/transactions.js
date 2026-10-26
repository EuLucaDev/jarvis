'use strict';

const repo = require('../repository');
const accounts = require('./accounts');
const cards = require('./cards');
const { logActivity } = require('./catalog');
const {
  generateId, now, toNumber, roundCurrency, required,
  dateOnly, filterList, formatBRL, invoiceDueDate
} = require('../utils');

const BANK_METHODS = ['PIX', 'DEBITO', 'DINHEIRO'];
// META é a saída paga com o dinheiro que já estava guardado numa meta. Conta
// como gasto do mês, mas não desconta da conta bancária: esse dinheiro saiu de
// lá quando foi para a caixinha. Mesma ideia do VALE_BENEFICIO, que desconta do
// saldo do vale e não da conta.
const PAYMENT_METHODS = [...BANK_METHODS, 'CARTAO_CREDITO', 'VALE_BENEFICIO', 'META'];

// ===========================================================================
// ENTRADAS
// ===========================================================================

function listIncomes(filters = {}) {
  return filterList(repo.all('incomes', 'date DESC, created_at DESC'), filters);
}

function createIncome(data) {
  required(data, ['source', 'category', 'bankAccountId', 'amount', 'date']);
  accounts.requireActive(data.bankAccountId);
  const amount = roundCurrency(data.amount);
  if (amount <= 0) throw new Error('O valor da entrada deve ser maior que zero.');

  const item = {
    id: generateId('income'),
    source: String(data.source).trim(),
    category: data.category,
    bankAccountId: data.bankAccountId,
    amount,
    date: dateOnly(data.date),
    description: data.description || '',
    notes: data.notes || '',
    recurringIncomeId: data.recurringIncomeId || '',
    createdAt: now(),
    updatedAt: now()
  };
  repo.insert('incomes', item);
  logActivity('INCOME_CREATED', `Entrada de ${formatBRL(amount)} adicionada`, 'income', item.id);
  accounts.syncBalances();
  return item;
}

function updateIncome(id, data) {
  if (!repo.findById('incomes', id)) throw new Error('Entrada não encontrada.');
  required(data, ['source', 'category', 'bankAccountId', 'amount', 'date']);
  const result = repo.update('incomes', id, {
    ...data,
    amount: roundCurrency(data.amount),
    date: dateOnly(data.date)
  });
  accounts.syncBalances();
  return result;
}

function deleteIncome(id) {
  if (!repo.findById('incomes', id)) throw new Error('Entrada não encontrada.');
  const removed = repo.remove('incomes', id);
  accounts.syncBalances();
  return removed;
}

// ---------------------------------------------------------------------------
// Receitas recorrentes — o espelho das despesas fixas para o lado das entradas
// ---------------------------------------------------------------------------

function listRecurringIncomes() {
  return repo.all('recurring_incomes', 'status, name COLLATE NOCASE');
}

function createRecurringIncome(data) {
  required(data, ['name', 'source', 'category', 'estimatedAmount']);
  const item = {
    id: generateId('recincome'),
    name: String(data.name).trim(),
    source: String(data.source).trim(),
    category: data.category,
    defaultAccountId: data.defaultAccountId || '',
    estimatedAmount: roundCurrency(data.estimatedAmount),
    receiveDay: Math.min(31, Math.max(1, toNumber(data.receiveDay, 1))),
    status: data.status || 'ATIVA',
    notes: data.notes || '',
    createdAt: now(),
    updatedAt: now()
  };
  if (item.estimatedAmount <= 0) throw new Error('O valor estimado deve ser maior que zero.');
  repo.insert('recurring_incomes', item);
  return item;
}

function updateRecurringIncome(id, data) {
  if (!repo.findById('recurring_incomes', id)) throw new Error('Receita recorrente não encontrada.');
  return repo.update('recurring_incomes', id, {
    ...data,
    estimatedAmount: roundCurrency(data.estimatedAmount),
    receiveDay: Math.min(31, Math.max(1, toNumber(data.receiveDay, 1)))
  });
}

function toggleRecurringIncomeStatus(id) {
  const item = repo.findById('recurring_incomes', id);
  if (!item) throw new Error('Receita recorrente não encontrada.');
  return repo.update('recurring_incomes', id, { status: item.status === 'ATIVA' ? 'INATIVA' : 'ATIVA' });
}

function deleteRecurringIncome(id) {
  return repo.remove('recurring_incomes', id);
}

/** Lança no mês as receitas recorrentes ativas que ainda não foram lançadas. */
function generateRecurringIncomesForMonth(referenceMonth) {
  if (!/^\d{4}-\d{2}$/.test(String(referenceMonth || ''))) throw new Error('Mês de referência inválido.');
  return repo.transaction(() => {
    let generated = 0;
    let existing = 0;
    const lastDay = new Date(Number(referenceMonth.slice(0, 4)), Number(referenceMonth.slice(5, 7)), 0).getDate();

    for (const recurring of listRecurringIncomes().filter(item => item.status === 'ATIVA')) {
      const already = repo.count('incomes', 'recurring_income_id = ? AND substr(date, 1, 7) = ?', [
        recurring.id,
        referenceMonth
      ]);
      if (already > 0) { existing++; continue; }
      if (!recurring.defaultAccountId) continue;

      const day = String(Math.min(toNumber(recurring.receiveDay, 1), lastDay)).padStart(2, '0');
      createIncome({
        source: recurring.source,
        category: recurring.category,
        bankAccountId: recurring.defaultAccountId,
        amount: recurring.estimatedAmount,
        date: `${referenceMonth}-${day}`,
        description: recurring.name,
        notes: recurring.notes,
        recurringIncomeId: recurring.id
      });
      generated++;
    }
    logActivity('RECURRING_INCOME_GENERATED', `${generated} receita(s) recorrente(s) lançada(s) em ${referenceMonth}`, 'recurringIncome', referenceMonth);
    return { generated, existing };
  });
}

// ===========================================================================
// SAÍDAS
// ===========================================================================

function listExpenses(filters = {}) {
  return filterList(repo.all('expenses', 'date DESC, created_at DESC'), filters);
}

/**
 * O coração do sistema. Uma saída se comporta de forma bem diferente conforme
 * a forma de pagamento:
 *
 *   PIX/Débito/Dinheiro → sai da conta na hora; abate o saldo.
 *   Vale/Benefício      → abate o saldo do vale; sempre nasce PAGO.
 *   Cartão de crédito   → não abate nada agora. Cria uma compra, que gera
 *                         parcelas, que compõem faturas. Fica PENDENTE até a
 *                         fatura ser paga.
 */
function createExpense(data, forcedId = null) {
  return repo.transaction(() => {
    required(data, ['category', 'paymentMethod', 'amount', 'date', 'description']);
    const amount = roundCurrency(data.amount);
    if (amount <= 0) throw new Error('O valor da saída deve ser maior que zero.');
    const method = data.paymentMethod;
    if (!PAYMENT_METHODS.includes(method)) throw new Error('Forma de pagamento inválida.');

    const item = {
      id: forcedId || generateId('expense'),
      type: data.type || 'VARIAVEL',
      category: data.category,
      bankAccountId: data.bankAccountId || '',
      paymentMethod: method,
      creditCardId: data.creditCardId || '',
      amount,
      date: dateOnly(data.date),
      description: String(data.description).trim(),
      notes: data.notes || '',
      status: data.status || 'PAGO',
      fixedExpenseId: data.fixedExpenseId || '',
      cardPurchaseId: '',
      goalId: data.goalId || '',
      createdAt: data.createdAt || now(),
      updatedAt: now()
    };

    if (BANK_METHODS.includes(method)) {
      accounts.requireActive(item.bankAccountId);
      item.creditCardId = '';
      repo.insert('expenses', item);
      logActivity('EXPENSE_CREATED', `Saída de ${formatBRL(amount)} adicionada`, 'expense', item.id);
      accounts.syncBalances();
      return item;
    }

    if (method === 'META') {
      // Quem controla o saldo da caixinha é o serviço de metas, que só chega
      // aqui depois de conferir que há dinheiro livre suficiente.
      if (!item.goalId) throw new Error('Saída de meta precisa dizer a qual meta pertence.');
      item.bankAccountId = '';
      item.creditCardId = '';
      item.status = 'PAGO';
      repo.insert('expenses', item);
      logActivity('GOAL_EXPENSE_CREATED', `Saída de ${formatBRL(amount)} paga por uma meta`, 'expense', item.id);
      return item;
    }

    if (method === 'VALE_BENEFICIO') {
      cards.decreaseBenefitBalance(item.creditCardId, amount);
      item.bankAccountId = '';
      item.status = 'PAGO';
      repo.insert('expenses', item);
      logActivity('BENEFIT_PURCHASE_CREATED', `Compra de ${formatBRL(amount)} no benefício`, 'expense', item.id);
      return item;
    }

    // CARTAO_CREDITO
    const card = cards.getById(item.creditCardId);
    if (cards.isBenefit(card)) throw new Error('Selecione um cartão de crédito, não um benefício.');
    if (card.status !== 'ATIVO') throw new Error('Selecione um cartão de crédito ativo.');

    item.bankAccountId = '';
    item.status = 'PENDENTE';
    const purchase = {
      id: generateId('purchase'),
      creditCardId: item.creditCardId,
      category: item.category,
      description: item.description,
      totalAmount: amount,
      purchaseDate: item.date,
      installments: Math.max(1, toNumber(data.installments, 1)),
      currentInstallment: 1,
      notes: item.notes,
      createdAt: now(),
      updatedAt: now()
    };
    repo.insert('card_purchases', purchase);
    item.cardPurchaseId = purchase.id;
    repo.insert('expenses', item);
    cards.generateInstallments(purchase);
    logActivity('CARD_PURCHASE_CREATED', `Compra ${item.description} lançada no cartão`, 'cardPurchase', purchase.id);
    return item;
  });
}

/**
 * Editar uma saída é apagar e recriar: mudar a forma de pagamento muda toda a
 * cadeia (parcelas, faturas, saldo de vale), e recriar garante que nenhum
 * efeito colateral da versão anterior sobre.
 */
function updateExpense(id, data) {
  return repo.transaction(() => {
    const old = repo.findById('expenses', id);
    if (!old) throw new Error('Saída não encontrada.');
    if (old.paymentMethod === 'META') {
      throw new Error('Esta saída pertence a um item de meta — edite por lá, na página Metas.');
    }
    const merged = { ...old, ...data };

    if (merged.paymentMethod === 'VALE_BENEFICIO') {
      const benefit = cards.getById(merged.creditCardId);
      const refundable =
        old.paymentMethod === 'VALE_BENEFICIO' && old.status === 'PAGO' && old.creditCardId === merged.creditCardId
          ? toNumber(old.amount)
          : 0;
      if (toNumber(benefit.benefitBalance) + refundable < toNumber(merged.amount)) {
        throw new Error(`Saldo insuficiente no ${benefit.name}. Disponível: ${formatBRL(benefit.benefitBalance)}.`);
      }
    }

    deleteExpenseInternal(old, false);
    const result = createExpense(
      { ...merged, type: old.type, fixedExpenseId: old.fixedExpenseId, createdAt: old.createdAt },
      id
    );
    accounts.syncBalances();
    return result;
  });
}

/**
 * Estorno numa fatura de cartão.
 *
 * Uma compra cancelada não devolve dinheiro para a sua conta: ela abate a
 * fatura do cartão. Registrar como receita — que era o que acontecia — inflava
 * o saldo bancário E deixava a fatura alta demais, errando duas vezes.
 *
 * Aqui o estorno vira uma "compra negativa": entra na mesma fatura, com valor
 * negativo, e a soma das parcelas cai exatamente o quanto deveria.
 */
function createCardRefund(data) {
  return repo.transaction(() => {
    required(data, ['category', 'amount', 'date', 'description', 'creditCardId']);
    const amount = roundCurrency(Math.abs(data.amount));
    if (amount <= 0) throw new Error('O valor do estorno deve ser maior que zero.');

    const card = cards.getById(data.creditCardId);
    if (cards.isBenefit(card)) throw new Error('Estorno de fatura só se aplica a cartão de crédito.');

    const purchase = {
      id: generateId('purchase'),
      creditCardId: card.id,
      category: data.category,
      description: data.description,
      totalAmount: -amount,
      purchaseDate: dateOnly(data.date),
      installments: 1,
      currentInstallment: 1,
      notes: data.notes || '',
      createdAt: now(),
      updatedAt: now()
    };
    repo.insert('card_purchases', purchase);

    const item = {
      id: generateId('expense'),
      type: 'ESTORNO',
      category: data.category,
      bankAccountId: '',
      paymentMethod: 'CARTAO_CREDITO',
      creditCardId: card.id,
      // Valor negativo: é o que faz o total da categoria e do mês recuar.
      amount: -amount,
      date: dateOnly(data.date),
      description: data.description,
      notes: data.notes || '',
      status: 'PENDENTE',
      fixedExpenseId: '',
      cardPurchaseId: purchase.id,
      createdAt: now(),
      updatedAt: now()
    };
    repo.insert('expenses', item);

    cards.generateInstallments(purchase);
    logActivity('CARD_REFUND_CREATED', `Estorno de ${formatBRL(amount)} em ${card.name}`, 'expense', item.id);
    return item;
  });
}

function deleteExpenseInternal(item, sync = true) {
  if (item.paymentMethod === 'VALE_BENEFICIO' && item.status === 'PAGO') {
    cards.refundBenefitBalance(item.creditCardId, item.amount);
  }
  // Apagar aqui a saída de um item de meta desmarca o item: senão ele
  // continuaria dizendo "pago" apontando para uma despesa que não existe mais,
  // e o dinheiro ficaria preso na caixinha.
  if (item.goalId) {
    for (const linked of repo.query('SELECT id FROM goal_items WHERE expense_id = ?', [item.id])) {
      repo.update('goal_items', linked.id, {
        status: 'PLANEJADO', paidAmount: 0, paidSource: '', bankAccountId: '', paidDate: '', expenseId: ''
      });
    }
  }
  if (item.cardPurchaseId) {
    // ON DELETE CASCADE limpa as parcelas junto com a compra.
    repo.remove('card_purchases', item.cardPurchaseId);
    cards.rebuildInvoices();
  }
  const removed = repo.remove('expenses', item.id);
  if (sync) accounts.syncBalances();
  return removed;
}

function deleteExpense(id) {
  return repo.transaction(() => {
    const item = repo.findById('expenses', id);
    if (!item) throw new Error('Saída não encontrada.');
    return deleteExpenseInternal(item, true);
  });
}

function markExpenseAsPaid(id) {
  return repo.transaction(() => {
    const item = repo.findById('expenses', id);
    if (!item) throw new Error('Saída não encontrada.');
    if (item.status === 'PAGO') throw new Error('Esta saída já está paga.');
    if (item.paymentMethod === 'VALE_BENEFICIO') cards.decreaseBenefitBalance(item.creditCardId, item.amount);
    if (BANK_METHODS.includes(item.paymentMethod)) accounts.getById(item.bankAccountId);

    const result = repo.update('expenses', id, { status: 'PAGO' });
    logActivity('EXPENSE_PAID', `${item.description} marcada como paga`, 'expense', id);
    accounts.syncBalances();
    return result;
  });
}

/**
 * Aplica a mesma mudança a vários lançamentos de uma vez.
 *
 * Depois de importar um ano de extratos sobram dezenas de linhas sem
 * categoria; corrigir uma a uma é o tipo de trabalho que faz o app ser
 * abandonado. Cada categoria confirmada aqui também vira regra, então o
 * esforço não se repete no mês seguinte.
 */
function bulkUpdate(ids, changes = {}) {
  return repo.transaction(() => {
    const categorizer = require('./categorizer');
    let updated = 0;
    let learned = 0;
    const errors = [];

    for (const id of ids || []) {
      const item = repo.findById('expenses', id);
      if (!item) { errors.push(`Lançamento ${id} não encontrado.`); continue; }

      const patch = {};
      if (changes.category) patch.category = changes.category;
      if (changes.bankAccountId && BANK_METHODS.includes(item.paymentMethod)) {
        accounts.requireActive(changes.bankAccountId);
        patch.bankAccountId = changes.bankAccountId;
      }
      if (changes.status && changes.status !== item.status) patch.status = changes.status;
      if (!Object.keys(patch).length) continue;

      repo.update('expenses', id, patch);
      updated++;

      if (changes.category && changes.category !== item.category && changes.learn !== false) {
        categorizer.learn(item.description, changes.category, 'variableExpense', 'user');
        learned++;
      }
    }

    accounts.syncBalances();
    if (updated) {
      logActivity('BULK_UPDATE', `${updated} lançamento(s) atualizado(s) em lote`, 'expense', 'bulk');
    }
    return { updated, learned, errors };
  });
}

/** Exclui vários de uma vez, respeitando os efeitos colaterais de cada um. */
function bulkDelete(ids) {
  return repo.transaction(() => {
    let deleted = 0;
    const errors = [];
    for (const id of ids || []) {
      try { deleteExpense(id); deleted++; }
      catch (error) { errors.push(error.message); }
    }
    return { deleted, errors };
  });
}

/** Marca várias de uma vez — útil no fim do mês, na lista de pendentes. */
function markManyAsPaid(ids = []) {
  let paid = 0;
  const errors = [];
  for (const id of ids) {
    try { markExpenseAsPaid(id); paid++; }
    catch (error) { errors.push(error.message); }
  }
  return { paid, errors };
}

// ---------------------------------------------------------------------------
// Despesas fixas
// ---------------------------------------------------------------------------

function listFixedExpenses() {
  return repo.all('fixed_expenses', 'status, due_day, name COLLATE NOCASE');
}

function createFixedExpense(data) {
  required(data, ['name', 'category', 'defaultPaymentMethod', 'estimatedAmount', 'dueDay']);
  const item = {
    id: generateId('fixed'),
    name: String(data.name).trim(),
    category: data.category,
    defaultBankAccountId: data.defaultBankAccountId || '',
    defaultPaymentMethod: data.defaultPaymentMethod,
    defaultCreditCardId: data.defaultCreditCardId || '',
    estimatedAmount: roundCurrency(data.estimatedAmount),
    dueDay: toNumber(data.dueDay),
    status: data.status || 'ATIVA',
    notes: data.notes || '',
    createdAt: now(),
    updatedAt: now()
  };
  if (item.estimatedAmount <= 0) throw new Error('O valor estimado deve ser maior que zero.');
  if (item.dueDay < 1 || item.dueDay > 31) throw new Error('O dia do vencimento deve estar entre 1 e 31.');
  repo.insert('fixed_expenses', item);
  return item;
}

function updateFixedExpense(id, data) {
  if (!repo.findById('fixed_expenses', id)) throw new Error('Despesa fixa não encontrada.');
  return repo.update('fixed_expenses', id, {
    ...data,
    estimatedAmount: roundCurrency(data.estimatedAmount),
    dueDay: toNumber(data.dueDay)
  });
}

function toggleFixedExpenseStatus(id) {
  const item = repo.findById('fixed_expenses', id);
  if (!item) throw new Error('Despesa fixa não encontrada.');
  return repo.update('fixed_expenses', id, { status: item.status === 'ATIVA' ? 'INATIVA' : 'ATIVA' });
}

function deleteFixedExpense(id) {
  return repo.remove('fixed_expenses', id);
}

/**
 * Gera as ocorrências do mês para cada compromisso fixo ativo, pulando os que
 * já foram gerados (rodar duas vezes no mesmo mês não duplica nada).
 */
function generateFixedExpensesForMonth(referenceMonth) {
  if (!/^\d{4}-\d{2}$/.test(String(referenceMonth || ''))) throw new Error('Mês de referência inválido.');
  return repo.transaction(() => {
    let generated = 0;
    let existing = 0;
    const lastDay = new Date(Number(referenceMonth.slice(0, 4)), Number(referenceMonth.slice(5, 7)), 0).getDate();

    for (const fixed of listFixedExpenses().filter(item => item.status === 'ATIVA')) {
      const already = repo.count('expenses', 'fixed_expense_id = ? AND substr(date, 1, 7) = ?', [fixed.id, referenceMonth]);
      if (already > 0) { existing++; continue; }

      const day = String(Math.min(toNumber(fixed.dueDay, 1), lastDay)).padStart(2, '0');
      const usesCard = ['CARTAO_CREDITO', 'VALE_BENEFICIO'].includes(fixed.defaultPaymentMethod);
      createExpense({
        type: 'FIXA',
        category: fixed.category,
        bankAccountId: usesCard ? '' : fixed.defaultBankAccountId,
        paymentMethod: fixed.defaultPaymentMethod,
        creditCardId: fixed.defaultCreditCardId || '',
        amount: fixed.estimatedAmount,
        date: `${referenceMonth}-${day}`,
        description: fixed.name,
        notes: fixed.notes || '',
        // Fixa no cartão/vale já é lançada e cobrada; nas demais fica pendente
        // até você confirmar o pagamento.
        status: usesCard ? undefined : 'PENDENTE',
        fixedExpenseId: fixed.id,
        installments: 1
      });
      generated++;
    }
    logActivity('FIXED_EXPENSE_GENERATED', `${generated} despesa(s) fixa(s) gerada(s) para ${referenceMonth}`, 'fixedExpense', referenceMonth);
    accounts.syncBalances();
    return { generated, existing };
  });
}

// ---------------------------------------------------------------------------
// Contas a pagar / lembretes
// ---------------------------------------------------------------------------

function daysUntil(dateStr) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(`${dateOnly(dateStr)}T00:00:00`);
  return Math.round((target - today) / 86400000);
}

/**
 * Tudo que vence: saídas pendentes e faturas em aberto, numa lista só,
 * ordenada por urgência. Alimenta a página "A pagar" e as notificações.
 *
 * Compras no cartão de crédito ficam de fora de propósito: elas já entram
 * aqui através da fatura. Se aparecessem também como saída pendente, o mesmo
 * valor seria contado duas vezes.
 */
function listPayables(windowDays = 30) {
  const items = [];
  const cardsById = new Map(cards.list().map(card => [card.id, card]));

  for (const expense of repo.query(
    `SELECT * FROM expenses WHERE status = 'PENDENTE' AND payment_method <> 'CARTAO_CREDITO'`
  )) {
    items.push({
      kind: 'expense',
      id: expense.id,
      title: expense.description,
      category: expense.category,
      amount: toNumber(expense.amount),
      dueDate: expense.date,
      days: daysUntil(expense.date),
      paymentMethod: expense.paymentMethod,
      bankAccountId: expense.bankAccountId,
      isFixed: expense.type === 'FIXA'
    });
  }

  for (const invoice of cards.getInvoices().filter(item => item.status === 'ABERTA' && toNumber(item.totalAmount) > 0)) {
    const card = cardsById.get(invoice.creditCardId);
    if (!card) continue;
    const dueDate = invoiceDueDate(invoice.referenceMonth, card.dueDay, card.closingDay);
    items.push({
      kind: 'invoice',
      id: invoice.id,
      title: `Fatura ${card.name}`,
      category: 'Cartão de crédito',
      amount: toNumber(invoice.totalAmount),
      dueDate,
      days: daysUntil(dueDate),
      referenceMonth: invoice.referenceMonth,
      cardColor: card.color
    });
  }

  return items
    .filter(item => item.days <= Number(windowDays))
    .sort((a, b) => a.days - b.days || b.amount - a.amount);
}

module.exports = {
  BANK_METHODS,
  PAYMENT_METHODS,
  listIncomes,
  createIncome,
  updateIncome,
  deleteIncome,
  listRecurringIncomes,
  createRecurringIncome,
  updateRecurringIncome,
  toggleRecurringIncomeStatus,
  deleteRecurringIncome,
  generateRecurringIncomesForMonth,
  listExpenses,
  createExpense,
  createCardRefund,
  updateExpense,
  deleteExpense,
  markExpenseAsPaid,
  markManyAsPaid,
  bulkUpdate,
  bulkDelete,
  listFixedExpenses,
  createFixedExpense,
  updateFixedExpense,
  toggleFixedExpenseStatus,
  deleteFixedExpense,
  generateFixedExpensesForMonth,
  listPayables,
  daysUntil
};
