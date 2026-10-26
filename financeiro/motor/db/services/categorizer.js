'use strict';

const repo = require('../repository');
const catalog = require('./catalog');
const parser = require('./parser');
const { normalize } = parser;
const { generateId, now, toNumber } = require('../utils');

/**
 * Categorização em três camadas, da mais confiável para a menos.
 *
 *   1. Suas regras   — o que você já corrigiu antes. Determinístico e instantâneo.
 *   2. Dicionário    — comerciantes conhecidos do Brasil, embutido no app.
 *   3. IA local      — só quando as duas primeiras não sabem.
 *
 * A camada 1 é a que faz o app melhorar com o uso: você corrige "Zé Padaria"
 * para Alimentação uma vez, e ele nunca mais erra. Isso resolve a maior parte
 * do problema sem depender de modelo nenhum.
 */

// ---------------------------------------------------------------------------
// Dicionário embutido
// ---------------------------------------------------------------------------

const BUILTIN = {
  variableExpense: {
    'Alimentação': ['ifood', 'rappi', 'restaurante', 'lanche', 'almoco', 'jantar', 'padaria', 'pizza',
      'burger', 'mcdonald', 'bk ', 'burguer', 'subway', 'outback', 'habibs', 'cafe', 'starbucks',
      'bar ', 'boteco', 'churrascaria', 'sushi', 'temaki', 'espetinho', 'doceria', 'sorveteria'],
    'Mercado': ['mercado', 'supermercado', 'hortifruti', 'acougue', 'atacad', 'carrefour', 'assai',
      'pao de acucar', 'extra', 'big', 'sams club', 'makro', 'dia ', 'zona sul', 'sendas', 'mambo',
      'st marche', 'oba hortifruti', 'quitanda', 'emporio'],
    'Delivery': ['delivery', 'entrega', 'ze delivery', 'daki', 'zap entrega'],
    'Transporte': ['uber', '99app', '99 pop', 'cabify', 'indriver', 'gasolina', 'combustivel', 'posto',
      'ipiranga', 'shell', 'petrobras', 'br mania', 'estacionamento', 'zona azul', 'pedagio',
      'sem parar', 'conectcar', 'veloe', 'metro', 'onibus', 'bilhete unico', 'passagem', 'localiza',
      'movida', 'unidas', 'buser', 'clickbus'],
    'Moradia': ['aluguel', 'condominio', 'iptu', 'enel', 'cemig', 'light', 'cpfl', 'copel', 'celesc',
      'sabesp', 'cedae', 'copasa', 'comgas', 'naturgy', 'ultragaz', 'faxina', 'diarista', 'leroy',
      'telhanorte', 'obramax', 'casa e construcao'],
    'Saúde': ['farmacia', 'drogaria', 'droga raia', 'drogasil', 'pacheco', 'panvel', 'ultrafarma',
      'medico', 'clinica', 'hospital', 'laboratorio', 'fleury', 'dasa', 'sabin', 'consulta',
      'dentista', 'psicolog', 'terapia', 'exame', 'unimed', 'amil', 'sulamerica', 'bradesco saude',
      'academia', 'smartfit', 'bluefit', 'gympass', 'wellhub', 'crossfit', 'pilates'],
    'Lazer': ['netflix', 'spotify', 'disney', 'hbo', 'max', 'prime video', 'globoplay', 'paramount',
      'deezer', 'youtube premium', 'cinema', 'cinemark', 'kinoplex', 'uci ', 'ingresso', 'sympla',
      'eventim', 'ticketmaster', 'show', 'teatro', 'steam', 'playstation', 'xbox', 'nintendo',
      'epic games', 'twitch', 'balada', 'clube'],
    'Compras': ['amazon', 'shopee', 'aliexpress', 'mercadolivre', 'mercado livre', 'magalu',
      'magazine luiza', 'americanas', 'casas bahia', 'ponto frio', 'submarino', 'shein', 'temu',
      'renner', 'riachuelo', 'cea ', 'zara', 'hering', 'centauro', 'nike', 'adidas', 'netshoes',
      'kabum', 'pichau', 'terabyte', 'fastshop', 'shopping'],
    'Assinaturas': ['assinatura', 'mensalidade', 'vivo', 'claro', 'tim ', 'oi ', 'nextel', 'internet',
      'net ', 'sky', 'icloud', 'google one', 'dropbox', 'microsoft', 'office 365', 'adobe',
      'chatgpt', 'openai', 'anthropic', 'notion', 'figma'],
    'Educação': ['curso', 'faculdade', 'universidade', 'escola', 'colegio', 'udemy', 'alura',
      'coursera', 'rocketseat', 'livraria', 'amazon kindle', 'saraiva', 'cultura', 'material escolar'],
    'Pets': ['pet', 'petz', 'cobasi', 'petlove', 'veterinari', 'racao', 'banho e tosa'],
    'Viagem': ['hotel', 'pousada', 'airbnb', 'booking', 'decolar', 'latam', 'gol ', 'azul ', 'smiles',
      'cvc', 'hurb', '123milhas', 'hostel', 'resort']
  },
  income: {
    'Salário': ['salario', 'pagamento empresa', 'folha', 'holerite', 'proventos', 'remuneracao'],
    'Freela': ['freela', 'freelance', 'projeto', 'servico prestado', 'nota fiscal'],
    'Investimentos': ['rendimento', 'dividendo', 'juros', 'jcp', 'resgate', 'tesouro', 'cdb', 'lci', 'lca'],
    'Reembolso': ['reembolso', 'estorno', 'devolucao', 'restituicao', 'cashback'],
    'Venda': ['venda', 'vendi', 'olx', 'enjoei']
  }
};

