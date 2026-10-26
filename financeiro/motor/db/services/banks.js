'use strict';

const { dateOnly } = require('../utils');

/**
 * Leitores sob medida, um por banco.
 *
 * O leitor genérico procura "data + descrição + valor" em qualquer linha. Isso
 * funciona num extrato simples e falha feio nos reais:
 *
 *   Inter        — cada linha tem DOIS valores (o da transação e o saldo
 *                  corrente) e a data é um cabeçalho de bloco, não da linha.
 *   Santander    — coluna "Nº Documento" no meio e o sinal de débito vem como
 *                  um "-" DEPOIS do número: "387,19-".
 *   Mercado Pago — ID da operação entre a descrição e o valor, e a descrição
 *                  quebra em várias linhas.
 *   Faturas      — "09/10" no meio da linha é parcela 9 de 10, não uma data.
 *
 * Cada leitor devolve linhas já classificadas por natureza (`kind`), porque
 * "Aplicação em CDB" não é despesa: é dinheiro saindo da conta e entrando no
 * patrimônio. Tratar como gasto destruiria a sobra do mês.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MONTHS_PT = {
  janeiro: 1, fevereiro: 2, marco: 3, março: 3, abril: 4, maio: 5, junho: 6,
  julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12
};

const normalize = value =>
  String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/**
 * Converte um valor monetário brasileiro em número, respeitando as três
 * formas de indicar débito que os bancos usam: sinal antes, sinal depois
 * ("387,19-") e a letra D no fim.
 */
function parseBRL(raw) {
  if (raw === undefined || raw === null) return 0;
  const text = String(raw).trim();
  // Cada banco põe o sinal num lugar: "-R$ 190,00" (Inter), "R$ -50,00"
  // (Mercado Pago), "387,19-" (Santander) e "387,19 D". A regra que cobre os
  // três primeiros é olhar tudo que vem ANTES do primeiro dígito.
  const firstDigit = text.search(/\d/);
  const prefix = firstDigit >= 0 ? text.slice(0, firstDigit) : text;
  const negative = prefix.includes('-') || /-\s*$/.test(text)
    || /\bD$/i.test(text) || /^\(.*\)$/.test(text);
  const digits = text.replace(/[^\d,.]/g, '');
  if (!digits) return 0;
  const value = parseFloat(digits.replace(/\./g, '').replace(',', '.'));
  if (!Number.isFinite(value)) return 0;
  return negative ? -Math.abs(value) : value;
}

/** "5 de Janeiro de 2026" → "2026-01-05" */
function parseLongDate(day, monthName, year) {
  const month = MONTHS_PT[normalize(monthName)];
  if (!month) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(Number(day)).padStart(2, '0')}`;
}

/**
 * "04/07" precisa de um ano. Usa o período do documento e escolhe o ano que
 * faz a data cair dentro dele — é o que resolve uma fatura de janeiro que
 * inclui compras de dezembro do ano anterior.
 */
function resolveShortDate(day, month, period, fallbackYear) {
  const d = Number(day);
  const m = Number(month);
  if (!(d >= 1 && d <= 31 && m >= 1 && m <= 12)) return null;

  const candidates = [];
  if (period?.start && period?.end) {
    const startYear = Number(period.start.slice(0, 4));
    const endYear = Number(period.end.slice(0, 4));
    for (let year = startYear - 1; year <= endYear + 1; year++) candidates.push(year);
  } else {
    const base = Number(fallbackYear) || new Date().getFullYear();
    candidates.push(base, base - 1);
  }

  const iso = year => `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

  if (period?.start && period?.end) {
    // Primeiro tenta o ano que coloca a data DENTRO do período. Sem essa
    // preferência, uma compra de 10/07 numa fatura de julho/2026 podia cair
    // em 2025 só porque a janela tolerante também aceitava aquele ano.
    const exact = candidates.find(year => iso(year) >= period.start && iso(year) <= period.end);
    if (exact) return iso(exact);

    // Janela generosa: faturas listam parcelas de compras bem anteriores.
    const near = candidates
      .filter(year => iso(year) >= addDays(period.start, -420) && iso(year) <= addDays(period.end, 60))
      .sort((a, b) => Math.abs(distance(iso(a), period.start)) - Math.abs(distance(iso(b), period.start)));
    if (near.length) return iso(near[0]);
  }
  const base = Number(fallbackYear) || new Date().getFullYear();
  const guess = iso(base);
  const today = dateOnly(new Date());
  return guess > addDays(today, 45) ? iso(base - 1) : guess;
}

