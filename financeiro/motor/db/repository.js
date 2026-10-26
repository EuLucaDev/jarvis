'use strict';

const database = require('./database');
const { camelToSnake, rowToObject, rowsToObjects, now } = require('./utils');

/**
 * Repositório genérico sobre as tabelas. Recebe e devolve objetos camelCase;
 * a tradução para snake_case acontece aqui, num lugar só.
 *
 * Todos os nomes de coluna saem entre aspas duplas porque a tabela de cartões
 * tem uma coluna chamada `limit`, que é palavra reservada no SQL.
 */

const columnCache = new Map();

/**
 * Conta quantas escritas já passaram por aqui.
 *
 * Serve de carimbo para memórias de curta duração: um cálculo caro guarda o
 * número que viu e só refaz o trabalho quando ele muda. Como toda escrita do
 * app passa pelo repositório, nenhum serviço precisa lembrar de avisar
 * ninguém — é o que torna o cache seguro.
 */
let writeVersion = 0;
const version = () => writeVersion;
const touch = () => { writeVersion += 1; };

function columnsOf(table) {
  if (!columnCache.has(table)) {
    const columns = database.get().prepare(`PRAGMA table_info("${table}")`).all().map(c => c.name);
    columnCache.set(table, columns);
  }
  return columnCache.get(table);
}

/** Mantém só as chaves que existem como coluna, evitando SQL inválido. */
function toRow(table, data) {
  const valid = new Set(columnsOf(table));
  const row = {};
  for (const [key, value] of Object.entries(data || {})) {
    const column = camelToSnake(key);
    if (!valid.has(column)) continue;
    if (value === undefined || value === null) row[column] = '';
    else if (typeof value === 'boolean') row[column] = value ? 1 : 0;
    else row[column] = value;
  }
  return row;
}

function all(table, orderBy = '') {
  return rowsToObjects(database.get().prepare(`SELECT * FROM "${table}"${orderBy ? ` ORDER BY ${orderBy}` : ''}`).all());
}

function findById(table, id, idColumn = 'id') {
  return rowToObject(database.get().prepare(`SELECT * FROM "${table}" WHERE "${idColumn}" = ?`).get(id));
}

function insert(table, data) {
  const row = toRow(table, data);
  const columns = Object.keys(row);
  if (!columns.length) throw new Error(`Nada para inserir em ${table}.`);
  const sql = `INSERT INTO "${table}" (${columns.map(c => `"${c}"`).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
  database.get().prepare(sql).run(columns.map(c => row[c]));
  touch();
  return data;
}

function insertMany(table, items) {
  const list = (items || []).filter(Boolean);
  if (!list.length) return [];
  database.get().transaction(() => {
    for (const item of list) insert(table, item);
  })();
  return list;
}

function update(table, id, data, idColumn = 'id') {
  const current = findById(table, id, idColumn);
  if (!current) throw new Error('Registro não encontrado.');
  const row = toRow(table, { ...data, updatedAt: data.updatedAt || now() });
  delete row[idColumn];
  const columns = Object.keys(row);
  if (!columns.length) return current;
  const sql = `UPDATE "${table}" SET ${columns.map(c => `"${c}" = ?`).join(', ')} WHERE "${idColumn}" = ?`;
  database.get().prepare(sql).run([...columns.map(c => row[c]), id]);
  touch();
  return findById(table, id, idColumn);
}

function remove(table, id, idColumn = 'id') {
  const result = database.get().prepare(`DELETE FROM "${table}" WHERE "${idColumn}" = ?`).run(id);
  touch();
  return result.changes > 0;
}

function removeWhere(table, column, value) {
  const changes = database.get().prepare(`DELETE FROM "${table}" WHERE "${camelToSnake(column)}" = ?`).run(value).changes;
  touch();
  return changes;
}

function clear(table) {
  database.get().prepare(`DELETE FROM "${table}"`).run();
  touch();
}

function count(table, where = '', params = []) {
  const sql = `SELECT COUNT(*) AS total FROM "${table}"${where ? ` WHERE ${where}` : ''}`;
  return Number(database.get().prepare(sql).get(params).total);
}

/** Executa um bloco inteiro dentro de uma transação (tudo ou nada). */
function transaction(callback) {
  return database.get().transaction(callback)();
}

/** SELECT livre — devolve as linhas já em camelCase. */
function query(sql, params = []) {
  return rowsToObjects(database.get().prepare(sql).all(params));
}

/** INSERT/UPDATE/DELETE livre — devolve o número de linhas afetadas. */
function run(sql, params = []) {
  const changes = database.get().prepare(sql).run(params).changes;
  touch();
  return changes;
}

module.exports = {
  all,
  findById,
  insert,
  insertMany,
  update,
  remove,
  removeWhere,
  clear,
  count,
  transaction,
  query,
  run,
  columnsOf,
  version,
  touch
};
