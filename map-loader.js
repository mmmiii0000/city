(() => {
  'use strict';

  const mapCache = new Map();
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

  function visitPositions(value, callback) {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number') {
      callback(value[0], value[1]);
      return;
    }
    for (const child of value) visitPositions(child, callback);
  }

  function boundsOf(features) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const feature of features) {
      visitPositions(feature.geometry?.coordinates, (x, y) => {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      });
    }
    return Number.isFinite(minX) ? [minX, minY, maxX, maxY] : null;
  }

  function makeProjector(bounds, width, height, padding) {
    const [minX, minY, maxX, maxY] = bounds;
    const spanX = Math.max(maxX - minX, 1e-9);
    const spanY = Math.max(maxY - minY, 1e-9);
    const scale = Math.min((width - padding * 2) / spanX, (height - padding * 2) / spanY);
    const drawW = spanX * scale;
    const drawH = spanY * scale;
    const offsetX = (width - drawW) / 2;
    const offsetY = (height - drawH) / 2;
    return (x, y) => [
      offsetX + (x - minX) * scale,
      offsetY + (maxY - y) * scale,
    ];
  }

  function ringPath(ring, project) {
    if (!ring?.length) return '';
    return ring.map((point, index) => {
      const [x, y] = project(point[0], point[1]);
      return `${index ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`;
    }).join('') + 'Z';
  }

  function geometryPath(geometry, project) {
    if (!geometry) return '';
    if (geometry.type === 'Polygon') {
      return geometry.coordinates.map(ring => ringPath(ring, project)).join('');
    }
    if (geometry.type === 'MultiPolygon') {
      return geometry.coordinates
        .map(polygon => polygon.map(ring => ringPath(ring, project)).join(''))
        .join('');
    }
    return '';
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
      const bounds = boundsOf(prefFeatures);
      if (!target || !bounds) throw new Error('対象自治体を見つけられませんでした');

      const width = 420;
      const height = 250;
      const project = makeProjector(bounds, width, height, 14);
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', `${pref}内で${name}の位置を示す地図`);
      svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

      for (const feature of prefFeatures) {
        if (feature === target) continue;
        const d = geometryPath(feature.geometry, project);
        if (d) svg.appendChild(createPath(d, 'municipality-map-outline'));
      }

      const targetPath = geometryPath(target.geometry, project);
      if (targetPath) svg.appendChild(createPath(targetPath, 'municipality-map-highlight'));

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
