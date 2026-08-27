(async () => {
  'use strict';

  const municipalities = Array.isArray(window.MUNICIPALITIES) ? window.MUNICIPALITIES : [];
  const touristSpots = Array.isArray(window.TOURIST_SPOTS) ? window.TOURIST_SPOTS : [];
  if (!municipalities.length) {
    console.error('municipalities.js が読み込まれていません。');
    return;
  }

  // ---------------------------------------------------------------------------
  // Population data
  // ---------------------------------------------------------------------------
  // 2026-01-01 Basic Resident Register population is embedded in municipalities.js.
  // No external population request is required.

  // ---------------------------------------------------------------------------
  // Municipality readings
  // ---------------------------------------------------------------------------
  // LOCALGOV_JP provides current municipality names and their hiragana readings.
  // Match by prefecture + municipality name so designated-city code collisions do
  // not affect the reading lookup.
  const municipalityReadingByPrefName = new Map();
  if (typeof LOCALGOV_JP !== 'undefined' && Array.isArray(LOCALGOV_JP)) {
    for (const item of LOCALGOV_JP) {
      const pref = String(item?.pref || '').trim();
      const name = String(item?.city || '').trim();
      const reading = String(item?.citykana || '').trim();
      if (!pref || !name || !reading) continue;
      municipalityReadingByPrefName.set(`${pref}\u0000${name}`, reading);
    }
  } else {
    console.warn('市町村ふりがなデータを読み込めませんでした。クイズ本体はそのまま利用できます。');
  }

  function municipalityReading(item) {
    if (!item) return '';
    return municipalityReadingByPrefName.get(`${item.pref}\u0000${item.name}`) || '';
  }

  function municipalityQuestionReading(question) {
    if (!question || question.mode !== 'municipality') return '';
    const readings = [...new Set((question.answers || []).map(municipalityReading).filter(Boolean))];
    return readings.join('／');
  }

  // ---------------------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------------------
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const els = {
    modeTabs: $$('.mode-tab[data-mode]'),
    gameLayout: $('#game-layout'), startScreen: $('#start-screen'), startTitle: $('#start-screen-title'), startButton: $('#start-game-button'),
    endScreen: $('#end-screen'), endCorrect: $('#end-correct'), endTotal: $('#end-total'), endRate: $('#end-rate'), endMaxStreak: $('#end-max-streak'),
    wrongList: $('#wrong-list'), wrongEmpty: $('#wrong-empty'), restartSameButton: $('#restart-same-button'), restartSettingsButton: $('#restart-settings-button'),
    questionNo: $('#question-no'), questionTotal: $('#question-total'), progressBar: $('#question-progress'), questionLabel: $('#question-label'),
    questionName: $('#municipality-name'), questionReading: $('#municipality-reading'), duplicateNotice: $('#duplicate-notice'), duplicateBadge: $('#duplicate-badge'), duplicateText: $('#duplicate-text'),
    answerSlots: $('#answer-slots'), prefectureButtons: $$('.prefecture[data-pref]'), resetButton: $('#reset-selection'), answerButton: $('#answer-button'),
    correctRate: $('#correct-rate'), scoreCount: $('#score-count'), streak: $('#current-streak'), resultPanel: $('#result-panel'), resultStatus: $('#result-status'),
    resultTitle: $('#result-title'), resultSentence: $('#result-sentence'), resultEmpty: $('#result-empty'), resultCards: $('#result-cards'), nextButton: $('#next-button'),
    settingsButton: $('.settings-button'), settingsPopover: $('#settings-popover'), settingsClose: $('.settings-close'),
  };

  // ---------------------------------------------------------------------------
  // Question source model
  // ---------------------------------------------------------------------------
  const municipalityByName = new Map();
  for (const item of municipalities) {
    if (!municipalityByName.has(item.name)) municipalityByName.set(item.name, []);
    municipalityByName.get(item.name).push(item);
  }
  const municipalityQuestions = [...municipalityByName.entries()].map(([name, answers]) => ({
    id: `m:${name}`,
    name,
    mode: 'municipality',
    answers: answers.slice().sort((a, b) => a.pref.localeCompare(b.pref, 'ja')),
  }));

  function normalizeTouristSpot(spot) {
    const byPref = new Map();
    for (const loc of spot.locations || []) {
      if (!byPref.has(loc.pref)) byPref.set(loc.pref, []);
      byPref.get(loc.pref).push(loc);
    }
    const answers = [...byPref.entries()].map(([pref, locs]) => {
      const locationLabels = [...new Set(locs.map(loc => loc.location).filter(Boolean))];
      const mapNames = [];
      for (const loc of locs) {
        const names = Array.isArray(loc.mapName) ? loc.mapName : [loc.mapName];
        for (const name of names.filter(Boolean)) if (!mapNames.includes(name)) mapNames.push(name);
      }
      return {
        pref,
        name: spot.name,
        mapName: mapNames.length === 1 ? mapNames[0] : mapNames,
        location: locationLabels.join('・'),
        quizRegion: locs[0]?.quizRegion,
        categories: spot.categories,
        type: spot.type,
        worldHeritage: spot.worldHeritage,
      };
    }).sort((a, b) => a.pref.localeCompare(b.pref, 'ja'));
    return { id: spot.id, name: spot.name, mode: 'tourism', answers, spot };
  }
  const touristQuestions = touristSpots.map(normalizeTouristSpot).filter(q => q.answers.length);

  const state = {
    mode: 'municipality', phase: 'start', questionLimit: 10, type: '全部', tourismCategory: '全部', region: '全国',
    queue: [], questionIndex: 0, currentQuestion: null, selectedPrefs: [], answered: false, correct: 0, answeredCount: 0,
    streak: 0, maxStreak: 0, mistakes: [], lastId: null, actualGameTotal: 10,
  };

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  function shuffle(array) { const a = array.slice(); for (let i = a.length - 1; i > 0; i -= 1) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
  const escapeHtml = value => String(value).replace(/[&<>'"]/g, ch => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' }[ch]));
  const formatInteger = value => new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 }).format(value);
  const formatNumber = (value, digits) => new Intl.NumberFormat('ja-JP', { maximumFractionDigits: digits }).format(value);
  function joinJapanese(parts) { if (parts.length <= 1) return parts[0] || ''; if (parts.length === 2) return `${parts[0]} と ${parts[1]}`; return `${parts.slice(0,-1).join('、')}、${parts.at(-1)}`; }
  function currentAnswers() { return state.currentQuestion?.answers || []; }

  // ---------------------------------------------------------------------------
  // Mode / settings
  // ---------------------------------------------------------------------------
  function setSettingsOpen(open) {
    if (!els.settingsPopover || !els.settingsButton) return;
    els.settingsPopover.hidden = !open;
    els.settingsButton.setAttribute('aria-expanded', String(open));
  }

  function updateModeUI() {
    document.body.dataset.quizMode = state.mode;
    for (const tab of els.modeTabs) {
      const active = tab.dataset.mode === state.mode;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-pressed', String(active));
    }
    for (const node of $$('.mode-municipality-setting')) node.hidden = state.mode !== 'municipality';
    for (const node of $$('.mode-tourism-setting')) node.hidden = state.mode !== 'tourism';
    if (els.startTitle) els.startTitle.textContent = state.mode === 'municipality' ? '市町村クイズを始める' : '観光地クイズを始める';
    if (els.questionLabel) els.questionLabel.textContent = state.mode === 'municipality'
      ? 'この市町村がある都道府県を選んでください'
      : 'この観光地がある都道府県を選んでください';
    syncSettingsButtons();
  }

  function switchMode(mode) {
    if (!['municipality','tourism'].includes(mode) || mode === state.mode) return;
    if (state.phase === 'playing' && state.questionIndex > 0) {
      const ok = window.confirm('クイズを切り替えると、現在のゲームを終了して開始画面へ戻ります。切り替えますか？');
      if (!ok) return;
    }
    state.mode = mode;
    showStartScreen();
    updateModeUI();
  }

  function syncSettingsButtons() {
    for (const group of $$('.settings-popover .setting-group, .start-settings .setting-group')) {
      const legend = group.querySelector('legend')?.textContent.trim();
      for (const button of group.querySelectorAll('button')) {
        const value = button.textContent.trim();
        let active = false;
        if (legend === '問題数') active = Number.isFinite(state.questionLimit) ? parseInt(value,10) === state.questionLimit : value === 'エンドレス';
        else if (legend === '出題する自治体') active = value === state.type;
        else if (legend === '出題カテゴリ') active = value === state.tourismCategory;
        else if (legend === '出題する地方') active = value === state.region;
        button.classList.toggle('active', active);
      }
    }
  }

  function readSettingChange(legend, value) {
    if (legend === '問題数') return { key:'questionLimit', value: value === 'エンドレス' ? Infinity : parseInt(value,10) };
    if (legend === '出題する自治体') return { key:'type', value };
    if (legend === '出題カテゴリ') return { key:'tourismCategory', value };
    if (legend === '出題する地方') return { key:'region', value };
    return null;
  }

  function applySettingChange(legend, value) {
    const change = readSettingChange(legend, value);
    if (!change || Object.is(state[change.key], change.value)) return;
    if (state.phase === 'playing' && state.questionIndex > 0) {
      const ok = window.confirm('出題設定を変更すると、現在のゲームをリセットして新しいゲームを開始します。変更しますか？');
      if (!ok) { syncSettingsButtons(); return; }
    }
    state[change.key] = change.value;
    syncSettingsButtons();
    if (state.phase === 'playing') startGame();
    else if (state.phase === 'ended') showStartScreen();
  }

  function bindSettingsAndMode() {
    for (const group of $$('.settings-popover .setting-group, .start-settings .setting-group')) {
      const legend = group.querySelector('legend')?.textContent.trim();
      for (const button of group.querySelectorAll('button')) button.addEventListener('click', () => applySettingChange(legend, button.textContent.trim()));
    }
    for (const tab of els.modeTabs) tab.addEventListener('click', () => switchMode(tab.dataset.mode));
    els.settingsButton?.addEventListener('click', event => { event.stopPropagation(); setSettingsOpen(els.settingsPopover.hidden); });
    els.settingsClose?.addEventListener('click', () => { setSettingsOpen(false); els.settingsButton?.focus(); });
    els.settingsPopover?.addEventListener('click', event => event.stopPropagation());
    document.addEventListener('click', () => setSettingsOpen(false));
  }

  // ---------------------------------------------------------------------------
  // Game lifecycle / queues
  // ---------------------------------------------------------------------------
  function candidateQuestions() {
    const source = state.mode === 'municipality' ? municipalityQuestions : touristQuestions;
    return source.filter(question => {
      if (state.mode === 'municipality') {
        const typeOk = state.type === '全部' || question.answers[0]?.type === state.type.replace('だけ','');
        const regionOk = state.region === '全国' || question.answers.some(item => item.quizRegion === state.region);
        return typeOk && regionOk;
      }
      const categoryOk = state.tourismCategory === '全部' || (question.spot.categories || []).includes(state.tourismCategory);
      const regionOk = state.region === '全国' || question.answers.some(item => item.quizRegion === state.region);
      return categoryOk && regionOk;
    });
  }

  function buildGameQueue() {
    let candidates = shuffle(candidateQuestions());
    if (!candidates.length) candidates = shuffle(state.mode === 'municipality' ? municipalityQuestions : touristQuestions);
    if (state.lastId && candidates.length > 1 && candidates[0].id === state.lastId) [candidates[0], candidates[1]] = [candidates[1], candidates[0]];
    if (Number.isFinite(state.questionLimit)) {
      state.actualGameTotal = Math.min(state.questionLimit, candidates.length);
      state.queue = candidates.slice(0, state.actualGameTotal);
    } else {
      state.actualGameTotal = Infinity;
      state.queue = candidates;
    }
  }

  function resetRoundState() {
    state.questionIndex = 0; state.currentQuestion = null; state.selectedPrefs = []; state.answered = false; state.correct = 0; state.answeredCount = 0;
    state.streak = 0; state.maxStreak = 0; state.mistakes = []; state.lastId = null; updateStats();
  }

  function startGame() {
    setSettingsOpen(false); state.phase = 'playing'; resetRoundState(); buildGameQueue();
    els.startScreen.hidden = true; els.endScreen.hidden = true; els.gameLayout.hidden = false; showNextQuestion();
  }
  function showStartScreen() {
    state.phase = 'start'; setSettingsOpen(false); els.gameLayout.hidden = true; els.endScreen.hidden = true; els.startScreen.hidden = false; updateModeUI();
  }
  function finishGame() {
    if (!Number.isFinite(state.questionLimit)) return;
    state.phase = 'ended'; els.gameLayout.hidden = true; els.startScreen.hidden = true; els.endScreen.hidden = false;
    const total = state.answeredCount; const rate = total ? Math.round((state.correct / total) * 100) : 0;
    els.endCorrect.textContent = String(state.correct); els.endTotal.textContent = String(total); els.endRate.textContent = `${rate}%`; els.endMaxStreak.textContent = String(state.maxStreak); renderMistakes();
  }
  function takeNextQuestion() {
    if (state.queue.length) return state.queue.shift();
    if (!Number.isFinite(state.questionLimit)) { buildGameQueue(); return state.queue.shift(); }
    return null;
  }

  function warmQuestion(question) { window.MunicipalityMap?.prepareMany(question?.answers || []); }
  function scheduleUpcomingMapWarmup() {
    if (!window.MunicipalityMap) return;
    const upcoming = Number.isFinite(state.questionLimit) ? state.queue.slice() : state.queue.slice(0,8);
    if (!upcoming.length) return;
    const allItems = upcoming.flatMap(q => q.answers);
    const nextFew = upcoming.slice(0,2).flatMap(q => q.answers);
    const task = () => { window.MunicipalityMap.preloadFiles(allItems); window.MunicipalityMap.prepareMany(nextFew); };
    if ('requestIdleCallback' in window) window.requestIdleCallback(task, { timeout:1200 }); else setTimeout(task, 80);
  }

  function showNextQuestion() {
    const question = takeNextQuestion();
    if (!question) { finishGame(); return; }
    state.currentQuestion = question; state.lastId = question.id; state.questionIndex += 1; state.selectedPrefs = []; state.answered = false;
    clearPrefectureStates(); renderQuestion(); renderAnswerSlots(); syncPrefectureSelection(); updateAnswerButton(); showResultPlaceholder(); warmQuestion(question); scheduleUpcomingMapWarmup();
  }

  // ---------------------------------------------------------------------------
  // Question / answer interaction
  // ---------------------------------------------------------------------------
  function renderQuestion() {
    const q = state.currentQuestion; if (!q) return;
    els.questionName.textContent = q.name;
    const reading = municipalityQuestionReading(q);
    els.questionReading.textContent = reading;
    els.questionReading.hidden = !reading || state.mode !== 'municipality';
    els.questionNo.textContent = String(state.questionIndex).padStart(2,'0');
    if (Number.isFinite(state.questionLimit)) {
      els.questionTotal.textContent = `/ ${state.actualGameTotal}`;
      els.progressBar.style.width = `${Math.min(100,(state.questionIndex/state.actualGameTotal)*100)}%`;
    } else { els.questionTotal.textContent = '/ ∞'; els.progressBar.style.width = '100%'; }
    const required = q.answers.length;
    if (required > 1) {
      els.duplicateNotice.hidden = false;
      els.duplicateBadge.textContent = state.mode === 'municipality' ? '同名自治体' : '複数都道府県';
      els.duplicateText.innerHTML = state.mode === 'municipality'
        ? `「${escapeHtml(q.name)}」は<strong>${required}つの都道府県</strong>にあります。すべて選んでください。`
        : `「${escapeHtml(q.name)}」は<strong>${required}つの都道府県</strong>にまたがります。すべて選んでください。`;
    } else els.duplicateNotice.hidden = true;
  }

  function renderAnswerSlots() {
    els.answerSlots.replaceChildren();
    const required = currentAnswers().length || 1;
    els.answerSlots.dataset.count = String(required);
    els.answerSlots.classList.toggle('single-slot', required === 1);
    for (let i=0;i<required;i+=1) {
      const slot=document.createElement('div'); slot.className='answer-slot';
      slot.innerHTML=`<span class="slot-number">${i+1}</span><span class="slot-placeholder">${required===1?'都道府県を選択':`${i+1}つ目を選択`}</span><button type="button" class="slot-clear" hidden aria-label="選択を解除">×</button>`;
      slot.querySelector('.slot-clear').addEventListener('click', () => { if (state.answered) return; state.selectedPrefs.splice(i,1); syncPrefectureSelection(); syncAnswerSlots(); updateAnswerButton(); });
      els.answerSlots.appendChild(slot);
    }
  }
  function syncAnswerSlots() {
    const slots=[...els.answerSlots.querySelectorAll('.answer-slot')];
    slots.forEach((slot,i)=>{ const value=slot.querySelector('.slot-placeholder,.slot-value'); const clear=slot.querySelector('.slot-clear'); const pref=state.selectedPrefs[i];
      if(pref){slot.classList.add('filled'); value.className='slot-value'; value.textContent=pref; clear.hidden=false;}
      else{slot.classList.remove('filled'); value.className='slot-placeholder'; value.textContent=slots.length===1?'都道府県を選択':`${i+1}つ目を選択`; clear.hidden=true;}
    });
  }
  function togglePrefecture(pref) {
    if (state.answered || !state.currentQuestion) return;
    const required=currentAnswers().length; const existing=state.selectedPrefs.indexOf(pref);
    if(existing>=0) state.selectedPrefs.splice(existing,1);
    else if(required===1) state.selectedPrefs=[pref];
    else if(state.selectedPrefs.length<required) state.selectedPrefs.push(pref);
    else state.selectedPrefs[required-1]=pref;
    syncPrefectureSelection(); syncAnswerSlots(); updateAnswerButton();
  }
  function syncPrefectureSelection(){ for(const button of els.prefectureButtons) button.classList.toggle('selected',state.selectedPrefs.includes(button.dataset.pref)); }
  function clearPrefectureStates(){ for(const button of els.prefectureButtons){button.classList.remove('selected','correct-answer','wrong-answer','missed-answer');button.disabled=false;} }
  function updateAnswerButton(){const required=currentAnswers().length||1;els.answerButton.disabled=state.answered||state.selectedPrefs.length!==required;els.answerButton.textContent=required===1?'回答する':`${required}つ選んで回答する`;els.resetButton.disabled=state.answered||state.selectedPrefs.length===0;}

  function submitAnswer(){
    if(state.answered||!state.currentQuestion)return; const answers=currentAnswers(); const correctPrefs=answers.map(x=>x.pref).sort(); const selected=state.selectedPrefs.slice().sort(); if(selected.length!==correctPrefs.length)return;
    const isCorrect=correctPrefs.every((pref,i)=>pref===selected[i]); state.answered=true; state.answeredCount+=1;
    if(isCorrect){state.correct+=1;state.streak+=1;state.maxStreak=Math.max(state.maxStreak,state.streak);} else {state.streak=0;state.mistakes.push({name:state.currentQuestion.name,correctPrefs:answers.map(x=>x.pref),selectedPrefs:state.selectedPrefs.slice()});}
    updateStats(); markAnswerButtons(correctPrefs); renderResult(isCorrect); updateAnswerButton();
  }
  function markAnswerButtons(correctPrefs){const correctSet=new Set(correctPrefs),selectedSet=new Set(state.selectedPrefs);for(const button of els.prefectureButtons){const pref=button.dataset.pref;button.disabled=true;if(correctSet.has(pref))button.classList.add('correct-answer');if(selectedSet.has(pref)&&!correctSet.has(pref))button.classList.add('wrong-answer');if(correctSet.has(pref)&&!selectedSet.has(pref))button.classList.add('missed-answer');}}
  function updateStats(){const rate=state.answeredCount?Math.round((state.correct/state.answeredCount)*100):0;els.correctRate.textContent=`${rate}%`;els.scoreCount.textContent=`${state.correct} / ${state.answeredCount}`;els.streak.textContent=String(state.streak);}

  // ---------------------------------------------------------------------------
  // Result cards
  // ---------------------------------------------------------------------------
  function showResultPlaceholder(){els.resultPanel.classList.remove('has-result','result-correct','result-wrong');els.resultStatus.textContent='？';els.resultStatus.className='result-status waiting';els.resultTitle.textContent='ANSWER';els.resultSentence.textContent='都道府県を選んで「回答する」を押してください。';els.resultEmpty.hidden=false;els.resultCards.replaceChildren();els.resultCards.dataset.count='0';els.nextButton.hidden=true;}
  function renderResult(isCorrect){
    const q=state.currentQuestion,answers=currentAnswers(); els.resultPanel.classList.add('has-result');els.resultPanel.classList.toggle('result-correct',isCorrect);els.resultPanel.classList.toggle('result-wrong',!isCorrect);els.resultStatus.textContent=isCorrect?'○':'×';els.resultStatus.className=`result-status ${isCorrect?'correct':'incorrect'}`;els.resultTitle.textContent=isCorrect?'正解！':'不正解';
    const prefs=answers.map(item=>`<strong>${escapeHtml(item.pref)}</strong>`);els.resultSentence.innerHTML=`${escapeHtml(q.name)}は ${joinJapanese(prefs)} にあります。`;els.resultEmpty.hidden=true;els.resultCards.replaceChildren();els.resultCards.dataset.count=String(answers.length);
    for(const item of answers){const card=state.mode==='municipality'?createMunicipalityResultCard(item):createTouristResultCard(item,q.spot);els.resultCards.appendChild(card);const map=card.querySelector('.municipality-map');window.MunicipalityMap?.render(map,item.pref,item.mapName||item.name);}
    const isLast=Number.isFinite(state.questionLimit)&&state.questionIndex>=state.actualGameTotal;els.nextButton.textContent=isLast?'結果を見る':'次の問題へ';els.nextButton.hidden=false;
  }
  function createMapCard(){const mapCard=document.createElement('div');mapCard.className='map-card';const map=document.createElement('div');map.className='map-placeholder municipality-map';mapCard.appendChild(map);return mapCard;}
  function createMunicipalityResultCard(item){
    const article=document.createElement('article');article.className='municipality-card';const info=document.createElement('div');info.className='municipality-info';const titleRow=document.createElement('div');titleRow.className='municipality-title-row';const title=document.createElement('div');const prefLabel=document.createElement('span');prefLabel.className='pref-label';prefLabel.textContent=item.pref;const nameLine=document.createElement('div');nameLine.className='municipality-name-line';const name=document.createElement('h3');name.textContent=item.name;nameLine.appendChild(name);const reading=municipalityReading(item);if(reading){const readingEl=document.createElement('span');readingEl.className='municipality-reading-inline';readingEl.textContent=reading;nameLine.appendChild(readingEl);}title.append(prefLabel,nameLine);titleRow.append(title);
    const dl=document.createElement('dl');dl.className='data-grid';const areaText=item.area==null?'—':`${formatNumber(item.area,2)} km²`;const densityText=item.density==null?'—':`${formatNumber(item.density,1)}人/km²`;const populationText=item.population==null?'—':`${formatInteger(item.population)}人`;const populationRank=item.populationRank==null?'—':`${item.populationRank}位/ ${item.prefMunicipalityCount}自治体`;const areaRank=item.areaRank==null?'—':`${item.areaRank}位/ ${item.prefMunicipalityCount}自治体`;
    dl.innerHTML=[['人口',populationText],['面積',areaText],['人口密度',densityText],['県内人口順位',populationRank],['県内面積順位',areaRank]].map(([dt,dd])=>`<div><dt>${dt}</dt><dd>${dd}</dd></div>`).join('');info.append(titleRow,dl);article.append(info,createMapCard());return article;
  }
  function createTouristResultCard(item,spot){
    const article=document.createElement('article');article.className='municipality-card tourist-card';const info=document.createElement('div');info.className='municipality-info tourist-result-info';const titleRow=document.createElement('div');titleRow.className='municipality-title-row';const title=document.createElement('div');title.innerHTML=`<span class="pref-label">${escapeHtml(item.pref)}</span><h3 class="tourist-location-name">${escapeHtml(item.location||'所在地情報なし')}</h3>`;titleRow.append(title);info.appendChild(titleRow);
    const meta=document.createElement('div');meta.className='tourist-meta-list';const categoryText=(spot.categories||[]).join(' / ')||'その他';meta.innerHTML=`<div class="tourist-meta-row"><span>カテゴリ</span><strong>${escapeHtml(categoryText)}</strong></div>`;
    const badges=Array.isArray(spot.badges)?spot.badges:[];
    if(badges.length){const badgeWrap=document.createElement('div');badgeWrap.className='spot-badges';for(const badgeText of badges){const badge=document.createElement('span');badge.className='spot-badge';badge.textContent=badgeText;badgeWrap.appendChild(badge);}info.appendChild(badgeWrap);}
    if(spot.worldHeritage){const detail=document.createElement('div');detail.className='world-heritage-badge';detail.textContent=`世界遺産登録名：${spot.worldHeritage}`;info.appendChild(detail);} info.appendChild(meta);article.append(info,createMapCard());return article;
  }

  // ---------------------------------------------------------------------------
  // End screen / controls
  // ---------------------------------------------------------------------------
  function renderMistakes(){els.wrongList.replaceChildren();els.wrongEmpty.hidden=state.mistakes.length!==0;if(!state.mistakes.length)return;for(const mistake of state.mistakes){const li=document.createElement('li');li.className='wrong-item';const selected=mistake.selectedPrefs.length?joinJapanese(mistake.selectedPrefs):'未回答';li.innerHTML=`<strong>${escapeHtml(mistake.name)}</strong><span>正解：${escapeHtml(joinJapanese(mistake.correctPrefs))}</span><span>回答：${escapeHtml(selected)}</span>`;els.wrongList.appendChild(li);}}
  function advanceAfterAnswer(){if(!state.answered)return;const isLast=Number.isFinite(state.questionLimit)&&state.questionIndex>=state.actualGameTotal;if(isLast)finishGame();else showNextQuestion();}
  function bindControls(){
    for(const button of els.prefectureButtons)button.addEventListener('click',()=>{togglePrefecture(button.dataset.pref);button.blur();});
    els.resetButton.addEventListener('click',()=>{if(state.answered)return;state.selectedPrefs=[];syncPrefectureSelection();syncAnswerSlots();updateAnswerButton();});els.answerButton.addEventListener('click',submitAnswer);els.nextButton.addEventListener('click',advanceAfterAnswer);els.startButton.addEventListener('click',startGame);els.restartSameButton.addEventListener('click',startGame);els.restartSettingsButton.addEventListener('click',showStartScreen);
    document.addEventListener('keydown',event=>{if(event.key==='Escape'){if(!els.settingsPopover.hidden){event.preventDefault();setSettingsOpen(false);els.settingsButton?.focus();}return;}if(event.key!=='Enter'||event.repeat||!els.settingsPopover.hidden)return;const target=event.target;if(target instanceof HTMLElement&&target.closest('input,select,textarea,a,[contenteditable="true"]'))return;if(state.phase==='playing'){if(!state.answered&&!els.answerButton.disabled){event.preventDefault();submitAnswer();}else if(state.answered&&!els.nextButton.hidden){event.preventDefault();advanceAfterAnswer();}}});
  }

  bindSettingsAndMode(); bindControls(); updateModeUI(); updateStats(); showStartScreen();
})();
