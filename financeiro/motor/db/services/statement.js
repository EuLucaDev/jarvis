'use strict';

const fs = require('node:fs');
const path = require('node:path');
const parser = require('./parser');
const banks = require('./banks');
const categorizer = require('./categorizer');
const { dateOnly, toNumber } = require('../utils');

/**
 * Leitura de extratos e faturas.
 *
 * A ordem de tentativa vai do mais confiável para o menos:
 *
 *   1. OFX          — formato estruturado, não tem como errar.
 *   2. CSV          — estruturado, mas com layout variável por banco.
 *   3. PDF com texto — extrai o texto e aplica os leitores por banco.
 *   4. PDF escaneado / imagem — OCR, e depois o mesmo tratamento do PDF.
 *
 * Em todos os casos o resultado passa pelo mesmo pipeline final: categorizar,
 * marcar duplicados e devolver para você conferir antes de importar. O app
 * nunca importa nada sozinho.
 */

// ---------------------------------------------------------------------------
// Extração de texto
// ---------------------------------------------------------------------------

/**
 * O pdfjs espera rodar num navegador. Aqui só queremos o texto, nunca a
 * imagem da página, então bastam estes esboços das APIs de desenho — sem eles
 * o carregamento falha com "DOMMatrix is not defined", mesmo sem renderizar.
 */
function installPdfPolyfills() {
  if (typeof globalThis.DOMMatrix === 'undefined') {
    globalThis.DOMMatrix = class DOMMatrix {
      constructor(init = [1, 0, 0, 1, 0, 0]) {
        const [a, b, c, d, e, f] = Array.isArray(init) ? init : [1, 0, 0, 1, 0, 0];
        Object.assign(this, { a, b, c, d, e, f });
      }
      // Multiplicação 2D padrão — o suficiente para o pdfjs posicionar o texto.
      multiply(other) {
        return new DOMMatrix([
          this.a * other.a + this.c * other.b,
          this.b * other.a + this.d * other.b,
          this.a * other.c + this.c * other.d,
          this.b * other.c + this.d * other.d,
          this.a * other.e + this.c * other.f + this.e,
          this.b * other.e + this.d * other.f + this.f
        ]);
      }
      translate(x = 0, y = 0) { return this.multiply(new DOMMatrix([1, 0, 0, 1, x, y])); }
      scale(x = 1, y = x) { return this.multiply(new DOMMatrix([x, 0, 0, y, 0, 0])); }
      transformPoint(point = { x: 0, y: 0 }) {
        return {
          x: this.a * point.x + this.c * point.y + this.e,
          y: this.b * point.x + this.d * point.y + this.f
        };
      }
    };
  }
  if (typeof globalThis.Path2D === 'undefined') {
    globalThis.Path2D = class Path2D {
      addPath() {} moveTo() {} lineTo() {} bezierCurveTo() {}
      quadraticCurveTo() {} closePath() {} rect() {} arc() {}
    };
  }
  if (typeof globalThis.ImageData === 'undefined') {
    globalThis.ImageData = class ImageData {
      constructor(width, height) { this.width = width; this.height = height; }
    };
  }
}

/**
 * Extrai o texto de um PDF preservando a estrutura de linhas.
 *
 * O pdfjs devolve fragmentos soltos com coordenadas; agrupar por altura (Y) é
 * o que reconstrói a linha da tabela. Sem isso, "15/07  IFOOD  47,90" chegaria
 * como três pedaços desconexos e nenhum leitor funcionaria.
 */
async function extractPdfText(filePath) {
  installPdfPolyfills();
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(fs.readFileSync(filePath));
  const task = pdfjs.getDocument({ data, useSystemFonts: true, isEvalSupported: false });
  const document = await task.promise;

  const pages = [];
  for (let index = 1; index <= document.numPages; index++) {
    const page = await document.getPage(index);
    const content = await page.getTextContent();

    // Agrupa por linha usando a coordenada vertical, com tolerância de 2pt.
    const lines = new Map();
    for (const item of content.items) {
      if (!item.str?.trim()) continue;
      const y = Math.round(item.transform[5] / 2) * 2;
      if (!lines.has(y)) lines.set(y, []);
      lines.get(y).push({ x: item.transform[4], text: item.str });
    }

    const rendered = [...lines.entries()]
      .sort((a, b) => b[0] - a[0])                       // de cima para baixo
      .map(([, fragments]) => fragments
        .sort((a, b) => a.x - b.x)                       // da esquerda para a direita
        .map(fragment => fragment.text)
        .join(' ')
        .replace(/\s{2,}/g, '  ')                        // preserva colunas
        .trim())
      .filter(Boolean);

    pages.push(rendered.join('\n'));
  }
  await task.destroy();
  return pages.join('\n\n');
}

