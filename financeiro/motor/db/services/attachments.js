'use strict';

const fs = require('node:fs');
const path = require('node:path');
const repo = require('../repository');
const database = require('../database');
const { generateId, now } = require('../utils');

/**
 * Comprovantes e notas fiscais. O arquivo original é copiado para dentro da
 * pasta de dados do app, então mover ou apagar o arquivo de origem não quebra
 * o anexo — e o backup do banco viaja junto com a pasta de anexos.
 */

const ALLOWED = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.heic', '.gif', '.txt', '.csv', '.ofx', '.xml']);
const MAX_BYTES = 20 * 1024 * 1024;

function attachmentsRoot() {
  return database.getPaths().attachments;
}

function list(entityType, entityId) {
  return repo
    .query('SELECT * FROM attachments WHERE entity_type = ? AND entity_id = ? ORDER BY created_at DESC', [entityType, entityId])
    .map(item => ({ ...item, absolutePath: path.join(attachmentsRoot(), item.filePath) }));
}

function countFor(entityType, entityId) {
  return repo.count('attachments', 'entity_type = ? AND entity_id = ?', [entityType, entityId]);
}

/** Mapa { entityId: quantidade } — evita uma consulta por linha na lista. */
function countsByEntity(entityType) {
  const map = {};
  for (const row of repo.query(
    'SELECT entity_id, COUNT(*) AS total FROM attachments WHERE entity_type = ? GROUP BY entity_id',
    [entityType]
  )) {
    map[row.entityId] = Number(row.total);
  }
  return map;
}

function add(entityType, entityId, sourcePath) {
  if (!fs.existsSync(sourcePath)) throw new Error('Arquivo não encontrado.');
  const stats = fs.statSync(sourcePath);
  if (stats.size > MAX_BYTES) throw new Error('O arquivo passa de 20 MB. Comprima antes de anexar.');

  const extension = path.extname(sourcePath).toLowerCase();
  if (!ALLOWED.has(extension)) throw new Error(`Tipo de arquivo não suportado (${extension || 'sem extensão'}).`);

  // Uma subpasta por tipo de entidade mantém a pasta navegável no Finder.
  const folder = path.join(attachmentsRoot(), entityType);
  fs.mkdirSync(folder, { recursive: true });

  const id = generateId('attachment');
  const fileName = path.basename(sourcePath);
  const storedName = `${id}${extension}`;
  fs.copyFileSync(sourcePath, path.join(folder, storedName));

  const item = {
    id,
    entityType,
    entityId,
    fileName,
    filePath: path.join(entityType, storedName),
    mimeType: extension.replace('.', ''),
    sizeBytes: stats.size,
    createdAt: now()
  };
  repo.insert('attachments', item);
  return { ...item, absolutePath: path.join(attachmentsRoot(), item.filePath) };
}

function remove(id) {
  const item = repo.findById('attachments', id);
  if (!item) return false;
  const absolute = path.join(attachmentsRoot(), item.filePath);
  try { if (fs.existsSync(absolute)) fs.unlinkSync(absolute); } catch (error) { /* já removido */ }
  return repo.remove('attachments', id);
}

/** Remove anexos órfãos — chamado quando um lançamento é excluído. */
function removeForEntity(entityType, entityId) {
  for (const item of list(entityType, entityId)) remove(item.id);
}

module.exports = { ALLOWED, attachmentsRoot, list, countFor, countsByEntity, add, remove, removeForEntity };
