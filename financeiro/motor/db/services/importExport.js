'use strict';

const repo = require('../repository');
const catalog = require('./catalog');
const accounts = require('./accounts');
const cards = require('./cards');
const setup = require('./setup');
const { generateId, now, toNumber } = require('../utils');

/**
 * Formato de troca do app. É o que garante levar a carteira para outro
 * computador: exporta um JSON, importa no outro, tudo volta igual.
 *
 * A versão 2 é o formato exportado pela planilha antiga do Google — a
 * importação aceita as duas, para que o histórico da planilha possa ser
 * trazido para cá quando você quiser.
 */
const EXPORT_VERSION = 5;

const TABLES = [
  'profile', 'bank_accounts', 'incomes', 'recurring_incomes', 'expenses', 'fixed_expenses',
  'cards_benefits', 'card_purchases', 'card_installments', 'card_invoices',
  'investments', 'investment_contributions', 'investment_operations', 'investment_income',
  'investment_snapshots', 'transfers', 'goals', 'goal_deposits', 'goal_items', 'budgets',
  'categories', 'settings', 'activities'
];

function exportData() {
  const payload = { version: EXPORT_VERSION, exportedAt: now(), app: 'Carteira Pessoal' };
  for (const table of TABLES) payload[table] = repo.all(table);
  // Tokens de serviços externos ficam somente no computador. Backups podem
  // circular ou ir para nuvem e nunca devem carregar uma credencial de API.
  payload.settings = payload.settings.filter(item => !['brapi_token', 'openai_api_key'].includes(String(item.key).toLowerCase()));
  // Chaves com os nomes antigos, para que backups deste app possam ser lidos
  // por qualquer ferramenta que já entendia o formato da planilha.
  payload.creditCards = payload.cards_benefits;
  payload.bankAccounts = payload.bank_accounts;
  catalog.logActivity('DATA_EXPORTED', 'Backup JSON exportado', 'database', 'all');
  return payload;
}

function exportJSON() {
  return JSON.stringify(exportData(), null, 2);
}

const camelKeys = obj => {
  const { camelToSnake } = require('../utils');
  const result = {};
  for (const [key, value] of Object.entries(obj || {})) result[camelToSnake(key)] = value;
  return result;
};

/** Aceita tanto o formato deste app quanto o exportado pela planilha antiga. */
function normalizePayload(raw) {
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!data || typeof data !== 'object') throw new Error('Arquivo inválido.');

  const pick = (...names) => {
    for (const name of names) {
      if (Array.isArray(data[name])) return data[name];
    }
    return [];
  };

  const normalized = {
    profile: Array.isArray(data.profile) ? data.profile : data.profile ? [data.profile] : [],
    bank_accounts: pick('bank_accounts', 'bankAccounts'),
    incomes: pick('incomes'),
    recurring_incomes: pick('recurring_incomes', 'recurringIncomes'),
    expenses: pick('expenses'),
    fixed_expenses: pick('fixed_expenses', 'fixedExpenses'),
    cards_benefits: pick('cards_benefits', 'cardsBenefits', 'creditCards'),
    card_purchases: pick('card_purchases', 'cardPurchases'),
    card_installments: pick('card_installments', 'cardInstallments'),
    card_invoices: pick('card_invoices', 'cardInvoices'),
    investments: pick('investments'),
    investment_contributions: pick('investment_contributions', 'investmentContributions'),
    investment_operations: pick('investment_operations', 'investmentOperations'),
    investment_income: pick('investment_income', 'investmentIncome'),
    investment_snapshots: pick('investment_snapshots', 'investmentSnapshots'),
    transfers: pick('transfers'),
    goals: pick('goals'),
    goal_deposits: pick('goal_deposits', 'goalDeposits'),
    goal_items: pick('goal_items', 'goalItems'),
    budgets: pick('budgets'),
    activities: pick('activities'),
    categories: [],
    settings: []
  };

  // Categorias: array plano (novo) ou objeto agrupado por tipo (planilha).
  if (Array.isArray(data.categories)) {
    normalized.categories = data.categories;
  } else if (data.categories && typeof data.categories === 'object') {
    for (const [type, items] of Object.entries(data.categories)) {
      for (const item of items || []) {
        normalized.categories.push(
          typeof item === 'string'
            ? { id: generateId('cat'), type, name: item, createdAt: now(), updatedAt: now() }
            : { ...item, type: item.type || type }
        );
      }
    }
  }

  // Configurações: array de linhas (novo) ou objeto chave/valor (planilha).
  if (Array.isArray(data.settings)) {
    normalized.settings = data.settings;
  } else if (data.settings && typeof data.settings === 'object') {
    for (const [key, value] of Object.entries(data.settings)) {
      normalized.settings.push({
        key,
        value: String(value),
        type: typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'text',
        description: '',
        updatedAt: now()
      });
    }
  }

  if (!normalized.bank_accounts.length && !normalized.expenses.length && !normalized.incomes.length && !normalized.investments.length) {
    throw new Error('Arquivo incompatível com a Carteira Pessoal — nenhum dado reconhecido.');
  }
  return normalized;
}

/**
 * Substitui o conteúdo atual pelo do arquivo. Roda numa transação: se algo
 * falhar no meio, o banco volta exatamente ao que era antes.
 */
