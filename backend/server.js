/**
 * server.js — API REST Express
 *
 * Rotas:
 *   GET    /api/health              → status do servidor e token Apify
 *   GET    /api/sites               → listar sites
 *   POST   /api/sites               → criar site
 *   PUT    /api/sites/:id           → actualizar site
 *   DELETE /api/sites/:id           → eliminar site
 *   POST   /api/sites/:id/test      → testar actor Apify do site
 *   POST   /api/search              → iniciar busca (SSE streaming de progresso)
 *   GET    /api/search/history      → histórico de buscas
 *   GET    /api/apify/validate      → validar token Apify
 *   GET    /api/apify/actor/:id     → info de um actor
 */

require('dotenv').config();

const express     = require('express');
const cors        = require('cors');
const rateLimit   = require('express-rate-limit');
const db          = require('./db');
const apifySvc    = require('./apify.service');
const dedupSvc    = require('./dedup.service');
const path        = require('path');        // ← ADICIONA ESTA LINHA
const app  = express();
const PORT = process.env.PORT || 3001;

app.get('/debug', (req, res) => {
  const fs = require('fs');
  const paths = [
    path.join(__dirname, 'frontend/public'),
    path.join(__dirname, '../frontend/public'),
    path.join(__dirname, 'public'),
    '/home/u895337781/domains/buscas.printonicsapp.fr/public_html/.builds/source/repository/frontend/public',
    '/home/u895337781/domains/buscas.printonicsapp.fr/nodejs/frontend/public',
  ];
  
  const result = {};
  paths.forEach(p => {
    result[p] = {
      existe: fs.existsSync(p),
      temIndex: fs.existsSync(path.join(p, 'index.html'))
    };
  });
  
  res.json({ __dirname, frontendPath: process.env.FRONTEND_PATH || 'não definido', paths: result });
});

// ── Middlewares ───────────────────────────────────────────────────────────────

app.use(cors({ origin: '*' }));
app.use(express.json());

// Serve ficheiros estáticos
const frontendPath = process.env.FRONTEND_PATH || path.join(__dirname, '../frontend/public');
app.use(express.static(frontendPath));

// Rota raiz explícita — garante que / carrega o index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(frontendPath, 'index.html'));
});

// Fallback para SPA — todas as rotas carregam o index.html
app.get('*', (req, res) => {
  const indexPath = path.join(frontendPath, 'index.html');
  const fs = require('fs');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).json({ 
      error: 'Frontend não encontrado', 
      procurou: indexPath,
      dirname: __dirname 
    });
  }
});

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      50,
  message:  { error: 'Muitos pedidos. Tenta novamente em 15 minutos.' }
});
app.use('/api/search', limiter);

// Autenticação simples por API key (opcional, activar em produção)
function authMiddleware(req, res, next) {
  const secret = process.env.API_SECRET;
  if (!secret) return next();   // sem secret configurado → não autenticar
  const key = req.headers['x-api-key'] || req.query.key;
  if (key !== secret) return res.status(401).json({ error: 'Não autorizado' });
  next();
}

// ── Health check ──────────────────────────────────────────────────────────────

app.get('/api/health', async (req, res) => {
  const hasToken = !!process.env.APIFY_TOKEN;
  let apifyOk = false;
  let apifyUser = null;

  if (hasToken) {
    try {
      const info = await apifySvc.validateToken();
      apifyOk   = true;
      apifyUser  = info.username;
    } catch (_) {}
  }

  res.json({
    status:    'ok',
    timestamp: new Date().toISOString(),
    apify:     { configured: hasToken, connected: apifyOk, user: apifyUser }
  });
});

// ── Sites CRUD ────────────────────────────────────────────────────────────────

app.get('/api/sites', (req, res) => {
  const sites = db.getSites();
  res.json({ sites });
});

