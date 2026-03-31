/**
 * db.js - Persistencia de dados com lowdb
 *
 * Guarda: sites cadastrados, historico de buscas, cache de resultados
 *
 * Boas praticas implementadas:
 *  - Cache com TTL configuravel (padrao: 4 horas)
 *  - Limpeza selectiva: cache / historico / tudo
 *  - Backup automatico antes de qualquer limpeza destrutiva
 *  - Backup manual via API
 *  - Info de estado da BD
 */

const low      = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const path     = require('path');
const fs       = require('fs');
const { v4: uuid } = require('uuid');

const DB_PATH    = path.join(__dirname, 'db.json');
const BACKUP_DIR = path.join(__dirname, 'backups');

if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

const adapter = new FileSync(DB_PATH);
const db = low(adapter);

const CACHE_TTL_MS = (parseInt(process.env.CACHE_TTL_HOURS) || 4) * 60 * 60 * 1000;

db.defaults({ sites: [], searches: [], cache: [] }).write();

// ── Backup ────────────────────────────────────────────────────────────────────

function createBackup(reason) {
  try {
    const ts   = new Date().toISOString().replace(/[:.]/g, '-');
    const name = `db_backup_${reason}_${ts}.json`;
    const dest = path.join(BACKUP_DIR, name);
    fs.copyFileSync(DB_PATH, dest);
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('db_backup_')).sort();
    if (files.length > 20) {
      files.slice(0, files.length - 20).forEach(f =>
        fs.unlinkSync(path.join(BACKUP_DIR, f)));
    }
    console.log(`[DB] Backup criado: ${name}`);
    return { ok: true, file: name };
  } catch (err) {
    console.error('[DB] Erro ao criar backup:', err.message);
    return { ok: false, error: err.message };
  }
}

function listBackups() {
  try {
    return fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('db_backup_'))
      .sort().reverse()
      .map(f => {
        const stat = fs.statSync(path.join(BACKUP_DIR, f));
        return { file: f, sizeKb: Math.round(stat.size / 1024), created: stat.mtime.toISOString() };
      });
  } catch { return []; }
}

function restoreBackup(filename) {
  const src = path.join(BACKUP_DIR, filename);
  if (!fs.existsSync(src)) throw new Error(`Backup "${filename}" nao encontrado`);
  createBackup('pre-restore');
  fs.copyFileSync(src, DB_PATH);
  const fresh = low(new FileSync(DB_PATH));
  db.setState(fresh.getState());
  console.log(`[DB] Restaurado backup: ${filename}`);
}

// ── Info ──────────────────────────────────────────────────────────────────────

function getDbInfo() {
  const stat      = fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH) : null;
  const cache     = db.get('cache').value();
  const now       = Date.now();
  const valid     = cache.filter(e => (now - new Date(e.savedAt).getTime()) < CACHE_TTL_MS);
  const expired   = cache.filter(e => (now - new Date(e.savedAt).getTime()) >= CACHE_TTL_MS);
  return {
    file:          DB_PATH,
    sizeKb:        stat ? Math.round(stat.size / 1024) : 0,
    sites:         db.get('sites').value().length,
    searches:      db.get('searches').value().length,
    cacheTotal:    cache.length,
    cacheValid:    valid.length,
    cacheExpired:  expired.length,
    cacheTtlHours: CACHE_TTL_MS / 3600000,
    backups:       listBackups().length,
    lastModified:  stat ? stat.mtime.toISOString() : null
  };
}

// ── Limpeza ───────────────────────────────────────────────────────────────────

function clearCache(backup = true) {
  if (backup) createBackup('pre-clear-cache');
  const count = db.get('cache').value().length;
  db.set('cache', []).write();
  console.log(`[DB] Cache limpo: ${count} entradas removidas`);
  return { removed: count };
}

function clearExpiredCache() {
  const now    = Date.now();
  const before = db.get('cache').value().length;
  db.get('cache').remove(e => (now - new Date(e.savedAt).getTime()) >= CACHE_TTL_MS).write();
  const removed = before - db.get('cache').value().length;
  console.log(`[DB] Cache expirado: ${removed} entradas removidas`);
  return { removed };
}

function clearHistory(backup = true) {
  if (backup) createBackup('pre-clear-history');
  const count = db.get('searches').value().length;
  db.set('searches', []).write();
  console.log(`[DB] Historico limpo: ${count} entradas removidas`);
  return { removed: count };
}

function clearAll(backup = true) {
  if (backup) createBackup('pre-clear-all');
  const cc = db.get('cache').value().length;
  const sc = db.get('searches').value().length;
  db.set('cache', []).write();
  db.set('searches', []).write();
  console.log(`[DB] Tudo limpo: ${cc} cache + ${sc} historico`);
  return { cacheRemoved: cc, searchesRemoved: sc };
}

function resetAll(backup = true) {
  if (backup) createBackup('pre-reset-all');
  db.set('sites', []).write();
  db.set('cache', []).write();
  db.set('searches', []).write();
  console.log('[DB] Reset completo efectuado');
  return { ok: true };
}

// ── Sites ─────────────────────────────────────────────────────────────────────

module.exports = {

  createBackup, listBackups, restoreBackup, getDbInfo,
  clearCache, clearExpiredCache, clearHistory, clearAll, resetAll,
  CACHE_TTL_MS,

  getSites:     () => db.get('sites').value(),
  getSiteById:  (id) => db.get('sites').find({ id }).value(),

  createSite: (data) => {
    const site = { id: uuid(), ...data, createdAt: new Date().toISOString() };
    db.get('sites').push(site).write();
    return site;
  },

  updateSite: (id, data) => {
    db.get('sites').find({ id }).assign({ ...data, updatedAt: new Date().toISOString() }).write();
    return db.get('sites').find({ id }).value();
  },

  deleteSite: (id) => db.get('sites').remove({ id }).write(),

  saveSearch: (data) => {
    const entry = { id: uuid(), ...data, createdAt: new Date().toISOString() };
    db.get('searches').unshift(entry).write();
    const all = db.get('searches').value();
    if (all.length > 100) db.set('searches', all.slice(0, 100)).write();
    return entry;
  },

  getSearchHistory: (limit = 50) => db.get('searches').take(limit).value(),

  getCached: (cacheKey) => {
    const entry = db.get('cache').find({ key: cacheKey }).value();
    if (!entry) return null;
    const age = Date.now() - new Date(entry.savedAt).getTime();
    if (age > CACHE_TTL_MS) {
      db.get('cache').remove({ key: cacheKey }).write();
      return null;
    }
    return entry.results;
  },

  setCache: (cacheKey, results) => {
    db.get('cache').remove({ key: cacheKey }).write();
    db.get('cache').push({ key: cacheKey, results, savedAt: new Date().toISOString() }).write();
    const all = db.get('cache').value();
    if (all.length > 200) db.set('cache', all.slice(all.length - 200)).write();
  }
};