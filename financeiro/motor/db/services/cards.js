'use strict';

const repo = require('../repository');
const accounts = require('./accounts');
const { logActivity } = require('./catalog');
const {
  generateId, now, toNumber, roundCurrency, required, sum,
  monthKey, addMonths, invoiceMonthForPurchase, invoiceDueDate, formatBRL
} = require('../utils');

const CARD_TYPE_LABELS = {
  CREDITO: 'Crédito',
  VALE_ALIMENTACAO: 'Vale alimentação',
  VALE_REFEICAO: 'Vale refeição',
  BENEFICIO_FLEXIVEL: 'Benefício flexível'
};

const isBenefit = card => Boolean(card?.cardType) && card.cardType !== 'CREDITO';

// ---------------------------------------------------------------------------
// Cartões e benefícios
// ---------------------------------------------------------------------------

function list() {
  return repo.all('cards_benefits', 'status, name COLLATE NOCASE');
}

function getById(id) {
  const card = repo.findById('cards_benefits', id);
  if (!card) throw new Error('Cartão ou benefício não encontrado.');
  return card;
}

function creditCards() {
  return list().filter(card => !isBenefit(card));
}

function benefits() {
  return list().filter(isBenefit);
}

function create(data) {
  required(data, ['name', 'bankName', 'cardType']);
  const benefit = data.cardType !== 'CREDITO';
  if (!benefit && (toNumber(data.limit) <= 0 || toNumber(data.closingDay) <= 0 || toNumber(data.dueDay) <= 0)) {
    throw new Error('Informe limite, dia de fechamento e dia de vencimento do cartão de crédito.');
  }
  const item = {
    id: generateId('card'),
    name: String(data.name).trim(),
    bankName: String(data.bankName).trim(),
    cardType: data.cardType,
    limit: benefit ? 0 : roundCurrency(data.limit),
    benefitBalance: benefit ? roundCurrency(data.benefitBalance) : 0,
    closingDay: benefit ? 0 : toNumber(data.closingDay),
    dueDay: benefit ? 0 : toNumber(data.dueDay),
    color: data.color || '#7c3aed',
    status: data.status || 'ATIVO',
    createdAt: now(),
    updatedAt: now()
  };
  if (item.benefitBalance < 0) throw new Error('O saldo do benefício não pode ser negativo.');
  repo.insert('cards_benefits', item);
  logActivity(
    benefit ? 'BENEFIT_CREATED' : 'CREDIT_CARD_CREATED',
    `${benefit ? 'Benefício' : 'Cartão'} ${item.name} adicionado`,
    'cardBenefit',
    item.id
  );
  return item;
}

function update(id, data) {
  const current = getById(id);
  const merged = { ...current, ...data };
  const benefit = merged.cardType !== 'CREDITO';
  const payload = {
    ...merged,
    limit: benefit ? 0 : roundCurrency(merged.limit),
    benefitBalance: benefit ? roundCurrency(merged.benefitBalance) : 0,
    closingDay: benefit ? 0 : toNumber(merged.closingDay),
    dueDay: benefit ? 0 : toNumber(merged.dueDay)
  };
  if (!benefit && (payload.limit <= 0 || payload.closingDay <= 0 || payload.dueDay <= 0)) {
    throw new Error('Dados do cartão de crédito incompletos.');
  }
  if (payload.benefitBalance < 0) throw new Error('O saldo do benefício não pode ser negativo.');
  const result = repo.update('cards_benefits', id, payload);
  // Mudar o dia de fechamento remaneja as parcelas em aberto.
  if (!benefit && toNumber(current.closingDay) !== payload.closingDay) recalculateByClosingDay();
  return result;
}

function toggleStatus(id) {
  const card = getById(id);
  return repo.update('cards_benefits', id, { status: card.status === 'ATIVO' ? 'INATIVO' : 'ATIVO' });
}

function remove(id) {
  const card = getById(id);
  const uses =
    repo.count('expenses', 'credit_card_id = ?', [id]) +
    repo.count('card_purchases', 'credit_card_id = ?', [id]);
  if (uses > 0) {
    throw new Error(
      `${card.name} tem ${uses} lançamento(s) vinculado(s). Inative em vez de excluir para preservar o histórico.`
    );
  }
  return repo.remove('cards_benefits', id);
}

// ---------------------------------------------------------------------------
// Saldo de benefício (vale alimentação/refeição)
// ---------------------------------------------------------------------------

