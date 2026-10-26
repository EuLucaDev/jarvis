/* ==========================================================================
   Núcleo da interface: estado, ponte com o banco e componentes reutilizáveis.

   Tudo que aparece em mais de uma tela mora aqui — campo de formulário,
   tabela, cartão de resumo, gráfico, modal. As telas (pages.js) só compõem
   esses blocos. É o que evita a repetição que existia na versão web, onde
   cada página redesenhava seus próprios filtros e tabelas.
   ========================================================================== */

'use strict';

const CP = {};
window.CP = CP;

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

CP.MONTHS = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
CP.MONTHS_FULL = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
CP.CATEGORY_COLORS = ['#d7ff37', '#2ee59d', '#4ea8ff', '#8b5cf6', '#ffbf47', '#ff5f6d', '#22d3ee', '#f472b6'];

CP.PAGES = {
  dashboard:    { eyebrow: 'VISÃO GERAL',   title: 'Visão geral' },
  transactions: { eyebrow: 'MOVIMENTAÇÕES', title: 'Lançamentos' },
  payables:     { eyebrow: 'COMPROMISSOS',  title: 'A pagar' },
  wallet:       { eyebrow: 'CARTEIRA',      title: 'Contas, cartões e faturas' },
  investments:  { eyebrow: 'PATRIMÔNIO',    title: 'Investimentos' },
  goals:        { eyebrow: 'OBJETIVOS',     title: 'Metas' },
  reports:      { eyebrow: 'ANÁLISE',       title: 'Relatórios' },
  settings:     { eyebrow: 'PREFERÊNCIAS',  title: 'Configurações' }
};

/**
 * Ícone e cor por categoria. É o que faz a tela virar reconhecível de relance:
 * você identifica um gasto pelo símbolo antes de ler o texto.
 * A busca é por palavra, então uma categoria personalizada como
 * "Alimentação fora" herda o ícone de "alimentação".
 */
CP.CATEGORY_STYLES = {
  'alimenta':   { icon: '🍽', color: '#ff9f45' },
  'mercado':    { icon: '🛒', color: '#2ee59d' },
  'delivery':   { icon: '🛵', color: '#ff7a45' },
  'transporte': { icon: '🚗', color: '#4ea8ff' },
  'combust':    { icon: '⛽', color: '#4ea8ff' },
  'moradia':    { icon: '🏠', color: '#8b5cf6' },
  'aluguel':    { icon: '🏠', color: '#8b5cf6' },
  'condom':     { icon: '🏢', color: '#8b5cf6' },
  'energia':    { icon: '💡', color: '#ffbf47' },
  'água':       { icon: '💧', color: '#22d3ee' },
  'agua':       { icon: '💧', color: '#22d3ee' },
  'gás':        { icon: '🔥', color: '#ff7a45' },
  'internet':   { icon: '📶', color: '#4ea8ff' },
  'telefone':   { icon: '📱', color: '#4ea8ff' },
  'saúde':      { icon: '💊', color: '#ff5f6d' },
  'saude':      { icon: '💊', color: '#ff5f6d' },
  'academia':   { icon: '🏋', color: '#2ee59d' },
  'educa':      { icon: '📚', color: '#22d3ee' },
  'escola':     { icon: '🎓', color: '#22d3ee' },
  'faculdade':  { icon: '🎓', color: '#22d3ee' },
  'lazer':      { icon: '🎬', color: '#f472b6' },
  'viagem':     { icon: '✈️', color: '#22d3ee' },
  'compras':    { icon: '🛍', color: '#f472b6' },
  'assinatura': { icon: '🔁', color: '#8b5cf6' },
  'pets':       { icon: '🐾', color: '#ffbf47' },
  'presente':   { icon: '🎁', color: '#f472b6' },
  'seguro':     { icon: '🛡', color: '#4ea8ff' },
  'financ':     { icon: '🏦', color: '#ff5f6d' },
  'transfer':   { icon: '⇄', color: '#8b95a7' },
  'salário':    { icon: '💰', color: '#2ee59d' },
  'salario':    { icon: '💰', color: '#2ee59d' },
  'freela':     { icon: '💼', color: '#2ee59d' },
  'investi':    { icon: '📈', color: '#d7ff37' },
  'reembolso':  { icon: '↩️', color: '#2ee59d' },
  'venda':      { icon: '🏷', color: '#2ee59d' },
  'comiss':     { icon: '🤝', color: '#2ee59d' },
  'outros':     { icon: '•', color: '#8b95a7' }
};

/** Ícone + cor de uma categoria, com um símbolo neutro como último recurso. */
CP.categoryStyle = name => {
  const normalized = CP.normalize(name);
  for (const [key, style] of Object.entries(CP.CATEGORY_STYLES)) {
    if (normalized.includes(key)) return style;
  }
  return { icon: '•', color: '#8b95a7' };
};

/** Marca colorida da categoria, usada nas listas e nos gráficos. */
CP.categoryChip = name => {
  if (!name) return '<span class="cat-chip none">sem categoria</span>';
  const style = CP.categoryStyle(name);
  return `<span class="cat-chip" style="--cat:${style.color}"><i>${style.icon}</i>${CP.esc(name)}</span>`;
};