/** Diferença em dias entre duas datas ISO. */
function distance(a, b) {
  return (new Date(`${a}T12:00:00`) - new Date(`${b}T12:00:00`)) / 86400000;
}

function addDays(iso, days) {
  const date = new Date(`${iso}T12:00:00`);
  date.setDate(date.getDate() + days);
  return dateOnly(date);
}

/** Nome da pessoa/loja em "Cp :00360305-Lucicleide Duarte da Silva". */
function extractCounterparty(text) {
  const match = String(text).match(/"?\s*Cp\s*:?\s*[\d-]*-([^"]+)"?/i);
  return match ? match[1].trim() : String(text).replace(/^["']|["']$/g, '').trim();
}

/**
 * Nome de pessoa ou de estabelecimento? Um Pix para "LOUCOS POR COXINHA" é
 * consumo; para "Maria Clara Silva Braga" é transferência pessoal.
 */
const BUSINESS_HINTS = /\b(ltda|me|mei|eireli|sa|s\/a|comercio|comercial|servicos|restaurante|posto|mercado|super|farmacia|loja|padaria|lanches|pizzaria|bar|hotel|clinica|academia|escola|auto|distribuidora|industria|transportes|construcao|materiais|10xmais|pizza|coxinha|burguer|acai|cafe)\b/i;

function looksLikePerson(name) {
  const clean = String(name).trim();
  if (!clean) return false;
  if (BUSINESS_HINTS.test(normalize(clean))) return false;
  const words = clean.split(/\s+/).filter(Boolean);
  // 2 a 5 palavras, todas alfabéticas, sem números: cara de nome de gente.
  if (words.length < 2 || words.length > 5) return false;
  return words.every(word => /^[A-Za-zÀ-ÿ.']+$/.test(word));
}

/** Período do documento, para resolver datas curtas. */
function findPeriod(text) {
  let match = text.match(/Per[íi]odo:?\s*(?:De\s*)?(\d{2})[-/](\d{2})[-/](\d{4})\s*(?:a|al|至|-)\s*(\d{2})[-/](\d{2})[-/](\d{4})/i);
  if (match) {
    return {
      start: `${match[3]}-${match[2]}-${match[1]}`,
      end: `${match[6]}-${match[5]}-${match[4]}`
    };
  }
  match = text.match(/(\d{2})\s+DE\s+([A-ZÇa-zç]+)\s+DE\s+(\d{4})\s+a\s+(\d{2})\s+DE\s+([A-ZÇa-zç]+)\s+DE\s+(\d{4})/i);
  if (match) {
    const start = parseLongDate(match[1], match[2], match[3]);
    const end = parseLongDate(match[4], match[5], match[6]);
    if (start && end) return { start, end };
  }
  match = text.match(/Consumos de\s*(\d{2})\/(\d{2})\s*a\s*(\d{2})\/(\d{2})/i);
  if (match) {
    const year = (text.match(/\b(20\d{2})\b/) || [])[1] || String(new Date().getFullYear());
    return { start: `${year}-${match[2]}-${match[1]}`, end: `${year}-${match[4]}-${match[3]}` };
  }
  return null;
}

/** Um lançamento no formato interno dos leitores. */
const row = (date, description, amount, kind, extra = {}) => ({
  date,
  description: String(description).replace(/\s{2,}/g, ' ').trim(),
  amount: Math.abs(amount),
  isIncome: amount > 0,
  // expense | income | investment | investmentReturn | transfer | invoicePayment
  kind,
  ...extra
});

// ---------------------------------------------------------------------------
// Banco Inter
// ---------------------------------------------------------------------------

const inter = {
  id: 'inter',
  name: 'Inter',
  detect: text => /banco inter/i.test(text) || /Instituição:\s*Banco Inter/i.test(text),

  parse(text, context = {}) {
    const lines = text.split('\n');
    const period = findPeriod(text);
    const rows = [];
    let currentDate = null;

    // Saldo final declarado, para conferência depois da importação.
    const finalBalance = (text.match(/Saldo total\s+Saldo dispon[íi]vel:.*?\n\s*R\$\s*([\d.,]+)/is) || [])[1];

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      // Cabeçalho de dia: "5 de Janeiro de 2026 Saldo do dia: R$ 16,00"
      const dayHeader = line.match(/^(\d{1,2})\s+de\s+([A-Za-zÇç]+)\s+de\s+(\d{4})\b/i);
      if (dayHeader) {
        currentDate = parseLongDate(dayHeader[1], dayHeader[2], dayHeader[3]) || currentDate;
        continue;
      }
      if (!currentDate) continue;

      // Transação: descrição + valor + saldo corrente (dois valores no fim).
      const match = line.match(/^(.+?)\s+(-?R\$\s*[\d.,]+)\s+(-?R\$\s*[\d.,]+)\s*$/);
      if (!match) continue;

      const description = match[1].trim();
      const amount = parseBRL(match[2]);   // o segundo valor é o saldo, ignorado
      if (!amount) continue;

      rows.push(classifyInter(description, amount, currentDate));
    }

    return {
      rows,
      meta: {
        period,
        declaredFinalBalance: finalBalance ? parseBRL(finalBalance) : null,
        account: extractInterAccount(text)
      }
    };
  }
};

function extractInterAccount(text) {
  const match = text.match(/Ag[êe]ncia:\s*([\d-]+)\s*,?\s*Conta:\s*([\d-]+)/i);
  return match ? { bankName: 'Inter', agency: match[1], number: match[2] } : { bankName: 'Inter' };
}

/**
 * O Inter prefixa cada lançamento com o tipo. Usar esse prefixo é muito mais
 * confiável do que tentar adivinhar pela descrição.
 */
function classifyInter(description, amount, date) {
  const prefix = normalize(description);

  // Aplicação e Resgate do mesmo produto precisam cair no MESMO investimento,
  // então o nome vem sem o prefixo do tipo de operação.
  if (/^aplicacao/.test(prefix)) {
    return row(date, cleanInterLabel(description), amount, 'investment',
      { investmentName: cleanInterLabel(description) });
  }
  if (/^resgate/.test(prefix)) {
    return row(date, cleanInterLabel(description), amount, 'investmentReturn',
      { investmentName: cleanInterLabel(description) });
  }
  if (/^credito evento b3|^rendimento|^juros/.test(prefix)) {
    return row(date, cleanInterLabel(description), amount, 'income', { category: 'Investimentos' });
  }
  if (/^pix (enviado|recebido)/.test(prefix)) {
    const counterparty = extractCounterparty(description);
    const person = looksLikePerson(counterparty);
    return row(date, counterparty, amount, amount > 0 ? 'income' : 'expense',
      person ? { category: 'Transferências pessoais' } : {});
  }
  if (/pagamento de fatura|pagamento fatura|pagamento cartao/.test(prefix)) {
    return row(date, cleanInterLabel(description), amount, 'invoicePayment');
  }

  return row(date, cleanInterLabel(description), amount, amount > 0 ? 'income' : 'expense');
}

const cleanInterLabel = text =>
  String(text).replace(/^[^:]+:\s*/, '').replace(/^["']|["']$/g, '').trim() || String(text).trim();

// ---------------------------------------------------------------------------
// Santander
// ---------------------------------------------------------------------------

const santander = {
  id: 'santander',
  name: 'Santander',
  detect: text => /santander/i.test(text),

  parse(text, context = {}) {
    return context.documentType === 'fatura'
      ? parseSantanderInvoice(text)
      : parseSantanderStatement(text);
  }
};

function parseSantanderStatement(text) {
  const lines = text.split('\n');
  const rows = [];
  const period = findPeriod(text);
  const year = (text.match(/\b(20\d{2})\b/) || [])[1] || String(new Date().getFullYear());

  let inside = false;
  let declaredFinalBalance = null;
  let lastDate = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (/^Movimenta[çc][ãa]o$/i.test(line)) { inside = true; continue; }
    if (/^Saldos por Per[íi]odo|^Investimentos|^Cart[õo]es de Cr[ée]dito/i.test(line)) { inside = false; continue; }
    if (!inside || !line) continue;

    const balanceLine = line.match(/^SALDO EM\s+(\d{2})\/(\d{2})\s+([\d.,]+)(-?)/i);
    if (balanceLine) {
      declaredFinalBalance = parseBRL(balanceLine[3] + balanceLine[4]);
      continue;
    }
    if (/^Data\s+Descri|^Conta Corrente$/i.test(line)) continue;

    // "01/06 PIX RECEBIDO - 387,19" ou "01/06 DESCRIÇÃO 105017 387,19- 0,76"
    let match = line.match(/^(\d{2})\/(\d{2})\s+(.+?)\s+([\d.]{0,12}[\d],\d{2})(-?)(?:\s+([\d.]*[\d],\d{2})(-?))?\s*$/);
    let date = match ? resolveShortDate(match[1], match[2], period, year) : null;

    // O PDF do Santander às vezes joga a data numa linha e o lançamento na
    // seguinte. Sem data no começo, a linha herda o dia corrente do bloco.
    if (!match && lastDate) {
      const orphan = line.match(/^(.+?)\s+([\d.]{0,12}[\d],\d{2})(-?)(?:\s+([\d.]*[\d],\d{2})(-?))?\s*$/);
      if (orphan && /\d{4,}/.test(orphan[1])) {
        match = [null, null, null, orphan[1], orphan[2], orphan[3], orphan[4], orphan[5]];
        date = lastDate;
      }
    }
    if (!match || !date) continue;
    lastDate = date;

    // Quando há dois números, o primeiro é o movimento e o segundo o saldo.
    const amount = parseBRL(match[4] + match[5]);
    if (!amount) continue;

    let description = match[3].replace(/\s+-\s*$/, '').replace(/\s+\d{5,}\s*$/, '').trim();
    if (!description) continue;

    rows.push(classifySantander(description, amount, date));
  }

  return { rows, meta: { period, declaredFinalBalance, account: extractSantanderAccount(text) } };
}

function classifySantander(description, amount, date) {
  const normalized = normalize(description);
  if (/pagamento cartao|pagamento de fatura/.test(normalized)) {
    return row(date, description, amount, 'invoicePayment');
  }
  if (/^pix recebido|^ted recebida|^deposito/.test(normalized)) {
    return row(date, description, Math.abs(amount), 'income');
  }
  if (/^pix enviado|^ted enviada/.test(normalized)) {
    return row(date, description, -Math.abs(amount), 'expense');
  }
  return row(date, description, amount, amount > 0 ? 'income' : 'expense');
}

function extractSantanderAccount(text) {
  const match = text.match(/Ag[êe]ncia\s*:?\s*(\d{3,5})[^\d]{0,6}Conta\s*:?\s*([\d.-]+)/i);
  return match ? { bankName: 'Santander', agency: match[1], number: match[2] } : { bankName: 'Santander' };
}

function parseSantanderInvoice(text) {
  const lines = text.split('\n');
  const rows = [];
  const period = findPeriod(text);
  const year = (text.match(/\b(20\d{2})\b/) || [])[1] || String(new Date().getFullYear());
  const cardLast4 = (text.match(/(\d{4})\s*$/m) || text.match(/XXXX\s*(\d{4})/i) || [])[1];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.length < 8) continue;
    if (/^(total|subtotal|limite|saldo|juros|iof|encargos|multa|parcelamento|vencimento|pague|valor desta)/i.test(line)) continue;

    // "22/09 ZP *OLX IGOR NATA01750 09/10 182,60"  → parcela 9 de 10
    // "31/05 PAGAMENTO DE FATURA-INTERNET -387,19" → crédito
    const match = line.match(/^(\d{2})\/(\d{2})\s+(.+?)(?:\s+(\d{2})\/(\d{2}))?\s+(-?[\d.]*[\d],\d{2})-?\s*$/);
    if (!match) continue;

    const date = resolveShortDate(match[1], match[2], period, year);
    if (!date) continue;

    const rawAmount = match[6];
    const amount = parseBRL(rawAmount);
    if (!amount) continue;

    const description = match[3].trim();
    const installment = match[4] && match[5]
      ? { number: Number(match[4]), total: Number(match[5]) }
      : null;

    // Na fatura, valor negativo é pagamento ou estorno.
    const normalized = normalize(description);
    const kind = /pagamento de fatura|pagamento fatura/.test(normalized)
      ? 'invoicePayment'
      : amount < 0 ? 'refund' : 'expense';

    rows.push(row(date, description, amount < 0 ? amount : -amount, kind, { installment, cardLast4 }));
  }

  const terms = findInvoiceTerms(text);
  return { rows, meta: { period, cardLast4, terms,
    invoiceReference: findInvoiceReference(text, period, terms),
    account: { bankName: 'Santander' } } };
}

// ---------------------------------------------------------------------------
// Mercado Pago
// ---------------------------------------------------------------------------

const mercadoPago = {
  id: 'mercadopago',
  name: 'Mercado Pago',
  detect: text => /mercado\s*pago/i.test(text),

  parse(text, context = {}) {
    return context.documentType === 'fatura'
      ? parseMercadoPagoInvoice(text)
      : parseMercadoPagoStatement(text);
  }
};

function parseMercadoPagoStatement(text) {
  const lines = text.split('\n').map(line => line.trim());
  const rows = [];
  const period = findPeriod(text);
  const declaredFinalBalance = parseBRL((text.match(/Saldo final:\s*(R\$\s*[\d.,-]+)/i) || [])[1]);

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    // "01-07-2026 Descrição 166762474124 R$ 25,00 R$ 25,57"
    const match = line.match(/^(\d{2})-(\d{2})-(\d{4})\s+(.*?)\s*(\d{9,})\s+(R\$\s*-?[\d.,]+)\s+(R\$\s*-?[\d.,]+)\s*$/);
    if (!match) continue;

    const date = `${match[3]}-${match[2]}-${match[1]}`;
    const amount = parseBRL(match[6]);
    if (!amount) continue;

    // A descrição quebra em várias linhas: o começo vem antes da linha da data
    // e a continuação depois. Linhas sem número são pedaços da descrição.
    const isFragment = candidate =>
      candidate && !/\d{9,}/.test(candidate) && !/R\$/.test(candidate)
      && !/^\d{2}-\d{2}-\d{4}/.test(candidate) && !/^(Data|Extrato|Per[íi]odo|Saldo|Entradas|Saidas|\d+\/\d+)$/i.test(candidate)
      && candidate.length > 2;

    const before = isFragment(lines[index - 1]) ? lines[index - 1] : '';
    const after = isFragment(lines[index + 1]) ? lines[index + 1] : '';
    const description = [before, match[4], after].filter(Boolean).join(' ').replace(/\s{2,}/g, ' ').trim();

    rows.push(classifyMercadoPago(description || 'Movimentação', amount, date));
  }

  return { rows, meta: { period, declaredFinalBalance, account: extractMercadoPagoAccount(text) } };
}

