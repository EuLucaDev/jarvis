/* ==========================================================================
   Metas: o objetivo, a caixinha e o plano.

   A lista mostra cada meta com os números que importam de relance. O detalhe
   é onde a meta vira um plano: o dinheiro que você já guardou, do que a meta
   é feita, e o que já foi resolvido.

   Três valores aparecem juntos o tempo todo, porque confundi-los é o erro
   fácil: GUARDADO é tudo que entrou na caixinha, PAGO é o que os itens já
   consumiram, e LIVRE é o que ainda dá para usar. Pagar a aliança não apaga
   o que você poupou — só muda onde esse dinheiro está.
   ========================================================================== */

'use strict';

(() => {
  const { $, esc, money, state, openModal, toast, mutate, field,
          formFooter, badge, emptyState, sectionLabel, summaryCard, pageHeading } = CP;

  const db = () => CP.db();
  const api = window.api;

  // =========================================================================
  // Lista
  // =========================================================================

  CP.renderGoals = () => {
    if (state.goalDetail) return renderDetail(state.goalDetail);

    const goals = db().goals || [];
    const active = goals.filter(goal => goal.status === 'ATIVA');
    const done = goals.filter(goal => goal.status === 'CONCLUIDA');

    return `<section class="page">
      ${pageHeading(
        'Cada meta tem uma caixinha e um plano: você guarda dinheiro, lista do que ela é feita e vai marcando o que já resolveu.',
        '<button class="button primary" data-action="add-goal">＋ Nova meta</button>')}

      <div class="summary-grid">
        ${summaryCard('Guardado nas metas', CP.sum(active, goal => goal.savedAmount), '🎯', 'success')}
        ${summaryCard('Livre para usar', CP.sum(active, goal => goal.freeAmount), '◎', 'primary')}
        ${summaryCard('Metas ativas', String(active.length), '#', 'blue', true)}
        ${summaryCard('Concluídas', String(done.length), '🏆', 'warning', true)}
      </div>

      <div class="goal-grid">${goals.length
        ? goals.map(goalCard).join('')
        : emptyState('Nenhuma meta ainda',
            'Uma meta é um objetivo com valor: casamento, carro, viagem. Dentro dela você guarda dinheiro e lista o que precisa pagar — aliança, buffet, local.',
            'Criar primeira meta', 'add-goal')}
      </div>
    </section>`;
  };

  const goalCard = goal => `
    <article class="goal-card ${goal.status === 'CONCLUIDA' ? 'done' : ''}"
             style="--goal-color:${goal.color}" data-action="open-goal" data-id="${goal.id}" role="button" tabindex="0">
      <div class="goal-head">
        <div style="display:flex;gap:12px;align-items:center">
          <span class="goal-icon">${goal.icon || '🎯'}</span>
          <div><h3>${esc(goal.name)}</h3>
            <p>${goal.linkedInvestmentName
              ? `Acompanha ${esc(goal.linkedInvestmentName)}`
              : goal.targetDate ? `Até ${CP.date(goal.targetDate)}` : 'Sem prazo'}</p></div>
        </div>
        ${goal.status === 'CONCLUIDA' ? badge('Concluída', 'success') : ''}
      </div>

      <div class="goal-amounts"><strong>${money(goal.savedAmount)}</strong><span>de ${money(goal.targetAmount)}</span></div>
      <div class="goal-bar"><i style="width:${goal.progress.toFixed(0)}%"></i></div>

      <div class="goal-numbers">
        <div><small>Livre</small><b>${money(goal.freeAmount)}</b></div>
        <div><small>Pago</small><b>${money(goal.paidAmount)}</b></div>
        <div><small>Falta juntar</small><b>${money(goal.missing)}</b></div>
      </div>

      <div class="goal-meta">
        <span>${goal.itemCount ? `${goal.itemCount} item(ns) no plano` : 'Sem plano ainda'}</span>
        <span>${goal.missing > 0 && goal.monthsLeft > 0
          ? `<b>${money(goal.requiredPerMonth)}</b>/mês por ${goal.monthsLeft} ${goal.monthsLeft === 1 ? 'mês' : 'meses'}`
          : goal.missing > 0 ? `Faltam <b>${money(goal.missing)}</b>` : '🎉 Alcançada'}</span>
      </div>

      ${goal.nextItem ? `<div class="goal-next">
        <span>Próximo</span><b>${esc(goal.nextItem.name)}</b>
        <i>${money(goal.nextItem.amount)}${goal.nextItem.dueDate ? ` · ${CP.date(goal.nextItem.dueDate)}` : ''}</i>
      </div>` : ''}
    </article>`;

  // =========================================================================
  // Detalhe
  // =========================================================================

  CP.openGoal = async id => {
    try {
      state.goalDetail = await api.goals.get(id);
      state.goalId = id;
      if (state.page !== 'goals') return CP.navigate('goals');
      CP.render();
      window.scrollTo({ top: 0 });
    } catch (error) { toast(error.message, 'error'); }
  };

  CP.closeGoal = () => {
    state.goalDetail = null;
    state.goalId = null;
    CP.render();
  };

  /** Recarrega o detalhe aberto depois de qualquer mudança dentro dele. */
  const refreshDetail = async () => {
    if (!state.goalId) return;
    state.goalDetail = await api.goals.get(state.goalId);
  };

  const goalMutate = (action, message) =>
    mutate(async () => { const result = await action(); await refreshDetail(); return result; }, message);

  const STATUS_LABEL = { PLANEJADO: 'A resolver', CONTRATADO: 'Contratado', PAGO: 'Pago' };

  const renderDetail = goal => `
    <section class="page goal-detail">
      <div class="goal-detail-top">
        <button class="button ghost small" data-action="close-goal">‹ Todas as metas</button>
        <span class="spacer"></span>
        <button class="button ghost small" data-action="edit-goal" data-id="${goal.id}">Editar</button>
        <button class="button ghost small danger" data-action="delete-goal" data-id="${goal.id}">Excluir</button>
      </div>

      <header class="goal-hero" style="--goal-color:${goal.color}">
        <span class="goal-hero-icon">${goal.icon || '🎯'}</span>
        <div class="goal-hero-copy">
          <h2>${esc(goal.name)}</h2>
          <p>${goal.targetDate
            ? `Alvo de ${money(goal.targetAmount)} até ${CP.date(goal.targetDate)}`
            : `Alvo de ${money(goal.targetAmount)}`}${goal.status === 'CONCLUIDA' ? ' · 🎉 alcançada' : ''}</p>
        </div>
        <button class="button primary" data-action="goal-deposit" data-id="${goal.id}">＋ Guardar dinheiro</button>
      </header>

      <div class="goal-figures">
        ${figure('Guardado', goal.savedAmount, 'tudo que já entrou na caixinha', 'success')}
        ${figure('Pago', goal.paidAmount, 'itens já quitados', 'warning')}
        ${figure('Livre', goal.freeAmount, 'ainda dá para usar', 'primary')}
        ${figure('Falta juntar', goal.missing, goal.monthsLeft > 0
          ? `${money(goal.requiredPerMonth)}/mês pelos próximos ${goal.monthsLeft}`
          : 'para chegar no alvo', 'blue')}
      </div>

      <div class="goal-bar big"><i style="width:${goal.progress.toFixed(0)}%"></i></div>
      <p class="goal-bar-note">${goal.progress.toFixed(0)}% do alvo guardado${
        goal.plannedAmount > 0 ? ` · ${goal.planProgress.toFixed(0)}% do plano resolvido` : ''}</p>

      ${goal.overPlanned > 0 ? `<div class="notice warning">
        ⚠ Você planejou ${money(goal.plannedAmount)} numa meta de ${money(goal.targetAmount)} —
        ${money(goal.overPlanned)} acima do alvo. Ou o alvo sobe, ou algum item precisa caber em menos.
      </div>` : ''}

      ${sectionLabel('◆ Do que essa meta é feita')}
      <section class="panel">
        <div class="panel-head">
          <div class="panel-title"><h3>Plano</h3>
            <p>${goal.items.length
              ? `${money(goal.plannedAmount)} planejados · faltam ${money(goal.remainingToPay)} para quitar tudo`
              : 'Liste o que precisa ser pago: aliança, buffet, local…'}</p></div>
          <button class="button small primary" data-action="goal-item-add" data-id="${goal.id}">＋ Item</button>
        </div>
        <div class="panel-body">${goal.items.length ? `
          <div class="table-wrap"><table class="data-table goal-items">
            <thead><tr><th>Item</th><th>Valor</th><th>Prazo</th><th>Situação</th><th></th></tr></thead>
            <tbody>${goal.items.map(itemRow).join('')}</tbody>
          </table></div>`
          : emptyState('Plano vazio',
              'Cada linha aqui é uma coisa que precisa ser paga, com o valor que você espera gastar. A soma mostra se o alvo da meta dá conta.',
              '＋ Adicionar item', 'goal-item-add')}
        </div>
      </section>

      ${sectionLabel('◈ Movimentos da caixinha')}
      <section class="panel">
        <div class="panel-body">${goal.deposits.length ? `
          <div class="table-wrap"><table class="data-table">
            <thead><tr><th>Data</th><th>Movimento</th><th>De onde</th><th class="right">Valor</th><th></th></tr></thead>
            <tbody>${goal.deposits.map(deposit => `
              <tr>
                <td>${CP.date(deposit.date)}</td>
                <td>${esc(deposit.description)}</td>
                <td>${deposit.bankAccountId
                  ? esc(CP.accountById(deposit.bankAccountId)?.name || 'conta removida')
                  : '<span class="muted">só reservado</span>'}</td>
                <td class="right ${deposit.amount >= 0 ? 'money-positive' : 'money-negative'}">
                  ${deposit.amount >= 0 ? '+' : '−'} ${money(Math.abs(deposit.amount))}</td>
                <td class="right"><button class="icon-button danger" data-action="goal-deposit-remove"
                  data-id="${deposit.id}" aria-label="Remover movimento">×</button></td>
              </tr>`).join('')}</tbody>
          </table></div>`
          : '<p class="empty-hint">Nada guardado ainda. O dinheiro sai da conta escolhida e fica reservado aqui.</p>'}
        </div>
      </section>
    </section>`;

  const figure = (label, value, note, tone) => `
    <article class="goal-figure ${tone}">
      <small>${esc(label)}</small>
      <strong>${money(value)}</strong>
      <span>${esc(note)}</span>
    </article>`;

  const itemRow = item => {
    const paid = item.status === 'PAGO';
    const value = paid ? item.paidAmount : item.plannedAmount;
    const late = !paid && item.dueDate && item.dueDate < new Date().toISOString().slice(0, 10);
    return `<tr class="${paid ? 'done' : ''}">
      <td><b>${esc(item.name)}</b>${item.category ? ` ${CP.categoryChip(item.category)}` : ''}</td>
      <td>${money(value)}${paid && Math.abs(item.paidAmount - item.plannedAmount) >= 0.01
        ? `<small class="muted"> previsto ${money(item.plannedAmount)}</small>` : ''}</td>
      <td>${item.dueDate ? `<span class="${late ? 'money-negative' : ''}">${CP.date(item.dueDate)}</span>` : '—'}</td>
      <td>${paid
        ? badge(`Pago ${item.paidSource === 'META' ? 'pela caixinha' : 'pela conta'}`, 'success')
        : badge(STATUS_LABEL[item.status] || item.status, item.status === 'CONTRATADO' ? 'warning' : '')}</td>
      <td class="right actions-cell">
        ${paid
          ? `<button class="button small ghost" data-action="goal-item-unpay" data-id="${item.id}">Desmarcar</button>`
          : `<button class="button small primary" data-action="goal-item-pay" data-id="${item.id}">Pagar</button>`}
        <button class="icon-button" data-action="goal-item-edit" data-id="${item.id}" aria-label="Editar">✎</button>
        <button class="icon-button danger" data-action="goal-item-remove" data-id="${item.id}" aria-label="Excluir">×</button>
      </td>
    </tr>`;
  };

  // =========================================================================
  // Formulários
  // =========================================================================

  CP.openGoalForm = (id = null) => {
    const item = id
      ? (db().goals || []).find(goal => goal.id === id) || state.goalDetail
      : { name: '', targetAmount: '', targetDate: '', investmentId: '', color: '#d7ff37', icon: '🎯', notes: '' };
    const investments = (db().investments || []).filter(investment => investment.status === 'ATIVO');

    openModal(`<form id="entityForm" data-form="goal" data-id="${id || ''}" class="form-grid">
      ${field('name', 'Nome da meta', item.name, { placeholder: 'Ex.: Casamento', full: true })}
      ${field('icon', 'Ícone', item.icon || '🎯', { placeholder: '🎯', required: false })}
      ${field('color', 'Cor', item.color, { type: 'color' })}
      ${field('targetAmount', 'Quanto a meta inteira custa', CP.moneyInput(item.targetAmount), { currency: true })}
      ${field('targetDate', 'Até quando', item.targetDate, {
        date: true, required: false, help: 'Com prazo, o app calcula quanto guardar por mês.' })}
      ${field('investmentId', 'Acompanhar um investimento', item.investmentId, {
        select: [{ value: '', label: 'Caixinha própria (recomendado)' },
                 ...investments.map(investment => ({ value: investment.id, label: investment.name }))],
        full: true,
        help: 'Ligada a um investimento, a meta espelha o saldo dele e a caixinha fica desativada.' })}
      ${field('notes', 'Observações', item.notes, { textarea: true, full: true, required: false })}
      ${formFooter(id ? 'Salvar alterações' : 'Criar meta')}
    </form>`, id ? 'Editar meta' : 'Nova meta', 'OBJETIVO');
  };

  CP.openGoalDeposit = id => {
    const goal = state.goalDetail || (db().goals || []).find(item => item.id === id);
    if (!goal) return;

    openModal(`<div class="summary-card" style="margin-bottom:16px">
        <span class="metric-icon">${goal.icon || '🎯'}</span>
        <div><small>${esc(goal.name)} · livre ${money(goal.freeAmount)}</small>
          <strong>${money(goal.savedAmount)} guardados</strong></div>
      </div>
      <form id="entityForm" data-form="goalDeposit" data-id="${goal.id}" class="form-grid">
        ${field('amount', 'Quanto guardar agora', '', { currency: true })}
        ${field('date', 'Data', new Date().toISOString().slice(0, 10), { date: true })}
        <div class="field full"><label>De qual conta sai</label>
          ${CP.select('bankAccountId', [...CP.accountOptions(), { value: '', label: 'Só reservar (não sai da conta)' }],
            CP.activeAccounts()[0]?.id || '')}
          <span class="field-help">O dinheiro sai do saldo dessa conta, como quando você usa a caixinha do próprio
            banco. Para retirar da meta, informe um valor negativo.</span></div>
        ${field('description', 'Descrição', '', { required: false, full: true, placeholder: 'Ex.: sobra do mês' })}
        ${formFooter('Guardar')}
      </form>`, 'Guardar na meta', 'CAIXINHA');
  };

  CP.openGoalItemForm = (goalId, itemId = null) => {
    const item = itemId
      ? (state.goalDetail?.items || []).find(row => row.id === itemId)
      : { name: '', plannedAmount: '', category: '', dueDate: '', status: 'PLANEJADO', notes: '' };
    if (!item) return;

    openModal(`<form id="entityForm" data-form="goalItem" data-id="${itemId || ''}"
                     data-goal="${goalId || state.goalId}" class="form-grid">
      ${field('name', 'O que é', item.name, { full: true, placeholder: 'Ex.: aliança, buffet, local' })}
      ${field('plannedAmount', 'Quanto deve custar', CP.moneyInput(item.plannedAmount), { currency: true })}
      ${field('dueDate', 'Para quando', item.dueDate, { date: true, required: false })}
      ${field('category', 'Categoria do gasto', item.category, {
        select: [{ value: '', label: 'Escolher na hora de pagar' }, ...CP.categoryOptions('variableExpense')],
        help: 'É a categoria que a saída vai receber quando você marcar como pago.' })}
      ${field('status', 'Situação', item.status, {
        select: [{ value: 'PLANEJADO', label: 'A resolver' }, { value: 'CONTRATADO', label: 'Já contratado' }] })}
      ${field('notes', 'Observações', item.notes, { textarea: true, full: true, required: false })}
      ${formFooter(itemId ? 'Salvar item' : 'Adicionar item')}
    </form>`, itemId ? 'Editar item' : 'Novo item do plano', 'PLANO');
  };

  CP.openGoalItemPay = itemId => {
    const goal = state.goalDetail;
    const item = (goal?.items || []).find(row => row.id === itemId);
    if (!item) return;

    openModal(`<div class="summary-card" style="margin-bottom:16px">
        <span class="metric-icon">✓</span>
        <div><small>${esc(item.name)} · previsto ${money(item.plannedAmount)}</small>
          <strong>Caixinha livre: ${money(goal.freeAmount)}</strong></div>
      </div>
      <form id="entityForm" data-form="goalItemPay" data-id="${itemId}" class="form-grid">
        ${field('amount', 'Quanto foi pago de verdade', CP.moneyInput(item.plannedAmount), { currency: true })}
        ${field('date', 'Quando', new Date().toISOString().slice(0, 10), { date: true })}
        ${field('source', 'De onde saiu', 'META', {
          select: [{ value: 'META', label: `Da caixinha da meta (${money(goal.freeAmount)} livres)` },
                   { value: 'CONTA', label: 'De uma conta bancária' }] })}
        <div class="field" data-pay-account hidden><label>Conta</label>
          ${CP.select('bankAccountId', CP.accountOptions(), CP.activeAccounts()[0]?.id || '')}</div>
        ${field('category', 'Categoria', item.category || 'Outros', { select: CP.categoryOptions('variableExpense') })}
        <div class="field full"><span class="field-help">
          Pagando pela caixinha, a saída entra no mês com essa categoria mas não desconta da conta de novo —
          esse dinheiro já saiu de lá quando foi guardado.</span></div>
        ${formFooter('Marcar como pago')}
      </form>`, 'Pagar item', 'PLANO');

    const source = $('input[name="source"]', $('#entityForm'));
    const sync = () => { $('[data-pay-account]').hidden = source.value !== 'CONTA'; };
    source.addEventListener('change', sync);
    sync();
  };

  // =========================================================================
  // Ações e formulários, entregues ao despachante de app.js
  // =========================================================================

  CP.GOAL_ACTIONS = {
    'add-goal': () => CP.openGoalForm(),
    'edit-goal': element => CP.openGoalForm(element.dataset.id),
    'open-goal': element => CP.openGoal(element.dataset.id),
    'close-goal': () => CP.closeGoal(),
    'goal-deposit': element => CP.openGoalDeposit(element.dataset.id),
    'goal-item-add': element => CP.openGoalItemForm(element.dataset.id || state.goalId),
    'goal-item-edit': element => CP.openGoalItemForm(state.goalId, element.dataset.id),
    'goal-item-pay': element => CP.openGoalItemPay(element.dataset.id),

    'goal-item-unpay': element => CP.confirm(
      'A saída gerada por este item será apagada e o valor volta para a caixinha da meta.',
      () => goalMutate(() => api.goals.itemUnpay(element.dataset.id), 'Item desmarcado.'),
      'Desmarcar item', 'Desmarcar'),

    'goal-item-remove': element => CP.confirm(
      'Este item sai do plano da meta. Se estiver pago, a saída também é apagada.',
      () => goalMutate(() => api.goals.itemRemove(element.dataset.id), 'Item removido.'),
      'Excluir item', 'Excluir'),

    'goal-deposit-remove': element => CP.confirm(
      'Este movimento some da caixinha e o dinheiro volta para o saldo da conta de origem.',
      () => goalMutate(() => api.goals.depositRemove(element.dataset.id), 'Movimento removido.'),
      'Remover movimento', 'Remover'),

    'delete-goal': element => CP.confirm(
      'A meta e a caixinha inteira serão apagadas, e o dinheiro guardado volta para as contas de origem. '
      + 'As saídas dos itens já pagos continuam no histórico do mês — aquilo aconteceu de verdade.',
      async () => {
        state.goalDetail = null;
        state.goalId = null;
        await mutate(() => api.goals.remove(element.dataset.id), 'Meta excluída.');
      },
      'Excluir meta', 'Excluir')
  };

  CP.GOAL_FORMS = {
    goal: (id, data) => id
      ? goalMutate(() => api.goals.update(id, data), 'Meta atualizada.')
      : mutate(() => api.goals.create(data), 'Meta criada.'),

    goalDeposit: (id, data) => goalMutate(
      () => api.goals.deposit(id, {
        amount: data.amount, bankAccountId: data.bankAccountId, date: data.date, description: data.description
      }),
      Number(data.amount) >= 0 ? 'Dinheiro guardado na meta.' : 'Retirada registrada.'),

    goalItem: (id, data, form) => (id
      ? goalMutate(() => api.goals.itemUpdate(id, data), 'Item atualizado.')
      : goalMutate(() => api.goals.itemCreate(form.dataset.goal, data), 'Item adicionado ao plano.')),

    goalItemPay: (id, data) => goalMutate(
      () => api.goals.itemPay(id, {
        amount: data.amount, date: data.date, source: data.source,
        bankAccountId: data.bankAccountId, category: data.category
      }),
      'Item pago.')
  };
})();