function importData(raw) {
  const data = normalizePayload(raw);

  return repo.transaction(() => {
    // Ordem inversa das dependências para não bater em chave estrangeira.
    for (const table of [...TABLES].reverse()) {
      if (table === 'settings') continue; // preferências do app permanecem
      repo.clear(table);
    }

    const stamp = now();
    const withDefaults = (item, extra = {}) => ({
      createdAt: stamp,
      updatedAt: stamp,
      ...camelKeys(item),
      ...extra
    });

    if (data.profile.length) {
      const profile = data.profile[0];
      repo.insert('profile', {
        id: profile.id || generateId('profile'),
        name: profile.name || 'Minha Carteira',
        monthly_goal: toNumber(profile.monthlyGoal ?? profile.monthly_goal),
        emergency_reserve_goal: toNumber(profile.emergencyReserveGoal ?? profile.emergency_reserve_goal),
        created_at: profile.createdAt || profile.created_at || stamp,
        updated_at: stamp
      });
    }

    repo.insertMany('bank_accounts', data.bank_accounts.map(item => withDefaults(item)));
    repo.insertMany(
      'cards_benefits',
      data.cards_benefits.map(item => withDefaults(item, { cardType: item.cardType || item.card_type || 'CREDITO' }))
    );
    repo.insertMany('categories', data.categories.map(item => withDefaults(item, { id: item.id || generateId('cat') })));
    repo.insertMany('incomes', data.incomes.map(item => withDefaults(item)));
    repo.insertMany('recurring_incomes', data.recurring_incomes.map(item => withDefaults(item)));
    repo.insertMany('fixed_expenses', data.fixed_expenses.map(item => withDefaults(item)));
    repo.insertMany('card_purchases', data.card_purchases.map(item => withDefaults(item)));
    repo.insertMany('expenses', data.expenses.map(item => withDefaults(item)));
    repo.insertMany('card_installments', data.card_installments.map(item => withDefaults(item)));
    // As faturas são reconstruídas logo abaixo, mas precisam ser restauradas
    // antes: é delas que vem a conta que pagou cada fatura — informação que não
    // existe nas parcelas e sem a qual os saldos não fecham.
    repo.insertMany('card_invoices', data.card_invoices.map(item => withDefaults(item)));
    repo.insertMany('investments', data.investments.map(item => withDefaults(item)));
    repo.insertMany('investment_contributions', data.investment_contributions.map(item => withDefaults(item)));
    repo.insertMany('investment_operations', data.investment_operations.map(item => withDefaults(item)));
    repo.insertMany('investment_income', data.investment_income.map(item => withDefaults(item)));
    repo.insertMany('investment_snapshots', data.investment_snapshots.map(item => withDefaults(item)));
    repo.insertMany('transfers', data.transfers.map(item => withDefaults(item)));
    repo.insertMany('goals', data.goals.map(item => withDefaults(item, { id: item.id || generateId('goal') })));
    repo.insertMany('goal_deposits', data.goal_deposits.map(item => withDefaults(item, { id: item.id || generateId('deposit') })));
    repo.insertMany('goal_items', data.goal_items.map(item => withDefaults(item, { id: item.id || generateId('goalitem') })));
    repo.insertMany('budgets', data.budgets.map(item => withDefaults(item, { id: item.id || generateId('budget') })));
    repo.insertMany('activities', data.activities.slice(0, 500).map(item => withDefaults(item)));

    setup.ensureDefaultSettings();
    if (!catalog.listCategories().length) setup.ensureDefaultCategories();
    catalog.setSetting('onboarding_done', 'true', 'boolean');

    // Faturas e saldos são derivados — recalculados, nunca importados crus.
    cards.rebuildInvoices();
    accounts.syncBalances();

    catalog.logActivity('DATA_IMPORTED', 'Dados importados de um backup', 'database', 'all');
    return {
      imported: true,
      counts: {
        contas: data.bank_accounts.length,
        entradas: data.incomes.length,
        saidas: data.expenses.length,
        cartoes: data.cards_benefits.length,
        investimentos: data.investments.length,
        transferencias: data.transfers.length,
        metas: data.goals.length
      }
    };
  });
}

/** Apaga os lançamentos mantendo perfil, categorias e preferências. */
function clearTransactions() {
  return repo.transaction(() => {
    for (const table of [
      'card_installments', 'card_purchases', 'card_invoices', 'investment_snapshots',
      'investment_income', 'investment_operations', 'investment_contributions',
      'transfers', 'incomes', 'expenses'
    ]) {
      repo.clear(table);
    }
    accounts.syncBalances();
    catalog.logActivity('DATA_CLEARED', 'Lançamentos apagados', 'database', 'transactions');
    return true;
  });
}

/** Zera tudo e volta ao estado de app recém-instalado. */
function resetAll() {
  return repo.transaction(() => {
    for (const table of [...TABLES].reverse()) repo.clear(table);
    setup.ensureDefaultCategories();
    setup.ensureDefaultSettings();
    catalog.setSetting('onboarding_done', 'false', 'boolean');
    return true;
  });
}

module.exports = { EXPORT_VERSION, exportData, exportJSON, importData, clearTransactions, resetAll };