app.post('/api/sites', authMiddleware, (req, res) => {
  const { name, url, searchUrl, category, region, currency,
          actorId, timeoutSecs, selectors, actorInput, active } = req.body;

  if (!name || !url) {
    return res.status(400).json({ error: 'Os campos "name" e "url" são obrigatórios.' });
  }

  const site = db.createSite({
    name, url, searchUrl, category, region, currency,
    actorId:     actorId     || process.env.DEFAULT_ACTOR || 'apify/cheerio-scraper',
    timeoutSecs: timeoutSecs || 90,
    selectors:   selectors   || {},
    actorInput:  actorInput  || {},
    active:      active !== undefined ? active : true
  });

  res.status(201).json({ site });
});

app.put('/api/sites/:id', authMiddleware, (req, res) => {
  const site = db.getSiteById(req.params.id);
  if (!site) return res.status(404).json({ error: 'Site não encontrado.' });

  const updated = db.updateSite(req.params.id, req.body);
  res.json({ site: updated });
});

app.delete('/api/sites/:id', authMiddleware, (req, res) => {
  const site = db.getSiteById(req.params.id);
  if (!site) return res.status(404).json({ error: 'Site não encontrado.' });

  db.deleteSite(req.params.id);
  res.json({ ok: true });
});

// ── Testar actor de um site ───────────────────────────────────────────────────