/** OCR para PDF escaneado ou foto de comprovante. Roda offline. */
async function extractImageText(filePath, onProgress = () => {}) {
  const { createWorker } = require('tesseract.js');
  // idioma embutido no Jarvis (FIN_TESSDATA): sem baixar nada da internet
  const local = process.env.FIN_TESSDATA;
  const worker = await createWorker('por', 1, {
    // o cache descompactado vai para a pasta de dados (o pacote do app não pode ser alterado)
    ...(local ? { langPath: local, cachePath: process.env.FIN_OCR_CACHE || local, gzip: true } : {}),
    logger: message => {
      if (message.status === 'recognizing text') onProgress(Math.round(message.progress * 100));
    }
  });
  try {
    const { data } = await worker.recognize(filePath);
    return data.text || '';
  } finally {
    await worker.terminate();
  }
}

// ---------------------------------------------------------------------------
// Identificação do banco
// ---------------------------------------------------------------------------

/**
 * Cada assinatura é um trecho que só aparece nos documentos daquele banco.
 * Saber qual banco é permite usar o leitor certo em vez do genérico.
 */
const BANK_SIGNATURES = [
  { id: 'nubank', name: 'Nubank', patterns: [/nu\s*pagamentos/i, /nubank/i, /\bnu\b.*\bs\.?a\.?/i] },
  { id: 'itau', name: 'Itaú', patterns: [/ita[uú]\s*unibanco/i, /\bita[uú]\b/i] },
  { id: 'bradesco', name: 'Bradesco', patterns: [/bradesco/i] },
  { id: 'bb', name: 'Banco do Brasil', patterns: [/banco do brasil/i, /\bbb\b.*extrato/i] },
  { id: 'santander', name: 'Santander', patterns: [/santander/i] },
  { id: 'caixa', name: 'Caixa', patterns: [/caixa econ[oô]mica/i] },
  { id: 'inter', name: 'Inter', patterns: [/banco inter/i, /\binter\s+s\.?a\.?/i] },
  { id: 'c6', name: 'C6 Bank', patterns: [/c6\s*bank/i, /banco c6/i] },
  { id: 'picpay', name: 'PicPay', patterns: [/picpay/i] },
  { id: 'mercadopago', name: 'Mercado Pago', patterns: [/mercado\s*pago/i] },
  { id: 'will', name: 'Will Bank', patterns: [/will\s*bank/i] },
  { id: 'neon', name: 'Neon', patterns: [/banco neon/i] }
];

function detectBank(text) {
  const head = String(text).slice(0, 4000);
  for (const bank of BANK_SIGNATURES) {
    if (bank.patterns.some(pattern => pattern.test(head))) return bank;
  }
  return null;
}

/** Fatura de cartão ou extrato de conta? Muda como interpretar os sinais. */
function detectDocumentType(text, fileName = '') {
  // O nome do arquivo é a pista mais confiável quando o conteúdo não se
  // identifica — o CSV de fatura do Nubank só tem "date,title,amount".
  const name = String(fileName).toLowerCase();
  if (/fatura|invoice|cartao|cart[ãa]o/.test(name)) return 'fatura';
  if (/extrato|statement/.test(name)) return 'extrato';

  const head = String(text).slice(0, 4000).toLowerCase();
  if (/fatura|limite\s+(total|dispon)|vencimento da fatura|pagamento m[ií]nimo|compras do per[ií]odo/.test(head)) {
    return 'fatura';
  }
  return 'extrato';
}

// ---------------------------------------------------------------------------
// Leitor genérico
// ---------------------------------------------------------------------------

const MONTH_ABBR = {
  jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6,
  jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12
};

