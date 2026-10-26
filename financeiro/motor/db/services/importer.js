'use strict';

const repo = require('../repository');
const statement = require('./statement');
const accounts = require('./accounts');
const cards = require('./cards');
const transactions = require('./transactions');
const investments = require('./investments');
const categorizer = require('./categorizer');
const catalog = require('./catalog');
const { generateId, now, toNumber, roundCurrency, dateOnly, sum, invoiceDueDate } = require('../utils');

/**
 * Importação em lote.
 *
 * Você joga doze faturas e doze extratos de uma vez; isto aqui lê todos, junta
 * numa lista só, remove o que se repete entre arquivos e devolve para revisão.
 * Depois de confirmar, grava cada linha no lugar certo — despesa, receita,
 * aporte, resgate ou pagamento de fatura — e ajusta o saldo inicial da conta
 * para que o app feche exatamente com o extrato do banco.
 */

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

/**
 * Lê vários arquivos e monta uma sessão de importação.
 * Nada é gravado aqui: a sessão é só a proposta que você vai revisar.
 */
async function readBatch(filePaths, options = {}) {
  const documents = [];
  const errors = [];

  for (const filePath of filePaths) {
    try {
      const result = await statement.readFile(filePath, { ...options, enrich: false });
      documents.push(result);
    } catch (error) {
      errors.push({ file: filePath.split('/').pop(), message: error.message });
    }
  }

  return buildSession(documents, errors);
}

async function readPasted(text, options = {}) {
  const result = await statement.readText(text, { ...options, fileName: 'texto colado' });
  return buildSession([result], []);
}

/**
 * Junta os documentos numa lista única, marcando repetições.
 *
 * São dois tipos de repetição diferentes:
 *   - o mesmo arquivo importado duas vezes, ou meses que se sobrepõem;
 *   - o pagamento da fatura, que aparece no extrato E na fatura.
 * O segundo caso é resolvido pela regra combinada: o extrato manda no
 * dinheiro, a fatura manda nas compras.
 */
function buildSession(documents, errors = []) {
  const existing = existingFingerprints();
  const seen = new Map();
  const rows = [];

  // Extratos primeiro: eles são a fonte de verdade sobre o dinheiro da conta.
  const ordered = [...documents].sort((a, b) =>
    (a.documentType === 'extrato' ? 0 : 1) - (b.documentType === 'extrato' ? 0 : 1));

  for (const document of ordered) {
    for (const row of document.rows || []) {
      const item = {
        ...row,
        id: generateId('imp'),
        source: document.fileName || document.bank || 'documento',
        bankId: document.bankId,
        bankName: document.bank,
        documentType: document.documentType,
        selected: true
      };

      // Categoriza aqui, no lote. A leitura de cada arquivo roda com
      // `enrich: false` justamente para não repetir esse trabalho por
      // documento — mas sem este passo os lançamentos chegavam à revisão sem
      // categoria nenhuma e acabavam todos em "Outros".
      if (!item.category && needsCategory(item)) {
        const guess = categorizer.categorize(item.description, item.isIncome ? 'income' : 'variableExpense');
        if (guess.category) {
          item.category = guess.category;
          item.categorySource = guess.source;
        }
      }

      const fingerprint = makeFingerprint(item);
      item.fingerprint = fingerprint;

      if (existing.has(fingerprint)) {
        item.duplicate = 'já existe no app';
        item.selected = false;
      } else if (seen.has(fingerprint) && seen.get(fingerprint) !== item.source) {
        // Só é duplicata quando vem de OUTRO arquivo. Dois Pix iguais para a
        // mesma pessoa no mesmo dia, dentro do mesmo extrato, são dois Pix
        // de verdade — descartar um deles quebraria o saldo.
        item.duplicate = `repetido em ${seen.get(fingerprint)}`;
        item.selected = false;
      } else if (item.kind === 'invoicePayment' && document.documentType === 'fatura') {
        // O pagamento já veio (ou virá) pelo extrato da conta.
        item.duplicate = 'pagamento de fatura — já contabilizado pelo extrato';
        item.selected = false;
      } else {
        seen.set(fingerprint, item.source);
      }

      rows.push(item);
    }
  }

  linkCardPayments(rows, documents);

  rows.sort((a, b) => String(b.date).localeCompare(String(a.date)));

  const dates = rows.map(row => row.date).filter(Boolean).sort();
  const selected = rows.filter(row => row.selected);

  return {
    id: generateId('session'),
    documents: documents.map(summarizeDocument),
    errors,
    rows,
    total: rows.length,
    selectedCount: selected.length,
    duplicates: rows.length - selected.length,
    uncategorized: selected.filter(row => !row.category && needsCategory(row)).length,
    period: dates.length ? { start: dates[0], end: dates.at(-1) } : null,
    byMonth: groupByMonth(selected)
  };
}

