'use strict';

const repo = require('../repository');
const catalog = require('./catalog');
const accounts = require('./accounts');
const { generateId, now, toNumber } = require('../utils');

const DEFAULT_CATEGORIES = {
  income: ['Salário', 'Freela', 'Comissão', 'Venda', 'Reembolso', 'Investimentos', 'Presente', 'Outros'],
  variableExpense: [
    'Alimentação', 'Mercado', 'Delivery', 'Transporte', 'Moradia', 'Saúde', 'Educação',
    'Lazer', 'Compras', 'Assinaturas', 'Pets', 'Presentes', 'Viagem', 'Outros'
  ],
  fixedExpense: [
    'Aluguel', 'Condomínio', 'Internet', 'Energia', 'Água', 'Gás', 'Telefone',
    'Academia', 'Plano de saúde', 'Seguro', 'Assinatura', 'Financiamento', 'Escola/Faculdade', 'Outros'
  ],
  investment: ['Renda fixa', 'Renda variável', 'Fundo imobiliário', 'Tesouro Direto', 'Cripto', 'Reserva de emergência', 'Previdência', 'Outros']
};

const DEFAULT_SETTINGS = [
  { key: 'theme', value: 'dark', type: 'text', description: 'Tema visual' },
  { key: 'currency', value: 'BRL', type: 'text', description: 'Moeda' },
  { key: 'default_year', value: String(new Date().getFullYear()), type: 'number', description: 'Ano padrão dos filtros' },
  { key: 'app_name', value: 'Carteira Pessoal', type: 'text', description: 'Nome do app' },
  { key: 'density', value: 'comfortable', type: 'text', description: 'Densidade da interface' },
  { key: 'hidden_sections', value: '[]', type: 'json', description: 'Blocos ocultos do dashboard' },
  { key: 'backup_enabled', value: 'true', type: 'boolean', description: 'Backup automático ligado' },
  { key: 'backup_frequency', value: 'daily', type: 'text', description: 'daily | weekly | always' },
  { key: 'backup_keep', value: '15', type: 'number', description: 'Quantos backups manter' },
  { key: 'backup_folder', value: '', type: 'text', description: 'Pasta de backup escolhida pelo usuário' },
  { key: 'notifications_enabled', value: 'true', type: 'boolean', description: 'Avisos de vencimento' },
  { key: 'notifications_days', value: '3', type: 'number', description: 'Avisar com quantos dias de antecedência' },
  { key: 'brapi_token', value: '', type: 'text', description: 'Token gratuito da brapi.dev' },
  { key: 'quote_refresh_minutes', value: '30', type: 'number', description: 'Intervalo de atualização das cotações' },
  { key: 'onboarding_done', value: 'false', type: 'boolean', description: 'Onboarding concluído' }
];

function ensureDefaultCategories() {
  const existing = new Set(catalog.listCategories().map(item => `${item.type}|${item.name.toLowerCase()}`));
  const created = [];
  for (const [type, names] of Object.entries(DEFAULT_CATEGORIES)) {
    for (const name of names) {
      if (existing.has(`${type}|${name.toLowerCase()}`)) continue;
      created.push({ id: generateId('cat'), type, name, color: '', icon: '', createdAt: now(), updatedAt: now() });
    }
  }
  repo.insertMany('categories', created);
  return created.length;
}

function ensureDefaultSettings() {
  const existing = catalog.getSettings();
  let created = 0;
  for (const item of DEFAULT_SETTINGS) {
    if (item.key in existing) continue;
    catalog.setSetting(item.key, item.value, item.type, item.description);
    created++;
  }
  return created;
}

function needsOnboarding() {
  return repo.count('profile') === 0 || catalog.getSettings().onboarding_done !== true;
}

/**
 * Executado uma única vez, ao final do cadastro na primeira abertura.
 * É o momento em que o banco deixa de estar vazio.
 */
function completeOnboarding(data = {}) {
  return repo.transaction(() => {
    catalog.saveProfile({
      name: data.name || 'Minha Carteira',
      monthlyGoal: toNumber(data.monthlyGoal),
      emergencyReserveGoal: toNumber(data.emergencyReserveGoal)
    });

    ensureDefaultCategories();
    ensureDefaultSettings();
    if (data.year) catalog.setSetting('default_year', Number(data.year), 'number');
    if (data.theme) catalog.setSetting('theme', data.theme, 'text');

    // Conta inicial é opcional, mas sem nenhuma conta não dá para lançar nada —
    // por isso o onboarding oferece criar já a primeira.
    if (data.account?.name && data.account?.bankName) {
      accounts.create({
        name: data.account.name,
        bankName: data.account.bankName,
        accountType: data.account.accountType || 'CONTA_DIGITAL',
        initialBalance: toNumber(data.account.initialBalance),
        color: data.account.color || '#8b5cf6'
      });
    }

    // Reserva de emergência: cria o investimento que alimenta o score e as
    // projeções, se o usuário definiu uma meta de reserva.
    if (toNumber(data.emergencyReserveGoal) > 0 && data.createReserve !== false) {
      const investments = require('./investments');
      investments.create({
        name: 'Reserva de emergência',
        type: 'RESERVA_EMERGENCIA',
        institution: data.account?.bankName || 'A definir',
        currentAmount: 0,
        goalAmount: toNumber(data.emergencyReserveGoal)
      });
    }

    require('./categorizer').seedBuiltinRules();
    catalog.setSetting('onboarding_done', 'true', 'boolean');
    catalog.logActivity('ONBOARDING_COMPLETED', 'Carteira criada. Bem-vindo!', 'profile', 'setup');
    return { ok: true };
  });
}

/** Garante estrutura mínima em bancos já existentes (abertura normal). */
function ensureBaseData() {
  ensureDefaultSettings();
  if (catalog.listCategories().length === 0) ensureDefaultCategories();
  // O dicionário de comerciantes vira regras visíveis e editáveis na primeira
  // abertura, para que você possa ajustar qualquer associação que discordar.
  require('./categorizer').seedBuiltinRules();
  return true;
}

module.exports = {
  DEFAULT_CATEGORIES,
  DEFAULT_SETTINGS,
  ensureDefaultCategories,
  ensureDefaultSettings,
  ensureBaseData,
  needsOnboarding,
  completeOnboarding
};
