'use strict';

const { toNumber, dateOnly, addMonths } = require('../utils');

/**
 * Motor determinístico de interpretação de texto.
 *
 * Este arquivo NÃO usa IA. Ele extrai por regra tudo que é objetivo numa frase
 * financeira: valor, data (inclusive relativa), forma de pagamento, número de
 * parcelas, e qual conta ou cartão foi citado.
 *
 * A razão de existir: modelos pequenos erram justamente nisso. No teste que
 * motivou esta reescrita, o llama3.2:3b leu "no crédito ... em 3x" e respondeu
 * DEBITO, e leu "anteontem" e respondeu a data de hoje. Uma expressão regular
 * acerta os dois casos sempre, em zero milissegundo.
 *
 * A IA entra só depois, e só para o que é subjetivo: escolher a categoria e
 * limpar a descrição. Ela nunca sobrescreve o que foi extraído aqui.
 */

const normalize = value =>
  String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

// ---------------------------------------------------------------------------
// Valor
// ---------------------------------------------------------------------------

const MULTIPLIERS = [
  { pattern: /\b(\d+(?:[.,]\d+)?)\s*(mil|k)\b/i, factor: 1000 },
  { pattern: /\b(\d+(?:[.,]\d+)?)\s*(mi|milh(?:ao|oes|ão|ões))\b/i, factor: 1000000 }
];

/** "1.234,56" → 1234.56 · "1,234.56" → 1234.56 · "1234" → 1234 */
function parseAmountToken(token) {
  let value = String(token).replace(/[^\d.,]/g, '');
  if (!value) return 0;

  const lastComma = value.lastIndexOf(',');
  const lastDot = value.lastIndexOf('.');

  if (lastComma > lastDot) {
    // Padrão brasileiro: ponto agrupa milhar, vírgula separa centavos.
    value = value.replace(/\./g, '').replace(',', '.');
  } else if (lastDot > lastComma) {
    // Padrão americano, ou só milhar com ponto ("1.850" sem centavos).
    const decimals = value.length - lastDot - 1;
    value = decimals === 3 && lastComma === -1
      ? value.replace(/\./g, '')       // 1.850 → 1850
      : value.replace(/,/g, '');       // 1,234.56 → 1234.56
  }
  return parseFloat(value) || 0;
}

/**
 * Acha o valor na frase. Ignora números que claramente não são dinheiro:
 * o "3" de "3x", o "12" de "12/08", o "2" de "2 unidades".
 */