const summarizeDocument = document => ({
  fileName: document.fileName,
  bank: document.bank,
  bankId: document.bankId,
  documentType: document.documentType,
  strategy: document.strategy,
  total: document.total,
  empty: Boolean(document.empty),
  emptyReason: document.emptyReason,
  period: document.meta?.period || null,
  declaredFinalBalance: document.meta?.declaredFinalBalance ?? null,
  account: document.meta?.account || null,
  cardLast4: document.meta?.cardLast4 || null,
  invoiceReference: document.meta?.invoiceReference || null,
  terms: document.meta?.terms || null
});

// ---------------------------------------------------------------------------
// Pagamento de fatura reconhecido pelo extrato
// ---------------------------------------------------------------------------

/**
 * Pagar o cartão não se anuncia no extrato. Sai como "Pix enviado: MERCADO
 * PAGO INSTITUICAO DE PAGAMENTO" — do lado de fora é igual a qualquer outra
 * transferência.
 *
 * Sem reconhecer, o mesmo dinheiro é contado duas vezes: uma nas compras que
 * vieram da fatura, outra nessa saída da conta. E a fatura fica em aberto
 * para sempre, porque o pagamento dela nunca chegou.
 *
 * O reconhecimento exige três coincidências ao mesmo tempo — o nome da
 * emissora na descrição, o valor igual ao total da fatura e a data perto do
 * vencimento. Uma só não serve: mandar R$ 300 para o Mercado Pago para usar
 * como saldo é uma transferência de verdade, e é assim que continua sendo
 * tratada, porque não bate com fatura nenhuma.
 */
const ISSUERS = [
  { id: 'mercadopago', terms: ['mercado pago', 'mercadopago', 'mercado libre', 'mercadolibre'] },
  { id: 'nubank', terms: ['nubank', 'nu pagamentos', 'nu financeira'] },
  { id: 'inter', terms: ['banco inter', 'inter'] },
  { id: 'santander', terms: ['santander'] },
  { id: 'itau', terms: ['itau', 'itaucard', 'itau unibanco'] },
  { id: 'bradesco', terms: ['bradesco'] },
  { id: 'c6', terms: ['c6 bank', 'c6bank', 'banco c6'] },
  { id: 'bb', terms: ['banco do brasil', 'ourocard'] },
  { id: 'caixa', terms: ['caixa economica', 'caixa'] },
  { id: 'will', terms: ['will bank', 'willbank'] },
  { id: 'neon', terms: ['neon'] },
  { id: 'picpay', terms: ['picpay'] },
  { id: 'btg', terms: ['btg'] },
  { id: 'xp', terms: ['xp investimentos', 'banco xp'] },
  { id: 'original', terms: ['banco original'] },
  { id: 'pan', terms: ['banco pan'] },
  { id: 'digio', terms: ['digio'] },
  { id: 'amazonia', terms: ['banpara', 'banco da amazonia'] }
];

/** Qual emissora aparece neste texto, se alguma. */
function issuerOf(text) {
  const clean = normalize(text).replace(/[^a-z0-9 ]/g, ' ');
  for (const issuer of ISSUERS) {
    for (const term of issuer.terms) {
      if (new RegExp(`\\b${term.replace(/\s+/g, '\\s+')}\\b`).test(clean)) return issuer.id;
    }
  }
  return null;
}

const daysApart = (a, b) => {
  if (!a || !b) return 999;
  return Math.abs(Math.round((Date.parse(a) - Date.parse(b)) / 86400000));
};

/**
 * As faturas com que a saída pode estar casando: as que vieram nesta mesma
 * leva de arquivos e as que já estão em aberto no app.
 */
