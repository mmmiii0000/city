(async () => {
  'use strict';

  // ---------------------------------------------------------------------------
  // Data bootstrap
  // ---------------------------------------------------------------------------
  const municipalities = Array.isArray(window.MUNICIPALITIES) ? window.MUNICIPALITIES : [];
  if (!municipalities.length) {
    console.error('municipalities.js が読み込まれていません。');
    return;
  }

  const POPULATION_2026_URLS = [
    'https://huggingface.co/datasets/yhay81/japan-municipal-open-data-atlas-2026/raw/d388159/municipalities_city_level.csv',
    'https://huggingface.co/datasets/yhay81/japan-municipal-open-data-atlas-2026/raw/main/municipalities_city_level.csv',
  ];

  function parseCsvLine(line) {
    const values = [];
    let value = '';
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"') {
        if (quoted && line[i + 1] === '"') {
          value += '"';
          i += 1;
        } else {
          quoted = !quoted;
        }
      } else if (ch === ',' && !quoted) {
        values.push(value);
        value = '';
      } else {
        value += ch;
      }
    }
    values.push(value);
    return values;
  }

  function recalculatePopulationStats() {
    const byPref = new Map();
    for (const item of municipalities) {
      item.density = Number.isFinite(item.population) && Number.isFinite(item.area) && item.area > 0
        ? Math.round((item.population / item.area) * 10) / 10
        : null;
      if (!byPref.has(item.pref)) byPref.set(item.pref, []);
      byPref.get(item.pref).push(item);
    }

    for (const items of byPref.values()) {
      items
        .filter(item => Number.isFinite(item.population))
        .slice()
        .sort((a, b) => b.population - a.population || a.code.localeCompare(b.code))
        .forEach((item, index) => { item.populationRank = index + 1; });
    }
  }

  async function updatePopulation2026() {
    let lastError = null;
    for (const url of POPULATION_2026_URLS) {
      try {
        const response = await fetch(url, { mode: 'cors', cache: 'force-cache' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = await response.text();
        const lines = text.split(/\r?\n/).filter(Boolean);
        if (lines.length < 2) throw new Error('人口CSVが空です');

        const header = parseCsvLine(lines[0]);
        const codeIndex = header.indexOf('standard_area_code');
        const populationIndex = header.indexOf('resident_register_population_total');
        const dateIndex = header.indexOf('resident_register_population_observation_date');
        if (codeIndex < 0 || populationIndex < 0 || dateIndex < 0) {
          throw new Error('人口CSVの列構成を認識できません');
        }

        const populationByCode = new Map();
        let observationDate = '2026-01-01';
        for (let i = 1; i < lines.length; i += 1) {
          const row = parseCsvLine(lines[i]);
          const code = row[codeIndex];
          const population = Number(row[populationIndex]);
          if (!/^\d{5}$/.test(code) || !Number.isFinite(population)) continue;
          populationByCode.set(code, population);
          if (row[dateIndex]) observationDate = row[dateIndex];
        }

        let updated = 0;
        for (const item of municipalities) {
          const population = populationByCode.get(item.code);
          if (!Number.isFinite(population)) continue;
          item.population = population;
          item.populationDate = observationDate;
          updated += 1;
        }
        if (updated < municipalities.length * 0.98) {
          throw new Error(`人口データの突合件数が不足しています (${updated}/${municipalities.length})`);
        }

        recalculatePopulationStats();
        document.documentElement.dataset.populationDate = observationDate;
        const sourceDate = document.querySelector('#population-source-date');
        if (sourceDate) sourceDate.textContent = observationDate;
        return true;
      } catch (error) {
        lastError = error;
      }
    }

    console.warn('2026年人口データを取得できなかったため、同梱の人口データを使用します。', lastError);
    recalculatePopulationStats();
    const sourceDate = document.querySelector('#population-source-date');
    if (sourceDate) sourceDate.textContent = municipalities[0]?.populationDate || '2024-01-01';
    return false;
  }

  await updatePopulation2026();

  // ---------------------------------------------------------------------------
  // DOM / source model
  // ---------------------------------------------------------------------------
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];

  const els = {
    gameLayout: $('#game-layout'),
    startScreen: $('#start-screen'),
    startButton: $('#start-game-button'),
    startSettingsButton: $('#start-settings-button'),
    endScreen: $('#end-screen'),
    endCorrect: $('#end-correct'),
    endTotal: $('#end-total'),
    endRate: $('#end-rate'),
    endMaxStreak: $('#end-max-streak'),
    wrongList: $('#wrong-list'),
    wrongEmpty: $('#wrong-empty'),
    restartSameButton: $('#restart-same-button'),
    restartSettingsButton: $('#restart-settings-button'),

    questionNo: $('#question-no'),
    questionTotal: $('#question-total'),
    progressBar: $('#question-progress'),
    municipalityName: $('#municipality-name'),
    duplicateNotice: $('#duplicate-notice'),
    duplicateText: $('#duplicate-text'),
    answerSlots: $('#answer-slots'),
    prefectureButtons: $$('.prefecture[data-pref]'),
    resetButton: $('#reset-selection'),
    answerButton: $('#answer-button'),
    correctRate: $('#correct-rate'),
    scoreCount: $('#score-count'),
    streak: $('#current-streak'),
    resultPanel: $('#result-panel'),
    resultStatus: $('#result-status'),
    resultTitle: $('#result-title'),
    resultSentence: $('#result-sentence'),
    resultEmpty: $('#result-empty'),
    resultCards: $('#result-cards'),
    nextButton: $('#next-button'),

    settingsWrap: $('.settings-popover-wrap'),
    settingsButton: $('.settings-button'),
    settingsPopover: $('#settings-popover'),
    settingsClose: $('.settings-close'),
  };

  const groupByName = new Map();
  for (const item of municipalities) {
    if (!groupByName.has(item.name)) groupByName.set(item.name, []);
    groupByName.get(item.name).push(item);
  }
  const allGroups = [...groupByName.values()].map(group =>
    group.slice().sort((a, b) => a.pref.localeCompare(b.pref, 'ja'))
  );

  const state = {
    phase: 'start', // start | playing | ended
    questionLimit: 10,
    type: '全部',
    region: '全国',
    queue: [],
    questionIndex: 0,
    currentGroup: null,
    selectedPrefs: [],
    answered: false,
    correct: 0,
    answeredCount: 0,
    streak: 0,
    maxStreak: 0,
    mistakes: [],
    lastName: null,
    actualGameTotal: 10,
    replaceIndex: 0,
  };

  // ---------------------------------------------------------------------------
  // Generic helpers
  // ---------------------------------------------------------------------------
  function shuffle(array) {
    const a = array.slice();
    for (let i = a.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function formatInteger(value) {
    return new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 }).format(value);
  }

  function formatNumber(value, digits) {
    return new Intl.NumberFormat('ja-JP', { maximumFractionDigits: digits }).format(value);
  }

  function joinJapanese(parts) {
    if (parts.length <= 1) return parts[0] || '';
    if (parts.length === 2) return `${parts[0]} と ${parts[1]}`;
    return `${parts.slice(0, -1).join('、')}、${parts.at(-1)}`;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[ch]));
  }


  // ---------------------------------------------------------------------------
  // Settings popover
  // ---------------------------------------------------------------------------
  function setSettingsOpen(open) {
    if (!els.settingsPopover || !els.settingsButton) return;
    els.settingsPopover.hidden = !open;
    els.settingsButton.setAttribute('aria-expanded', String(open));
  }

  function syncSettingsButtons() {
    for (const group of $$('.settings-popover .setting-group')) {
      const legend = group.querySelector('legend')?.textContent.trim();
      for (const button of group.querySelectorAll('button')) {
        const value = button.textContent.trim();
        let active = false;
        if (legend === '問題数') {
          active = Number.isFinite(state.questionLimit)
            ? parseInt(value, 10) === state.questionLimit
            : value === 'エンドレス';
        } else if (legend === '出題する自治体') {
          active = value === state.type;
        } else if (legend === '出題する地方') {
          active = value === state.region;
        }
        button.classList.toggle('active', active);
      }
    }
  }

  function readSettingChange(legend, value) {
    if (legend === '問題数') {
      return { key: 'questionLimit', value: value === 'エンドレス' ? Infinity : parseInt(value, 10) };
    }
    if (legend === '出題する自治体') return { key: 'type', value };
    if (legend === '出題する地方') return { key: 'region', value };
    return null;
  }

  function applySettingChange(legend, value) {
    const change = readSettingChange(legend, value);
    if (!change || Object.is(state[change.key], change.value)) return;

    if (state.phase === 'playing' && state.questionIndex > 0) {
      const ok = window.confirm('出題設定を変更すると、現在のゲームをリセットして新しいゲームを開始します。変更しますか？');
      if (!ok) {
        syncSettingsButtons();
        return;
      }
    }

    state[change.key] = change.value;
    syncSettingsButtons();

    if (state.phase === 'playing') {
      startGame();
    } else if (state.phase === 'ended') {
      showStartScreen();
    }
  }

  function bindSettings() {
    for (const group of $$('.settings-popover .setting-group')) {
      const legend = group.querySelector('legend')?.textContent.trim();
      for (const button of group.querySelectorAll('button')) {
        button.addEventListener('click', () => applySettingChange(legend, button.textContent.trim()));
      }
    }

    els.settingsButton?.addEventListener('click', event => {
      event.stopPropagation();
      setSettingsOpen(els.settingsPopover.hidden);
    });
    els.settingsClose?.addEventListener('click', () => {
      setSettingsOpen(false);
      els.settingsButton?.focus();
    });
    els.settingsPopover?.addEventListener('click', event => event.stopPropagation());
    document.addEventListener('click', () => setSettingsOpen(false));
  }

  // ---------------------------------------------------------------------------
  // Question pool / game lifecycle
  // ---------------------------------------------------------------------------
  function candidateGroups() {
    return allGroups.filter(group => {
      const typeOk = state.type === '全部' || group[0].type === state.type.replace('だけ', '');
      const regionOk = state.region === '全国' || group.some(item => item.quizRegion === state.region);
      return typeOk && regionOk;
    });
  }

  function buildGameQueue() {
    let candidates = shuffle(candidateGroups());
    if (!candidates.length) candidates = shuffle(allGroups);

    if (state.lastName && candidates.length > 1 && candidates[0][0].name === state.lastName) {
      [candidates[0], candidates[1]] = [candidates[1], candidates[0]];
    }

    if (Number.isFinite(state.questionLimit)) {
      state.actualGameTotal = Math.min(state.questionLimit, candidates.length);
      state.queue = candidates.slice(0, state.actualGameTotal);
    } else {
      state.actualGameTotal = Infinity;
      state.queue = candidates;
    }
  }

  function resetRoundState() {
    state.questionIndex = 0;
    state.currentGroup = null;
    state.selectedPrefs = [];
    state.answered = false;
    state.replaceIndex = 0;
    state.correct = 0;
    state.answeredCount = 0;
    state.streak = 0;
    state.maxStreak = 0;
    state.mistakes = [];
    state.lastName = null;
    state.replaceIndex = 0;
    updateStats();
  }

  function startGame() {
    setSettingsOpen(false);
    state.phase = 'playing';
    resetRoundState();
    buildGameQueue();
    els.startScreen.hidden = true;
    els.endScreen.hidden = true;
    els.gameLayout.hidden = false;
    showNextQuestion();
  }

  function showStartScreen() {
    state.phase = 'start';
    setSettingsOpen(false);
    els.gameLayout.hidden = true;
    els.endScreen.hidden = true;
    els.startScreen.hidden = false;
    syncSettingsButtons();
  }

  function finishGame() {
    if (!Number.isFinite(state.questionLimit)) return;
    state.phase = 'ended';
    els.gameLayout.hidden = true;
    els.startScreen.hidden = true;
    els.endScreen.hidden = false;

    const total = state.answeredCount;
    const rate = total ? Math.round((state.correct / total) * 100) : 0;
    els.endCorrect.textContent = String(state.correct);
    els.endTotal.textContent = String(total);
    els.endRate.textContent = `${rate}%`;
    els.endMaxStreak.textContent = String(state.maxStreak);
    renderMistakes();
  }

  function takeNextGroup() {
    if (state.queue.length) return state.queue.shift();

    // Endless mode: refill only after every candidate has appeared once.
    if (!Number.isFinite(state.questionLimit)) {
      buildGameQueue();
      return state.queue.shift();
    }
    return null;
  }

  function showNextQuestion() {
    const group = takeNextGroup();
    if (!group) {
      finishGame();
      return;
    }

    state.currentGroup = group;
    state.questionIndex += 1;
    state.lastName = group[0].name;
    state.selectedPrefs = [];
    state.answered = false;

    const finite = Number.isFinite(state.questionLimit);
    els.municipalityName.textContent = group[0].name;
    els.questionNo.textContent = String(state.questionIndex).padStart(2, '0');
    els.questionTotal.textContent = finite ? `/ ${state.actualGameTotal}` : '/ ∞';
    els.progressBar.style.width = finite
      ? `${Math.min(100, (state.questionIndex / state.actualGameTotal) * 100)}%`
      : '100%';
    els.progressBar.classList.toggle('endless-progress', !finite);

    const count = group.length;
    els.duplicateNotice.hidden = count <= 1;
    els.duplicateText.innerHTML = count > 1
      ? `「${escapeHtml(group[0].name)}」は<strong>${count}つの都道府県</strong>にあります。正しい都道府県を${count}つ選んでください。`
      : '';

    renderAnswerSlots(count);
    clearPrefectureStates();
    updateAnswerButton();
    showResultPlaceholder();
  }

  // ---------------------------------------------------------------------------
  // Answer selection / judging
  // ---------------------------------------------------------------------------
  function renderAnswerSlots(count) {
    els.answerSlots.replaceChildren();
    els.answerSlots.dataset.count = String(count);
    els.answerSlots.classList.toggle('single-slot', count === 1);

    for (let i = 0; i < count; i += 1) {
      const slot = document.createElement('div');
      slot.className = 'answer-slot';
      slot.dataset.slot = String(i);

      const num = document.createElement('span');
      num.className = 'slot-number';
      num.textContent = String(i + 1);

      const value = document.createElement('span');
      value.className = 'slot-placeholder';
      value.textContent = count === 1 ? '都道府県を選択' : `${i + 1}つ目を選択`;

      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'slot-clear';
      clear.setAttribute('aria-label', `${i + 1}つ目の選択を解除`);
      clear.textContent = '×';
      clear.hidden = true;
      clear.addEventListener('click', () => {
        if (state.answered) return;
        const pref = state.selectedPrefs[i];
        if (pref) togglePrefecture(pref);
      });

      slot.append(num, value, clear);
      els.answerSlots.appendChild(slot);
    }
  }

  function syncAnswerSlots() {
    const slots = [...els.answerSlots.querySelectorAll('.answer-slot')];
    slots.forEach((slot, i) => {
      const value = slot.querySelector('.slot-placeholder, .slot-value');
      const clear = slot.querySelector('.slot-clear');
      const pref = state.selectedPrefs[i];
      if (pref) {
        slot.classList.add('filled');
        value.className = 'slot-value';
        value.textContent = pref;
        clear.hidden = false;
      } else {
        slot.classList.remove('filled');
        value.className = 'slot-placeholder';
        value.textContent = slots.length === 1 ? '都道府県を選択' : `${i + 1}つ目を選択`;
        clear.hidden = true;
      }
    });
  }

  function togglePrefecture(pref) {
    if (state.answered || !state.currentGroup) return;
    const required = state.currentGroup.length;
    const existingIndex = state.selectedPrefs.indexOf(pref);

    if (existingIndex >= 0) {
      state.selectedPrefs.splice(existingIndex, 1);
      state.replaceIndex = Math.min(state.replaceIndex, Math.max(0, state.selectedPrefs.length - 1));
    } else if (required === 1) {
      // Single-answer questions always replace the current choice immediately.
      state.selectedPrefs = [pref];
      state.replaceIndex = 0;
    } else if (state.selectedPrefs.length < required) {
      state.selectedPrefs.push(pref);
      state.replaceIndex = state.selectedPrefs.length % required;
    } else {
      // When every slot is full, clicking another prefecture replaces one slot
      // instead of silently ignoring the click. Repeated replacements cycle slots.
      const indexToReplace = Math.min(state.replaceIndex, required - 1);
      state.selectedPrefs[indexToReplace] = pref;
      state.replaceIndex = (indexToReplace + 1) % required;
    }

    syncPrefectureSelection();
    syncAnswerSlots();
    updateAnswerButton();
  }

  function syncPrefectureSelection() {
    for (const button of els.prefectureButtons) {
      button.classList.toggle('selected', state.selectedPrefs.includes(button.dataset.pref));
    }
  }

  function clearPrefectureStates() {
    for (const button of els.prefectureButtons) {
      button.classList.remove('selected', 'correct-answer', 'wrong-answer', 'missed-answer');
      button.disabled = false;
    }
  }

  function updateAnswerButton() {
    const required = state.currentGroup?.length || 1;
    els.answerButton.disabled = state.answered || state.selectedPrefs.length !== required;
    els.answerButton.textContent = required === 1 ? '回答する' : `${required}つ選んで回答する`;
    els.resetButton.disabled = state.answered || state.selectedPrefs.length === 0;
  }

  function submitAnswer() {
    if (state.answered || !state.currentGroup) return;
    const correctPrefs = state.currentGroup.map(item => item.pref).sort();
    const selected = state.selectedPrefs.slice().sort();
    if (selected.length !== correctPrefs.length) return;

    const isCorrect = correctPrefs.every((pref, i) => pref === selected[i]);
    state.answered = true;
    state.answeredCount += 1;

    if (isCorrect) {
      state.correct += 1;
      state.streak += 1;
      state.maxStreak = Math.max(state.maxStreak, state.streak);
    } else {
      state.streak = 0;
      state.mistakes.push({
        name: state.currentGroup[0].name,
        correctPrefs: state.currentGroup.map(item => item.pref),
        selectedPrefs: state.selectedPrefs.slice(),
      });
    }

    updateStats();
    markAnswerButtons(correctPrefs);
    renderResult(isCorrect);
    updateAnswerButton();
  }

  function markAnswerButtons(correctPrefs) {
    const correctSet = new Set(correctPrefs);
    const selectedSet = new Set(state.selectedPrefs);
    for (const button of els.prefectureButtons) {
      const pref = button.dataset.pref;
      button.disabled = true;
      if (correctSet.has(pref)) button.classList.add('correct-answer');
      if (selectedSet.has(pref) && !correctSet.has(pref)) button.classList.add('wrong-answer');
      if (correctSet.has(pref) && !selectedSet.has(pref)) button.classList.add('missed-answer');
    }
  }

  function updateStats() {
    const rate = state.answeredCount ? Math.round((state.correct / state.answeredCount) * 100) : 0;
    els.correctRate.textContent = `${rate}%`;
    els.scoreCount.textContent = `${state.correct} / ${state.answeredCount}`;
    els.streak.textContent = String(state.streak);
  }

  // ---------------------------------------------------------------------------
  // Result panel
  // ---------------------------------------------------------------------------
  function showResultPlaceholder() {
    els.resultPanel.classList.remove('has-result', 'result-correct', 'result-wrong');
    els.resultStatus.textContent = '？';
    els.resultStatus.className = 'result-status waiting';
    els.resultTitle.textContent = 'ANSWER';
    els.resultSentence.textContent = '都道府県を選んで「回答する」を押してください。';
    els.resultEmpty.hidden = false;
    els.resultCards.replaceChildren();
    els.resultCards.dataset.count = '0';
    els.nextButton.hidden = true;
  }

  function renderResult(isCorrect) {
    els.resultPanel.classList.add('has-result');
    els.resultPanel.classList.toggle('result-correct', isCorrect);
    els.resultPanel.classList.toggle('result-wrong', !isCorrect);
    els.resultStatus.textContent = isCorrect ? '○' : '×';
    els.resultStatus.className = `result-status ${isCorrect ? 'correct' : 'incorrect'}`;
    els.resultTitle.textContent = isCorrect ? '正解！' : '不正解';
    const prefs = state.currentGroup.map(item => `<strong>${escapeHtml(item.pref)}</strong>`);
    els.resultSentence.innerHTML = `${escapeHtml(state.currentGroup[0].name)}は ${joinJapanese(prefs)} にあります。`;
    els.resultEmpty.hidden = true;
    els.resultCards.replaceChildren();
    els.resultCards.dataset.count = String(state.currentGroup.length);

    for (const item of state.currentGroup) {
      els.resultCards.appendChild(createResultCard(item));
    }
    for (const container of els.resultCards.querySelectorAll('.municipality-map')) {
      window.renderMunicipalityMap?.(container, container.dataset.pref, container.dataset.name);
    }

    const isLast = Number.isFinite(state.questionLimit) && state.questionIndex >= state.actualGameTotal;
    els.nextButton.textContent = isLast ? '結果を見る' : '次の問題へ';
    els.nextButton.hidden = false;
  }

  function createResultCard(item) {
    const article = document.createElement('article');
    article.className = 'municipality-card';

    const info = document.createElement('div');
    info.className = 'municipality-info';

    const titleRow = document.createElement('div');
    titleRow.className = 'municipality-title-row';
    const title = document.createElement('div');
    title.innerHTML = `<span class="pref-label">${escapeHtml(item.pref)}</span><h3>${escapeHtml(item.name)}</h3>`;
    titleRow.append(title);

    const dl = document.createElement('dl');
    dl.className = 'data-grid';
    const areaText = item.area == null ? '—' : `${formatNumber(item.area, 2)} km²${item.areaNote || ''}`;
    const densityText = item.density == null ? '—' : `${formatNumber(item.density, 1)}人/km²`;
    const populationText = item.population == null ? '—' : `${formatInteger(item.population)}人`;
    const populationRank = item.populationRank == null ? '—' : `${item.populationRank}位 / ${item.prefMunicipalityCount}`;
    const areaRank = item.areaRank == null ? '—' : `${item.areaRank}位 / ${item.prefMunicipalityCount}`;
    dl.innerHTML = [
      ['人口', populationText],
      ['面積', areaText],
      ['人口密度', densityText],
      ['県内人口順位', populationRank],
      ['県内面積順位', areaRank],
    ].map(([dt, dd]) => `<div><dt>${dt}</dt><dd>${dd}</dd></div>`).join('');

    info.append(titleRow, dl);

    const mapCard = document.createElement('div');
    mapCard.className = 'map-card';
    const map = document.createElement('div');
    map.className = 'map-placeholder municipality-map';
    map.dataset.pref = item.pref;
    map.dataset.name = item.name;
    mapCard.appendChild(map);

    article.append(info, mapCard);
    return article;
  }

  // ---------------------------------------------------------------------------
  // End screen
  // ---------------------------------------------------------------------------
  function renderMistakes() {
    els.wrongList.replaceChildren();
    els.wrongEmpty.hidden = state.mistakes.length !== 0;
    if (!state.mistakes.length) return;

    for (const mistake of state.mistakes) {
      const li = document.createElement('li');
      li.className = 'wrong-item';
      const selected = mistake.selectedPrefs.length ? joinJapanese(mistake.selectedPrefs) : '未回答';
      li.innerHTML = `
        <strong>${escapeHtml(mistake.name)}</strong>
        <span>正解：${escapeHtml(joinJapanese(mistake.correctPrefs))}</span>
        <span>回答：${escapeHtml(selected)}</span>
      `;
      els.wrongList.appendChild(li);
    }
  }

  // ---------------------------------------------------------------------------
  // Controls / keyboard
  // ---------------------------------------------------------------------------
  function advanceAfterAnswer() {
    if (!state.answered) return;
    const isLast = Number.isFinite(state.questionLimit) && state.questionIndex >= state.actualGameTotal;
    if (isLast) finishGame();
    else showNextQuestion();
  }

  function bindControls() {
    for (const button of els.prefectureButtons) {
      button.addEventListener('click', () => {
        togglePrefecture(button.dataset.pref);
        button.blur();
      });
    }

    els.resetButton.addEventListener('click', () => {
      if (state.answered) return;
      state.selectedPrefs = [];
      syncPrefectureSelection();
      syncAnswerSlots();
      updateAnswerButton();
    });
    els.answerButton.addEventListener('click', submitAnswer);
    els.nextButton.addEventListener('click', advanceAfterAnswer);

    els.startButton.addEventListener('click', startGame);
    els.startSettingsButton.addEventListener('click', event => {
      event.stopPropagation();
      setSettingsOpen(true);
      els.settingsButton?.focus();
    });
    els.restartSameButton.addEventListener('click', startGame);
    els.restartSettingsButton.addEventListener('click', () => {
      showStartScreen();
      setSettingsOpen(true);
    });

    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        if (!els.settingsPopover.hidden) {
          event.preventDefault();
          setSettingsOpen(false);
          els.settingsButton?.focus();
        }
        return;
      }

      if (event.key !== 'Enter' || event.repeat || !els.settingsPopover.hidden) return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest('button, input, select, textarea, a, [contenteditable="true"]')) return;

      if (state.phase === 'playing') {
        if (!state.answered && !els.answerButton.disabled) {
          event.preventDefault();
          submitAnswer();
        } else if (state.answered && !els.nextButton.hidden) {
          event.preventDefault();
          advanceAfterAnswer();
        }
      }
    });
  }

  bindSettings();
  bindControls();
  syncSettingsButtons();
  updateStats();
  showStartScreen();
})();