function extractAmount(text) {
  for (const { pattern, factor } of MULTIPLIERS) {
    const match = text.match(pattern);
    if (match) return { amount: parseAmountToken(match[1]) * factor, token: match[0] };
  }

  // Remove trechos que contêm números não-monetários antes de procurar.
  const cleaned = String(text)
    .replace(/\b\d{1,2}\s*x\b/gi, ' ')                    // 3x, 12 x
    .replace(/\b\d{1,2}[/\-]\d{1,2}(?:[/\-]\d{2,4})?\b/g, ' ') // 12/08, 12/08/2026
    .replace(/\bdia\s+\d{1,2}\b/gi, ' ')                  // dia 15
    .replace(/\b\d{1,2}h(?:\d{2})?\b/gi, ' ');            // 14h30

  // A primeira alternativa exige pelo menos um separador de milhar; sem isso
  // ela engoliria só os 3 primeiros dígitos de "3200" e devolveria 320.
  const candidates = [...cleaned.matchAll(
    /(?<![\d.,])(?:r\$\s*)?(\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)(?![\d])/gi
  )]
    .map(match => ({ amount: parseAmountToken(match[1]), token: match[0], hasCurrency: /r\$/i.test(match[0]) }))
    .filter(item => item.amount > 0);

  if (!candidates.length) return { amount: 0, token: '' };
  // "R$ 84,90" ganha de um número solto; entre números soltos, o maior vence.
  const withCurrency = candidates.filter(item => item.hasCurrency);
  const pool = withCurrency.length ? withCurrency : candidates;
  return pool.reduce((best, item) => (item.amount > best.amount ? item : best));
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

const WEEKDAYS = {
  domingo: 0, segunda: 1, terca: 2, quarta: 3, quinta: 4, sexta: 5, sabado: 6
};

const MONTH_NAMES = {
  janeiro: 1, fevereiro: 2, marco: 3, abril: 4, maio: 5, junho: 6,
  julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
  jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6,
  jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12
};

const shift = (base, days) => {
  const date = new Date(`${base}T12:00:00`);
  date.setDate(date.getDate() + days);
  return dateOnly(date);
};

/**
 * Entende data absoluta e relativa. É onde o modelo pequeno mais tropeça:
 * "anteontem", "sexta passada" e "dia 5" exigem contar a partir de hoje.
 */
function extractDate(text, today = dateOnly(new Date())) {
  const normalized = normalize(text);

  // ISO puro vem primeiro: "2026-07-27" é inequívoco e não deve competir com
  // as heurísticas de data brasileira.
  const isoMatch = String(text).match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (isoMatch) return { date: isoMatch[0], token: isoMatch[0] };

  if (/\banteontem\b/.test(normalized)) return { date: shift(today, -2), token: 'anteontem' };
  if (/\bontem\b/.test(normalized)) return { date: shift(today, -1), token: 'ontem' };
  if (/\bhoje\b/.test(normalized)) return { date: today, token: 'hoje' };
  if (/\bamanha\b/.test(normalized)) return { date: shift(today, 1), token: 'amanhã' };
  if (/\bdepois de amanha\b/.test(normalized)) return { date: shift(today, 2), token: 'depois de amanhã' };

  // "há 3 dias", "3 dias atrás", "faz 2 semanas"
  let match = normalized.match(/\b(?:ha|faz)\s+(\d+)\s+(dia|semana|mes|mês)/);
  if (!match) match = normalized.match(/\b(\d+)\s+(dia|semana|mes|mês)s?\s+atras/);
  if (match) {
    const count = Number(match[1]);
    const unit = match[2];
    if (unit.startsWith('dia')) return { date: shift(today, -count), token: match[0] };
    if (unit.startsWith('semana')) return { date: shift(today, -count * 7), token: match[0] };
    return { date: addMonths(today, -count), token: match[0] };
  }

  // "sexta passada", "na terça"
  match = normalized.match(/\b(domingo|segunda|terca|quarta|quinta|sexta|sabado)(?:\s*-?\s*feira)?\s*(passad[ao]|retrasad[ao])?/);
  if (match) {
    const target = WEEKDAYS[match[1]];
    const current = new Date(`${today}T12:00:00`).getDay();
    let back = (current - target + 7) % 7;
    if (back === 0) back = 7;                       // "na sexta" numa sexta = a anterior
    if (match[2]?.startsWith('retrasad')) back += 7;
    return { date: shift(today, -back), token: match[0] };
  }

  // "12/08", "12/08/2026", "12-08-26"
  match = text.match(/\b(\d{1,2})[/\-.](\d{1,2})(?:[/\-.](\d{2,4}))?\b/);
  if (match) {
    const day = Number(match[1]);
    const month = Number(match[2]);
    let year = match[3] ? Number(match[3]) : Number(today.slice(0, 4));
    if (year < 100) year += 2000;
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      // Sem ano informado e a data caiu no futuro? Era do ano passado.
      const resolved = !match[3] && iso > today ? `${year - 1}${iso.slice(4)}` : iso;
      return { date: resolved, token: match[0] };
    }
  }

  // "5 de agosto", "5 de ago"
  match = normalized.match(/\b(\d{1,2})\s+de\s+([a-z]+)/);
  if (match && MONTH_NAMES[match[2]]) {
    const day = Number(match[1]);
    const month = MONTH_NAMES[match[2]];
    const year = Number(today.slice(0, 4));
    const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return { date: iso > today ? `${year - 1}${iso.slice(4)}` : iso, token: match[0] };
  }

  // "dia 15" — o dia 15 mais recente que já passou.
  match = normalized.match(/\bdia\s+(\d{1,2})\b/);
  if (match) {
    const day = Number(match[1]);
    const [year, month] = today.split('-').map(Number);
    const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return { date: iso > today ? addMonths(iso, -1) : iso, token: match[0] };
  }

  return { date: today, token: '' };
}

// ---------------------------------------------------------------------------
// Forma de pagamento
// ---------------------------------------------------------------------------

/**
 * A ordem importa: "crédito" é testado antes de "cartão" porque
 * "cartão de crédito" contém as duas palavras, e antes de "débito" porque
 * "cartão de débito" também. Padrões mais específicos primeiro.
 */
const PAYMENT_PATTERNS = [
  // "débito automático" é cobrança em conta, não cartão de débito — precisa
  // ser testado antes do "débito" solto.
  { method: 'PIX', pattern: /\bdebito automatico\b/ },
  { method: 'CARTAO_CREDITO', pattern: /\b(credito|cred|no cartao|cartao de credito|parcelad[oa]|\d+\s*x\b)/ },
  { method: 'DEBITO', pattern: /\b(debito|deb|cartao de debito|maquininha)\b/ },
  { method: 'VALE_BENEFICIO', pattern: /\b(vale|beneficio|refeicao|alimentacao|va\b|vr\b|alelo|sodexo|ticket|caju|flash)\b/ },
  { method: 'DINHEIRO', pattern: /\b(dinheiro|especie|cash|em maos|papel)\b/ },
  { method: 'PIX', pattern: /\b(pix|transferencia|ted|doc|boleto|debito automatico)\b/ }
];

function extractPaymentMethod(text) {
  const normalized = normalize(text);
  for (const { method, pattern } of PAYMENT_PATTERNS) {
    const match = normalized.match(pattern);
    if (match) return { method, token: match[0], explicit: true };
  }
  return { method: 'PIX', token: '', explicit: false };
}

// ---------------------------------------------------------------------------
// Parcelas
// ---------------------------------------------------------------------------