function invoiceCandidates(rows, documents) {
  const candidates = [];

  for (const document of documents) {
    if (document.documentType !== 'fatura') continue;
    const reference = document.meta?.invoiceReference
      || (document.rows?.[0]?.date || '').slice(0, 7) || null;
    const own = rows.filter(row => row.source === (document.fileName || document.bank || 'documento'));
    // Duas linhas não entram no total: o estorno abate (a fatura fecha pelo
    // líquido, e é o líquido que se paga) e o pagamento da fatura ANTERIOR,
    // que quase toda fatura lista no topo. Somar esse pagamento inflava o
    // total e nenhuma saída do extrato batia com ele.
    const total = roundCurrency(own.reduce((acc, row) => {
      if (row.kind === 'invoicePayment') return acc;
      return acc + (row.isIncome || row.kind === 'refund' ? -row.amount : row.amount);
    }, 0));
    if (total <= 0) continue;
    const terms = document.meta?.terms || {};
    candidates.push({
      origin: 'sessao',
      fileName: document.fileName,
      cardId: null,
      name: document.bank || document.fileName,
      issuer: issuerOf(document.meta?.account?.bankName || document.bank || document.fileName || ''),
      reference,
      total,
      dueDate: reference && terms.dueDay
        ? invoiceDueDate(reference, terms.dueDay, terms.closingDay)
        : reference ? `${reference}-10` : null
    });
  }

  for (const invoice of repo.query(
    `SELECT i.id, i.credit_card_id, i.reference_month, i.total_amount,
            c.name AS card_name, c.bank_name, c.due_day, c.closing_day
       FROM card_invoices i JOIN cards_benefits c ON c.id = i.credit_card_id
      WHERE i.status = 'ABERTA' AND i.total_amount > 0`
  )) {
    candidates.push({
      origin: 'app',
      fileName: null,
      cardId: invoice.creditCardId,
      name: invoice.cardName,
      issuer: issuerOf(`${invoice.bankName} ${invoice.cardName}`),
      reference: invoice.referenceMonth,
      total: roundCurrency(invoice.totalAmount),
      dueDate: invoiceDueDate(invoice.referenceMonth, invoice.dueDay, invoice.closingDay)
    });
  }

  return candidates;
}

function linkCardPayments(rows, documents) {
  const candidates = invoiceCandidates(rows, documents);
  if (!candidates.length) return;
  const used = new Set();

  for (const row of rows) {
    if (row.isIncome || row.documentType !== 'extrato') continue;
    if (!['expense', 'transfer', 'invoicePayment'].includes(row.kind)) continue;

    // Quando o próprio banco já escreveu "Pagamento de fatura", o nome da
    // emissora não é exigido — o extrato já disse o que é.
    const declared = row.kind === 'invoicePayment';
    const issuer = issuerOf(row.description);
    if (!declared && !issuer) continue;

    const matches = candidates
      .filter(candidate => !used.has(candidateKey(candidate)))
      .filter(candidate => declared || !candidate.issuer || candidate.issuer === issuer)
      .map(candidate => ({
        candidate,
        amountGap: Math.abs(candidate.total - row.amount),
        dateGap: daysApart(row.date, candidate.dueDate)
      }))
      // A tolerância no valor não é zero de propósito: a fatura real do
      // Santander fecha em R$ 387,17 pela soma das parcelas e o banco cobrou
      // R$ 387,19 — dois centavos de arredondamento que existem no mundo e
      // fariam o casamento falhar. Já a data pode adiantar bastante (quem
      // paga antes do vencimento) e atrasar pouco, porque pagar atrasado
      // muda o valor e aí não bate mesmo.
      .filter(item => item.amountGap <= Math.max(0.10, item.candidate.total * 0.003)
        && item.dateGap <= 12)
      .sort((a, b) => a.amountGap - b.amountGap || a.dateGap - b.dateGap);

    const best = matches[0];
    if (!best) continue;

    used.add(candidateKey(best.candidate));
    row.kind = 'invoicePayment';
    row.cardPayment = {
      fileName: best.candidate.fileName,
      cardId: best.candidate.cardId,
      reference: best.candidate.reference,
      total: best.candidate.total,
      cardName: best.candidate.name
    };
    row.note = `Pagamento da fatura ${best.candidate.name}`
      + (best.candidate.reference ? ` (${best.candidate.reference})` : '');
  }
}

const candidateKey = candidate =>
  `${candidate.origin}|${candidate.cardId || candidate.fileName}|${candidate.reference}`;

/**
 * Assinatura de um lançamento: data + valor + início da descrição.
 * Descrição inteira seria frágil demais — o mesmo gasto aparece com textos
 * ligeiramente diferentes no extrato e na fatura.
 */
function makeFingerprint(row) {
  const head = String(row.description || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 14);
  return `${row.date}|${Math.round(toNumber(row.amount) * 100)}|${head}`;
}