// ---------------------------------------------------------------------------
// Regras aprendidas
// ---------------------------------------------------------------------------

function listRules() {
  return repo.all('category_rules', 'hits DESC, length(term) DESC');
}

/**
 * Cria ou reforça uma regra. Chamado toda vez que você corrige uma categoria:
 * o app extrai o termo mais característico da descrição e memoriza.
 */
function learn(description, category, kind = 'variableExpense', source = 'user') {
  const term = significantTerm(description);
  if (!term || !category) return null;

  const existing = repo.query('SELECT * FROM category_rules WHERE term = ? AND kind = ?', [term, kind])[0];
  if (existing) {
    // Mudou de ideia sobre a categoria? A correção mais recente vence.
    return repo.update('category_rules', existing.id, {
      category,
      source,
      hits: existing.category === category ? Number(existing.hits) + 1 : 1
    });
  }

  const rule = {
    id: generateId('rule'),
    term,
    category,
    kind,
    matchType: 'contains',
    source,
    hits: 1,
    createdAt: now(),
    updatedAt: now()
  };
  repo.insert('category_rules', rule);
  return rule;
}

const STOPWORDS = new Set([
  'de', 'da', 'do', 'das', 'dos', 'e', 'em', 'no', 'na', 'nos', 'nas', 'a', 'o', 'as', 'os',
  'um', 'uma', 'com', 'por', 'para', 'pra', 'ltda', 'me', 'sa', 'eireli', 'com', 'br', 'pagamento',
  'compra', 'cartao', 'debito', 'credito', 'pix', 'transferencia', 'recebido', 'enviado', 'parcela'
]);

/**
 * Extrai o pedaço da descrição que identifica o comerciante.
 * "PAG*IFOOD SAO PAULO BR" → "ifood"; "Zé Padaria Ltda" → "ze padaria".
 */