/**
 * Linhas que não são lançamento: cabeçalho, rodapé, saldo, total.
 * Sem esse filtro o "SALDO ANTERIOR 1.234,56" entraria como uma despesa.
 */
const IGNORE_LINE = /^(saldo|total|subtotal|limite|extrato|per[ií]odo|data\s+hist|lan[çc]amentos|resumo|p[áa]gina|dispon[íi]vel|pagamento m[íi]nimo|encargos|juros do per|iof|vencimento|fechamento|melhor dia|cliente|ag[êe]ncia|conta:|cnpj|cpf|sac\b|ouvidoria|central de|www\.|https?:)/i;

/**
 * Procura em cada linha o trio data + descrição + valor.
 * Funciona na maioria dos extratos porque quase todos seguem esse formato,
 * mesmo com colunas em posições diferentes.
 */
function parseGenericLines(text, options = {}) {
  const today = options.today || dateOnly(new Date());
  const fallbackYear = options.year || today.slice(0, 4);
  const isInvoice = options.documentType === 'fatura';
  const rows = [];

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/\s+/g, ' ').trim();
    if (line.length < 8 || IGNORE_LINE.test(line)) continue;

    // --- data no início ---
    let date = null;
    let rest = line;

    let match = line.match(/^(\d{1,2})[/\-.](\d{1,2})(?:[/\-.](\d{2,4}))?\s+/);
    if (match) {
      const day = Number(match[1]);
      const month = Number(match[2]);
      let year = match[3] ? Number(match[3]) : Number(fallbackYear);
      if (year < 100) year += 2000;
      if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
        date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        rest = line.slice(match[0].length);
      }
    }

    if (!date) {
      // "15 JUL" ou "15 DE JULHO"
      match = line.match(/^(\d{1,2})\s+(?:de\s+)?([a-zç]{3,9})\.?\s+/i);
      const abbreviation = match && parser.normalize(match[2]).slice(0, 3);
      if (match && MONTH_ABBR[abbreviation]) {
        date = `${fallbackYear}-${String(MONTH_ABBR[abbreviation]).padStart(2, '0')}-${String(Number(match[1])).padStart(2, '0')}`;
        rest = line.slice(match[0].length);
      }
    }

    if (!date) {
      match = line.match(/^(\d{4}-\d{2}-\d{2})\s+/);
      if (match) { date = match[1]; rest = line.slice(match[0].length); }
    }

    if (!date) continue;

    // A linha de saldo só é reconhecível depois de tirar a data da frente:
    // "01/07/2026 SALDO ANTERIOR ..." não começa com "saldo".
    if (IGNORE_LINE.test(rest.trim())) continue;

    // --- valor no fim ---
    // "R$" precisa vir junto: aceitar um "R" solto faria o regex engolir o
    // "R" de "SAO PAULO BR" e truncar a descrição.
    const amountMatch = rest.match(
      /([-+−]?\s*(?:R\$)?\s*\d{1,3}(?:\.\d{3})+,\d{2}|[-+−]?\s*(?:R\$)?\s*\d+,\d{2})\s*([DC])?\s*$/i
    );
    if (!amountMatch) continue;

    const amount = parser.parseAmountToken(amountMatch[1]);
    if (!amount) continue;

    let description = rest.slice(0, amountMatch.index).trim()
      .replace(/\s{2,}/g, ' ')
      .replace(/\s*[-–]\s*$/, '');
    if (!description || description.length < 2) continue;

    // Parcela embutida na descrição: "NETSHOES 3/10"
    const installmentMatch = description.match(/\s(\d{1,2})\s*\/\s*(\d{1,2})\s*$/);
    let installment = null;
    if (installmentMatch) {
      installment = { number: Number(installmentMatch[1]), total: Number(installmentMatch[2]) };
      description = description.slice(0, installmentMatch.index).trim();
    }

    const hasMinus = /[-−]/.test(amountMatch[1]);
    const hasPlus = /\+/.test(amountMatch[1]);
    const marker = (amountMatch[2] || '').toUpperCase();

    // Numa fatura, tudo é gasto — menos o pagamento da própria fatura e estornos.
    const isPayment = /pagamento\s+(recebido|efetuado|fatura)|estorno|cr[ée]dito de|desconto/i.test(description);
    const isIncome = isInvoice
      ? isPayment
      : hasPlus || marker === 'C' || (!hasMinus && marker !== 'D' && /recebid|dep[óo]sito|sal[áa]rio|rendimento|estorno|resgate|cr[ée]dito/i.test(description));

    rows.push({
      date,
      description,
      amount: Math.abs(amount),
      isIncome,
      installment,
      // Transferência entre contas próprias não é entrada nem saída — a tela
      // de revisão sugere registrar como transferência.
      suggestedType: /transfer[êe]ncia entre contas|entre contas|aplica[çc][ãa]o|resgate/i.test(description)
        ? 'transfer' : null,
      raw: line
    });
  }

  return rows;
}

