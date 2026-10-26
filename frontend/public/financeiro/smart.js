/* ==========================================================================
   Entrada inteligente de dados.

   Três coisas moram aqui:
     1. a barra de comando rápida, que mostra o que entendeu antes de salvar;
     2. a importação de extrato, fatura e comprovante;
     3. a tela de regras automáticas, e o gancho que aprende com as correções.
   ========================================================================== */

'use strict';

(() => {
  const { $, $$, esc, money, state, field, formFooter, formData, openModal,
          closeModal, toast, mutate, badge, emptyState, confirm: confirmAction } = CP;

  const db = () => CP.db();
  const api = window.api;

  // =========================================================================
  // Barra de comando rápida
  // =========================================================================

  state.quick = { text: '', parsed: null, busy: false };

  /**
   * A barra fica no topo da Visão geral e dos Lançamentos. Você digita, ela
   * mostra o que entendeu — com o que foi lido do texto em cor sólida e o que
   * foi suposto em amarelo tracejado — e você confirma com Enter.
   */
  CP.quickBar = () => `
    <div class="quickbar">
      <span class="quickbar-icon">⚡</span>
      <input id="quickInput" value="${esc(state.quick.text)}" autocomplete="off" spellcheck="false"
             placeholder='Digite e pressione Enter: "mercado 84,90 débito" ou "recebi 3200 salário"'>
      <button class="button ghost small" data-action="import-statement" title="Importar extrato">📄</button>
      <button class="button primary small" id="quickSubmit">Lançar</button>
    </div>
    <div id="quickPreview"></div>`;

  const renderQuickPreview = () => {
    const slot = $('#quickPreview');
    if (!slot) return;
    const parsed = state.quick.parsed;

    if (state.quick.busy) {
      slot.innerHTML = '<div class="quickbar-preview"><span class="qb-chip">Lendo…</span></div>';
      return;
    }
    if (!parsed || !(parsed.amount > 0)) {
      slot.innerHTML = '';
      return;
    }

    // `fields` diz de onde veio cada valor: "texto" = estava escrito,
    // qualquer outra coisa = o app supôs e por isso a etiqueta fica amarela.
    const chip = (label, value, kind = '') =>
      `<span class="qb-chip ${kind}">${label ? `${label} ` : ''}<b>${esc(value)}</b></span>`;
    const guess = source => (source === 'texto' ? '' : 'guess');

    const account = parsed.accountId ? CP.accountById(parsed.accountId) : CP.activeAccounts()[0];
    const card = parsed.cardId ? CP.cardById(parsed.cardId) : null;
    const categorySource = parsed.fields.category;

    slot.innerHTML = `<div class="quickbar-preview">
      ${chip('', money(parsed.amount), `money ${parsed.isIncome ? 'in' : ''}`)}
      ${chip('', parsed.isIncome ? 'Entrada' : 'Saída', guess(parsed.fields.amount))}
      ${chip('', parsed.description || '—')}
      ${parsed.category
        ? chip('', parsed.category, categorySource === 'none' ? 'guess' : '')
        : chip('', 'sem categoria', 'guess')}
      ${chip('', CP.paymentLabel(parsed.paymentMethod), guess(parsed.fields.paymentMethod))}
      ${parsed.installments > 1 ? chip('', `${parsed.installments}x`, guess(parsed.fields.installments)) : ''}
      ${chip('', CP.date(parsed.date), guess(parsed.fields.date))}
      ${card ? chip('', card.name) : account ? chip('', account.name, 'guess') : ''}
      <span class="qb-hint">amarelo = suposto · Enter confirma · Tab abre o formulário</span>
    </div>
    <div id="quickOutlier"></div>`;

    // O aviso de gasto fora do padrão chega depois, sem segurar a leitura.
    if (!parsed.isIncome) {
      CP.outlierNotice(parsed.description, parsed.amount, parsed.category)
        .then(html => { const slot = $('#quickOutlier'); if (slot) slot.innerHTML = html; });
    }
  };

  let quickTimer;
  const readQuick = async text => {
    if (!text.trim()) { state.quick.parsed = null; return renderQuickPreview(); }
    state.quick.busy = true;
    renderQuickPreview();
    try {
      state.quick.parsed = await api.entries.parse(text);
    } catch (error) {
      state.quick.parsed = null;
    } finally {
      state.quick.busy = false;
      renderQuickPreview();
    }
  };

  CP.initQuickBar = () => {
    const input = $('#quickInput');
    if (!input) return;

    input.addEventListener('input', () => {
      state.quick.text = input.value;
      clearTimeout(quickTimer);
      quickTimer = setTimeout(() => readQuick(input.value), 320);
    });

    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); submitQuick(); }
      // Tab abre o formulário completo já preenchido, para ajustar o que faltou.
      if (event.key === 'Tab' && state.quick.parsed?.amount > 0) {
        event.preventDefault();
        openPrefilledForm(state.quick.parsed);
      }
      if (event.key === 'Escape') { input.value = ''; state.quick.text = ''; state.quick.parsed = null; renderQuickPreview(); }
    });

    $('#quickSubmit')?.addEventListener('click', submitQuick);
    if (state.quick.text) readQuick(state.quick.text);
  };

  const submitQuick = async () => {
    const input = $('#quickInput');
    const text = input?.value.trim();
    if (!text) return toast('Escreva algo como "mercado 84,90 débito".', 'error');

    // Ainda não terminou de interpretar? Interpreta agora, na hora.
    let parsed = state.quick.parsed;
    if (!parsed || state.quick.busy) {
      state.quick.busy = true;
      renderQuickPreview();
      try { parsed = await api.entries.parse(text); } finally { state.quick.busy = false; }
    }
    if (!parsed || !(parsed.amount > 0)) {
      return toast('Não encontrei um valor na frase. Tente "mercado 84,90 débito".', 'error');
    }

    const result = await commitParsedEntry(parsed);
    if (result) {
      input.value = '';
      state.quick.text = '';
      state.quick.parsed = null;
      renderQuickPreview();
      input.focus();
    }
  };

  const commitParsedEntry = async parsed => {
    const account = parsed.accountId || CP.activeAccounts()[0]?.id;
    if (!account) { toast('Cadastre uma conta bancária primeiro.', 'error'); return null; }

    if (parsed.isIncome) {
      return mutate(() => api.incomes.create({
        source: parsed.description,
        category: parsed.category || db().categories.income[0]?.name || 'Outros',
        bankAccountId: account,
        amount: parsed.amount,
        date: parsed.date,
        description: ''
      }), `Entrada de ${money(parsed.amount)} adicionada.`);
    }

    const credit = parsed.paymentMethod === 'CARTAO_CREDITO';
    const benefit = parsed.paymentMethod === 'VALE_BENEFICIO';
    const card = parsed.cardId
      ? CP.cardById(parsed.cardId)
      : credit ? CP.activeCards('credit')[0] : benefit ? CP.activeCards('benefit')[0] : null;

    if ((credit || benefit) && !card) {
      toast(`Cadastre um ${credit ? 'cartão de crédito' : 'vale'} para lançar assim.`, 'error');
      return null;
    }

    return mutate(() => api.expenses.create({
      description: parsed.description,
      category: parsed.category || db().categories.variableExpense[0]?.name || 'Outros',
      paymentMethod: parsed.paymentMethod,
      bankAccountId: credit || benefit ? '' : account,
      creditCardId: card?.id || '',
      amount: parsed.amount,
      date: parsed.date,
      installments: parsed.installments || 1,
      status: credit ? 'PENDENTE' : 'PAGO'
    }), `Saída de ${money(parsed.amount)} adicionada${parsed.category ? ` em ${parsed.category}` : ''}.`);
  };

  /** Tab na barra rápida: abre o formulário já preenchido com o que foi lido. */
  const openPrefilledForm = parsed => {
    CP.prefill = parsed;
    CP.runAction(parsed.isIncome ? 'add-income' : 'add-expense');
  };

  // =========================================================================
  // Importação de extrato, fatura e comprovante
  // =========================================================================

  state.importSession = null;

  CP.openImport = () => {
    state.importSession = null;
    openModal(`
      <div id="importStage">
        <div class="dropzone" id="dropzone">
          <span class="dropzone-icon">📄</span>
          <div>
            <strong>Arraste seus extratos e faturas aqui</strong>
            <small>Pode jogar o ano inteiro de uma vez — cada lançamento vai para o mês certo</small>
          </div>
          <div class="dropzone-formats"><span>PDF</span><span>CSV</span><span>OFX</span><span>FOTO</span></div>
        </div>
        <div class="quick-or"><span>ou cole o texto</span></div>
        <div class="field full">
          <textarea id="pasteArea" rows="4"
            placeholder="Cole o extrato copiado do app do banco, um e-mail de compra ou um comprovante de Pix."></textarea>
        </div>
        <div class="form-footer field full">
          <button type="button" class="button ghost" data-close-modal>Cancelar</button>
          <button type="button" class="button primary" id="pasteSubmit">Ler o texto colado</button>
        </div>
      </div>`, 'Importar lançamentos', 'EXTRATOS, FATURAS E COMPROVANTES', '860px');

    const dropzone = $('#dropzone');

    dropzone.addEventListener('click', async () => {
      const paths = await api.dialog.openFiles({
        filters: [{ name: 'Extratos e faturas', extensions: ['pdf', 'csv', 'ofx', 'txt', 'png', 'jpg', 'jpeg', 'webp'] }]
      });
      if (paths?.length) readBatch(paths);
    });

    for (const eventName of ['dragenter', 'dragover']) {
      dropzone.addEventListener(eventName, event => { event.preventDefault(); dropzone.classList.add('dragging'); });
    }
    for (const eventName of ['dragleave', 'drop']) {
      dropzone.addEventListener(eventName, event => { event.preventDefault(); dropzone.classList.remove('dragging'); });
    }
    dropzone.addEventListener('drop', async event => {
      // no Jarvis o arquivo arrastado sobe para a pasta do financeiro e volta com o caminho
      const paths = await api.uploadFiles([...(event.dataTransfer?.files || [])]);
      if (paths.length) readBatch(paths);
      else toast('Não consegui ler esses arquivos. Use o botão para escolher.', 'error');
    });

    $('#pasteSubmit').addEventListener('click', async () => {
      const text = $('#pasteArea').value.trim();
      if (!text) return toast('Cole algum texto primeiro.', 'error');
      showImportProgress('Interpretando o texto…');
      try { renderTargets(await api.import.readPasted(text, {})); }
      catch (error) { renderImportError(error.message); }
    });
  };

  const showImportProgress = (message, detail = 'Tudo é feito no seu computador, sem internet.') => {
    const stage = $('#importStage');
    if (stage) {
      stage.innerHTML = `<div class="import-progress"><span class="spinner"></span><div>
        <strong>${esc(message)}</strong>
        <small style="display:block;color:var(--muted)">${esc(detail)}</small></div></div>`;
    }
  };

  const renderImportError = message => {
    const stage = $('#importStage');
    if (!stage) return;
    stage.innerHTML = `${emptyState('Não consegui ler', message)}
      <div class="form-footer field full">
        <button type="button" class="button ghost" data-close-modal>Fechar</button>
        <button type="button" class="button primary" data-action="import-statement">Tentar outros arquivos</button>
      </div>`;
  };

  /** Ponto de entrada único da importação de arquivos. */
  CP.importFiles = paths => readBatch(paths);

  const readBatch = async paths => {
    showImportProgress(
      `Lendo ${paths.length} arquivo${paths.length > 1 ? 's' : ''}…`,
      'PDFs grandes e fotos levam alguns segundos.'
    );
    try { renderTargets(await api.import.readBatch(paths, {})); }
    catch (error) { renderImportError(error.message); }
  };

  // -------------------------------------------------------------------------
  // Passo 1 — a qual conta ou cartão cada arquivo pertence
  // -------------------------------------------------------------------------

  const renderTargets = async session => {
    state.importSession = session;
    state.importTargets = {};

    if (!session.total && !session.documents.some(document => !document.empty)) {
      const empty = session.documents.find(document => document.empty);
      return renderImportError(empty?.emptyReason || 'Nenhum lançamento encontrado nesses arquivos.');
    }

    const suggestions = await api.import.suggestTargets(session);
    const accounts = CP.activeAccounts();
    const cards = CP.activeCards();

    const options = suggestion => {
      const pool = suggestion.documentType === 'fatura' ? cards : accounts;
      const kind = suggestion.documentType === 'fatura' ? 'card' : 'account';
      return `<select data-target="${esc(suggestion.fileName)}" data-kind="${kind}">
        ${suggestion.proposal ? `<option value="new" selected>✚ Criar ${kind === 'card' ? 'cartão' : 'conta'} "${esc(suggestion.proposal.name)}"</option>` : ''}
        ${pool.map(item => `<option value="${item.id}" ${item.id === suggestion.matchedId ? 'selected' : ''}>${esc(item.name)}</option>`).join('')}
        ${suggestion.proposal ? '' : `<option value="new">✚ Criar novo</option>`}
      </select>`;
    };

    $('#importStage').innerHTML = `
      <div class="import-summary">
        <span class="metric-icon">📄</span>
        <div>
          <strong>${session.documents.length} arquivo(s) lido(s)</strong>
          <small>${session.total} lançamento(s) · ${session.period ? `${CP.date(session.period.start)} a ${CP.date(session.period.end)}` : 'sem período'}</small>
        </div>
      </div>

      <p class="page-lead" style="margin-bottom:12px">Confirme a qual conta ou cartão cada arquivo pertence:</p>
      <div class="target-list">
        ${session.documents.map((document, index) => {
          const suggestion = suggestions[index];
          return `<div class="target-row ${document.empty ? 'empty' : ''}">
            <span class="target-icon">${document.documentType === 'fatura' ? '▰' : '◇'}</span>
            <div class="target-info">
              <strong>${esc(document.fileName)}</strong>
              <small>${esc(document.bank || 'banco não identificado')} · ${document.documentType}
                ${document.empty ? ' · sem movimentação' : ` · ${document.total} lançamento(s)`}
                ${document.declaredFinalBalance != null ? ` · saldo final ${money(document.declaredFinalBalance)}` : ''}</small>
            </div>
            ${document.empty ? '<span class="badge">nada a importar</span>' : options(suggestion)}
          </div>`;
        }).join('')}
      </div>

      ${session.errors.length ? `<div class="import-errors">
        ${session.errors.map(error => `<div>⚠ <strong>${esc(error.file)}</strong>: ${esc(error.message)}</div>`).join('')}
      </div>` : ''}

      <div class="import-actions">
        <span class="spacer"></span>
        <button type="button" class="button ghost" data-close-modal>Cancelar</button>
        <button type="button" class="button primary" id="targetsNext">Revisar lançamentos ›</button>
      </div>`;

    state.importSuggestions = suggestions;
    $('#targetsNext').addEventListener('click', () => {
      $$('[data-target]').forEach(select => {
        const suggestion = suggestions.find(item => item.fileName === select.dataset.target);
        state.importTargets[select.dataset.target] = select.value === 'new'
          ? { create: suggestion.proposal || { kind: select.dataset.kind, name: suggestion.bankName || 'Novo', bankName: suggestion.bankName } }
          : (select.dataset.kind === 'card' ? { cardId: select.value } : { accountId: select.value });
      });
      renderReview();
    });
  };

  // -------------------------------------------------------------------------
  // Passo 2 — revisar tudo numa lista só
  // -------------------------------------------------------------------------

  const KIND_LABEL = {
    expense: 'saída', income: 'entrada', investment: 'aporte',
    investmentReturn: 'resgate', invoicePayment: 'fatura', refund: 'estorno'
  };

  const renderReview = () => {
    const session = state.importSession;
    const selected = session.rows.filter(row => row.selected);

    $('#importStage').innerHTML = `
      <div class="import-summary">
        <span class="metric-icon" style="--metric-color:var(--success);--metric-soft:var(--success-soft)">✓</span>
        <div>
          <strong>${selected.length} de ${session.total} lançamentos prontos</strong>
          <small>${session.duplicates ? `${session.duplicates} repetido(s) já desmarcado(s) · ` : ''}${session.uncategorized} sem categoria</small>
        </div>
        ${badge(session.period ? `${CP.date(session.period.start)} → ${CP.date(session.period.end)}` : '', 'primary')}
      </div>

      ${session.byMonth.length > 1 ? `<div class="month-strip">
        ${session.byMonth.map(month => `<div class="month-chip">
          <strong>${CP.MONTHS[Number(month.month.slice(5, 7)) - 1]}<small>${month.month.slice(2, 4)}</small></strong>
          <span>${month.count}</span>
        </div>`).join('')}
      </div>` : ''}

      <div class="import-filters">
        <input data-import-search placeholder="Buscar lançamento…">
        <button class="button ghost small" data-import-filter="all">Todos</button>
        <button class="button ghost small" data-import-filter="uncategorized">Sem categoria</button>
        <button class="button ghost small" data-import-filter="duplicate">Repetidos</button>
      </div>

      <div class="import-rows" id="importRows">${renderRows(session.rows)}</div>

      <div class="import-actions">
        <button type="button" class="button ghost small" data-import-toggle="all">Marcar todos</button>
        <button type="button" class="button ghost small" data-import-toggle="none">Desmarcar todos</button>
        <span class="spacer"></span>
        <button type="button" class="button ghost" id="backToTargets">‹ Voltar</button>
        <button type="button" class="button primary" id="importConfirm">Importar ${selected.length}</button>
      </div>`;

    bindReview();
  };

  /**
   * Cada linha mostra a categoria como etiqueta, não como lista suspensa.
   *
   * Com 400 lançamentos, montar uma lista por linha criava quase 5.000
   * elementos e a tela levava 4 segundos para aparecer. Agora a lista só é
   * criada na linha em que você clicar.
   */
  const renderRows = rows => rows.map(row => {
    const editable = ['expense', 'income'].includes(row.kind);
    const tone = row.category ? '' : 'none';

    return `<label class="import-row ${row.selected ? '' : 'off'} ${row.duplicate ? 'dup' : ''}"
             data-row="${row.id}" data-kind="${row.kind}" data-has-category="${row.category ? '1' : '0'}">
      <input type="checkbox" data-import-row="${row.id}" ${row.selected ? 'checked' : ''}>
      <span class="import-date">${CP.date(row.date)}</span>
      <span class="import-desc">
        <b>${esc(row.description)}</b>
        <em>${esc(KIND_LABEL[row.kind] || row.kind)}${row.installment ? ` · parcela ${row.installment.number}/${row.installment.total}` : ''}${row.duplicate ? ` · ${esc(row.duplicate)}` : ''}${row.note ? ` · <b class="import-note">${esc(row.note)}</b>` : ''}</em>
      </span>
      <span class="import-cat">${editable
        ? `<button type="button" class="cat-edit ${tone}" data-cat-edit="${row.id}">${esc(row.category || 'sem categoria')}</button>`
        : `<span class="kind-tag">${esc(KIND_LABEL[row.kind] || row.kind)}</span>`}</span>
      <span class="import-amount ${row.isIncome ? 'money-positive' : 'money-negative'}">
        ${row.isIncome ? '+' : '−'} ${money(row.amount)}</span>
    </label>`;
  }).join('');

  /** Troca a etiqueta pela lista suspensa, só na linha clicada. */
  const openCategoryPicker = (button, row) => {
    const kind = row.isIncome ? 'income' : 'variableExpense';
    const options = (db().categories?.[kind] || [])
      .map(category => `<option value="${esc(category.name)}" ${category.name === row.category ? 'selected' : ''}>${esc(category.name)}</option>`)
      .join('');

    const select = document.createElement('select');
    select.innerHTML = `<option value="">sem categoria</option>${options}`;
    select.dataset.importCat = row.id;
    select.className = row.category ? '' : 'none';
    button.replaceWith(select);
    select.focus();
    select.size = 1;
    // Abre a lista na hora, para o clique não precisar ser dado duas vezes.
    // Só funciona quando vem de um clique real; se não vier, o campo fica
    // focado e um segundo clique abre — sem quebrar nada.
    try { select.showPicker?.(); } catch (error) { /* sem gesto do usuário */ }
  };

  const bindReview = () => {
    const stage = $('#importStage');
    const session = state.importSession;

    const refreshCount = () => {
      const count = session.rows.filter(row => row.selected).length;
      $('#importConfirm').textContent = `Importar ${count}`;
    };

    stage.addEventListener('change', event => {
      const checkbox = event.target.closest('[data-import-row]');
      if (checkbox) {
        const row = session.rows.find(item => item.id === checkbox.dataset.importRow);
        if (row) row.selected = checkbox.checked;
        checkbox.closest('.import-row').classList.toggle('off', !checkbox.checked);
        refreshCount();
      }
      const select = event.target.closest('[data-import-cat]');
      if (select) {
        const row = session.rows.find(item => item.id === select.dataset.importCat);
        if (row) { row.category = select.value; row.categoryEdited = true; }
        const line = select.closest('.import-row');
        line.dataset.hasCategory = select.value ? '1' : '0';

        // Volta a ser etiqueta, mantendo a lista leve.
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `cat-edit ${select.value ? '' : 'none'}`;
        button.dataset.catEdit = row.id;
        button.textContent = select.value || 'sem categoria';
        select.replaceWith(button);
      }
    });

    // Clique na etiqueta abre a lista daquela linha.
    stage.addEventListener('click', event => {
      const button = event.target.closest('[data-cat-edit]');
      if (!button) return;
      event.preventDefault();
      const row = session.rows.find(item => item.id === button.dataset.catEdit);
      if (row) openCategoryPicker(button, row);
    });

    $$('[data-import-toggle]', stage).forEach(button => button.addEventListener('click', () => {
      const check = button.dataset.importToggle === 'all';
      $$('.import-row', stage).forEach(element => {
        if (element.hidden) return;
        const checkbox = $('[data-import-row]', element);
        checkbox.checked = check;
        const row = session.rows.find(item => item.id === checkbox.dataset.importRow);
        if (row) row.selected = check;
        element.classList.toggle('off', !check);
      });
      refreshCount();
    }));

    // Filtros e busca escondem linhas sem redesenhar a lista inteira.
    const applyFilter = () => {
      const query = CP.normalize($('[data-import-search]', stage)?.value || '');
      const filter = state.importFilter || 'all';
      $$('.import-row', stage).forEach(element => {
        const row = session.rows.find(item => item.id === $('[data-import-row]', element).dataset.importRow);
        const matchesQuery = !query || CP.normalize(row.description).includes(query);
        const matchesFilter =
          filter === 'all' ? true
          : filter === 'uncategorized' ? element.dataset.hasCategory === '0' && ['expense', 'income'].includes(row.kind)
          : Boolean(row.duplicate);
        element.hidden = !(matchesQuery && matchesFilter);
      });
    };

    let searchTimer;
    $('[data-import-search]', stage)?.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(applyFilter, 200);
    });
    $$('[data-import-filter]', stage).forEach(button => button.addEventListener('click', () => {
      state.importFilter = button.dataset.importFilter;
      $$('[data-import-filter]', stage).forEach(item => item.classList.toggle('primary', item === button));
      applyFilter();
    }));

    $('#backToTargets').addEventListener('click', () => renderTargets(session));
    $('#importConfirm').addEventListener('click', confirmImport);
  };

  const confirmImport = async () => {
    const session = state.importSession;
    const count = session.rows.filter(row => row.selected).length;
    if (!count) return toast('Selecione ao menos um lançamento.', 'error');

    showImportProgress(`Importando ${count} lançamento(s)…`, 'Criando contas, gravando e conferindo os saldos.');
    try {
      const report = await api.import.commit(session, state.importTargets, {});
      await CP.reload();
      CP.render();
      renderImportReport(report, count);
    } catch (error) {
      toast(error.message, 'error');
      closeModal();
    }
  };

  /** O relatório final é onde a conciliação de saldo aparece para você. */
  const renderImportReport = (report, total) => {
    const parts = [
      ['saída', report.expenses], ['entrada', report.incomes],
      ['aporte', report.contributions], ['resgate', report.withdrawals],
      ['pagamento de fatura', report.invoicePayments]
    ].filter(([, value]) => value > 0);

    openModal(`
      <div class="import-summary" style="border-left-color:var(--success)">
        <span class="metric-icon" style="--metric-color:var(--success);--metric-soft:var(--success-soft)">✓</span>
        <div>
          <strong>${total - report.skipped} lançamento(s) importado(s)</strong>
          <small>${parts.map(([label, value]) => `${value} ${label}${value > 1 ? 's' : ''}`).join(' · ')}</small>
        </div>
      </div>

      ${report.reconciled?.length ? `
        <div class="section-label"><span>◎ Conferência de saldo</span><i></i></div>
        <div class="recon-list">${report.reconciled.map(item => item.alreadyMatched
          ? `<div class="recon-row ok"><span>✓</span><div><strong>${esc(item.account)}</strong>
               <small>o saldo do app já batia com o do banco: ${money(item.balance)}</small></div></div>`
          : `<div class="recon-row"><span>◎</span><div><strong>${esc(item.account)}</strong>
               <small>o extrato termina em ${money(item.declared)} — ajustei o saldo inicial para
               ${money(item.adjustedInitialBalance)} e agora bate exatamente</small></div></div>`
        ).join('')}</div>` : ''}

      ${report.invoicePayments ? `<p class="empty-hint">${report.invoicePayments} pagamento(s) de fatura reconhecido(s) no extrato — a fatura correspondente já está fechada.</p>` : ''}
      ${report.learned ? `<p class="empty-hint">${report.learned} regra(s) de categoria aprendida(s) com as suas correções.</p>` : ''}
      ${report.errors?.length ? `<div class="import-errors">${report.errors.slice(0, 5).map(error => `<div>⚠ ${esc(error)}</div>`).join('')}</div>` : ''}

      <div class="form-footer field full">
        ${report.batchId ? `<button type="button" class="button danger ghost" data-undo-import="${report.batchId}">Desfazer importação</button>` : ''}
        <span class="spacer"></span>
        <button type="button" class="button ghost" data-action="import-statement">Importar mais</button>
        <button type="button" class="button primary" data-close-modal>Concluir</button>
      </div>`, 'Importação concluída', 'RESUMO', '680px');

    const undo = document.querySelector('[data-undo-import]');
    if (undo) undo.addEventListener('click', () => CP.undoImport(undo.dataset.undoImport));
  };

  /**
   * Desfazer apaga só o que aquela importação criou. O que você registrou
   * depois, à mão, continua onde está — por isso existe, em vez de mandar
   * você restaurar um backup.
   */
  CP.undoImport = batchId => {
    CP.confirm(
      'Todos os lançamentos que vieram destes arquivos serão apagados, as faturas que eles '
      + 'fecharam voltam a ficar abertas e os saldos iniciais ajustados na conferência voltam ao '
      + 'que eram. O que você lançou à mão depois não é tocado.',
      async () => {
        const result = await api.import.undo(batchId);
        await CP.reload();
        CP.render();
        closeModal();
        const total = Object.values(result.removed || {}).reduce((acc, value) => acc + value, 0);
        toast(`Importação desfeita — ${total} registro(s) removido(s).`, 'success');
      },
      'Desfazer esta importação?',
      'Desfazer'
    );
  };

  // =========================================================================
  // Regras automáticas
  // =========================================================================

  state.ruleSearch = '';

  CP.renderRulesSection = () => {
    const rules = db().categoryRules || [];
    const query = CP.normalize(state.ruleSearch);
    const filtered = query
      ? rules.filter(rule => CP.normalize(`${rule.term} ${rule.category}`).includes(query))
      : rules;
    const learned = rules.filter(rule => rule.source !== 'builtin');

    return `<section class="settings-section">
      <h3>Regras automáticas</h3>
      <p>Quando você corrige a categoria de um lançamento, o app memoriza aqui e nunca mais erra aquele comerciante.
         ${learned.length ? `Você já ensinou <strong>${learned.length}</strong> regra(s).` : ''}</p>

      <div class="filter-bar rule-search">
        <span class="filter-caption">⌕</span>
        <div class="field" style="flex:1"><input data-rule-search value="${esc(state.ruleSearch)}" placeholder="Buscar termo ou categoria…"></div>
        <button class="button small" data-action="add-rule">＋ Nova regra</button>
        <button class="button ghost small" data-action="apply-rules">↻ Aplicar aos sem categoria</button>
      </div>

      <div class="rule-list">${filtered.slice(0, 150).map(rule => `
        <div class="rule-row ${rule.source === 'builtin' ? 'builtin' : ''}">
          <span><code>${esc(rule.term)}</code> → <strong>${esc(rule.category)}</strong></span>
          <span style="color:var(--muted);font-size:10px">${rule.kind === 'income' ? 'entrada' : 'saída'} · ${
            rule.source === 'builtin' ? 'embutida' : 'sua'}</span>
          <span class="hits">${rule.hits || 0}×</span>
          <button class="button danger small icon-only" data-action="delete-rule" data-id="${rule.id}" aria-label="Excluir">×</button>
        </div>`).join('') || '<p class="empty-hint">Nenhuma regra encontrada.</p>'}
      </div>
      ${filtered.length > 150 ? `<p class="empty-hint">Mostrando 150 de ${filtered.length}. Use a busca para filtrar.</p>` : ''}
    </section>`;
  };

  CP.openRuleForm = () => {
    const categories = [
      ...(db().categories?.variableExpense || []).map(c => ({ value: c.name, label: `Saída · ${c.name}` })),
      ...(db().categories?.income || []).map(c => ({ value: c.name, label: `Entrada · ${c.name}` }))
    ];
    openModal(`<form id="ruleForm" class="form-grid">
      ${field('term', 'Quando a descrição contiver', '', { full: true, placeholder: 'Ex.: ifood, posto shell, academia' })}
      ${field('category', 'Usar esta categoria', categories[0]?.value, { select: categories, full: true })}
      ${field('kind', 'Tipo', 'variableExpense', {
        select: [{ value: 'variableExpense', label: 'Saída' }, { value: 'income', label: 'Entrada' }] })}
      <div class="field full"><span class="field-help">
        A comparação ignora maiúsculas e acentos. Termos mais específicos têm prioridade sobre os genéricos.</span></div>
      ${formFooter('Criar regra')}
    </form>`, 'Nova regra automática', 'CATEGORIZAÇÃO');
  };

  /**
   * Gancho de aprendizado: chamado quando você troca a categoria de uma saída
   * já existente. É o que faz o app ficar melhor com o uso.
   */
  CP.learnFromCorrection = async (description, category, kind = 'variableExpense') => {
    if (!description || !category) return;
    try {
      await api.rules.learn(description, category, kind);
    } catch (error) { /* aprender é um bônus, não pode quebrar o salvamento */ }
  };
})();
