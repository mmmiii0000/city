(() => {
  'use strict';

  const mapCache = new Map();
  const preparedCache = new Map();
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
        maxLon = Math.max(maxLon, lon);
        minLat = Math.min(minLat, lat);
        maxLat = Math.max(maxLat, lat);
      }
    }
    return Number.isFinite(minLon) ? [minLon, minLat, maxLon, maxLat] : null;
  }

  function mergeBounds(list) {
    const valid = list.filter(Boolean);
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
    const meanLat = ring.reduce((sum, p) => sum + p[1], 0) / ring.length;
    const lonScale = Math.max(Math.cos(meanLat * Math.PI / 180), 0.01);
    let twiceArea = 0;
    for (let i = 0; i < ring.length; i += 1) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      twiceArea += (a[0] * lonScale) * b[1] - (b[0] * lonScale) * a[1];
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

  function preparePrefecture(prefFeatures, pref) {
    const key = `${pref}\u0000${prefFeatures.length}`;
    if (preparedCache.has(key)) return preparedCache.get(key);

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

    // Remove only minute rocks from viewport calculations. They remain in the
    // source, but should never make a prefecture appear tiny.
    const minArea = Math.max(largestArea * 0.00008, 1e-10);
    let significant = components.filter(item => item.area >= minArea);
    if (!significant.length) significant = components.slice();

    // Cluster only truly adjacent land. A small threshold connects boundaries
    // that were slightly separated by simplification, but it does not chain
    // remote islands into the mainland viewport.
    const n = significant.length;
    const parent = Array.from({ length: n }, (_, i) => i);
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
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[rb] = ra;
    };

    const bucketSize = 0.18;
    const joinKm = 1.5;
    const buckets = new Map();
    const bucketKey = (x, y) => `${x},${y}`;

    for (let i = 0; i < n; i += 1) {
      const bounds = significant[i].bounds;
      const minBX = Math.floor(bounds[0] / bucketSize);
      const maxBX = Math.floor(bounds[2] / bucketSize);
      const minBY = Math.floor(bounds[1] / bucketSize);
      const maxBY = Math.floor(bounds[3] / bucketSize);
      const checked = new Set();

      for (let bx = minBX - 1; bx <= maxBX + 1; bx += 1) {
        for (let by = minBY - 1; by <= maxBY + 1; by += 1) {
          const nearby = buckets.get(bucketKey(bx, by));
          if (!nearby) continue;
          for (const j of nearby) {
            if (checked.has(j)) continue;
            checked.add(j);
            if (bboxGapKm(bounds, significant[j].bounds) <= joinKm) union(i, j);
          }
        }
      }

      for (let bx = minBX; bx <= maxBX; bx += 1) {
        for (let by = minBY; by <= maxBY; by += 1) {
          const k = bucketKey(bx, by);
          if (!buckets.has(k)) buckets.set(k, []);
          buckets.get(k).push(i);
        }
      }
    }

    const grouped = new Map();
    for (let i = 0; i < n; i += 1) {
      const root = find(i);
      if (!grouped.has(root)) grouped.set(root, []);
      grouped.get(root).push(significant[i]);
    }

    const clusters = [...grouped.values()].map(items => ({
      items,
      area: items.reduce((sum, item) => sum + item.area, 0),
      bounds: mergeBounds(items.map(item => item.bounds)),
      names: new Set(items.map(item => item.feature.properties?.name)),
    })).sort((a, b) => b.area - a.area);

    const prepared = { components, significant, clusters, mainCluster: clusters[0] || null };
    preparedCache.set(key, prepared);
    return prepared;
  }

  function chooseCluster(prepared, targetName) {
    if (!prepared.clusters.length) return null;
    if (prepared.mainCluster?.names.has(targetName)) return prepared.mainCluster;

    // Island municipality: focus on the largest land group containing that
    // municipality instead of zooming out to include every remote island.
    const targetClusters = prepared.clusters
      .filter(cluster => cluster.names.has(targetName))
      .sort((a, b) => b.area - a.area);
    return targetClusters[0] || prepared.mainCluster;
  }

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

  function expandBounds(bounds, fraction = 0.008) {
    if (!bounds) return null;
    const [minLon, minLat, maxLon, maxLat] = bounds;
    const dx = Math.max(maxLon - minLon, 0.005);
    const dy = Math.max(maxLat - minLat, 0.005);
    return [
      minLon - dx * fraction,
      minLat - dy * fraction,
      maxLon + dx * fraction,
      maxLat + dy * fraction,
    ];
  }

  function makeProjector(geoBounds, width, height, padding = 3) {
    const [minX, minY, maxX, maxY] = projectedBounds(geoBounds);
    const spanX = Math.max(maxX - minX, 1e-9);
    const spanY = Math.max(maxY - minY, 1e-9);
    const scale = Math.min((width - padding * 2) / spanX, (height - padding * 2) / spanY);
    const drawW = spanX * scale;
    const drawH = spanY * scale;
    const offsetX = (width - drawW) / 2;
    const offsetY = (height - drawH) / 2;

    return (lon, lat) => {
      const [x, y] = mercatorRaw(lon, lat);
      return [
        offsetX + (x - minX) * scale,
        offsetY + (maxY - y) * scale,
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
      if (!prefFeatures.some(feature => feature.properties?.name === name)) {
        throw new Error('対象自治体を見つけられませんでした');
      }

      const prepared = preparePrefecture(prefFeatures, pref);
      const cluster = chooseCluster(prepared, name);
      const bounds = expandBounds(cluster?.bounds || mergeBounds(prepared.significant.map(item => item.bounds)));
      if (!bounds) throw new Error('表示範囲を計算できませんでした');

      const width = 760;
      const height = 520;
      const project = makeProjector(bounds, width, height, 3);
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', `${pref}内で${name}の位置を示す地図`);
      svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

      const visibleItems = cluster?.items || prepared.significant;
      for (const component of visibleItems) {
        if (component.feature.properties?.name === name) continue;
        const d = polygonPath(component.polygon, project);
        if (d) svg.appendChild(createPath(d, 'municipality-map-outline'));
      }
      for (const component of visibleItems) {
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
})();