// ---------------------------------------------------------------------------
// CSV e OFX
// ---------------------------------------------------------------------------

function parseOFX(text) {
  const rows = [];
  for (const block of text.match(/<STMTTRN>[\s\S]*?<\/STMTTRN>/gi) || []) {
    const rawAmount = (block.match(/<TRNAMT>\s*(-?[0-9.,]+)/i) || [])[1];
    if (!rawAmount) continue;
    const rawDate = (block.match(/<DTPOSTED>\s*(\d{8})/i) || [])[1];
    const memo = (block.match(/<MEMO>([^<\r\n]+)/i) || block.match(/<NAME>([^<\r\n]+)/i) || [])[1];
    const value = parseFloat(String(rawAmount).replace(',', '.'));
    rows.push({
      date: rawDate ? `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}` : dateOnly(new Date()),
      description: (memo || 'Lançamento').trim(),
      amount: Math.abs(value),
      isIncome: value > 0
    });
  }
  return rows;
}

/**
 * CSV de verdade tem o mesmo número de colunas em toda linha. Sem essa
 * checagem, um extrato colado vira "CSV" só porque tem vírgula nos centavos —
 * e o resultado sai todo picado.
 */
function looksLikeCSV(text) {
  const lines = String(text).split(/\r?\n/).filter(line => line.trim()).slice(0, 12);
  if (lines.length < 3) return false;

  for (const delimiter of [';', ',', '\t']) {
    const counts = lines.map(line => (line.split(delimiter).length - 1));
    if (counts[0] < 2) continue;                      // precisa de 3+ colunas
    if (counts.every(count => count === counts[0])) return true;
  }
  return false;
}

