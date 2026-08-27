(() => {
  'use strict';

  // ---------------------------------------------------------------------------
  // Cache model
  // ---------------------------------------------------------------------------
  const MAP_DATA_VERSION = '2.9';
  const geojsonCache = new Map();          // map file -> Promise<GeoJSON>
  const prefectureCache = new Map();       // map file + prefecture -> prepared geometry
  const svgCache = new Map();              // prefecture + municipality -> Promise<SVGElement>

  const municipalityIndex = new Map(
    (window.MUNICIPALITIES || []).map(item => [`${item.pref}\u0000${item.name}`, item])
  );
  const prefectureMapFile = new Map(
    (window.MUNICIPALITIES || []).map(item => [item.pref, item.mapFile])
  );

  function loadGeoJSON(file) {
    if (!geojsonCache.has(file)) {
      // GeoJSON files can change when ward boundaries/background features are
      // added. A versioned URL prevents an older GitHub/browser cache from
      // hiding newly added wards, while no-cache still allows normal HTTP
      // revalidation (304) without repeatedly downloading unchanged data.
      const url = `./${file}?v=${encodeURIComponent(MAP_DATA_VERSION)}`;
      geojsonCache.set(file, fetch(url, { cache: 'no-cache' }).then(response => {
        if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
        return response.json();
      }));
    }
    return geojsonCache.get(file);
  }

  // ---------------------------------------------------------------------------
  // Geometry helpers
  // ---------------------------------------------------------------------------
  function polygonList(geometry) {
    if (!geometry) return [];
    if (geometry.type === 'Polygon') return [geometry.coordinates];
    if (geometry.type === 'MultiPolygon') return geometry.coordinates;
    return [];
  }

  function boundsOfPolygon(polygon) {
    let minLon = Infinity;
    let minLat = Infinity;
    let maxLon = -Infinity;
    let maxLat = -Infinity;

    for (const ring of polygon || []) {
      for (const point of ring || []) {
        const lon = point?.[0];
        const lat = point?.[1];
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        minLon = Math.min(minLon, lon);
        minLat = Math.min(minLat, lat);
        maxLon = Math.max(maxLon, lon);
        maxLat = Math.max(maxLat, lat);
      }
    }

    return Number.isFinite(minLon) ? [minLon, minLat, maxLon, maxLat] : null;
  }

  function mergeBounds(boundsList) {
    const valid = boundsList.filter(Boolean);
    if (!valid.length) return null;
    return [
      Math.min(...valid.map(bounds => bounds[0])),
      Math.min(...valid.map(bounds => bounds[1])),
      Math.max(...valid.map(bounds => bounds[2])),
      Math.max(...valid.map(bounds => bounds[3])),
    ];
  }

  function polygonAreaApprox(polygon) {
    const ring = polygon?.[0];
    if (!ring || ring.length < 3) return 0;

    const meanLat = ring.reduce((sum, point) => sum + point[1], 0) / ring.length;
    const lonKm = 111.32 * Math.max(Math.cos(meanLat * Math.PI / 180), 0.01);
    const latKm = 110.57;
    let twiceArea = 0;

    for (let index = 0; index < ring.length; index += 1) {
      const a = ring[index];
      const b = ring[(index + 1) % ring.length];
      const ax = a[0] * lonKm;
      const ay = a[1] * latKm;
      const bx = b[0] * lonKm;
      const by = b[1] * latKm;
      twiceArea += ax * by - bx * ay;
    }

    return Math.abs(twiceArea) / 2;
  }

  function bboxGapKm(a, b) {
    const lonGap = Math.max(a[0] - b[2], b[0] - a[2], 0);
    const latGap = Math.max(a[1] - b[3], b[1] - a[3], 0);
    const centerLat = ((a[1] + a[3]) + (b[1] + b[3])) / 4;
    const dx = lonGap * 111.32 * Math.max(Math.cos(centerLat * Math.PI / 180), 0.01);
    const dy = latGap * 110.57;
    return Math.hypot(dx, dy);
  }

  // Web-Mercator coordinates are used only for drawing. This fixes the
  // east-west stretching that was visible especially in Hokkaido.
  function mercatorRaw(lon, lat) {
    const x = lon * Math.PI / 180;
    const limitedLat = Math.max(-85, Math.min(85, lat));
    const phi = limitedLat * Math.PI / 180;
    const y = Math.log(Math.tan(Math.PI / 4 + phi / 2));
    return [x, y];
  }

  function projectedBounds(geoBounds) {
    const [minLon, minLat, maxLon, maxLat] = geoBounds;
    const [x1, y1] = mercatorRaw(minLon, minLat);
    const [x2, y2] = mercatorRaw(maxLon, maxLat);
    return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
  }

  function expandBounds(bounds, fraction = 0.018) {
    if (!bounds) return null;
    const [minLon, minLat, maxLon, maxLat] = bounds;
    const dx = Math.max(maxLon - minLon, 0.004);
    const dy = Math.max(maxLat - minLat, 0.004);
    return [
      minLon - dx * fraction,
      minLat - dy * fraction,
      maxLon + dx * fraction,
      maxLat + dy * fraction,
    ];
  }

  function fitScale(geoBounds, width = 600, height = 600, padding = 10) {
    const [minX, minY, maxX, maxY] = projectedBounds(geoBounds);
    const spanX = Math.max(maxX - minX, 1e-9);
    const spanY = Math.max(maxY - minY, 1e-9);
    const innerWidth = Math.max(1, width - padding * 2);
    const innerHeight = Math.max(1, height - padding * 2);
    return Math.min(innerWidth / spanX, innerHeight / spanY);
  }

  function makeProjector(geoBounds, width, height, padding = 10, offsetX = 0, offsetY = 0) {
    const [minX, minY, maxX, maxY] = projectedBounds(geoBounds);
    const spanX = Math.max(maxX - minX, 1e-9);
    const spanY = Math.max(maxY - minY, 1e-9);
    const innerWidth = Math.max(1, width - padding * 2);
    const innerHeight = Math.max(1, height - padding * 2);
    const scale = Math.min(innerWidth / spanX, innerHeight / spanY);
    const drawWidth = spanX * scale;
    const drawHeight = spanY * scale;
    const startX = offsetX + (width - drawWidth) / 2;
    const startY = offsetY + (height - drawHeight) / 2;

    return (lon, lat) => {
      const [x, y] = mercatorRaw(lon, lat);
      return [
        startX + (x - minX) * scale,
        startY + (maxY - y) * scale,
      ];
    };
  }

  function ringPath(ring, project) {
    if (!ring?.length) return '';
    return ring.map((point, index) => {
      const [x, y] = project(point[0], point[1]);
      return `${index ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`;
    }).join('') + 'Z';
  }

  function polygonPath(polygon, project) {
    return (polygon || []).map(ring => ringPath(ring, project)).join('');
  }

  function createPath(d, className) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    path.setAttribute('class', className);
    path.setAttribute('fill-rule', 'evenodd');
    path.setAttribute('vector-effect', 'non-scaling-stroke');
    return path;
  }

  function appendRect(svg, x, y, width, height) {
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', x);
    rect.setAttribute('y', y);
    rect.setAttribute('width', width);
    rect.setAttribute('height', height);
    rect.setAttribute('rx', '14');
    rect.setAttribute('class', 'municipality-map-inset');
    svg.appendChild(rect);
  }

  // ---------------------------------------------------------------------------
  // Prefecture preparation / island grouping
  // ---------------------------------------------------------------------------
  function preparePrefecture(prefFeatures, cacheKey) {
    if (prefectureCache.has(cacheKey)) return prefectureCache.get(cacheKey);

    const components = [];
    let largestArea = 0;

    for (const feature of prefFeatures) {
      for (const polygon of polygonList(feature.geometry)) {
        const bounds = boundsOfPolygon(polygon);
        if (!bounds) continue;
        const area = polygonAreaApprox(polygon);
        largestArea = Math.max(largestArea, area);
        components.push({ feature, polygon, bounds, area });
      }
    }

    // Very small rocks are intentionally excluded from viewport calculations.
    // They are the main reason a prefecture used to become unnecessarily tiny.
    const minArea = Math.max(largestArea * 0.00006, 0.002);
    let significant = components.filter(component => component.area >= minArea);
    if (!significant.length) significant = components.slice();

    const count = significant.length;
    const parent = Array.from({ length: count }, (_, index) => index);
    const find = value => {
      let root = value;
      while (parent[root] !== root) root = parent[root];
      while (parent[value] !== value) {
        const next = parent[value];
        parent[value] = root;
        value = next;
      }
      return root;
    };
    const union = (a, b) => {
      const rootA = find(a);
      const rootB = find(b);
      if (rootA !== rootB) parent[rootB] = rootA;
    };

    // Only genuinely adjacent land masses are connected. The small tolerance
    // absorbs simplification gaps without chaining remote islands to mainland.
    const bucketSize = 0.14;
    const joinKm = 0.8;
    const buckets = new Map();
    const bucketKey = (x, y) => `${x},${y}`;

    for (let index = 0; index < count; index += 1) {
      const bounds = significant[index].bounds;
      const minBucketX = Math.floor(bounds[0] / bucketSize);
      const maxBucketX = Math.floor(bounds[2] / bucketSize);
      const minBucketY = Math.floor(bounds[1] / bucketSize);
      const maxBucketY = Math.floor(bounds[3] / bucketSize);
      const checked = new Set();

      for (let bx = minBucketX - 1; bx <= maxBucketX + 1; bx += 1) {
        for (let by = minBucketY - 1; by <= maxBucketY + 1; by += 1) {
          const nearby = buckets.get(bucketKey(bx, by));
          if (!nearby) continue;
          for (const otherIndex of nearby) {
            if (checked.has(otherIndex)) continue;
            checked.add(otherIndex);
            if (bboxGapKm(bounds, significant[otherIndex].bounds) <= joinKm) {
              union(index, otherIndex);
            }
          }
        }
      }

      for (let bx = minBucketX; bx <= maxBucketX; bx += 1) {
        for (let by = minBucketY; by <= maxBucketY; by += 1) {
          const key = bucketKey(bx, by);
          if (!buckets.has(key)) buckets.set(key, []);
          buckets.get(key).push(index);
        }
      }
    }

    const grouped = new Map();
    for (let index = 0; index < count; index += 1) {
      const root = find(index);
      if (!grouped.has(root)) grouped.set(root, []);
      grouped.get(root).push(significant[index]);
    }

    const clusters = [...grouped.values()].map(items => ({
      items,
      area: items.reduce((sum, item) => sum + item.area, 0),
      bounds: mergeBounds(items.map(item => item.bounds)),
      names: new Set(items.map(item => item.feature.properties?.name)),
    })).sort((a, b) => b.area - a.area);

    const prepared = {
      components,
      significant,
      clusters,
      mainCluster: clusters[0] || null,
    };
    prefectureCache.set(cacheKey, prepared);
    return prepared;
  }

  function isTokyoMainlandFeature(feature) {
    const code = String(feature?.properties?.code || '');
    const numericCode = Number(code);
    if (!Number.isFinite(numericCode)) return false;

    // Tokyo mainland = 23 special wards + all 26 cities + the four
    // Nishitama mainland towns/villages. Izu/Ogasawara islands stay outside
    // this set so they can use the normal mainland + inset presentation.
    if (numericCode >= 13101 && numericCode <= 13123) return true;
    if (numericCode >= 13201 && numericCode <= 13229) return true;
    return ['13303', '13305', '13307', '13308'].includes(code);
  }

  function uniqueItems(clusters) {
    const result = [];
    const seen = new Set();
    for (const cluster of clusters) {
      for (const item of cluster.items) {
        if (seen.has(item)) continue;
        seen.add(item);
        result.push(item);
      }
    }
    return result;
  }

  // Nearby islands are drawn in the same prefecture canvas when doing so does
  // not materially shrink the mainland. This is scale-based rather than a
  // hand-maintained island list, so Sado / Rishiri / Rebun / Okushiri can be
  // shown naturally while remote groups such as Ogasawara still use an inset.
  const NEARBY_ISLAND_MIN_SCALE_RATIO = 0.88;

  function includeNearbyClusters(baseItems, baseBounds, clusters) {
    if (!baseBounds || !baseItems?.length) {
      return { items: baseItems || [], bounds: baseBounds, scaleRatio: 1, baseScale: baseBounds ? fitScale(baseBounds) : 1 };
    }

    const baseScale = fitScale(baseBounds);
    const included = [...baseItems];
    const includedSet = new Set(baseItems);
    let bounds = baseBounds;

    const candidates = (clusters || [])
      .filter(cluster => !cluster.items.some(item => includedSet.has(item)))
      .sort((a, b) => {
        const gapDiff = bboxGapKm(baseBounds, a.bounds) - bboxGapKm(baseBounds, b.bounds);
        return Math.abs(gapDiff) > 1e-9 ? gapDiff : b.area - a.area;
      });

    for (const cluster of candidates) {
      const combinedBounds = mergeBounds([bounds, cluster.bounds]);
      if (!combinedBounds) continue;
      const ratio = fitScale(combinedBounds) / baseScale;
      if (ratio + 1e-9 < NEARBY_ISLAND_MIN_SCALE_RATIO) continue;

      for (const item of cluster.items) {
        if (includedSet.has(item)) continue;
        includedSet.add(item);
        included.push(item);
      }
      bounds = combinedBounds;
    }

    return {
      items: included,
      bounds,
      scaleRatio: fitScale(bounds) / baseScale,
      baseScale,
    };
  }

  function drawItems(svg, items, targetName, project) {
    for (const component of items) {
      if ((Array.isArray(targetName) ? targetName.includes(component.feature.properties?.name) : component.feature.properties?.name === targetName)) continue;
      const d = polygonPath(component.polygon, project);
      if (d) svg.appendChild(createPath(d, 'municipality-map-outline'));
    }
    for (const component of items) {
      if (!(Array.isArray(targetName) ? targetName.includes(component.feature.properties?.name) : component.feature.properties?.name === targetName)) continue;
      const d = polygonPath(component.polygon, project);
      if (d) svg.appendChild(createPath(d, 'municipality-map-highlight'));
    }
  }

  // ---------------------------------------------------------------------------
  // SVG build / pre-render
  // ---------------------------------------------------------------------------
  async function buildMunicipalitySvg(pref, name) {
    const mapFile = prefectureMapFile.get(pref);
    if (!mapFile) throw new Error(`${pref}: map file metadata not found`);

    const geojson = await loadGeoJSON(mapFile);
    const prefFeatures = geojson.features.filter(feature => feature.properties?.pref === pref);
    if (!prefFeatures.some(feature => (Array.isArray(name) ? name.includes(feature.properties?.name) : feature.properties?.name === name))) {
      throw new Error(`${pref} ${name}: geometry not found`);
    }

    const prepared = preparePrefecture(prefFeatures, `${mapFile}\u0000${pref}`);
    const mainCluster = prepared.mainCluster;
    const targetClusters = prepared.clusters.filter(cluster => (Array.isArray(name) ? name.some(n => cluster.names.has(n)) : cluster.names.has(name)));
    const targetComponents = prepared.components.filter(
      component => (Array.isArray(name) ? name.includes(component.feature.properties?.name) : component.feature.properties?.name === name)
    );

    let mainItems = mainCluster?.items || prepared.significant;
    let mainBounds = mainCluster?.bounds || mergeBounds(mainItems.map(item => item.bounds));
    let targetIsOnMain = Boolean((Array.isArray(name) ? name.some(n => mainCluster?.names.has(n)) : mainCluster?.names.has(name)));

    // Tokyo needs a deterministic mainland definition. Automatic cluster
    // detection can split the 23 wards from Tama after geometry simplification,
    // which made a city such as Tachikawa render only the Tama side. Always
    // treat the 23 wards, 26 cities and four Nishitama mainland municipalities
    // as one mainland canvas. The islands continue to use an inset.
    if (pref === '東京都') {
      const tokyoMainItems = prepared.components.filter(component => isTokyoMainlandFeature(component.feature));
      const tokyoMainBounds = mergeBounds(tokyoMainItems.map(item => item.bounds));
      if (tokyoMainItems.length && tokyoMainBounds) {
        mainItems = tokyoMainItems;
        mainBounds = tokyoMainBounds;
        targetIsOnMain = targetComponents.some(component => isTokyoMainlandFeature(component.feature));
      }
    }

    // Add nearby island clusters only while the mainland stays at least 88% of
    // its original scale. This is evaluated cumulatively, so several nearby
    // islands can coexist without letting many small islands gradually shrink
    // the prefecture too much.
    const nearby = includeNearbyClusters(mainItems, mainBounds, prepared.clusters);
    mainItems = nearby.items;
    mainBounds = nearby.bounds;

    const targetMatches = component => (
      Array.isArray(name)
        ? name.includes(component.feature.properties?.name)
        : component.feature.properties?.name === name
    );
    targetIsOnMain = mainItems.some(targetMatches);

    // A tiny target island may have been excluded from the significant-cluster
    // set. If adding that target itself still preserves the same scale rule,
    // draw it in the main canvas instead of forcing an inset.
    if (!targetIsOnMain && targetComponents.length) {
      const targetBoundsRaw = mergeBounds(targetComponents.map(component => component.bounds));
      const combinedBounds = mergeBounds([mainBounds, targetBoundsRaw]);
      if (combinedBounds && fitScale(combinedBounds) / nearby.baseScale >= NEARBY_ISLAND_MIN_SCALE_RATIO) {
        const seen = new Set(mainItems);
        for (const component of targetComponents) {
          if (!seen.has(component)) mainItems.push(component);
        }
        mainBounds = combinedBounds;
        targetIsOnMain = true;
      }
    }

    const size = 600;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `${pref}内で${Array.isArray(name) ? name.join('・') : name}の位置を示す地図`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

    if (targetIsOnMain || !mainCluster) {
      const bounds = expandBounds(mainBounds);
      if (!bounds) throw new Error('map viewport unavailable');
      const project = makeProjector(bounds, size, size, 10);
      drawItems(svg, mainItems, name, project);
      return svg;
    }

    // Island municipality: keep the main land visible at normal scale, and add
    // a magnified inset for the target island group. This avoids the old issue
    // where including both in one geographic bbox made the whole map tiny.
    const expandedMainBounds = expandBounds(mainBounds, 0.02);
    const mainProject = makeProjector(expandedMainBounds, size, size, 12);
    drawItems(svg, mainItems, name, mainProject);

    // If a very small island was filtered out of the normal viewport clusters,
    // fall back to the original target polygons so it is still shown correctly.
    const targetItems = targetClusters.length ? uniqueItems(targetClusters) : targetComponents;
    const targetBounds = expandBounds(
      targetClusters.length
        ? mergeBounds(targetClusters.map(cluster => cluster.bounds))
        : mergeBounds(targetComponents.map(component => component.bounds)),
      0.06
    );
    if (!targetBounds || !targetItems.length) return svg;

    const insetSize = 238;
    const insetX = size - insetSize - 12;
    const insetY = size - insetSize - 12;
    appendRect(svg, insetX, insetY, insetSize, insetSize);
    const insetProject = makeProjector(targetBounds, insetSize, insetSize, 12, insetX, insetY);
    drawItems(svg, targetItems, name, insetProject);

    return svg;
  }

  function prepareMunicipalityMap(pref, name) {
    const key = `${pref}\u0000${Array.isArray(name) ? name.join('\u0001') : name}`;
    if (!svgCache.has(key)) {
      svgCache.set(key, buildMunicipalitySvg(pref, name));
    }
    return svgCache.get(key);
  }

  async function renderMunicipalityMap(container, pref, name) {
    if (!container) return;
    container.classList.remove('map-error');

    // If the question already warmed this map, this Promise resolves immediately
    // and no loading state is visually noticeable.
    if (!container.hasChildNodes()) {
      container.classList.add('map-loading');
      container.textContent = '地図を読み込み中…';
    }

    try {
      const svg = await prepareMunicipalityMap(pref, name);
      container.replaceChildren(svg.cloneNode(true));
      container.classList.remove('map-loading', 'map-error');
    } catch (error) {
      console.error(error);
      container.textContent = '地図を表示できませんでした';
      container.classList.remove('map-loading');
      container.classList.add('map-error');
    }
  }

  function normalizeItems(items) {
    return (items || []).filter(Boolean).map(item => {
      if (typeof item === 'string') return null;
      if (item.pref && (item.mapName || item.name)) return { pref: item.pref, name: item.mapName || item.name };
      return null;
    }).filter(Boolean);
  }

  async function prepareMany(items) {
    const normalized = normalizeItems(items);
    await Promise.allSettled(normalized.map(item => prepareMunicipalityMap(item.pref, item.name)));
  }

  async function preloadFiles(items) {
    const normalized = normalizeItems(items);
    const files = new Set();
    for (const item of normalized) {
      const mapFile = prefectureMapFile.get(item.pref);
      if (mapFile) files.add(mapFile);
    }
    await Promise.allSettled([...files].map(loadGeoJSON));
  }

  window.MunicipalityMap = Object.freeze({
    prepare: prepareMunicipalityMap,
    prepareMany,
    preloadFiles,
    render: renderMunicipalityMap,
  });

  // Backward-compatible entry point for existing quiz code.
  window.renderMunicipalityMap = renderMunicipalityMap;
})();
