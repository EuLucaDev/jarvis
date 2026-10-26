/* ==========================================================================
   Telas que dependem de histórico.

     "O que fazer agora"  — o bloco de sugestões da visão geral.
     Assinaturas          — o que se repete todo mês e quanto custa por ano.
     Fechamento do mês    — a rotina de três minutos.
     Calendário           — os vencimentos e o saldo caminhando até o fim do mês.
   ========================================================================== */

'use strict';

(() => {
  const { $, $$, esc, money, state, openModal, closeModal, toast, mutate,
          badge, emptyState, sectionLabel, summaryCard } = CP;

  const db = () => CP.db();
  const api = window.api;

  // =========================================================================
  // O que fazer agora
  // =========================================================================

  const TONE_COLORS = {
    danger: 'var(--danger)', warning: 'var(--warning)',
    primary: 'var(--primary)', blue: 'var(--blue)', success: 'var(--success)'
  };

  /**
   * Fica no topo da visão geral. Em vez de só mostrar números, diz o que fazer
   * — e cada sugestão traz o botão que resolve.
   */
  CP.nextActionsBlock = () => {
    const actions = db().nextActions || [];
    if (!actions.length) return '';

    return `<div class="next-actions">
      ${actions.map((action, index) => `
        <article class="next-action" style="--tone:${TONE_COLORS[action.tone] || 'var(--muted)'};--i:${index}">
          <span class="next-icon">${action.icon}</span>
          <div class="next-copy">
            <strong>${esc(action.title)}</strong>
            <small>${esc(action.detail)}</small>
          </div>
          <button class="button small" data-next-action='${esc(JSON.stringify(action.action))}'>${esc(action.label)}</button>
        </article>`).join('')}
    </div>`;
  };

  /** Cada sugestão sabe se resolver sozinha. */
  CP.runNextAction = async raw => {
    let action;
    try { action = JSON.parse(raw); } catch (error) { return; }
    if (!action) return;

    switch (action.type) {
      case 'go':
        if (action.tab) state.tab[action.page] = action.tab;
        return CP.navigate(action.page);
      case 'generate-fixed':
        return CP.runAction('generate-fixed');
      case 'close-month':
        return CP.openMonthClosing();
      case 'subscriptions':
        return CP.openSubscriptions();
      case 'calendar':
        return CP.openCalendar();
      case 'import':
        return CP.openImport();
      case 'add-goal':
        return CP.runAction('add-goal');
      default:
        return null;
    }
  };

  // =========================================================================
  // Assinaturas e gastos recorrentes
  // =========================================================================

  CP.openSubscriptions = async () => {
    CP.showLoading();
    let data;
    try { data = await api.insights.subscriptions(); }
    catch (error) { CP.hideLoading(); return toast(error.message, 'error'); }
    CP.hideLoading();

    if (!data.active.length && !data.inactive.length) {
      return openModal(emptyState(
        'Ainda não há repetição suficiente',
        'Preciso ver o mesmo gasto em pelo menos três meses para reconhecê-lo como recorrente. Importe mais extratos e volte aqui.'
      ), 'Gastos recorrentes', 'ANÁLISE', '620px');
    }

    const line = item => `
      <div class="sub-row ${item.status === 'inativa' ? 'inactive' : ''}">
        <span class="sub-icon" style="--cat:${CP.categoryStyle(item.category).color}">
          ${CP.categoryStyle(item.category).icon}
        </span>
        <div class="sub-info">
          <strong>${esc(item.name)}</strong>
          <small>
            ${item.months} meses · dia ${item.day}
            ${item.onCard ? ' · no cartão' : ''}
            ${item.status === 'inativa' ? ` · sem cobrança há ${item.monthsSinceLast} meses` : ''}
          </small>
        </div>
        ${item.priceChange ? `<span class="sub-change ${item.priceChange.amount > 0 ? 'up' : 'down'}">
          ${item.priceChange.amount > 0 ? '▲' : '▼'} ${money(Math.abs(item.priceChange.amount))}
        </span>` : ''}
        <div class="sub-amount">
          <strong>${money(item.amount)}</strong>
          <small>${money(item.yearlyCost)}/ano</small>
        </div>
      </div>`;

    openModal(`
      <div class="summary-grid" style="grid-template-columns:repeat(3,1fr)">
        ${summaryCard('Por mês', data.monthlyTotal, '🔁', 'warning')}
        ${summaryCard('Por ano', data.yearlyTotal, '📅', 'danger')}
        ${summaryCard('Recorrências', String(data.active.length), '#', 'primary', true)}
      </div>

      ${data.priceIncreases.length ? `
        <div class="sub-alert">
          <span>📈</span>
          <div><strong>${data.priceIncreases.length} ${data.priceIncreases.length > 1 ? 'aumentaram' : 'aumentou'} de preço</strong>
          <small>${data.priceIncreases.map(item =>
            `${esc(item.name)}: ${money(item.priceChange.from)} → ${money(item.priceChange.to)}`).join(' · ')}</small></div>
        </div>` : ''}

      <div class="sub-list">${data.active.map(line).join('')}</div>

      ${data.inactive.length ? `
        <div class="section-label" style="margin-top:16px"><span>○ Pararam de aparecer</span><i></i></div>
        <p class="empty-hint">Estas cobranças sumiram há dois meses ou mais. Se você cancelou, tudo certo — se não cancelou, vale conferir.</p>
        <div class="sub-list">${data.inactive.map(line).join('')}</div>` : ''}

      <div class="form-footer field full">
        <button type="button" class="button primary" data-close-modal>Fechar</button>
      </div>`, 'Gastos recorrentes', 'O QUE SE REPETE TODO MÊS', '720px');
  };

  // =========================================================================
  // Fechamento do mês
  // =========================================================================

  CP.openMonthClosing = async (month = null) => {
    CP.showLoading();
    let data;
    try { data = await api.insights.monthClosing(month || CP.currentRef()); }
    catch (error) { CP.hideLoading(); return toast(error.message, 'error'); }
    CP.hideLoading();

    const { summary } = data;
    const step = item => `
      <article class="close-step ${item.done ? 'done' : ''} ${item.manual ? 'manual' : ''}">
        <span class="close-check">${item.done ? '✓' : item.manual ? '◎' : '○'}</span>
        <div class="close-copy">
          <strong>${esc(item.title)}</strong>
          <small>${esc(item.detail)}</small>
          ${item.items?.length && !item.done ? `<div class="close-items">
            ${item.items.slice(0, 4).map(entry => `<span>${esc(entry.description || entry.title || entry.cardName)} · ${money(entry.amount || entry.totalAmount)}</span>`).join('')}
            ${item.count > 4 ? `<span class="more">e mais ${item.count - 4}</span>` : ''}
          </div>` : ''}
        </div>
        ${item.action && !item.done
          ? `<button class="button small primary" data-next-action='${esc(JSON.stringify(item.action))}'>Resolver</button>`
          : ''}
      </article>`;

    openModal(`
      <div class="close-hero ${summary.goalReached ? 'win' : ''}">
        <div>
          <span class="eyebrow">${esc(data.label)}</span>
          <h3>${summary.leftover >= 0 ? 'Você guardou' : 'Você gastou a mais'} ${money(Math.abs(summary.leftover))}</h3>
          <small>${money(summary.income)} entraram · ${money(summary.spent)} saíram${
            summary.goal > 0 ? ` · meta de ${money(summary.goal)}` : ''}</small>
        </div>
        ${summary.goalReached ? '<span class="close-medal">🎉</span>' : ''}
      </div>

      <div class="close-progress">
        <span>${data.steps.filter(item => item.done).length} de ${data.steps.length} conferidos</span>
        <i><b style="width:${(data.steps.filter(item => item.done).length / data.steps.length * 100).toFixed(0)}%"></b></i>
      </div>

      <div class="close-steps">${data.steps.map(step).join('')}</div>

      <div class="form-footer field full">
        <button type="button" class="button ghost" data-action="open-retro">Ver retrospectiva</button>
        <button type="button" class="button primary" data-close-modal>Concluir</button>
      </div>`, 'Fechamento do mês', 'ROTINA DE 3 MINUTOS', '700px');
  };

  // =========================================================================
  // Calendário e saldo projetado
  // =========================================================================

  CP.openCalendar = async (month = null) => {
    CP.showLoading();
    let data;
    try { data = await api.insights.calendar(month || CP.currentRef()); }
    catch (error) { CP.hideLoading(); return toast(error.message, 'error'); }
    CP.hideLoading();

    const weekdays = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];
    const blanks = Array.from({ length: data.firstWeekday }, () => '<div class="cal-day blank"></div>').join('');

    const dayCell = day => {
      const pending = day.events.filter(event => !event.done);
      const tone = day.projectedBalance < 0 ? 'negative'
        : pending.length ? 'pending'
        : day.events.length ? 'has' : '';
      return `<div class="cal-day ${tone} ${day.isToday ? 'today' : ''} ${day.isPast ? 'past' : ''}"
                   ${day.events.length ? `data-cal-day="${day.date}"` : ''}>
        <span class="cal-number">${day.day}</span>
        ${day.events.length ? `<span class="cal-dots">
          ${day.income > 0 ? '<i class="in"></i>' : ''}
          ${day.outflow > 0 ? '<i class="out"></i>' : ''}
          ${pending.length ? '<i class="due"></i>' : ''}
        </span>` : ''}
        ${day.events.length ? `<span class="cal-value ${day.income > day.outflow ? 'money-positive' : 'money-negative'}">
          ${money(day.income > day.outflow ? day.income : day.outflow, true)}</span>` : ''}
      </div>`;
    };

    // Curva do saldo projetado, dia a dia.
    const values = data.days.map(day => day.projectedBalance);
    const rawMin = Math.min(0, ...values);
    const rawMax = Math.max(1, ...values);
    // Uma folga de 12% impede que a linha fique colada na borda quando o saldo
    // é constante — o que acontece sempre que o mês já passou.
    const padding = Math.max(1, (rawMax - rawMin) * 0.12);
    const min = rawMin - padding;
    const max = rawMax + padding;
    const range = max - min || 1;
    const points = values.map((value, index) => {
      const x = (index / Math.max(1, values.length - 1)) * 100;
      const y = 100 - ((value - min) / range) * 100;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    }).join(' ');
    const zeroLine = 100 - ((0 - min) / range) * 100;

    openModal(`
      <div class="summary-grid" style="grid-template-columns:repeat(3,1fr)">
        ${summaryCard('Saldo hoje', data.startingBalance, '◇', 'blue')}
        ${summaryCard('Projetado no fim do mês', data.endingBalance, data.endingBalance >= 0 ? '↗' : '↘',
          data.endingBalance >= 0 ? 'success' : 'danger')}
        ${summaryCard('A vencer', String(data.totals.pendingCount), '⌛', 'warning', true)}
      </div>

      ${data.willGoNegative ? `
        <div class="sub-alert danger">
          <span>⚠</span>
          <div><strong>Seu saldo fica negativo no dia ${Number(data.willGoNegative.date.slice(8, 10))}</strong>
          <small>Chega a ${money(data.willGoNegative.balance)}. Antecipar uma entrada ou adiar um pagamento resolve.</small></div>
        </div>` : ''}

      <div class="cal-grid">
        ${weekdays.map(day => `<div class="cal-weekday">${day}</div>`).join('')}
        ${blanks}
        ${data.days.map(dayCell).join('')}
      </div>

      <div class="cal-legend">
        <span><i class="in"></i>entrada</span>
        <span><i class="out"></i>saída</span>
        <span><i class="due"></i>a vencer</span>
        <span class="cal-hint">clique num dia para ver os lançamentos</span>
      </div>

      <div class="section-label" style="margin-top:14px"><span>◇ Saldo ao longo do mês</span><i></i></div>
      <div class="cal-chart">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none">
          ${min < 0 ? `<line class="cal-zero" x1="0" y1="${zeroLine.toFixed(2)}" x2="100" y2="${zeroLine.toFixed(2)}"/>` : ''}
          <polyline points="${points}"/>
        </svg>
        <div class="cal-chart-labels"><span>dia 1</span><span>dia ${data.days.length}</span></div>
      </div>

      <div class="form-footer field full">
        <button type="button" class="button primary" data-close-modal>Fechar</button>
      </div>`, `Calendário · ${data.label}`, 'VENCIMENTOS E SALDO PROJETADO', '760px');

    state.calendarData = data;
  };

  // =========================================================================
  // Orçamento sugerido pelo histórico
  // =========================================================================

  CP.openBudgetSuggestions = async () => {
    CP.showLoading();
    let data, pace;
    try {
      [data, pace] = await Promise.all([api.insights.suggestBudgets({}), api.insights.budgetPace()]);
    } catch (error) { CP.hideLoading(); return toast(error.message, 'error'); }
    CP.hideLoading();

    if (!data.length) {
      return openModal(emptyState(
        'Ainda não dá para sugerir',
        'Preciso de pelo menos três meses de gasto na mesma categoria para propor um teto que faça sentido. Importe mais extratos e volte aqui.'
      ), 'Orçamento sugerido', 'A PARTIR DO SEU HISTÓRICO', '620px');
    }

    const ahead = pace.filter(item => item.aheadOfPace);

    openModal(`
      ${ahead.length ? `<div class="sub-alert">
        <span>⏱</span>
        <div><strong>${ahead.length} categoria(s) correndo mais rápido que o normal</strong>
        <small>${ahead.map(item =>
          `${esc(item.category)}: ${item.pct.toFixed(0)}% gasto com ${item.elapsedPct.toFixed(0)}% do mês — no ritmo, fecha em ${money(item.projected)}`
        ).join(' · ')}</small></div>
      </div>` : ''}

      <p class="page-lead" style="margin:14px 0 10px">
        Os tetos abaixo vêm da <strong>mediana</strong> dos seus últimos meses, não da média —
        assim um mês com uma compra grande não infla a sugestão.
      </p>

      <form id="suggestBudgetForm" class="budget-suggest">
        ${data.map(item => `
          <label class="suggest-row">
            <input type="checkbox" data-suggest="${esc(item.category)}" value="${item.suggested}"
              ${item.currentBudget ? '' : 'checked'}>
            <span class="suggest-cat">${CP.categoryChip(item.category)}</span>
            <span class="suggest-history">
              <small>varia de ${money(item.min, true)} a ${money(item.max, true)} · ${item.months} meses</small>
            </span>
            <span class="suggest-value">
              ${item.currentBudget
                ? `<small>hoje ${money(item.currentBudget)}</small>`
                : '<small>sem teto</small>'}
              <strong>${money(item.suggested)}</strong>
            </span>
          </label>`).join('')}
        <div class="form-footer field full">
          <button type="button" class="button ghost" data-close-modal>Cancelar</button>
          <button type="submit" class="button primary">Aplicar selecionados</button>
        </div>
      </form>`, 'Orçamento sugerido', 'A PARTIR DO SEU HISTÓRICO', '660px');
  };

  // =========================================================================
  // Mesmo mês do ano anterior
  // =========================================================================

  CP.openYearComparison = async (month = null) => {
    CP.showLoading();
    let data;
    try { data = await api.insights.sameMonthLastYear(month || CP.currentRef()); }
    catch (error) { CP.hideLoading(); return toast(error.message, 'error'); }
    CP.hideLoading();

    if (!data.hasData) {
      return openModal(emptyState(
        `Sem dados de ${data.previousLabel}`,
        'Esta comparação precisa do mesmo mês do ano anterior. Importe os extratos daquele período e ela passa a funcionar.'
      ), 'Ano a ano', 'MESMO MÊS, ANO ANTERIOR', '600px');
    }

    const arrow = data.delta > 0 ? '↑' : data.delta < 0 ? '↓' : '→';

    openModal(`
      <div class="close-hero">
        <div>
          <span class="eyebrow">${esc(data.label)} vs ${esc(data.previousLabel)}</span>
          <h3 class="${data.delta > 0 ? 'money-negative' : 'money-positive'}">
            ${arrow} ${money(Math.abs(data.delta))}</h3>
          <small>${money(data.currentTotal)} agora · ${money(data.previousTotal)} no ano passado
            · ${data.pct >= 0 ? '+' : ''}${data.pct.toFixed(0)}%</small>
        </div>
      </div>

      <p class="page-lead" style="margin-bottom:10px">
        Comparar com o mesmo mês do ano anterior tira o efeito da sazonalidade —
        o que sobra é mudança de hábito de verdade.
      </p>

      <div class="yoy-list">
        ${data.rows.map(row => `
          <div class="yoy-row">
            <span class="yoy-cat">${CP.categoryChip(row.category)}</span>
            <span class="yoy-bars">
              <i class="before" style="width:${data.rows[0] ? (row.previous / Math.max(row.previous, row.current, 1)) * 100 : 0}%"></i>
              <i class="after ${row.delta > 0 ? 'up' : 'down'}"
                 style="width:${data.rows[0] ? (row.current / Math.max(row.previous, row.current, 1)) * 100 : 0}%"></i>
            </span>
            <span class="yoy-values">
              <small>${money(row.previous, true)} → ${money(row.current, true)}</small>
              <strong class="${row.delta > 0 ? 'money-negative' : 'money-positive'}">
                ${row.delta > 0 ? '+' : '−'} ${money(Math.abs(row.delta))}</strong>
            </span>
            ${row.isNew ? '<span class="yoy-tag new">novo</span>' : ''}
            ${row.disappeared ? '<span class="yoy-tag gone">sumiu</span>' : ''}
          </div>`).join('')}
      </div>

      <div class="form-footer field full">
        <button type="button" class="button primary" data-close-modal>Fechar</button>
      </div>`, 'Ano a ano', 'MESMO MÊS, ANO ANTERIOR', '680px');
  };

  // =========================================================================
  // Gasto fora do padrão
  // =========================================================================

  /**
   * Consulta o histórico e devolve o aviso pronto para a barra rápida.
   * Silencioso quando não há nada de estranho — alerta demais vira ruído.
   */
  CP.outlierNotice = async (description, amount, category) => {
    if (!description || !(amount > 0)) return '';
    try {
      const result = await api.insights.checkOutlier(description, amount, category);
      if (!result) return '';
      return `<div class="outlier-notice">
        <span>⚠</span>
        <div>${result.flags.map(flag => esc(flag.message)).join(' · ')}</div>
      </div>`;
    } catch (error) {
      return '';
    }
  };

  /** Detalhe de um dia do calendário. */
  CP.openCalendarDay = date => {
    const day = state.calendarData?.days.find(item => item.date === date);
    if (!day?.events.length) return;

    openModal(`
      <div class="summary-grid" style="grid-template-columns:repeat(2,1fr)">
        ${summaryCard('Entradas', day.income, '↗', 'success')}
        ${summaryCard('Saídas', day.outflow, '↘', 'danger')}
      </div>
      <div class="day-list">
        ${day.events.map(event => `
          <div class="day-row ${event.done ? '' : 'pending'}">
            <span class="day-icon" style="--cat:${CP.categoryStyle(event.category).color}">
              ${event.type === 'invoice' ? '▰' : CP.categoryStyle(event.category).icon}
            </span>
            <div><strong>${esc(event.title)}</strong>
              <small>${event.done ? 'pago' : 'a pagar'}${event.category ? ` · ${esc(event.category)}` : ''}</small></div>
            <span class="${event.isIncome ? 'money-positive' : 'money-negative'}">
              ${event.isIncome ? '+' : '−'} ${money(event.amount)}</span>
          </div>`).join('')}
      </div>
      <div class="form-footer field full">
        <button type="button" class="button primary" data-close-modal>Fechar</button>
      </div>`, CP.date(date), 'LANÇAMENTOS DO DIA', '560px');
  };
})();