function parseCSV(text, options = {}) {
  const lines = String(text).split(/\r?\n/).filter(line => line.trim());
  if (!lines.length) return [];

  const delimiter = (lines[0].match(/;/g) || []).length >= (lines[0].match(/,/g) || []).length ? ';' : ',';
  const splitLine = line => {
    const cells = [];
    let current = '';
    let quoted = false;
    for (const char of line) {
      if (char === '"') quoted = !quoted;
      else if (char === delimiter && !quoted) { cells.push(current); current = ''; }
      else current += char;
    }
    cells.push(current);
    return cells.map(cell => cell.trim().replace(/^"|"$/g, ''));
  };

  const header = splitLine(lines[0]).map(parser.normalize);
  const hasHeader = header.some(cell => /data|date|valor|amount|descr|hist|lan[çc]/.test(cell));
  const dateIndex = header.findIndex(cell => /data|date/.test(cell));
  const amountIndex = header.findIndex(cell => /valor|amount|montante|credito|debito/.test(cell));
  const descIndex = header.findIndex(cell => /descr|hist|memo|lan[çc]|estabelec|title/.test(cell));

  const rows = [];
  for (let index = hasHeader ? 1 : 0; index < lines.length; index++) {
    const cells = splitLine(lines[index]);
    if (cells.length < 2) continue;

    const rawAmount = cells[amountIndex >= 0 ? amountIndex : cells.length - 1] || '';
    const amount = parser.parseAmountToken(rawAmount);
    if (!amount) continue;

    const rawDate = cells[dateIndex >= 0 ? dateIndex : 0] || '';
    const dateInfo = parser.extractDate(rawDate, options.today || dateOnly(new Date()));
    const description = cells[descIndex >= 0 ? descIndex : 1] || 'Lançamento';

    rows.push({
      date: dateInfo.date,
      description: description.trim(),
      amount: Math.abs(amount),
      isIncome: !/-/.test(rawAmount)
        && /recebid|dep[óo]sito|sal[áa]rio|cr[ée]dito|rendimento|estorno/i.test(description)
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Entrada única
// ---------------------------------------------------------------------------

/**
 * Lê um arquivo e devolve os lançamentos encontrados, prontos para revisão.
 * Descobre sozinho o formato, o banco e o tipo de documento.
 */
async function readFile(filePath, options = {}) {
  if (!fs.existsSync(filePath)) throw new Error('Arquivo não encontrado.');
  const extension = path.extname(filePath).toLowerCase();
  const onProgress = options.onProgress || (() => {});

  let text = '';
  let method = '';

  if (['.png', '.jpg', '.jpeg', '.webp', '.heic', '.tiff', '.bmp'].includes(extension)) {
    onProgress({ stage: 'ocr', message: 'Lendo a imagem…' });
    text = await extractImageText(filePath, percent => onProgress({ stage: 'ocr', percent }));
    method = 'ocr';
  } else if (extension === '.pdf') {
    onProgress({ stage: 'pdf', message: 'Extraindo o texto do PDF…' });
    text = await extractPdfText(filePath);
    method = 'pdf';
    // PDF sem camada de texto é um scan: cai para OCR.
    if (text.replace(/\s/g, '').length < 80) {
      onProgress({ stage: 'ocr', message: 'PDF sem texto — usando reconhecimento de imagem…' });
      text = await extractImageText(filePath, percent => onProgress({ stage: 'ocr', percent }));
      method = 'pdf-ocr';
    }
  } else {
    text = fs.readFileSync(filePath, 'utf8');
    method = extension.replace('.', '') || 'texto';
  }

  return readText(text, { ...options, method, fileName: path.basename(filePath) });
}

/** Mesmo pipeline, para texto colado. */
async function readText(text, options = {}) {
  const bank = detectBank(text);
  const documentType = detectDocumentType(text, options.fileName);
  const today = options.today || dateOnly(new Date());

  let rows = [];
  let strategy = '';
  let meta = {};

  // 1º: leitor sob medida do banco. É o único que entende as peculiaridades
  // reais — duas colunas de valor, sinal depois do número, parcela no meio
  // da linha — e o único que sabe separar aplicação de despesa.
  const specific = banks.parse(text, { documentType, today, fileName: options.fileName });
  if (specific) {
    rows = specific.rows;
    meta = specific.meta || {};
    strategy = `leitor ${specific.bankName}`;
    if (meta.empty) {
      return {
        bank: specific.bankName, bankId: specific.bankId, documentType,
        strategy, method: options.method || 'texto', fileName: options.fileName || '',
        total: 0, duplicates: 0, rows: [], empty: true,
        emptyReason: meta.emptyReason, meta
      };
    }
  }

  if (!rows.length && /<STMTTRN>/i.test(text)) {
    rows = parseOFX(text);
    strategy = 'ofx';
  } else if (!rows.length && (options.method === 'csv' || looksLikeCSV(text))) {
    rows = parseCSV(text, { today });
    strategy = 'csv';
  }

  // A leitura por linhas é a rede de segurança: cobre bancos que ainda não
  // têm leitor próprio.
  if (!rows.length) {
    rows = parseGenericLines(text, { today, documentType, year: options.year });
    strategy = 'linhas';
  }

  if (!rows.length) {
    throw new Error(
      'Não reconheci lançamentos neste arquivo. ' +
      'Se for um extrato de um banco que ainda não conheço, me mande o arquivo em exemplos/ que eu faço o leitor.'
    );
  }

  const enriched = options.enrich === false ? rows : categorizer.enrichRows(rows);

  return {
    bank: specific?.bankName || bank?.name || null,
    bankId: specific?.bankId || bank?.id || null,
    documentType,
    strategy,
    method: options.method || 'texto',
    fileName: options.fileName || '',
    total: enriched.length,
    duplicates: enriched.filter(row => row.duplicate).length,
    meta,
    rows: enriched.sort((a, b) => String(b.date).localeCompare(String(a.date)))
  };
}

module.exports = {
  BANK_SIGNATURES,
  extractPdfText,
  extractImageText,
  detectBank,
  detectDocumentType,
  parseGenericLines,
  parseOFX,
  parseCSV,
  readFile,
  readText
};