CP.PAYMENT_LABELS = {
  PIX: 'PIX', DEBITO: 'Débito', DINHEIRO: 'Dinheiro',
  CARTAO_CREDITO: 'Cartão de crédito', VALE_BENEFICIO: 'Vale / benefício'
};

/**
 * META fica de fora da lista acima de propósito: é a saída paga com o dinheiro
 * de uma meta, criada pela própria meta, e não uma opção que faça sentido
 * escolher num formulário de saída solta. Mas ela precisa de nome na hora de
 * aparecer nas listas.
 */
CP.paymentLabel = method =>
  CP.PAYMENT_LABELS[method] || (method === 'META' ? 'Dinheiro da meta' : method);

CP.ACCOUNT_TYPES = [
  { value: 'CONTA_CORRENTE', label: 'Conta corrente' },
  { value: 'CONTA_POUPANCA', label: 'Conta poupança' },
  { value: 'CONTA_DIGITAL', label: 'Conta digital' },
  { value: 'CARTEIRA_DINHEIRO', label: 'Carteira / dinheiro' },
  { value: 'OUTROS', label: 'Outros' }
];

CP.CARD_TYPES = [
  { value: 'CREDITO', label: 'Cartão de crédito' },
  { value: 'VALE_ALIMENTACAO', label: 'Vale alimentação' },
  { value: 'VALE_REFEICAO', label: 'Vale refeição' },
  { value: 'BENEFICIO_FLEXIVEL', label: 'Benefício flexível' }
];

CP.INVESTMENT_TYPES = [
  { value: 'ACAO', label: 'Ações brasileiras' },
  { value: 'FII', label: 'Fundos imobiliários (FIIs)' },
  { value: 'FIAGRO', label: 'Fiagros' },
  { value: 'ETF', label: 'ETFs nacionais' },
  { value: 'BDR', label: 'BDRs' },
  { value: 'STOCK', label: 'Ações internacionais (stocks)' },
  { value: 'REIT', label: 'REITs' },
  { value: 'ETF_INTERNACIONAL', label: 'ETFs internacionais' },
  { value: 'CRIPTO', label: 'Criptomoedas' },
  { value: 'TESOURO_DIRETO', label: 'Tesouro Direto' },
  { value: 'CDB', label: 'CDB / RDB' },
  { value: 'LCI_LCA', label: 'LCI / LCA' },
  { value: 'CRI_CRA', label: 'CRI / CRA' },
  { value: 'DEBENTURE', label: 'Debêntures' },
  { value: 'FUNDO', label: 'Fundos de investimento' },
  { value: 'PREVIDENCIA', label: 'Previdência privada' },
  { value: 'POUPANCA', label: 'Poupança' },
  { value: 'RESERVA_EMERGENCIA', label: 'Reserva de emergência' },
  { value: 'RENDA_FIXA', label: 'Outros de renda fixa' },
  { value: 'OUTROS', label: 'Outros' }
];

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------

CP.state = {
  page: 'dashboard',
  tab: {},                 // aba ativa por página
  filters: { year: new Date().getFullYear(), month: 'all', account: 'all', card: 'all', category: 'all' },
  search: {},              // busca por página
  selection: new Set(),    // seleção em massa na lista de pendentes
  db: null,                // último snapshot vindo do banco
  goalDetail: null,        // meta aberta na tela de detalhe
  goalId: null,
  reports: null
};

const state = CP.state;
CP.db = () => state.db || {};

// ---------------------------------------------------------------------------
// Atalhos de DOM e texto
// ---------------------------------------------------------------------------

const $ = CP.$ = (selector, scope = document) => scope.querySelector(selector);
const $$ = CP.$$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];

