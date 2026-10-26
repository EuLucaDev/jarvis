'use strict';

/**
 * Motor financeiro do Jarvis: as regras da Carteira Pessoal (db/) atrás de um HTTP local.
 *
 * O núcleo do Jarvis (Python) abre este processo e é o único que fala com ele:
 *   POST /c/<operação>   corpo {"args": [...]}   →   {"ok": true, "data": ...} | {"ok": false, "error": "..."}
 *   GET  /saude          →   {"ok": true}
 *
 * Só ouve em 127.0.0.1 e exige o token da sessão (cabeçalho x-token), passado pelo núcleo em FIN_TOKEN.
 * Os dados ficam em FIN_DADOS (banco, backups e anexos), dentro da pasta do Jarvis no computador da pessoa.
 */

const http = require('node:http');
const path = require('node:path');

const database = require('./db/database');
const { handlers } = require('./db/router');
const setup = require('./db/services/setup');
const backup = require('./db/services/backup');

const DADOS = process.env.FIN_DADOS || path.join(process.cwd(), 'dados');
const TOKEN = process.env.FIN_TOKEN || '';
const PORTA = Number(process.env.FIN_PORTA || 8766);

database.open(DADOS);
setup.ensureBaseData();
try { backup.runAutoBackupIfDue(); } catch (error) { console.warn('[backup]', error.message); }

// operações que só leem não precisam consolidar o -wal (mesma regra do app original)
const SO_LEITURA = /^(app:(initialData|refresh|needsOnboarding))|:(get|list|grouped|status|details|movements|balance|categorize|parseEntry|full|statement|categories|comparison|ledger|csv|export|folder|suggestTargets|subscriptions|monthClosing|calendar|nextActions|usedLimit|items|deposits|batches)$/;
let consolidar = null;
function agendarConsolidacao() {
  clearTimeout(consolidar);
  consolidar = setTimeout(() => {
    try { database.checkpoint(); } catch (error) { /* segue */ }
  }, 4000);
}

const extras = {
  // o que no app original vinha do Electron
  'app:info': () => ({
    version: '1.0.0',
    platform: process.platform,
    dataPath: database.getPaths().root,
    dbPath: database.getPaths().file,
    backupPath: backup.backupFolder()
  }),
  'app:setTheme': theme => theme,
  'app:operacoes': () => Object.keys(handlers)
};

function responder(res, status, corpo) {
  const texto = JSON.stringify(corpo);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(texto);
}

const servidor = http.createServer((req, res) => {
  if (req.url === '/saude') return responder(res, 200, { ok: true });
  if (TOKEN && req.headers['x-token'] !== TOKEN) return responder(res, 403, { ok: false, error: 'Acesso negado.' });
  const m = /^\/c\/([A-Za-z]+:[A-Za-z]+)$/.exec(req.url || '');
  if (req.method !== 'POST' || !m) return responder(res, 404, { ok: false, error: 'Operação desconhecida.' });
  const canal = m[1];
  const fn = handlers[canal] || extras[canal];
  if (!fn) return responder(res, 404, { ok: false, error: `Operação desconhecida: ${canal}` });

  let corpo = '';
  req.setEncoding('utf8');
  req.on('data', parte => { corpo += parte; });
  req.on('end', async () => {
    try {
      const args = corpo ? (JSON.parse(corpo).args || []) : [];
      const data = await fn(...args);
      if (!SO_LEITURA.test(canal)) agendarConsolidacao();
      responder(res, 200, { ok: true, data: data === undefined ? null : data });
    } catch (error) {
      console.error(`[${canal}]`, error);
      responder(res, 200, { ok: false, error: error.message || 'Erro inesperado.' });
    }
  });
});

function encerrar() {
  try {
    backup.runAutoBackupIfDue();
    database.checkpoint();
    database.close();
  } catch (error) { /* encerrando de qualquer jeito */ }
  process.exit(0);
}
process.on('SIGTERM', encerrar);
process.on('SIGINT', encerrar);
// o núcleo fecha a entrada padrão quando sai: o motor sai junto (sem processo órfão)
process.stdin.on('end', encerrar);
process.stdin.resume();

servidor.listen(PORTA, '127.0.0.1', () => console.log(`motor financeiro no ar em 127.0.0.1:${PORTA}`));
