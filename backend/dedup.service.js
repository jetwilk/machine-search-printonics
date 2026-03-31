/**
 * dedup.service.js — Detecção e agrupamento de equipamentos duplicados
 *
 * Lógica:
 *  - Chave de agrupamento = normalizar(marca) + normalizar(modelo) + ano
 *  - "Normalizar" = lowercase + remover espaços/hífens/pontuação
 *  - Exemplo: "Heidelberg SM52-4" (2018) === "heidelberg sm524" (2018)
 *  - Grupos com ≥2 ocorrências são considerados duplicados
 */

// ─────────────────────────────────────────────────────────────────────────────
// Normalização de strings para comparação fuzzy
// ─────────────────────────────────────────────────────────────────────────────
function normalize(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')   // remove tudo que não é alfanumérico
    .trim();
}

function groupKey(item) {
  return `${normalize(item.brand)}__${normalize(item.model)}__${normalize(item.year)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Deduplica um array de resultados
//
// Retorna:
//  {
//    unique:  [...],   // resultados sem duplicados (1 ocorrência)
//    grouped: [        // máquinas encontradas em ≥2 sites
//      {
//        brand, model, year, condition,
//        occurrences: [{ site, price, priceNum, location, url, currency }],
//        bestPrice:   { price, priceNum, site, url }  // menor preço com valor
//      }
//    ]
//  }
// ─────────────────────────────────────────────────────────────────────────────
function deduplicate(results) {
  const map = new Map();

  for (const item of results) {
    const key = groupKey(item);

    if (!map.has(key)) {
      map.set(key, {
        brand:     item.brand,
        model:     item.model,
        year:      item.year,
        occurrences: []
      });
    }

    map.get(key).occurrences.push({
      site: item.site,
      url:  item.url
    });
  }

  const unique  = [];
  const grouped = [];

  for (const group of map.values()) {
    // Ordenar ocorrências por nome de site
    group.occurrences.sort((a, b) => a.site.localeCompare(b.site));

    if (group.occurrences.length >= 2) {
      grouped.push(group);
    } else {
      unique.push({
        ...results.find(r => groupKey(r) === groupKey({ brand: group.brand, model: group.model, year: group.year })),
      });
    }
  }

  // Ordenar grupos por nº de ocorrências (mais encontrados primeiro)
  grouped.sort((a, b) => b.occurrences.length - a.occurrences.length);

  return { unique, grouped };
}

// ─────────────────────────────────────────────────────────────────────────────
// Estatísticas resumo
// ─────────────────────────────────────────────────────────────────────────────
function summarize(results, grouped) {
  const siteCounts = {};
  for (const r of results) {
    siteCounts[r.site] = (siteCounts[r.site] || 0) + 1;
  }

  return {
    total:      results.length,
    duplicated: grouped.length,
    sites:      Object.keys(siteCounts).length,
    siteCounts
  };
}

module.exports = { deduplicate, summarize, normalize, groupKey };