function extractInstallments(text) {
  const normalized = normalize(text);
  // "3x", "em 3 vezes", "parcelado em 10"
  const match = normalized.match(/\b(\d{1,2})\s*x\b/)
    || normalized.match(/\bem\s+(\d{1,2})\s*(?:vezes|parcelas)/)
    || normalized.match(/\bparcelad[oa]\s+em\s+(\d{1,2})/);
  const count = match ? Number(match[1]) : 1;
  return Math.min(60, Math.max(1, count));
}

// ---------------------------------------------------------------------------
// Entrada ou saída
// ---------------------------------------------------------------------------

const INCOME_WORDS = /\b(recebi|receber|salario|entrada|freela|renda|caiu|caiu na conta|pix recebido|vendi|venda|reembolso|restituicao|cashback|rendimento|dividendo|premio|deposito)\b/;
const EXPENSE_WORDS = /\b(paguei|pagar|gastei|comprei|comprar|saiu|debitado|torrei|assinei)\b/;

function extractDirection(text) {
  const normalized = normalize(text);
  if (EXPENSE_WORDS.test(normalized)) return { isIncome: false, explicit: true };
  if (INCOME_WORDS.test(normalized)) return { isIncome: true, explicit: true };
  return { isIncome: false, explicit: false };
}

// ---------------------------------------------------------------------------
// Conta e cartão citados pelo nome
// ---------------------------------------------------------------------------

/**
 * Casa "nubank" com o cartão "Ultravioleta · Nubank". Procura tanto no nome do
 * item quanto no nome do banco, e escolhe a correspondência mais longa — assim
 * "inter gold" não perde para "inter".
 */
function matchEntity(text, entities) {
  const normalized = normalize(text);
  let best = null;
  for (const entity of entities || []) {
    for (const candidate of [entity.name, entity.bankName].filter(Boolean)) {
      const term = normalize(candidate);
      if (term.length < 3) continue;
      // Palavra inteira, não pedaço: sem isso o cartão "Inter" casa dentro de
      // "internet" e o gasto vai parar no cartão errado.
      const boundary = new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i');
      if (!boundary.test(normalized)) continue;
      if (!best || term.length > best.length) best = { entity, length: term.length, term };
    }
  }
  return best?.entity || null;
}

// ---------------------------------------------------------------------------
// Descrição limpa
// ---------------------------------------------------------------------------

const NOISE = [
  /\b(paguei|pagar|gastei|comprei|comprar|recebi|receber|foi|no|na|em|de|do|da|com|por|pelo|pela|um|uma|uns|umas)\b/gi,
  /\br\$\s*/gi
];

/**
 * Tira da frase os pedaços que já viraram campo estruturado, sobrando só o
 * "o quê". De "paguei 340 no mercado ontem no crédito em 3x" sobra "mercado".
 */
function cleanDescription(text, tokens = []) {
  let result = String(text);
  for (const token of tokens.filter(Boolean)) {
    result = result.replace(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), ' ');
  }
  for (const pattern of NOISE) result = result.replace(pattern, ' ');
  result = result.replace(/\s+/g, ' ').trim();
  if (!result) return String(text).trim();
  return result.charAt(0).toUpperCase() + result.slice(1);
}

// ---------------------------------------------------------------------------
// Interpretação completa
// ---------------------------------------------------------------------------

/**
 * Lê a frase inteira e devolve o lançamento estruturado, marcando quais campos
 * vieram de evidência explícita no texto (`explicit`) e quais são suposição.
 * A camada de IA só tem permissão de mexer no que não é explícito.
 */
function parseEntry(text, context = {}) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const today = context.today || dateOnly(new Date());
  const amount = extractAmount(raw);
  const date = extractDate(raw, today);
  const payment = extractPaymentMethod(raw);
  const direction = extractDirection(raw);
  const installments = extractInstallments(raw);

  const card = matchEntity(raw, context.cards);
  const account = matchEntity(raw, context.accounts);

  // O cartão citado manda na forma de pagamento: se você escreveu "alelo",
  // é vale, mesmo que a frase não diga a palavra "vale".
  let method = payment.method;
  if (card && !payment.explicit) {
    method = card.cardType === 'CREDITO' ? 'CARTAO_CREDITO' : 'VALE_BENEFICIO';
  }
  if (direction.isIncome) method = 'PIX';

  const description = cleanDescription(raw, [
    amount.token, date.token, payment.token,
    installments > 1 ? `${installments}x` : '',
    card?.name, card?.bankName, account?.name, account?.bankName
  ]);

  return {
    amount: amount.amount,
    date: date.date,
    paymentMethod: method,
    installments: method === 'CARTAO_CREDITO' ? installments : 1,
    isIncome: direction.isIncome,
    description,
    cardId: card?.id || '',
    accountId: account?.id || '',
    // Guia da camada de IA: o que veio de evidência não pode ser alterado.
    explicit: {
      amount: amount.amount > 0,
      date: Boolean(date.token),
      paymentMethod: payment.explicit || Boolean(card),
      direction: direction.explicit,
      installments: installments > 1
    },
    source: 'rules'
  };
}

module.exports = {
  normalize,
  parseAmountToken,
  extractAmount,
  extractDate,
  extractPaymentMethod,
  extractInstallments,
  extractDirection,
  matchEntity,
  cleanDescription,
  parseEntry
};