/** Tudo que já está no banco, para não importar duas vezes. */
function existingFingerprints() {
  const set = new Set();
  const add = rows => {
    for (const row of rows) {
      set.add(makeFingerprint({ date: row.date, amount: row.amount, description: row.description || row.source }));
    }
  };
  add(repo.query('SELECT date, amount, description FROM expenses'));
  add(repo.query('SELECT date, amount, source AS description FROM incomes'));
  add(repo.query('SELECT date, amount, description FROM investment_contributions'));
  add(repo.query('SELECT date, amount, description FROM transfers'));
  // Guardar dinheiro numa meta é uma saída de verdade da conta e aparece no
  // extrato do banco. Sem isto, a linha correspondente chegaria à revisão como
  // se fosse um gasto novo, e o dinheiro sairia duas vezes.
  add(repo.query("SELECT date, amount, description FROM goal_deposits WHERE bank_account_id <> ''"));
  return set;
}

/**
 * O estorno também é categorizado: ele precisa cair na MESMA categoria da
 * compra que está cancelando, senão o valor sai de "Compras" e some em
 * "Reembolso", e a categoria original nunca recua.
 */
const needsCategory = row => ['expense', 'income', 'refund'].includes(row.kind);

function groupByMonth(rows) {
  const map = new Map();
  for (const row of rows) {
    const month = String(row.date).slice(0, 7);
    if (!map.has(month)) map.set(month, { month, count: 0, income: 0, expense: 0 });
    const entry = map.get(month);
    entry.count++;
    if (row.isIncome) entry.income = roundCurrency(entry.income + row.amount);
    else entry.expense = roundCurrency(entry.expense + row.amount);
  }
  return [...map.values()].sort((a, b) => a.month.localeCompare(b.month));
}

// ---------------------------------------------------------------------------
// Vínculo com conta e cartão
// ---------------------------------------------------------------------------

/**
 * Sugere a qual conta ou cartão cada documento pertence, comparando o banco
 * detectado com o que já está cadastrado. Quando não há correspondência,
 * devolve uma proposta de criação já preenchida.
 */
function suggestTargets(session) {
  const existingAccounts = accounts.list();
  const existingCards = cards.list();

  return session.documents.map(document => {
    const bankName = document.account?.bankName || document.bank || '';
    const isInvoice = document.documentType === 'fatura';
    const pool = isInvoice ? existingCards : existingAccounts;

    const match = pool.find(item =>
      normalize(item.bankName) === normalize(bankName)
      || normalize(item.name).includes(normalize(bankName)));

    return {
      fileName: document.fileName,
      documentType: document.documentType,
      bankName,
      matchedId: match?.id || null,
      matchedName: match?.name || null,
      // As condições vêm da própria fatura. Só caem no padrão quando o
      // documento realmente não as informa.
      terms: document.terms || null,
      proposal: match ? null : (isInvoice
        ? {
            kind: 'card', name: bankName || 'Cartão', bankName, cardType: 'CREDITO',
            limit: document.terms?.limit || 0,
            closingDay: document.terms?.closingDay || 1,
            dueDay: document.terms?.dueDay || 10,
            termsDetected: Boolean(document.terms?.closingDay && document.terms?.dueDay)
          }
        : { kind: 'account', name: bankName || 'Conta', bankName, accountType: 'CONTA_DIGITAL', initialBalance: 0 })
    };
  });
}

const normalize = value =>
  String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

// ---------------------------------------------------------------------------
// Gravação
// ---------------------------------------------------------------------------

/**
 * Grava a sessão revisada.
 *
 * `targets` diz, por arquivo, em qual conta ou cartão as linhas entram.
 * Cada natureza vai para o lugar certo do app, e no fim o saldo inicial da
 * conta é ajustado para bater com o saldo final que o extrato declara.
 */
