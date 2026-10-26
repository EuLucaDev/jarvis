'use strict';

const repo = require('../repository');
const { generateId, now, toNumber, roundCurrency } = require('../utils');

// ---------------------------------------------------------------------------
// Atividades
// ---------------------------------------------------------------------------

function logActivity(type, message, entityType = '', entityId = '') {
  const item = { id: generateId('activity'), type, message, entityType, entityId, createdAt: now() };
  repo.insert('activities', item);
  return item;
}

function listActivities(limit = 20) {
  return repo.query('SELECT * FROM activities ORDER BY created_at DESC LIMIT ?', [Number(limit) || 20]);
}

/** Mantém o histórico enxuto — sem isso a tabela cresce para sempre. */
function pruneActivities(keep = 500) {
  repo.run(
    'DELETE FROM activities WHERE id NOT IN (SELECT id FROM activities ORDER BY created_at DESC LIMIT ?)',
    [keep]
  );
}

// ---------------------------------------------------------------------------
// Perfil
// ---------------------------------------------------------------------------

function getProfile() {
  const rows = repo.all('profile');
  return rows[0] || null;
}

function saveProfile(data) {
  const current = getProfile();
  const payload = {
    name: String(data.name || '').trim(),
    monthlyGoal: toNumber(data.monthlyGoal),
    emergencyReserveGoal: toNumber(data.emergencyReserveGoal),
    updatedAt: now()
  };
  if (!payload.name) throw new Error('Informe o nome da carteira.');
  if (!current) {
    const item = { id: generateId('profile'), ...payload, createdAt: now() };
    repo.insert('profile', item);
    return item;
  }
  const result = repo.update('profile', current.id, payload);
  logActivity('SETTINGS_UPDATED', 'Perfil financeiro atualizado', 'profile', current.id);
  return result;
}

// ---------------------------------------------------------------------------
// Configurações (chave/valor tipado)
// ---------------------------------------------------------------------------

function getSettings() {
  const settings = {};
  for (const item of repo.all('settings')) {
    let value = item.value;
    if (item.type === 'number') value = toNumber(value);
    else if (item.type === 'boolean') value = String(value) === 'true' || value === 1;
    else if (item.type === 'json') {
      try { value = JSON.parse(value); } catch (error) { value = null; }
    }
    settings[item.key] = value;
  }
  return settings;
}

function setSetting(key, value, type = '', description = '') {
  const existing = repo.findById('settings', key, 'key');
  const resolvedType = type || existing?.type || (typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'text');
  const stored = resolvedType === 'json' ? JSON.stringify(value) : String(value);
  const payload = {
    key,
    value: stored,
    type: resolvedType,
    description: description || existing?.description || '',
    updatedAt: now()
  };
  if (existing) repo.update('settings', key, payload, 'key');
  else repo.insert('settings', payload);
  return payload;
}

function setSettings(patch = {}) {
  repo.transaction(() => {
    for (const [key, value] of Object.entries(patch)) setSetting(key, value);
  });
  return getSettings();
}

// ---------------------------------------------------------------------------
// Categorias
// ---------------------------------------------------------------------------

const CATEGORY_TYPES = ['income', 'variableExpense', 'fixedExpense', 'investment'];

function listCategories() {
  return repo.all('categories', 'type, name COLLATE NOCASE');
}

/** Agrupadas por tipo — formato que os formulários da interface esperam. */
function groupedCategories() {
  const grouped = { income: [], variableExpense: [], fixedExpense: [], investment: [] };
  for (const item of listCategories()) {
    if (grouped[item.type]) grouped[item.type].push(item);
  }
  return grouped;
}

function createCategory(type, name, color = '') {
  const clean = String(name || '').trim();
  if (!CATEGORY_TYPES.includes(type)) throw new Error('Tipo de categoria inválido.');
  if (!clean) throw new Error('Informe o nome da categoria.');
  const duplicate = listCategories().some(
    item => item.type === type && item.name.toLowerCase() === clean.toLowerCase()
  );
  if (duplicate) throw new Error('Essa categoria já existe.');
  const item = { id: generateId('cat'), type, name: clean, color, icon: '', createdAt: now(), updatedAt: now() };
  repo.insert('categories', item);
  return item;
}

function updateCategory(type, id, data) {
  const current = repo.findById('categories', id);
  if (!current) throw new Error('Categoria não encontrada.');
  const clean = String(data.name || '').trim();
  if (!clean) throw new Error('Informe o nome da categoria.');
  return repo.update('categories', id, { type: type || current.type, name: clean, color: data.color ?? current.color });
}

/**
 * Excluir categoria não mexe nos lançamentos antigos: eles guardam o nome da
 * categoria como texto, então o histórico continua legível. A categoria só
 * some das opções futuras.
 */
function deleteCategory(type, id) {
  const item = repo.findById('categories', id);
  if (!item) throw new Error('Categoria não encontrada.');
  if (type && item.type !== type) throw new Error('Tipo de categoria inválido.');
  return repo.remove('categories', id);
}

// ---------------------------------------------------------------------------
// Orçamentos por categoria
// ---------------------------------------------------------------------------

function listBudgets() {
  return repo.all('budgets', 'category COLLATE NOCASE');
}

/** Mapa { categoria: valor } — o formato consumido pelas barras do dashboard. */
function budgetMap(referenceMonth = '') {
  const map = {};
  for (const item of listBudgets()) {
    if (item.referenceMonth && item.referenceMonth !== referenceMonth) continue;
    map[item.category] = toNumber(item.amount);
  }
  return map;
}

/** Substitui o conjunto de metas de uma vez (é como o editor da interface salva). */
function saveBudgets(budgets = {}, referenceMonth = '') {
  repo.transaction(() => {
    repo.run('DELETE FROM budgets WHERE reference_month = ?', [referenceMonth]);
    for (const [category, amount] of Object.entries(budgets)) {
      const value = roundCurrency(amount);
      if (value <= 0) continue;
      repo.insert('budgets', {
        id: generateId('budget'),
        category,
        amount: value,
        referenceMonth,
        createdAt: now(),
        updatedAt: now()
      });
    }
  });
  return budgetMap(referenceMonth);
}

module.exports = {
  CATEGORY_TYPES,
  logActivity,
  listActivities,
  pruneActivities,
  getProfile,
  saveProfile,
  getSettings,
  setSetting,
  setSettings,
  listCategories,
  groupedCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  listBudgets,
  budgetMap,
  saveBudgets
};