function classifyMercadoPago(description, amount, date) {
  const normalized = normalize(description);
  if (/^rendimento/.test(normalized)) {
    return row(date, 'Rendimento da conta', amount, 'income', { category: 'Investimentos' });
  }
  if (/pagamento (da )?fatura/.test(normalized)) {
    return row(date, description, amount, 'invoicePayment');
  }
  if (/^pix (recebido|enviado)/.test(normalized)) {
    const counterparty = description.replace(/^pix (recebido|enviado)\s*/i, '').trim();
    return row(date, counterparty || description, amount, amount > 0 ? 'income' : 'expense',
      looksLikePerson(counterparty) ? { category: 'Transferências pessoais' } : {});
  }
  return row(date, description, amount, amount > 0 ? 'income' : 'expense');
}

function extractMercadoPagoAccount(text) {
  const match = text.match(/Ag[êe]ncia:\s*(\d+)\s*Conta:\s*(\d+)/i);
  return match ? { bankName: 'Mercado Pago', agency: match[1], number: match[2] } : { bankName: 'Mercado Pago' };
}

function parseMercadoPagoInvoice(text) {
  const lines = text.split('\n').map(line => line.trim());
  const rows = [];
  const period = findPeriod(text);
  const year = (text.match(/\b(20\d{2})\b/) || [])[1] || String(new Date().getFullYear());
  let cardLast4 = null;

  for (const line of lines) {
    const cardHeader = line.match(/Cart[ãa]o\s+\w+\s*\[?\**(\d{4})\]?/i);
    if (cardHeader) { cardLast4 = cardHeader[1]; continue; }

    if (/^(total|resumo|consumos de|tarifas|multas|juros|informa)/i.test(line)) continue;

    // "04/07 CABANA GUARANA R$ 21,00"
    const match = line.match(/^(\d{2})\/(\d{2})\s+(.+?)\s+R\$\s*(-?[\d.]*[\d],\d{2})\s*$/);
    if (!match) continue;

    const date = resolveShortDate(match[1], match[2], period, year);
    if (!date) continue;

    const amount = parseBRL(match[4]);
    if (!amount) continue;

    const description = match[3].trim();
    const normalized = normalize(description);
    const kind = /pagamento da fatura|pagamento fatura/.test(normalized)
      ? 'invoicePayment'
      : amount < 0 ? 'refund' : 'expense';

    // Parcela no fim da descrição, nas três formas que aparecem:
    // "2/5", "Parcela 2/5" e "Parcela 2 de 5".
    const installmentMatch = description.match(/parcela\s*(\d{1,2})\s*de\s*(\d{1,2})\s*$/i)
      || description.match(/(?:parcela\s*)?(\d{1,2})\s*\/\s*(\d{1,2})\s*$/i);
    const installment = installmentMatch
      ? { number: Number(installmentMatch[1]), total: Number(installmentMatch[2]) }
      : null;

    const cleanDescription = installment
      ? description.replace(/\s*(?:-\s*)?parcela\s*\d{1,2}\s*(?:de|\/)\s*\d{1,2}\s*$/i, '')
                   .replace(/\s*(?:-\s*)?\d{1,2}\s*\/\s*\d{1,2}\s*$/i, '').trim()
      : description;
    rows.push(row(date, cleanDescription,
      amount < 0 ? amount : -amount, kind, { installment, cardLast4 }));
  }

  const terms = findInvoiceTerms(text);
  return { rows, meta: { period, cardLast4, terms,
    invoiceReference: findInvoiceReference(text, period, terms),
    account: { bankName: 'Mercado Pago' } } };
}

