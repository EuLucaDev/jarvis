'use strict';

const repo = require('../repository');
const { logActivity } = require('./catalog');
const { generateId, now, toNumber, roundCurrency, required, dateOnly, formatBRL } = require('../utils');

const BANK_METHODS = ['PIX', 'DEBITO', 'DINHEIRO'];

// ---------------------------------------------------------------------------
// Saldos
//
// O saldo nunca é digitado: é sempre recalculado a partir dos lançamentos.
// Isso garante que conta e extrato jamais divirjam.
//
//   saldo = saldo inicial
//         + entradas
//         + transferências recebidas
//         − saídas pagas em conta (PIX, débito, dinheiro)
//         − faturas de cartão pagas por esta conta
//         − aportes em investimentos
//         − transferências enviadas
// ---------------------------------------------------------------------------

/**
 * O saldo de todas as contas.
 *
 * Sai caro: são sete consultas somando tudo que já entrou e saiu. E é pedido
 * várias vezes na mesma carga de tela — pela lista de contas, pelo painel,
 * pelas contas a pagar, pelas metas. A memória abaixo guarda o resultado até
 * a próxima escrita no banco, então o custo é pago uma vez só.
 */
let balanceCache = { version: -1, value: null };

function calculateBalances() {
  if (balanceCache.value && balanceCache.version === repo.version()) {
    return { ...balanceCache.value };
  }
  const computed = computeBalances();
  balanceCache = { version: repo.version(), value: computed };
  return { ...computed };
}

function computeBalances() {
  const balances = {};
  for (const account of repo.all('bank_accounts')) {
    balances[account.id] = toNumber(account.initialBalance);
  }

  const add = (id, value) => {
    if (balances[id] !== undefined) balances[id] += toNumber(value);
  };

  for (const row of repo.query('SELECT bank_account_id, SUM(amount) AS total FROM incomes GROUP BY bank_account_id')) {
    add(row.bankAccountId, row.total);
  }
  for (const row of repo.query(
    `SELECT bank_account_id, SUM(amount) AS total FROM expenses
      WHERE status = 'PAGO' AND payment_method IN ('PIX', 'DEBITO', 'DINHEIRO')
      GROUP BY bank_account_id`
  )) {
    add(row.bankAccountId, -row.total);
  }
  for (const row of repo.query(
    `SELECT paid_from_bank_account_id AS bank_account_id, SUM(total_amount) AS total
       FROM card_invoices WHERE status = 'PAGA' GROUP BY paid_from_bank_account_id`
  )) {
    add(row.bankAccountId, -row.total);
  }
  for (const row of repo.query('SELECT bank_account_id, SUM(amount) AS total FROM investment_contributions GROUP BY bank_account_id')) {
    add(row.bankAccountId, -row.total);
  }
  // Dinheiro guardado numa meta sai da conta de verdade, como acontece quando
  // você usa a caixinha do próprio banco — o extrato mostra essa saída, então
  // descontar aqui é o que mantém o app batendo com o banco. Depósito sem
  // conta de origem (metas antigas, digitadas à mão) não mexe em saldo nenhum.
  for (const row of repo.query(
    "SELECT bank_account_id, SUM(amount) AS total FROM goal_deposits WHERE bank_account_id <> '' GROUP BY bank_account_id"
  )) {
    add(row.bankAccountId, -row.total);
  }
  for (const row of repo.query('SELECT from_account_id AS bank_account_id, SUM(amount) AS total FROM transfers GROUP BY from_account_id')) {
    add(row.bankAccountId, -row.total);
  }
  for (const row of repo.query('SELECT to_account_id AS bank_account_id, SUM(amount) AS total FROM transfers GROUP BY to_account_id')) {
    add(row.bankAccountId, row.total);
  }

  for (const id of Object.keys(balances)) balances[id] = roundCurrency(balances[id]);
  return balances;
}

