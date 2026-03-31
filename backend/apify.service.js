/**
 * apify.service.js — Integração real com a API do Apify
 *
 * Fluxo por site:
 *  1. Monta o input para o Actor (URL de busca + page function com selectores)
 *  2. Inicia o Actor via apify-client
 *  3. Faz polling até o run terminar (SUCCEEDED / FAILED / TIMED-OUT)
 *  4. Lê os items do dataset gerado
 *  5. Normaliza e devolve os resultados
 *
 * Actors suportados:
 *  - apify/cheerio-scraper   → HTML estático (mais rápido, mais barato)
 *  - apify/web-scraper       → Sites com JavaScript (usa jQuery no browser)
 *  - apify/playwright-scraper → Sites com anti-bot (usa Playwright/Chromium)
 */

require('dotenv').config();
const { ApifyClient } = require('apify-client');

// ── Cliente global ────────────────────────────────────────────────────────────
const client = new ApifyClient({ token: process.env.APIFY_TOKEN });

// ─────────────────────────────────────────────────────────────────────────────
// PAGE FUNCTION injectada no Actor
// Detecta automaticamente o tipo de actor e usa a API correcta
// ─────────────────────────────────────────────────────────────────────────────
function buildPageFunction(selectors, actorId = '') {
  const s = JSON.stringify(selectors);

  // web-scraper usa context.jQuery
  if (actorId.includes('web-scraper')) {
    return `
async function pageFunction(context) {
  const { jQuery: $, request, log } = context;
  const sel = ${s};
  const results = [];

  const containers = sel.container ? $(sel.container) : $('body');

  containers.each((i, el) => {
    const $el = $(el);

    const txt = (selector) => {
      if (!selector) return '';
      const found = selector.includes('[href')
        ? $el.find(selector).attr('href')
        : $el.find(selector).first().text().trim();
      return found || '';
    };

    let link = '';
    if (sel.link) {
      const $a = $el.find(sel.link).first();
      link = $a.attr('href') || '';
      if (link && !link.startsWith('http')) {
        link = new URL(link, request.url).href;
      }
    }

    const rawPrice = txt(sel.price);
    const cleanPrice = rawPrice.replace(/[^0-9.,€$£R\\s]/g, '').trim();

    const item = {
      brand:     txt(sel.brand)     || 'N/D',
      model:     txt(sel.model)     || 'N/D',
      year:      txt(sel.year)      || 'N/D',
      url:       link               || request.url,
      scrapedAt: new Date().toISOString()
    };

    if (item.brand !== 'N/D' || item.model !== 'N/D') {
      results.push(item);
    }
  });

  log.info('Extraídos ' + results.length + ' itens de ' + request.url);
  return results;
}
`;
  }

  // playwright-scraper usa context.page (Playwright API)
  if (actorId.includes('playwright')) {
    return `
async function pageFunction(context) {
  const { page, request, log } = context;
  const sel = ${s};

  await page.waitForSelector(sel.container || 'body', { timeout: 10000 }).catch(() => {});

  const items = await page.evaluate((sel) => {
    const containers = sel.container
      ? [...document.querySelectorAll(sel.container)]
      : [document.body];

    return containers.map(el => {
      const txt = (s) => {
        if (!s) return '';
        const found = el.querySelector(s);
        return found ? (found.getAttribute('href') || found.innerText.trim()) : '';
      };
      let link = '';
      if (sel.link) {
        const a = el.querySelector(sel.link);
        if (a) link = a.href || a.getAttribute('href') || '';
      }
      const rawPrice = txt(sel.price);
      const cleanPrice = rawPrice.replace(/[^0-9.,€$£R\\s]/g, '').trim();
      return {
        brand:     txt(sel.brand)     || 'N/D',
        model:     txt(sel.model)     || 'N/D',
        year:      txt(sel.year)      || 'N/D',
        url:       link               || window.location.href,
        scrapedAt: new Date().toISOString()
      };
    }).filter(item => item.brand !== 'N/D' || item.model !== 'N/D');
  }, sel);

  log.info('Extraídos ' + items.length + ' itens de ' + request.url);
  return items;
}
`;
  }

  // cheerio-scraper — HTML estático (padrão)
  return `
async function pageFunction(context) {
  const { $, request, log } = context;
  const sel = ${s};
  const results = [];

  const containers = sel.container ? $(sel.container) : $('body');

  containers.each((i, el) => {
    const $el = $(el);

    // txtClean: extrai texto removendo sub-elementos indesejados (ex: .float-right)
    // Usado para campos onde o selector pai contém spans extra (Pressxchange, PressCity)
    const txtClean = (selector, removeChild) => {
      if (!selector) return '';
      const $found = $el.find(selector).first();
      if (!$found.length) return '';
      if (removeChild) {
        const $clone = $found.clone();
        $clone.find(removeChild).remove();
        return $clone.text().trim();
      }
      return $found.text().trim();
    };

    const txt = (selector) => {
      if (!selector) return '';
      const found = selector.startsWith('a') && selector.includes('[href')
        ? $el.find(selector).attr('href')
        : $el.find(selector).first().text().trim();
      return found || '';
    };

    let link = '';
    if (sel.link) {
      const $a = $el.find(sel.link).first();
      link = $a.attr('href') || '';
      if (link && !link.startsWith('http')) {
        link = new URL(link, request.url).href;
      }
    }

    const rawPrice = txt(sel.price);
    const cleanPrice = rawPrice.replace(/[^0-9.,€$£R\\s]/g, '').trim();

    // Para marca e modelo: remover .float-right do elemento pai se existir
    // Resolve o problema do Pressxchange onde o ano (.float-right) esta dentro do titulo
    const brandRaw = txtClean(sel.brand, '.float-right') || txt(sel.brand) || 'N/D';
    const modelRaw = txtClean(sel.model, '.float-right') || txt(sel.model) || 'N/D';

    const item = {
      brand:     brandRaw,
      model:     modelRaw,
      year:      txt(sel.year)      || 'N/D',
      url:       link               || request.url,
      scrapedAt: new Date().toISOString()
    };

    if (item.brand !== 'N/D' || item.model !== 'N/D') {
      results.push(item);
    }
  });

  log.info('Extraídos ' + results.length + ' itens de ' + request.url);
  return results;
}
`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Monta o input completo para o Actor do Apify
// ─────────────────────────────────────────────────────────────────────────────
function buildActorInput(site, query) {
  const searchUrl = site.searchUrl.replace('{query}', encodeURIComponent(query));

  // Remover maxPages do actorInput para não passar ao Apify
  const { maxPages, ...cleanActorInput } = site.actorInput || {};

  // Só usar paginação se maxPages estiver explicitamente definido
  let startUrls;
  if (maxPages && maxPages > 1) {
    startUrls = [];
    for (let i = 1; i <= maxPages; i++) {
      const pageUrl = searchUrl.includes('?')
        ? `${searchUrl}&page=${i}`
        : `${searchUrl}?page=${i}`;
      startUrls.push({ url: pageUrl });
    }
  } else {
    // Comportamento original — só o URL base
    startUrls = [{ url: searchUrl }];
  }

  const baseInput = {
    startUrls,
    pageFunction: buildPageFunction(site.selectors, site.actorId),
    maxRequestsPerCrawl: 100,
    maxConcurrency: 5,
    ...cleanActorInput
  };

  if (site.actorId.includes('web-scraper')) {
    baseInput.waitUntil = cleanActorInput?.waitUntil || ['networkidle2'];
  }

  return baseInput;
}

// ─────────────────────────────────────────────────────────────────────────────
// Faz polling do run até terminar ou timeout
// ─────────────────────────────────────────────────────────────────────────────
async function waitForRun(runId, timeoutSecs = 120) {
  const POLL_INTERVAL_MS = 3000;
  const deadline = Date.now() + timeoutSecs * 1000;

  while (Date.now() < deadline) {
    const run = await client.run(runId).get();

    if (run.status === 'SUCCEEDED') return run;
    if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(run.status)) {
      throw new Error(`Actor terminou com status: ${run.status}`);
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }

  await client.run(runId).abort().catch(() => {});
  throw new Error(`Timeout de ${timeoutSecs}s atingido para o site`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Scrape de um único site para um único termo de busca
// ─────────────────────────────────────────────────────────────────────────────
async function scrapeSite(site, query) {
  const actorId = site.actorId || process.env.DEFAULT_ACTOR || 'apify/cheerio-scraper';
  const timeout = site.timeoutSecs || parseInt(process.env.DEFAULT_TIMEOUT_SECS) || 120;
  const input   = buildActorInput(site, query);

  console.log(`[Apify] Iniciando actor "${actorId}" para site "${site.name}" | query: "${query}"`);

  // .start() em vez de .call() — apify-client v2 nao aceita timeoutSecs nas opcoes
  const run = await client.actor(actorId).start(input, {
    memory: actorId.includes('web-scraper') || actorId.includes('playwright')
      ? 1024   // Puppeteer/Playwright precisam de mais memoria
      : 512    // cheerio-scraper pode ficar com 512 MB
  });

  const finishedRun = await waitForRun(run.id, timeout);

  const { items } = await client.dataset(finishedRun.defaultDatasetId).listItems({
    limit: 500
  });

  // ── Normalização ────────────────────────────────────────────────────────────
  const results = (Array.isArray(items) ? items : []).flatMap(item => {
    const rows = Array.isArray(item) ? item : [item];
    return rows.map(row => {

      // 1) Limpar prefixos "Brand: Heidelberg" → "Heidelberg"
      //    OffsetPoint e sites com tabela label:valor
      //    Só actua se o campo contiver ":" — não afecta outros sites
      const cleanLabel = (val) => (val && val.includes(':'))
        ? val.replace(/^[^:]+:\s*/i, '').trim()
        : val;

      row.brand     = cleanLabel(row.brand);
      row.model     = cleanLabel(row.model);
      row.year      = cleanLabel(row.year);

      // 2) Split "ANO MARCA MODELO" num único campo
      //    PressCity/MachineryHost: "2005 Heidelberg CD 102-6"
      //    Normaliza espaços extras antes de testar o padrão
      //    Só actua se começar com 4 dígitos — não afecta Werktuigen/Exapro/OffsetPoint
      const titulo = row.brand || row.model || '';
      const tituloLimpo = titulo.replace(/\s+/g, ' ').trim();
      const m = tituloLimpo.match(/^(\d{4})\s+(\S+)\s+(.+)$/);
      if (m) {
        row.brand = m[2];
        row.model = m[3];
        if (!row.year || row.year === 'N/D') row.year = m[1];
      }
      if (row.model) row.model = row.model.replace(/\s*\(\d{4}\)\s*$/, '').trim();
      return {
        brand:     row.brand     || 'N/D',
        model:     row.model     || 'N/D',
        year:      row.year      || 'N/D',
        url:       row.url       || '',
        site:      site.name,
        scrapedAt: row.scrapedAt || new Date().toISOString()
      };
    });
  });

  console.log(`[Apify] Site "${site.name}" → ${results.length} resultados`);
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scrape de MÚLTIPLOS sites com concorrência controlada
// ─────────────────────────────────────────────────────────────────────────────
async function scrapeAll(sites, queries, concurrency = 3, onProgress = null) {
  const tasks = [];

  for (const query of queries) {
    for (const site of sites) {
      tasks.push({ site, query });
    }
  }

  const allResults = [];
  const errors     = [];

  for (let i = 0; i < tasks.length; i += concurrency) {
    const batch = tasks.slice(i, i + concurrency);

    const settled = await Promise.allSettled(
      batch.map(({ site, query }) => scrapeSite(site, query))
    );

    settled.forEach((result, idx) => {
      const { site, query } = batch[idx];

      if (result.status === 'fulfilled') {
        allResults.push(...result.value);
        if (onProgress) onProgress({ site: site.name, query, status: 'ok', count: result.value.length });
      } else {
        const errMsg = result.reason?.message || 'Erro desconhecido';
        console.error(`[Apify] Erro em "${site.name}" (${query}): ${errMsg}`);
        errors.push({ site: site.name, query, error: errMsg });
        if (onProgress) onProgress({ site: site.name, query, status: 'error', error: errMsg });
      }
    });
  }

  return { results: allResults, errors };
}

// ─────────────────────────────────────────────────────────────────────────────
// Validar token e info de actor (usado no backoffice)
// ─────────────────────────────────────────────────────────────────────────────
async function validateToken() {
  const user = await client.user('me').get();
  return { valid: true, username: user.username, plan: user.plan?.id };
}

async function getActorInfo(actorId) {
  const actor = await client.actor(actorId).get();
  if (!actor) throw new Error(`Actor "${actorId}" não encontrado`);
  return {
    id:          actor.id,
    name:        actor.name,
    description: actor.description,
    version:     actor.defaultRunOptions?.build
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: extrair valor numérico de uma string de preço
// ex: "€ 48.000" → 48000  |  "$ 1,200.50" → 1200.50
// ─────────────────────────────────────────────────────────────────────────────
function parsePrice(str) {
  if (!str || str === '—') return 0;
  const cleaned = str.replace(/[€$£R\s]/g, '').replace(/\.(?=\d{3})/g, '').replace(',', '.');
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

module.exports = { scrapeAll, scrapeSite, validateToken, getActorInfo, parsePrice };