function commit(session, targets = {}, options = {}) {
  return repo.transaction(() => {
    const report = {
      expenses: 0, incomes: 0, contributions: 0, withdrawals: 0,
      invoicePayments: 0, refunds: 0, skipped: 0, learned: 0, errors: []
    };

    const chosen = (session.rows || []).filter(row => row.selected);
    // Fotografia do que já existia. O que aparecer daqui para frente foi esta
    // importação que criou — é assim que ela sabe desfazer só o que é dela.
    const before = snapshotIds();
    const resolved = resolveTargets(session, targets);
    // Pagamento de fatura só pode ser gravado depois que as compras da fatura
    // entraram e as faturas foram remontadas — antes disso não existe fatura
    // para pagar.
    const pendingPayments = [];

    for (const row of chosen) {
      try {
        const target = resolved[row.source] || resolved.default;
        writeRow(row, target, report, pendingPayments);
      } catch (error) {
        report.errors.push(`${row.description}: ${error.message}`);
        report.skipped++;
      }
    }

    // Categoria escolhida ou corrigida na revisão vira regra permanente.
    for (const row of chosen) {
      if (!row.categoryEdited || !row.category) continue;
      categorizer.learn(row.description, row.category, row.isIncome ? 'income' : 'variableExpense', 'user');
      report.learned++;
    }

    cards.rebuildInvoices();
    for (const pending of pendingPayments) {
      try {
        applyInvoicePayment(pending, resolved, report);
      } catch (error) {
        report.errors.push(`${pending.row.description}: ${error.message}`);
        report.skipped++;
      }
    }
    accounts.syncBalances();

    // Fotografia dos saldos iniciais tirada agora, antes da conciliação:
    // para as contas que já existiam é o valor de sempre, e para as que esta
    // importação acabou de criar é o valor de nascimento. Um retrato só
    // resolve os dois casos na hora de desfazer.
    const balancesBefore = accounts.list()
      .map(item => ({ id: item.id, initialBalance: toNumber(item.initialBalance) }));

    if (options.reconcile !== false) {
      report.reconciled = reconcileBalances(session, resolved);
    }

    report.batchId = recordBatch(session, before, balancesBefore, report);

    catalog.logActivity(
      'BATCH_IMPORTED',
      `${report.expenses + report.incomes + report.contributions} lançamento(s) importado(s) de ${session.documents.length} arquivo(s)`,
      'database', session.id
    );

    return report;
  });
}

// ---------------------------------------------------------------------------
// Desfazer uma importação
// ---------------------------------------------------------------------------

/**
 * Tabelas que uma importação pode alimentar. A ordem importa no momento de
 * apagar: filhos antes de pais.
 */
const TRACKED = [
  'expenses', 'card_purchases', 'incomes', 'investment_contributions',
  'transfers', 'investments', 'cards_benefits', 'bank_accounts'
];

const snapshotIds = () => Object.fromEntries(
  TRACKED.map(table => [table, new Set(repo.query(`SELECT id FROM ${table}`).map(item => item.id))])
);

/** O que nasceu nesta importação, por tabela. */
function addedSince(before) {
  const added = {};
  for (const table of TRACKED) {
    added[table] = repo.query(`SELECT id FROM ${table}`)
      .map(item => item.id)
      .filter(id => !before[table].has(id));
  }
  return added;
}

function recordBatch(session, before, balancesBefore, report) {
  const added = addedSince(before);
  const entries = TRACKED.reduce((acc, table) => acc + added[table].length, 0);
  if (!entries) return null;

  const item = {
    id: generateId('batch'),
    createdAt: now(),
    files: (session.documents || []).map(document => document.fileName).filter(Boolean).join(' · '),
    period: session.period ? `${session.period.start} → ${session.period.end}` : '',
    entries: report.expenses + report.incomes + report.contributions + report.withdrawals,
    payload: JSON.stringify({
      added,
      balancesBefore,
      // Faturas que esta importação fechou voltam a ficar abertas ao desfazer.
      paidInvoices: report.paidInvoices || []
    }),
    status: 'ATIVO'
  };
  repo.insert('import_batches', item);
  return item.id;
}

/**
 * Alguém ainda depende deste registro? Só vale para os "donos" — conta,
 * cartão e investimento. Lançamento não é dono de ninguém.
 */
const REFERENCES = {
  bank_accounts: [
    ['expenses', 'bank_account_id'], ['incomes', 'bank_account_id'],
    ['investment_contributions', 'bank_account_id'], ['transfers', 'from_account_id'],
    ['transfers', 'to_account_id'], ['card_invoices', 'paid_from_bank_account_id']
  ],
  cards_benefits: [
    ['card_purchases', 'credit_card_id'], ['card_installments', 'credit_card_id'],
    ['expenses', 'credit_card_id']
  ],
  investments: [['investment_contributions', 'investment_id'], ['goals', 'investment_id']]
};

function stillReferenced(table, id) {
  for (const [child, column] of REFERENCES[table] || []) {
    const found = repo.query(`SELECT 1 AS hit FROM ${child} WHERE ${column} = ? LIMIT 1`, [id]);
    if (found.length) return true;
  }
  return false;
}