// ---------------------------------------------------------------------------
// Nubank
// ---------------------------------------------------------------------------

const nubank = {
  id: 'nubank',
  name: 'Nubank',
  detect: text => /nubank|nu pagamentos|nu financeira/i.test(text),

  parse(text, context = {}) {
    // O CSV de fatura do Nubank é o formato mais limpo que existe.
    if (/^date,title,amount/im.test(text)) return parseNubankCSV(text);
    return parseNubankStatement(text);
  }
};

function parseNubankCSV(text) {
  const lines = text.split(/\r?\n/).filter(line => line.trim());
  const rows = [];

  for (const line of lines.slice(1)) {
    const match = line.match(/^(\d{4}-\d{2}-\d{2}),(.*),"?\s*(-?\s*[\d.]*[\d],\d{2})"?\s*$/);
    if (!match) continue;

    const amount = parseBRL(match[3]);
    if (!amount) continue;

    let description = match[2].replace(/^"|"$/g, '').trim();
    const installmentMatch = description.match(/-\s*Parcela\s*(\d{1,2})\/(\d{1,2})\s*$/i);
    const installment = installmentMatch
      ? { number: Number(installmentMatch[1]), total: Number(installmentMatch[2]) }
      : null;
    if (installment) description = description.replace(/-\s*Parcela\s*\d{1,2}\/\d{1,2}\s*$/i, '').trim();

    const normalized = normalize(description);
    const kind = /pagamento recebido|pagamento de fatura/.test(normalized)
      ? 'invoicePayment'
      : amount < 0 ? 'refund' : 'expense';

    rows.push(row(match[1], description, amount < 0 ? amount : -amount, kind, { installment }));
  }

  return { rows, meta: { invoiceReference: null, terms: findInvoiceTerms(text), account: { bankName: 'Nubank' } } };
}

