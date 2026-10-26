'use strict';

/**
 * Ponte das telas do financeiro com o Jarvis. É a mesma `window.api` da Carteira Pessoal (preload.js do
 * Electron), mas as chamadas vão por HTTP para o núcleo do Jarvis (/api/fin/c/<operação>), que repassa ao
 * motor financeiro. Diálogos de arquivo são os do sistema, abertos pelo núcleo.
 */
(() => {
  const ouvintes = { navigate: null, action: null, market: null };

  async function call(channel, ...args) {
    const res = await fetch(`/api/fin/c/${channel}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args })
    });
    let response = null;
    try { response = await res.json(); } catch (error) { /* sem corpo */ }
    if (!response) throw new Error('Sem resposta do Jarvis.');
    if (response.ok === false) throw new Error(response.error || response.detail || 'Erro inesperado.');
    return response.data;
  }

  /** Salvar arquivo: o Jarvis pergunta onde (diálogo do sistema) e grava. Devolve o caminho ou null. */
  function salvarArquivo(options = {}) {
    return call('dialog:saveFile', options);
  }

  async function enviarArquivos(files) {
    const caminhos = [];
    for (const file of files) {
      const res = await fetch(`/api/fin/arquivo?nome=${encodeURIComponent(file.name)}`, { method: 'POST', body: file });
      const r = await res.json().catch(() => null);
      if (r?.ok && r.data) caminhos.push(r.data);
    }
    return caminhos;
  }

  /** Confirmação dentro da página (o WebView do app não tem a caixa nativa do navegador). */
  function confirmar({ title, message, detail, confirmLabel, danger } = {}) {
    return new Promise(resolve => {
      const fundo = document.createElement('div');
      fundo.className = 'jv-confirm';
      fundo.innerHTML = `<div class="jv-confirm-box" role="dialog" aria-modal="true">
        <strong></strong><p></p><small></small>
        <div><button type="button" class="button ghost" data-r="0">Cancelar</button>
        <button type="button" class="button ${danger ? 'danger' : 'primary'}" data-r="1"></button></div></div>`;
      fundo.querySelector('strong').textContent = title || 'Confirmar';
      fundo.querySelector('p').textContent = message || '';
      fundo.querySelector('small').textContent = detail || '';
      fundo.querySelector('[data-r="1"]').textContent = confirmLabel || 'Confirmar';
      fundo.addEventListener('click', event => {
        const b = event.target.closest('[data-r]');
        if (!b && event.target !== fundo) return;
        fundo.remove();
        resolve(b ? b.dataset.r === '1' : false);
      });
      document.body.appendChild(fundo);
      fundo.querySelector('[data-r="1"]').focus();
    });
  }

  async function imprimir() {
    try { window.print(); } catch (error) { /* sem impressão neste sistema */ }
    return null;
  }

  // o Jarvis manda abrir uma página ("abre os relatórios") ou recarregar depois de um lançamento por voz
  window.jarvisNavegar = page => ouvintes.navigate?.(page);
  window.jarvisAcao = action => ouvintes.action?.(action);
  try {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?role=financeiro`);
    ws.onmessage = event => {
      let e = null;
      try { e = JSON.parse(event.data); } catch (error) { return; }
      if (e.type === 'financeiro.mudou') window.CP?.reload?.().then(() => window.CP?.render?.());
      if (e.type === 'financeiro.navegar' && e.pagina) ouvintes.navigate?.(e.pagina);
      if (e.type === 'financeiro.cotacoes') ouvintes.market?.(e.resultado);
    };
  } catch (error) { /* sem atualização ao vivo */ }

  const api = {
    // --- Sistema -------------------------------------------------------------
    info: () => call('app:info'),
    initialData: filters => call('app:initialData', filters),
    refresh: filters => call('app:refresh', filters),
    needsOnboarding: () => call('app:needsOnboarding'),
    completeOnboarding: data => call('app:completeOnboarding', data),
    setTheme: theme => call('app:setTheme', theme),
    printToPDF: () => imprimir(),
  
    // --- Perfil e preferências ----------------------------------------------
    profile: {
      get: () => call('profile:get'),
      save: data => call('profile:save', data)
    },
    settings: {
      get: () => call('settings:get'),
      set: (key, value, type) => call('settings:set', key, value, type),
      setMany: patch => call('settings:setMany', patch)
    },
    categories: {
      list: () => call('categories:list'),
      grouped: () => call('categories:grouped'),
      create: (type, name, color) => call('categories:create', type, name, color),
      update: (type, id, data) => call('categories:update', type, id, data),
      remove: (type, id) => call('categories:delete', type, id)
    },
    budgets: {
      get: month => call('budgets:get', month),
      save: (budgets, month) => call('budgets:save', budgets, month)
    },
  
    // --- Contas e transferências --------------------------------------------
    accounts: {
      list: () => call('accounts:list'),
      create: data => call('accounts:create', data),
      update: (id, data) => call('accounts:update', id, data),
      toggle: id => call('accounts:toggle', id),
      remove: id => call('accounts:delete', id),
      movements: (id, limit) => call('accounts:movements', id, limit),
      balance: id => call('accounts:balance', id)
    },
    transfers: {
      list: filters => call('transfers:list', filters),
      create: data => call('transfers:create', data),
      update: (id, data) => call('transfers:update', id, data),
      remove: id => call('transfers:delete', id)
    },
  
    // --- Entradas ------------------------------------------------------------
    incomes: {
      list: filters => call('incomes:list', filters),
      create: data => call('incomes:create', data),
      update: (id, data) => call('incomes:update', id, data),
      remove: id => call('incomes:delete', id)
    },
    recurringIncomes: {
      list: () => call('recurringIncomes:list'),
      create: data => call('recurringIncomes:create', data),
      update: (id, data) => call('recurringIncomes:update', id, data),
      toggle: id => call('recurringIncomes:toggle', id),
      remove: id => call('recurringIncomes:delete', id),
      generate: month => call('recurringIncomes:generate', month)
    },
  
    // --- Saídas --------------------------------------------------------------
    expenses: {
      list: filters => call('expenses:list', filters),
      create: data => call('expenses:create', data),
      update: (id, data) => call('expenses:update', id, data),
      remove: id => call('expenses:delete', id),
      markPaid: id => call('expenses:markPaid', id),
      markManyPaid: ids => call('expenses:markManyPaid', ids),
      bulkUpdate: (ids, changes) => call('expenses:bulkUpdate', ids, changes),
      bulkDelete: ids => call('expenses:bulkDelete', ids)
    },
    fixedExpenses: {
      list: () => call('fixedExpenses:list'),
      create: data => call('fixedExpenses:create', data),
      update: (id, data) => call('fixedExpenses:update', id, data),
      toggle: id => call('fixedExpenses:toggle', id),
      remove: id => call('fixedExpenses:delete', id),
      generate: month => call('fixedExpenses:generate', month)
    },
    payables: {
      list: days => call('payables:list', days)
    },
  
    // --- Cartões e faturas ---------------------------------------------------
    cards: {
      list: () => call('cards:list'),
      create: data => call('cards:create', data),
      update: (id, data) => call('cards:update', id, data),
      toggle: id => call('cards:toggle', id),
      remove: id => call('cards:delete', id),
      topUp: (id, amount) => call('cards:topUp', id, amount),
      usedLimit: id => call('cards:usedLimit', id)
    },
    invoices: {
      list: cardId => call('invoices:list', cardId),
      details: (cardId, month) => call('invoices:details', cardId, month),
      pay: (invoiceId, accountId) => call('invoices:pay', invoiceId, accountId),
      recalculate: () => call('invoices:recalculate')
    },
  
    // --- Investimentos e metas ----------------------------------------------
    investments: {
      list: () => call('investments:list'),
      classes: () => call('investments:classes'),
      portfolio: () => call('investments:portfolio'),
      create: data => call('investments:create', data),
      update: (id, data) => call('investments:update', id, data),
      toggle: id => call('investments:toggle', id),
      remove: id => call('investments:delete', id)
    },
    investmentOperations: {
      list: filters => call('investmentOperations:list', filters),
      create: data => call('investmentOperations:create', data),
      remove: id => call('investmentOperations:delete', id)
    },
    investmentIncome: {
      list: filters => call('investmentIncome:list', filters)
    },
    marketData: {
      status: () => call('marketData:status'),
      search: (query, assetClass) => call('marketData:search', query, assetClass),
      refresh: () => call('marketData:refresh')
    },
    contributions: {
      list: filters => call('contributions:list', filters),
      create: data => call('contributions:create', data),
      remove: id => call('contributions:delete', id)
    },
    goals: {
      list: () => call('goals:list'),
      get: id => call('goals:get', id),
      create: data => call('goals:create', data),
      update: (id, data) => call('goals:update', id, data),
      remove: id => call('goals:delete', id),
      deposit: (id, data) => call('goals:deposit', id, data),
      deposits: id => call('goals:deposits', id),
      depositRemove: id => call('goals:depositDelete', id),
      items: id => call('goals:items', id),
      itemCreate: (goalId, data) => call('goals:itemCreate', goalId, data),
      itemUpdate: (id, data) => call('goals:itemUpdate', id, data),
      itemRemove: id => call('goals:itemRemove', id),
      itemReorder: (goalId, ids) => call('goals:itemReorder', goalId, ids),
      itemPay: (id, data) => call('goals:itemPay', id, data),
      itemUnpay: id => call('goals:itemUnpay', id)
    },
  
    // --- Análises com histórico ----------------------------------------------
    insights: {
      subscriptions: () => call('insights:subscriptions'),
      monthClosing: month => call('insights:monthClosing', month),
      calendar: month => call('insights:calendar', month),
      nextActions: () => call('insights:nextActions'),
      suggestBudgets: options => call('insights:suggestBudgets', options),
      budgetPace: month => call('insights:budgetPace', month),
      sameMonthLastYear: month => call('insights:sameMonthLastYear', month),
      checkOutlier: (description, amount, category) => call('insights:checkOutlier', description, amount, category)
    },
  
    // --- Visão geral e relatórios -------------------------------------------
    dashboard: filters => call('dashboard:get', filters),
    reports: {
      full: filters => call('reports:full', filters),
      statement: year => call('reports:statement', year),
      categories: year => call('reports:categories', year),
      comparison: year => call('reports:comparison', year),
      ledger: filters => call('reports:ledger', filters),
      csv: filters => call('reports:csv', filters)
    },
  
    // --- Dados ---------------------------------------------------------------
    data: {
      export: () => call('data:export'),
      import: payload => call('data:import', payload),
      clearTransactions: () => call('data:clearTransactions'),
      reset: () => call('data:reset')
    },
    backup: {
      list: () => call('backup:list'),
      create: () => call('backup:create'),
      restore: filePath => call('backup:restore', filePath),
      remove: filePath => call('backup:delete', filePath),
      folder: () => call('backup:folder')
    },
    attachments: {
      list: (type, id) => call('attachments:list', type, id),
      add: (type, id, filePath) => call('attachments:add', type, id, filePath),
      remove: id => call('attachments:delete', id)
    },
  
    // --- Regras de categoria -------------------------------------------------
    rules: {
      list: () => call('rules:list'),
      save: data => call('rules:save', data),
      remove: id => call('rules:delete', id),
      learn: (description, category, kind) => call('rules:learn', description, category, kind),
      apply: () => call('rules:apply'),
      categorize: (description, kind) => call('rules:categorize', description, kind)
    },
  
    // --- Extratos, faturas e comprovantes ------------------------------------
    statement: {
      readFile: (filePath, options) => call('statement:readFile', filePath, options),
      readText: (text, options) => call('statement:readText', text, options)
    },
  
    // --- Importação em lote --------------------------------------------------
    import: {
      readBatch: (filePaths, options) => call('import:readBatch', filePaths, options),
      readPasted: (text, options) => call('import:readPasted', text, options),
      suggestTargets: session => call('import:suggestTargets', session),
      commit: (session, targets, options) => call('import:commit', session, targets, options),
      batches: limit => call('import:batches', limit),
      undo: batchId => call('import:undo', batchId)
    },
  
    // --- Lançamento escrito à mão --------------------------------------------
    entries: {
      parse: text => call('entries:parse', text)
    },
  
    // --- Diálogos e sistema operacional --------------------------------------
    dialog: {
      saveFile: options => salvarArquivo(options),
      openFile: options => call('dialog:openFile', options),
      openFiles: options => call('dialog:openFiles', options),
      openFolder: () => call('dialog:openFolder'),
      confirm: options => confirmar(options)
    },
    shell: {
      openPath: target => call('shell:openPath', target),
      openExternal: url => call('shell:openExternal', url)
    },
  
    /** Arquivo arrastado para a janela: sobe para o Jarvis e volta o caminho no computador. */
    pathForFile: () => '',
    uploadFiles: files => enviarArquivos(files),
  
    // --- Comandos vindos do Jarvis (voz, ícone) -----------------------------
    onNavigate: callback => { ouvintes.navigate = callback; },
    onAction: callback => { ouvintes.action = callback; },
    onMarketDataUpdated: callback => { ouvintes.market = callback; }
  };

  window.api = api;
})();