function validateBenefitBalance(benefitId, amount) {
  const benefit = getById(benefitId);
  if (!isBenefit(benefit)) throw new Error('O registro selecionado não é um benefício.');
  if (benefit.status !== 'ATIVO') throw new Error('O benefício selecionado está inativo.');
  if (toNumber(benefit.benefitBalance) < toNumber(amount)) {
    throw new Error(`Saldo insuficiente no ${benefit.name}. Disponível: ${formatBRL(benefit.benefitBalance)}.`);
  }
  return benefit;
}

function decreaseBenefitBalance(benefitId, amount) {
  const benefit = validateBenefitBalance(benefitId, amount);
  return repo.update('cards_benefits', benefitId, {
    benefitBalance: roundCurrency(toNumber(benefit.benefitBalance) - toNumber(amount))
  });
}

function refundBenefitBalance(benefitId, amount) {
  const benefit = repo.findById('cards_benefits', benefitId);
  if (!benefit || !isBenefit(benefit)) return null;
  return repo.update('cards_benefits', benefitId, {
    benefitBalance: roundCurrency(toNumber(benefit.benefitBalance) + toNumber(amount))
  });
}

/** Recarga mensal do vale — antes só dava para editar o saldo na mão. */
function topUpBenefit(benefitId, amount) {
  const benefit = getById(benefitId);
  if (!isBenefit(benefit)) throw new Error('Recarga disponível apenas para vales e benefícios.');
  const value = roundCurrency(amount);
  if (value <= 0) throw new Error('Informe um valor de recarga maior que zero.');
  const result = repo.update('cards_benefits', benefitId, {
    benefitBalance: roundCurrency(toNumber(benefit.benefitBalance) + value)
  });
  logActivity('BENEFIT_TOPUP', `Recarga de ${formatBRL(value)} em ${benefit.name}`, 'cardBenefit', benefitId);
  return result;
}

// ---------------------------------------------------------------------------
// Parcelamento
//
// Uma compra de R$ 100 em 3x vira 33,33 + 33,33 + 33,34: as parcelas são
// arredondadas para baixo e a diferença de centavos vai toda na última, para
// que a soma bata exatamente com o valor da compra.
// ---------------------------------------------------------------------------

function generateInstallments(purchase) {
  const card = getById(purchase.creditCardId);
  if (isBenefit(card)) throw new Error('Benefícios não permitem parcelamento nem fatura.');
  if (repo.count('card_installments', 'purchase_id = ?', [purchase.id]) > 0) return [];

  const count = Math.max(1, toNumber(purchase.installments, 1));
  const totalAmount = roundCurrency(purchase.totalAmount);
  // Estorno entra como compra de valor negativo. Arredondar para baixo levaria
  // a diferença para o lado errado num número negativo, então o truncamento
  // acompanha o sinal.
  const truncate = totalAmount < 0 ? Math.ceil : Math.floor;
  const base = truncate((totalAmount / count) * 100) / 100;
  const firstMonth = invoiceMonthForPurchase(purchase.purchaseDate, card.closingDay);

  const installments = [];
  for (let index = 0; index < count; index++) {
    installments.push({
      id: generateId('installment'),
      purchaseId: purchase.id,
      creditCardId: purchase.creditCardId,
      invoiceMonth: monthKey(addMonths(`${firstMonth}-01`, index)),
      installmentNumber: index + 1,
      installmentsTotal: count,
      amount: roundCurrency(index === count - 1 ? totalAmount - base * (count - 1) : base),
      status: 'ABERTA',
      paidAt: '',
      createdAt: now(),
      updatedAt: now()
    });
  }
  repo.insertMany('card_installments', installments);
  rebuildInvoices();
  return installments;
}

function getInstallments(cardId, referenceMonth) {
  return repo.query(
    'SELECT * FROM card_installments WHERE credit_card_id = ? AND invoice_month = ? ORDER BY created_at',
    [cardId, referenceMonth]
  );
}

// ---------------------------------------------------------------------------
// Faturas
//
// A fatura é derivada: sempre reconstruída a partir das parcelas, agrupando
// por cartão + mês. Nunca é editada diretamente, então não há como o total da
// fatura divergir da soma das parcelas.
// ---------------------------------------------------------------------------

/**
 * Reconstrói as faturas a partir das parcelas.
 *
 * Chamar isto é apagar e regravar TODAS as faturas. Como `getInvoices` é lido
 * em toda atualização de tela, o app estava escrevendo no banco a cada clique:
 * transação, WAL crescendo, checkpoint atrás de checkpoint. O guarda abaixo
 * compara o carimbo de tempo das parcelas com o das faturas e só refaz o
 * trabalho quando alguma parcela mudou depois da última reconstrução.
 *
 * É auto-corretivo de propósito: nenhum ponto do código precisa lembrar de
 * avisar que mexeu em parcela.
 */
