'use strict';

const repo = require('../repository');
const accounts = require('./accounts');
const cards = require('./cards');
const dashboard = require('./dashboard');
const { MONTH_LABELS, toNumber, roundCurrency, sum, matchesPeriod, monthKey } = require('../utils');

/**
 * Relatórios: as visões que a planilha não dava — comparativo ano a ano,
 * evolução de cada categoria mês a mês e um resumo do tipo DRE.
 */

// ---------------------------------------------------------------------------
// Resumo mensal (estilo DRE)
// ---------------------------------------------------------------------------

function monthlyStatement(year) {
  const incomes = repo.all('incomes');
  const expenses = repo.all('expenses');
  const contributions = repo.all('investment_contributions');
  const invoices = cards.getInvoices();

  const rows = [];
  for (let month = 1; month <= 12; month++) {
    const scope = { year, month };
    const income = sum(incomes.filter(i => matchesPeriod(i.date, scope)), 'amount');
    const fixed = sum(
      expenses.filter(e => e.type === 'FIXA' && e.status === 'PAGO' && e.paymentMethod !== 'CARTAO_CREDITO' && matchesPeriod(e.date, scope)),
      'amount'
    );
    const variable = sum(
      expenses.filter(e => e.type !== 'FIXA' && e.status === 'PAGO' && e.paymentMethod !== 'CARTAO_CREDITO' && matchesPeriod(e.date, scope)),
      'amount'
    );
    const invoicesPaid = sum(invoices.filter(i => i.status === 'PAGA' && matchesPeriod(i.paidAt, scope)), 'totalAmount');
    const invested = sum(contributions.filter(c => matchesPeriod(c.date, scope)), 'amount');
    const outflow = fixed + variable + invoicesPaid + invested;

    rows.push({
      month,
      label: MONTH_LABELS[month - 1],
      income: roundCurrency(income),
      fixed: roundCurrency(fixed),
      variable: roundCurrency(variable),
      invoices: roundCurrency(invoicesPaid),
      invested: roundCurrency(invested),
      outflow: roundCurrency(outflow),
      result: roundCurrency(income - outflow),
      savingRate: income ? ((income - outflow) / income) * 100 : 0
    });
  }

  const totals = rows.reduce(
    (acc, row) => {
      for (const key of ['income', 'fixed', 'variable', 'invoices', 'invested', 'outflow', 'result']) {
        acc[key] = roundCurrency(acc[key] + row[key]);
      }
      return acc;
    },
    { income: 0, fixed: 0, variable: 0, invoices: 0, invested: 0, outflow: 0, result: 0 }
  );
  totals.savingRate = totals.income ? (totals.result / totals.income) * 100 : 0;
  totals.label = 'Total';

  return { year, rows, totals };
}

// ---------------------------------------------------------------------------
// Categoria mês a mês — onde o dinheiro vai e como isso muda ao longo do ano
// ---------------------------------------------------------------------------

function categoryMatrix(year) {
  const rows = repo.query(
    `SELECT category, substr(date, 1, 7) AS ref, SUM(amount) AS total
       FROM expenses
      WHERE status = 'PAGO' AND substr(date, 1, 4) = ?
      GROUP BY category, ref`,
    [String(year)]
  );

  const byCategory = new Map();
  for (const row of rows) {
    const category = row.category || 'Outros';
    if (!byCategory.has(category)) byCategory.set(category, { category, months: Array(12).fill(0), total: 0 });
    const entry = byCategory.get(category);
    const monthIndex = Number(String(row.ref).split('-')[1]) - 1;
    if (monthIndex >= 0 && monthIndex < 12) {
      entry.months[monthIndex] = roundCurrency(row.total);
      entry.total = roundCurrency(entry.total + toNumber(row.total));
    }
  }

  const list = [...byCategory.values()].sort((a, b) => b.total - a.total);
  const monthTotals = Array(12)
    .fill(0)
    .map((_, index) => roundCurrency(sum(list, item => item.months[index])));

  return {
    year,
    categories: list.map(item => ({
      ...item,
      average: roundCurrency(item.total / 12),
      // Meses em que houve gasto — média só faz sentido sobre eles.
      activeMonths: item.months.filter(v => v > 0).length
    })),
    monthTotals,
    grandTotal: roundCurrency(sum(monthTotals))
  };
}

// ---------------------------------------------------------------------------
// Comparativo ano a ano
// ---------------------------------------------------------------------------

