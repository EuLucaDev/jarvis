/* ==========================================================================
   Formulários, ações e ciclo de vida do aplicativo.
   ========================================================================== */

'use strict';

(() => {
  const { $, $$, esc, money, state, field, formFooter, formData, openModal,
          closeModal, confirm: confirmAction, toast, mutate, badge, emptyState,
          summaryCard, select } = CP;

  const db = () => CP.db();
  const api = window.api;

  // =========================================================================
  // Onboarding — a primeira abertura, quando o banco ainda está vazio
  // =========================================================================

  const onboarding = { step: 0, data: { theme: 'dark' } };

  const ONBOARDING_STEPS = [
    {
      title: 'Bem-vindo ao financeiro do Jarvis',
      lead: 'Um app de controle financeiro que roda inteiro no seu computador. Nada é enviado para a internet — seus dados ficam num único arquivo aqui na sua máquina.',
      fields: () => `
        ${field('name', 'Como quer chamar sua carteira?', onboarding.data.name || 'Minha Carteira', { full: true, placeholder: 'Ex.: Minhas finanças' })}
        <div class="onboarding-privacy"><span>🔒</span>
          <div><b>Tudo offline.</b> Sem cadastro, sem senha, sem servidor. Você pode exportar um backup a qualquer momento para levar a carteira para outro computador.</div>
        </div>`
    },
    {
      title: 'Suas metas',
      lead: 'Elas alimentam o índice de saúde financeira e as projeções da visão geral. Pode mudar depois, quando quiser.',
      fields: () => `
        ${field('monthlyGoal', 'Quanto você quer que sobre por mês?', CP.moneyInput(onboarding.data.monthlyGoal || 0), { currency: true, required: false, help: 'Deixe em branco se ainda não sabe.' })}
        ${field('emergencyReserveGoal', 'Meta da reserva de emergência', CP.moneyInput(onboarding.data.emergencyReserveGoal || 0), { currency: true, required: false, help: 'O recomendado é de 3 a 6 meses das suas despesas.' })}
        <div class="onboarding-privacy"><span>💡</span>
          <div>Se você definir uma meta de reserva, o app já cria o investimento <b>Reserva de emergência</b> para acompanhar o progresso.</div>
        </div>`
    },
    {
      title: 'Sua primeira conta',
      lead: 'Toda entrada e saída precisa estar ligada a uma conta. Cadastre a que você mais usa — dá para adicionar outras depois.',
      fields: () => `
        ${field('accountName', 'Nome da conta', onboarding.data.account?.name || '', { placeholder: 'Ex.: Conta principal', required: false })}
        ${field('bankName', 'Banco', onboarding.data.account?.bankName || '', { placeholder: 'Ex.: Nubank', required: false })}
        ${field('accountType', 'Tipo', onboarding.data.account?.accountType || 'CONTA_DIGITAL', { select: CP.ACCOUNT_TYPES })}
        ${field('initialBalance', 'Saldo atual', CP.moneyInput(onboarding.data.account?.initialBalance || 0), { currency: true, required: false })}
        <div class="onboarding-privacy"><span>✦</span>
          <div>Pode pular esta etapa — o app abre normalmente e você cadastra a conta quando quiser.</div>
        </div>`
    }
  ];

  const renderOnboarding = () => {
    const step = ONBOARDING_STEPS[onboarding.step];
    const isLast = onboarding.step === ONBOARDING_STEPS.length - 1;

    $('#onboardingRoot').innerHTML = `
      <div class="onboarding">
        <div class="onboarding-card">
          <div class="onboarding-brand">
            <div class="brand-mark"><span>J</span></div>
            <div><strong>Financeiro</strong><small>Configuração inicial</small></div>
          </div>
          <div class="onboarding-steps">${ONBOARDING_STEPS.map((_, index) => `
            <i class="${index === onboarding.step ? 'active' : index < onboarding.step ? 'done' : ''}"></i>`).join('')}</div>
          <h2>${esc(step.title)}</h2>
          <p class="step-lead">${esc(step.lead)}</p>
          <form id="onboardingForm" class="form-grid">${step.fields()}</form>
          <div class="onboarding-footer">
            ${onboarding.step > 0
              ? '<button class="button ghost" data-onboarding="back">‹ Voltar</button>'
              : '<span class="onboarding-skip">Passo 1 de 3</span>'}
            <div style="display:flex;gap:8px">
              ${isLast ? '<button class="button ghost" data-onboarding="skip">Pular</button>' : ''}
              <button class="button primary" data-onboarding="next">${isLast ? 'Criar minha carteira' : 'Continuar ›'}</button>
            </div>
          </div>
        </div>
      </div>`;

    const root = $('#onboardingRoot');
    CP.initSelects(root);
    CP.initCurrency(root);
    setTimeout(() => $('input:not([type="hidden"])', root)?.focus(), 120);
  };

  /** Guarda o que foi preenchido antes de trocar de passo. */
  const captureOnboardingStep = () => {
    const form = $('#onboardingForm');
    if (!form) return;
    const data = formData(form);
    if (onboarding.step === 0) onboarding.data.name = data.name;
    if (onboarding.step === 1) {
      onboarding.data.monthlyGoal = data.monthlyGoal;
      onboarding.data.emergencyReserveGoal = data.emergencyReserveGoal;
    }
    if (onboarding.step === 2) {
      onboarding.data.account = {
        name: data.accountName,
        bankName: data.bankName,
        accountType: data.accountType,
        initialBalance: data.initialBalance
      };
    }
  };

  const finishOnboarding = async (skipAccount = false) => {
    captureOnboardingStep();
    const payload = { ...onboarding.data };
    if (skipAccount || !payload.account?.name || !payload.account?.bankName) delete payload.account;
    if (!payload.name?.trim()) payload.name = 'Minha Carteira';

    CP.showLoading();
    try {
      await api.completeOnboarding(payload);
      $('#onboardingRoot').innerHTML = '';
      await boot(true);
      toast(`Carteira criada. Bem-vindo, ${payload.name}!`);
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      CP.hideLoading();
    }
  };

  document.addEventListener('click', event => {
    const button = event.target.closest('[data-onboarding]');
    if (!button) return;
    const move = button.dataset.onboarding;
    if (move === 'back') { captureOnboardingStep(); onboarding.step--; return renderOnboarding(); }
    if (move === 'skip') return finishOnboarding(true);
    if (onboarding.step === ONBOARDING_STEPS.length - 1) return finishOnboarding();
    captureOnboardingStep();
    onboarding.step++;
    renderOnboarding();
  });

  // =========================================================================
  // Formulários
  // =========================================================================

  const openIncomeForm = (id = null) => {
    const prefill = CP.prefill;
    CP.prefill = null;
    const item = id ? db().incomes.find(x => x.id === id) : prefill ? {
      source: prefill.description, category: prefill.category,
      bankAccountId: prefill.accountId || CP.activeAccounts()[0]?.id,
      amount: prefill.amount, date: prefill.date, description: '', notes: ''
    } : {
      source: '', category: db().categories?.income?.[0]?.name,
      bankAccountId: CP.activeAccounts()[0]?.id, amount: '', date: CP.today(), description: '', notes: ''
    };
    if (!CP.activeAccounts().length) return toast('Cadastre uma conta bancária antes de registrar entradas.', 'error');

    openModal(`<form id="entityForm" data-form="income" data-id="${id || ''}" class="form-grid">
      ${field('source', 'Origem', item.source, { placeholder: 'Ex.: salário, freela…' })}
      ${field('category', 'Categoria', item.category, { select: CP.categoryOptions('income') })}
      ${field('bankAccountId', 'Conta de destino', item.bankAccountId, { select: CP.accountOptions() })}
      ${field('amount', 'Valor', CP.moneyInput(item.amount), { currency: true })}
      ${field('date', 'Data', item.date, { date: true })}
      ${field('description', 'Descrição', item.description, { required: false, placeholder: 'Opcional' })}
      ${field('notes', 'Observações', item.notes, { textarea: true, full: true, required: false })}
      ${formFooter(id ? 'Salvar alterações' : 'Adicionar entrada')}
    </form>`, id ? 'Editar entrada' : 'Nova entrada', 'MOVIMENTAÇÃO');
  };

  const openExpenseForm = (id = null) => {
    // Vindo da barra rápida com Tab: abre já preenchido com o que foi lido.
    const prefill = CP.prefill;
    CP.prefill = null;
    const existing = id ? db().expenses.find(x => x.id === id) : (prefill ? {
      description: prefill.description, category: prefill.category,
      paymentMethod: prefill.paymentMethod, amount: prefill.amount, date: prefill.date,
      creditCardId: prefill.cardId, bankAccountId: prefill.accountId,
      status: prefill.paymentMethod === 'CARTAO_CREDITO' ? 'PENDENTE' : 'PAGO'
    } : null);
    const purchase = existing?.cardPurchaseId
      ? db().cardPurchases?.find(p => p.id === existing.cardPurchaseId) : null;
    const item = existing || {
      category: db().categories?.variableExpense?.[0]?.name, paymentMethod: 'PIX',
      amount: '', date: CP.today(), status: 'PAGO', description: '', notes: ''
    };

    openModal(`<form id="entityForm" data-form="expense" data-id="${id || ''}" class="form-grid">
      ${field('description', 'Descrição', item.description, { full: true, placeholder: 'Ex.: supermercado da semana' })}
      ${field('category', 'Categoria', item.category, { select: CP.categoryOptions('variableExpense') })}
      ${field('paymentMethod', 'Forma de pagamento', item.paymentMethod, {
        select: Object.entries(CP.PAYMENT_LABELS).map(([value, label]) => ({ value, label })) })}
      <div class="field" data-bank-field><label>Conta bancária</label>
        ${select('bankAccountId', CP.accountOptions(), existing?.bankAccountId || CP.activeAccounts()[0]?.id)}</div>
      <div class="field" data-credit-field hidden><label>Cartão de crédito</label>
        ${select('creditCardId', CP.cardOptions('credit'), existing?.creditCardId || CP.activeCards('credit')[0]?.id)}</div>
      <div class="field" data-benefit-field hidden><label>Vale ou benefício</label>
        ${select('benefitCardId', CP.cardOptions('benefit'), existing?.creditCardId || CP.activeCards('benefit')[0]?.id)}</div>
      ${field('amount', 'Valor total', CP.moneyInput(item.amount), { currency: true })}
      ${field('date', 'Data', item.date, { date: true })}
      ${field('installments', 'Parcelas', purchase?.installments || 1, { type: 'number', min: 1, max: 60 })}
      ${field('status', 'Status', item.status, { select: [{ value: 'PAGO', label: 'Pago' }, { value: 'PENDENTE', label: 'Pendente' }] })}
      ${field('notes', 'Observações', item.notes, { textarea: true, full: true, required: false })}
      ${formFooter(id ? 'Salvar alterações' : 'Adicionar saída')}
    </form>`, id ? 'Editar saída' : 'Nova saída', 'MOVIMENTAÇÃO');

    // A forma de pagamento decide quais campos fazem sentido.
    const method = $('input[name="paymentMethod"]', $('#entityForm'));
    const syncFields = () => {
      const credit = method.value === 'CARTAO_CREDITO';
      const benefit = method.value === 'VALE_BENEFICIO';
      $('[data-bank-field]').hidden = credit || benefit;
      $('[data-credit-field]').hidden = !credit;
      $('[data-benefit-field]').hidden = !benefit;
      $('input[name="installments"]').closest('.field').hidden = !credit;
      $('input[name="status"]').closest('.field').hidden = credit || benefit;
    };
    method.addEventListener('change', syncFields);
    syncFields();

    // Sugestão de categoria enquanto você digita, pelas regras aprendidas e
    // pelo dicionário de comerciantes.
    const description = $('input[name="description"]', $('#entityForm'));
    let timer;
    description.addEventListener('input', () => {
      clearTimeout(timer);
      const text = description.value.trim();
      if (text.length < 4 || id) return;
      timer = setTimeout(async () => {
        try {
          const { category } = await api.rules.categorize(text, 'variableExpense');
          if (!category) return;
          const hidden = $('input[name="category"]', $('#entityForm'));
          const root = hidden?.closest('.custom-select');
          const option = root && $$('.select-option', root).find(o => o.dataset.value === category);
          if (option && hidden.value !== category) option.click();
        } catch (error) { /* sugestão é um extra; silencioso */ }
      }, 700);
    });
  };

  const openFixedForm = (id = null) => {
    const item = id ? db().fixedExpenses.find(x => x.id === id) : {
      name: '', category: db().categories?.fixedExpense?.[0]?.name,
      defaultBankAccountId: CP.activeAccounts()[0]?.id, defaultPaymentMethod: 'PIX',
      defaultCreditCardId: '', estimatedAmount: '', dueDay: 10, status: 'ATIVA', notes: ''
    };
    openModal(`<form id="entityForm" data-form="fixed" data-id="${id || ''}" class="form-grid">
      ${field('name', 'Nome da despesa', item.name, { placeholder: 'Ex.: Internet residencial', full: true })}
      ${field('category', 'Categoria', item.category, { select: CP.categoryOptions('fixedExpense') })}
      ${field('defaultPaymentMethod', 'Pagamento padrão', item.defaultPaymentMethod, {
        select: Object.entries(CP.PAYMENT_LABELS).map(([value, label]) => ({ value, label })) })}
      ${field('defaultBankAccountId', 'Conta padrão', item.defaultBankAccountId, { select: CP.accountOptions(true) })}
      ${field('defaultCreditCardId', 'Cartão ou benefício padrão', item.defaultCreditCardId, { select: CP.cardOptions(), required: false })}
      ${field('estimatedAmount', 'Valor estimado', CP.moneyInput(item.estimatedAmount), { currency: true })}
      ${field('dueDay', 'Dia do vencimento', item.dueDay, { type: 'number', min: 1, max: 31, help: 'Dia 31 vira o último dia em meses curtos.' })}
      ${field('status', 'Status', item.status, { select: [{ value: 'ATIVA', label: 'Ativa' }, { value: 'INATIVA', label: 'Inativa' }] })}
      ${field('notes', 'Observações', item.notes, { textarea: true, full: true, required: false })}
      ${formFooter(id ? 'Salvar alterações' : 'Cadastrar compromisso')}
    </form>`, id ? 'Editar despesa fixa' : 'Nova despesa fixa', 'COMPROMISSO MENSAL');
  };

  const openRecurringForm = (id = null) => {
    const item = id ? db().recurringIncomes.find(x => x.id === id) : {
      name: '', source: '', category: db().categories?.income?.[0]?.name,
      defaultAccountId: CP.activeAccounts()[0]?.id, estimatedAmount: '', receiveDay: 5, status: 'ATIVA', notes: ''
    };
    openModal(`<form id="entityForm" data-form="recurring" data-id="${id || ''}" class="form-grid">
      ${field('name', 'Nome', item.name, { placeholder: 'Ex.: Salário mensal', full: true })}
      ${field('source', 'Origem', item.source, { placeholder: 'Ex.: Empresa X' })}
      ${field('category', 'Categoria', item.category, { select: CP.categoryOptions('income') })}
      ${field('defaultAccountId', 'Conta de destino', item.defaultAccountId, { select: CP.accountOptions(true) })}
      ${field('estimatedAmount', 'Valor estimado', CP.moneyInput(item.estimatedAmount), { currency: true })}
      ${field('receiveDay', 'Dia do recebimento', item.receiveDay, { type: 'number', min: 1, max: 31 })}
      ${field('status', 'Status', item.status, { select: [{ value: 'ATIVA', label: 'Ativa' }, { value: 'INATIVA', label: 'Inativa' }] })}
      ${field('notes', 'Observações', item.notes, { textarea: true, full: true, required: false })}
      ${formFooter(id ? 'Salvar alterações' : 'Cadastrar receita')}
    </form>`, id ? 'Editar receita recorrente' : 'Nova receita recorrente', 'RENDA MENSAL');
  };

  const openAccountForm = (id = null) => {
    const item = id ? db().bankAccounts.find(x => x.id === id) : {
      name: '', bankName: '', accountType: 'CONTA_DIGITAL', initialBalance: '', color: '#8b5cf6', status: 'ATIVA'
    };
    openModal(`<form id="entityForm" data-form="account" data-id="${id || ''}" class="form-grid">
      ${field('name', 'Nome da conta', item.name, { placeholder: 'Ex.: Conta principal' })}
      ${field('bankName', 'Banco / instituição', item.bankName, { placeholder: 'Ex.: Nubank' })}
      ${field('accountType', 'Tipo', item.accountType, { select: CP.ACCOUNT_TYPES })}
      ${field('initialBalance', 'Saldo inicial', CP.moneyInput(item.initialBalance), { currency: true, required: false,
        help: id ? 'O saldo atual é calculado a partir dos lançamentos.' : 'Quanto tem nessa conta hoje.' })}
      ${field('color', 'Cor', item.color, { type: 'color' })}
      ${field('status', 'Status', item.status, { select: [{ value: 'ATIVA', label: 'Ativa' }, { value: 'INATIVA', label: 'Inativa' }] })}
      ${formFooter(id ? 'Salvar alterações' : 'Cadastrar conta')}
    </form>`, id ? 'Editar conta' : 'Nova conta bancária', 'CONTA');
  };

  const openCardForm = (id = null) => {
    const item = id ? db().cardsBenefits.find(x => x.id === id) : {
      name: '', bankName: '', cardType: 'CREDITO', limit: '', benefitBalance: '',
      closingDay: 5, dueDay: 12, color: '#7c3aed', status: 'ATIVO'
    };
    openModal(`<form id="entityForm" data-form="card" data-id="${id || ''}" class="form-grid">
      ${field('cardType', 'Tipo', item.cardType, { select: CP.CARD_TYPES, full: true })}
      ${field('name', 'Nome', item.name, { placeholder: 'Ex.: Nubank Ultravioleta' })}
      ${field('bankName', 'Banco / emissor', item.bankName)}
      <div data-credit-config style="display:contents">
        ${field('limit', 'Limite total', CP.moneyInput(item.limit), { currency: true, required: false })}
        ${field('closingDay', 'Dia do fechamento', item.closingDay || 5, { type: 'number', min: 1, max: 31, required: false,
          help: 'Compras após esse dia entram na fatura seguinte.' })}
        ${field('dueDay', 'Dia do vencimento', item.dueDay || 12, { type: 'number', min: 1, max: 31, required: false })}
      </div>
      <div data-benefit-config style="display:contents">
        ${field('benefitBalance', 'Saldo disponível', CP.moneyInput(item.benefitBalance), { currency: true, required: false,
          help: 'Quanto há hoje no vale. Use "Recarregar" nos próximos meses.' })}
      </div>
      ${field('color', 'Cor', item.color, { type: 'color' })}
      ${field('status', 'Status', item.status, { select: [{ value: 'ATIVO', label: 'Ativo' }, { value: 'INATIVO', label: 'Inativo' }] })}
      ${formFooter(id ? 'Salvar alterações' : 'Cadastrar')}
    </form>`, id ? 'Editar cartão ou benefício' : 'Novo cartão ou benefício', 'CARTEIRA');

    const typeInput = $('input[name="cardType"]', $('#entityForm'));
    const syncFields = () => {
      const benefit = typeInput.value !== 'CREDITO';
      $('[data-credit-config]').hidden = benefit;
      $('[data-benefit-config]').hidden = !benefit;
      $('#modalEyebrow').textContent = benefit ? 'BENEFÍCIO' : 'CRÉDITO';
    };
    typeInput.addEventListener('change', syncFields);
    syncFields();
  };

  const openPurchaseForm = () => {
    if (!CP.activeCards().length) return toast('Cadastre um cartão ou benefício antes de lançar uma compra.', 'error');
    openModal(`<form id="entityForm" data-form="purchase" class="form-grid">
      ${field('creditCardId', 'Cartão ou benefício', CP.activeCards()[0]?.id, { select: CP.cardOptions() })}
      ${field('description', 'Descrição da compra', '', { full: true, placeholder: 'Ex.: notebook, mercado, jantar' })}
      ${field('category', 'Categoria', db().categories?.variableExpense?.[0]?.name, { select: CP.categoryOptions('variableExpense') })}
      ${field('amount', 'Valor total', '', { currency: true })}
      ${field('date', 'Data da compra', CP.today(), { date: true })}
      ${field('installments', 'Número de parcelas', 1, { type: 'number', min: 1, max: 60 })}
      ${field('notes', 'Observações', '', { textarea: true, full: true, required: false })}
      ${formFooter('Lançar compra')}
    </form>`, 'Nova compra', 'CARTÃO OU BENEFÍCIO');

    const cardInput = $('input[name="creditCardId"]', $('#entityForm'));
    const syncFields = () => {
      const benefit = CP.isBenefit(CP.cardById(cardInput.value));
      $('input[name="installments"]').closest('.field').hidden = benefit;
      $('#modalEyebrow').textContent = benefit ? 'COMPRA NO BENEFÍCIO' : 'COMPRA NO CRÉDITO';
    };
    cardInput.addEventListener('change', syncFields);
    syncFields();
  };

  const openTransferForm = (id = null) => {
    const accounts = CP.activeAccounts();
    if (accounts.length < 2) return toast('Você precisa de pelo menos duas contas ativas para transferir.', 'error');
    const item = id ? db().transfers.find(x => x.id === id) : {
      fromAccountId: accounts[0]?.id, toAccountId: accounts[1]?.id,
      amount: '', date: CP.today(), description: '', notes: ''
    };
    openModal(`<form id="entityForm" data-form="transfer" data-id="${id || ''}" class="form-grid">
      ${field('fromAccountId', 'De qual conta sai', item.fromAccountId, { select: CP.accountOptions() })}
      ${field('toAccountId', 'Para qual conta vai', item.toAccountId, { select: CP.accountOptions() })}
      ${field('amount', 'Valor', CP.moneyInput(item.amount), { currency: true })}
      ${field('date', 'Data', item.date, { date: true })}
      ${field('description', 'Descrição', item.description, { full: true, required: false, placeholder: 'Ex.: guardar para a viagem' })}
      <div class="field full"><span class="field-help">
        A transferência move o saldo entre as contas sem contar como entrada nem como saída do mês.</span></div>
      ${formFooter(id ? 'Salvar alterações' : 'Transferir')}
    </form>`, id ? 'Editar transferência' : 'Nova transferência', 'ENTRE CONTAS');
  };

  const openInvestmentForm = (id = null) => {
    const item = id ? db().investments.find(x => x.id === id) : {
      name: '', type: 'ACAO', symbol: '', institution: '', currency: 'BRL', market: 'BR',
      initialQuantity: '', initialPrice: '', exchangeRate: 1, purchaseDate: CP.today(),
      benchmark: '', annualRate: '', maturityDate: '', goalAmount: '', autoQuote: 1, status: 'ATIVO', notes: ''
    };
    openModal(`<form id="entityForm" data-form="investment" data-id="${id || ''}" class="form-grid">
      <input type="hidden" name="providerId" value="${esc(item.providerId || '')}">
      ${field('type', 'Tipo', item.type, { select: CP.INVESTMENT_TYPES })}
      <div class="field asset-search-field"><label for="field_symbol">Código ou nome do ativo</label>
        <div class="asset-search-input"><span>⌕</span><input id="field_symbol" name="symbol" value="${esc(item.symbol || '')}" placeholder="Busque MXRF11, Petrobras, Bitcoin…" autocomplete="off" spellcheck="false"><i class="asset-search-spinner" aria-hidden="true"></i></div>
        <span class="field-help">Digite pelo menos 2 caracteres para consultar as APIs.</span>
        <div class="asset-search-results" id="assetSearchResults" role="listbox" aria-label="Ativos encontrados"></div>
      </div>
      ${field('name', 'Nome personalizado', item.name, { placeholder: 'Ex.: Minha posição em MXRF11', required: false })}
      ${field('institution', 'Corretora ou instituição', item.institution, { placeholder: 'Ex.: XP, Nubank, BTG' })}
      ${field('currency', 'Moeda', item.currency || 'BRL', { select: [{ value: 'BRL', label: 'Real (BRL)' }, { value: 'USD', label: 'Dólar (USD)' }, { value: 'EUR', label: 'Euro (EUR)' }] })}
      ${field('market', 'Mercado', item.market || 'BR', { select: [{ value: 'BR', label: 'Brasil' }, { value: 'US', label: 'Estados Unidos' }, { value: 'GLOBAL', label: 'Global / cripto' }] })}
      ${field('status', 'Status', item.status, { select: [{ value: 'ATIVO', label: 'Ativo' }, { value: 'INATIVO', label: 'Inativo' }] })}
      ${field('autoQuote', 'Atualização de preço', item.autoQuote === 0 ? 'false' : 'true', { select: [{ value: 'true', label: 'Automática quando disponível' }, { value: 'false', label: 'Manual / contratual' }] })}
      ${!id ? field('initialQuantity', 'Quantidade inicial', '', { type: 'number', min: 0, step: '0.00000001', required: false, help: 'Ex.: 3 cotas de MXRF11.' }) : ''}
      ${!id ? field('initialPrice', 'Preço pago por unidade', '', { currency: true, required: false }) : ''}
      ${!id ? field('exchangeRate', 'Câmbio da compra', CP.moneyInput(item.exchangeRate || 1), { currency: true, required: false, help: 'Use 1 para investimentos em reais.' }) : ''}
      ${!id ? field('purchaseDate', 'Data da posição inicial', item.purchaseDate, { date: true }) : ''}
      ${!id ? field('bankAccountId', 'Movimentar conta bancária', '', { select: [{ value: '', label: 'Não movimentar nenhuma conta' }, ...CP.accountOptions()], full: true, required: false }) : ''}
      ${field('benchmark', 'Indexador / benchmark', item.benchmark, { placeholder: 'Ex.: 110% CDI, IPCA +', required: false })}
      ${field('annualRate', 'Taxa anual estimada (%)', item.annualRate || '', { type: 'number', min: 0, step: '0.01', required: false, help: 'Usada na projeção de ativos sem cotação.' })}
      ${field('maturityDate', 'Vencimento', item.maturityDate, { date: true, required: false })}
      ${field('goalAmount', 'Meta', CP.moneyInput(item.goalAmount), { currency: true, required: false })}
      ${field('notes', 'Observações', item.notes, { textarea: true, full: true, required: false })}
      <div class="field full"><span class="field-help">A carteira apenas organiza e calcula seus investimentos. Nenhuma ordem de compra ou venda é enviada.</span></div>
      ${formFooter(id ? 'Salvar alterações' : 'Adicionar à carteira')}
    </form>`, id ? 'Editar ativo' : 'Adicionar investimento', 'MINHA CARTEIRA');

    const form = $('#entityForm');
    const symbolInput = $('input[name="symbol"]', form);
    const resultsRoot = $('#assetSearchResults', form);
    const searchWrap = symbolInput.closest('.asset-search-field');
    let searchTimer = null;
    let searchSequence = 0;
    let results = [];

    const setSelectValue = (name, value, label) => {
      const hidden = $(`input[name="${name}"]`, form);
      if (!hidden) return;
      hidden.value = value;
      const root = hidden.closest('.custom-select');
      const option = $(`.select-option[data-value="${CSS.escape(String(value))}"]`, root);
      $$('.select-option', root).forEach(item => item.classList.toggle('selected', item === option));
      $('.select-trigger', root).textContent = option?.textContent.trim() || label || value;
    };

    const closeResults = () => {
      resultsRoot.classList.remove('open');
      resultsRoot.innerHTML = '';
    };

    const chooseResult = result => {
      symbolInput.value = result.symbol || '';
      const nameInput = $('input[name="name"]', form);
      if (nameInput && !nameInput.value.trim()) nameInput.value = result.name || result.symbol || '';
      setSelectValue('type', result.assetClass, CP.INVESTMENT_TYPES.find(type => type.value === result.assetClass)?.label);
      setSelectValue('currency', result.currency || 'BRL');
      setSelectValue('market', result.market || 'BR');
      const priceInput = $('input[name="initialPrice"]', form);
      if (priceInput && result.price > 0 && !CP.parseMoney(priceInput.value)) priceInput.value = CP.moneyInput(result.price);
      const maturityInput = $('input[name="maturityDate"]', form);
      if (maturityInput && result.maturityDate) maturityInput.value = String(result.maturityDate).slice(0, 10);
      symbolInput.dataset.source = result.source || '';
      $('input[name="providerId"]', form).value = result.providerId || '';
      closeResults();
      symbolInput.focus();
    };

    const renderSearchResults = response => {
      results = response.results || [];
      if (!results.length) {
        resultsRoot.innerHTML = `<div class="asset-search-message"><span>${response.searchable === false ? '✎' : '⌕'}</span><div><strong>${response.searchable === false ? 'Cadastro manual' : 'Nenhum ativo encontrado'}</strong><small>${esc(response.message || 'Tente buscar pelo código completo ou por outro nome.')}</small></div></div>`;
      } else {
        resultsRoot.innerHTML = `<div class="asset-results-head"><span>${results.length} resultado(s)</span><small>Selecione para preencher automaticamente</small></div>${results.map((result, index) => `<button type="button" class="asset-result" data-result-index="${index}" role="option">
          <span class="asset-result-mark">${esc(String(result.symbol).slice(0, 2).toUpperCase())}</span>
          <span class="asset-result-copy"><strong>${esc(result.symbol)}</strong><small>${esc(result.name)}</small><em>${esc(result.sector || result.assetClass)}</em></span>
          <span class="asset-result-price">${result.price > 0 ? `<strong>${money(result.price)}</strong><small class="${Number(result.changePercent) >= 0 ? 'positive' : 'negative'}">${Number(result.changePercent) >= 0 ? '+' : ''}${Number(result.changePercent || 0).toFixed(2)}%</small>` : '<small>Preço ao atualizar</small>'}</span>
          <span class="asset-result-source">${esc(result.source)}</span>
        </button>`).join('')}`;
      }
      resultsRoot.classList.add('open');
    };

    const searchAssets = async () => {
      const query = symbolInput.value.trim();
      if (query.length < 2) return closeResults();
      const sequence = ++searchSequence;
      searchWrap.classList.add('searching');
      resultsRoot.innerHTML = '<div class="asset-search-loading"><i></i><span>Consultando as fontes de mercado…</span></div>';
      resultsRoot.classList.add('open');
      try {
        const response = await api.marketData.search(query, $('input[name="type"]', form).value);
        if (sequence === searchSequence) renderSearchResults(response);
      } catch (error) {
        if (sequence === searchSequence) renderSearchResults({ results: [], message: error.message });
      } finally {
        if (sequence === searchSequence) searchWrap.classList.remove('searching');
      }
    };

    symbolInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(searchAssets, 320);
    });
    form.addEventListener('change', event => {
      if (event.target.name === 'type' && symbolInput.value.trim().length >= 2) searchAssets();
    });
    resultsRoot.addEventListener('click', event => {
      const option = event.target.closest('[data-result-index]');
      if (option) chooseResult(results[Number(option.dataset.resultIndex)]);
    });
    symbolInput.addEventListener('keydown', event => {
      const options = $$('.asset-result', resultsRoot);
      if (!options.length || !['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(event.key)) return;
      event.preventDefault();
      if (event.key === 'Escape') return closeResults();
      const focused = $('.asset-result:focus', resultsRoot);
      if (event.key === 'Enter' && focused) return focused.click();
      const index = focused ? options.indexOf(focused) : -1;
      options[event.key === 'ArrowUp' ? Math.max(0, index - 1) : Math.min(options.length - 1, index + 1)]?.focus();
    });
  };

  const openOperationForm = (investmentId = '') => {
    const active = (db().investments || []).filter(i => i.status === 'ATIVO');
    if (!active.length) return toast('Cadastre um investimento antes de registrar uma operação.', 'error');
    const selected = active.find(item => item.id === investmentId) || active[0];
    openModal(`<form id="entityForm" data-form="investmentOperation" class="form-grid">
      ${field('investmentId', 'Ativo', selected.id, { select: active.map(item => ({ value: item.id, label: `${item.symbol || item.name} · ${money(item.currentAmount)}` })) })}
      ${field('operationType', 'Operação', 'COMPRA', { select: [
        { value: 'COMPRA', label: 'Compra' }, { value: 'VENDA', label: 'Venda' },
        { value: 'APORTE', label: 'Aplicação em renda fixa' }, { value: 'RESGATE', label: 'Resgate' },
        { value: 'BONIFICACAO', label: 'Bonificação em ativos' }, { value: 'DESDOBRAMENTO', label: 'Desdobramento' }
      ] })}
      ${field('quantity', 'Quantidade', '', { type: 'number', min: 0, step: '0.00000001', placeholder: 'Ex.: 3' })}
      ${field('unitPrice', 'Preço por unidade', selected.currentPrice ? CP.moneyInput(selected.currentPrice) : '', { currency: true, help: `Preço na moeda do ativo (${selected.currency || 'BRL'}).` })}
      ${field('exchangeRate', 'Câmbio usado', CP.moneyInput(selected.exchangeRate || 1), { currency: true, help: 'Para ativos em reais, mantenha 1,00.' })}
      ${field('fees', 'Taxas e custos', CP.moneyInput(0), { currency: true, required: false })}
      ${field('date', 'Data da operação', CP.today(), { date: true })}
      ${field('bankAccountId', 'Movimentar conta', '', { select: [{ value: '', label: 'Não movimentar nenhuma conta' }, ...CP.accountOptions()], required: false })}
      ${field('description', 'Descrição', '', { full: true, required: false, placeholder: 'Ex.: aporte mensal pela corretora' })}
      <div class="field full"><span class="field-help">Ao escolher uma conta, compras reduzem o saldo e vendas devolvem o dinheiro automaticamente.</span></div>
      ${formFooter('Registrar operação')}
    </form>`, 'Nova transação', 'COMPRA, VENDA OU APORTE');
  };

  const openMarketSettings = () => {
    const settings = db().settings || {};
    openModal(`<form id="marketDataForm" class="form-grid">
      ${field('brapi_token', 'Token gratuito da Brapi', settings.brapi_token || '', { type: 'password', full: true, required: false, placeholder: 'Cole o token obtido em brapi.dev', help: 'Necessário para consultar todos os ativos da B3, Tesouro e proventos.' })}
      ${field('quote_refresh_minutes', 'Intervalo entre atualizações (minutos)', settings.quote_refresh_minutes || 30, { type: 'number', min: 5, max: 1440 })}
      <div class="field full api-coverage-note"><strong>Fontes utilizadas</strong><span>Brapi: B3, Tesouro e indicadores · CoinGecko: cripto · Yahoo: contingência e exterior. As fontes gratuitas podem ter atraso e limites de uso.</span></div>
      ${formFooter('Salvar fontes')}
    </form>`, 'Cotações automáticas', 'FONTES DE DADOS');
  };

  const openCategoryForm = type => {
    openModal(`<form id="categoryForm" data-type="${type}" class="form-grid">
      ${field('name', 'Nome da categoria', '', { full: true, placeholder: 'Digite um nome claro' })}
      ${formFooter('Adicionar categoria')}
    </form>`, 'Nova categoria', 'PERSONALIZAÇÃO');
  };

  const openTopUpForm = id => {
    const card = CP.cardById(id);
    if (!card) return;
    openModal(`<div class="summary-card" style="margin-bottom:16px">
        <span class="metric-icon" style="--metric-color:var(--success);--metric-soft:var(--success-soft)">✦</span>
        <div><small>Saldo atual em ${esc(card.name)}</small><strong>${money(card.benefitBalance)}</strong></div>
      </div>
      <form id="entityForm" data-form="topup" data-id="${id}" class="form-grid">
        ${field('amount', 'Valor da recarga', '', { currency: true, full: true })}
        ${formFooter('Recarregar')}
      </form>`, 'Recarregar benefício', 'VALE');
  };

  const openBudgetEditor = () => {
    const budgets = db().budgets || {};
    const categories = [...new Set([
      ...(db().categories?.variableExpense || []).map(c => c.name),
      ...Object.keys(budgets)
    ])].filter(Boolean);

    openModal(`<form id="budgetForm" class="form-grid">
      ${categories.length ? categories.map(category => `
        <div class="field"><label>${esc(category)}</label><div class="currency-field">
          <input name="budget_${esc(category)}" data-budget="${esc(category)}" data-currency
            value="${budgets[category] ? CP.moneyInput(budgets[category]) : ''}" placeholder="0,00"></div></div>`).join('')
        : '<p style="color:var(--muted)">Cadastre categorias de saída nas Configurações primeiro.</p>'}
      <div class="field full"><span class="field-help">Deixe em branco para não acompanhar uma categoria.</span></div>
      ${formFooter('Salvar metas')}
    </form>`, 'Orçamento por categoria', 'METAS MENSAIS', '620px');
    CP.initCurrency($('#budgetForm'));
  };

  const openGenerateForm = (kind = 'fixed') => {
    const isFixed = kind === 'fixed';
    openModal(`<form id="generateForm" data-kind="${kind}" class="form-grid">
      ${field('referenceMonth', 'Mês de referência', CP.currentRef(), { type: 'month', full: true })}
      <div class="field full"><span class="field-help">
        ${isFixed
          ? 'Cria as contas do mês para cada despesa fixa ativa. Rodar duas vezes no mesmo mês não duplica nada.'
          : 'Lança as receitas recorrentes ativas neste mês.'}</span></div>
      ${formFooter(isFixed ? 'Gerar despesas' : 'Lançar receitas')}
    </form>`, isFixed ? 'Gerar despesas do mês' : 'Lançar receitas do mês', 'COMPROMISSOS');
  };

  // =========================================================================
  // Modais de leitura: extrato, fatura, anexos
  // =========================================================================

  const openMovements = async id => {
    CP.showLoading();
    try {
      const account = CP.accountById(id);
      const movements = await api.accounts.movements(id, 60);
      openModal(`<div class="summary-card" style="margin-bottom:15px">
          <span class="metric-icon">◇</span>
          <div><small>Saldo calculado de ${esc(account?.name || '')}</small><strong>${money(account?.currentBalance || 0)}</strong></div>
        </div>
        ${movements.length ? `<div class="table-wrap"><table class="data-table">
          <thead><tr><th>Movimentação</th><th>Tipo</th><th>Data</th><th>Valor</th></tr></thead>
          <tbody>${movements.map(item => `<tr>
            <td><div class="cell-main">
              <span class="cell-icon" style="--icon-color:${item.signedAmount >= 0 ? 'var(--success)' : 'var(--danger)'};--icon-soft:${item.signedAmount >= 0 ? 'var(--success-soft)' : 'var(--danger-soft)'}">${item.signedAmount >= 0 ? '↗' : '↘'}</span>
              <span><strong>${esc(item.description || item.source || 'Movimentação')}</strong><small>${esc(item.category || '')}</small></span>
            </div></td>
            <td>${badge(item.movementLabel)}</td>
            <td>${CP.date(item.date)}</td>
            <td class="${item.signedAmount >= 0 ? 'money-positive' : 'money-negative'}">
              ${item.signedAmount >= 0 ? '+' : '−'} ${money(Math.abs(item.signedAmount))}</td>
          </tr>`).join('')}</tbody></table></div>`
          : emptyState('Sem movimentações', 'Esta conta ainda não tem lançamentos.')}`,
        `Extrato · ${account?.name || ''}`, 'MOVIMENTAÇÕES DA CONTA', '860px');
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      CP.hideLoading();
    }
  };

  const openInvoiceDetails = async (cardId, referenceMonth) => {
    CP.showLoading();
    try {
      const { card, invoice, dueDate, total, installments } = await api.invoices.details(cardId, referenceMonth);
      openModal(`<div class="summary-card" style="margin-bottom:17px">
          <span class="metric-icon" style="--metric-color:var(--warning);--metric-soft:var(--warning-soft)">▰</span>
          <div><small>${esc(card.name)} · ${CP.monthLabel(referenceMonth)} · vence ${CP.date(dueDate)}</small>
            <strong>${money(total)}</strong><small>${installments.length} parcela(s) nesta fatura</small></div>
        </div>
        ${installments.length ? `<div class="table-wrap"><table class="data-table">
          <thead><tr><th>Compra</th><th>Data</th><th>Parcela</th><th>Status</th><th>Valor</th></tr></thead>
          <tbody>${installments.map(item => `<tr>
            <td><div class="cell-main">
              <span class="cell-icon" style="--icon-color:${card.color};--icon-soft:${card.color}22">▰</span>
              <span><strong>${esc(item.purchaseDescription || 'Compra no cartão')}</strong><small>${esc(item.purchaseCategory || '')}</small></span>
            </div></td>
            <td>${CP.date(item.purchaseDate)}</td>
            <td><strong>${item.installmentNumber}/${item.installmentsTotal}</strong></td>
            <td>${badge(item.status, item.status === 'PAGA' ? 'success' : 'warning')}</td>
            <td><strong>${money(item.amount)}</strong></td>
          </tr>`).join('')}</tbody></table></div>`
          : emptyState('Fatura sem parcelas', 'Não há compras vinculadas a esta referência.', 'Lançar compra', 'add-purchase')}
        <div class="form-footer field full" style="margin-top:16px">
          <button type="button" class="button ghost" data-close-modal>Fechar</button>
          ${invoice.id && invoice.status === 'ABERTA'
            ? `<button type="button" class="button primary" data-action="pay-invoice" data-id="${invoice.id}">Paguei esta fatura</button>` : ''}
        </div>`, 'Detalhes da fatura', 'FATURA DO CARTÃO', '900px');
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      CP.hideLoading();
    }
  };

  const openInvoicePayment = id => {
    const invoice = (db().cardInvoices || []).find(i => i.id === id);
    if (!invoice) return toast('Fatura não encontrada.', 'error');
    if (!CP.activeAccounts().length) return toast('Cadastre uma conta bancária para pagar a fatura.', 'error');

    openModal(`<div class="summary-card" style="margin-bottom:17px">
        <span class="metric-icon" style="--metric-color:var(--warning);--metric-soft:var(--warning-soft)">▰</span>
        <div><small>Fatura ${esc(invoice.cardName)} · ${CP.monthLabel(invoice.referenceMonth)}</small>
          <strong>${money(invoice.totalAmount)}</strong></div>
      </div>
      <form id="entityForm" data-form="invoice" data-id="${id}" class="form-grid">
        <div class="field full"><label>Conta usada no pagamento</label>
          ${select('bankAccountId', CP.accountOptions(), CP.activeAccounts()[0]?.id)}</div>
        <div class="field full"><span class="field-help">
          O valor é descontado do saldo da conta. Todas as parcelas desta fatura são marcadas como pagas.</span></div>
        ${formFooter('Confirmar pagamento')}
      </form>`, 'Pagar fatura', 'CONFIRMAÇÃO');
  };

  const openAttachments = async (type, id) => {
    CP.showLoading();
    try {
      const items = await api.attachments.list(type, id);
      openModal(`<div class="attachment-list">${items.length ? items.map(item => `
          <div class="attachment-row">
            <span>📎</span>
            <strong>${esc(item.fileName)}</strong>
            <small>${(item.sizeBytes / 1024).toFixed(0)} KB</small>
            <button class="button small ghost" data-action="open-attachment" data-path="${esc(item.absolutePath)}">Abrir</button>
            <button class="button danger small icon-only" data-action="delete-attachment" data-id="${item.id}"
              data-type="${type}" data-entity="${id}" aria-label="Excluir">×</button>
          </div>`).join('')
          : '<p class="empty-hint">Nenhum comprovante anexado ainda.</p>'}
        </div>
        <div class="form-footer field full" style="margin-top:16px">
          <button type="button" class="button ghost" data-close-modal>Fechar</button>
          <button type="button" class="button primary" data-action="add-attachment" data-type="${type}" data-entity="${id}">＋ Anexar arquivo</button>
        </div>`, 'Comprovantes', 'ANEXOS', '560px');
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      CP.hideLoading();
    }
  };

  const openQuickAdd = () => {
    openModal(`<form id="quickNaturalForm" class="quick-nl">
        <span class="quick-nl-icon">⌁</span>
        <input name="text" placeholder='Ex.: "mercado 84,90 débito" ou "recebi 3200 salário"' autocomplete="off" spellcheck="false">
        <button class="button primary" type="submit">Adicionar</button>
      </form>
      <div class="quick-nl-hint">Escreva como falaria. O app entende valor, categoria e forma de pagamento.</div>
      <div class="quick-or"><span>ou escolha um tipo</span></div>
      <div class="entity-grid" style="grid-template-columns:repeat(2,minmax(0,1fr))">
        ${quickTile('add-income', 'Receita', 'Nova entrada', '↗', 'success')}
        ${quickTile('add-expense', 'Gasto', 'Nova saída', '↘', 'danger')}
        ${quickTile('add-purchase', 'Crédito', 'Compra no cartão', '▰', 'warning')}
        ${quickTile('add-transfer', 'Entre contas', 'Transferência', '⇄', 'blue')}
        ${quickTile('add-operation', 'Patrimônio', 'Compra ou aporte', '⌁', 'blue')}
        ${quickTile('add-goal', 'Objetivo', 'Nova meta', '🎯', 'primary')}
      </div>`, 'O que deseja adicionar?', 'ATALHO RÁPIDO', '620px');
  };

  const quickTile = (action, label, title, icon, color) => `
    <button class="entity-card" data-action="${action}" style="cursor:pointer;text-align:left">
      <span class="metric-icon" style="--metric-color:var(--${color === 'primary' ? 'primary' : color});--metric-soft:var(--${color === 'primary' ? 'primary' : color}-soft)">${icon}</span>
      <div class="entity-balance"><small>${label}</small><strong style="font-size:15px">${title}</strong></div>
    </button>`;

  // =========================================================================
  // Simulador, retrospectiva e importação de extrato
  // =========================================================================

  const openSimulator = () => {
    const categories = (db().dashboard?.expensesByCategory || []).slice(0, 5);
    if (!categories.length) return toast('Sem gastos no período para simular.', 'error');
    const baseTotal = CP.sum(categories, c => c.value);

    openModal(`<div class="sim-summary">
        <div><small>Gasto atual</small><strong>${money(baseTotal)}</strong></div>
        <div><small>Após os cortes</small><strong id="simAfter" class="money-positive">${money(baseTotal)}</strong></div>
        <div><small>Economia/mês</small><strong id="simDelta" style="color:var(--primary)">${money(0)}</strong></div>
      </div>
      <div class="sim-list">${categories.map(item => `
        <div class="sim-row">
          <div class="sim-top"><span>${esc(item.name)}</span><strong>${money(item.value)}</strong></div>
          <input type="range" min="0" max="100" value="0" data-sim="${esc(item.name)}" data-amount="${item.value}">
          <div class="sim-cut"><span class="sim-pct">0%</span><span class="sim-save">economiza ${money(0)}</span></div>
        </div>`).join('')}</div>
      <p class="sim-note" id="simNote">Arraste para simular cortes e veja o impacto no seu ano.</p>`,
      'Simulador "e se"', 'PLANEJAMENTO', '620px');

    const recompute = () => {
      let saved = 0;
      $$('[data-sim]', $('#modalBody')).forEach(slider => {
        const amount = Number(slider.dataset.amount) * (Number(slider.value) / 100);
        saved += amount;
        const row = slider.closest('.sim-row');
        $('.sim-pct', row).textContent = `${slider.value}%`;
        $('.sim-save', row).textContent = `economiza ${money(amount)}`;
      });
      $('#simAfter').textContent = money(baseTotal - saved);
      $('#simDelta').textContent = money(saved);
      $('#simNote').innerHTML = saved > 0
        ? `Cortando <strong>${money(saved)}/mês</strong>, você guardaria <strong>${money(saved * 12)}</strong> em um ano.`
        : 'Arraste para simular cortes e veja o impacto no seu ano.';
    };
    $$('[data-sim]', $('#modalBody')).forEach(slider => slider.addEventListener('input', recompute));
  };

  const openRetro = () => {
    const data = db().dashboard;
    if (!data) return;
    const month = state.filters.month === 'all' ? new Date().getMonth() + 1 : Number(state.filters.month);
    const top = data.topExpenseCategories[0];
    const hitGoal = data.leftover >= data.monthlyGoal && data.monthlyGoal > 0;

    const slides = [
      { bg: 'linear-gradient(135deg,#8b5cf6,#4ea8ff)', emoji: '📅', title: `Retrospectiva de ${CP.MONTHS_FULL[month - 1]}`, value: '', sub: 'Use as setas para navegar →' },
      { bg: 'linear-gradient(135deg,#2ee59d,#4ea8ff)', emoji: '💰', title: 'Você economizou', value: money(data.leftover), sub: hitGoal ? 'Meta batida! 🎉' : `Meta: ${money(data.monthlyGoal)}`, confetti: hitGoal },
      { bg: 'linear-gradient(135deg,#ffbf47,#ff5f6d)', emoji: '🛒', title: 'Onde você mais gastou', value: top ? top.name : '—', sub: top ? money(top.value) : 'Sem gastos no período' },
      { bg: 'linear-gradient(135deg,#d7ff37,#2ee59d)', emoji: '📈', title: 'Entradas', value: money(data.totalIncome), sub: `${data.counts.incomes} lançamento(s)` },
      { bg: 'linear-gradient(135deg,#4ea8ff,#8b5cf6)', emoji: '❤️', title: 'Saúde financeira', value: `${data.intelligence.health.score}/100`, sub: data.intelligence.health.label }
    ];

    let index = 0;
    let timer;
    const overlay = document.createElement('div');
    overlay.className = 'retro-overlay';
    overlay.innerHTML = `<div class="retro-bars">${slides.map((_, i) => `<i data-b="${i}"></i>`).join('')}</div>
      <button class="retro-close" aria-label="Fechar">×</button>
      <div class="retro-stage"></div>
      <button class="retro-nav prev" aria-label="Anterior">‹</button>
      <button class="retro-nav next" aria-label="Próximo">›</button>
      <canvas class="retro-confetti"></canvas>`;
    document.body.append(overlay);

    const stage = $('.retro-stage', overlay);
    const show = position => {
      index = (position + slides.length) % slides.length;
      const slide = slides[index];
      stage.style.background = slide.bg;
      stage.innerHTML = `<div class="retro-card"><span class="retro-emoji">${slide.emoji}</span>
        <h2>${esc(slide.title)}</h2>${slide.value ? `<strong>${esc(slide.value)}</strong>` : ''}
        <p>${esc(slide.sub)}</p></div>`;
      $$('.retro-bars i', overlay).forEach((bar, position2) => bar.classList.toggle('active', position2 <= index));
      if (slide.confetti) burstConfetti($('.retro-confetti', overlay));
      clearTimeout(timer);
      timer = setTimeout(() => show(index + 1), 4600);
    };
    const close = () => { clearTimeout(timer); overlay.remove(); state.retroClose = null; };
    state.retroClose = close;

    $('.retro-close', overlay).addEventListener('click', close);
    $('.retro-nav.next', overlay).addEventListener('click', () => show(index + 1));
    $('.retro-nav.prev', overlay).addEventListener('click', () => show(index - 1));
    overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
    show(0);
  };

  const burstConfetti = canvas => {
    if (!canvas) return;
    const context = canvas.getContext('2d');
    const width = canvas.width = canvas.offsetWidth;
    const height = canvas.height = canvas.offsetHeight;
    const colors = ['#d7ff37', '#2ee59d', '#4ea8ff', '#8b5cf6', '#ffbf47', '#ff5f6d'];
    const particles = Array.from({ length: 130 }, () => ({
      x: width / 2, y: height / 3,
      vx: (Math.random() - 0.5) * 13, vy: Math.random() * -13 - 4,
      color: colors[Math.floor(Math.random() * colors.length)],
      size: Math.random() * 6 + 3, alpha: 1
    }));
    let frame = 0;
    const animate = () => {
      context.clearRect(0, 0, width, height);
      for (const particle of particles) {
        particle.vy += 0.35;
        particle.x += particle.vx;
        particle.y += particle.vy;
        particle.alpha -= 0.008;
        context.globalAlpha = Math.max(0, particle.alpha);
        context.fillStyle = particle.color;
        context.fillRect(particle.x, particle.y, particle.size, particle.size);
      }
      if (++frame < 150) requestAnimationFrame(animate);
    };
    animate();
  };

  // =========================================================================
  // Envio de formulários
  // =========================================================================

  const validate = (form, data) => {
    const empty = $$('input[required], textarea[required]', form)
      .filter(input => !input.closest('[hidden]'))
      .find(input => !String(input.value).trim());
    if (empty) {
      (empty.type === 'hidden' ? empty.closest('.date-field')?.querySelector('button') : empty)?.focus();
      toast('Preencha todos os campos obrigatórios.', 'error');
      return false;
    }
    if ('amount' in data && Number(data.amount) <= 0 && form.dataset.form !== 'goalDeposit') {
      toast('Informe um valor maior que zero.', 'error');
      return false;
    }
    return true;
  };

  const SUBMIT_HANDLERS = {
    ...CP.GOAL_FORMS,

    income: (id, data) => id
      ? mutate(() => api.incomes.update(id, data), 'Entrada atualizada.')
      : mutate(() => api.incomes.create(data), 'Entrada adicionada.'),

    expense: (id, data) => {
      const credit = data.paymentMethod === 'CARTAO_CREDITO';
      const benefit = data.paymentMethod === 'VALE_BENEFICIO';
      const payload = {
        ...data,
        status: credit ? 'PENDENTE' : benefit ? 'PAGO' : data.status,
        bankAccountId: credit || benefit ? '' : data.bankAccountId,
        creditCardId: credit ? data.creditCardId : benefit ? data.benefitCardId : ''
      };
      if (id) {
        // Trocou a categoria de um lançamento existente? Isso vira regra.
        const previous = db().expenses.find(item => item.id === id);
        if (previous && previous.category !== payload.category) {
          CP.learnFromCorrection(payload.description, payload.category, 'variableExpense');
        }
        return mutate(() => api.expenses.update(id, payload), 'Saída atualizada.');
      }
      return mutate(() => api.expenses.create(payload), 'Saída adicionada.');
    },

    fixed: (id, data) => {
      const payload = { ...data,
        defaultCreditCardId: ['CARTAO_CREDITO', 'VALE_BENEFICIO'].includes(data.defaultPaymentMethod) ? data.defaultCreditCardId : '' };
      return id
        ? mutate(() => api.fixedExpenses.update(id, payload), 'Compromisso atualizado.')
        : mutate(() => api.fixedExpenses.create(payload), 'Despesa fixa cadastrada.');
    },

    recurring: (id, data) => id
      ? mutate(() => api.recurringIncomes.update(id, data), 'Receita atualizada.')
      : mutate(() => api.recurringIncomes.create(data), 'Receita recorrente cadastrada.'),

    account: (id, data) => id
      ? mutate(() => api.accounts.update(id, data), 'Conta atualizada.')
      : mutate(() => api.accounts.create(data), 'Conta cadastrada.'),

    card: (id, data) => id
      ? mutate(() => api.cards.update(id, data), 'Cartão atualizado.')
      : mutate(() => api.cards.create(data), 'Cartão cadastrado.'),

    purchase: (id, data) => {
      const card = CP.cardById(data.creditCardId);
      const benefit = CP.isBenefit(card);
      return mutate(() => api.expenses.create({
        description: data.description, category: data.category,
        paymentMethod: benefit ? 'VALE_BENEFICIO' : 'CARTAO_CREDITO',
        creditCardId: data.creditCardId, amount: data.amount, date: data.date,
        installments: benefit ? 1 : Number(data.installments || 1), notes: data.notes
      }), benefit
        ? `Compra descontada do saldo do ${card.name}.`
        : `${data.installments} parcela(s) distribuída(s) nas faturas.`);
    },

    transfer: (id, data) => id
      ? mutate(() => api.transfers.update(id, data), 'Transferência atualizada.')
      : mutate(() => api.transfers.create(data), 'Transferência registrada.'),

    investment: (id, data) => id
      ? mutate(() => api.investments.update(id, data), 'Investimento atualizado.')
      : mutate(() => api.investments.create(data), 'Investimento cadastrado.'),

    investmentOperation: (id, data) => {
      const balance = CP.accountById(data.bankAccountId)?.currentBalance || 0;
      const total = Number(data.quantity || 0) * Number(data.unitPrice || 0) * Number(data.exchangeRate || 1) + Number(data.fees || 0);
      const spends = ['COMPRA', 'APORTE'].includes(data.operationType) && data.bankAccountId;
      const commit = () => mutate(() => api.investmentOperations.create(data), 'Operação registrada e carteira recalculada.');
      if (spends && balance < total) {
        confirmAction(
          `A conta tem ${money(balance)} e a operação movimenta aproximadamente ${money(total)}. Deseja continuar e deixar o saldo negativo?`,
          commit, 'Saldo insuficiente', 'Continuar mesmo assim');
        return null;
      }
      return commit();
    },

    topup: (id, data) => mutate(() => api.cards.topUp(id, data.amount), 'Benefício recarregado.'),

    invoice: (id, data) => {
      const invoice = (db().cardInvoices || []).find(i => i.id === id);
      const balance = CP.accountById(data.bankAccountId)?.currentBalance || 0;
      const commit = () => mutate(() => api.invoices.pay(id, data.bankAccountId), 'Fatura paga e saldo atualizado.');
      if (balance < Number(invoice?.totalAmount || 0)) {
        confirmAction(
          `A conta tem ${money(balance)} e a fatura é de ${money(invoice.totalAmount)}. Pagar mesmo assim?`,
          commit, 'Saldo insuficiente', 'Pagar mesmo assim');
        return null;
      }
      return commit();
    }
  };

  const handleSubmit = async event => {
    event.preventDefault();
    const form = event.target;

    if (form.id === 'entityForm') {
      const data = formData(form);
      if (!validate(form, data)) return;
      return SUBMIT_HANDLERS[form.dataset.form]?.(form.dataset.id || null, data, form);
    }

    if (form.id === 'profileForm') {
      return mutate(() => api.profile.save(formData(form)), 'Perfil atualizado.');
    }

    if (form.id === 'notificationForm') {
      const data = formData(form);
      return mutate(() => api.settings.setMany({ notifications_days: Number(data.notifications_days) }), 'Avisos atualizados.');
    }

    if (form.id === 'backupForm') {
      const data = formData(form);
      return mutate(() => api.settings.setMany({
        backup_frequency: data.backup_frequency,
        backup_keep: Number(data.backup_keep)
      }), 'Preferências de backup salvas.');
    }

    if (form.id === 'marketDataForm') {
      const data = formData(form);
      return mutate(() => api.settings.setMany({
        brapi_token: data.brapi_token || '',
        quote_refresh_minutes: Number(data.quote_refresh_minutes) || 30
      }), 'Fontes de cotação atualizadas.');
    }

    if (form.id === 'generateForm') {
      const month = form.referenceMonth.value;
      const isFixed = form.dataset.kind === 'fixed';
      return mutate(async () => {
        const result = isFixed
          ? await api.fixedExpenses.generate(month)
          : await api.recurringIncomes.generate(month);
        state.tab.transactions = isFixed ? 'expenses' : 'incomes';
        return result;
      }, isFixed ? 'Despesas do mês geradas.' : 'Receitas do mês lançadas.');
    }

    if (form.id === 'bulkForm') {
      const data = formData(form);
      const ids = [...state.selection];
      const changes = form.dataset.bulk === 'category'
        ? { category: data.category }
        : { bankAccountId: data.bankAccountId };

      const result = await mutate(() => api.expenses.bulkUpdate(ids, changes), null);
      state.selection.clear();
      CP.render();
      if (result) {
        toast(`${result.updated} lançamento(s) atualizado(s)${
          result.learned ? ` · ${result.learned} regra(s) aprendida(s)` : ''}.`);
      }
      return;
    }

    if (form.id === 'ruleForm') {
      const data = formData(form);
      return mutate(() => api.rules.save(data), 'Regra criada.');
    }

    if (form.id === 'categoryForm') {
      const name = form.name.value.trim();
      if (!name) return toast('Digite o nome da categoria.', 'error');
      return mutate(() => api.categories.create(form.dataset.type, name), 'Categoria adicionada.');
    }

    if (form.id === 'suggestBudgetForm') {
      const budgets = { ...(db().budgets || {}) };
      $$('[data-suggest]', form).forEach(input => {
        if (input.checked) budgets[input.dataset.suggest] = Number(input.value);
      });
      return mutate(() => api.budgets.save(budgets), 'Orçamento atualizado com base no seu histórico.');
    }

    if (form.id === 'budgetForm') {
      const budgets = {};
      $$('[data-budget]', form).forEach(input => {
        const value = CP.parseMoney(input.value);
        if (value > 0) budgets[input.dataset.budget] = value;
      });
      return mutate(() => api.budgets.save(budgets), 'Metas de orçamento salvas.');
    }

    if (form.id === 'quickNaturalForm') {
      const text = form.text.value.trim();
      if (!text) return toast('Escreva algo como "mercado 84,90 débito".', 'error');
      return submitNaturalEntry(text);
    }
  };

  const submitNaturalEntry = async text => {
    CP.showLoading();
    let parsed;
    try {
      parsed = await api.entries.parse(text);
    } finally {
      CP.hideLoading();
    }
    if (!parsed || !(parsed.amount > 0)) {
      return toast('Não entendi o valor. Tente algo como "mercado 84,90 débito".', 'error');
    }

    const account = CP.activeAccounts()[0]?.id;
    if (!account) return toast('Cadastre uma conta bancária primeiro.', 'error');

    if (parsed.isIncome) {
      return mutate(() => api.incomes.create({
        source: parsed.description,
        category: parsed.category || db().categories.income[0]?.name || 'Outros',
        bankAccountId: account, amount: parsed.amount, date: parsed.date, description: ''
      }), `Entrada de ${money(parsed.amount)} adicionada.`);
    }

    const credit = parsed.paymentMethod === 'CARTAO_CREDITO';
    const benefit = parsed.paymentMethod === 'VALE_BENEFICIO';
    const card = credit ? CP.activeCards('credit')[0] : benefit ? CP.activeCards('benefit')[0] : null;
    if ((credit || benefit) && !card) {
      return toast(`Cadastre um ${credit ? 'cartão de crédito' : 'vale'} para lançar assim.`, 'error');
    }

    return mutate(() => api.expenses.create({
      description: parsed.description,
      category: parsed.category || db().categories.variableExpense[0]?.name || 'Outros',
      paymentMethod: parsed.paymentMethod,
      bankAccountId: credit || benefit ? '' : account,
      creditCardId: card?.id || '',
      amount: parsed.amount, date: parsed.date,
      installments: parsed.installments || 1,
      status: credit ? 'PENDENTE' : 'PAGO'
    }), `Saída de ${money(parsed.amount)} adicionada${parsed.category ? ` em ${parsed.category}` : ''}.`);
  };

  // =========================================================================
  // Ações
  // =========================================================================

  const toggleSetting = async (key, current) => {
    await api.settings.set(key, String(!current), 'boolean');
    await CP.reload();
    CP.render();
  };

  // As ações e os formulários das metas moram em goals.js, junto da tela que
  // os usa; aqui eles só entram no mesmo despachante das demais.
  const ACTIONS = {
    ...CP.GOAL_ACTIONS,
    // Criação e edição
    'quick-add': openQuickAdd,
    'add-income': () => openIncomeForm(),
    'edit-income': element => openIncomeForm(element.dataset.id),
    'add-expense': () => openExpenseForm(),
    'edit-expense': element => openExpenseForm(element.dataset.id),
    'add-fixed': () => openFixedForm(),
    'edit-fixed': element => openFixedForm(element.dataset.id),
    'add-recurring': () => openRecurringForm(),
    'edit-recurring': element => openRecurringForm(element.dataset.id),
    'add-account': () => openAccountForm(),
    'edit-account': element => openAccountForm(element.dataset.id),
    'add-card': () => openCardForm(),
    'edit-card': element => openCardForm(element.dataset.id),
    'add-purchase': openPurchaseForm,
    'add-transfer': () => openTransferForm(),
    'edit-transfer': element => openTransferForm(element.dataset.id),
    'add-investment': () => openInvestmentForm(),
    'edit-investment': element => openInvestmentForm(element.dataset.id),
    'add-operation': element => openOperationForm(element.dataset.investment),
    'market-settings': openMarketSettings,
    'refresh-market': () => mutate(async () => {
      const result = await api.marketData.refresh();
      if (result.failures?.length && !result.updated?.length) {
        throw new Error(result.message);
      }
      return result;
    }, 'Cotações e proventos atualizados.'),
    'add-category': element => openCategoryForm(element.dataset.type),
    'topup-card': element => openTopUpForm(element.dataset.id),
    'edit-budgets': openBudgetEditor,
    'generate-fixed': () => openGenerateForm('fixed'),
    'generate-recurring': () => openGenerateForm('recurring'),

    // Exclusões e alternâncias
    'delete-income': element => confirmAction(
      'A entrada será removida e o saldo da conta recalculado.',
      () => mutate(() => api.incomes.remove(element.dataset.id), 'Entrada excluída.'), 'Excluir entrada'),
    'delete-expense': element => confirmAction(
      'A saída será excluída. Se for uma compra parcelada, as parcelas e a fatura são recalculadas.',
      () => mutate(() => api.expenses.remove(element.dataset.id), 'Saída excluída.'), 'Excluir saída'),
    'delete-transfer': element => confirmAction(
      'A transferência será removida e os saldos das duas contas recalculados.',
      () => mutate(() => api.transfers.remove(element.dataset.id), 'Transferência excluída.'), 'Excluir transferência'),
    'delete-fixed': element => confirmAction(
      'O compromisso será removido. As despesas já geradas continuam no histórico.',
      () => mutate(() => api.fixedExpenses.remove(element.dataset.id), 'Compromisso excluído.'), 'Excluir compromisso'),
    'delete-recurring': element => confirmAction(
      'A receita recorrente será removida. As entradas já lançadas continuam no histórico.',
      () => mutate(() => api.recurringIncomes.remove(element.dataset.id), 'Receita excluída.'), 'Excluir receita'),
    'delete-operation': element => confirmAction(
      'A transação e o movimento bancário vinculado serão removidos. Quantidade, preço médio e saldo serão recalculados.',
      () => mutate(() => api.investmentOperations.remove(element.dataset.id), 'Transação excluída.'), 'Excluir transação'),
    'delete-category': element => confirmAction(
      'A categoria sai das opções futuras. Os lançamentos antigos continuam intactos.',
      () => mutate(() => api.categories.remove(element.dataset.type, element.dataset.id), 'Categoria removida.'), 'Excluir categoria'),

    'toggle-fixed': element => mutate(() => api.fixedExpenses.toggle(element.dataset.id), 'Status atualizado.'),
    'toggle-recurring': element => mutate(() => api.recurringIncomes.toggle(element.dataset.id), 'Status atualizado.'),
    'toggle-account': element => mutate(() => api.accounts.toggle(element.dataset.id), 'Status atualizado.'),
    'toggle-card': element => mutate(() => api.cards.toggle(element.dataset.id), 'Status atualizado.'),
    'toggle-investment': element => mutate(() => api.investments.toggle(element.dataset.id), 'Status atualizado.'),

    // Pagamentos
    'pay-expense': element => mutate(() => api.expenses.markPaid(element.dataset.id), 'Marcada como paga.'),
    'pay-invoice': element => openInvoicePayment(element.dataset.id),
    'view-invoice': element => openInvoiceDetails(element.dataset.card, element.dataset.reference),
    'recalculate-invoices': () => confirmAction(
      'As parcelas em aberto serão redistribuídas nas faturas certas, usando o dia de fechamento atual de cada cartão. Parcelas já pagas não se movem.',
      () => mutate(() => api.invoices.recalculate(), 'Faturas recalculadas.'), 'Recalcular faturas', 'Recalcular'),
    'account-movements': element => openMovements(element.dataset.id),

    // Seleção em massa
    'pay-selected': () => {
      const ids = [...state.selection];
      confirmAction(`${ids.length} saída(s) serão marcadas como pagas e os saldos recalculados.`, async () => {
        const result = await mutate(() => api.expenses.markManyPaid(ids), null);
        state.selection.clear();
        CP.render();
        if (result) {
          toast(result.errors.length
            ? `${result.paid} paga(s). ${result.errors.length} falharam.`
            : `${result.paid} saída(s) marcadas como pagas.`, result.errors.length ? 'warning' : 'success');
        }
      }, 'Marcar como pagas', 'Confirmar');
    },
    'clear-selection': () => { state.selection.clear(); CP.render(); },

    'bulk-category': () => {
      const ids = [...state.selection];
      openModal(`<form id="bulkForm" data-bulk="category" class="form-grid">
        <div class="field full"><span class="field-help">
          ${ids.length} lançamento(s) serão movidos para a categoria escolhida.
          O app também aprende a associação, então os próximos vêm certos sozinhos.</span></div>
        ${field('category', 'Nova categoria', db().categories?.variableExpense?.[0]?.name,
          { select: CP.categoryOptions('variableExpense'), full: true })}
        ${formFooter(`Aplicar a ${ids.length}`)}
      </form>`, 'Categorizar em lote', `${ids.length} SELECIONADOS`);
    },

    'bulk-account': () => {
      const ids = [...state.selection];
      if (!CP.activeAccounts().length) return toast('Cadastre uma conta bancária primeiro.', 'error');
      openModal(`<form id="bulkForm" data-bulk="account" class="form-grid">
        <div class="field full"><span class="field-help">
          Só afeta lançamentos pagos em conta (PIX, débito ou dinheiro).
          Compras no cartão e no vale não têm conta bancária.</span></div>
        ${field('bankAccountId', 'Nova conta', CP.activeAccounts()[0]?.id, { select: CP.accountOptions(), full: true })}
        ${formFooter(`Aplicar a ${ids.length}`)}
      </form>`, 'Trocar a conta', `${ids.length} SELECIONADOS`);
    },

    'bulk-delete': () => {
      const ids = [...state.selection];
      confirmAction(
        `${ids.length} lançamento(s) serão excluídos. Compras parceladas levam junto as parcelas e as faturas são recalculadas.`,
        async () => {
          const result = await mutate(() => api.expenses.bulkDelete(ids), null);
          state.selection.clear();
          CP.render();
          if (result) {
            toast(result.errors.length
              ? `${result.deleted} excluído(s). ${result.errors.length} falharam.`
              : `${result.deleted} lançamento(s) excluído(s).`, result.errors.length ? 'warning' : 'success');
          }
        }, 'Excluir em lote', 'Excluir');
    },

    // Anexos
    'attach': element => openAttachments(element.dataset.type, element.dataset.id),
    'add-attachment': async element => {
      const file = await api.dialog.openFile({
        filters: [{ name: 'Comprovantes', extensions: ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'heic'] }],
        readContent: false
      });
      if (!file) return;
      try {
        await api.attachments.add(element.dataset.type, element.dataset.entity, file.path);
        await CP.reload();
        openAttachments(element.dataset.type, element.dataset.entity);
        toast('Comprovante anexado.');
      } catch (error) { toast(error.message, 'error'); }
    },
    'delete-attachment': async element => {
      await api.attachments.remove(element.dataset.id);
      await CP.reload();
      openAttachments(element.dataset.type, element.dataset.entity);
      toast('Anexo removido.');
    },
    'open-attachment': element => api.shell.openPath(element.dataset.path),

    // Preferências
    'toggle-theme': () => CP.toggleTheme(),
    'toggle-density': async () => {
      const next = db().settings?.density === 'compact' ? 'comfortable' : 'compact';
      await api.settings.set('density', next, 'text');
      await CP.reload();
      CP.applyPreferences();
      CP.render();
      toast(`Modo ${next === 'compact' ? 'compacto' : 'confortável'} ativado.`);
    },
    'toggle-section': async element => {
      const hidden = db().settings?.hidden_sections || [];
      const section = element.dataset.section;
      const next = hidden.includes(section) ? hidden.filter(item => item !== section) : [...hidden, section];
      await api.settings.set('hidden_sections', next, 'json');
      await CP.reload();
      CP.render();
    },
    'toggle-notifications': () => toggleSetting('notifications_enabled', db().settings?.notifications_enabled !== false),
    'toggle-backup': () => toggleSetting('backup_enabled', db().settings?.backup_enabled !== false),
    'clear-filters': () => {
      state.filters = { ...state.filters, month: 'all', account: 'all', card: 'all', category: 'all' };
      state.search[state.page] = '';
      CP.refreshAndRender();
    },

    // Dados
    'export-json': async () => {
      const json = await api.data.export();
      const path = await api.dialog.saveFile({
        defaultName: `carteira-pessoal-${CP.today()}.json`,
        content: json,
        filters: [{ name: 'Backup JSON', extensions: ['json'] }]
      });
      if (path) toast('Backup exportado. Guarde esse arquivo em local seguro.');
    },
    'import-json': async () => {
      const file = await api.dialog.openFile({ filters: [{ name: 'Backup JSON', extensions: ['json'] }] });
      if (!file) return;
      confirmAction(
        `Os dados atuais serão substituídos pelo conteúdo de "${file.name}". O app faz um backup automático antes.`,
        async () => {
          await api.backup.create();
          const result = await mutate(() => api.data.import(file.content), null);
          if (result) {
            const summary = Object.entries(result.counts).filter(([, value]) => value > 0)
              .map(([key, value]) => `${value} ${key}`).join(', ');
            toast(`Importado: ${summary || 'nenhum registro'}.`);
          }
        }, 'Importar backup', 'Importar');
    },
    'export-csv': async () => {
      const csv = await api.reports.csv(state.filters);
      const path = await api.dialog.saveFile({
        defaultName: `carteira-${state.filters.year}${state.filters.month === 'all' ? '' : `-${String(state.filters.month).padStart(2, '0')}`}.csv`,
        content: csv,
        filters: [{ name: 'Planilha CSV', extensions: ['csv'] }]
      });
      if (path) toast('Relatório exportado.');
    },
    'export-pdf': async () => {
      const path = await api.printToPDF();
      if (path) toast('PDF salvo.');
    },
    'clear-transactions': () => confirmAction(
      'Todas as entradas, saídas, aportes, transferências e faturas serão apagadas. Contas, cartões, categorias e metas permanecem.',
      async () => { await api.backup.create(); return mutate(() => api.data.clearTransactions(), 'Lançamentos apagados.'); },
      'Apagar lançamentos', 'Apagar'),
    'reset-data': () => confirmAction(
      'TUDO será apagado e o app volta ao estado inicial, com a tela de boas-vindas. Um backup é feito automaticamente antes.',
      async () => {
        await api.backup.create();
        await api.data.reset();
        location.reload();
      }, 'Apagar tudo', 'Apagar tudo'),

    // Backup
    'backup-now': async () => {
      const result = await api.backup.create();
      state.backups = await api.backup.list();
      CP.render();
      toast(`Backup criado: ${result.name}`);
    },
    'restore-backup': element => confirmAction(
      'Os dados atuais serão substituídos por este backup. Uma cópia do estado atual é guardada antes, por segurança.',
      async () => {
        await api.backup.restore(element.dataset.path);
        location.reload();
      }, 'Restaurar backup', 'Restaurar'),
    'delete-backup': element => confirmAction('Este arquivo de backup será apagado.', async () => {
      await api.backup.remove(element.dataset.path);
      state.backups = await api.backup.list();
      closeModal();
      CP.render();
      toast('Backup removido.');
    }, 'Excluir backup', 'Excluir'),
    'choose-backup-folder': async () => {
      const folder = await api.dialog.openFolder();
      if (!folder) return;
      await api.settings.set('backup_folder', folder, 'text');
      state.backups = await api.backup.list();
      await CP.reload();
      CP.render();
      toast('Pasta de backup atualizada.');
    },
    'open-backup-folder': async () => api.shell.openPath(await api.backup.folder()),
    'open-data-folder': () => api.shell.openPath(state.appInfo?.dataPath),

    'undo-import': element => confirmAction(
      'Todos os lançamentos que vieram daqueles arquivos serão apagados, as faturas que eles fecharam '
      + 'voltam a ficar abertas e os saldos iniciais ajustados na conferência voltam ao que eram. '
      + 'O que você lançou à mão depois não é tocado.',
      async () => {
        const result = await api.import.undo(element.dataset.batch);
        state.importBatches = await api.import.batches(8);
        await CP.reload();
        closeModal();
        CP.render();
        const total = Object.values(result.removed || {}).reduce((acc, value) => acc + value, 0);
        toast(`Importação desfeita — ${total} registro(s) removido(s).`);
      }, 'Desfazer importação', 'Desfazer'),

    // Regras automáticas
    'add-rule': () => CP.openRuleForm(),
    'delete-rule': element => mutate(() => api.rules.remove(element.dataset.id), 'Regra removida.'),
    'apply-rules': async () => {
      const result = await mutate(() => api.rules.apply(), null);
      if (result) {
        toast(result.updated
          ? `${result.updated} lançamento(s) categorizado(s) pelas regras.`
          : 'Nenhum lançamento sem categoria encontrado.');
      }
    },

    // Análises com histórico
    'close-month': () => CP.openMonthClosing(),
    'open-calendar': () => CP.openCalendar(),
    'open-subscriptions': () => CP.openSubscriptions(),
    'suggest-budgets': () => CP.openBudgetSuggestions(),
    'year-comparison': () => CP.openYearComparison(),

    // Ferramentas
    'open-simulator': openSimulator,
    'open-retro': openRetro,
    'command-palette': () => openPalette(),
    'import-statement': () => CP.openImport(),
    'confirm-import': () => {}
  };

  /** Permite que outros módulos disparem uma ação pelo nome. */
  CP.runAction = (name, dataset = {}) => ACTIONS[name]?.({ dataset });

  // =========================================================================
  // Paleta de comandos
  // =========================================================================

  let palette = null;
  let paletteIndex = 0;

  const paletteCommands = () => {
    const commands = [
      ...Object.entries(CP.PAGES).map(([page, meta]) => ({
        label: `Ir para ${meta.title}`, icon: '→', run: () => CP.navigate(page)
      })),
      { label: 'Novo lançamento', icon: '＋', run: openQuickAdd },
      { label: 'Nova entrada', icon: '↗', run: () => openIncomeForm() },
      { label: 'Nova saída', icon: '↘', run: () => openExpenseForm() },
      { label: 'Nova compra no cartão', icon: '▰', run: openPurchaseForm },
      { label: 'Nova transferência entre contas', icon: '⇄', run: () => openTransferForm() },
      { label: 'Compra ou aporte', icon: '⌁', run: () => openOperationForm() },
      { label: 'Nova meta', icon: '🎯', run: () => CP.openGoalForm() },
      { label: 'Gerar despesas fixas do mês', icon: '↻', run: () => openGenerateForm('fixed') },
      { label: 'Lançar receitas recorrentes do mês', icon: '↻', run: () => openGenerateForm('recurring') },
      { label: 'Definir orçamento por categoria', icon: '◎', run: openBudgetEditor },
      { label: 'Sugerir orçamento pelo meu histórico', icon: '◈', run: () => CP.openBudgetSuggestions() },
      { label: 'Comparar com o mesmo mês do ano passado', icon: '⇅', run: () => CP.openYearComparison() },
      { label: 'Simulador "e se"', icon: '◐', run: openSimulator },
      { label: 'Retrospectiva do mês', icon: '✦', run: openRetro },
      { label: 'Fechamento do mês', icon: '✓', run: () => CP.openMonthClosing() },
      { label: 'Calendário e saldo projetado', icon: '▦', run: () => CP.openCalendar() },
      { label: 'Gastos recorrentes e assinaturas', icon: '🔁', run: () => CP.openSubscriptions() },
      { label: 'Importar extratos e faturas', icon: '📄', run: () => CP.openImport() },
      { label: 'Importar extrato (CSV/OFX)', icon: '↑', run: () => ACTIONS['import-statement']() },
      { label: 'Fazer backup agora', icon: '⇩', run: () => ACTIONS['backup-now']() },
      { label: 'Exportar dados (JSON)', icon: '↓', run: () => ACTIONS['export-json']() },
      { label: 'Exportar relatório (CSV)', icon: '↓', run: () => ACTIONS['export-csv']() },
      { label: 'Salvar PDF', icon: '⎙', run: () => ACTIONS['export-pdf']() },
      { label: 'Alternar tema claro/escuro', icon: '☾', run: () => CP.toggleTheme() },
      { label: 'Alternar modo compacto', icon: '≡', run: () => ACTIONS['toggle-density']() }
    ];
    CP.MONTHS_FULL.forEach((label, index) => commands.push({
      label: `Filtrar mês: ${label}`, icon: '▦',
      run: () => { state.filters.month = index + 1; CP.refreshAndRender(); }
    }));
    commands.push({ label: 'Filtrar: ano inteiro', icon: '▦', run: () => { state.filters.month = 'all'; CP.refreshAndRender(); } });
    return commands;
  };

  const openPalette = () => {
    if (palette) return;
    const all = paletteCommands();
    paletteIndex = 0;
    palette = document.createElement('div');
    palette.className = 'cmdk';
    palette.innerHTML = `<div class="cmdk-box">
      <input class="cmdk-input" placeholder="Buscar ação, página ou filtro…" autocomplete="off" spellcheck="false">
      <div class="cmdk-list"></div>
      <div class="cmdk-foot"><span>↑↓ navegar</span><span>↵ selecionar</span><span>esc fechar</span></div>
    </div>`;
    document.body.append(palette);

    const input = $('.cmdk-input', palette);
    const list = $('.cmdk-list', palette);
    const renderList = () => {
      const query = CP.normalize(input.value);
      const items = all.filter(command => CP.normalize(command.label).includes(query));
      paletteIndex = CP.clamp(paletteIndex, 0, Math.max(0, items.length - 1));
      list.innerHTML = items.map((command, index) => `
        <button class="cmdk-item ${index === paletteIndex ? 'active' : ''}" data-index="${index}">
          <span class="cmdk-ic">${command.icon}</span>${esc(command.label)}</button>`).join('')
        || '<div class="cmdk-empty">Nada encontrado</div>';
      palette._items = items;
      $('.cmdk-item.active', list)?.scrollIntoView({ block: 'nearest' });
    };
    const runAt = index => {
      const command = (palette._items || [])[index];
      closePalette();
      command?.run();
    };

    input.addEventListener('input', () => { paletteIndex = 0; renderList(); });
    input.addEventListener('keydown', event => {
      const total = (palette._items || []).length;
      if (event.key === 'ArrowDown') { event.preventDefault(); paletteIndex = (paletteIndex + 1) % total; renderList(); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); paletteIndex = (paletteIndex - 1 + total) % total; renderList(); }
      else if (event.key === 'Enter') { event.preventDefault(); runAt(paletteIndex); }
      else if (event.key === 'Escape') closePalette();
    });
    palette.addEventListener('click', event => {
      const item = event.target.closest('.cmdk-item');
      if (item) runAt(Number(item.dataset.index));
      else if (event.target === palette) closePalette();
    });
    renderList();
    input.focus();
  };

  const closePalette = () => { palette?.remove(); palette = null; };

  // =========================================================================
  // Navegação e renderização
  // =========================================================================

  const RENDERERS = {
    dashboard: () => CP.renderDashboard(),
    transactions: () => CP.renderTransactions(),
    payables: () => CP.renderPayables(),
    wallet: () => CP.renderWallet(),
    investments: () => CP.renderInvestments(),
    goals: () => CP.renderGoals(),
    reports: () => CP.renderReports(),
    settings: () => CP.renderSettings()
  };

  CP.render = () => {
    CP.closePickers();
    updateChrome();
    $('#app').innerHTML = RENDERERS[state.page]();
    const app = $('#app');
    CP.initSelects(app);
    CP.initPickers(app);
    CP.initCurrency(app);
    CP.initTooltips();
    CP.initQuickBar();
    requestAnimationFrame(() => CP.animateNumbers());
  };

  const updateChrome = () => {
    const meta = CP.PAGES[state.page];
    $('#pageEyebrow').textContent = meta.eyebrow;
    $('#pageTitle').textContent = meta.title;

    const profile = db().profile;
    const name = profile?.name || 'Financeiro';
    $('#profileName').textContent = name;
    $('#profileAvatar').textContent = name.split(' ').slice(0, 2).map(part => part[0] || '').join('').toUpperCase() || 'CP';
    $('#profileSub').textContent = 'Tudo offline';
    $('#sidebarGoal').textContent = money(profile?.monthlyGoal || 0);

    const dashboard = db().dashboard;
    $('#sidebarGoalBar').style.width = `${CP.clamp(dashboard?.goalProgress || 0, 0, 100)}%`;

    $$('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.page === state.page));
    updateNavBadges();
  };

  /** Contador de pendências no menu — o que precisa da sua atenção. */
  const updateNavBadges = () => {
    const overdue = (db().payables || []).filter(item => item.days <= 3).length;
    $$('.nav-item').forEach(item => {
      $('.nav-badge', item)?.remove();
      if (item.dataset.page === 'payables' && overdue) {
        const badgeElement = document.createElement('span');
        badgeElement.className = 'nav-badge';
        badgeElement.textContent = overdue > 9 ? '9+' : String(overdue);
        item.append(badgeElement);
      }
    });
  };

  CP.navigate = async page => {
    if (!CP.PAGES[page]) return;
    state.page = page;
    state.selection.clear();
    closeMobileMenu();
    if (page === 'reports' && !state.reports) await loadReports();
    if (page === 'settings' && !state.backups) state.backups = await api.backup.list().catch(() => []);
    if (page === 'settings' && !state.importBatches) state.importBatches = await api.import.batches(8).catch(() => []);
    CP.render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const loadReports = async () => {
    CP.showLoading();
    try { state.reports = await api.reports.full(state.filters); }
    catch (error) { toast(error.message, 'error'); }
    finally { CP.hideLoading(); }
  };

  /** Recarrega os dados do período e redesenha — usado ao mudar filtros. */
  CP.refreshAndRender = async () => {
    CP.showLoading();
    try {
      await CP.reload();
      if (state.page === 'reports') await loadReports();
      CP.render();
    } finally {
      CP.hideLoading();
    }
  };

  CP.applyPreferences = () => {
    document.body.classList.toggle('density-compact', db().settings?.density === 'compact');
    const theme = db().settings?.theme === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
  };

  CP.toggleTheme = async () => {
    const next = db().settings?.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    await api.settings.set('theme', next, 'text');
    await api.setTheme(next);
    await CP.reload();
    CP.render();
  };

  const openMobileMenu = () => {
    $('#sidebar').classList.add('open');
    $('#mobileOverlay').classList.add('show');
  };
  const closeMobileMenu = () => {
    $('#sidebar').classList.remove('open');
    $('#mobileOverlay').classList.remove('show');
  };

  // =========================================================================
  // Eventos globais
  // =========================================================================

  const handleClick = event => {
    if (event.target.closest('[data-close-modal]')) return closeModal();

    const page = event.target.closest('[data-page]');
    if (page) { closeModal(); return CP.navigate(page.dataset.page); }

    const tab = event.target.closest('[data-tab]');
    if (tab) {
      const [tabPage, tabId] = tab.dataset.tab.split(':');
      state.tab[tabPage] = tabId;
      state.selection.clear();
      return CP.render();
    }

    const nextAction = event.target.closest('[data-next-action]');
    if (nextAction) return CP.runNextAction(nextAction.dataset.nextAction);

    const calendarDay = event.target.closest('[data-cal-day]');
    if (calendarDay) return CP.openCalendarDay(calendarDay.dataset.calDay);

    const action = event.target.closest('[data-action]');
    if (action) {
      if (action.dataset.action !== 'confirm-import') CP.closeDrawer();
      return ACTIONS[action.dataset.action]?.(action);
    }
  };

  const handleChange = event => {
    const target = event.target;

    const filterMap = {
      filterYear: 'year', filterMonth: 'month',
      filterAccount: 'account', filterCard: 'card', filterCategory: 'category'
    };
    if (filterMap[target.name]) {
      state.filters[filterMap[target.name]] = target.value;
      return CP.refreshAndRender();
    }

    // Marcar uma linha não pode redesenhar a lista inteira: com centenas de
    // lançamentos isso trava a rolagem e perde a posição. Só a barra muda.
    if (target.dataset.select) {
      target.checked ? state.selection.add(target.dataset.select) : state.selection.delete(target.dataset.select);
      target.closest('tr')?.classList.toggle('selected', target.checked);
      return refreshBulkBar();
    }

    if (target.dataset.checkAll !== undefined) {
      $$('[data-select]').forEach(input => {
        input.checked = target.checked;
        target.checked ? state.selection.add(input.dataset.select) : state.selection.delete(input.dataset.select);
        input.closest('tr')?.classList.toggle('selected', target.checked);
      });
      return refreshBulkBar();
    }

    if (target.dataset.aiFeature) {
      const features = db().settings?.ai_features || [];
      const next = target.checked
        ? [...new Set([...features, target.dataset.aiFeature])]
        : features.filter(item => item !== target.dataset.aiFeature);
      api.settings.set('ai_features', next, 'json').then(() => CP.reload());
    }
  };

  const refreshBulkBar = () => {
    const slot = $('#bulkBarSlot');
    if (slot) slot.innerHTML = CP.bulkBarHTML();
  };

  let ruleSearchTimer;
  const handleRuleSearch = event => {
    clearTimeout(ruleSearchTimer);
    const value = event.target.value;
    ruleSearchTimer = setTimeout(() => {
      state.ruleSearch = value;
      CP.render();
      const input = $('[data-rule-search]');
      input?.focus();
      input?.setSelectionRange(value.length, value.length);
    }, 260);
  };

  let searchTimer;
  const handleInput = event => {
    if (event.target.matches('[data-rule-search]')) return handleRuleSearch(event);
    if (!event.target.matches('[data-search]')) return;
    clearTimeout(searchTimer);
    const value = event.target.value;
    searchTimer = setTimeout(() => {
      state.search[state.page] = value;
      CP.render();
      const input = $('[data-search]');
      input?.focus();
      input?.setSelectionRange(value.length, value.length);
    }, 260);
  };

  const handleKeydown = event => {
    if (event.key === 'Escape') {
      if (palette) return closePalette();
      if ($('.retro-overlay')) return state.retroClose?.();
      if ($('.drawer-root')) return CP.closeDrawer();
      closeModal();
      closeMobileMenu();
      return;
    }
    if ((event.key === 'k' || event.key === 'K') && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      return palette ? closePalette() : openPalette();
    }
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName) || event.target.isContentEditable;
    if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'n' || event.key === 'N') { event.preventDefault(); openQuickAdd(); }
  };

  // =========================================================================
  // Inicialização
  // =========================================================================

  const boot = async (afterOnboarding = false) => {
    document.body.classList.add(`platform-${(await api.info()).platform}`);
    state.appInfo = await api.info();

    if (!afterOnboarding && await api.needsOnboarding()) {
      return renderOnboarding();
    }

    CP.showLoading();
    try {
      await CP.reload();
      CP.applyPreferences();
      CP.render();
    } catch (error) {
      $('#app').innerHTML = `<section class="page">${emptyState(
        'Não foi possível abrir seus dados', error.message)}</section>`;
      toast(error.message, 'error');
    } finally {
      CP.hideLoading();
    }
  };

  document.addEventListener('DOMContentLoaded', async () => {
    $('#todayLabel').textContent = new Intl.DateTimeFormat('pt-BR', {
      weekday: 'short', day: '2-digit', month: 'short'
    }).format(new Date()).replace('.', '');

    document.addEventListener('click', CP.closeFloating);
    document.addEventListener('click', handleClick);
    document.addEventListener('submit', handleSubmit);
    document.addEventListener('change', handleChange);
    document.addEventListener('input', handleInput);
    document.addEventListener('keydown', handleKeydown);

    $('#themeToggle').addEventListener('click', () => CP.toggleTheme());
    $('#quickAdd').addEventListener('click', openQuickAdd);
    $('#fabAdd')?.addEventListener('click', openQuickAdd);
    $('#cmdkButton').addEventListener('click', openPalette);
    $('#menuButton').addEventListener('click', openMobileMenu);
    $('#sidebarClose').addEventListener('click', closeMobileMenu);
    $('#mobileOverlay').addEventListener('click', closeMobileMenu);

    window.addEventListener('scroll', () => {
      document.body.classList.toggle('scrolled', window.scrollY > 40);
    }, { passive: true });

    // Comandos vindos do menu nativo do sistema.
    api.onNavigate(page => CP.navigate(page));
    api.onAction(action => ACTIONS[action]?.({ dataset: {} }));
    api.onMarketDataUpdated(async result => {
      await CP.reload();
      if (state.page === 'investments') CP.render();
      if (result?.updated?.length) toast(`${result.updated.length} cotação(ões) atualizada(s) automaticamente.`);
    });

    await boot();
  });
})();