function invoicesAreStale() {
  const parcelas = repo.query('SELECT MAX(updated_at) AS marca, COUNT(*) AS total FROM card_installments')[0];
  const faturas = repo.query('SELECT MAX(updated_at) AS marca, COUNT(*) AS total FROM card_invoices')[0];
  // Sem parcela nenhuma, só há o que fazer se sobrou fatura órfã.
  if (!Number(parcelas.total)) return Number(faturas.total) > 0;
  if (!Number(faturas.total)) return true;
  return String(parcelas.marca || '') > String(faturas.marca || '');
}

function rebuildInvoices(force = false) {
  if (!force && !invoicesAreStale()) return repo.all('card_invoices');
  return repo.transaction(() => {
    const previous = new Map(
      repo.all('card_invoices').map(invoice => [`${invoice.creditCardId}|${invoice.referenceMonth}`, invoice])
    );
    const groups = new Map();
    for (const item of repo.all('card_installments')) {
      const key = `${item.creditCardId}|${item.invoiceMonth}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }

    const invoices = [...groups.entries()].map(([key, installments]) => {
      const [creditCardId, referenceMonth] = key.split('|');
      const old = previous.get(key);
      const allPaid = installments.every(item => item.status === 'PAGA');
      const firstPaid = installments.find(item => item.paidAt);
      // Fatura paga guarda o valor com que foi paga. Recalcular pela soma das
      // parcelas apagaria os centavos de diferença entre o que o app leu e o
      // que o banco cobrou — e o saldo da conta, que já saiu pelo valor real,
      // ficaria devendo essa diferença a cada remontagem.
      const paidTotal = old?.status === 'PAGA' ? toNumber(old.totalAmount) : 0;
      return {
        id: old?.id || generateId('invoice'),
        creditCardId,
        referenceMonth,
        totalAmount: allPaid && paidTotal > 0 ? roundCurrency(paidTotal) : roundCurrency(sum(installments, 'amount')),
        status: allPaid ? 'PAGA' : 'ABERTA',
        paidAt: allPaid ? old?.paidAt || firstPaid?.paidAt || '' : '',
        paidFromBankAccountId: allPaid ? old?.paidFromBankAccountId || '' : '',
        createdAt: old?.createdAt || now(),
        updatedAt: now()
      };
    });

    repo.clear('card_invoices');
    repo.insertMany('card_invoices', invoices);
    return invoices;
  });
}

function getInvoices(cardId) {
  rebuildInvoices();
  const invoices = repo.all('card_invoices', 'reference_month DESC');
  return cardId ? invoices.filter(item => item.creditCardId === cardId) : invoices;
}

/** Enriquece a fatura com vencimento e cartão — o que a tela precisa mostrar. */
function getInvoicesDetailed(cardId) {
  const cards = new Map(list().map(card => [card.id, card]));
  return getInvoices(cardId).map(invoice => {
    const card = cards.get(invoice.creditCardId);
    return {
      ...invoice,
      cardName: card?.name || 'Cartão removido',
      cardColor: card?.color || '#7c3aed',
      closingDay: card?.closingDay || 0,
      dueDate: card ? invoiceDueDate(invoice.referenceMonth, card.dueDay, card.closingDay) : `${invoice.referenceMonth}-01`,
      installmentCount: repo.count('card_installments', 'credit_card_id = ? AND invoice_month = ?', [
        invoice.creditCardId,
        invoice.referenceMonth
      ])
    };
  });
}

/** Detalhe de uma fatura: cada parcela com a compra que a originou. */
function getInvoiceDetails(cardId, referenceMonth) {
  const card = getById(cardId);
  const rows = repo.query(
    `SELECT i.*, p.description AS purchase_description, p.category AS purchase_category,
            p.purchase_date AS purchase_date, p.total_amount AS purchase_total
       FROM card_installments i
       LEFT JOIN card_purchases p ON p.id = i.purchase_id
      WHERE i.credit_card_id = ? AND i.invoice_month = ?
      ORDER BY p.purchase_date, i.created_at`,
    [cardId, referenceMonth]
  );
  const invoice = repo.query('SELECT * FROM card_invoices WHERE credit_card_id = ? AND reference_month = ?', [
    cardId,
    referenceMonth
  ])[0];
  return {
    card,
    invoice: invoice || { id: '', creditCardId: cardId, referenceMonth, status: 'ABERTA', totalAmount: 0 },
    dueDate: invoiceDueDate(referenceMonth, card.dueDay, card.closingDay),
    total: roundCurrency(sum(rows, 'amount')),
    installments: rows
  };
}

/**
 * `paidAmount` só é informado pela importação: quando o extrato mostra o
 * valor exato que saiu da conta, é ele que fecha a fatura, e não a soma das
 * parcelas que o app conseguiu ler. A diferença é de centavos de
 * arredondamento, mas ela é a diferença entre o saldo bater e não bater.
 */
function payInvoice(invoiceId, bankAccountId, paidAmount = null) {
  return repo.transaction(() => {
    const invoice = repo.findById('card_invoices', invoiceId);
    if (!invoice) throw new Error('Fatura não encontrada.');
    if (invoice.status === 'PAGA') throw new Error('Esta fatura já foi paga.');
    accounts.getById(bankAccountId);

    const installments = getInstallments(invoice.creditCardId, invoice.referenceMonth);
    const total = paidAmount != null && toNumber(paidAmount) > 0
      ? roundCurrency(paidAmount)
      : roundCurrency(sum(installments, 'amount')) || toNumber(invoice.totalAmount);
    const paidAt = now();

    const updated = repo.update('card_invoices', invoiceId, {
      totalAmount: total,
      status: 'PAGA',
      paidAt,
      paidFromBankAccountId: bankAccountId
    });
    for (const item of installments) {
      repo.update('card_installments', item.id, { status: 'PAGA', paidAt });
    }
    // As saídas do tipo cartão viram "PAGO" junto com a fatura.
    repo.run(
      `UPDATE expenses SET status = 'PAGO', updated_at = ?
        WHERE payment_method = 'CARTAO_CREDITO'
          AND card_purchase_id IN (SELECT DISTINCT purchase_id FROM card_installments WHERE credit_card_id = ? AND invoice_month = ?)
          AND card_purchase_id NOT IN (
                SELECT DISTINCT purchase_id FROM card_installments WHERE status = 'ABERTA'
          )`,
      [paidAt, invoice.creditCardId, invoice.referenceMonth]
    );

    const card = getById(invoice.creditCardId);
    logActivity('CARD_INVOICE_PAID', `Fatura ${card.name} de ${invoice.referenceMonth} paga`, 'cardInvoice', invoice.id);
    accounts.syncBalances();
    return updated;
  });
}

/**
 * Recoloca as parcelas em aberto na fatura correta segundo o dia de
 * fechamento atual de cada cartão. Útil depois de corrigir o fechamento de um
 * cartão cadastrado errado. Parcelas já pagas não se movem.
 */
function recalculateByClosingDay() {
  return repo.transaction(() => {
    const cardsById = new Map(list().map(card => [card.id, card]));
    let moved = 0;

    for (const purchase of repo.all('card_purchases')) {
      const card = cardsById.get(purchase.creditCardId);
      if (!card || isBenefit(card)) continue;
      const firstMonth = invoiceMonthForPurchase(purchase.purchaseDate, card.closingDay);
      const open = repo.query(`SELECT * FROM card_installments WHERE purchase_id = ? AND status <> 'PAGA'`, [purchase.id]);
      for (const item of open) {
        const expected = monthKey(addMonths(`${firstMonth}-01`, Math.max(1, toNumber(item.installmentNumber, 1)) - 1));
        if (item.invoiceMonth !== expected) {
          repo.update('card_installments', item.id, { invoiceMonth: expected });
          moved++;
        }
      }
    }

    const invoices = rebuildInvoices();
    logActivity('CARD_INVOICES_RECALCULATED', `${moved} parcela(s) redistribuída(s) por fechamento`, 'cardInvoice', 'recalculate');
    return { moved, invoices: invoices.length };
  });
}

/** Quanto do limite está comprometido: soma das parcelas ainda não pagas. */
function usedLimit(cardId) {
  const row = repo
    .query(`SELECT SUM(amount) AS total FROM card_installments WHERE credit_card_id = ? AND status = 'ABERTA'`, [cardId])[0];
  return roundCurrency(row?.total);
}

module.exports = {
  CARD_TYPE_LABELS,
  isBenefit,
  list,
  getById,
  creditCards,
  benefits,
  create,
  update,
  toggleStatus,
  remove,
  validateBenefitBalance,
  decreaseBenefitBalance,
  refundBenefitBalance,
  topUpBenefit,
  generateInstallments,
  getInstallments,
  rebuildInvoices,
  getInvoices,
  getInvoicesDetailed,
  getInvoiceDetails,
  payInvoice,
  recalculateByClosingDay,
  usedLimit
};