function parseNubankStatement(text) {
  const period = findPeriod(text);
  const account = (text.match(/Ag[êe]ncia\s*(\d+)\s*Conta\s*\n?\s*([\d-]+)/i) || []);

  // O extrato sem movimentação diz isso com todas as letras. Reconhecer a
  // frase evita mostrar "não consegui ler" para um arquivo perfeitamente bom.
  if (/Nenhuma movimenta[çc][ãa]o realizada/i.test(text)) {
    return {
      rows: [],
      meta: {
        period,
        empty: true,
        emptyReason: 'Este extrato não tem nenhuma movimentação no período.',
        account: { bankName: 'Nubank', agency: account[1], number: account[2] }
      }
    };
  }

  const rows = [];
  const lines = text.split('\n').map(line => line.trim());
  let currentDate = null;

  for (const line of lines) {
    const dayHeader = line.match(/^(\d{1,2})\s+DE\s+([A-ZÇa-zç]+)(?:\s+DE\s+(\d{4}))?\s*$/i);
    if (dayHeader) {
      currentDate = parseLongDate(dayHeader[1], dayHeader[2], dayHeader[3] || period?.start?.slice(0, 4) || new Date().getFullYear()) || currentDate;
      continue;
    }

    const match = line.match(/^(.+?)\s+([-+]?\s*R?\$?\s*[\d.]*[\d],\d{2})\s*$/);
    if (!match || !currentDate) continue;
    if (/^(saldo|total|rendimento l[íi]quido)/i.test(match[1])) continue;

    const amount = parseBRL(match[2]);
    if (!amount) continue;
    rows.push(row(currentDate, match[1].trim(), amount, amount > 0 ? 'income' : 'expense'));
  }

  return { rows, meta: { period, account: { bankName: 'Nubank', agency: account[1], number: account[2] } } };
}