function listBatches(limit = 10) {
  return repo.query('SELECT * FROM import_batches ORDER BY created_at DESC LIMIT ?', [limit])
    .map(item => ({ ...item, payload: undefined, undone: item.status === 'DESFEITO' }));
}

/**
 * Desfaz uma importação: apaga só o que ela criou, reabre as faturas que ela
 * fechou e devolve os saldos iniciais que ela ajustou. O que você registrou
 * depois, à mão, continua onde está — é a diferença entre isto e restaurar um
 * backup.
 */
function undoBatch(batchId) {
  return repo.transaction(() => {
    const batch = repo.findById('import_batches', batchId)
      || repo.query("SELECT * FROM import_batches WHERE status = 'ATIVO' ORDER BY created_at DESC LIMIT 1")[0];
    if (!batch) throw new Error('Nenhuma importação para desfazer.');
    if (batch.status === 'DESFEITO') throw new Error('Esta importação já foi desfeita.');

    const payload = JSON.parse(batch.payload || '{}');
    const added = payload.added || {};
    const removed = {};

    for (const table of TRACKED) {
      let count = 0;
      let kept = 0;
      for (const id of added[table] || []) {
        // O registro pode já ter sido apagado à mão, ou ter ido junto com o
        // pai (parcelas somem com a compra). Nenhum dos dois é erro.
        if (!repo.findById(table, id)) continue;
        // Conta, cartão ou investimento que a importação criou mas que já tem
        // lançamento seu pendurado fica de pé. Apagar levaria junto o que
        // você registrou à mão — ou pior, deixaria o lançamento apontando
        // para uma conta que não existe mais.
        if (stillReferenced(table, id)) { kept++; continue; }
        repo.remove(table, id);
        count++;
      }
      if (count) removed[table] = count;
      if (kept) (removed.kept = removed.kept || {})[table] = kept;
    }

    for (const paid of payload.paidInvoices || []) {
      const invoice = repo.query(
        'SELECT * FROM card_invoices WHERE credit_card_id = ? AND reference_month = ?',
        [paid.cardId, paid.reference]
      )[0];
      if (!invoice) continue;
      repo.update('card_invoices', invoice.id, { status: 'ABERTA', paidAt: '', paidFromBankAccountId: '' });
      repo.run(
        "UPDATE card_installments SET status = 'ABERTA', paid_at = '' WHERE credit_card_id = ? AND invoice_month = ?",
        [paid.cardId, paid.reference]
      );
    }

    for (const account of payload.balancesBefore || []) {
      const current = repo.findById('bank_accounts', account.id);
      if (!current) continue;
      if (roundCurrency(current.initialBalance) === roundCurrency(account.initialBalance)) continue;
      repo.update('bank_accounts', account.id, { initialBalance: roundCurrency(account.initialBalance) });
    }

    repo.update('import_batches', batch.id, { status: 'DESFEITO' });
    cards.rebuildInvoices();
    accounts.syncBalances();
    catalog.logActivity('BATCH_UNDONE', `Importação de ${batch.period || batch.createdAt.slice(0, 10)} desfeita`,
      'database', batch.id);

    return { removed, batch: { ...batch, payload: undefined, status: 'DESFEITO' } };
  });
}

/** Cria as contas e cartões que faltavam e devolve o destino de cada arquivo. */
function resolveTargets(session, targets) {
  const resolved = {};
  const fallbackAccount = accounts.list().find(item => item.status === 'ATIVA');
  // Dois arquivos do mesmo banco (o extrato e a fatura do Nubank, por exemplo)
  // não podem gerar duas contas iguais.
  const created = new Map();

  for (const document of session.documents) {
    const choice = targets[document.fileName] || {};
    let accountId = choice.accountId || null;
    let cardId = choice.cardId || null;

    if (choice.create) {
      const key = `${choice.create.kind}|${normalize(choice.create.bankName || choice.create.name)}`;
      if (created.has(key)) {
        const previous = created.get(key);
        accountId = previous.accountId || accountId;
        cardId = previous.cardId || cardId;
      } else if (choice.create.kind === 'card') {
        cardId = cards.create({
          name: choice.create.name,
          bankName: choice.create.bankName || choice.create.name,
          cardType: choice.create.cardType || 'CREDITO',
          // O cartão exige um limite maior que zero; sem o dado na fatura,
          // usa o total do documento como piso, para não travar a importação.
          limit: toNumber(choice.create.limit) > 0 ? toNumber(choice.create.limit) : 1000,
          closingDay: toNumber(choice.create.closingDay, 1),
          dueDay: toNumber(choice.create.dueDay, 10),
          color: choice.create.color || '#7c3aed'
        }).id;
        created.set(key, { cardId });
      } else {
        accountId = accounts.create({
          name: choice.create.name,
          bankName: choice.create.bankName || choice.create.name,
          accountType: choice.create.accountType || 'CONTA_DIGITAL',
          initialBalance: toNumber(choice.create.initialBalance),
          color: choice.create.color || '#4ea8ff'
        }).id;
        created.set(key, { accountId });
      }
    }

    resolved[document.fileName] = {
      // Fatura não tem conta própria: usa a conta padrão para o que for
      // movimento de dinheiro (estorno, pagamento).
      accountId: accountId || fallbackAccount?.id || accounts.list()[0]?.id || null,
      cardId,
      documentType: document.documentType,
      declaredFinalBalance: document.declaredFinalBalance
    };
  }

  resolved.default = { accountId: fallbackAccount?.id || null, cardId: null };
  return resolved;
}