/** Grava o saldo calculado na tabela, para leitura rápida e para o backup. */
function syncBalances() {
  const balances = calculateBalances();
  const stamp = now();
  repo.transaction(() => {
    for (const [id, balance] of Object.entries(balances)) {
      repo.run('UPDATE bank_accounts SET current_balance = ?, updated_at = ? WHERE id = ?', [balance, stamp, id]);
    }
  });
  return balances;
}

function getBalance(id) {
  return calculateBalances()[id] || 0;
}

// ---------------------------------------------------------------------------
// CRUD de contas
// ---------------------------------------------------------------------------

function list() {
  const balances = calculateBalances();
  return repo.all('bank_accounts', 'status, name COLLATE NOCASE').map(account => ({
    ...account,
    currentBalance: balances[account.id] ?? toNumber(account.initialBalance)
  }));
}

function getById(id) {
  const account = repo.findById('bank_accounts', id);
  if (!account) throw new Error('Conta bancária não encontrada.');
  return account;
}

function requireActive(id) {
  const account = getById(id);
  if (account.status !== 'ATIVA') throw new Error(`A conta ${account.name} está inativa.`);
  return account;
}

function create(data) {
  required(data, ['name', 'bankName', 'accountType']);
  const item = {
    id: generateId('account'),
    name: String(data.name).trim(),
    bankName: String(data.bankName).trim(),
    accountType: data.accountType,
    initialBalance: roundCurrency(data.initialBalance),
    currentBalance: roundCurrency(data.initialBalance),
    color: data.color || '#4ea8ff',
    status: data.status || 'ATIVA',
    createdAt: now(),
    updatedAt: now()
  };
  repo.insert('bank_accounts', item);
  logActivity('BANK_ACCOUNT_CREATED', `Conta ${item.name} adicionada`, 'bankAccount', item.id);
  return item;
}

function update(id, data) {
  getById(id);
  const payload = { ...data, initialBalance: roundCurrency(data.initialBalance) };
  delete payload.currentBalance;
  const result = repo.update('bank_accounts', id, payload);
  syncBalances();
  return result;
}

function toggleStatus(id) {
  const account = getById(id);
  return repo.update('bank_accounts', id, { status: account.status === 'ATIVA' ? 'INATIVA' : 'ATIVA' });
}

/**
 * Excluir conta só é permitido quando nada aponta para ela — caso contrário o
 * histórico ficaria órfão e os saldos não fechariam. Inativar é o caminho
 * normal para uma conta que você não usa mais.
 */
function remove(id) {
  const account = getById(id);
  const uses =
    repo.count('incomes', 'bank_account_id = ?', [id]) +
    repo.count('expenses', 'bank_account_id = ?', [id]) +
    repo.count('investment_contributions', 'bank_account_id = ?', [id]) +
    repo.count('card_invoices', 'paid_from_bank_account_id = ?', [id]) +
    repo.count('transfers', 'from_account_id = ? OR to_account_id = ?', [id, id]);
  if (uses > 0) {
    throw new Error(
      `${account.name} tem ${uses} lançamento(s) vinculado(s). Inative a conta em vez de excluir para preservar o histórico.`
    );
  }
  return repo.remove('bank_accounts', id);
}

// ---------------------------------------------------------------------------
// Extrato consolidado da conta
// ---------------------------------------------------------------------------

