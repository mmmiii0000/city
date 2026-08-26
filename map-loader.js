(() => {
  'use strict';

  const mapCache = new Map();
  const viewportCache = new Map();
  const municipalityIndex = new Map(
    (window.MUNICIPALITIES || []).map(item => [`${item.pref}\u0000${item.name}`, item])
  );

  function loadGeoJSON(file) {
    if (!mapCache.has(file)) {
      mapCache.set(file, fetch(`./${file}`).then(response => {
        if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
        return response.json();
      }));
    }
    return mapCache.get(file);
  }

  function polygonList(geometry) {
    if (!geometry) return [];
    if (geometry.type === 'Polygon') return [geometry.coordinates];
    if (geometry.type === 'MultiPolygon') return geometry.coordinates;
    return [];
  }

  function boundsOfPolygon(polygon) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const ring of polygon || []) {
      for (const point of ring || []) {
        const x = point?.[0];
        const y = point?.[1];
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    return Number.isFinite(minX) ? [minX, minY, maxX, maxY] : null;
  }

  function mergeBounds(boundsList) {
    const valid = boundsList.filter(Boolean);
    if (!valid.length) return null;
    return [
      Math.min(...valid.map(b => b[0])),
      Math.min(...valid.map(b => b[1])),
      Math.max(...valid.map(b => b[2])),
      Math.max(...valid.map(b => b[3])),
    ];
  }

  function polygonAreaApprox(polygon) {
    const ring = polygon?.[0];
    if (!ring || ring.length < 3) return 0;
    let meanLat = 0;
    for (const point of ring) meanLat += point[1];
    meanLat /= ring.length;
    const lonFactor = Math.max(Math.cos(meanLat * Math.PI / 180), 0.01);
    let twiceArea = 0;
    for (let i = 0; i < ring.length; i += 1) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      twiceArea += (a[0] * lonFactor) * b[1] - (b[0] * lonFactor) * a[1];
    }
    return Math.abs(twiceArea) / 2;
  }

  function bboxGapKm(a, b) {
    const lonGap = Math.max(a[0] - b[2], b[0] - a[2], 0);
    const latGap = Math.max(a[1] - b[3], b[1] - a[3], 0);
    const centerLat = (Math.max(a[1], b[1]) + Math.min(a[3], b[3])) / 2;
    const dx = lonGap * 111.32 * Math.max(Math.cos(centerLat * Math.PI / 180), 0.01);
    const dy = latGap * 110.57;
    return Math.hypot(dx, dy);
  }

  function boundsIntersect(a, b, marginDeg = 0) {
    return !(
      a[2] < b[0] - marginDeg ||
      a[0] > b[2] + marginDeg ||
      a[3] < b[1] - marginDeg ||
      a[1] > b[3] + marginDeg
    );
  }

  function preparePrefectureViewport(prefFeatures, pref) {
    const cacheKey = `${pref}\u0000${prefFeatures.length}`;
    if (viewportCache.has(cacheKey)) return viewportCache.get(cacheKey);

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

    // Tiny rocks and minute islets are useful in the source data but should not
    // control the map viewport. Keep meaningful land components for clustering.
    const minArea = Math.max(largestArea * 0.0002, 1e-8);
    let significant = components.filter(component => component.area >= minArea);
    if (!significant.length) significant = components.slice();

    // Build geographic land groups. Adjacent mainland municipalities naturally
    // connect because their polygon bounds touch. Remote island groups remain
    // separate, so they no longer make the prefecture appear tiny.
    const n = significant.length;
    const parent = Array.from({ length: n }, (_, i) => i);
    const find = (x) => {
      let root = x;
      while (parent[root] !== root) root = parent[root];
      while (parent[x] !== x) {
        const next = parent[x];
        parent[x] = root;
        x = next;
      }
      return root;
    };
    const union = (a, b) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[rb] = ra;
    };

    // Spatial buckets keep this fast even for prefectures containing thousands
    // of tiny source polygons.
    const bucketSize = 0.35;
    const buckets = new Map();
    const bucketKey = (x, y) => `${x},${y}`;
    for (let i = 0; i < n; i += 1) {
      const b = significant[i].bounds;
      const minBX = Math.floor(b[0] / bucketSize);
      const maxBX = Math.floor(b[2] / bucketSize);
      const minBY = Math.floor(b[1] / bucketSize);
      const maxBY = Math.floor(b[3] / bucketSize);
      const seen = new Set();
      for (let bx = minBX - 1; bx <= maxBX + 1; bx += 1) {
        for (let by = minBY - 1; by <= maxBY + 1; by += 1) {
          const list = buckets.get(bucketKey(bx, by));
          if (!list) continue;
          for (const j of list) {
            if (seen.has(j)) continue;
            seen.add(j);
            if (bboxGapKm(b, significant[j].bounds) <= 18) union(i, j);
          }
        }
      }
      for (let bx = minBX; bx <= maxBX; bx += 1) {
        for (let by = minBY; by <= maxBY; by += 1) {
          const key = bucketKey(bx, by);
          if (!buckets.has(key)) buckets.set(key, []);
          buckets.get(key).push(i);
        }
      }
    }

    const clustersByRoot = new Map();
    for (let i = 0; i < n; i += 1) {
      const root = find(i);
      if (!clustersByRoot.has(root)) clustersByRoot.set(root, []);
      clustersByRoot.get(root).push(significant[i]);
    }

    const clusters = [...clustersByRoot.values()].map(items => ({
      items,
      area: items.reduce((sum, item) => sum + item.area, 0),
      bounds: mergeBounds(items.map(item => item.bounds)),
      names: new Set(items.map(item => item.feature.properties?.name)),
    })).sort((a, b) => b.area - a.area);

    const prepared = { components, clusters, mainCluster: clusters[0] || null };
    viewportCache.set(cacheKey, prepared);
    return prepared;
  }

  function chooseViewport(prepared, targetName) {
    const { clusters, mainCluster, components } = prepared;
    if (!clusters.length) return mergeBounds(components.map(item => item.bounds));

    const targetClusters = clusters
      .filter(cluster => cluster.names.has(targetName))
      .sort((a, b) => b.area - a.area);

    // If the municipality lies on the prefecture's principal land group, show
    // the principal group. For a remote-island municipality, focus that island
    // group instead of shrinking the entire prefecture to include distant land.
    if (mainCluster?.names.has(targetName)) return mainCluster.bounds;
    if (targetClusters.length) return targetClusters[0].bounds;

    const targetComponents = components.filter(item => item.feature.properties?.name === targetName);
    return mergeBounds(targetComponents.map(item => item.bounds)) || mainCluster?.bounds;
  }

  function padBounds(bounds, fraction = 0.055) {
    if (!bounds) return bounds;
    const [minX, minY, maxX, maxY] = bounds;
    const dx = Math.max(maxX - minX, 0.02);
    const dy = Math.max(maxY - minY, 0.02);
    return [minX - dx * fraction, minY - dy * fraction, maxX + dx * fraction, maxY + dy * fraction];
  }

  function makeProjector(bounds, width, height, padding) {
    const [minLon, minLat, maxLon, maxLat] = bounds;
    const centerLat = (minLat + maxLat) / 2;
    const lonFactor = Math.max(Math.cos(centerLat * Math.PI / 180), 0.01);
    const minX = minLon * lonFactor;
    const maxX = maxLon * lonFactor;
    const minY = minLat;
    const maxY = maxLat;
    const spanX = Math.max(maxX - minX, 1e-9);
    const spanY = Math.max(maxY - minY, 1e-9);
    const scale = Math.min((width - padding * 2) / spanX, (height - padding * 2) / spanY);
    const drawW = spanX * scale;
    const drawH = spanY * scale;
    const offsetX = (width - drawW) / 2;
    const offsetY = (height - drawH) / 2;

    return (lon, lat) => [
      offsetX + (lon * lonFactor - minX) * scale,
      offsetY + (maxY - lat) * scale,
    ];
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

  async function renderMunicipalityMap(container, pref, name) {
    const info = municipalityIndex.get(`${pref}\u0000${name}`);
    if (!info) {
      container.textContent = `${pref} ${name} の地図データがありません`;
      container.classList.add('map-error');
      return;
    }

    container.classList.add('map-loading');
    container.textContent = '地図を読み込み中…';

    try {
      const geojson = await loadGeoJSON(info.mapFile);
      const prefFeatures = geojson.features.filter(feature => feature.properties?.pref === pref);
      const target = prefFeatures.find(feature => feature.properties?.name === name);
      if (!target) throw new Error('対象自治体を見つけられませんでした');

      const prepared = preparePrefectureViewport(prefFeatures, pref);
      const focusBounds = padBounds(chooseViewport(prepared, name));
      if (!focusBounds) throw new Error('表示範囲を計算できませんでした');

      const width = 560;
      const height = 330;
      const project = makeProjector(focusBounds, width, height, 18);
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', `${pref}内で${name}の位置を示す地図`);
      svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

      // Render only polygons near the chosen land group. Distant island groups
      // are deliberately omitted from this viewport so the useful area remains large.
      const margin = Math.max(focusBounds[2] - focusBounds[0], focusBounds[3] - focusBounds[1]) * 0.03;
      const visible = prepared.components.filter(component => boundsIntersect(component.bounds, focusBounds, margin));

      for (const component of visible) {
        if (component.feature.properties?.name === name) continue;
        const d = polygonPath(component.polygon, project);
        if (d) svg.appendChild(createPath(d, 'municipality-map-outline'));
      }

      for (const component of visible) {
        if (component.feature.properties?.name !== name) continue;
        const d = polygonPath(component.polygon, project);
        if (d) svg.appendChild(createPath(d, 'municipality-map-highlight'));
      }

      container.replaceChildren(svg);
      container.classList.remove('map-loading', 'map-error');
    } catch (error) {
      console.error(error);
      container.textContent = '地図を表示できませんでした';
      container.classList.remove('map-loading');
      container.classList.add('map-error');
    }
  }

  window.renderMunicipalityMap = renderMunicipalityMap;

  for (const container of document.querySelectorAll('.municipality-map[data-pref][data-name]')) {
    renderMunicipalityMap(container, container.dataset.pref, container.dataset.name);
  }
})();