/** Grava uma linha no lugar certo conforme a natureza detectada pelo leitor. */
function writeRow(row, target, report, pendingPayments = []) {
  const date = dateOnly(row.date);

  // Casou com uma fatura: fica para o fim, quando a fatura existir.
  if (row.kind === 'invoicePayment' && row.cardPayment) {
    pendingPayments.push({ row, target });
    return;
  }

  switch (row.kind) {
    case 'investment': {
      const investment = ensureInvestment(row.investmentName || row.description, target.accountId);
      investments.createContribution({
        investmentId: investment.id,
        bankAccountId: target.accountId,
        amount: Math.abs(row.amount),
        date,
        description: row.description
      });
      report.contributions++;
      return;
    }

    case 'investmentReturn': {
      const investment = ensureInvestment(row.investmentName || row.description, target.accountId);
      investments.createContribution({
        investmentId: investment.id,
        bankAccountId: target.accountId,
        amount: -Math.abs(row.amount),
        date,
        description: row.description
      });
      report.withdrawals++;
      return;
    }

    case 'invoicePayment': {
      // Vindo do extrato, é uma saída de dinheiro da conta. Fica registrada
      // como despesa na categoria do cartão, para o saldo fechar.
      transactions.createExpense({
        description: row.description || 'Pagamento de fatura',
        category: row.category || 'Outros',
        paymentMethod: 'DEBITO',
        bankAccountId: target.accountId,
        amount: Math.abs(row.amount),
        date,
        status: 'PAGO'
      });
      report.invoicePayments++;
      return;
    }

    case 'refund': {
      // Numa fatura, o estorno abate o próprio cartão. Num extrato de conta,
      // é dinheiro que voltou de verdade para a conta.
      if (target.documentType === 'fatura' && target.cardId) {
        transactions.createCardRefund({
          description: row.description || 'Estorno',
          category: row.category || 'Reembolso',
          creditCardId: target.cardId,
          amount: Math.abs(row.amount),
          date
        });
        report.refunds = (report.refunds || 0) + 1;
        return;
      }
      if (!target.accountId) throw new Error('Sem conta para registrar o estorno.');
      transactions.createIncome({
        source: row.description || 'Estorno',
        category: row.category || 'Reembolso',
        bankAccountId: target.accountId,
        amount: Math.abs(row.amount),
        date
      });
      report.incomes++;
      return;
    }

    case 'income': {
      transactions.createIncome({
        source: row.description,
        category: row.category || 'Outros',
        bankAccountId: target.accountId,
        amount: Math.abs(row.amount),
        date,
        description: ''
      });
      report.incomes++;
      return;
    }

    default: {
      // Compra de fatura entra no cartão; movimento de extrato, na conta.
      const onCard = target.documentType === 'fatura' && target.cardId;
      transactions.createExpense({
        description: row.description,
        category: row.category || 'Outros',
        paymentMethod: onCard ? 'CARTAO_CREDITO' : 'DEBITO',
        bankAccountId: onCard ? '' : target.accountId,
        creditCardId: onCard ? target.cardId : '',
        amount: Math.abs(row.amount),
        date,
        status: 'PAGO',
        installments: 1
      });
      report.expenses++;
    }
  }
}

/**
 * Fecha a fatura que a saída do extrato pagou.
 *
 * A conferência é refeita agora, e não na revisão: entre uma coisa e outra as
 * faturas foram remontadas e o total pode ter mudado (uma parcela de outro
 * mês entrou, por exemplo). Se o valor não bater na casa do centavo, o
 * pagamento vira saída comum — melhor uma despesa a mais na lista do que uma
 * fatura marcada como paga por um valor que não é o dela.
 */
