'use strict';

const fs = require('node:fs');
const path = require('node:path');
const database = require('../database');
const catalog = require('./catalog');
const { now, toNumber } = require('../utils');

/**
 * Backup é a peça crítica de um app local: sem servidor, o arquivo .db é a
 * única cópia dos seus dados. Aqui ele é copiado inteiro (o SQLite é um
 * arquivo só), com o WAL incorporado antes, para que a cópia seja consistente.
 */

const STAMP = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

function backupFolder() {
  const custom = catalog.getSettings().backup_folder;
  if (custom && fs.existsSync(custom)) return custom;
  return database.getPaths().backups;
}

function listBackups() {
  const folder = backupFolder();
  if (!fs.existsSync(folder)) return [];
  return fs
    .readdirSync(folder)
    .filter(name => name.startsWith('carteira-') && name.endsWith('.db'))
    .map(name => {
      const filePath = path.join(folder, name);
      const stats = fs.statSync(filePath);
      return {
        name,
        path: filePath,
        size: stats.size,
        createdAt: stats.mtime.toISOString(),
        auto: name.includes('-auto-')
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function createBackup(kind = 'manual') {
  const folder = backupFolder();
  fs.mkdirSync(folder, { recursive: true });
  database.checkpoint();

  const target = path.join(folder, `carteira-${kind === 'auto' ? 'auto-' : ''}${STAMP()}.db`);
  fs.copyFileSync(database.getPaths().file, target);

  pruneBackups();
  if (kind === 'manual') catalog.logActivity('BACKUP_CREATED', 'Backup manual criado', 'database', path.basename(target));
  catalog.setSetting('last_backup_at', now(), 'text', 'Último backup');
  return { path: target, name: path.basename(target), createdAt: now() };
}

/** Mantém apenas os N backups automáticos mais recentes. Os manuais ficam. */
function pruneBackups() {
  const keep = Math.max(3, toNumber(catalog.getSettings().backup_keep, 15));
  const auto = listBackups().filter(item => item.auto);
  for (const item of auto.slice(keep)) {
    try { fs.unlinkSync(item.path); } catch (error) { /* arquivo já removido */ }
  }
}

/** Roda na abertura do app; respeita a frequência configurada. */
function runAutoBackupIfDue() {
  const settings = catalog.getSettings();
  if (settings.backup_enabled === false) return { skipped: 'desligado' };

  const frequency = settings.backup_frequency || 'daily';
  const last = settings.last_backup_at;
  if (frequency !== 'always' && last) {
    const elapsedHours = (Date.now() - new Date(last).getTime()) / 3600000;
    const threshold = frequency === 'weekly' ? 24 * 7 : 24;
    if (elapsedHours < threshold) return { skipped: 'ainda no prazo' };
  }
  return createBackup('auto');
}

/**
 * Restaurar troca o arquivo do banco inteiro. Antes disso guarda uma cópia de
 * segurança do estado atual — se a restauração for um engano, dá para voltar.
 */
function restoreBackup(filePath) {
  if (!fs.existsSync(filePath)) throw new Error('Arquivo de backup não encontrado.');

  const Database = require('better-sqlite3');
  try {
    const probe = new Database(filePath, { readonly: true, fileMustExist: true });
    const check = probe.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='bank_accounts'").get();
    probe.close();
    if (!check) throw new Error('formato');
  } catch (error) {
    throw new Error('Este arquivo não é um backup válido da Carteira Pessoal.');
  }

  const paths = database.getPaths();
  const safety = path.join(paths.backups, `carteira-antes-de-restaurar-${STAMP()}.db`);
  database.checkpoint();
  fs.copyFileSync(paths.file, safety);

  database.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const extra = `${paths.file}${suffix}`;
    if (suffix && fs.existsSync(extra)) fs.unlinkSync(extra);
  }
  fs.copyFileSync(filePath, paths.file);
  database.open(paths.root);

  catalog.logActivity('BACKUP_RESTORED', `Backup ${path.basename(filePath)} restaurado`, 'database', 'restore');
  return { restored: path.basename(filePath), safetyCopy: path.basename(safety) };
}

function deleteBackup(filePath) {
  const folder = backupFolder();
  // Só apaga dentro da pasta de backups — evita apagar arquivo arbitrário.
  if (!path.resolve(filePath).startsWith(path.resolve(folder))) {
    throw new Error('Só é possível excluir backups da pasta de backups.');
  }
  fs.unlinkSync(filePath);
  return true;
}

module.exports = {
  backupFolder,
  listBackups,
  createBackup,
  pruneBackups,
  runAutoBackupIfDue,
  restoreBackup,
  deleteBackup
};