CP.esc = value => String(value ?? '').replace(/[&<>'"]/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);

CP.normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
CP.clamp = (value, min, max) => Math.min(max, Math.max(min, value));
CP.sum = (list, getter = v => v) => (list || []).reduce((total, item) => total + (Number(getter(item)) || 0), 0);

const esc = CP.esc;
const clamp = CP.clamp;
const sum = CP.sum;

// ---------------------------------------------------------------------------
// Formatação
// ---------------------------------------------------------------------------

CP.money = (value, compact = false) => new Intl.NumberFormat('pt-BR', {
  style: 'currency', currency: 'BRL',
  notation: compact ? 'compact' : 'standard',
  maximumFractionDigits: compact ? 1 : 2
}).format(Number(value) || 0);

CP.parseMoney = value =>
  Number(String(value || '').replace(/[^\d,-]/g, '').replace(/\./g, '').replace(',', '.')) || 0;

CP.moneyInput = value =>
  Number(value || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

CP.date = value => {
  if (!value) return '—';
  // Um mês ("2026-03") ou qualquer texto que não seja data derrubava a tela
  // inteira com "Invalid time value". Data ruim vira travessão, não erro.
  const parsed = new Date(`${String(value).slice(0, 10)}T12:00:00`);
  return Number.isNaN(parsed.getTime()) ? '—' : new Intl.DateTimeFormat('pt-BR').format(parsed);
};

CP.monthLabel = value => {
  const [year, month] = String(value).split('-');
  return `${CP.MONTHS_FULL[Number(month) - 1] || ''} de ${year}`;
};

CP.monthKey = value => String(value).slice(0, 7);
CP.today = () => new Date().toISOString().slice(0, 10);
CP.pct = (part, total) => (total ? (Number(part) / Number(total)) * 100 : 0);

CP.addMonths = (value, amount) => {
  const date = new Date(`${String(value).slice(0, 10)}T12:00:00`);
  date.setMonth(date.getMonth() + amount);
  return date.toISOString().slice(0, 10);
};

/** Mês de referência do filtro atual; "todos os meses" cai no mês corrente. */
CP.currentRef = () => {
  const month = state.filters.month === 'all' ? new Date().getMonth() + 1 : Number(state.filters.month);
  return `${state.filters.year}-${String(month).padStart(2, '0')}`;
};

CP.relative = value => {
  const days = Math.floor((Date.now() - new Date(value).getTime()) / 86400000);
  return days < 1 ? 'Hoje' : days === 1 ? 'Ontem' : `${days} dias`;
};

CP.daysLabel = days =>
  days < 0 ? `Venceu há ${Math.abs(days)}d` : days === 0 ? 'Vence hoje' : `Em ${days}d`;

const money = CP.money;

// ---------------------------------------------------------------------------
// Ponte com o banco
// ---------------------------------------------------------------------------

CP.showLoading = () => {
  $('#loadingLayer').classList.add('show');
  $('#loadingLayer').setAttribute('aria-hidden', 'false');
};
CP.hideLoading = () => {
  $('#loadingLayer').classList.remove('show');
  $('#loadingLayer').setAttribute('aria-hidden', 'true');
};

CP.toast = (message, type = 'success') => {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  const heading = type === 'error' ? 'Não foi possível' : type === 'warning' ? 'Atenção' : 'Tudo certo';
  const icon = type === 'error' ? '×' : type === 'warning' ? '!' : '✓';
  toast.innerHTML = `<span class="toast-icon">${icon}</span><div><strong>${heading}</strong><small>${esc(message)}</small></div><button aria-label="Fechar">×</button>`;
  $('#toastStack').append(toast);
  const remove = () => { toast.classList.add('removing'); setTimeout(() => toast.remove(), 260); };
  $('button', toast).addEventListener('click', remove);
  setTimeout(remove, 4600);
};

/** Recarrega o snapshot do banco e redesenha a tela atual. */
CP.reload = async () => {
  state.db = await window.api.initialData(state.filters);
  if (state.db.filters) state.filters = { ...state.filters, ...state.db.filters };
  return state.db;
};

/**
 * Executa uma alteração, recarrega e avisa. Concentra o tratamento de erro:
 * nenhuma tela precisa repetir try/catch/toast.
 *
 * O botão que disparou a ação vira um ✓ por um instante antes do toast — é o
 * retorno imediato que faz o app parecer responder, em vez de só piscar.
 */
CP.mutate = async (action, successMessage) => {
  const trigger = document.activeElement?.closest?.('button') || null;
  const previousLabel = trigger?.textContent;

  CP.showLoading();
  try {
    const result = await action();

    if (trigger && previousLabel) {
      trigger.textContent = '✓';
      trigger.classList.add('saved');
      setTimeout(() => {
        trigger.classList.remove('saved');
        if (trigger.isConnected) trigger.textContent = previousLabel;
      }, 700);
    }

    const previousBalance = CP.db().dashboard?.totalBalance;
    await CP.reload();
    CP.closeModal();
    CP.render();

    // O patrimônio pulsa quando muda, para você notar o efeito do lançamento.
    if (previousBalance != null && CP.db().dashboard?.totalBalance !== previousBalance) {
      CP.$('.hero-balance h2')?.classList.add('changed');
    }

    if (successMessage) CP.toast(successMessage);
    return result;
  } catch (error) {
    CP.toast(error.message, 'error');
    return null;
  } finally {
    CP.hideLoading();
  }
};

// ---------------------------------------------------------------------------
// Consultas locais sobre o snapshot
// ---------------------------------------------------------------------------

CP.accountById = id => CP.db().bankAccounts?.find(a => a.id === id);
CP.cardById = id => CP.db().cardsBenefits?.find(c => c.id === id);
CP.isBenefit = card => Boolean(card?.cardType) && card.cardType !== 'CREDITO';
CP.cardTypeLabel = type => CP.CARD_TYPES.find(t => t.value === type)?.label || 'Crédito';
CP.accountName = id => CP.accountById(id)?.name || '—';

CP.activeAccounts = () => (CP.db().bankAccounts || []).filter(a => a.status === 'ATIVA');
CP.activeCards = (kind = 'all') => (CP.db().cardsBenefits || []).filter(card => {
  if (card.status !== 'ATIVO') return false;
  if (kind === 'credit') return !CP.isBenefit(card);
  if (kind === 'benefit') return CP.isBenefit(card);
  return true;
});

CP.matchesPeriod = (date, filters = state.filters) => {
  if (!date) return false;
  const [year, month] = String(date).slice(0, 10).split('-').map(Number);
  if (Number(filters.year) !== year) return false;
  return filters.month === 'all' || Number(filters.month) === month;
};

/** Aplica período + busca textual + ordenação por data. Usado por toda lista. */
CP.applyList = (items, { period = true, dateField = 'date', page = state.page } = {}) => {
  const query = CP.normalize(state.search[page] || '');
  let result = [...(items || [])];
  if (period) result = result.filter(item => CP.matchesPeriod(item[dateField]));
  if (query) result = result.filter(item => CP.normalize(Object.values(item).join(' ')).includes(query));
  return result.sort((a, b) => String(b[dateField] || b.createdAt).localeCompare(String(a[dateField] || a.createdAt)));
};

// ---------------------------------------------------------------------------
// Blocos visuais
// ---------------------------------------------------------------------------

CP.badge = (text, type = '') => `<span class="badge ${type}">${esc(text)}</span>`;

/**
 * Cabeçalho da página: só a linha de contexto e os botões de ação.
 * O título já está na barra do topo — repeti-lo aqui era exatamente o tipo de
 * duplicação que a versão web tinha.
 */
CP.pageHeading = (description, actions = '') => `
  <div class="page-heading">
    <div><p class="page-lead">${esc(description)}</p></div>
    <div class="page-actions">${actions}</div>
  </div>`;

CP.sectionLabel = text => `<div class="section-label"><span>${text}</span><i></i></div>`;

CP.metricCard = (label, value, icon, color = 'primary', foot = '', index = 0) => {
  const palette = {
    primary: ['var(--primary)', 'var(--primary-soft)'],
    success: ['var(--success)', 'var(--success-soft)'],
    danger: ['var(--danger)', 'var(--danger-soft)'],
    blue: ['var(--blue)', 'var(--blue-soft)'],
    warning: ['var(--warning)', 'var(--warning-soft)'],
    purple: ['var(--purple, #8b5cf6)', 'rgba(139,92,246,.11)']
  };
  const [ink, soft] = palette[color] || palette.primary;
  return `<article class="metric-card" style="--i:${index};--metric-color:${ink};--metric-soft:${soft}">
    <div class="metric-top"><span class="metric-icon">${icon}</span><span>•••</span></div>
    <div class="metric-label">${label}</div>
    <div class="metric-value" data-animate-number="${Number(value) || 0}">${money(value)}</div>
    ${foot ? `<div class="metric-foot">${foot}</div>` : ''}
  </article>`;
};

CP.summaryCard = (label, value, icon, color = 'primary', raw = false) => {
  const styles = {
    primary: '',
    success: '--metric-color:var(--success);--metric-soft:var(--success-soft)',
    danger: '--metric-color:var(--danger);--metric-soft:var(--danger-soft)',
    blue: '--metric-color:var(--blue);--metric-soft:var(--blue-soft)',
    warning: '--metric-color:var(--warning);--metric-soft:var(--warning-soft)'
  };
  return `<article class="summary-card">
    <span class="metric-icon" style="${styles[color] || ''}">${icon}</span>
    <div><small>${esc(label)}</small><strong>${raw ? esc(value) : money(value)}</strong></div>
  </article>`;
};

CP.emptyState = (title, text, buttonLabel = '', action = '') => `
  <div class="empty-state">
    <div class="empty-art"><span>✦</span></div>
    <h3>${esc(title)}</h3>
    <p>${esc(text)}</p>
    ${buttonLabel ? `<button class="button primary" data-action="${action}">${esc(buttonLabel)}</button>` : ''}
  </div>`;

/** Abas de uma página. Substitui as páginas duplicadas da versão web. */
CP.tabs = (page, items) => {
  const active = CP.activeTab(page, items[0].id);
  return `<div class="tab-bar" role="tablist">${items.map(item => `
    <button role="tab" class="${item.id === active ? 'active' : ''}" data-tab="${page}:${item.id}" aria-selected="${item.id === active}">
      ${esc(item.label)}
      ${item.count ? `<span class="tab-count ${item.alert ? 'alert' : ''}">${item.count}</span>` : ''}
    </button>`).join('')}</div>`;
};

CP.activeTab = (page, fallback) => state.tab[page] || fallback;

// ---------------------------------------------------------------------------
// Selects e campos de formulário
// ---------------------------------------------------------------------------

CP.select = (name, options, value, extraClass = '') => {
  const normalized = options.map(option =>
    typeof option === 'string' ? { value: option, label: option } : option);
  const current = normalized.find(option => String(option.value) === String(value)) || normalized[0];
  return `<div class="custom-select ${extraClass}" data-select-name="${esc(name)}">
    <input type="hidden" name="${esc(name)}" value="${esc(current?.value ?? '')}">
    <button type="button" class="select-trigger" aria-haspopup="listbox" aria-expanded="false">${esc(current?.label || 'Selecione')}</button>
    <div class="select-menu" role="listbox">${normalized.map(option => `
      <button type="button" class="select-option ${String(option.value) === String(current?.value) ? 'selected' : ''}" data-value="${esc(option.value)}" role="option">${esc(option.label)}</button>`).join('')}
    </div>
  </div>`;
};

CP.field = (name, label, value = '', options = {}) => {
  const full = options.full ? ' full' : '';
  const requiredAttr = options.required === false ? '' : 'required';

  if (options.select) {
    return `<div class="field${full}"><label>${esc(label)}</label>${CP.select(name, options.select, value)}
      ${options.help ? `<span class="field-help">${esc(options.help)}</span>` : ''}</div>`;
  }
  if (options.textarea) {
    return `<div class="field${full}"><label for="field_${name}">${esc(label)}</label>
      <textarea id="field_${name}" name="${name}" placeholder="${esc(options.placeholder || '')}">${esc(value)}</textarea></div>`;
  }
  if (options.date || options.type === 'month') {
    const mode = options.type === 'month' ? 'month' : 'date';
    const display = value ? (mode === 'month' ? CP.monthLabel(value) : CP.date(value)) : '';
    return `<div class="field${full}"><label id="label_${name}">${esc(label)}</label>
      <div class="date-field" data-picker="${mode}">
        <input type="hidden" name="${esc(name)}" value="${esc(value)}" ${requiredAttr}>
        <button type="button" class="date-trigger" aria-haspopup="dialog" aria-expanded="false" aria-labelledby="label_${name}">
          <span data-placeholder="${mode === 'month' ? 'Selecione o mês' : 'Selecione a data'}">${esc(display)}</span><i aria-hidden="true">▦</i>
        </button>
      </div></div>`;
  }

  const wrapClass = options.currency ? 'currency-field' : '';
  return `<div class="field${full}"><label for="field_${name}">${esc(label)}</label>
    <div class="${wrapClass}">
      <input id="field_${name}" name="${name}" value="${esc(value)}" type="${options.type || 'text'}"
        ${options.currency ? 'data-currency' : ''}
        ${options.min != null ? `min="${options.min}"` : ''}
        ${options.max != null ? `max="${options.max}"` : ''}
        ${options.step ? `step="${options.step}"` : ''}
        placeholder="${esc(options.placeholder || '')}" ${requiredAttr}>
    </div>
    ${options.help ? `<span class="field-help">${esc(options.help)}</span>` : ''}</div>`;
};

CP.formFooter = (label = 'Salvar') => `
  <div class="form-footer field full">
    <button type="button" class="button ghost" data-close-modal>Cancelar</button>
    <button type="submit" class="button primary">${esc(label)}</button>
  </div>`;

CP.formData = form => {
  const data = Object.fromEntries(new FormData(form).entries());
  $$('[data-currency]', form).forEach(input => { data[input.name] = CP.parseMoney(input.value); });
  return data;
};

CP.accountOptions = (includeEmpty = false) => [
  ...(includeEmpty ? [{ value: '', label: 'Selecione uma conta' }] : []),
  ...CP.activeAccounts().map(a => ({ value: a.id, label: `${a.name} · ${money(a.currentBalance)}` }))
];

CP.cardOptions = (kind = 'all') => [
  { value: '', label: kind === 'benefit' ? 'Selecione um benefício' : 'Selecione um cartão' },
  ...CP.activeCards(kind).map(c => ({
    value: c.id,
    label: `${c.name} · ${CP.isBenefit(c) ? money(c.benefitBalance) : CP.cardTypeLabel(c.cardType)}`
  }))
];

CP.categoryOptions = type => (CP.db().categories?.[type] || []).map(c => ({ value: c.name, label: c.name }));

// ---------------------------------------------------------------------------
// Comportamento dos campos (select custom, calendário, moeda)
// ---------------------------------------------------------------------------

let activePicker = null;
const pickerInstances = new WeakMap();

CP.initSelects = (scope = document) => {
  $$('.custom-select', scope).forEach(root => {
    if (root.dataset.ready) return;
    root.dataset.ready = 'true';
    const trigger = $('.select-trigger', root);
    const hidden = $('input[type="hidden"]', root);
    trigger.addEventListener('click', event => {
      event.stopPropagation();
      $$('.custom-select.open').filter(item => item !== root).forEach(item => item.classList.remove('open'));
      root.classList.toggle('open');
      trigger.setAttribute('aria-expanded', root.classList.contains('open'));
    });
    $$('.select-option', root).forEach(option => option.addEventListener('click', () => {
      $$('.select-option', root).forEach(item => item.classList.remove('selected'));
      option.classList.add('selected');
      hidden.value = option.dataset.value;
      trigger.textContent = option.textContent.trim();
      root.classList.remove('open');
      hidden.dispatchEvent(new Event('change', { bubbles: true }));
    }));
  });
};

CP.initCurrency = (scope = document) => {
  $$('[data-currency]', scope).forEach(input => {
    if (input.dataset.currencyReady) return;
    input.dataset.currencyReady = 'true';
    input.addEventListener('focus', () => { input.value = input.value.replace(/[^\d,]/g, ''); });
    input.addEventListener('blur', () => {
      const amount = CP.parseMoney(input.value);
      input.value = amount ? CP.moneyInput(amount) : '';
    });
  });
};

class DatePicker {
  constructor(root) {
    this.root = root;
    this.input = $('input[type="hidden"]', root);
    this.trigger = $('.date-trigger', root);
    this.mode = root.dataset.picker || 'date';
    this.viewDate = this.parse(this.input.value) || new Date();
    this.popover = null;
    this.trigger.addEventListener('click', event => {
      event.stopPropagation();
      this.popover ? this.close() : this.open();
    });
  }
  parse(value) {
    if (!value) return null;
    const parts = String(value).split('-').map(Number);
    const date = new Date(parts[0], (parts[1] || 1) - 1, this.mode === 'month' ? 1 : parts[2] || 1, 12);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  format(date) {
    const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    return this.mode === 'month' ? iso : `${iso}-${String(date.getDate()).padStart(2, '0')}`;
  }
  open() {
    activePicker?.close();
    activePicker = this;
    this.popover = document.createElement('div');
    this.popover.className = 'calendar-popover';
    this.popover.setAttribute('role', 'dialog');
    this.popover.addEventListener('click', event => event.stopPropagation());
    document.body.append(this.popover);
    this.render();
    this.trigger.setAttribute('aria-expanded', 'true');
    requestAnimationFrame(() => this.popover?.classList.add('open'));
  }
  close() {
    if (!this.popover) return;
    this.popover.remove();
    this.popover = null;
    this.trigger.setAttribute('aria-expanded', 'false');
    if (activePicker === this) activePicker = null;
  }
  position() {
    if (!this.popover) return;
    const rect = this.trigger.getBoundingClientRect();
    const { offsetWidth: width, offsetHeight: height } = this.popover;
    this.popover.style.left = `${clamp(rect.left, 12, window.innerWidth - width - 12)}px`;
    const below = rect.bottom + height + 10 <= window.innerHeight;
    this.popover.style.top = `${below ? rect.bottom + 7 : Math.max(12, rect.top - height - 7)}px`;
  }
  header(subtitle) {
    const title = this.mode === 'month' ? this.viewDate.getFullYear() : CP.MONTHS_FULL[this.viewDate.getMonth()];
    return `<div class="calendar-head">
      <button type="button" class="calendar-nav" data-prev aria-label="Anterior">‹</button>
      <div class="calendar-title"><strong>${title}</strong><small>${subtitle}</small></div>
      <button type="button" class="calendar-nav" data-next aria-label="Próximo">›</button>
    </div>`;
  }
  footer() {
    return `<div class="calendar-footer">
      <button type="button" class="calendar-link" data-clear>Limpar</button>
      <button type="button" class="calendar-link" data-today>Hoje</button>
    </div>`;
  }
  bind() {
    const step = amount => {
      if (this.mode === 'month') this.viewDate.setFullYear(this.viewDate.getFullYear() + amount);
      else this.viewDate.setMonth(this.viewDate.getMonth() + amount);
      this.render();
    };
    $('[data-prev]', this.popover).addEventListener('click', () => step(-1));
    $('[data-next]', this.popover).addEventListener('click', () => step(1));
    $('[data-clear]', this.popover).addEventListener('click', () => this.select(null));
    $('[data-today]', this.popover).addEventListener('click', () => this.select(new Date()));
  }
  render() {
    if (!this.popover) return;
    this.mode === 'month' ? this.renderMonths() : this.renderDays();
    this.bind();
    this.position();
  }
  renderDays() {
    const year = this.viewDate.getFullYear();
    const month = this.viewDate.getMonth();
    const first = new Date(year, month, 1, 12);
    const start = new Date(year, month, 1 - first.getDay(), 12);
    const selected = this.parse(this.input.value);
    const todayISO = CP.today();
    const days = Array.from({ length: 42 }, (_, index) => {
      const date = new Date(start);
      date.setDate(start.getDate() + index);
      return date;
    });
    this.popover.innerHTML = `${this.header(String(year))}
      <div class="calendar-weekdays">${['D', 'S', 'T', 'Q', 'Q', 'S', 'S'].map(d => `<span>${d}</span>`).join('')}</div>
      <div class="calendar-days">${days.map(date => {
        const iso = this.format(date);
        const outside = date.getMonth() !== month;
        const isSelected = selected && this.format(selected) === iso;
        return `<button type="button" class="calendar-day ${outside ? 'outside' : ''} ${todayISO === iso ? 'today' : ''} ${isSelected ? 'selected' : ''}" data-date="${iso}">${date.getDate()}</button>`;
      }).join('')}</div>${this.footer()}`;
    $$('[data-date]', this.popover).forEach(button =>
      button.addEventListener('click', () => this.select(this.parse(button.dataset.date))));
  }
  renderMonths() {
    const selected = this.parse(this.input.value);
    const today = new Date();
    const year = this.viewDate.getFullYear();
    this.popover.innerHTML = `${this.header('Escolha o mês')}
      <div class="month-grid">${CP.MONTHS.map((label, index) => {
        const isCurrent = today.getFullYear() === year && today.getMonth() === index;
        const isSelected = selected && selected.getFullYear() === year && selected.getMonth() === index;
        return `<button type="button" class="month-option ${isCurrent ? 'current' : ''} ${isSelected ? 'selected' : ''}" data-month="${index}">${label}</button>`;
      }).join('')}</div>${this.footer()}`;
    $$('[data-month]', this.popover).forEach(button =>
      button.addEventListener('click', () => this.select(new Date(year, Number(button.dataset.month), 1, 12))));
  }
  select(date) {
    this.input.value = date ? this.format(date) : '';
    $('span', this.trigger).textContent = date
      ? (this.mode === 'month' ? CP.monthLabel(this.input.value) : CP.date(this.input.value))
      : '';
    this.input.dispatchEvent(new Event('change', { bubbles: true }));
    this.close();
    this.trigger.focus();
  }
}

CP.initPickers = (scope = document) => {
  $$('[data-picker]', scope).forEach(root => {
    if (pickerInstances.has(root)) return;
    pickerInstances.set(root, new DatePicker(root));
  });
};

CP.closeFloating = event => {
  if (!event.target.closest('.custom-select')) {
    $$('.custom-select.open').forEach(item => item.classList.remove('open'));
  }
  if (activePicker && !event.target.closest('.calendar-popover') && !event.target.closest('.date-trigger')) {
    activePicker.close();
  }
};

CP.closePickers = () => activePicker?.close();

// ---------------------------------------------------------------------------
// Modal, gaveta lateral e confirmação
// ---------------------------------------------------------------------------

CP.openModal = (content, title = 'Adicionar', eyebrow = 'NOVO REGISTRO', size = '') => {
  $('#modalBody').innerHTML = content;
  $('#modalTitle').textContent = title;
  $('#modalEyebrow').textContent = eyebrow;
  $('.modal').style.width = size || '';
  $('#modalRoot').classList.add('open');
  $('#modalRoot').setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');
  const body = $('#modalBody');
  CP.initSelects(body);
  CP.initPickers(body);
  CP.initCurrency(body);
  setTimeout(() => $('input:not([type="hidden"]), textarea, button', body)?.focus(), 90);
};

CP.closeModal = () => {
  CP.closePickers();
  $('#modalRoot').classList.remove('open');
  $('#modalRoot').setAttribute('aria-hidden', 'true');
  document.body.classList.remove('modal-open');
};

CP.confirm = (message, callback, title = 'Confirmar ação', confirmLabel = 'Confirmar') => {
  CP.openModal(`<div class="confirm-box">
    <div class="confirm-icon">!</div>
    <h3>${esc(title)}</h3>
    <p>${esc(message)}</p>
    <div class="confirm-actions">
      <button class="button ghost" data-close-modal>Cancelar</button>
      <button class="button danger" id="confirmButton">${esc(confirmLabel)}</button>
    </div>
  </div>`, title, 'ATENÇÃO');
  $('#confirmButton').addEventListener('click', async () => {
    try { await callback(); } catch (error) { CP.toast(error.message, 'error'); }
  });
};

CP.openDrawer = (html, title) => {
  CP.closeDrawer();
  const drawer = document.createElement('div');
  drawer.className = 'drawer-root';
  drawer.innerHTML = `<div class="drawer-backdrop"></div>
    <aside class="drawer" role="dialog" aria-label="${esc(title || 'Detalhes')}">
      <header class="drawer-head"><h2>${esc(title || 'Detalhes')}</h2>
        <button class="icon-button drawer-close" aria-label="Fechar">×</button></header>
      <div class="drawer-body">${html}</div>
    </aside>`;
  document.body.append(drawer);
  requestAnimationFrame(() => drawer.classList.add('shown'));
  drawer.addEventListener('click', event => {
    if (event.target.closest('.drawer-close') || event.target.classList.contains('drawer-backdrop')) CP.closeDrawer();
  });
};

CP.closeDrawer = () => {
  const drawer = $('.drawer-root');
  if (!drawer) return;
  drawer.classList.remove('shown');
  setTimeout(() => drawer.remove(), 260);
};

// ---------------------------------------------------------------------------
// Gráficos
// ---------------------------------------------------------------------------

CP.barChart = series => {
  const max = Math.max(1, ...series.flatMap(item => [item.income, item.outflow]));
  return `<div class="bar-chart">${series.map((item, index) => `
    <div class="bar-group"><div class="bars">
      <i class="bar" style="--h:${Math.max(2, (item.income / max) * 100)}%;--i:${index}" data-tip="Entradas ${item.label}: ${money(item.income)}"></i>
      <i class="bar out" style="--h:${Math.max(2, (item.outflow / max) * 100)}%;--i:${index}" data-tip="Saídas ${item.label}: ${money(item.outflow)}"></i>
    </div><span class="bar-label">${item.label}</span></div>`).join('')}</div>
    <div class="chart-legend"><span><i style="--legend:var(--success)"></i>Entradas</span><span><i style="--legend:var(--danger)"></i>Saídas</span></div>`;
};

CP.lineChart = (values, color = 'var(--primary)', id = 'chart') => {
  // Sem nenhum ponto não existe linha: montar o traçado assim mesmo gerava um
  // "d" começando em L, que o navegador recusa e registra como erro.
  if (!Array.isArray(values) || !values.length) {
    return '<div class="chart-wrap empty"><p class="empty-hint">Sem dados no período.</p></div>';
  }
  const width = 720;
  const height = 220;
  const padding = 25;
  const min = Math.min(0, ...values);
  const max = Math.max(1, ...values);
  const range = max - min || 1;
  const points = values.map((value, index) => ({
    x: padding + index * ((width - padding * 2) / Math.max(1, values.length - 1)),
    y: height - padding - ((value - min) / range) * (height - padding * 2),
    value
  }));
  const path = points.reduce((acc, point, index) => {
    if (!index) return `M ${point.x} ${point.y}`;
    const previous = points[index - 1];
    const mid = (previous.x + point.x) / 2;
    return `${acc} C ${mid} ${previous.y}, ${mid} ${point.y}, ${point.x} ${point.y}`;
  }, '');
  const area = `${path} L ${points.at(-1)?.x || 0} ${height - padding} L ${points[0]?.x || 0} ${height - padding} Z`;
  const last = points.at(-1);
  return `<div class="chart-wrap"><svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-label="Gráfico de evolução">
    <defs><linearGradient id="grad_${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${color}"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
    <g class="chart-grid">${[0, 1, 2, 3].map(i => `<line x1="${padding}" y1="${padding + i * 52}" x2="${width - padding}" y2="${padding + i * 52}"/>`).join('')}</g>
    <path class="chart-area" d="${area}" fill="url(#grad_${id})"/>
    <path class="chart-line" d="${path}" stroke="${color}"/>
    ${last ? `<circle class="chart-pulse" cx="${last.x}" cy="${last.y}" r="5" fill="${color}"/>` : ''}
    ${points.map((p, i) => `<circle class="chart-dot${i === points.length - 1 ? ' last' : ''}" cx="${p.x}" cy="${p.y}" r="4" fill="${color}" data-tip="${CP.MONTHS[i] || ''}: ${money(p.value)}"/>`).join('')}
    ${points.map((p, i) => `<text class="chart-label" x="${p.x}" y="215" text-anchor="middle">${CP.MONTHS[i] || ''}</text>`).join('')}
  </svg></div>`;
};

CP.donut = rows => {
  if (!rows.length) return CP.emptyState('Sem gastos no período', 'Altere os filtros ou registre uma saída para ver a distribuição.');
  const top = rows.slice(0, 6);
  const total = sum(top, item => item.value);
  const circumference = 2 * Math.PI * 42;
  let offset = 0;
  const arcs = top.map((item, index) => {
    const fraction = total ? item.value / total : 0;
    const length = fraction * circumference;
    const color = CP.CATEGORY_COLORS[index % CP.CATEGORY_COLORS.length];
    const arc = `<circle class="donut-arc" cx="60" cy="60" r="42" fill="none" stroke="${color}" stroke-width="16"
      stroke-dasharray="${length.toFixed(2)} ${(circumference - length).toFixed(2)}"
      stroke-dashoffset="${(-offset * circumference).toFixed(2)}"
      style="--arc-delay:${(index * 0.12).toFixed(2)}s"
      data-tip="${esc(item.name)}: ${money(item.value)} · ${(fraction * 100).toFixed(0)}%"></circle>`;
    offset += fraction;
    return arc;
  }).join('');
  return `<div class="donut-layout">
    <div class="donut-figure">
      <svg class="donut-svg" viewBox="0 0 120 120" aria-label="Distribuição por categoria">
        <g transform="rotate(-90 60 60)"><circle class="donut-track" cx="60" cy="60" r="42" fill="none" stroke-width="16"></circle>${arcs}</g>
      </svg>
      <div class="donut-center"><strong>${money(total, true)}</strong><small>em gastos</small></div>
    </div>
    <div class="donut-legend">${top.map((item, index) => `
      <div class="donut-item" style="--c:${CP.CATEGORY_COLORS[index % CP.CATEGORY_COLORS.length]}">
        <i></i><span>${esc(item.name)}</span><strong>${CP.pct(item.value, total).toFixed(0)}%</strong>
      </div>`).join('')}</div>
  </div>`;
};

// ---------------------------------------------------------------------------
// Animações e dicas
// ---------------------------------------------------------------------------

CP.animateNumbers = () => {
  $$('[data-animate-number]').forEach(element => {
    const end = Number(element.dataset.animateNumber) || 0;
    const start = performance.now();
    const frame = timestamp => {
      const progress = clamp((timestamp - start) / 800, 0, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      element.textContent = money(end * eased);
      if (progress < 1) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
};

CP.initTooltips = () => {
  let tooltip = $('.chart-tooltip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.className = 'chart-tooltip';
    document.body.append(tooltip);
  }
  $$('[data-tip]', $('#app')).forEach(element => {
    element.addEventListener('pointerenter', () => {
      tooltip.textContent = element.dataset.tip;
      tooltip.classList.add('show');
    });
    element.addEventListener('pointermove', event => {
      tooltip.style.left = `${event.clientX + 12}px`;
      tooltip.style.top = `${event.clientY - 30}px`;
    });
    element.addEventListener('pointerleave', () => tooltip.classList.remove('show'));
  });
};
