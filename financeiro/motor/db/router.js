'use strict';

const repo = require('./repository');
const catalog = require('./services/catalog');
const accounts = require('./services/accounts');
const cards = require('./services/cards');
const transactions = require('./services/transactions');
const investments = require('./services/investments');
const goals = require('./services/goals');
const dashboard = require('./services/dashboard');
const reports = require('./services/reports');
const importExport = require('./services/importExport');
const backup = require('./services/backup');
const attachments = require('./services/attachments');
const setup = require('./services/setup');
const categorizer = require('./services/categorizer');
const statement = require('./services/statement');
const importer = require('./services/importer');
const insights = require('./services/insights');

/**
 * Catálogo de operações expostas à interface. Cada chave vira um canal IPC.
 * É o equivalente ao Router.gs da planilha — mesma ideia, mesmos nomes onde
 * fazia sentido manter.
 */

// ---------------------------------------------------------------------------
// Carga inicial: tudo que a interface precisa para desenhar a primeira tela
// ---------------------------------------------------------------------------

function getInitialData(filters = {}) {
  const settings = catalog.getSettings();
  const scope = {
    year: Number(filters.year) || Number(settings.default_year) || new Date().getFullYear(),
    month: filters.month || 'all',
    account: filters.account || 'all',
    card: filters.card || 'all',
    category: filters.category || 'all'
  };

  return {
    profile: catalog.getProfile(),
    settings,
    filters: scope,
    categories: catalog.groupedCategories(),
    categoriesList: catalog.listCategories(),
    bankAccounts: accounts.list(),
    incomes: transactions.listIncomes({}),
    recurringIncomes: transactions.listRecurringIncomes(),
    expenses: transactions.listExpenses({}),
    fixedExpenses: transactions.listFixedExpenses(),
    transfers: accounts.listTransfers(),
    cardsBenefits: cards.list(),
    cardPurchases: repo.all('card_purchases'),
    cardInstallments: repo.all('card_installments'),
    cardInvoices: cards.getInvoicesDetailed(),
    investments: investments.list(),
    investmentContributions: investments.listContributions(),
    investmentOperations: investments.listOperations(),
    investmentIncome: investments.listIncome(),
    investmentPortfolio: investments.portfolioSummary(),
    investmentClasses: investments.ASSET_CLASSES,
    marketDataStatus: investments.marketStatus(),
    goals: goals.listGoals(),
    budgets: catalog.budgetMap(),
    payables: transactions.listPayables(60),
    activities: catalog.listActivities(30),
    dashboard: dashboard.getData(scope),
    attachmentCounts: {
      expense: attachments.countsByEntity('expense'),
      income: attachments.countsByEntity('income')
    },
    categoryRules: categorizer.listRules().slice(0, 200),
    nextActions: insights.nextActions(),
    availableYears: reports.availableYears(),
    needsOnboarding: setup.needsOnboarding()
  };
}

/** Recarga leve depois de uma alteração — evita reenviar o banco inteiro. */
function refresh(filters = {}) {
  return getInitialData(filters);
}