// ---------------------------------------------------------------------------
// Registro
// ---------------------------------------------------------------------------

const PARSERS = [inter, nubank, santander, mercadoPago];

/**
 * Identifica o banco pelo conteúdo. Quando o arquivo não se identifica — o CSV
 * de fatura do Nubank tem só "date,title,amount" — o nome do arquivo resolve.
 */
function detectBank(text, fileName = '') {
  const head = String(text).slice(0, 6000);
  const found = PARSERS.find(bank => bank.detect(head));
  if (found) return found;

  const name = normalize(fileName);
  return PARSERS.find(bank => name.includes(bank.id) || name.includes(normalize(bank.name))) || null;
}

/**
 * Condições do cartão, lidas da própria fatura: dia de fechamento, dia de
 * vencimento e limite.
 *
 * Sem isso o cartão criado na importação nasce com valores inventados, e aí
 * cada compra cai na fatura errada — uma compra de 2 de julho ia parar na
 * fatura de agosto só porque o fechamento chutado era dia 1.
 *
 * Os três dados aparecem em lugares diferentes conforme o banco, mas seguem
 * um padrão comum: na linha do vencimento, o valor em reais que vem DEPOIS da
 * data é o limite.
 */
function findInvoiceTerms(text) {
  const lines = String(text).split('\n');
  const terms = { closingDay: null, dueDay: null, dueDate: null, limit: null };

  // Fechamento: dito com todas as letras, ou implícito em "compras até DD/MM".
  let match = text.match(/Fechamento(?:\s+da\s+fatura)?:?\s*(\d{2})\/(\d{2})(?:\/(\d{4}))?/i)
    || text.match(/(?:compras\s+(?:e\s+pagamentos\s+)?realizad[ao]s?\s+at[ée]|per[íi]odo\s+at[ée])\s*(\d{2})\/(\d{2})/i)
    || text.match(/Consumos de\s*\d{2}\/\d{2}\s*a\s*(\d{2})\/(\d{2})/i);
  if (match) terms.closingDay = Number(match[1]);

  // Vencimento: o rótulo costuma ficar numa linha e a data na seguinte.
  //
  // A palavra "vencimento" aparece várias vezes num contrato de fatura, quase
  // sempre em frases de rodapé ("...até a data de vencimento serão cobrados
  // encargos..."). Por isso não paramos na primeira ocorrência: juntamos todas
  // as candidatas e preferimos a que também traz o limite ao lado, porque essa
  // é a linha da tabela de resumo, não do texto corrido.
  const candidates = [];
  for (let index = 0; index < lines.length; index++) {
    if (!/venc(e|imento)/i.test(lines[index])) continue;

    for (let offset = 0; offset <= 2 && index + offset < lines.length; offset++) {
      const line = lines[index + offset];
      const date = line.match(/\b(\d{2})\/(\d{2})\/(\d{4})\b/);
      if (!date) continue;

      // O limite é o valor em reais logo depois da data, na mesma linha.
      const after = line.slice(date.index + date[0].length);
      const money = after.match(/R\$\s*([\d.]+,\d{2})/);

      candidates.push({
        dueDay: Number(date[1]),
        dueDate: `${date[3]}-${date[2]}-${date[1]}`,
        limit: money ? parseBRL(money[1]) : null
      });
      break;
    }
  }

  const best = candidates.find(item => item.limit) || candidates[0];
  if (best) {
    terms.dueDay = best.dueDay;
    terms.dueDate = best.dueDate;
    terms.limit = best.limit;
  }

  // Limite dito explicitamente ganha do que foi deduzido pela posição.
  // O `[^\n\d]` é essencial: sem ele o casamento atravessa a quebra de linha
  // e captura o "Total a Pagar" da linha seguinte em vez do limite.
  const explicit = text.match(/(?:Limite total|Seu lim[it]+e [ée]|Limite de cr[ée]dito)[^\n\d]{0,60}R\$\s*([\d.]+,\d{2})/i);
  if (explicit) {
    // Só vale se for maior que zero: a fatura do Santander traz um campo
    // "Limite total R$0,00" zerado que, aceito às cegas, apagava o limite
    // correto lido da tabela de resumo.
    const value = parseBRL(explicit[1]);
    if (value > 0) terms.limit = value;
  }

  return terms;
}