function applyInvoicePayment({ row, target }, resolved, report) {
  const link = row.cardPayment || {};
  const cardId = link.cardId || (link.fileName ? resolved[link.fileName]?.cardId : null);
  const invoice = cardId && link.reference
    ? repo.query('SELECT * FROM card_invoices WHERE credit_card_id = ? AND reference_month = ?',
        [cardId, link.reference])[0]
    : null;

  const paid = roundCurrency(Math.abs(row.amount));
  const gap = invoice ? Math.abs(roundCurrency(invoice.totalAmount) - paid) : Infinity;
  const payable = invoice
    && invoice.status === 'ABERTA'
    && gap <= Math.max(0.10, roundCurrency(invoice.totalAmount) * 0.003);

  if (payable && target.accountId) {
    // A fatura fecha pelo valor que realmente saiu da conta. Quando a soma
    // das parcelas lidas dá alguns centavos a menos que a cobrança do banco,
    // quem tem razão é o extrato: foi esse dinheiro que sumiu do saldo.
    cards.payInvoice(invoice.id, target.accountId, paid);
    report.invoicePayments++;
    (report.paidInvoices = report.paidInvoices || []).push({ cardId, reference: link.reference });
    if (gap >= 0.01) report.paymentAdjustments = (report.paymentAdjustments || 0) + 1;
    return;
  }

  transactions.createExpense({
    description: row.description || 'Pagamento de fatura',
    category: row.category || 'Outros',
    paymentMethod: 'DEBITO',
    bankAccountId: target.accountId,
    amount: Math.abs(row.amount),
    date: dateOnly(row.date),
    status: 'PAGO'
  });
  report.invoicePayments++;
  report.unmatchedPayments = (report.unmatchedPayments || 0) + 1;
}

/** Encontra ou cria o investimento correspondente ao CDB citado no extrato. */
function ensureInvestment(name, accountId) {
  const clean = String(name || 'Investimento')
    .replace(/^(aplicacao|aplicação|resgate)\s*:?\s*/i, '')
    .replace(/["']/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60) || 'Investimento';
  // "CDB Porq Obj BANCO INTER S A" e "...INTER SA" são o mesmo produto escrito
  // com espaçamento diferente. Compara só letras e números.
  const key = value => normalize(value).replace(/[^a-z0-9]/g, '');
  const existing = investments.list().find(item => key(item.name) === key(clean));
  if (existing) return existing;

  const account = accountId ? accounts.list().find(item => item.id === accountId) : null;
  return investments.create({
    name: clean,
    type: /cdb|tesouro|renda fixa|poup/i.test(clean) ? 'RENDA_FIXA' : 'OUTROS',
    institution: account?.bankName || 'Importado',
    currentAmount: 0,
    goalAmount: 0
  });
}

/**
 * Ajusta o saldo inicial de cada conta para que o saldo calculado pelo app
 * bata com o saldo final declarado no extrato.
 *
 * É o passo que dispensa você de fazer conta: o extrato diz onde terminou, o
 * app sabe tudo que entrou e saiu, e a diferença é exatamente o que havia
 * antes do primeiro lançamento importado.
 */
function reconcileBalances(session, resolved) {
  const adjustments = [];

  for (const document of session.documents) {
    if (document.documentType !== 'extrato') continue;
    if (document.declaredFinalBalance == null) continue;

    const target = resolved[document.fileName];
    if (!target?.accountId) continue;

    const account = accounts.list().find(item => item.id === target.accountId);
    if (!account) continue;

    const difference = roundCurrency(document.declaredFinalBalance - account.currentBalance);
    if (Math.abs(difference) < 0.01) {
      adjustments.push({ account: account.name, alreadyMatched: true, balance: account.currentBalance });
      continue;
    }

    const initialBalance = roundCurrency(toNumber(account.initialBalance) + difference);
    accounts.update(account.id, { ...account, initialBalance });
    adjustments.push({
      account: account.name,
      declared: document.declaredFinalBalance,
      previous: account.currentBalance,
      adjustedInitialBalance: initialBalance,
      difference
    });
  }

  accounts.syncBalances();
  return adjustments;
}

module.exports = {
  readBatch, readPasted, buildSession, suggestTargets, commit, makeFingerprint,
  listBatches, undoBatch
};