function yearOverYear(year) {
  const build = target => {
    const statement = monthlyStatement(target);
    return { year: target, ...statement.totals, rows: statement.rows };
  };
  const current = build(year);
  const previous = build(year - 1);
  const delta = (a, b) => ({ value: roundCurrency(a - b), pct: b ? ((a - b) / Math.abs(b)) * 100 : a ? 100 : 0 });

  return {
    current,
    previous,
    deltas: {
      income: delta(current.income, previous.income),
      outflow: delta(current.outflow, previous.outflow),
      result: delta(current.result, previous.result),
      invested: delta(current.invested, previous.invested)
    }
  };
}

/** Anos que efetivamente têm lançamento — alimenta o seletor de período. */
function availableYears() {
  const rows = repo.query(
    `SELECT DISTINCT substr(date, 1, 4) AS year FROM incomes
      UNION SELECT DISTINCT substr(date, 1, 4) FROM expenses
      UNION SELECT DISTINCT substr(date, 1, 4) FROM investment_contributions
      ORDER BY year`
  );
  const years = rows.map(r => Number(r.year)).filter(Boolean);
  const currentYear = new Date().getFullYear();
  if (!years.includes(currentYear)) years.push(currentYear);
  return [...new Set(years)].sort((a, b) => b - a);
}

// ---------------------------------------------------------------------------
// Extrato do período (base do CSV e da lista de lançamentos)
// ---------------------------------------------------------------------------

function periodLedger(filters = {}) {
  const accountsById = new Map(accounts.list().map(a => [a.id, a.name]));
  const cardsById = new Map(cards.list().map(c => [c.id, c.name]));
  const rows = [];

  for (const item of repo.all('incomes')) {
    if (!matchesPeriod(item.date, filters)) continue;
    rows.push({
      kind: 'Entrada', date: item.date, description: item.source || item.description,
      category: item.category, account: accountsById.get(item.bankAccountId) || '',
      method: 'Depósito', status: 'PAGO', amount: toNumber(item.amount), signed: toNumber(item.amount), id: item.id
    });
  }
  for (const item of repo.all('expenses')) {
    if (!matchesPeriod(item.date, filters)) continue;
    rows.push({
      kind: item.type === 'FIXA' ? 'Saída fixa' : 'Saída', date: item.date, description: item.description,
      category: item.category, account: accountsById.get(item.bankAccountId) || cardsById.get(item.creditCardId) || '',
      method: String(item.paymentMethod).replaceAll('_', ' '), status: item.status,
      amount: toNumber(item.amount), signed: -toNumber(item.amount), id: item.id
    });
  }
  for (const item of repo.all('investment_contributions')) {
    if (!matchesPeriod(item.date, filters)) continue;
    rows.push({
      kind: 'Aporte', date: item.date, description: item.description || 'Aporte',
      category: 'Investimento', account: accountsById.get(item.bankAccountId) || '',
      method: 'Transferência', status: 'PAGO', amount: toNumber(item.amount), signed: -toNumber(item.amount), id: item.id
    });
  }
  for (const item of repo.all('transfers')) {
    if (!matchesPeriod(item.date, filters)) continue;
    rows.push({
      kind: 'Transferência', date: item.date, description: item.description,
      category: 'Entre contas',
      account: `${accountsById.get(item.fromAccountId) || ''} → ${accountsById.get(item.toAccountId) || ''}`,
      method: 'Transferência', status: 'PAGO', amount: toNumber(item.amount), signed: 0, id: item.id
    });
  }

  return rows.sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

function toCSV(filters = {}) {
  const rows = periodLedger(filters);
  const header = ['Tipo', 'Data', 'Descrição', 'Categoria', 'Conta / cartão', 'Forma', 'Status', 'Valor'];
  const lines = [header, ...rows.map(r => [
    r.kind, r.date, r.description, r.category, r.account, r.method, r.status,
    String(r.amount.toFixed(2)).replace('.', ',')
  ])];
  // BOM para o Excel abrir com acentuação correta no Windows.
  return '﻿' + lines.map(line => line.map(cell => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(';')).join('\r\n');
}

/** Pacote completo do relatório, pronto para a tela e para a impressão/PDF. */
function fullReport(filters = {}) {
  const year = Number(filters.year) || new Date().getFullYear();
  return {
    year,
    statement: monthlyStatement(year),
    categories: categoryMatrix(year),
    comparison: yearOverYear(year),
    dashboard: dashboard.getData({ ...filters, year }),
    ledger: periodLedger({ ...filters, year }).slice(0, 300),
    availableYears: availableYears(),
    generatedAt: new Date().toISOString()
  };
}

module.exports = {
  monthlyStatement,
  categoryMatrix,
  yearOverYear,
  availableYears,
  periodLedger,
  toCSV,
  fullReport
};
