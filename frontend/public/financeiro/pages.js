/* ==========================================================================
   As telas.

   Sete páginas, cada uma com abas quando faz sentido. Todas montadas a partir
   dos blocos de core.js — nenhuma redesenha filtro, tabela ou cartão por
   conta própria.
   ========================================================================== */

'use strict';

(() => {
  const { $, $$, esc, clamp, sum, money, badge, pageHeading, sectionLabel,
          metricCard, summaryCard, emptyState, tabs, activeTab, select,
          barChart, lineChart, donut, state } = CP;

  const db = () => CP.db();
  const pctText = value => `${value >= 0 ? '+' : ''}${value.toFixed(0)}%`;

  // =========================================================================
  // Barra de filtros — uma só, compartilhada por todas as páginas
  // =========================================================================

  CP.filterBar = (options = {}) => {
    const years = (db().availableYears || [new Date().getFullYear()]).map(y => ({ value: y, label: String(y) }));
    const months = [{ value: 'all', label: 'Todos os meses' },
      ...CP.MONTHS_FULL.map((label, index) => ({ value: index + 1, label }))];
    const accounts = [{ value: 'all', label: 'Todas as contas' },
      ...(db().bankAccounts || []).map(a => ({ value: a.id, label: a.name }))];
    const cards = [{ value: 'all', label: 'Todos os cartões' },
      ...(db().cardsBenefits || []).map(c => ({ value: c.id, label: c.name }))];
    const categoryNames = [...new Set([
      ...(db().categories?.variableExpense || []).map(c => c.name),
      ...(db().categories?.income || []).map(c => c.name)
    ])];

    const active = ['month', 'account', 'card', 'category']
      .filter(key => state.filters[key] && state.filters[key] !== 'all').length;

    return `<div class="filter-bar sticky-filters">
      <span class="filter-caption">⌁ Período</span>
      ${select('filterYear', years, state.filters.year)}
      ${select('filterMonth', months, state.filters.month)}
      ${options.compact ? '' : `
        ${select('filterAccount', accounts, state.filters.account)}
        ${select('filterCard', cards, state.filters.card)}
        ${select('filterCategory', [{ value: 'all', label: 'Todas as categorias' },
          ...categoryNames.map(name => ({ value: name, label: name }))], state.filters.category)}`}
      ${options.search !== false ? `<div class="field" style="flex:1;min-width:170px">
        <input data-search placeholder="${esc(options.searchPlaceholder || 'Buscar…')}" value="${esc(state.search[state.page] || '')}">
      </div>` : '<span class="filter-spacer"></span>'}
      ${active ? `<span class="filter-chip-active">${active} filtro${active > 1 ? 's' : ''}</span>` : ''}
      <button class="button ghost small" data-action="clear-filters">Limpar</button>
    </div>`;
  };

  const periodLabel = () => state.filters.month === 'all'
    ? `Ano de ${state.filters.year}`
    : `${CP.MONTHS_FULL[Number(state.filters.month) - 1]} de ${state.filters.year}`;

  // =========================================================================
  // 1. VISÃO GERAL
  // =========================================================================

  CP.renderDashboard = () => {
    const data = db().dashboard;
    if (!data) return emptyState('Carregando…', 'Buscando seus dados.');
    const hidden = db().settings?.hidden_sections || [];
    const visible = id => !hidden.includes(id);

    return `<section class="page dashboard-page">
      ${CP.quickBar()}
      ${CP.nextActionsBlock()}
      ${heroStrip(data)}
      ${CP.filterBar({ search: false })}
      ${metricsRow(data)}
      ${visible('intel') ? intelligenceBlock(data) : ''}
      ${visible('budget') ? budgetBlock(data) : ''}
      ${chartsBlock(data)}
      ${walletPreview(data)}
      ${activityBlock(data)}
    </section>`;
  };

  const heroStrip = data => `
    <div class="hero-strip">
      <div class="hero-balance">
        <span class="hero-label"><i>◆</i> Patrimônio total</span>
        <h2 data-animate-number="${data.totalBalance}">${money(data.totalBalance)}</h2>
        <div class="hero-change">
          <span class="delta ${data.leftover < 0 ? 'negative' : ''}">${data.leftover >= 0 ? '↗' : '↘'} ${Math.abs(data.savingRate).toFixed(1)}%</span>
          <span>${periodLabel()}</span>
        </div>
      </div>
      <div class="hero-quick">
        ${heroCard('Em contas', data.bankBalance, '◇', 'var(--blue)', 'var(--blue-soft)')}
        ${heroCard('Investido', data.investedBalance, '⌁', 'var(--purple, #8b5cf6)', 'rgba(139,92,246,.11)')}
        ${heroCard('Benefícios', data.benefitBalance, '✦', 'var(--primary)', 'var(--primary-soft)')}
        ${heroCard('Entradas', data.totalIncome, '↗', 'var(--success)', 'var(--success-soft)')}
        ${heroCard('Saídas', data.totalOutflow, '↘', 'var(--danger)', 'var(--danger-soft)')}
      </div>
    </div>`;

  const heroCard = (label, value, icon, color, soft) => `
    <div class="hero-quick-card">
      <span class="metric-icon" style="--metric-color:${color};--metric-soft:${soft}">${icon}</span>
      <div><small>${label}</small><strong>${money(value)}</strong></div>
    </div>`;

  const metricsRow = data => {
    const goalGap = Math.max(0, data.monthlyGoal - data.freeToSpend);
    return `<div class="metrics-grid">
      ${metricCard('Livre para gastar', data.freeToSpend, '◎', data.freeToSpend >= 0 ? 'success' : 'danger', 'Entradas − saídas da conta', 0)}
      ${metricCard('A pagar', data.payable, '!', data.payable > 0 ? 'danger' : 'success', `${data.counts.pending} pendência(s) + faturas`, 1)}
      ${metricCard('Faturas abertas', data.openInvoiceTotal, '▰', 'warning', `${data.counts.openInvoices} fatura(s) no período`, 2)}
      ${metricCard('Aportes', data.contributionTotal, '⌁', 'blue',
        data.counts.withdrawals
          ? `${data.counts.contributions} aporte(s) · ${data.counts.withdrawals} resgate(s) de ${money(data.withdrawalTotal)}`
          : `${data.counts.contributions} aporte(s)`, 3)}
      ${metricCard('Meta de economia', data.monthlyGoal, '✦', 'purple',
        goalGap <= 0 ? '🎉 Meta atingida' : `Faltam ${money(goalGap)}`, 4)}
    </div>`;
  };

  // --- Inteligência financeira ---------------------------------------------

  const intelligenceBlock = data => {
    const { health, comparison, reserve, forecast, anomalies } = data.intelligence;
    const tone = { success: 'var(--success)', warning: 'var(--warning)', danger: 'var(--danger)' }[health.tone];
    const bar = (value, cap, color) =>
      `<i class="intel-bar"><b style="width:${clamp((value / cap) * 100, 0, 100).toFixed(0)}%;background:${color}"></b></i>`;

    const healthCard = `<article class="panel">
      <header class="panel-header">
        <div class="panel-title"><h3>Saúde financeira</h3><p>Índice combinado do período</p></div>
        ${badge(health.label, health.tone)}
      </header>
      <div class="panel-body"><div class="gauge-wrap">
        <div class="gauge-figure">
          <svg class="gauge" viewBox="0 0 120 76" aria-label="Score ${health.score} de 100">
            <path class="gauge-track" d="M8 66 A52 52 0 0 1 112 66" pathLength="100" fill="none"></path>
            <path class="gauge-value" d="M8 66 A52 52 0 0 1 112 66" pathLength="100" fill="none" stroke="${tone}" stroke-dasharray="${health.score} 100"></path>
          </svg>
          <div class="gauge-center"><strong style="color:${tone}">${health.score}</strong><small>de 100</small></div>
        </div>
        <ul class="intel-parts">
          <li><span>Economia</span>${bar(health.parts.saving, 40, 'var(--success)')}</li>
          <li><span>Reserva</span>${bar(health.parts.reserve, 35, 'var(--blue)')}</li>
          <li><span>Renda livre</span>${bar(health.parts.commitment, 25, 'var(--primary)')}</li>
        </ul>
      </div></div>
    </article>`;

    const arrow = comparison.delta > 0 ? '↑' : comparison.delta < 0 ? '↓' : '→';
    const comparisonCard = `<article class="panel">
      <header class="panel-header"><div class="panel-title">
        <h3>Comparativo mensal</h3>
        <p>${CP.MONTHS_FULL[comparison.currentMonth - 1]} vs ${CP.MONTHS_FULL[comparison.previousMonth - 1]}</p>
      </div></header>
      <div class="panel-body">
        <div class="cmp-head">
          <strong class="cmp-delta ${comparison.delta > 0 ? 'danger' : 'success'}">${arrow} ${Math.abs(comparison.pct).toFixed(0)}%</strong>
          <span>${comparison.delta >= 0 ? 'a mais' : 'a menos'} · ${money(Math.abs(comparison.delta))}</span>
        </div>
        <ul class="cmp-list">${comparison.movers.map(item => `
          <li><span class="cmp-cat">${esc(item.category)}</span>
            <span class="cmp-move ${item.delta > 0 ? 'up' : 'down'}">${item.delta > 0 ? '▲' : '▼'} ${money(Math.abs(item.delta))}</span></li>`
        ).join('') || '<li class="cmp-empty">Sem variações relevantes no período</li>'}</ul>
      </div>
    </article>`;

    const reserveText = {
      done: () => `<span class="proj-goal">🎯 Reserva completa — ${money(reserve.current)}</span>`,
      none: () => '<span>Defina uma meta de reserva nas Configurações para ver a projeção.</span>',
      stalled: () => `<span>Faltam <strong>${money(reserve.missing)}</strong> · sem aportes recentes para projetar o prazo.</span>`,
      ok: () => `<span>No ritmo de <strong>${money(reserve.pace)}/mês</strong>, você chega em <strong class="proj-date">${reserve.dateLabel}</strong>.</span>`
    }[reserve.status]();

    const projectionCard = `<article class="panel">
      <header class="panel-header"><div class="panel-title"><h3>Projeções</h3><p>Reserva e fluxo de caixa</p></div></header>
      <div class="panel-body">
        <div class="proj-line">${reserveText}</div>
        ${reserve.pct != null ? `<div class="proj-progress"><i style="width:${clamp(reserve.pct, 0, 100).toFixed(0)}%"></i></div>` : ''}
        <div class="forecast-grid">${forecast.map(item => `
          <div class="forecast-tile ${item.value >= 0 ? 'pos' : 'neg'}"><small>${item.days} dias</small><strong>${money(item.value)}</strong></div>`
        ).join('')}</div>
        <span class="forecast-note">Saldo projetado a partir da entrada média, das despesas fixas e das faturas em aberto.</span>
      </div>
    </article>`;

    const radar = [
      ...data.payables.slice(0, 5).map(item => `
        <li class="radar-item ${item.days < 0 ? 'overdue' : item.days <= 2 ? 'soon' : ''}">
          <span class="radar-icon">${item.kind === 'invoice' ? '▰' : '⌛'}</span>
          <div><strong>${esc(item.title)}</strong><small>${CP.daysLabel(item.days)} · ${money(item.amount)}</small></div>
        </li>`),
      ...anomalies.map(item => `
        <li class="radar-item soon"><span class="radar-icon">📈</span>
          <div><strong>${esc(item.category)}</strong><small>${item.pct.toFixed(0)}% acima da média (${money(item.average)})</small></div>
        </li>`)
    ];

    const radarCard = `<article class="panel">
      <header class="panel-header">
        <div class="panel-title"><h3>Radar</h3><p>Vencimentos e gastos fora do padrão</p></div>
        ${radar.length ? badge(String(radar.length), 'warning') : ''}
      </header>
      <div class="panel-body"><ul class="radar-list">${radar.join('') ||
        '<li class="radar-empty">Tudo tranquilo — nada vencendo por agora.</li>'}</ul></div>
    </article>`;

    return `${sectionLabel('⌁ Inteligência financeira')}
      <div class="dashboard-grid intel-grid">${healthCard}${comparisonCard}</div>
      <div class="dashboard-grid intel-grid">${projectionCard}${radarCard}</div>`;
  };

  // --- Orçamento, metas e conquistas ---------------------------------------

  const budgetBlock = data => {
    const rows = data.budgets.map(item => `
      <div class="budget-row">
        <div class="budget-top"><span>${esc(item.category)}</span>
          <strong>${money(item.used)}${item.limit ? ` <small>/ ${money(item.limit)}</small>` : ''}</strong></div>
        <div class="budget-bar ${item.tone}"><i style="width:${item.limit ? item.pct : 3}%"></i></div>
        <small class="budget-note ${item.tone}">${
          !item.limit ? 'Sem meta definida'
          : item.over ? `Estourou ${money(item.over)}`
          : `Restam ${money(item.remaining)} (${(100 - item.pct).toFixed(0)}%)`}</small>
      </div>`).join('');

    const budgetCard = `<article class="panel">
      <header class="panel-header">
        <div class="panel-title"><h3>Orçamento do mês</h3><p>Gasto por categoria</p></div>
        <button class="button small ghost" data-action="suggest-budgets">◈ Sugerir</button>
        <button class="button small ghost" data-action="edit-budgets">Definir metas</button>
      </header>
      <div class="panel-body">${rows || '<p class="budget-empty">Registre saídas ou defina metas por categoria para acompanhar aqui.</p>'}</div>
    </article>`;

    const goals = data.goals || [];
    const goalsCard = `<article class="panel">
      <header class="panel-header">
        <div class="panel-title"><h3>Metas</h3><p>Guardado, livre e o que falta</p></div>
        <button class="button small ghost" data-action="add-goal">＋ Nova meta</button>
      </header>
      <div class="panel-body">${goals.length ? goals.map(goal => `
        <div class="budget-row goal-row" data-action="open-goal" data-id="${goal.id}" role="button" tabindex="0">
          <div class="budget-top"><span>${goal.icon} ${esc(goal.name)}</span>
            <strong>${money(goal.savedAmount)} <small>/ ${money(goal.targetAmount)}</small></strong></div>
          <div class="goal-bar" style="--goal-color:${goal.color}"><i style="width:${goal.progress.toFixed(0)}%"></i></div>
          <small class="budget-note">${goal.freeAmount != null && goal.paidAmount > 0
            ? `${money(goal.freeAmount)} livres · ${money(goal.paidAmount)} já pagos`
            : goal.monthsLeft != null && goal.monthsLeft > 0
              ? `Guarde ${money(goal.requiredPerMonth)}/mês para chegar no prazo`
              : goal.missing > 0 ? `Faltam ${money(goal.missing)}` : '🎉 Meta alcançada'}
            ${goal.nextItem ? ` · próximo: ${esc(goal.nextItem.name)}` : ''}</small>
        </div>`).join('')
        : '<p class="budget-empty">Crie uma meta — casamento, carro, viagem — liste do que ela é feita e acompanhe o quanto já está guardado.</p>'}
      </div>
    </article>`;

    return `${sectionLabel('◎ Orçamento e metas')}
      <div class="dashboard-grid equal">${budgetCard}${goalsCard}</div>
      ${achievementsBlock(data)}`;
  };

  const achievementsBlock = data => {
    const { list } = data.intelligence.achievements;
    return `<article class="panel">
      <header class="panel-header">
        <div class="panel-title"><h3>Conquistas</h3><p>Seu progresso financeiro</p></div>
        <button class="button small ghost" data-action="open-retro">Retrospectiva</button>
      </header>
      <div class="panel-body"><div class="achv-grid">${list.map(item => `
        <div class="achv ${item.done ? 'done' : ''}">
          <span class="achv-icon">${item.icon}</span>
          <div class="achv-body"><strong>${item.title}</strong><small>${item.desc}</small>
            <i class="achv-bar"><b style="width:${(item.progress * 100).toFixed(0)}%"></b></i></div>
          ${item.done ? '<span class="achv-check">✓</span>' : ''}
        </div>`).join('')}</div></div>
    </article>`;
  };

  // --- Gráficos e prévia da carteira ---------------------------------------

  const chartsBlock = data => `
    <div class="dashboard-grid">
      <article class="panel">
        <header class="panel-header"><div class="panel-title"><h3>Entradas vs. saídas</h3><p>Mês a mês em ${state.filters.year}</p></div></header>
        <div class="panel-body">${barChart(data.incomesVsOutflowsByMonth)}</div>
      </article>
      <article class="panel">
        <header class="panel-header"><div class="panel-title"><h3>Gastos por categoria</h3><p>Distribuição do período</p></div></header>
        <div class="panel-body">${donut(data.expensesByCategory)}</div>
      </article>
    </div>
    <div class="dashboard-grid">
      <article class="panel">
        <header class="panel-header">
          <div class="panel-title"><h3>Evolução patrimonial</h3><p>Contas + investimentos</p></div>${badge('12 meses', 'primary')}
        </header>
        <div class="panel-body">${lineChart(data.balanceEvolution.map(i => i.value), 'var(--primary)', 'equity')}</div>
      </article>
      <article class="panel">
        <header class="panel-header"><div class="panel-title"><h3>Próximos vencimentos</h3><p>O que precisa da sua atenção</p></div>
          <button class="button small ghost" data-page="payables">Ver todos</button></header>
        <div class="panel-body">${data.payables.length
          ? `<div class="payable-list">${data.payables.slice(0, 5).map(payableRow).join('')}</div>`
          : emptyState('Nada vencendo', 'Você está em dia com tudo que foi registrado.')}</div>
      </article>
    </div>`;

  const walletPreview = data => `
    <div class="dashboard-grid equal">
      <article class="panel">
        <header class="panel-header"><div class="panel-title"><h3>Suas contas</h3><p>Saldo atualizado</p></div>
          <button class="button small ghost" data-page="wallet">Ver todas</button></header>
        <div class="panel-body"><div class="account-scroll">${
          CP.activeAccounts().map(accountMini).join('') ||
          emptyState('Nenhuma conta cadastrada', 'Cadastre uma conta para acompanhar seus saldos.', 'Nova conta', 'add-account')}</div></div>
      </article>
      <article class="panel">
        <header class="panel-header"><div class="panel-title"><h3>Cartões e benefícios</h3><p>Limites e saldos de vale</p></div>
          <button class="button small ghost" data-page="wallet">Ver todos</button></header>
        <div class="panel-body"><div class="card-scroll">${
          CP.activeCards().map(cardVisual).join('') ||
          emptyState('Nenhum cartão cadastrado', 'Adicione crédito, vale alimentação ou refeição.', 'Novo cartão', 'add-card')}</div></div>
      </article>
    </div>`;

  const ACTIVITY_ICONS = {
    INCOME_CREATED: '↗', EXPENSE_CREATED: '↘', EXPENSE_PAID: '✓', CARD_PURCHASE_CREATED: '▰',
    CARD_INVOICE_PAID: '✓', INVESTMENT_CONTRIBUTION_CREATED: '⌁', BANK_ACCOUNT_CREATED: '◇',
    CREDIT_CARD_CREATED: '▰', BENEFIT_CREATED: '✦', BENEFIT_TOPUP: '＋', TRANSFER_CREATED: '⇄',
    GOAL_CREATED: '🎯', GOAL_COMPLETED: '🏆', SETTINGS_UPDATED: '⚙', FIXED_EXPENSE_GENERATED: '↻',
    BACKUP_CREATED: '⇩', DATA_IMPORTED: '⇧', ONBOARDING_COMPLETED: '✦'
  };

  const activityBlock = data => `
    <article class="panel">
      <header class="panel-header"><div class="panel-title"><h3>Atividades recentes</h3><p>O que aconteceu na sua carteira</p></div></header>
      <div class="panel-body"><div class="activity-list">${
        (data.recentActivities || []).map(item => `
          <div class="activity"><span class="activity-icon">${ACTIVITY_ICONS[item.type] || '•'}</span>
            <div><strong>${esc(item.message)}</strong><small>${esc(item.entityType)}</small></div>
            <time>${CP.relative(item.createdAt)}</time></div>`).join('') ||
        emptyState('Sem atividades', 'Suas ações aparecerão aqui.')}</div></div>
    </article>`;

  // =========================================================================
  // 2. LANÇAMENTOS — entradas, saídas, fixas, recorrentes e transferências
  // =========================================================================

  CP.renderTransactions = () => {
    const tab = activeTab('transactions', 'all');
    const counts = {
      all: CP.applyList(allEntries(), { period: true }).length,
      incomes: CP.applyList(db().incomes, { period: true }).length,
      expenses: CP.applyList(db().expenses, { period: true }).length,
      fixed: (db().fixedExpenses || []).filter(f => f.status === 'ATIVA').length,
      transfers: CP.applyList(db().transfers, { period: true }).length
    };

    const actions = {
      all: '<button class="button primary" data-action="quick-add">＋ Novo lançamento</button>',
      incomes: '<button class="button primary" data-action="add-income">＋ Nova entrada</button>',
      expenses: '<button class="button primary" data-action="add-expense">＋ Nova saída</button>',
      fixed: '<button class="button ghost" data-action="generate-fixed">↻ Gerar mês</button><button class="button primary" data-action="add-fixed">＋ Despesa fixa</button>',
      recurring: '<button class="button ghost" data-action="generate-recurring">↻ Lançar mês</button><button class="button primary" data-action="add-recurring">＋ Receita recorrente</button>',
      transfers: '<button class="button primary" data-action="add-transfer">＋ Nova transferência</button>'
    }[tab];

    const body = {
      all: allTab, incomes: incomesTab, expenses: expensesTab,
      fixed: fixedTab, recurring: recurringTab, transfers: transfersTab
    }[tab]();

    return `<section class="page">
      ${pageHeading('Tudo que entrou e saiu, num lugar só.', actions)}
      ${tabs('transactions', [
        { id: 'all', label: 'Tudo', count: counts.all },
        { id: 'incomes', label: 'Entradas', count: counts.incomes },
        { id: 'expenses', label: 'Saídas', count: counts.expenses },
        { id: 'fixed', label: 'Despesas fixas', count: counts.fixed },
        { id: 'recurring', label: 'Receitas fixas' },
        { id: 'transfers', label: 'Transferências', count: counts.transfers }
      ])}
      ${tab === 'all' || tab === 'expenses' || tab === 'incomes' ? CP.quickBar() : ''}
      ${CP.filterBar({ searchPlaceholder: 'Buscar por descrição, categoria ou conta…' })}
      ${body}
    </section>`;
  };

  /** Junta entradas, saídas e transferências numa linha do tempo única. */
  const allEntries = () => {
    const entries = [];
    for (const item of db().incomes || []) {
      entries.push({ ...item, _kind: 'income', _label: item.source, _signed: Number(item.amount) });
    }
    for (const item of db().expenses || []) {
      // Estorno é uma saída de valor negativo: aparece como crédito.
      const value = Number(item.amount);
      entries.push({
        ...item,
        _kind: value < 0 ? 'refund' : 'expense',
        _label: item.description,
        _signed: -value
      });
    }
    for (const item of db().transfers || []) {
      entries.push({ ...item, _kind: 'transfer', _label: item.description || 'Transferência', _signed: 0 });
    }
    return entries;
  };

  const KIND_STYLE = {
    income: { icon: '↗', color: 'var(--success)', soft: 'var(--success-soft)', label: 'Entrada' },
    expense: { icon: '↘', color: 'var(--danger)', soft: 'var(--danger-soft)', label: 'Saída' },
    refund: { icon: '↩', color: 'var(--success)', soft: 'var(--success-soft)', label: 'Estorno' },
    transfer: { icon: '⇄', color: 'var(--blue)', soft: 'var(--blue-soft)', label: 'Transferência' }
  };

  const allTab = () => {
    const items = CP.applyList(allEntries(), { period: true });
    const incomes = sum(items.filter(i => i._kind === 'income'), i => i.amount);
    const paid = sum(items.filter(i => i._kind === 'expense' && i.status === 'PAGO'), i => i.amount);
    const pending = sum(
      items.filter(i => i._kind === 'expense' && i.status === 'PENDENTE' && i.paymentMethod !== 'CARTAO_CREDITO'),
      i => i.amount
    );

    if (!items.length) {
      return emptyState('Nenhum lançamento no período',
        'Registre sua primeira movimentação — ou mude o filtro de período acima.', 'Novo lançamento', 'quick-add');
    }

    return `<div class="summary-grid">
        ${summaryCard('Entradas', incomes, '↗', 'success')}
        ${summaryCard('Saídas pagas', paid, '↘', 'danger')}
        ${summaryCard('Contas a pagar', pending, '!', 'warning')}
        ${summaryCard('Resultado', incomes - paid, '◎', incomes - paid >= 0 ? 'blue' : 'danger')}
      </div>
      <article class="data-card"><div class="table-wrap"><table class="data-table">
        <thead><tr><th>Lançamento</th><th>Categoria</th><th>Conta / cartão</th><th>Data</th><th>Status</th><th>Valor</th><th>Ações</th></tr></thead>
        <tbody>${items.map(unifiedRow).join('')}</tbody>
      </table></div></article>`;
  };

  const unifiedRow = item => {
    const style = KIND_STYLE[item._kind];
    const where = item._kind === 'transfer'
      ? `<span class="transfer-flow"><span>${esc(CP.accountName(item.fromAccountId))}</span><i>→</i><span>${esc(CP.accountName(item.toAccountId))}</span></span>`
      : esc(CP.accountById(item.bankAccountId)?.name || CP.cardById(item.creditCardId)?.name || '—');
    const attachments = db().attachmentCounts?.[item._kind]?.[item.id] || 0;

    return `<tr>
      <td><div class="cell-main">
        <span class="cell-icon" style="--icon-color:${style.color};--icon-soft:${style.soft}">${style.icon}</span>
        <span><strong>${esc(item._label)}${attachments ? `<span class="attach-pill">📎 ${attachments}</span>` : ''}</strong>
        <small>${style.label}${item.type === 'FIXA' ? ' fixa' : ''}${item.paymentMethod ? ` · ${CP.paymentLabel(item.paymentMethod)}` : ''}</small></span>
      </div></td>
      <td>${item.category ? CP.categoryChip(item.category) : '—'}</td>
      <td>${where}</td>
      <td>${CP.date(item.date)}</td>
      <td>${item.status ? badge(item.status, item.status === 'PAGO' ? 'success' : 'warning') : '—'}</td>
      <td class="${item._signed > 0 ? 'money-positive' : item._signed < 0 ? 'money-negative' : ''}">
        ${item._signed > 0 ? '+ ' : item._signed < 0 ? '− ' : ''}${money(Math.abs(item.amount))}</td>
      <td><div class="actions-cell">${rowActions(item)}</div></td>
    </tr>`;
  };

  const rowActions = item => {
    const kind = item._kind;
    if (kind === 'transfer') {
      return `<button class="button danger small icon-only" data-action="delete-transfer" data-id="${item.id}" aria-label="Excluir">×</button>`;
    }
    const editAction = kind === 'income' ? 'edit-income' : 'edit-expense';
    const deleteAction = kind === 'income' ? 'delete-income' : 'delete-expense';
    if (kind === 'refund') {
      return `<button class="button danger small icon-only" data-action="delete-expense" data-id="${item.id}" aria-label="Excluir">×</button>`;
    }
    return `
      ${item.status === 'PENDENTE' ? `<button class="button small" data-action="pay-expense" data-id="${item.id}">Pagar</button>` : ''}
      <button class="button small icon-only" data-action="attach" data-type="${kind}" data-id="${item.id}" aria-label="Anexos">📎</button>
      <button class="button small icon-only" data-action="${editAction}" data-id="${item.id}" aria-label="Editar">✎</button>
      <button class="button danger small icon-only" data-action="${deleteAction}" data-id="${item.id}" aria-label="Excluir">×</button>`;
  };

  const incomesTab = () => {
    const items = CP.applyList(db().incomes, { period: true });
    const total = sum(items, i => i.amount);
    const byAccount = items.reduce((acc, item) => {
      acc[item.bankAccountId] = (acc[item.bankAccountId] || 0) + Number(item.amount);
      return acc;
    }, {});
    const topAccount = Object.entries(byAccount).sort((a, b) => b[1] - a[1])[0];

    return `<div class="summary-grid">
        ${summaryCard('Total no período', total, '↗', 'success')}
        ${summaryCard('Maior entrada', Math.max(0, ...items.map(i => Number(i.amount))), '↑', 'blue')}
        ${summaryCard('Conta que mais recebeu', topAccount ? CP.accountName(topAccount[0]) : '—', '◇', 'primary', true)}
        ${summaryCard('Lançamentos', String(items.length), '#', 'warning', true)}
      </div>
      <article class="data-card">${items.length ? `<div class="table-wrap"><table class="data-table">
        <thead><tr><th>Origem</th><th>Categoria</th><th>Conta</th><th>Data</th><th>Valor</th><th>Ações</th></tr></thead>
        <tbody>${items.map(item => `<tr>
          <td><div class="cell-main">
            <span class="cell-icon" style="--icon-color:var(--success);--icon-soft:var(--success-soft)">↗</span>
            <span><strong>${esc(item.source)}</strong><small>${esc(item.description || 'Sem descrição')}</small></span>
          </div></td>
          <td>${CP.categoryChip(item.category)}</td>
          <td>${esc(CP.accountName(item.bankAccountId))}</td>
          <td>${CP.date(item.date)}</td>
          <td class="money-positive">+ ${money(item.amount)}</td>
          <td><div class="actions-cell">
            <button class="button small icon-only" data-action="edit-income" data-id="${item.id}" aria-label="Editar">✎</button>
            <button class="button danger small icon-only" data-action="delete-income" data-id="${item.id}" aria-label="Excluir">×</button>
          </div></td></tr>`).join('')}</tbody></table></div>`
        : emptyState('Nenhuma entrada no período', 'Registre salário, freela ou qualquer dinheiro que entrou.', 'Nova entrada', 'add-income')}
      </article>`;
  };

  const expensesTab = () => {
    const items = CP.applyList(db().expenses, { period: true });
    const paid = sum(items.filter(i => i.status === 'PAGO' && Number(i.amount) > 0), i => i.amount);
    const refunded = Math.abs(sum(items.filter(i => Number(i.amount) < 0), i => i.amount));
    // Compras no crédito ficam PENDENTE até a fatura ser paga — separá-las
    // evita a leitura errada de que são contas a pagar diretamente.
    const pendingBills = items.filter(i => i.status === 'PENDENTE' && i.paymentMethod !== 'CARTAO_CREDITO');
    const onCard = sum(items.filter(i => ['CARTAO_CREDITO', 'VALE_BENEFICIO'].includes(i.paymentMethod)), i => i.amount);

    return `<div class="summary-grid">
        ${summaryCard('Pago no período', paid, '↘', 'danger')}
        ${summaryCard('Contas a pagar', sum(pendingBills, i => i.amount), '!', 'warning')}
        ${refunded > 0
          ? summaryCard('Estornos', refunded, '↩', 'success')
          : summaryCard('Em cartões e vales', onCard, '▰', 'blue')}
        ${summaryCard('Lançamentos', String(items.length), '#', 'primary', true)}
      </div>
      <article class="data-card">${items.length ? `<div class="table-wrap"><table class="data-table">
        <thead><tr>
          <th style="width:34px"><input type="checkbox" class="row-check" data-check-all aria-label="Selecionar todos"></th>
          <th>Descrição</th><th>Categoria</th><th>Pagamento</th><th>Data</th><th>Status</th><th>Valor</th><th>Ações</th>
        </tr></thead>
        <tbody>${items.map(item => `<tr>
          <td><input type="checkbox" class="row-check" data-select="${item.id}"
                ${state.selection.has(item.id) ? 'checked' : ''} aria-label="Selecionar"></td>
          <td><div class="cell-main">
            <span class="cell-icon" style="--icon-color:var(--danger);--icon-soft:var(--danger-soft)">↘</span>
            <span><strong>${esc(item.description)}</strong><small>${item.type === 'FIXA' ? 'Despesa fixa' : 'Despesa variável'}</small></span>
          </div></td>
          <td>${CP.categoryChip(item.category)}</td>
          <td>${esc(CP.paymentLabel(item.paymentMethod))}</td>
          <td>${CP.date(item.date)}</td>
          <td>${badge(item.status, item.status === 'PAGO' ? 'success' : 'warning')}</td>
          <td class="${Number(item.amount) < 0 ? 'money-positive' : 'money-negative'}">
            ${Number(item.amount) < 0 ? '+' : '−'} ${money(Math.abs(item.amount))}</td>
          <td><div class="actions-cell">${rowActions({ ...item, _kind: Number(item.amount) < 0 ? 'refund' : 'expense' })}</div></td>
        </tr>`).join('')}</tbody></table></div><div id="bulkBarSlot">${bulkBar()}</div>`
        : emptyState('Nenhuma saída no período', 'Registre um gasto por PIX, débito, dinheiro, crédito ou vale.', 'Nova saída', 'add-expense')}
      </article>`;
  };

  /** A barra de seleção é redesenhada sozinha, sem refazer a lista toda. */
  CP.bulkBarHTML = () => bulkBar();

  const bulkBar = () => {
    if (!state.selection.size) return '';
    const items = (db().expenses || []).filter(item => state.selection.has(item.id));
    const pending = items.filter(item => item.status === 'PENDENTE').length;
    return `<div class="bulk-bar">
      <strong>${state.selection.size} selecionada(s)</strong>
      <span>${money(sum(items, i => Math.abs(i.amount)))}</span>
      <button class="button ghost small" data-action="clear-selection">Limpar</button>
      <span class="spacer" style="flex:1"></span>
      <button class="button small" data-action="bulk-category">Categorizar</button>
      <button class="button small" data-action="bulk-account">Trocar conta</button>
      ${pending ? `<button class="button small" data-action="pay-selected">Marcar ${pending} como paga(s)</button>` : ''}
      <button class="button danger small" data-action="bulk-delete">Excluir</button>
    </div>`;
  };

  const fixedTab = () => {
    const items = db().fixedExpenses || [];
    const active = items.filter(i => i.status === 'ATIVA');
    return `<div class="summary-grid">
        ${summaryCard('Compromisso mensal', sum(active, i => i.estimatedAmount), '↻', 'warning')}
        ${summaryCard('Ativos', String(active.length), '#', 'primary', true)}
        ${summaryCard('No cartão', String(items.filter(i => i.defaultPaymentMethod === 'CARTAO_CREDITO').length), '▰', 'blue', true)}
        ${summaryCard('Inativos', String(items.length - active.length), '○', 'danger', true)}
      </div>
      <div class="entity-grid">${items.map(item => `
        <article class="entity-card">
          <div class="entity-head">
            <div class="entity-title">
              <span class="metric-icon" style="--metric-color:var(--warning);--metric-soft:var(--warning-soft)">↻</span>
              <div><h3>${esc(item.name)}</h3><p>${esc(item.category)}</p></div>
            </div>${badge(item.status, item.status === 'ATIVA' ? 'success' : '')}
          </div>
          <div class="entity-balance"><small>Estimativa mensal</small><strong>${money(item.estimatedAmount)}</strong></div>
          <div class="entity-stats">
            <div><small>Vencimento</small><strong>Dia ${item.dueDay}</strong></div>
            <div><small>Pagamento</small><strong>${esc(CP.paymentLabel(item.defaultPaymentMethod))}</strong></div>
          </div>
          <div class="entity-actions">
            <button class="button small" data-action="edit-fixed" data-id="${item.id}">Editar</button>
            <button class="button small ghost" data-action="toggle-fixed" data-id="${item.id}">${item.status === 'ATIVA' ? 'Inativar' : 'Reativar'}</button>
            <button class="button small ghost" data-action="delete-fixed" data-id="${item.id}">Excluir</button>
          </div>
        </article>`).join('') ||
        emptyState('Nenhum compromisso fixo', 'Cadastre aluguel, internet, academia — e gere as contas do mês com um clique.', 'Cadastrar compromisso', 'add-fixed')}
      </div>`;
  };

  const recurringTab = () => {
    const items = db().recurringIncomes || [];
    const active = items.filter(i => i.status === 'ATIVA');
    return `<div class="summary-grid">
        ${summaryCard('Renda recorrente', sum(active, i => i.estimatedAmount), '↗', 'success')}
        ${summaryCard('Ativas', String(active.length), '#', 'primary', true)}
        ${summaryCard('Inativas', String(items.length - active.length), '○', 'danger', true)}
      </div>
      <div class="entity-grid">${items.map(item => `
        <article class="entity-card">
          <div class="entity-head">
            <div class="entity-title">
              <span class="metric-icon" style="--metric-color:var(--success);--metric-soft:var(--success-soft)">↗</span>
              <div><h3>${esc(item.name)}</h3><p>${esc(item.category)}</p></div>
            </div>${badge(item.status, item.status === 'ATIVA' ? 'success' : '')}
          </div>
          <div class="entity-balance"><small>Valor estimado</small><strong>${money(item.estimatedAmount)}</strong></div>
          <div class="entity-stats">
            <div><small>Recebimento</small><strong>Dia ${item.receiveDay}</strong></div>
            <div><small>Conta</small><strong>${esc(CP.accountName(item.defaultAccountId))}</strong></div>
          </div>
          <div class="entity-actions">
            <button class="button small" data-action="edit-recurring" data-id="${item.id}">Editar</button>
            <button class="button small ghost" data-action="toggle-recurring" data-id="${item.id}">${item.status === 'ATIVA' ? 'Inativar' : 'Reativar'}</button>
            <button class="button small ghost" data-action="delete-recurring" data-id="${item.id}">Excluir</button>
          </div>
        </article>`).join('') ||
        emptyState('Nenhuma receita recorrente',
          'Cadastre salário ou outra renda que se repete todo mês — e lance o mês inteiro com um clique.',
          'Cadastrar receita', 'add-recurring')}
      </div>`;
  };

  const transfersTab = () => {
    const items = CP.applyList(db().transfers, { period: true });
    return `<div class="summary-grid">
        ${summaryCard('Movimentado no período', sum(items, i => i.amount), '⇄', 'blue')}
        ${summaryCard('Transferências', String(items.length), '#', 'primary', true)}
      </div>
      <article class="data-card">${items.length ? `<div class="table-wrap"><table class="data-table">
        <thead><tr><th>Descrição</th><th>De → Para</th><th>Data</th><th>Valor</th><th>Ações</th></tr></thead>
        <tbody>${items.map(item => `<tr>
          <td><div class="cell-main">
            <span class="cell-icon" style="--icon-color:var(--blue);--icon-soft:var(--blue-soft)">⇄</span>
            <span><strong>${esc(item.description || 'Transferência')}</strong><small>Entre contas · não conta como entrada nem saída</small></span>
          </div></td>
          <td><span class="transfer-flow"><span>${esc(CP.accountName(item.fromAccountId))}</span><i>→</i><span>${esc(CP.accountName(item.toAccountId))}</span></span></td>
          <td>${CP.date(item.date)}</td>
          <td><strong>${money(item.amount)}</strong></td>
          <td><div class="actions-cell">
            <button class="button small icon-only" data-action="edit-transfer" data-id="${item.id}" aria-label="Editar">✎</button>
            <button class="button danger small icon-only" data-action="delete-transfer" data-id="${item.id}" aria-label="Excluir">×</button>
          </div></td></tr>`).join('')}</tbody></table></div>`
        : emptyState('Nenhuma transferência',
            'Moveu dinheiro entre suas contas? Registre aqui — o valor não conta como entrada nem como saída do mês.',
            'Nova transferência', 'add-transfer')}
      </article>`;
  };

  // =========================================================================
  // 3. A PAGAR
  // =========================================================================

  const payableRow = item => {
    const tone = item.days < 0 ? 'overdue' : item.days <= 3 ? 'soon' : '';
    const [, month, day] = String(item.dueDate).split('-');
    const action = item.kind === 'invoice'
      ? `<button class="button primary small" data-action="pay-invoice" data-id="${item.id}">Paguei</button>`
      : `<button class="button primary small" data-action="pay-expense" data-id="${item.id}">Paguei</button>`;
    return `<div class="payable-row ${tone}">
      <div class="payable-when"><strong>${day}</strong><small>${CP.MONTHS[Number(month) - 1]}</small></div>
      <div class="payable-info"><strong>${esc(item.title)}</strong>
        <small>${esc(item.category)} · ${CP.daysLabel(item.days)}</small></div>
      <div class="payable-amount">${money(item.amount)}</div>
      <div class="payable-actions">${action}</div>
    </div>`;
  };

  CP.renderPayables = () => {
    const all = db().payables || [];
    const tab = activeTab('payables', 'open');
    const overdue = all.filter(i => i.days < 0);
    const week = all.filter(i => i.days >= 0 && i.days <= 7);
    const month = all.filter(i => i.days > 7 && i.days <= 31);
    const groups = { open: all.filter(i => i.days <= 31), overdue, week, month }[tab];

    return `<section class="page">
      ${pageHeading('Contas pendentes e faturas em aberto, ordenadas por urgência.',
        '<button class="button ghost" data-action="generate-fixed">↻ Gerar despesas do mês</button><button class="button primary" data-action="add-expense">＋ Nova saída</button>')}
      <div class="summary-grid">
        ${summaryCard('Vencidas', sum(overdue, i => i.amount), '!', 'danger')}
        ${summaryCard('Próximos 7 dias', sum(week, i => i.amount), '⌛', 'warning')}
        ${summaryCard('Resto do mês', sum(month, i => i.amount), '▦', 'blue')}
        ${summaryCard('Total em aberto', sum(all, i => i.amount), '◎', 'primary')}
      </div>
      ${tabs('payables', [
        { id: 'open', label: 'Tudo', count: all.filter(i => i.days <= 31).length },
        { id: 'overdue', label: 'Vencidas', count: overdue.length, alert: overdue.length > 0 },
        { id: 'week', label: 'Esta semana', count: week.length },
        { id: 'month', label: 'Este mês', count: month.length }
      ])}
      ${groups.length ? `<div class="payable-list">${groups.map(payableRow).join('')}</div>
        <div class="payable-total"><span>Total desta lista</span><strong>${money(sum(groups, i => i.amount))}</strong></div>`
        : emptyState('Nada por aqui',
            tab === 'overdue' ? 'Nenhuma conta vencida. Muito bem!' : 'Nada vencendo neste recorte.',
            'Gerar despesas do mês', 'generate-fixed')}
    </section>`;
  };

  // =========================================================================
  // 4. CARTEIRA — contas, cartões e faturas
  // =========================================================================

  const accountMini = account => {
    const ref = CP.currentRef();
    const income = sum((db().incomes || []).filter(i => i.bankAccountId === account.id && CP.monthKey(i.date) === ref), i => i.amount);
    const outflow = sum((db().expenses || []).filter(i => i.bankAccountId === account.id && i.status === 'PAGO' && CP.monthKey(i.date) === ref), i => i.amount);
    return `<article class="account-card" style="--account-color:${account.color}">
      <div class="account-head"><span class="bank-symbol">${esc(account.bankName.slice(0, 1))}</span>${badge(account.status, account.status === 'ATIVA' ? 'success' : '')}</div>
      <h4>${esc(account.name)}</h4>
      <div class="balance">${money(account.currentBalance)}</div>
      <div class="account-foot"><span>↗ ${money(income, true)}</span><span>↘ ${money(outflow, true)}</span></div>
    </article>`;
  };

  const cardVisual = card => {
    const benefit = CP.isBenefit(card);
    const openInvoice = (db().cardInvoices || [])
      .filter(i => i.creditCardId === card.id && i.status === 'ABERTA' && Number(i.totalAmount) > 0)
      .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)))[0];
    const used = sum((db().cardInstallments || []).filter(i => i.creditCardId === card.id && i.status === 'ABERTA'), i => i.amount);

    return `<article class="credit-card-visual" style="--card-color:${card.color}">
      <div class="cc-top"><span class="chip"></span>${badge(benefit ? 'Benefício' : card.status, benefit ? 'primary' : card.status === 'ATIVO' ? 'success' : '')}</div>
      <h3>${esc(card.name)}</h3>
      <span class="cc-bank">${esc(card.bankName)} · ${esc(CP.cardTypeLabel(card.cardType))}</span>
      <div class="cc-metrics">${benefit
        ? `<div><small>Saldo disponível</small><strong>${money(card.benefitBalance)}</strong></div>
           <div><small>Uso</small><strong>À vista</strong></div>`
        : `<div><small>Próxima fatura</small><strong>${money(openInvoice?.totalAmount || 0)}</strong></div>
           <div><small>Disponível</small><strong>${money(Math.max(0, card.limit - used))}</strong></div>`}
      </div>
    </article>`;
  };

  CP.renderWallet = () => {
    const tab = activeTab('wallet', 'accounts');
    const openInvoices = (db().cardInvoices || []).filter(i => i.status === 'ABERTA' && Number(i.totalAmount) > 0);
    const actions = {
      accounts: '<button class="button ghost" data-action="add-transfer">⇄ Transferir</button><button class="button primary" data-action="add-account">＋ Nova conta</button>',
      cards: '<button class="button ghost" data-action="add-purchase">＋ Lançar compra</button><button class="button primary" data-action="add-card">＋ Novo cartão ou benefício</button>',
      invoices: '<button class="button ghost" data-action="recalculate-invoices">↻ Recalcular faturas</button>'
    }[tab];

    return `<section class="page">
      ${pageHeading('Contas bancárias, cartões, vales e faturas — tudo no mesmo lugar.', actions)}
      ${tabs('wallet', [
        { id: 'accounts', label: 'Contas', count: (db().bankAccounts || []).length },
        { id: 'cards', label: 'Cartões e benefícios', count: (db().cardsBenefits || []).length },
        { id: 'invoices', label: 'Faturas', count: openInvoices.length, alert: openInvoices.some(i => i.dueDate < CP.today()) }
      ])}
      ${{ accounts: accountsTab, cards: cardsTab, invoices: invoicesTab }[tab]()}
    </section>`;
  };

  const accountsTab = () => {
    const accounts = db().bankAccounts || [];
    const active = accounts.filter(a => a.status === 'ATIVA');
    return `<div class="summary-grid">
        ${summaryCard('Saldo em contas', sum(active, a => a.currentBalance), '◇', 'success')}
        ${summaryCard('Contas ativas', String(active.length), '#', 'primary', true)}
        ${summaryCard('Maior saldo', Math.max(0, ...accounts.map(a => Number(a.currentBalance))), '↑', 'blue')}
        ${summaryCard('Negativas', String(accounts.filter(a => a.currentBalance < 0).length), '!', 'danger', true)}
      </div>
      <div class="entity-grid">${accounts.map(account => {
        const ref = CP.currentRef();
        const income = sum((db().incomes || []).filter(i => i.bankAccountId === account.id && CP.monthKey(i.date) === ref), i => i.amount);
        const outflow = sum((db().expenses || []).filter(i => i.bankAccountId === account.id && i.status === 'PAGO' && CP.monthKey(i.date) === ref), i => i.amount);
        return `<article class="entity-card" style="--account-color:${account.color}">
          <div class="entity-head">
            <div class="entity-title"><span class="bank-symbol">${esc(account.bankName.slice(0, 1))}</span>
              <div><h3>${esc(account.name)}</h3><p>${esc(account.bankName)} · ${esc(String(account.accountType).replaceAll('_', ' ').toLowerCase())}</p></div>
            </div>${badge(account.status, account.status === 'ATIVA' ? 'success' : '')}
          </div>
          <div class="entity-balance"><small>Saldo calculado</small><strong>${money(account.currentBalance)}</strong></div>
          <div class="entity-stats">
            <div><small>Entradas no mês</small><strong class="money-positive">+ ${money(income)}</strong></div>
            <div><small>Saídas no mês</small><strong class="money-negative">− ${money(outflow)}</strong></div>
          </div>
          <div class="entity-actions">
            <button class="button small" data-action="account-movements" data-id="${account.id}">Extrato</button>
            <button class="button small ghost" data-action="edit-account" data-id="${account.id}">Editar</button>
            <button class="button small ghost" data-action="toggle-account" data-id="${account.id}">${account.status === 'ATIVA' ? 'Inativar' : 'Reativar'}</button>
          </div>
        </article>`;
      }).join('') ||
      emptyState('Nenhuma conta cadastrada', 'Adicione uma conta para começar a registrar suas movimentações.', 'Cadastrar conta', 'add-account')}
      </div>`;
  };

  const cardsTab = () => {
    const cards = db().cardsBenefits || [];
    const credit = cards.filter(c => !CP.isBenefit(c));
    const benefits = cards.filter(CP.isBenefit);
    const totalLimit = sum(credit.filter(c => c.status === 'ATIVO'), c => c.limit);
    const used = sum((db().cardInstallments || []).filter(i => i.status === 'ABERTA'), i => i.amount);

    return `<div class="summary-grid">
        ${summaryCard('Limite total', totalLimit, '▰', 'blue')}
        ${summaryCard('Limite usado', used, '◐', 'warning')}
        ${summaryCard('Saldo em benefícios', sum(benefits.filter(b => b.status === 'ATIVO'), b => b.benefitBalance), '✦', 'success')}
        ${summaryCard('Disponível', Math.max(0, totalLimit - used), '◎', 'primary')}
      </div>
      <div class="entity-grid">${cards.map(cardEntity).join('') ||
        emptyState('Nenhum cartão ou benefício', 'Cadastre cartões de crédito, vale alimentação ou vale refeição.', 'Novo cartão ou benefício', 'add-card')}
      </div>`;
  };

  const cardEntity = card => {
    const benefit = CP.isBenefit(card);
    const used = sum((db().cardInstallments || []).filter(i => i.creditCardId === card.id && i.status === 'ABERTA'), i => i.amount);
    const nextInvoice = (db().cardInvoices || [])
      .filter(i => i.creditCardId === card.id && i.status === 'ABERTA' && Number(i.totalAmount) > 0)
      .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)))[0];
    const usagePct = clamp(CP.pct(used, card.limit), 0, 100);

    return `<article class="entity-card">
      <div class="credit-card-visual" style="--card-color:${card.color};min-height:156px;margin:-18px -18px 17px;border-radius:20px 20px 14px 14px">
        <div class="cc-top"><span class="chip"></span>${badge(benefit ? CP.cardTypeLabel(card.cardType) : card.status, benefit ? 'primary' : card.status === 'ATIVO' ? 'success' : '')}</div>
        <h3>${esc(card.name)}</h3><span class="cc-bank">${esc(card.bankName)}</span>
        <div class="cc-metrics">${benefit
          ? `<div><small>Saldo disponível</small><strong>${money(card.benefitBalance)}</strong></div>
             <div><small>Modalidade</small><strong>Benefício</strong></div>`
          : `<div><small>Próxima fatura</small><strong>${money(nextInvoice?.totalAmount || 0)}</strong></div>
             <div><small>${nextInvoice ? CP.monthLabel(nextInvoice.referenceMonth) : 'Sem fatura'}</small><strong>${nextInvoice ? CP.date(nextInvoice.dueDate) : '—'}</strong></div>`}
        </div>
      </div>
      ${benefit
        ? `<div class="progress-meta"><span>Saldo para consumo</span><span>${card.status}</span></div>
           <div class="progress"><i style="width:${card.benefitBalance > 0 ? 100 : 0}%;background:${card.color}"></i></div>`
        : `<div class="progress-meta"><span>${money(used)} usado</span><span>${usagePct.toFixed(0)}% do limite</span></div>
           <div class="progress"><i style="width:${usagePct}%;background:${card.color}"></i></div>`}
      <div class="entity-actions">
        ${benefit ? `<button class="button small" data-action="topup-card" data-id="${card.id}">Recarregar</button>` : ''}
        ${!benefit && nextInvoice ? `<button class="button small" data-action="view-invoice" data-card="${card.id}" data-reference="${nextInvoice.referenceMonth}">Ver fatura</button>` : ''}
        <button class="button small ghost" data-action="edit-card" data-id="${card.id}">Editar</button>
        <button class="button small ghost" data-action="toggle-card" data-id="${card.id}">${card.status === 'ATIVO' ? 'Inativar' : 'Reativar'}</button>
      </div>
    </article>`;
  };

  const invoicesTab = () => {
    const invoices = (db().cardInvoices || [])
      .filter(invoice => Number(invoice.totalAmount) > 0)
      .filter(invoice => state.filters.card === 'all' || invoice.creditCardId === state.filters.card)
      .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)));
    const open = invoices.filter(i => i.status === 'ABERTA');

    return `${CP.filterBar({ compact: true, search: false })}
      <div class="summary-grid">
        ${summaryCard('Faturas em aberto', sum(open, i => i.totalAmount), '▰', 'danger')}
        ${summaryCard('Quantidade', String(open.length), '#', 'warning', true)}
        ${summaryCard('Próximo vencimento', open[0] ? CP.date(open[0].dueDate) : '—', '⌛', 'blue', true)}
      </div>
      <article class="data-card">${invoices.length ? `<div class="table-wrap"><table class="data-table">
        <thead><tr><th>Cartão</th><th>Referência</th><th>Vencimento</th><th>Parcelas</th><th>Status</th><th>Total</th><th>Ações</th></tr></thead>
        <tbody>${invoices.map(invoice => `<tr>
          <td><div class="cell-main">
            <span class="cell-icon" style="--icon-color:${invoice.cardColor};--icon-soft:${invoice.cardColor}22">▰</span>
            <span><strong>${esc(invoice.cardName)}</strong><small>Fecha dia ${invoice.closingDay || '—'}</small></span>
          </div></td>
          <td>${CP.monthLabel(invoice.referenceMonth)}</td>
          <td>${CP.date(invoice.dueDate)}${invoice.status === 'ABERTA' && invoice.dueDate < CP.today() ? ' <span class="badge danger">vencida</span>' : ''}</td>
          <td>${invoice.installmentCount} item(ns)</td>
          <td>${badge(invoice.status, invoice.status === 'PAGA' ? 'success' : 'warning')}</td>
          <td><strong>${money(invoice.totalAmount)}</strong></td>
          <td><div class="actions-cell">
            <button class="button small" data-action="view-invoice" data-card="${invoice.creditCardId}" data-reference="${invoice.referenceMonth}">Detalhes</button>
            ${invoice.status === 'ABERTA' ? `<button class="button primary small" data-action="pay-invoice" data-id="${invoice.id}">Paguei</button>` : '<span class="money-positive">✓ Paga</span>'}
          </div></td></tr>`).join('')}</tbody></table></div>`
        : emptyState('Nenhuma fatura', 'Lance uma compra no cartão para ver as parcelas distribuídas nas faturas.', 'Lançar compra', 'add-purchase')}
      </article>`;
  };

  // =========================================================================
  // 5. INVESTIMENTOS
  // =========================================================================

  CP.renderInvestments = () => {
    const requestedTab = activeTab('investments', 'overview');
    const tab = ['overview', 'assets', 'operations', 'income'].includes(requestedTab) ? requestedTab : 'overview';
    state.tab.investments = tab;
    const actions = {
      overview: '<button class="button ghost" data-action="market-settings">⚙ Fontes</button><button class="button ghost" data-action="refresh-market">↻ Atualizar cotações</button><button class="button primary" data-action="add-investment">＋ Ativo</button>',
      assets: '<button class="button ghost" data-action="refresh-market">↻ Atualizar preços</button><button class="button primary" data-action="add-investment">＋ Novo ativo</button>',
      operations: '<button class="button primary" data-action="add-operation">＋ Compra ou venda</button>',
      income: '<button class="button ghost" data-action="refresh-market">↻ Sincronizar proventos</button>'
    }[tab];

    return `<section class="page investments-page">
      ${pageHeading('Sua carteira consolidada, do aporte à rentabilidade.', actions)}
      ${marketSourceBar()}
      ${tabs('investments', [
        { id: 'overview', label: 'Resumo' },
        { id: 'assets', label: 'Ativos', count: (db().investments || []).length },
        { id: 'operations', label: 'Transações', count: (db().investmentOperations || []).length },
        { id: 'income', label: 'Proventos', count: (db().investmentIncome || []).length }
      ])}
      ${{ overview: investmentOverview, assets: investmentAssets,
          operations: investmentOperations, income: investmentIncome }[tab]()}
    </section>`;
  };

  const INVESTMENT_COLORS = ['#d7ff37', '#2ee59d', '#4ea8ff', '#8b5cf6', '#ffbf47', '#22d3ee', '#f472b6'];
  const signedPct = value => `${Number(value) >= 0 ? '+' : ''}${Number(value || 0).toFixed(2)}%`;
  const quantity = value => Number(value || 0).toLocaleString('pt-BR', { maximumFractionDigits: 8 });
  const assetName = id => (db().investments || []).find(item => item.id === id);
  const assetSymbol = item => item.symbol || item.name;

  const marketSourceBar = () => {
    const status = db().marketDataStatus || {};
    const summary = db().investmentPortfolio || {};
    const stamp = summary.lastQuoteAt ? new Date(summary.lastQuoteAt).toLocaleString('pt-BR') : 'ainda não atualizada';
    return `<div class="market-source-bar">
      <span class="market-pulse"></span><div><strong>Cotações automáticas</strong><small>Última atualização: ${esc(stamp)}</small></div>
      <span class="market-source-tags"><i>Brapi</i><i>CoinGecko</i><i>Yahoo fallback</i></span>
      <span class="market-plan ${status.brapiConfigured ? 'ready' : ''}">${status.brapiConfigured ? 'Brapi conectada' : 'Token Brapi pendente'}</span>
    </div>`;
  };

  const portfolioEvolution = snapshots => {
    const points = snapshots?.length ? snapshots : (db().dashboard?.investmentEvolution || []).map(row => ({
      // O painel devolve o mês ("2026-03"); o gráfico mostra datas.
      referenceDate: row.month ? `${row.month}-01` : '', marketValue: row.value || 0, investedAmount: row.value || 0
    }));
    if (!points.length) return `<div class="chart-empty"><span>⌁</span><strong>A evolução começa no primeiro aporte</strong><small>Os retratos diários serão salvos automaticamente.</small></div>`;
    const width = 720; const height = 230; const pad = 18;
    const values = points.map(point => Number(point.marketValue) || 0);
    const max = Math.max(...values, 1); const min = Math.min(...values, 0); const range = max - min || 1;
    const coords = values.map((value, index) => {
      const x = pad + (index / Math.max(1, values.length - 1)) * (width - pad * 2);
      const y = height - pad - ((value - min) / range) * (height - pad * 2);
      return [x, y];
    });
    const path = coords.map((point, index) => `${index ? 'L' : 'M'} ${point[0].toFixed(1)} ${point[1].toFixed(1)}`).join(' ');
    const area = `${path} L ${coords.at(-1)[0]} ${height - pad} L ${coords[0][0]} ${height - pad} Z`;
    return `<div class="portfolio-chart"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Evolução do patrimônio">
      <defs><linearGradient id="portfolioArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#d7ff37" stop-opacity=".3"/><stop offset="1" stop-color="#d7ff37" stop-opacity="0"/></linearGradient></defs>
      <path class="portfolio-area" d="${area}"/><path class="portfolio-line" d="${path}"/>
      ${coords.map((point, index) => `<circle cx="${point[0]}" cy="${point[1]}" r="4"><title>${CP.date(points[index].referenceDate)} · ${money(values[index])}</title></circle>`).join('')}
      </svg><div class="chart-range"><span>${CP.date(points[0].referenceDate)}</span><span>${CP.date(points.at(-1).referenceDate)}</span></div></div>`;
  };

  const allocationChart = allocations => {
    if (!allocations?.length) return `<div class="chart-empty compact"><span>◉</span><small>Sem ativos para distribuir</small></div>`;
    let offset = 0;
    const gradient = allocations.map((item, index) => {
      const start = offset; offset += item.percent;
      return `${INVESTMENT_COLORS[index % INVESTMENT_COLORS.length]} ${start}% ${offset}%`;
    }).join(',');
    return `<div class="allocation-wrap"><div class="allocation-donut" style="--allocation:conic-gradient(${gradient})"><div><strong>${allocations.length}</strong><span>classes</span></div></div>
      <div class="allocation-legend">${allocations.map((item, index) => `<div><i style="--dot:${INVESTMENT_COLORS[index % INVESTMENT_COLORS.length]}"></i><span>${esc(item.label)}</span><strong>${item.percent.toFixed(1)}%</strong></div>`).join('')}</div></div>`;
  };

  const investmentOverview = () => {
    const summary = db().investmentPortfolio || {};
    const profitClass = Number(summary.totalProfit) >= 0 ? 'positive' : 'negative';
    return `<div class="portfolio-hero">
      <div class="portfolio-value"><span>Patrimônio investido</span><strong>${money(summary.marketValue)}</strong><small><i class="${profitClass}">${signedPct(summary.profitability)}</i> rentabilidade total</small></div>
      <div class="portfolio-kpis">
        <div><span>Capital investido</span><strong>${money(summary.investedAmount)}</strong></div>
        <div><span>Lucro total</span><strong class="${profitClass}">${money(summary.totalProfit)}</strong></div>
        <div><span>Proventos recebidos</span><strong>${money(summary.incomeReceived)}</strong></div>
        <div><span>Variação do dia</span><strong class="${Number(summary.dayChange) >= 0 ? 'positive' : 'negative'}">${signedPct(summary.dayChange)}</strong></div>
      </div>
    </div>
    <div class="investment-insight-row"><span><b>${summary.assetsCount || 0}</b> ativos</span><span><b>${summary.institutionsCount || 0}</b> instituições</span><span><b>${(db().investmentOperations || []).length}</b> transações registradas</span><span>Dados para organização pessoal, sem execução de ordens</span></div>
    <div class="portfolio-panels">
      <article class="panel portfolio-evolution"><header class="panel-header"><div class="panel-title"><h3>Evolução patrimonial</h3><p>Valor de mercado da sua carteira</p></div><span class="badge primary">Histórico</span></header><div class="panel-body">${portfolioEvolution(summary.snapshots)}</div></article>
      <article class="panel allocation-panel"><header class="panel-header"><div class="panel-title"><h3>Alocação da carteira</h3><p>Distribuição por classe</p></div></header><div class="panel-body">${allocationChart(summary.allocations)}</div></article>
    </div>
    ${investmentAssets(true)}
    <article class="asset-universe"><header><div><span class="eyebrow">COBERTURA COMPLETA</span><h3>Organize todos os seus investimentos</h3></div><small>Cotações públicas onde existem; cálculo contratual nos ativos privados.</small></header>
      <div>${(db().investmentClasses || CP.INVESTMENT_TYPES).map((item, index) => `<span style="--class-color:${INVESTMENT_COLORS[index % INVESTMENT_COLORS.length]}">${esc(item.label)}</span>`).join('')}</div>
    </article>`;
  };

  const investmentAssets = compact => {
    const items = db().investments || [];
    const rows = compact ? items.filter(item => item.status === 'ATIVO').slice(0, 6) : items;
    return `<article class="panel assets-panel"><header class="panel-header"><div class="panel-title"><h3>${compact ? 'Maiores posições' : 'Todos os ativos'}</h3><p>Quantidade, preço médio, cotação e resultado</p></div>${compact ? '<button class="button small ghost" data-tab="investments:assets">Ver carteira completa →</button>' : ''}</header>
      <div class="panel-body no-pad">${rows.length ? `<div class="table-wrap"><table class="data-table investment-table"><thead><tr><th>Ativo</th><th>Quantidade</th><th>Preço médio</th><th>Preço atual</th><th>Patrimônio</th><th>Resultado</th><th>Carteira</th><th></th></tr></thead><tbody>${rows.map(item => `<tr>
        <td><div class="asset-identity"><span>${esc(String(assetSymbol(item)).slice(0, 2).toUpperCase())}</span><div><strong>${esc(assetSymbol(item))}</strong><small>${esc(item.classLabel || item.type)} · ${esc(item.institution)}</small></div></div></td>
        <td>${quantity(item.quantity)}</td><td>${money(item.averagePrice)}</td>
        <td><strong>${money(Number(item.currentPrice) * Number(item.exchangeRate || 1))}</strong><small class="quote-meta">${esc(item.quoteSource || (item.quoted ? 'aguardando cotação' : 'valor projetado'))}</small></td>
        <td><strong>${money(item.marketValue)}</strong></td>
        <td><span class="return-pill ${Number(item.profitability) >= 0 ? 'up' : 'down'}">${signedPct(item.profitability)}</span><small class="quote-meta">${money(item.totalProfit)}</small></td>
        <td><div class="allocation-cell"><i><b style="width:${clamp(item.allocation, 0, 100)}%"></b></i><span>${Number(item.allocation || 0).toFixed(1)}%</span></div></td>
        <td><div class="actions-cell"><button class="button small" data-action="add-operation" data-investment="${item.id}">Operar</button><button class="button small ghost icon-only" data-action="edit-investment" data-id="${item.id}" aria-label="Editar">✎</button></div></td>
      </tr>`).join('')}</tbody></table></div>` : emptyState('Sua carteira começa aqui', 'Cadastre o código e a quantidade. O preço será buscado automaticamente.', 'Cadastrar primeiro ativo', 'add-investment')}</div></article>`;
  };

  const investmentOperations = () => {
    const items = CP.applyList(db().investmentOperations || [], { period: true });
    return `${CP.filterBar({ compact: true, searchPlaceholder: 'Buscar transação…' })}<article class="panel"><header class="panel-header"><div class="panel-title"><h3>Histórico de transações</h3><p>Compras, vendas, aportes, resgates e bonificações</p></div></header><div class="panel-body no-pad">${items.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Ativo</th><th>Operação</th><th>Data</th><th>Quantidade</th><th>Preço unitário</th><th>Total</th><th>Conta</th><th></th></tr></thead><tbody>${items.map(item => { const asset = assetName(item.investmentId) || {}; return `<tr><td><strong>${esc(assetSymbol(asset) || '—')}</strong><small class="quote-meta">${esc(asset.name || '')}</small></td><td><span class="operation-type ${['VENDA', 'RESGATE'].includes(item.operationType) ? 'sell' : 'buy'}">${esc(item.operationType)}</span></td><td>${CP.date(item.date)}</td><td>${quantity(item.quantity)}</td><td>${money(Number(item.unitPrice) * Number(item.exchangeRate || 1))}</td><td><strong>${money(item.totalAmount)}</strong></td><td>${esc(item.bankAccountId ? CP.accountName(item.bankAccountId) : 'Sem movimentar conta')}</td><td><button class="button danger small icon-only" data-action="delete-operation" data-id="${item.id}" aria-label="Excluir">×</button></td></tr>`; }).join('')}</tbody></table></div>` : emptyState('Nenhuma transação', 'Registre sua primeira compra para calcular quantidade e preço médio.', 'Registrar compra', 'add-operation')}</div></article>`;
  };

  const investmentIncome = () => {
    const rows = db().investmentIncome || [];
    const received = rows.filter(item => item.status !== 'PREVISTO');
    return `<div class="summary-grid">${summaryCard('Proventos recebidos', sum(received, item => item.totalAmount), '↘', 'success')}${summaryCard('A receber', sum(rows.filter(item => item.status === 'PREVISTO'), item => item.totalAmount), '◷', 'primary')}${summaryCard('Eventos encontrados', String(rows.length), '#', 'blue', true)}</div>
      <article class="panel"><header class="panel-header"><div class="panel-title"><h3>Agenda de proventos</h3><p>Dividendos e rendimentos sincronizados para suas quantidades</p></div></header><div class="panel-body no-pad">${rows.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Ativo</th><th>Tipo</th><th>Data-com</th><th>Pagamento</th><th>Quantidade</th><th>Por cota</th><th>Total</th><th>Status</th></tr></thead><tbody>${rows.map(item => `<tr><td><strong>${esc(assetSymbol(assetName(item.investmentId) || {}))}</strong></td><td>${esc(item.incomeType)}</td><td>${CP.date(item.exDate)}</td><td>${CP.date(item.paymentDate)}</td><td>${quantity(item.quantity)}</td><td>${money(item.valuePerUnit)}</td><td><strong>${money(item.totalAmount)}</strong></td><td>${badge(item.status, item.status === 'RECEBIDO' ? 'success' : 'warning')}</td></tr>`).join('')}</tbody></table></div>` : emptyState('Nenhum provento sincronizado', 'Atualize as cotações depois de cadastrar ações, FIIs ou Fiagros.', 'Atualizar agora', 'refresh-market')}</div></article>`;
  };

  // =========================================================================
  // 6. RELATÓRIOS
  // =========================================================================

  CP.renderReports = () => {
    const report = state.reports;
    if (!report) {
      return `<section class="page">${pageHeading('Carregando análise do ano…')}
        ${emptyState('Montando os relatórios', 'Só um instante.')}</section>`;
    }

    const tab = activeTab('reports', 'statement');
    return `<section class="page">
      ${pageHeading(`Análise completa de ${report.year}.`,
        `<button class="button ghost" data-action="export-csv">↓ Exportar CSV</button>
         <button class="button primary" data-action="export-pdf">⎙ Salvar PDF</button>`)}
      ${CP.filterBar({ compact: true, search: false })}
      ${tabs('reports', [
        { id: 'statement', label: 'Resumo mensal' },
        { id: 'categories', label: 'Por categoria' },
        { id: 'comparison', label: 'Ano a ano' },
        { id: 'ledger', label: 'Extrato' }
      ])}
      ${{ statement: statementTab, categories: categoriesTab, comparison: comparisonTab, ledger: ledgerTab }[tab](report)}
    </section>`;
  };

  const statementTab = report => {
    const { rows, totals } = report.statement;
    return `<div class="report-grid">
        ${reportTile('Entradas no ano', totals.income, 'success')}
        ${reportTile('Saídas no ano', totals.outflow, 'danger')}
        ${reportTile('Resultado', totals.result, totals.result >= 0 ? 'success' : 'danger')}
        ${reportTile('Investido', totals.invested, 'blue')}
      </div>
      <article class="panel">
        <header class="panel-header"><div class="panel-title"><h3>Resumo mensal</h3><p>Quanto entrou, quanto saiu e quanto sobrou, mês a mês</p></div></header>
        <div class="panel-body"><div class="table-wrap"><table class="data-table statement-table">
          <thead><tr><th>Mês</th><th>Entradas</th><th>Fixas</th><th>Variáveis</th><th>Faturas</th><th>Investido</th><th>Saídas</th><th>Resultado</th><th>% poupado</th></tr></thead>
          <tbody>${rows.map(row => `<tr>
            <td><strong>${row.label}</strong></td>
            <td class="money-positive">${money(row.income)}</td>
            <td>${money(row.fixed)}</td>
            <td>${money(row.variable)}</td>
            <td>${money(row.invoices)}</td>
            <td>${money(row.invested)}</td>
            <td class="money-negative">${money(row.outflow)}</td>
            <td class="${row.result >= 0 ? 'positive' : 'negative'}"><strong>${money(row.result)}</strong></td>
            <td>${row.income ? `${row.savingRate.toFixed(0)}%` : '—'}</td>
          </tr>`).join('')}</tbody>
          <tfoot><tr>
            <td><strong>Total</strong></td>
            <td class="money-positive"><strong>${money(totals.income)}</strong></td>
            <td><strong>${money(totals.fixed)}</strong></td>
            <td><strong>${money(totals.variable)}</strong></td>
            <td><strong>${money(totals.invoices)}</strong></td>
            <td><strong>${money(totals.invested)}</strong></td>
            <td class="money-negative"><strong>${money(totals.outflow)}</strong></td>
            <td class="${totals.result >= 0 ? 'positive' : 'negative'}"><strong>${money(totals.result)}</strong></td>
            <td><strong>${totals.savingRate.toFixed(0)}%</strong></td>
          </tr></tfoot>
        </table></div></div>
      </article>
      <div class="dashboard-grid" style="margin-top:14px">
        <article class="panel">
          <header class="panel-header"><div class="panel-title"><h3>Entradas vs. saídas</h3><p>${report.year}</p></div></header>
          <div class="panel-body">${barChart(rows)}</div>
        </article>
        <article class="panel">
          <header class="panel-header"><div class="panel-title"><h3>Resultado acumulado</h3><p>Quanto sobrou por mês</p></div></header>
          <div class="panel-body">${lineChart(rows.map(r => r.result), 'var(--success)', 'result')}</div>
        </article>
      </div>`;
  };

  const reportTile = (label, value, tone) => `
    <div class="report-tile"><small>${esc(label)}</small>
      <strong class="${tone === 'success' ? 'money-positive' : tone === 'danger' ? 'money-negative' : ''}">${money(value)}</strong></div>`;

  const categoriesTab = report => {
    const { categories, monthTotals, grandTotal } = report.categories;
    if (!categories.length) {
      return emptyState('Sem gastos registrados em ' + report.year, 'Registre saídas para ver a evolução de cada categoria mês a mês.');
    }
    const maxValue = Math.max(...categories.flatMap(c => c.months));
    return `<article class="panel">
      <header class="panel-header"><div class="panel-title">
        <h3>Categoria mês a mês</h3><p>Quanto mais forte a cor, maior o gasto naquele mês</p></div></header>
      <div class="panel-body"><div class="matrix-wrap"><table class="matrix-table">
        <thead><tr><th>Categoria</th>${CP.MONTHS.map(m => `<th>${m}</th>`).join('')}<th>Total</th><th>Média</th></tr></thead>
        <tbody>${categories.map(row => `<tr>
          <td><strong>${esc(row.category)}</strong></td>
          ${row.months.map(value => `<td class="matrix-heat ${value ? '' : 'zero'}" style="--heat:${maxValue ? value / maxValue : 0}">${value ? money(value, true) : '—'}</td>`).join('')}
          <td><strong>${money(row.total, true)}</strong></td>
          <td>${money(row.activeMonths ? row.total / row.activeMonths : 0, true)}</td>
        </tr>`).join('')}</tbody>
        <tfoot><tr><td><strong>Total</strong></td>
          ${monthTotals.map(value => `<td><strong>${value ? money(value, true) : '—'}</strong></td>`).join('')}
          <td><strong>${money(grandTotal, true)}</strong></td><td></td></tr></tfoot>
      </table></div></div>
    </article>
    <div class="dashboard-grid" style="margin-top:14px">
      <article class="panel">
        <header class="panel-header"><div class="panel-title"><h3>Distribuição do ano</h3><p>Participação de cada categoria</p></div></header>
        <div class="panel-body">${donut(categories.map(c => ({ name: c.category, value: c.total })))}</div>
      </article>
      <article class="panel">
        <header class="panel-header"><div class="panel-title"><h3>Maiores categorias</h3><p>Onde o dinheiro mais foi</p></div></header>
        <div class="panel-body">${categories.slice(0, 8).map(row => `
          <div class="budget-row">
            <div class="budget-top"><span>${esc(row.category)}</span><strong>${money(row.total)}</strong></div>
            <div class="budget-bar ok"><i style="width:${CP.pct(row.total, grandTotal).toFixed(0)}%"></i></div>
            <small class="budget-note">${CP.pct(row.total, grandTotal).toFixed(1)}% do total · ${row.activeMonths} mês(es) com gasto</small>
          </div>`).join('')}</div>
      </article>
    </div>`;
  };

  const comparisonTab = report => {
    const { current, previous, deltas } = report.comparison;
    const deltaTile = (label, delta, invert = false) => {
      const good = invert ? delta.value < 0 : delta.value > 0;
      const tone = delta.value === 0 ? 'neutral' : good ? 'up' : 'down';
      return `<div class="report-tile"><small>${esc(label)}</small>
        <strong>${money(delta.value >= 0 ? delta.value : -delta.value)}</strong>
        <span class="report-delta ${tone}">${delta.value > 0 ? '↑' : delta.value < 0 ? '↓' : '→'} ${pctText(delta.pct)} vs ${previous.year}</span></div>`;
    };

    return `<div class="report-grid">
        ${deltaTile('Variação nas entradas', deltas.income)}
        ${deltaTile('Variação nas saídas', deltas.outflow, true)}
        ${deltaTile('Variação no resultado', deltas.result)}
        ${deltaTile('Variação no investido', deltas.invested)}
      </div>
      <article class="panel">
        <header class="panel-header"><div class="panel-title">
          <h3>${current.year} vs ${previous.year}</h3><p>Comparação mês a mês</p></div></header>
        <div class="panel-body"><div class="table-wrap"><table class="data-table statement-table">
          <thead><tr><th>Mês</th>
            <th>Entradas ${previous.year}</th><th>Entradas ${current.year}</th>
            <th>Saídas ${previous.year}</th><th>Saídas ${current.year}</th>
            <th>Resultado ${current.year}</th></tr></thead>
          <tbody>${current.rows.map((row, index) => {
            const old = previous.rows[index];
            return `<tr><td><strong>${row.label}</strong></td>
              <td>${money(old.income)}</td>
              <td class="${row.income >= old.income ? 'positive' : 'negative'}">${money(row.income)}</td>
              <td>${money(old.outflow)}</td>
              <td class="${row.outflow <= old.outflow ? 'positive' : 'negative'}">${money(row.outflow)}</td>
              <td><strong class="${row.result >= 0 ? 'money-positive' : 'money-negative'}">${money(row.result)}</strong></td></tr>`;
          }).join('')}</tbody>
          <tfoot><tr><td><strong>Total</strong></td>
            <td><strong>${money(previous.income)}</strong></td><td><strong>${money(current.income)}</strong></td>
            <td><strong>${money(previous.outflow)}</strong></td><td><strong>${money(current.outflow)}</strong></td>
            <td><strong>${money(current.result)}</strong></td></tr></tfoot>
        </table></div></div>
      </article>`;
  };

  const ledgerTab = report => {
    const query = CP.normalize(state.search.reports || '');
    const rows = query
      ? report.ledger.filter(row => CP.normalize(Object.values(row).join(' ')).includes(query))
      : report.ledger;

    return `<div class="filter-bar">
        <span class="filter-caption">⌕ Buscar</span>
        <div class="field" style="flex:1"><input data-search placeholder="Buscar no extrato…" value="${esc(state.search.reports || '')}"></div>
        <button class="button ghost small" data-action="export-csv">↓ Exportar tudo</button>
      </div>
      <article class="data-card">${rows.length ? `<div class="table-wrap"><table class="data-table">
        <thead><tr><th>Tipo</th><th>Descrição</th><th>Categoria</th><th>Conta / cartão</th><th>Forma</th><th>Data</th><th>Valor</th></tr></thead>
        <tbody>${rows.map(row => `<tr>
          <td>${badge(row.kind, row.signed > 0 ? 'success' : row.signed < 0 ? '' : 'primary')}</td>
          <td><strong>${esc(row.description)}</strong></td>
          <td>${esc(row.category)}</td>
          <td>${esc(row.account)}</td>
          <td>${esc(row.method)}</td>
          <td>${CP.date(row.date)}</td>
          <td class="${row.signed > 0 ? 'money-positive' : row.signed < 0 ? 'money-negative' : ''}">
            ${row.signed > 0 ? '+ ' : row.signed < 0 ? '− ' : ''}${money(row.amount)}</td>
        </tr>`).join('')}</tbody></table></div>
        <p class="empty-hint">Mostrando ${rows.length} lançamento(s). Use "Exportar tudo" para levar o período completo para o Excel.</p>`
        : emptyState('Nada encontrado', 'Ajuste a busca ou o período.')}
      </article>`;
  };

  // =========================================================================
  // 7. CONFIGURAÇÕES
  // =========================================================================

  CP.renderSettings = () => {
    const tab = activeTab('settings', 'profile');
    return `<section class="page">
      ${pageHeading('Seu perfil, suas categorias, suas regras e a segurança dos seus dados.')}
      ${tabs('settings', [
        { id: 'profile', label: 'Perfil e aparência' },
        { id: 'categories', label: 'Categorias' },
        { id: 'rules', label: 'Regras automáticas' },
        { id: 'data', label: 'Dados e backup' },
        { id: 'about', label: 'Sobre' }
      ])}
      ${{ profile: profileTab, categories: categoriesSettingsTab, rules: () => CP.renderRulesSection(),
          data: dataTab, about: aboutTab }[tab]()}
    </section>`;
  };

  const profileTab = () => {
    const profile = db().profile || { name: '', monthlyGoal: 0, emergencyReserveGoal: 0 };
    const settings = db().settings || {};
    const hidden = settings.hidden_sections || [];
    return `<div class="settings-grid"><div class="settings-stack">
      <section class="settings-section">
        <h3>Perfil financeiro</h3><p>As metas que alimentam os indicadores da visão geral.</p>
        <form id="profileForm" class="form-grid">
          ${CP.field('name', 'Nome da carteira', profile.name, { full: true })}
          ${CP.field('monthlyGoal', 'Meta de sobra mensal', CP.moneyInput(profile.monthlyGoal), { currency: true, help: 'Quanto você quer que sobre todo mês.' })}
          ${CP.field('emergencyReserveGoal', 'Meta da reserva de emergência', CP.moneyInput(profile.emergencyReserveGoal), { currency: true, help: 'Costuma ser de 3 a 6 meses de despesas.' })}
          <div class="form-footer field full"><button type="submit" class="button primary">Salvar perfil</button></div>
        </form>
      </section>

      <section class="settings-section">
        <h3>Aparência</h3><p>Como o app se apresenta.</p>
        <div class="toggle-row"><div><strong>Tema escuro</strong><small>Alterne entre o tema escuro e o claro</small></div>
          <button class="toggle ${settings.theme !== 'light' ? 'active' : ''}" data-action="toggle-theme" aria-label="Alternar tema"></button></div>
        <div class="toggle-row"><div><strong>Modo compacto</strong><small>Mais linhas por tela em listas e tabelas</small></div>
          <button class="toggle ${settings.density === 'compact' ? 'active' : ''}" data-action="toggle-density" aria-label="Alternar densidade"></button></div>
        <div class="toggle-row"><div><strong>Bloco de inteligência</strong><small>Score, comparativo, projeções e radar</small></div>
          <button class="toggle ${!hidden.includes('intel') ? 'active' : ''}" data-action="toggle-section" data-section="intel" aria-label="Alternar bloco"></button></div>
        <div class="toggle-row"><div><strong>Orçamento e metas</strong><small>Barras de orçamento, metas e conquistas</small></div>
          <button class="toggle ${!hidden.includes('budget') ? 'active' : ''}" data-action="toggle-section" data-section="budget" aria-label="Alternar bloco"></button></div>
      </section>

      <section class="settings-section">
        <h3>Avisos de vencimento</h3><p>O app avisa uma vez por dia, no máximo, sobre contas próximas do vencimento.</p>
        <div class="toggle-row"><div><strong>Notificações do sistema</strong><small>Aviso nativo do ${navigator.platform.includes('Mac') ? 'macOS' : 'Windows'}</small></div>
          <button class="toggle ${settings.notifications_enabled !== false ? 'active' : ''}" data-action="toggle-notifications" aria-label="Alternar avisos"></button></div>
        <form id="notificationForm" class="form-grid">
          ${CP.field('notifications_days', 'Avisar com quantos dias de antecedência', settings.notifications_days ?? 3, { type: 'number', min: 0, max: 30, full: true })}
          <div class="form-footer field full"><button type="submit" class="button primary">Salvar</button></div>
        </form>
      </section>
    </div>

    <section class="settings-section">
      <h3>Ferramentas</h3><p>Atalhos que também estão na paleta de comandos (Cmd/Ctrl + K).</p>
      <div class="data-actions">
        <button class="button" data-action="edit-budgets">◎ Orçamento por categoria</button>
        <button class="button" data-action="open-simulator">◐ Simulador "e se"</button>
        <button class="button" data-action="open-retro">✦ Retrospectiva do mês</button>
        <button class="button" data-action="close-month">✓ Fechamento do mês</button>
        <button class="button" data-action="open-calendar">▦ Calendário e saldo projetado</button>
        <button class="button" data-action="open-subscriptions">🔁 Gastos recorrentes</button>
        <button class="button" data-action="suggest-budgets">◈ Sugerir orçamento pelo histórico</button>
        <button class="button" data-action="year-comparison">⇅ Comparar com o ano passado</button>
        <button class="button" data-action="import-statement">↑ Importar extrato (CSV/OFX)</button>
        <button class="button" data-action="export-csv">↓ Exportar relatório CSV</button>
        <button class="button" data-action="export-pdf">⎙ Salvar PDF</button>
      </div>
    </section></div>`;
  };

  const categoriesSettingsTab = () => {
    const sections = [
      ['income', 'Categorias de entrada', 'Salário, freela, comissão e outras fontes.'],
      ['variableExpense', 'Saídas variáveis', 'Gastos do dia a dia e consumo.'],
      ['fixedExpense', 'Despesas fixas', 'Compromissos recorrentes mensais.'],
      ['investment', 'Tipos de investimento', 'Classificação da sua carteira de ativos.']
    ];
    return `<section class="settings-section">
      <h3>Categorias personalizadas</h3>
      <p>Excluir uma categoria não altera os lançamentos antigos — ela só deixa de aparecer nas opções.</p>
      <div class="settings-stack">${sections.map(([type, title, description]) => `
        <div>
          <div class="entity-head" style="margin-bottom:10px">
            <div><strong>${title}</strong><p style="margin:2px 0 0;color:var(--muted);font-size:10px">${description}</p></div>
            <button class="button small" data-action="add-category" data-type="${type}">＋ Adicionar</button>
          </div>
          <div class="category-list">${(db().categories?.[type] || []).map(item => `
            <span class="category-tag">${esc(item.name)}
              <button data-action="delete-category" data-type="${type}" data-id="${item.id}" aria-label="Excluir">×</button></span>`).join('') ||
            '<span class="empty-hint">Nenhuma categoria neste grupo.</span>'}</div>
        </div>`).join('')}</div>
    </section>`;
  };

  const dataTab = () => {
    const settings = db().settings || {};
    const backups = state.backups || [];
    return `<div class="settings-grid"><div class="settings-stack">
      <section class="settings-section">
        <h3>Backup automático</h3>
        <p>Este app guarda tudo num arquivo só, neste computador. O backup é a sua rede de segurança.</p>
        <div class="toggle-row"><div><strong>Backup automático</strong><small>Cópia feita ao abrir e ao fechar o app</small></div>
          <button class="toggle ${settings.backup_enabled !== false ? 'active' : ''}" data-action="toggle-backup" aria-label="Alternar backup"></button></div>
        <form id="backupForm" class="form-grid">
          ${CP.field('backup_frequency', 'Frequência', settings.backup_frequency || 'daily', {
            select: [{ value: 'daily', label: 'Diário' }, { value: 'weekly', label: 'Semanal' }, { value: 'always', label: 'Toda vez que abrir' }] })}
          ${CP.field('backup_keep', 'Quantas cópias manter', settings.backup_keep ?? 15, { type: 'number', min: 3, max: 100 })}
          <div class="form-footer field full"><button type="submit" class="button primary">Salvar</button></div>
        </form>
        <div class="data-actions" style="margin-top:12px">
          <button class="button" data-action="backup-now">⇩ Fazer backup agora</button>
          <button class="button" data-action="choose-backup-folder">📁 Escolher pasta</button>
          <button class="button" data-action="open-backup-folder">↗ Abrir pasta</button>
        </div>
        <p class="empty-hint" id="backupFolderLabel">${esc(settings.backup_folder || 'Usando a pasta padrão do app.')}</p>
      </section>

      <section class="settings-section">
        <h3>Cópias disponíveis</h3><p>Restaurar substitui os dados atuais — mas antes o app guarda uma cópia do estado presente.</p>
        <div class="backup-list">${backups.length ? backups.map(item => `
          <div class="backup-row ${item.auto ? 'auto' : ''}">
            <span class="backup-icon">${item.auto ? '↻' : '⇩'}</span>
            <div><strong>${esc(item.name.replace('carteira-', '').replace('auto-', '').replace('.db', ''))}</strong>
              <small>${item.auto ? 'Automático' : 'Manual'} · ${(item.size / 1024).toFixed(0)} KB · ${CP.relative(item.createdAt)}</small></div>
            <div class="actions-cell">
              <button class="button small" data-action="restore-backup" data-path="${esc(item.path)}">Restaurar</button>
              <button class="button danger small icon-only" data-action="delete-backup" data-path="${esc(item.path)}" aria-label="Excluir">×</button>
            </div>
          </div>`).join('') : '<p class="empty-hint">Nenhum backup ainda. Clique em "Fazer backup agora".</p>'}
        </div>
      </section>
    </div>

    <div class="settings-stack">
      <section class="settings-section">
        <h3>Importações recentes</h3>
        <p>Um lote que entrou errado não obriga a restaurar um backup: desfazer apaga só o que aquela
           importação criou e devolve os saldos que ela ajustou.</p>
        <div class="backup-list">${(state.importBatches || []).length
          ? state.importBatches.map(item => `
          <div class="backup-row ${item.undone ? 'auto' : ''}">
            <span class="backup-icon">${item.undone ? '↺' : '⇪'}</span>
            <div><strong>${esc(item.period || CP.date(item.createdAt.slice(0, 10)))}</strong>
              <small>${item.entries} lançamento(s) · ${esc((item.files || '').slice(0, 60))} · ${CP.relative(item.createdAt)}</small></div>
            <div class="actions-cell">${item.undone
              ? '<span class="kind-tag">desfeita</span>'
              : `<button class="button danger small" data-action="undo-import" data-batch="${esc(item.id)}">Desfazer</button>`}</div>
          </div>`).join('')
          : '<p class="empty-hint">Nenhuma importação em lote ainda.</p>'}
        </div>
      </section>

      <section class="settings-section">
        <h3>Levar para outro computador</h3>
        <p>Exporte um arquivo JSON, copie para a outra máquina e importe. Vai tudo junto: contas, lançamentos, cartões, faturas, investimentos, metas e orçamentos.</p>
        <div class="data-actions">
          <button class="button" data-action="export-json">↓ Exportar dados (JSON)</button>
          <button class="button" data-action="import-json">↑ Importar dados (JSON)</button>
        </div>
        <p class="empty-hint">A importação também aceita o backup exportado pela planilha antiga do Google.</p>
      </section>

      <section class="settings-section danger-zone">
        <h3>Zona de risco</h3><p>Faça um backup antes. Estas ações não podem ser desfeitas.</p>
        <div class="data-actions">
          <button class="button" data-action="clear-transactions">× Apagar lançamentos</button>
          <button class="button danger" data-action="reset-data">× Apagar tudo e recomeçar</button>
        </div>
        <p class="empty-hint">"Apagar lançamentos" mantém contas, cartões, categorias e metas — só limpa entradas, saídas e aportes.</p>
      </section>
    </div></div>`;
  };

  const aboutTab = () => {
    const info = state.appInfo || {};
    return `<div class="settings-grid"><div class="settings-stack">
      <section class="settings-section">
        <h3>Financeiro do Jarvis</h3>
        <p>Controle financeiro que roda inteiro no seu computador. Sem nuvem, sem conta, sem internet.</p>
        <div class="entity-stats" style="margin-top:14px">
          <div><small>Versão</small><strong>${esc(info.version || '1.0.0')}</strong></div>
          <div><small>Sistema</small><strong>${info.platform === 'darwin' ? 'macOS' : info.platform === 'win32' ? 'Windows' : esc(info.platform || '')}</strong></div>
        </div>
      </section>
      <section class="settings-section">
        <h3>Onde ficam meus dados</h3>
        <p>Um único arquivo SQLite. Faça uma cópia dele e você tem tudo.</p>
        <div class="attachment-list" style="margin-top:12px">
          <div class="attachment-row"><span>🗄️</span><strong>Banco de dados</strong><small>${esc(info.dbPath || '')}</small></div>
          <div class="attachment-row"><span>💾</span><strong>Backups</strong><small>${esc(info.backupPath || '')}</small></div>
        </div>
        <div class="data-actions" style="margin-top:12px">
          <button class="button" data-action="open-data-folder">↗ Abrir pasta de dados</button>
        </div>
      </section>
    </div>
    <div class="settings-stack">
      <section class="settings-section">
        <h3>Atalhos</h3>
        <div class="attachment-list">
          ${[['Cmd/Ctrl + K', 'Paleta de comandos'], ['Cmd/Ctrl + N', 'Novo lançamento'], ['N', 'Novo lançamento (rápido)'],
             ['Cmd/Ctrl + 1…6', 'Ir para uma página'], ['Cmd/Ctrl + P', 'Salvar PDF'], ['Cmd/Ctrl + E', 'Exportar dados'],
             ['Esc', 'Fechar janelas abertas']].map(([key, description]) => `
            <div class="attachment-row"><strong>${esc(description)}</strong><small><kbd>${esc(key)}</kbd></small></div>`).join('')}
        </div>
      </section>
    </div></div>`;
  };
})();