function getMovements(id, limit = 200) {
  getById(id);
  const movements = [];

  for (const item of repo.query('SELECT * FROM incomes WHERE bank_account_id = ?', [id])) {
    movements.push({ ...item, movementType: 'income', movementLabel: 'Entrada', signedAmount: toNumber(item.amount) });
  }
  for (const item of repo.query(
    `SELECT * FROM expenses WHERE bank_account_id = ? AND status = 'PAGO' AND payment_method IN ('PIX','DEBITO','DINHEIRO')`,
    [id]
  )) {
    movements.push({ ...item, movementType: 'expense', movementLabel: 'Saída', signedAmount: -toNumber(item.amount) });
  }
  for (const item of repo.query('SELECT * FROM investment_contributions WHERE bank_account_id = ?', [id])) {
    movements.push({ ...item, movementType: 'contribution', movementLabel: 'Aporte', signedAmount: -toNumber(item.amount) });
  }
  for (const item of repo.query(`SELECT * FROM card_invoices WHERE paid_from_bank_account_id = ? AND status = 'PAGA'`, [id])) {
    movements.push({
      ...item,
      date: dateOnly(item.paidAt),
      description: 'Pagamento de fatura',
      movementType: 'invoice',
      movementLabel: 'Fatura',
      signedAmount: -toNumber(item.totalAmount)
    });
  }
  for (const item of repo.query('SELECT * FROM transfers WHERE from_account_id = ? OR to_account_id = ?', [id, id])) {
    const outgoing = item.fromAccountId === id;
    movements.push({
      ...item,
      description: item.description || 'Transferência entre contas',
      movementType: outgoing ? 'transferOut' : 'transferIn',
      movementLabel: outgoing ? 'Transferência enviada' : 'Transferência recebida',
      signedAmount: outgoing ? -toNumber(item.amount) : toNumber(item.amount)
    });
  }

  return movements
    .sort((a, b) => String(b.date || b.createdAt).localeCompare(String(a.date || a.createdAt)))
    .slice(0, Number(limit) || 200);
}

// ---------------------------------------------------------------------------
// Transferências entre contas
//
// Neutras no resultado do mês: saem de uma conta e entram em outra sem contar
// como entrada nem como saída. Na planilha isso não existia e distorcia o
// total de entradas/saídas de quem movia dinheiro entre contas.
// ---------------------------------------------------------------------------

function listTransfers(filters = {}) {
  const items = repo.all('transfers', 'date DESC, created_at DESC');
  if (!filters.year) return items;
  return items.filter(item => {
    const [year, month] = String(item.date).split('-');
    if (String(year) !== String(filters.year)) return false;
    if (filters.month && filters.month !== 'all' && Number(month) !== Number(filters.month)) return false;
    return true;
  });
}

function createTransfer(data) {
  required(data, ['fromAccountId', 'toAccountId', 'amount', 'date']);
  if (data.fromAccountId === data.toAccountId) throw new Error('Escolha contas diferentes para a transferência.');
  const amount = roundCurrency(data.amount);
  if (amount <= 0) throw new Error('O valor da transferência deve ser maior que zero.');

  const from = requireActive(data.fromAccountId);
  const to = requireActive(data.toAccountId);

  const item = {
    id: generateId('transfer'),
    fromAccountId: from.id,
    toAccountId: to.id,
    amount,
    date: dateOnly(data.date),
    description: data.description || `Transferência ${from.name} → ${to.name}`,
    notes: data.notes || '',
    createdAt: now(),
    updatedAt: now()
  };
  repo.insert('transfers', item);
  logActivity('TRANSFER_CREATED', `${formatBRL(amount)} de ${from.name} para ${to.name}`, 'transfer', item.id);
  syncBalances();
  return item;
}

function updateTransfer(id, data) {
  const current = repo.findById('transfers', id);
  if (!current) throw new Error('Transferência não encontrada.');
  if ((data.fromAccountId || current.fromAccountId) === (data.toAccountId || current.toAccountId)) {
    throw new Error('Escolha contas diferentes para a transferência.');
  }
  const result = repo.update('transfers', id, {
    ...data,
    amount: roundCurrency(data.amount ?? current.amount),
    date: dateOnly(data.date || current.date)
  });
  syncBalances();
  return result;
}

function deleteTransfer(id) {
  const removed = repo.remove('transfers', id);
  syncBalances();
  return removed;
}

module.exports = {
  BANK_METHODS,
  calculateBalances,
  syncBalances,
  getBalance,
  list,
  getById,
  requireActive,
  create,
  update,
  toggleStatus,
  remove,
  getMovements,
  listTransfers,
  createTransfer,
  updateTransfer,
  deleteTransfer
};
