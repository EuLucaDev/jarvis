'use strict';

/**
 * Catálogo das operações do motor para o modo avançado do Jarvis: gerado do próprio código (router.js e os
 * serviços), então acompanha sozinho qualquer operação nova. Para cada operação: os parâmetros, os campos que
 * o objeto `data` usa (lidos do serviço chamado) e quais são obrigatórios (`required([...])`).
 */

const path = require('node:path');
const { handlers } = require('./db/router');

const SO_LEITURA = /^(app:(initialData|refresh|needsOnboarding))|:(get|list|grouped|status|details|movements|balance|categorize|parseEntry|full|statement|categories|comparison|ledger|csv|export|folder|suggestTargets|subscriptions|monthClosing|calendar|nextActions|usedLimit|items|deposits|batches|portfolio|classes|search|pace|sameMonthLastYear|suggestBudgets|checkOutlier)$/;

const servicos = {};
function servico(nome) {
  if (!(nome in servicos)) {
    try {
      servicos[nome] = require(path.join(__dirname, 'db', 'services', nome));
    } catch {
      servicos[nome] = null;
    }
  }
  return servicos[nome];
}

function parametros(fn) {
  const src = fn.toString();
  const m = /^\s*(?:async\s*)?(?:\(([^)]*)\)|([A-Za-z_$][\w$]*))\s*=>/.exec(src);
  const lista = (m ? m[1] ?? m[2] ?? '' : '').split(',').map((p) => p.trim().replace(/=.*$/, '').trim()).filter(Boolean);
  return { lista, src };
}

/** Campos de `data` e obrigatórios, lidos da função do serviço que a operação chama. */
function camposDoServico(src) {
  const chamada = /(\w+)\.(\w+)\(/.exec(src.split('=>').slice(1).join('=>'));
  if (!chamada) return {};
  const mod = servico(chamada[1]);
  const fn = mod && mod[chamada[2]];
  if (typeof fn !== 'function') return {};
  const corpo = fn.toString();
  const campos = [...new Set([...corpo.matchAll(/\bdata\.(\w+)/g)].map((x) => x[1]))];
  const req = /required\(\s*data\s*,\s*\[([^\]]*)\]/.exec(corpo);
  const obrigatorios = req ? [...req[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
  return { campos, obrigatorios };
}

function catalogo() {
  const out = {};
  for (const [canal, fn] of Object.entries(handlers)) {
    const { lista, src } = parametros(fn);
    const { campos, obrigatorios } = camposDoServico(src);
    out[canal] = {
      parametros: lista,
      ...(campos && campos.length ? { campos_data: campos } : {}),
      ...(obrigatorios && obrigatorios.length ? { obrigatorios } : {}),
      leitura: SO_LEITURA.test(canal),
    };
  }
  return out;
}

module.exports = { catalogo, SO_LEITURA };
