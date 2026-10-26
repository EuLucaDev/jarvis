'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

let db = null;
let paths = null;

/**
 * Onde tudo mora. Em produção isso cai em:
 *   macOS   ~/Library/Application Support/Carteira Pessoal/
 *   Windows %APPDATA%\Carteira Pessoal\
 */
function resolvePaths(userDataDir) {
  return {
    root: userDataDir,
    file: path.join(userDataDir, 'carteira.db'),
    backups: path.join(userDataDir, 'backups'),
    attachments: path.join(userDataDir, 'anexos')
  };
}

function getPaths() {
  if (!paths) throw new Error('Banco de dados ainda não inicializado.');
  return paths;
}

/** true quando o app nunca foi usado nesta máquina — dispara o onboarding. */
function isFirstRun(userDataDir) {
  const target = resolvePaths(userDataDir);
  if (!fs.existsSync(target.file)) return true;
  try {
    const probe = new Database(target.file, { readonly: true });
    const row = probe.prepare('SELECT COUNT(*) AS total FROM profile').get();
    probe.close();
    return Number(row.total) === 0;
  } catch (error) {
    // Banco existe mas está sem as tabelas: trata como primeira execução.
    return true;
  }
}

function open(userDataDir) {
  if (db) return db;
  paths = resolvePaths(userDataDir);
  fs.mkdirSync(paths.root, { recursive: true });
  fs.mkdirSync(paths.backups, { recursive: true });
  fs.mkdirSync(paths.attachments, { recursive: true });

  db = new Database(paths.file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  runMigrations(db);
  return db;
}

/**
 * Migrações aditivas. Cada entrada roda uma vez e é registrada em settings,
 * para que uma versão nova do app abra um banco criado por uma versão antiga
 * sem perder nada. Nunca removem colunas.
 */
const MIGRATIONS = [
  {
    id: '2026-07-transfers-goals',
    // As tabelas em si já vêm do schema.sql (CREATE TABLE IF NOT EXISTS).
    // Esta migração existe para bancos criados antes delas.
    run(connection) {
      const columns = connection.prepare('PRAGMA table_info(incomes)').all().map(c => c.name);
      if (!columns.includes('recurring_income_id')) {
        connection.exec("ALTER TABLE incomes ADD COLUMN recurring_income_id TEXT DEFAULT ''");
      }
    }
  },
  {
    id: '2026-08-investment-portfolio-v2',
    run(connection) {
      const existing = new Set(connection.prepare('PRAGMA table_info(investments)').all().map(c => c.name));
      const columns = [
        ['symbol', "TEXT DEFAULT ''"],
        ['asset_class', "TEXT DEFAULT ''"],
        ['quantity', 'REAL DEFAULT 0'],
        ['average_price', 'REAL DEFAULT 0'],
        ['current_price', 'REAL DEFAULT 0'],
        ['exchange_rate', 'REAL DEFAULT 1'],
        ['currency', "TEXT DEFAULT 'BRL'"],
        ['market', "TEXT DEFAULT 'BR'"],
        ['quote_source', "TEXT DEFAULT ''"],
        ['quote_updated_at', "TEXT DEFAULT ''"],
        ['day_change_percent', 'REAL DEFAULT 0'],
        ['logo_url', "TEXT DEFAULT ''"],
        ['benchmark', "TEXT DEFAULT ''"],
        ['annual_rate', 'REAL DEFAULT 0'],
        ['maturity_date', "TEXT DEFAULT ''"],
        ['purchase_date', "TEXT DEFAULT ''"],
        ['auto_quote', 'INTEGER DEFAULT 1']
      ];
      for (const [name, definition] of columns) {
        if (!existing.has(name)) connection.exec(`ALTER TABLE investments ADD COLUMN ${name} ${definition}`);
      }
      connection.exec(`
        UPDATE investments
        SET asset_class = CASE
          WHEN asset_class = '' THEN type
          ELSE asset_class
        END,
        purchase_date = CASE
          WHEN purchase_date = '' THEN substr(created_at, 1, 10)
          ELSE purchase_date
        END
      `);
    }
  },
  {
    id: '2026-08-investment-operations-v3',
    run(connection) {
      const existing = new Set(connection.prepare('PRAGMA table_info(investment_operations)').all().map(c => c.name));
      if (!existing.has('exchange_rate')) {
        connection.exec('ALTER TABLE investment_operations ADD COLUMN exchange_rate REAL DEFAULT 1');
      }
      connection.exec(`
        UPDATE investments SET asset_class = CASE
          WHEN asset_class = 'FUNDO_IMOBILIARIO' THEN 'FII'
          WHEN asset_class = 'RENDA_VARIAVEL' THEN 'ACAO'
          ELSE asset_class
        END
      `);
    }
  },
  {
    id: '2026-08-investment-provider-id-v4',
    run(connection) {
      const existing = new Set(connection.prepare('PRAGMA table_info(investments)').all().map(c => c.name));
      if (!existing.has('provider_id')) connection.exec("ALTER TABLE investments ADD COLUMN provider_id TEXT DEFAULT ''");
    }
  },
  {
    id: '2026-09-expenses-goal-id',
    run(connection) {
      const columns = connection.prepare('PRAGMA table_info(expenses)').all().map(c => c.name);
      if (!columns.includes('goal_id')) {
        connection.exec("ALTER TABLE expenses ADD COLUMN goal_id TEXT DEFAULT ''");
      }
    }
  },
  {
    id: '2026-09-goal-deposits',
    // O valor guardado da meta deixou de ser um número digitado e virou a soma
    // dos depósitos. O que já estava digitado vira um depósito de abertura sem
    // conta de origem: nada se perde e nenhum saldo antigo muda para trás.
    run(connection) {
      const stamp = new Date().toISOString();
      const goals = connection
        .prepare('SELECT id, saved_amount, created_at FROM goals WHERE saved_amount > 0')
        .all();
      const counter = connection.prepare('SELECT COUNT(*) AS total FROM goal_deposits WHERE goal_id = ?');
      const insert = connection.prepare(
        `INSERT INTO goal_deposits (id, goal_id, bank_account_id, amount, date, description, notes, created_at, updated_at)
         VALUES (?, ?, '', ?, ?, 'Saldo anterior da meta', '', ?, ?)`
      );
      for (const goal of goals) {
        if (Number(counter.get(goal.id).total) > 0) continue;
        insert.run(
          `deposit_${Date.now().toString(16)}${Math.random().toString(16).slice(2, 8)}`,
          goal.id,
          goal.saved_amount,
          String(goal.created_at || stamp).slice(0, 10),
          stamp,
          stamp
        );
      }
    }
  }
];

function runMigrations(connection) {
  const applied = new Set(
    connection.prepare("SELECT key FROM settings WHERE key LIKE 'migration_%'").all().map(r => r.key)
  );
  const now = new Date().toISOString();
  for (const migration of MIGRATIONS) {
    const key = `migration_${migration.id}`;
    if (applied.has(key)) continue;
    connection.transaction(() => {
      migration.run(connection);
      connection
        .prepare('INSERT OR REPLACE INTO settings (key, value, type, description, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(key, 'true', 'boolean', 'Migração aplicada', now);
    })();
  }
}

function get() {
  if (!db) throw new Error('Banco de dados ainda não inicializado.');
  return db;
}

function close() {
  if (db) {
    db.close();
    db = null;
  }
}

/** Garante que o WAL foi incorporado ao .db antes de copiar o arquivo. */
function checkpoint() {
  if (db) db.pragma('wal_checkpoint(TRUNCATE)');
}

module.exports = { open, get, close, checkpoint, isFirstRun, getPaths, resolvePaths };