function significantTerm(description) {
  const cleaned = normalize(description)
    // Prefixo de maquininha só existe colado num asterisco ("PAG*IFOOD",
    // "CP*UBER"). Sem exigir o asterisco, o "pag" comia o começo de palavras
    // reais: "MERCADO PAGO" virava "mercado" e o termo aprendido saía errado.
    .replace(/\b(pag|cp|tef|pos|mp|ebn|zp)\s*\*\s*/g, ' ')
    .replace(/\b(pagto|pagamento|compra)\b\s*/g, ' ')
    .replace(/\*/g, ' ')
    .replace(/\b\d{2,}\b/g, ' ')                                          // números soltos
    .replace(/\b(sao paulo|rio de janeiro|belo horizonte|brasilia|curitiba|porto alegre|br|bra)\b/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const words = cleaned.split(' ').filter(word => word.length >= 3 && !STOPWORDS.has(word));
  if (!words.length) return '';
  // Duas primeiras palavras significativas costumam identificar o lugar.
  return words.slice(0, 2).join(' ');
}

function deleteRule(id) {
  return repo.remove('category_rules', id);
}

function saveRule(data) {
  const term = normalize(data.term).trim();
  if (!term || !data.category) throw new Error('Informe o termo e a categoria.');
  const existing = repo.query('SELECT * FROM category_rules WHERE term = ? AND kind = ?',
    [term, data.kind || 'variableExpense'])[0];
  if (existing && existing.id !== data.id) throw new Error('Já existe uma regra para esse termo.');

  if (data.id) return repo.update('category_rules', data.id, { term, category: data.category, kind: data.kind });
  const rule = {
    id: generateId('rule'), term, category: data.category,
    kind: data.kind || 'variableExpense', matchType: 'contains',
    source: 'user', hits: 0, createdAt: now(), updatedAt: now()
  };
  repo.insert('category_rules', rule);
  return rule;
}

// ---------------------------------------------------------------------------
// Consulta
// ---------------------------------------------------------------------------

/**
 * Casa o termo como palavra inteira, não como pedaço de palavra.
 *
 * Sem isso, "cea" (de C&A) casa dentro de "mer(cea)ria" e manda uma compra de
 * mercado para a categoria Compras. Vale para termos de várias palavras
 * também: "pao de acucar" casa como bloco.
 */
const boundaryCache = new Map();

function matchesTerm(normalizedText, term) {
  const clean = String(term).trim();
  if (!clean) return false;
  if (!boundaryCache.has(clean)) {
    const escaped = clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    boundaryCache.set(clean, new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i'));
  }
  return boundaryCache.get(clean).test(normalizedText);
}

/** Camada 1: as suas regras. */
function matchLearnedRule(description, kind) {
  const normalized = normalize(description);
  const rules = listRules().filter(rule => rule.kind === kind);
  // Termo mais longo primeiro: "inter gold" ganha de "inter".
  for (const rule of rules.sort((a, b) => b.term.length - a.term.length)) {
    const hit = rule.matchType === 'exact'
      ? normalized === rule.term.trim()
      : matchesTerm(normalized, rule.term);
    if (hit) return rule;
  }
  return null;
}

/** Camada 2: o dicionário embutido. */
function matchBuiltin(description, kind) {
  const normalized = normalize(description);
  const dictionary = BUILTIN[kind] || {};
  let best = null;
  for (const [category, terms] of Object.entries(dictionary)) {
    for (const term of terms) {
      if (!matchesTerm(normalized, term)) continue;
      if (!best || term.trim().length > best.term.trim().length) best = { category, term };
    }
  }
  return best;
}

/**
 * Resolve a categoria pelas duas camadas determinísticas.
 * Devolve também de onde veio, para a interface poder mostrar a origem e para
 * a camada de IA saber se ainda precisa ser chamada.
 */
function categorize(description, kind = 'variableExpense') {
  const available = new Set((catalog.groupedCategories()[kind] || []).map(item => item.name));

  const learned = matchLearnedRule(description, kind);
  if (learned && available.has(learned.category)) {
    repo.run('UPDATE category_rules SET hits = hits + 1 WHERE id = ?', [learned.id]);
    return { category: learned.category, source: 'rule', confidence: 'alta', ruleId: learned.id };
  }

  const builtin = matchBuiltin(description, kind);
  if (builtin && available.has(builtin.category)) {
    return { category: builtin.category, source: 'builtin', confidence: 'media', term: builtin.term };
  }

  return { category: null, source: 'none', confidence: 'nenhuma' };
}

/**
 * Aplica as regras a lançamentos que ficaram sem categoria — útil depois de
 * uma importação grande, ou quando você acabou de criar uma regra nova.
 */
function applyRulesToUncategorized(fallbackCategory = 'Outros') {
  const pending = repo.query(
    `SELECT id, description, category FROM expenses WHERE category = '' OR category = ? OR category IS NULL`,
    [fallbackCategory]
  );
  let updated = 0;
  for (const expense of pending) {
    const result = categorize(expense.description, 'variableExpense');
    if (result.category && result.category !== expense.category) {
      repo.run('UPDATE expenses SET category = ?, updated_at = ? WHERE id = ?', [result.category, now(), expense.id]);
      updated++;
    }
  }
  return { updated, checked: pending.length };
}

/** Semeia o dicionário embutido como regras visíveis e editáveis. */
function seedBuiltinRules() {
  if (repo.count('category_rules') > 0) return 0;
  const rows = [];
  for (const [kind, dictionary] of Object.entries(BUILTIN)) {
    for (const [category, terms] of Object.entries(dictionary)) {
      for (const term of terms) {
        rows.push({
          id: generateId('rule'), term: term.trim(), category, kind,
          matchType: 'contains', source: 'builtin', hits: 0,
          createdAt: now(), updatedAt: now()
        });
      }
    }
  }
  repo.insertMany('category_rules', rows);
  return rows.length;
}

/**
 * Interpreta uma frase escrita à mão e devolve o lançamento pronto.
 *
 * O trabalho pesado é do parser determinístico: valor, data, forma de
 * pagamento e parcelas saem de regras, não de adivinhação. Aqui só se junta a
 * categoria, e `fields` conta de onde veio cada valor — é o que a barra rápida
 * usa para mostrar, com chip amarelo, aquilo que o app supôs.
 */
function parseEntry(text, context = {}) {
  const base = parser.parseEntry(text, context);
  if (!base) return null;

  const kind = base.isIncome ? 'income' : 'variableExpense';
  const guess = categorize(base.description, kind);

  return {
    ...base,
    category: guess.category,
    categorySource: guess.source,
    fields: {
      amount: base.explicit.amount ? 'texto' : 'ausente',
      date: base.explicit.date ? 'texto' : 'hoje',
      paymentMethod: base.explicit.paymentMethod ? 'texto' : 'padrão',
      installments: base.explicit.installments ? 'texto' : 'padrão',
      category: guess.source
    },
    source: 'rules'
  };
}

/**
 * Completa as linhas lidas de um extrato com categoria e marca as que já
 * existem no app. Vivia junto do assistente, mas nunca dependeu dele: quem
 * categoriza são as regras.
 */
function enrichRows(rows) {
  const existing = new Set(
    repo.query('SELECT date, amount FROM expenses UNION ALL SELECT date, amount FROM incomes')
      .map(item => `${String(item.date).slice(0, 10)}|${Math.round(toNumber(item.amount) * 100)}`)
  );

  return (rows || []).map(row => {
    const result = categorize(row.description, row.isIncome ? 'income' : 'variableExpense');
    return {
      ...row,
      category: result.category,
      categorySource: result.source,
      duplicate: existing.has(`${row.date}|${Math.round(toNumber(row.amount) * 100)}`)
    };
  });
}

module.exports = {
  parseEntry,
  enrichRows,
  BUILTIN,
  listRules,
  learn,
  saveRule,
  deleteRule,
  significantTerm,
  categorize,
  matchLearnedRule,
  matchBuiltin,
  applyRulesToUncategorized,
  seedBuiltinRules
};