const handlers = {
  // --- Sistema / onboarding ------------------------------------------------
  'app:initialData': getInitialData,
  'app:refresh': refresh,
  'app:needsOnboarding': () => setup.needsOnboarding(),
  'app:completeOnboarding': data => {
    setup.completeOnboarding(data);
    return getInitialData();
  },

  // --- Perfil e configurações ----------------------------------------------
  'profile:get': () => catalog.getProfile(),
  'profile:save': data => catalog.saveProfile(data),
  'settings:get': () => catalog.getSettings(),
  'settings:set': (key, value, type) => catalog.setSetting(key, value, type),
  'settings:setMany': patch => catalog.setSettings(patch),

  // --- Categorias e orçamentos ---------------------------------------------
  'categories:list': () => catalog.listCategories(),
  'categories:grouped': () => catalog.groupedCategories(),
  'categories:create': (type, name, color) => catalog.createCategory(type, name, color),
  'categories:update': (type, id, data) => catalog.updateCategory(type, id, data),
  'categories:delete': (type, id) => catalog.deleteCategory(type, id),
  'budgets:get': month => catalog.budgetMap(month || ''),
  'budgets:save': (budgets, month) => catalog.saveBudgets(budgets, month || ''),

  // --- Contas bancárias ----------------------------------------------------
  'accounts:list': () => accounts.list(),
  'accounts:create': data => accounts.create(data),
  'accounts:update': (id, data) => accounts.update(id, data),
  'accounts:toggle': id => accounts.toggleStatus(id),
  'accounts:delete': id => accounts.remove(id),
  'accounts:movements': (id, limit) => accounts.getMovements(id, limit),
  'accounts:balance': id => accounts.getBalance(id),

  // --- Transferências ------------------------------------------------------
  'transfers:list': filters => accounts.listTransfers(filters),
  'transfers:create': data => accounts.createTransfer(data),
  'transfers:update': (id, data) => accounts.updateTransfer(id, data),
  'transfers:delete': id => accounts.deleteTransfer(id),

  // --- Entradas ------------------------------------------------------------
  'incomes:list': filters => transactions.listIncomes(filters),
  'incomes:create': data => transactions.createIncome(data),
  'incomes:update': (id, data) => transactions.updateIncome(id, data),
  'incomes:delete': id => transactions.deleteIncome(id),

  'recurringIncomes:list': () => transactions.listRecurringIncomes(),
  'recurringIncomes:create': data => transactions.createRecurringIncome(data),
  'recurringIncomes:update': (id, data) => transactions.updateRecurringIncome(id, data),
  'recurringIncomes:toggle': id => transactions.toggleRecurringIncomeStatus(id),
  'recurringIncomes:delete': id => transactions.deleteRecurringIncome(id),
  'recurringIncomes:generate': month => transactions.generateRecurringIncomesForMonth(month),

  // --- Saídas --------------------------------------------------------------
  'expenses:list': filters => transactions.listExpenses(filters),
  'expenses:create': data => transactions.createExpense(data),
  'expenses:update': (id, data) => transactions.updateExpense(id, data),
  'expenses:delete': id => transactions.deleteExpense(id),
  'expenses:markPaid': id => transactions.markExpenseAsPaid(id),
  'expenses:markManyPaid': ids => transactions.markManyAsPaid(ids),
  'expenses:bulkUpdate': (ids, changes) => transactions.bulkUpdate(ids, changes),
  'expenses:bulkDelete': ids => transactions.bulkDelete(ids),

  'fixedExpenses:list': () => transactions.listFixedExpenses(),
  'fixedExpenses:create': data => transactions.createFixedExpense(data),
  'fixedExpenses:update': (id, data) => transactions.updateFixedExpense(id, data),
  'fixedExpenses:toggle': id => transactions.toggleFixedExpenseStatus(id),
  'fixedExpenses:delete': id => transactions.deleteFixedExpense(id),
  'fixedExpenses:generate': month => transactions.generateFixedExpensesForMonth(month),

  'payables:list': days => transactions.listPayables(days),

  // --- Cartões e faturas ---------------------------------------------------
  'cards:list': () => cards.list(),
  'cards:create': data => cards.create(data),
  'cards:update': (id, data) => cards.update(id, data),
  'cards:toggle': id => cards.toggleStatus(id),
  'cards:delete': id => cards.remove(id),
  'cards:topUp': (id, amount) => cards.topUpBenefit(id, amount),
  'cards:usedLimit': id => cards.usedLimit(id),

  'invoices:list': cardId => cards.getInvoicesDetailed(cardId),
  'invoices:details': (cardId, month) => cards.getInvoiceDetails(cardId, month),
  'invoices:pay': (invoiceId, accountId) => cards.payInvoice(invoiceId, accountId),
  'invoices:recalculate': () => cards.recalculateByClosingDay(),

  // --- Investimentos e metas ----------------------------------------------
  'investments:list': () => investments.list(),
  'investments:create': data => investments.create(data),
  'investments:update': (id, data) => investments.update(id, data),
  'investments:toggle': id => investments.toggleStatus(id),
  'investments:delete': id => investments.remove(id),
  'investments:classes': () => investments.ASSET_CLASSES,
  'investments:portfolio': () => investments.portfolioSummary(),
  'investmentOperations:list': filters => investments.listOperations(filters),
  'investmentOperations:create': data => investments.createOperation(data),
  'investmentOperations:delete': id => investments.deleteOperation(id),
  'investmentIncome:list': filters => investments.listIncome(filters),
  'marketData:status': () => investments.marketStatus(),
  'marketData:search': (query, assetClass) => require('./services/market').searchAssets(query, assetClass),
  'marketData:refresh': () => investments.refreshMarketData(),
  'contributions:list': filters => investments.listContributions(filters),
  'contributions:create': data => investments.createContribution(data),
  'contributions:delete': id => investments.deleteContribution(id),

  'goals:list': () => goals.listGoals(),
  'goals:get': id => goals.getGoal(id),
  'goals:create': data => goals.createGoal(data),
  'goals:update': (id, data) => goals.updateGoal(id, data),
  'goals:delete': id => goals.deleteGoal(id),
  'goals:deposit': (id, data) => goals.deposit(id, data),
  'goals:deposits': id => goals.listDeposits(id),
  'goals:depositDelete': id => goals.deleteDeposit(id),
  'goals:items': id => goals.listItems(id),
  'goals:itemCreate': (goalId, data) => goals.createItem(goalId, data),
  'goals:itemUpdate': (id, data) => goals.updateItem(id, data),
  'goals:itemRemove': id => goals.removeItem(id),
  'goals:itemReorder': (goalId, ids) => goals.reorderItems(goalId, ids),
  'goals:itemPay': (id, data) => goals.payItem(id, data),
  'goals:itemUnpay': id => goals.unpayItem(id),

  // --- Análises com histórico ----------------------------------------------
  'insights:subscriptions': () => insights.detectSubscriptions(),
  'insights:monthClosing': month => insights.monthClosing(month),
  'insights:calendar': month => insights.monthCalendar(month),
  'insights:nextActions': () => insights.nextActions(),
  'insights:suggestBudgets': options => insights.suggestBudgets(options),
  'insights:budgetPace': month => insights.budgetPace(month),
  'insights:sameMonthLastYear': month => insights.sameMonthLastYear(month),
  'insights:checkOutlier': (description, amount, category) => insights.checkOutlier(description, amount, category),

  // --- Visão geral e relatórios -------------------------------------------
  'dashboard:get': filters => dashboard.getData(filters),
  'reports:full': filters => reports.fullReport(filters),
  'reports:statement': year => reports.monthlyStatement(year),
  'reports:categories': year => reports.categoryMatrix(year),
  'reports:comparison': year => reports.yearOverYear(year),
  'reports:ledger': filters => reports.periodLedger(filters),
  'reports:csv': filters => reports.toCSV(filters),

  // --- Dados: backup, importação, limpeza ---------------------------------
  'data:export': () => importExport.exportJSON(),
  'data:import': payload => importExport.importData(payload),
  'data:clearTransactions': () => importExport.clearTransactions(),
  'data:reset': () => importExport.resetAll(),

  'backup:list': () => backup.listBackups(),
  'backup:create': () => backup.createBackup('manual'),
  'backup:restore': filePath => backup.restoreBackup(filePath),
  'backup:delete': filePath => backup.deleteBackup(filePath),
  'backup:folder': () => backup.backupFolder(),

  // --- Anexos --------------------------------------------------------------
  'attachments:list': (type, id) => attachments.list(type, id),
  'attachments:add': (type, id, filePath) => attachments.add(type, id, filePath),
  'attachments:delete': id => attachments.remove(id),

  // --- Regras de categoria -------------------------------------------------
  'rules:list': () => categorizer.listRules(),
  'rules:save': data => categorizer.saveRule(data),
  'rules:delete': id => categorizer.deleteRule(id),
  'rules:learn': (description, category, kind) => categorizer.learn(description, category, kind, 'user'),
  'rules:apply': () => categorizer.applyRulesToUncategorized(),
  'rules:categorize': (description, kind) => categorizer.categorize(description, kind),

  // --- Extratos, faturas e comprovantes ------------------------------------
  'statement:readFile': (filePath, options) => statement.readFile(filePath, options),
  'statement:readText': (text, options) => statement.readText(text, options),

  // --- Importação em lote --------------------------------------------------
  'import:readBatch': (filePaths, options) => importer.readBatch(filePaths, options),
  'import:readPasted': (text, options) => importer.readPasted(text, options),
  'import:suggestTargets': session => importer.suggestTargets(session),
  'import:commit': (session, targets, options) => importer.commit(session, targets, options),
  'import:batches': limit => importer.listBatches(limit),
  'import:undo': batchId => importer.undoBatch(batchId),

  // --- Lançamento escrito à mão --------------------------------------------
  // Barra rápida: "paguei 340 no mercado ontem no crédito em 3x". Tudo sai de
  // regras — não há assistente nenhum por trás disto.
  'entries:parse': text => categorizer.parseEntry(text, {
    accounts: accounts.list(),
    cards: cards.list()
  })
};

module.exports = { handlers, getInitialData };
