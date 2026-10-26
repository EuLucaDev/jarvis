'use strict';

const crypto = require('node:crypto');

const MONTH_LABELS = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

const generateId = (prefix = 'id') => `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
const now = () => new Date().toISOString();

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number(fallback) || 0;
}

function roundCurrency(value) {
  return Math.round((toNumber(value) + Number.EPSILON) * 100) / 100;
}

const snakeToCamel = value => String(value).replace(/_([a-z])/g, (_, char) => char.toUpperCase());
const camelToSnake = value => String(value).replace(/[A-Z]/g, char => `_${char.toLowerCase()}`);

/** Linha do SQLite -> objeto camelCase, o formato que a interface consome. */
function rowToObject(row) {
  if (!row) return null;
  const result = {};
  for (const [key, value] of Object.entries(row)) result[snakeToCamel(key)] = value;
  return result;
}

const rowsToObjects = rows => (rows || []).map(rowToObject);

function dateOnly(value) {
  if (!value) return '';
  if (value instanceof Date) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }
  return String(value).slice(0, 10);
}

const monthKey = value => dateOnly(value).slice(0, 7);

function addMonths(value, amount) {
  const parts = dateOnly(value).split('-').map(Number);
  const date = new Date(parts[0], (parts[1] || 1) - 1 + Number(amount || 0), parts[2] || 1, 12);
  return dateOnly(date);
}

/**
 * Em qual fatura cai uma compra. Comprou depois do fechamento, entra na
 * fatura do mês seguinte. Mesma regra da planilha original.
 */
function invoiceMonthForPurchase(purchaseDate, closingDay) {
  const iso = dateOnly(purchaseDate);
  if (!iso) return '';
  const day = Number(iso.split('-')[2]) || 1;
  const close = toNumber(closingDay);
  return monthKey(close > 0 && day > close ? addMonths(iso, 1) : iso);
}

/**
 * Data de vencimento de uma fatura de referência. Quando o vencimento cai
 * antes ou no mesmo dia do fechamento, ele pertence ao mês seguinte
 * (ex.: fecha dia 28, vence dia 5 — o dia 5 é do mês que vem).
 */
function invoiceDueDate(referenceMonth, dueDay, closingDay) {
  if (!referenceMonth) return '';
  const parts = String(referenceMonth).split('-').map(Number);
  let year = parts[0];
  let month = parts[1];
  const due = Math.max(1, toNumber(dueDay, 1));
  const close = toNumber(closingDay);
  if (close > 0 && due <= close) {
    const next = addMonths(`${referenceMonth}-01`, 1).split('-').map(Number);
    year = next[0];
    month = next[1];
  }
  const lastDay = new Date(year, month, 0).getDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(Math.min(due, lastDay)).padStart(2, '0')}`;
}

function sum(items, key) {
  return (items || []).reduce((total, item) => {
    const value = typeof key === 'function' ? key(item) : key ? item[key] : item;
    return total + toNumber(value);
  }, 0);
}

function required(data, fields) {
  for (const fieldName of fields || []) {
    const value = data[fieldName];
    if (value === undefined || value === null || String(value).trim() === '') {
      throw new Error(`Preencha o campo obrigatório: ${FIELD_LABELS[fieldName] || fieldName}.`);
    }
  }
}

const FIELD_LABELS = {
  name: 'nome',
  source: 'origem',
  category: 'categoria',
  bankAccountId: 'conta bancária',
  amount: 'valor',
  date: 'data',
  description: 'descrição',
  paymentMethod: 'forma de pagamento',
  bankName: 'banco',
  accountType: 'tipo de conta',
  cardType: 'tipo de cartão',
  estimatedAmount: 'valor estimado',
  dueDay: 'dia do vencimento',
  investmentId: 'investimento',
  institution: 'instituição',
  targetAmount: 'valor da meta',
  fromAccountId: 'conta de origem',
  toAccountId: 'conta de destino'
};

/** Confere se a data cai no período do filtro (ano + mês opcional). */
function matchesPeriod(date, filters = {}) {
  if (!date) return false;
  const parts = dateOnly(date).split('-');
  if (filters.year && String(parts[0]) !== String(filters.year)) return false;
  if (filters.month && filters.month !== 'all' && Number(parts[1]) !== Number(filters.month)) return false;
  return true;
}

function filterList(items, filters = {}, options = {}) {
  return (items || []).filter(item => {
    const date = item[options.dateField || 'date'];
    if (date && !matchesPeriod(date, filters)) return false;
    if (filters.account && filters.account !== 'all' && item[options.accountField || 'bankAccountId'] !== filters.account) return false;
    if (filters.card && filters.card !== 'all' && item[options.cardField || 'creditCardId'] !== filters.card) return false;
    if (filters.category && filters.category !== 'all' && item.category !== filters.category) return false;
    return true;
  });
}

const formatBRL = value =>
  `R$ ${toNumber(value).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;

module.exports = {
  MONTH_LABELS,
  generateId,
  now,
  toNumber,
  roundCurrency,
  snakeToCamel,
  camelToSnake,
  rowToObject,
  rowsToObjects,
  dateOnly,
  monthKey,
  addMonths,
  invoiceMonthForPurchase,
  invoiceDueDate,
  sum,
  required,
  matchesPeriod,
  filterList,
  formatBRL
};