app.post('/api/sites/:id/test', authMiddleware, async (req, res) => {
  const site = db.getSiteById(req.params.id);
  if (!site) return res.status(404).json({ error: 'Site não encontrado.' });

  try {
    const info = await apifySvc.getActorInfo(site.actorId);
    res.json({ ok: true, actor: info });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// ── Busca com SSE (Server-Sent Events para progresso em tempo real) ────────────
//
//  O frontend liga-se a este endpoint via EventSource e recebe eventos:
//    { type: 'progress', site, query, status, count }  — por site concluído
//    { type: 'done',     results, grouped, stats }      — quando tudo termina
//    { type: 'error',    error }                        — se houver falha geral

app.post('/api/search', authMiddleware, async (req, res) => {
  const { queries, siteIds, useCache = true } = req.body;

  if (!queries?.length) {
    return res.status(400).json({ error: 'Pelo menos um termo de busca é necessário.' });
  }

  // Determinar sites a usar
  const allSites = db.getSites().filter(s => s.active);
  const sites = siteIds?.length
    ? allSites.filter(s => siteIds.includes(s.id))
    : allSites;

  if (!sites.length) {
    return res.status(400).json({ error: 'Nenhum site activo encontrado.' });
  }

  // Configurar SSE
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');   // nginx: desactivar buffering

  const send = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Helper para enviar keepalive enquanto os actors correm
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 15000);

  try {
    // Verificar cache
    const cacheKey = JSON.stringify({ queries: queries.sort(), siteIds: (siteIds || []).sort() });
    if (useCache) {
      const cached = db.getCached(cacheKey);
      if (cached) {
        const { grouped } = dedupSvc.deduplicate(cached);
        const stats       = dedupSvc.summarize(cached, grouped);
        send({ type: 'cache_hit' });
        send({ type: 'done', results: cached, grouped, stats, fromCache: true });
        clearInterval(keepAlive);
        res.end();
        return;
      }
    }

    const concurrency = parseInt(process.env.DEFAULT_CONCURRENCY) || 3;

    // Callback de progresso — enviado por SSE a cada site concluído
    // Inclui siteId para o frontend poder actualizar o dot por ID (mais robusto que por nome)
    const onProgress = (info) => send({ type: 'progress', ...info });

    const { results, errors } = await apifySvc.scrapeAll(sites, queries, concurrency, onProgress);

    // Deduplicar
    const { grouped } = dedupSvc.deduplicate(results);
    const stats       = dedupSvc.summarize(results, grouped);

    // Guardar cache e histórico
    db.setCache(cacheKey, results);
    db.saveSearch({
      queries,
      siteIds: sites.map(s => s.id),
      siteNames: sites.map(s => s.name),
      totalResults: results.length,
      duplicated: grouped.length,
      errors: errors.length
    });

    send({ type: 'done', results, grouped, stats, errors });

  } catch (err) {
    console.error('[Search] Erro geral:', err);
    send({ type: 'error', error: err.message });
  } finally {
    clearInterval(keepAlive);
    res.end();
  }
});

// ── Histórico ─────────────────────────────────────────────────────────────────

app.get('/api/search/history', (req, res) => {
  const limit   = parseInt(req.query.limit) || 50;
  const history = db.getSearchHistory(limit);
  res.json({ history });
});

app.delete('/api/search/history', authMiddleware, (req, res) => {
  db.clearHistory();
  res.json({ ok: true });
});

// ── Apify utils ───────────────────────────────────────────────────────────────

app.get('/api/apify/validate', async (req, res) => {
  try {
    const info = await apifySvc.validateToken();
    res.json({ ok: true, ...info });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.get('/api/apify/actor/:actorId(*)', async (req, res) => {
  try {
    const info = await apifySvc.getActorInfo(req.params.actorId);
    res.json({ ok: true, actor: info });
  } catch (err) {
    res.status(404).json({ ok: false, error: err.message });
  }
});

// ── Admin: BD ─────────────────────────────────────────────────────────────────
//
//  GET    /api/admin/db/info               → estado actual da BD
//  POST   /api/admin/db/backup             → criar backup manual
//  GET    /api/admin/db/backups            → listar backups disponiveis
//  POST   /api/admin/db/restore/:filename  → restaurar backup
//  DELETE /api/admin/db/cache              → limpar todo o cache (+ backup auto)
//  DELETE /api/admin/db/cache/expired      → limpar so cache expirado
//  DELETE /api/admin/db/all                → limpar cache + historico (+ backup auto)
//  DELETE /api/admin/db/reset              → reset completo incluindo sites (CUIDADO)

app.get('/api/admin/db/info', authMiddleware, (req, res) => {
  res.json(db.getDbInfo());
});

app.post('/api/admin/db/backup', authMiddleware, (req, res) => {
  const reason = req.body.reason || 'manual';
  const result = db.createBackup(reason);
  res.json(result);
});

app.get('/api/admin/db/backups', authMiddleware, (req, res) => {
  res.json({ backups: db.listBackups() });
});

app.post('/api/admin/db/restore/:filename', authMiddleware, (req, res) => {
  try {
    db.restoreBackup(req.params.filename);
    res.json({ ok: true, message: `Backup "${req.params.filename}" restaurado com sucesso` });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.delete('/api/admin/db/cache/expired', authMiddleware, (req, res) => {
  const result = db.clearExpiredCache();
  res.json({ ok: true, ...result });
});

app.delete('/api/admin/db/cache', authMiddleware, (req, res) => {
  const backup = req.query.backup !== 'false';
  const result = db.clearCache(backup);
  res.json({ ok: true, ...result });
});

app.delete('/api/admin/db/all', authMiddleware, (req, res) => {
  const backup = req.query.backup !== 'false';
  const result = db.clearAll(backup);
  res.json({ ok: true, ...result });
});

app.delete('/api/admin/db/reset', authMiddleware, (req, res) => {
  const confirm = req.body.confirm;
  if (confirm !== 'RESET_ALL') {
    return res.status(400).json({
      error: 'Para confirmar o reset completo envia { "confirm": "RESET_ALL" } no body'
    });
  }
  const result = db.resetAll(true);
  res.json({ ok: true, ...result });
});

// Limpeza automatica de cache expirado a cada hora
setInterval(() => {
  const result = db.clearExpiredCache();
  if (result.removed > 0) {
    console.log(`[Auto] Cache expirado: ${result.removed} entradas removidas`);
  }
}, 60 * 60 * 1000);

// ── Iniciar servidor ──────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n Machine Search API a correr em http://localhost:${PORT}`);
  console.log(`   Rede local: http://SEU_IP:${PORT}`);
  console.log(`   Apify token: ${process.env.APIFY_TOKEN ? 'configurado' : 'em falta (.env)'}`);
  console.log(`   Cache TTL: ${(db.CACHE_TTL_MS / 3600000).toFixed(1)} horas`);
  console.log(`   Base de dados: db.json\n`);
});