/** Mês de referência da fatura — é nele que as parcelas do mês são lançadas. */
function findInvoiceReference(text, period, terms = null) {
  // O mês do fechamento é a referência mais fiel: é o ciclo que a fatura cobre.
  const closing = text.match(/Fechamento(?:\s+da\s+fatura)?:?\s*(\d{2})\/(\d{2})\/(\d{4})/i);
  if (closing) return `${closing[3]}-${closing[2]}`;

  if (period?.end) return period.end.slice(0, 7);

  if (terms?.dueDate) {
    // Sem fechamento declarado, o vencimento costuma ser no mês seguinte.
    const [year, month] = terms.dueDate.split('-').map(Number);
    const previous = month === 1 ? { m: 12, y: year - 1 } : { m: month - 1, y: year };
    return `${previous.y}-${String(previous.m).padStart(2, '0')}`;
  }
  return null;
}

/**
 * Lê o documento com o leitor do banco identificado.
 * Devolve `null` quando não conhece o banco — aí o chamador cai no genérico.
 */
function parse(text, context = {}) {
  const bank = detectBank(text, context.fileName);
  if (!bank) return null;
  const result = bank.parse(text, context);

  /**
   * Numa fatura, a parcela do mês pertence ao mês da fatura, não ao dia da
   * compra original. Sem isso, importar 12 faturas espalharia as parcelas
   * pelos meses de compra e o total de cada mês sairia errado.
   */
  const reference = result.meta?.invoiceReference;
  if (context.documentType === 'fatura' && reference) {
    /**
     * Tudo que está listado numa fatura pertence ao ciclo dela — por definição.
     *
     * Mas a data que a fatura mostra é a da COMPRA, que pode ser de meses
     * atrás: uma parcela 9/10, ou o estorno de algo comprado em maio. Deixar
     * essas linhas com a data original as joga em faturas antigas e o total
     * do mês não fecha com o do banco.
     *
     * Então: quem tem data dentro do ciclo mantém a data real (é informação
     * útil); quem está fora é trazido para o mês da fatura.
     */
    const closing = result.meta?.terms?.closingDay;
    const ceiling = closing && closing >= 1 && closing <= 28 ? closing : 28;

    const [refYear, refMonth] = reference.split('-').map(Number);
    const cycleEnd = `${reference}-${String(ceiling).padStart(2, '0')}`;
    const previous = refMonth === 1 ? { y: refYear - 1, m: 12 } : { y: refYear, m: refMonth - 1 };
    const cycleStart = `${previous.y}-${String(previous.m).padStart(2, '0')}-${String(ceiling).padStart(2, '0')}`;

    for (const item of result.rows) {
      if (item.date >= cycleStart && item.date <= cycleEnd) continue;
      item.purchaseDate = item.date;
      const day = Math.min(Number(item.date.slice(8, 10)) || 1, ceiling);
      item.date = `${reference}-${String(day).padStart(2, '0')}`;
    }
  }

  return { bankId: bank.id, bankName: bank.name, ...result };
}

module.exports = {
  PARSERS,
  findInvoiceTerms,
  detectBank,
  parse,
  parseBRL,
  looksLikePerson,
  findPeriod,
  resolveShortDate
};
