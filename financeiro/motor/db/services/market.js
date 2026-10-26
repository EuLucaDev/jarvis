'use strict';

const repo = require('../repository');
const catalog = require('./catalog');
const { now, toNumber, roundCurrency, generateId, dateOnly } = require('../utils');

const REQUEST_TIMEOUT = 9000;
const B3_TYPES = new Set(['ACAO', 'FII', 'FIAGRO', 'ETF', 'BDR', 'RENDA_VARIAVEL', 'FUNDO_IMOBILIARIO']);
const QUOTED_TYPES = new Set([...B3_TYPES, 'STOCK', 'REIT', 'ETF_INTERNACIONAL', 'CRIPTO']);
const COIN_IDS = {
  BTC: 'bitcoin', BITCOIN: 'bitcoin', ETH: 'ethereum', ETHEREUM: 'ethereum',
  SOL: 'solana', SOLANA: 'solana', USDT: 'tether', USDC: 'usd-coin',
  BNB: 'binancecoin', XRP: 'ripple', ADA: 'cardano', DOGE: 'dogecoin',
  AVAX: 'avalanche-2', LINK: 'chainlink', DOT: 'polkadot'
};

async function fetchJson(url, options = {}, timeout = REQUEST_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function config() {
  const settings = catalog.getSettings();
  return {
    brapiToken: String(settings.brapi_token || process.env.BRAPI_API_TOKEN || '').trim(),
    refreshMinutes: Math.max(5, Number(settings.quote_refresh_minutes) || 30)
  };
}

const headersForBrapi = token => token ? { Authorization: `Bearer ${token}` } : {};

function normalizedBrapiQuote(payload) {
  const first = payload?.results?.[0];
  if (!first) return null;
  const data = first.data || first;
  const price = toNumber(data.regularMarketPrice);
  if (!(price > 0)) return null;
  return {
    price,
    name: data.longName || data.shortName || first.symbol || '',
    currency: data.currency || 'BRL',
    changePercent: toNumber(data.regularMarketChangePercent),
    updatedAt: data.regularMarketTime || payload.requestedAt || now(),
    logoUrl: data.logourl || data.logoUrl || '',
    source: 'Brapi'
  };
}

async function quoteFromBrapi(item, token) {
  const symbol = encodeURIComponent(String(item.symbol || '').toUpperCase());
  if (!symbol) return null;
  if (item.assetClass === 'TESOURO_DIRETO') {
    const payload = await fetchJson(
      `https://brapi.dev/api/v2/treasury/indicators?symbols=${symbol.toLowerCase()}`,
      { headers: headersForBrapi(token) }
    );
    const first = payload?.results?.[0]?.data || payload?.results?.[0];
    const price = toNumber(first?.sellPrice || first?.buyPrice || first?.basePrice);
    if (!(price > 0)) return null;
    return {
      price,
      name: first.name || first.title || item.name,
      currency: 'BRL', changePercent: 0,
      updatedAt: first.referenceDate || payload.requestedAt || now(),
      logoUrl: '', source: 'Tesouro Direto · Brapi'
    };
  }
  const payload = await fetchJson(
    `https://brapi.dev/api/v2/stocks/quote?symbols=${symbol}`,
    { headers: headersForBrapi(token) }
  );
  return normalizedBrapiQuote(payload);
}

async function quoteFromYahoo(item) {
  let symbol = String(item.symbol || '').trim().toUpperCase();
  if (!symbol) return null;
  if ((item.market || 'BR') === 'BR' && !symbol.includes('.')) symbol += '.SA';
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
  const payload = await fetchJson(url, { headers: { 'User-Agent': 'Mozilla/5.0 Carteira-Pessoal/1.0' } }, 7000);
  const result = payload?.chart?.result?.[0];
  const meta = result?.meta;
  if (!meta) return null;
  const closes = (result.indicators?.quote?.[0]?.close || []).filter(value => Number.isFinite(value));
  const price = toNumber(meta.regularMarketPrice || closes.at(-1));
  if (!(price > 0)) return null;
  const previous = toNumber(meta.chartPreviousClose || meta.previousClose || closes.at(-2));
  return {
    price,
    name: meta.longName || meta.shortName || item.name,
    currency: meta.currency || item.currency || 'BRL',
    changePercent: previous > 0 ? ((price - previous) / previous) * 100 : 0,
    updatedAt: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : now(),
    logoUrl: item.logoUrl || '', source: 'Yahoo Finance'
  };
}

async function quoteFromCoinGecko(item) {
  const raw = String(item.symbol || '').trim();
  const id = String(item.providerId || COIN_IDS[raw.toUpperCase()] || raw.toLowerCase());
  if (!id) return null;
  const payload = await fetchJson(
    `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=brl,usd&include_24hr_change=true`,
    { headers: { Accept: 'application/json' } }, 7000
  );
  const data = payload?.[id];
  if (!data) return null;
  const currency = String(item.currency || 'BRL').toUpperCase();
  const key = currency === 'USD' ? 'usd' : 'brl';
  const price = toNumber(data[key]);
  if (!(price > 0)) return null;
  return {
    price, name: item.name || raw.toUpperCase(), currency,
    changePercent: toNumber(data[`${key}_24h_change`]), updatedAt: now(),
    logoUrl: item.logoUrl || '', source: 'CoinGecko'
  };
}

async function fetchQuote(item, token) {
  const type = item.assetClass || item.type;
  if (!QUOTED_TYPES.has(type) && type !== 'TESOURO_DIRETO') return null;
  if (type === 'CRIPTO') {
    try { return await quoteFromCoinGecko(item); } catch (error) { return null; }
  }
  if (B3_TYPES.has(type) || type === 'TESOURO_DIRETO') {
    try {
      const quote = await quoteFromBrapi(item, token);
      if (quote) return quote;
    } catch (error) { /* tenta a contingência abaixo */ }
  }
  if (type !== 'TESOURO_DIRETO') {
    try { return await quoteFromYahoo(item); } catch (error) { return null; }
  }
  return null;
}

function classFromBrapi(item) {
  const subType = String(item.subType || '').toLowerCase();
  if (subType === 'fii') return 'FII';
  if (subType === 'fi-agro') return 'FIAGRO';
  if (subType === 'etf') return 'ETF';
  if (subType === 'bdr' || item.type === 'bdr') return 'BDR';
  return 'ACAO';
}

async function searchBrapi(query, assetClass, token) {
  const params = new URLSearchParams({ search: query, limit: '8', page: '1' });
  const payload = await fetchJson(`https://brapi.dev/api/quote/list?${params}`, {
    headers: headersForBrapi(token)
  }, 7000);
  const rows = payload?.stocks || payload?.results || [];
  return rows.map(item => ({
    symbol: item.stock || item.symbol,
    name: item.longName || item.name || item.stock || item.symbol,
    assetClass: classFromBrapi(item), currency: 'BRL', market: 'BR',
    price: toNumber(item.close ?? item.quote?.lastPrice),
    changePercent: toNumber(item.change ?? item.quote?.changePercent),
    sector: item.subsector || item.sector || '', logoUrl: item.logo || item.logoUrl || '', source: 'Brapi'
  })).filter(item => item.symbol);
}

async function searchCrypto(query) {
  const payload = await fetchJson(
    `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(query)}`,
    { headers: { Accept: 'application/json' } }, 7000
  );
  const coins = (payload?.coins || []).slice(0, 8);
  let prices = {};
  if (coins.length) {
    try {
      prices = await fetchJson(
        `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(coins.map(item => item.id).join(','))}&vs_currencies=brl&include_24hr_change=true`,
        { headers: { Accept: 'application/json' } }, 7000
      );
    } catch (error) { /* a busca continua mesmo sem preço */ }
  }
  return coins.map(item => ({
    symbol: String(item.symbol || '').toUpperCase(), name: item.name,
    assetClass: 'CRIPTO', currency: 'BRL', market: 'GLOBAL',
    price: toNumber(prices?.[item.id]?.brl), changePercent: toNumber(prices?.[item.id]?.brl_24h_change),
    sector: item.market_cap_rank ? `Ranking #${item.market_cap_rank}` : 'Criptomoeda',
    logoUrl: item.thumb || '', source: 'CoinGecko', providerId: item.id
  }));
}

async function searchYahoo(query, assetClass) {
  const payload = await fetchJson(
    `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=8&newsCount=0`,
    { headers: { 'User-Agent': 'Mozilla/5.0 Carteira-Pessoal/1.0' } }, 7000
  );
  return (payload?.quotes || [])
    .filter(item => ['EQUITY', 'ETF', 'MUTUALFUND'].includes(item.quoteType))
    .slice(0, 8)
    .map(item => ({
      symbol: item.symbol, name: item.longname || item.shortname || item.symbol,
      assetClass: item.quoteType === 'ETF' ? 'ETF_INTERNACIONAL' : assetClass === 'REIT' ? 'REIT' : 'STOCK',
      currency: 'USD', market: 'US', price: toNumber(item.regularMarketPrice),
      changePercent: toNumber(item.regularMarketChangePercent), sector: item.exchDisp || item.exchange || '',
      logoUrl: '', source: 'Yahoo Finance'
    }));
}

async function searchTreasury(query, token) {
  const payload = await fetchJson(
    `https://brapi.dev/api/v2/treasury/list?search=${encodeURIComponent(query)}&limit=8`,
    { headers: headersForBrapi(token) }, 7000
  );
  const rows = payload?.bonds || payload?.results || payload?.treasury || [];
  return rows.map(raw => {
    const item = raw.data || raw;
    return {
      symbol: item.symbol, name: item.name || item.title || item.symbol,
      assetClass: 'TESOURO_DIRETO', currency: 'BRL', market: 'BR',
      price: toNumber(item.sellPrice || item.buyPrice || item.basePrice),
      changePercent: 0, sector: item.indexer || item.bondType || 'Tesouro Direto',
      logoUrl: '', source: 'Tesouro Direto · Brapi', maturityDate: item.maturityDate || ''
    };
  }).filter(item => item.symbol);
}

async function searchAssets(query, assetClass = 'ACAO') {
  const term = String(query || '').trim();
  if (term.length < 2) return { results: [], searchable: true };
  const token = config().brapiToken;
  try {
    if (assetClass === 'CRIPTO') return { results: await searchCrypto(term), searchable: true };
    if (assetClass === 'TESOURO_DIRETO') return { results: await searchTreasury(term, token), searchable: true };
    if (['STOCK', 'REIT', 'ETF_INTERNACIONAL'].includes(assetClass)) {
      return { results: await searchYahoo(term, assetClass), searchable: true };
    }
    if (['ACAO', 'FII', 'FIAGRO', 'ETF', 'BDR'].includes(assetClass)) {
      return { results: await searchBrapi(term, assetClass, token), searchable: true };
    }
    return {
      results: [], searchable: false,
      message: 'Esta classe não possui catálogo público de negociação. Informe o nome e os dados do contrato manualmente.'
    };
  } catch (error) {
    return { results: [], searchable: true, message: 'A fonte de dados não respondeu. Tente novamente em instantes.' };
  }
}

async function refreshQuotes() {
  const current = config();
  const assets = repo.all('investments')
    .filter(item => item.status === 'ATIVO' && item.autoQuote !== 0 && item.symbol);
  const updated = [];
  const failures = [];
  let exchange = { USD: 1, EUR: 1, BRL: 1 };
  try {
    const fx = await fetchJson('https://economia.awesomeapi.com.br/json/last/USD-BRL,EUR-BRL', {}, 5000);
    exchange = {
      ...exchange,
      USD: toNumber(fx?.USDBRL?.bid) || 1,
      EUR: toNumber(fx?.EURBRL?.bid) || 1
    };
  } catch (error) { /* mantém o último câmbio salvo por ativo */ }

  for (const item of assets) {
    const quote = await fetchQuote(item, current.brapiToken);
    if (!quote) {
      failures.push({ id: item.id, symbol: item.symbol, message: 'Cotação indisponível' });
      continue;
    }
    repo.update('investments', item.id, {
      name: item.name || quote.name || item.symbol,
      currentPrice: roundCurrency(quote.price),
      currency: quote.currency || item.currency || 'BRL',
      exchangeRate: exchange[String(quote.currency || item.currency || 'BRL').toUpperCase()] || item.exchangeRate || 1,
      dayChangePercent: quote.changePercent,
      quoteSource: quote.source,
      quoteUpdatedAt: quote.updatedAt,
      logoUrl: quote.logoUrl || item.logoUrl || ''
    });
    updated.push({ id: item.id, symbol: item.symbol, ...quote });
  }

  return {
    updated, failures, tokenConfigured: Boolean(current.brapiToken),
    message: updated.length
      ? `${updated.length} cotação(ões) atualizada(s).`
      : assets.length ? 'As fontes gratuitas não responderam para os ativos cadastrados.' : 'Nenhum ativo com cotação automática.'
  };
}

function positionAt(investmentId, referenceDate) {
  const operations = repo.query(
    'SELECT * FROM investment_operations WHERE investment_id = ? AND date <= ? ORDER BY date, created_at',
    [investmentId, referenceDate]
  );
  let quantity = 0;
  for (const item of operations) {
    const value = toNumber(item.quantity);
    if (['COMPRA', 'APORTE', 'BONIFICACAO', 'DESDOBRAMENTO'].includes(item.operationType)) quantity += value;
    if (['VENDA', 'RESGATE'].includes(item.operationType)) quantity -= value;
  }
  return Math.max(0, quantity);
}

async function syncIncomeForAsset(item) {
  const type = item.assetClass || item.type;
  if (!['ACAO', 'FII', 'FIAGRO', 'ETF', 'BDR', 'RENDA_VARIAVEL', 'FUNDO_IMOBILIARIO'].includes(type)) return 0;
  const token = config().brapiToken;
  const endpoint = ['FII', 'FIAGRO', 'FUNDO_IMOBILIARIO'].includes(type) ? 'fii' : 'stocks';
  const payload = await fetchJson(
    `https://brapi.dev/api/v2/${endpoint}/dividends?symbols=${encodeURIComponent(String(item.symbol).toUpperCase())}`,
    { headers: headersForBrapi(token) }
  );
  const first = payload?.results?.[0]?.data || payload?.results?.[0] || {};
  const rows = first.cashDividends || first.dividends || [];
  let inserted = 0;
  for (const row of rows) {
    const paymentDate = dateOnly(row.paymentDate || row.payment_date || '');
    const exDate = dateOnly(row.lastDatePrior || row.exDate || row.date_with || paymentDate);
    const rate = toNumber(row.rate || row.value || row.amount);
    if (!paymentDate || !(rate > 0)) continue;
    const externalKey = [item.symbol, paymentDate, row.label || row.type || 'PROVENTO', rate].join('|');
    const exists = repo.query(
      'SELECT id FROM investment_income WHERE investment_id = ? AND external_key = ?',
      [item.id, externalKey]
    )[0];
    if (exists) continue;
    const quantity = positionAt(item.id, exDate);
    repo.insert('investment_income', {
      id: generateId('income-investment'), investmentId: item.id,
      incomeType: String(row.label || row.type || 'DIVIDENDO').toUpperCase(),
      exDate, paymentDate, valuePerUnit: rate, quantity,
      totalAmount: roundCurrency(quantity * rate),
      status: paymentDate > dateOnly(now()) ? 'PREVISTO' : 'RECEBIDO',
      source: 'Brapi', externalKey, createdAt: now(), updatedAt: now()
    });
    inserted++;
  }
  return inserted;
}

async function syncIncome() {
  const assets = repo.all('investments').filter(item => item.status === 'ATIVO' && item.symbol);
  let inserted = 0;
  const failures = [];
  for (const item of assets) {
    try { inserted += await syncIncomeForAsset(item); }
    catch (error) { failures.push({ symbol: item.symbol, message: error.message }); }
  }
  return { inserted, failures };
}

function status() {
  const current = config();
  const quotes = repo.query(
    "SELECT quote_source, COUNT(*) AS total, MAX(quote_updated_at) AS updated_at FROM investments WHERE quote_source <> '' GROUP BY quote_source"
  );
  return {
    brapiConfigured: Boolean(current.brapiToken), refreshMinutes: current.refreshMinutes,
    sources: ['Brapi · B3 e Tesouro', 'CoinGecko · cripto', 'Yahoo Finance · contingência e exterior'],
    quotes
  };
}

module.exports = { config, status, searchAssets, fetchQuote, refreshQuotes, syncIncome, positionAt, QUOTED_TYPES };
