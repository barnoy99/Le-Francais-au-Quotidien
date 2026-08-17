(function () {
  'use strict';

  var STORAGE_KEY = 'frenchSR_state';
  var VERSION = 1;
  var SUMMARY_INTERVAL = 10;
  // level → minimum cooldown in ms
  var INTERVALS = [0, 120000, 86400000, 604800000, Infinity];
  // level → selection weight (0=unseen, 1=hard, 2=learning, 3=familiar)
  var WEIGHTS = [2, 4, 3, 1];
  // ⚑ Écouter reads every sentence this many times, ×6 flag or not
  var ECOUTER_READS = 4;
  var ECOUTER_DONE_SPEECH = 'Félicitations ! Vous avez écouté toutes vos expressions difficiles.';

  var state;
  var sessionSeen = 0;
  var sessionNew = 0;
  var lastShownId = null;
  var currentPhrase = null;
  var expandedProgressId = null;
  var phraseHistory = []; // apprentissage back-navigation stack
  var acquisPhrases = [];
  var acquisIndex = 0;
  var acquisBatchLen = 0;
  var acquisMaxSeen = 0;
  var handsfreeBatchLen = 0;
  var handsfreeMaxSeen = 0;
  var handsfreeCustomPool = false;   // true for the Difficiles-only session
  var acquisCustomPool = false;      // same, for Mes Acquis
  var handsfreeActive = false;
  var handsfreePaused = false;
  var handsfreePhrases = [];
  var handsfreeIndex = 0;
  var handsfreeExercise = 'main'; // 'main' or 'alt'
  // ⚑ Écouter only: main and alt are independent items pulled one at a time
  // from the persistent queue, so each index needs its own exercise and its
  // position in the pass (kept here so ⏮ still shows the right counter).
  var handsfreeExercises = [];
  var handsfreePositions = [];
  var handsfreeHistory = []; // stack of {index, exercise} for multi-step skip-back
  var handsfreeReadTarget = 3;          // 3 or 6, reset per exercise
  var handsfreeFinalPause = false;      // true during the 8s inter-exercise gap
  var handsfreeCurrentFrench = '';      // frenchText of current exercise
  var handsfreeLastReadNum = 0;         // last completed read number
  var handsfreeCurrentReadsDoneCallback = null; // onDone ref for re-entry from ×6
  var handsfreeTimerId = null;
  var handsfreeCountdownId = null;
  // Pause/resume state. A countdown freezes and resumes where it left off;
  // a sentence being spoken re-reads from its start (mobile speech engines
  // can't reliably resume mid-utterance).
  var handsfreeCountdownRemaining = 0;  // seconds left on the active countdown
  var handsfreeCountdownLabel = '';     // label of the active countdown
  var handsfreeCountdownDone = null;    // onDone of the active countdown
  var handsfreeCountdownTick = null;    // optional per-second hook (caption changes)
  var handsfreeResumeAction = null;     // closure to run on resume
  var handsfreeResumeSpeak = null;      // closure to re-speak the current sentence
  var handsfreeLastPrevTime = 0;        // for double-tap "back" = previous item
  var handsfreeGen = 0;                 // generation token — stale async callbacks bail out
  var wakeLock = null;
  var audioCtx = null;
  var db = null;
  var DB_PATH = 'progress/user1';

  // ── Firebase init ─────────────────────────────────────

  function initFirebase() {
    try {
      if (typeof FIREBASE_CONFIG !== 'undefined' && FIREBASE_CONFIG.apiKey !== 'YOUR_API_KEY') {
        firebase.initializeApp(FIREBASE_CONFIG);
        db = firebase.database();
        return true;
      }
    } catch (e) { /* Firebase not available — local only */ }
    return false;
  }

  // ── DOM helpers ────────────────────────────────────────

  function $(id) { return document.getElementById(id); }

  function showScreen(id) {
    var screens = document.querySelectorAll('.screen');
    for (var i = 0; i < screens.length; i++) {
      screens[i].classList.remove('screen--active');
    }
    $(id).classList.add('screen--active');
  }

  function show(el) { el.classList.remove('hidden'); }
  function hide(el) { el.classList.add('hidden'); }

  // ── Persistence ────────────────────────────────────────

  function defaults() {
    return { version: VERSION, phrases: {}, sessionCount: 0, deletedIds: [],
             hfCycle: [], hfCursor: 0, hfPass: {},
             acqCycle: [], acqCursor: 0, acqPass: {},
             ecCycle: [], ecCursor: 0 };
  }

  function activePhrases() {
    var deleted = state.deletedIds || [];
    if (deleted.length === 0) return PHRASES;
    return PHRASES.filter(function (p) { return deleted.indexOf(p.id) === -1; });
  }

  function loadLocal() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed.version) return parsed;
      }
    } catch (e) {}
    return null;
  }

  function load(callback) {
    var localState = loadLocal();

    if (db) {
      db.ref(DB_PATH).once('value').then(function (snapshot) {
        var cloudState = snapshot.val();
        if (cloudState && cloudState.version) {
          // Pick whichever has more progress (higher sessionCount = more usage)
          if (!localState || cloudState.sessionCount >= localState.sessionCount) {
            state = cloudState;
          } else {
            state = localState;
          }
        } else if (localState) {
          state = localState;
        } else {
          state = defaults();
        }
        // Save merged result to both
        saveLocal();
        saveCloud();
        if (callback) callback();
      }).catch(function () {
        state = localState || defaults();
        if (callback) callback();
      });
    } else {
      state = localState || defaults();
      if (callback) callback();
    }
  }

  function saveLocal() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {}
  }

  function saveCloud() {
    if (db) {
      try {
        db.ref(DB_PATH).set(state);
      } catch (e) {}
    }
  }

  function save() {
    saveLocal();
    saveCloud();
  }

  // ── Phrase data helpers ────────────────────────────────

  function getPhraseData(id) {
    if (state.phrases[id]) return state.phrases[id];
    return { level: 0, lastSeen: 0, timesSeen: 0, hfSeen: 0, boost: false,
             hardScore: 0, hardManual: false, misses: 0 };
  }

  // Single writer: merges changes into the existing record so no field is ever
  // dropped by accident (level, boost, hfSeen, hardScore, misses… all survive).
  function writePhrase(id, changes) {
    var d = getPhraseData(id);
    var next = {
      level: d.level || 0,
      lastSeen: d.lastSeen || 0,
      timesSeen: d.timesSeen || 0,
      hfSeen: d.hfSeen || 0,
      boost: d.boost || false,
      hardScore: d.hardScore || 0,
      hardManual: d.hardManual || false,
      misses: d.misses || 0
    };
    for (var k in changes) {
      if (Object.prototype.hasOwnProperty.call(changes, k)) next[k] = changes[k];
    }
    state.phrases[id] = next;
    save();
    return next;
  }

  function setPhraseData(id, level) {
    var d = getPhraseData(id);
    var wasNew = (d.timesSeen || 0) === 0;
    writePhrase(id, { level: level, lastSeen: Date.now(), timesSeen: (d.timesSeen || 0) + 1 });
    return wasNew;
  }

  function deletePhrase(id) {
    if (!state.deletedIds) state.deletedIds = [];
    if (state.deletedIds.indexOf(id) === -1) state.deletedIds.push(id);
    delete state.phrases[id];
    save();
  }

  // Move a phrase between pools: mastered (level 4 → Mes Acquis & Mains Libres)
  // or back into the Apprentissage rotation (level < 4, eligible immediately).
  // boost: pass true/false to set the ×6 flag when mastering; omit to keep it.
  function moveToPool(id, mastered, boost) {
    var d = getPhraseData(id);
    var newBoost;
    if (typeof boost === 'boolean') newBoost = boost;
    else newBoost = mastered ? (d.boost || false) : false;
    writePhrase(id, {
      level: mastered ? 4 : 1,
      lastSeen: mastered ? Date.now() : 0,
      boost: mastered ? newBoost : false
    });
  }

  function incrementHfSeen(id) {
    writePhrase(id, { hfSeen: (getPhraseData(id).hfSeen || 0) + 1 });
  }

  // ── ×6 boost flag (persistent per phrase, covers main + alt) ──

  function isBoosted(id) {
    return !!(state.phrases[id] && state.phrases[id].boost);
  }

  function toggleBoost(id) {
    return writePhrase(id, { boost: !getPhraseData(id).boost }).boost;
  }

  function setBoost(id, value) {
    writePhrase(id, { boost: !!value });
  }

  // ── Difficulty (automatic from Mes Acquis recall + manual override) ──

  function isHard(id) {
    var d = state.phrases[id];
    if (!d) return false;
    return !!d.hardManual || (d.hardScore || 0) >= 2;
  }

  function setHardManual(id, value) {
    writePhrase(id, { hardManual: !!value });
  }

  // Simple on/off flag, like ×6. Clearing also zeroes any legacy auto-score.
  function toggleHard(id) {
    var nowHard = !isHard(id);
    if (nowHard) writePhrase(id, { hardManual: true });
    else writePhrase(id, { hardManual: false, hardScore: 0 });
    invalidateCycles();
    return nowHard;
  }

  // How many copies of a phrase go into one rotation cycle.
  function cycleCopies(id) {
    var n = 1;
    if (isBoosted(id)) n *= 2;
    if (isHard(id)) n *= 2;
    return n;
  }

  function getHardPhrases() {
    return getMasteredPhrases().filter(function (p) { return isHard(p.id); });
  }

  function findPhraseById(id) {
    for (var i = 0; i < PHRASES.length; i++) {
      if (PHRASES[i].id === id) return PHRASES[i];
    }
    return null;
  }

  // ── Spaced repetition selection ────────────────────────

  function countMastered() {
    var n = 0;
    var active = activePhrases();
    for (var i = 0; i < active.length; i++) {
      if (getPhraseData(active[i].id).level === 4) n++;
    }
    return n;
  }

  function selectNext() {
    var now = Date.now();
    var eligible = [];
    var weights = [];
    var active = activePhrases();

    for (var i = 0; i < active.length; i++) {
      var p = active[i];
      var d = getPhraseData(p.id);
      if (d.level === 4) continue;
      if (p.id === lastShownId) continue;

      var interval = INTERVALS[d.level];
      if (d.lastSeen && (now - d.lastSeen < interval)) continue;

      eligible.push(p);
      weights.push(WEIGHTS[d.level]);
    }

    if (eligible.length === 0) {
      // all non-mastered are cooling — pick the one closest to eligible
      var best = null;
      var bestDelta = Infinity;
      for (var i = 0; i < active.length; i++) {
        var p = active[i];
        var d = getPhraseData(p.id);
        if (d.level === 4) continue;
        if (p.id === lastShownId && countMastered() < active.length - 1) continue;
        var delta = (d.lastSeen + INTERVALS[d.level]) - now;
        if (delta < bestDelta) { bestDelta = delta; best = p; }
      }
      return best; // null if ALL mastered
    }

    return weightedPick(eligible, weights);
  }

  function weightedPick(items, weights) {
    var total = 0;
    for (var i = 0; i < weights.length; i++) total += weights[i];
    var r = Math.random() * total;
    var acc = 0;
    for (var i = 0; i < items.length; i++) {
      acc += weights[i];
      if (r < acc) return items[i];
    }
    return items[items.length - 1];
  }

  // ── Rendering ──────────────────────────────────────────

  function renderPhrase(phrase) {
    currentPhrase = phrase;
    $('phrase-context').textContent = phrase.context;
    $('phrase-french').textContent = phrase.fr;
    $('phrase-english').textContent = phrase.en;

    $('session-counter').textContent = sessionSeen + (sessionSeen === 1 ? ' vue' : ' vues');

    hide($('translation-reveal'));
    hide($('summary-card'));
    hide($('btn-next'));
    show($('rating-buttons'));

    // re-enable rating buttons
    var btns = document.querySelectorAll('.rating-btn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].disabled = false;
      btns[i].style.opacity = '';
    }
  }

  function revealTranslation() {
    hide($('rating-buttons'));
    show($('translation-reveal'));
    show($('btn-next'));
  }

  function showSummary() {
    $('summary-seen').textContent = sessionSeen;
    $('summary-new').textContent = sessionNew;
    var mastered = countMastered();
    $('summary-mastered').textContent = mastered + ' / ' + PHRASES.length;
    $('summary-progress').style.width = Math.round((mastered / PHRASES.length) * 100) + '%';

    hide($('rating-buttons'));
    hide($('translation-reveal'));
    hide($('btn-next'));
    show($('summary-card'));
  }

  function advance() {
    var next = selectNext();
    if (!next) {
      showComplete();
      return;
    }
    if (currentPhrase) {
      phraseHistory.push(currentPhrase.id);
      if (phraseHistory.length > 30) phraseHistory.shift();
    }
    lastShownId = next.id;
    showScreen('screen-phrase');
    renderPhrase(next);
  }

  function phrasePrev() {
    if (phraseHistory.length === 0) return; // nothing to go back to
    var id = phraseHistory.pop();
    var p = findPhraseById(id);
    if (!p) return;
    lastShownId = p.id;
    renderPhrase(p);
  }

  function showComplete() {
    $('complete-total').textContent = PHRASES.length;
    $('complete-sessions').textContent = state.sessionCount;
    showScreen('screen-complete');
  }

  // ── Progress overlay ──────────────────────────────────

  function renderProgress() {
    var mastered = [];
    var familiar = [];
    var learning = [];
    var notYet = [];
    var unseen = [];
    var difficult = [];   // mastered but hard to recall

    var active = activePhrases();
    for (var i = 0; i < active.length; i++) {
      var p = active[i];
      var d = getPhraseData(p.id);
      var entry = { phrase: p, data: d };
      if (d.level === 4 && isHard(p.id)) { difficult.push(entry); continue; }
      switch (d.level) {
        case 4: mastered.push(entry); break;
        case 3: familiar.push(entry); break;
        case 2: learning.push(entry); break;
        case 1: notYet.push(entry); break;
        default: unseen.push(entry); break;
      }
    }

    var masteredCount = mastered.length;
    var pct = Math.round((masteredCount / active.length) * 100);
    $('progress-overview-text').textContent = masteredCount + ' / ' + active.length + ' maîtrisées (' + pct + ' %)';
    $('progress-bar-fill').style.width = pct + '%';

    var totalReviews = 0;
    var totalHf = 0;
    var phrasesSeen = 0;
    for (var i = 0; i < active.length; i++) {
      var d = getPhraseData(active[i].id);
      totalReviews += d.timesSeen;
      totalHf += (d.hfSeen || 0);
      if (d.timesSeen > 0) phrasesSeen++;
    }
    $('progress-stats-text').textContent =
      totalReviews + ' révisions · ' + phrasesSeen + ' / ' + active.length + ' expressions vues' +
      (totalHf > 0 ? ' · ◆' + totalHf + ' Mains Libres' : '');

    var list = $('progress-list');
    list.innerHTML = '';

    var groups = [
      { title: 'Difficiles', cls: 'new', items: difficult },
      { title: 'Maîtrisées', cls: 'mastered', items: mastered },
      { title: 'Familières', cls: 'familiar', items: familiar },
      { title: 'En apprentissage', cls: 'learning', items: learning },
      { title: 'Pas encore', cls: 'learning', items: notYet },
      { title: 'Pas encore vues', cls: 'unseen', items: unseen }
    ];

    for (var g = 0; g < groups.length; g++) {
      var group = groups[g];
      if (group.items.length === 0) continue;

      var title = document.createElement('p');
      title.className = 'progress-group-title level-' + group.cls;
      title.textContent = group.title + ' (' + group.items.length + ')';
      list.appendChild(title);

      for (var j = 0; j < group.items.length; j++) {
        var entry = group.items[j];
        var item = document.createElement('div');
        item.className = 'progress-item';
        item.setAttribute('data-id', entry.phrase.id);

        var dot = document.createElement('span');
        dot.className = 'progress-dot level-' + group.cls;

        var text = document.createElement('span');
        text.className = 'progress-phrase';
        text.textContent = entry.phrase.fr;

        var seen = document.createElement('span');
        seen.className = 'progress-seen';
        seen.textContent = entry.data.timesSeen > 0 ? ('×' + entry.data.timesSeen) : '';

        var hfSeen = document.createElement('span');
        hfSeen.className = 'progress-hf-seen';
        hfSeen.textContent = entry.data.hfSeen > 0 ? ('◆' + entry.data.hfSeen) : '';

        item.appendChild(dot);
        item.appendChild(text);
        item.appendChild(seen);
        item.appendChild(hfSeen);
        list.appendChild(item);

        // expanded detail (if this is the expanded one)
        if (expandedProgressId === entry.phrase.id) {
          var expanded = document.createElement('div');
          expanded.className = 'progress-expanded';

          var enText = document.createElement('p');
          enText.className = 'progress-expanded-en';
          enText.textContent = entry.phrase.en;
          expanded.appendChild(enText);

          if (entry.data.level === 4) {
            var resetBtn = document.createElement('button');
            resetBtn.className = 'btn-reset-phrase';
            resetBtn.textContent = 'Réinitialiser';
            resetBtn.setAttribute('data-reset-id', entry.phrase.id);
            expanded.appendChild(resetBtn);
          }

          list.appendChild(expanded);
        }

        (function (id) {
          item.addEventListener('click', function () {
            expandedProgressId = expandedProgressId === id ? null : id;
            renderProgress();
          });
        })(entry.phrase.id);
      }
    }
  }

  // ── Acquis mode ────────────────────────────────────────

  function getMasteredPhrases() {
    var result = [];
    var active = activePhrases();
    for (var i = 0; i < active.length; i++) {
      if (getPhraseData(active[i].id).level === 4) result.push(active[i]);
    }
    return result;
  }

  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  // Weighted shuffle: boosted (×6) phrases get 2× weight, so they
  // land earlier / more often at the front of each session's order.
  function weightedShuffle(arr) {
    var pool = arr.slice();
    var out = [];
    while (pool.length > 0) {
      var total = 0;
      var weights = [];
      for (var i = 0; i < pool.length; i++) {
        var w = isBoosted(pool[i].id) ? 2 : 1;
        weights.push(w);
        total += w;
      }
      var r = Math.random() * total;
      var acc = 0;
      var idx = pool.length - 1;
      for (var i = 0; i < pool.length; i++) {
        acc += weights[i];
        if (r < acc) { idx = i; break; }
      }
      out.push(pool.splice(idx, 1)[0]);
    }
    return out;
  }

  // ── Rotation playlist ──────────────────────────────────
  // A per-session reshuffle gave wildly uneven coverage: with the whole pool
  // redrawn every time, some phrases came up constantly and others never (21
  // mastered phrases had never been played). Instead we build one cycle in which
  // every phrase appears once per unit of weight (plain 1, ×6 or hard 2, hard+×6
  // 4), then walk through it across sessions. Every phrase is guaranteed its turn.

  // Mains Libres repeats ×6/hard phrases within a pass; Mes Acquis does not —
  // meeting the same card again a few minutes after seeing its answer tests
  // short-term memory, not recall.
  function usesWeightedCycle(key) { return key === 'hf'; }

  function poolSignature(pool, weighted) {
    if (!weighted) return pool.length + ':1';
    var totalWeight = 0;
    for (var i = 0; i < pool.length; i++) totalWeight += cycleCopies(pool[i].id);
    return pool.length + ':' + totalWeight;
  }

  function shuffleIds(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  // `done` (optional) maps id → how many copies of it have already been shown
  // in the current pass; those are left out so a rebuild doesn't repeat them.
  function buildCycle(pool, weighted, done) {
    var copiesOf = {}, maxCopies = 1, anyLeft = false;
    for (var i = 0; i < pool.length; i++) {
      var id = pool[i].id;
      var c = weighted ? cycleCopies(id) : 1;
      if (done) c = Math.max(0, c - (done[id] || 0));
      copiesOf[id] = c;
      if (c > 0) anyLeft = true;
      if (c > maxCopies) maxCopies = c;
    }
    if (!anyLeft) return [];   // pass finished — caller starts a fresh one

    if (!weighted || maxCopies === 1) {
      var single = [];
      for (var i = 0; i < pool.length; i++) {
        if (copiesOf[pool[i].id] > 0) single.push(pool[i].id);
      }
      return shuffleIds(single);
    }

    // Spread each phrase's copies evenly around the cycle: a phrase with k
    // copies aims for slots one N/k stride apart (k=2 → ~half a cycle between
    // them, k=4 → ~a quarter), from a random starting offset. Collisions walk
    // forward to the next free slot. Most-constrained phrases are placed first.
    var total = 0;
    for (var i = 0; i < pool.length; i++) total += copiesOf[pool[i].id];

    var order = pool.slice().sort(function (a, b) {
      var d = copiesOf[b.id] - copiesOf[a.id];
      return d !== 0 ? d : (Math.random() - 0.5);
    });

    var slots = new Array(total);
    for (var i = 0; i < order.length; i++) {
      var id = order[i].id, k = copiesOf[id];
      var stride = total / k;
      var offset = Math.random() * total;
      for (var j = 0; j < k; j++) {
        var pos = Math.round(offset + j * stride) % total;
        var tries = 0;
        while (slots[pos] !== undefined && tries < total) { pos = (pos + 1) % total; tries++; }
        slots[pos] = id;
      }
    }
    return slots;
  }

  // Returns the next `count` phrases from the persistent cycle, rebuilding it
  // when exhausted or when the pool changed. `key` is 'hf' or 'acq'.
  function takeFromCycle(key, pool, count) {
    var cycleKey = key + 'Cycle', cursorKey = key + 'Cursor',
        sigKey = key + 'Sig', passKey = key + 'Pass';
    var byId = {};
    for (var i = 0; i < pool.length; i++) byId[pool[i].id] = pool[i];
    var weighted = usesWeightedCycle(key);
    var sig = poolSignature(pool, weighted);
    if (!state[passKey]) state[passKey] = {};

    // Rebuild when the pool changes — but only over what's still owed this
    // pass, so mastering/flagging a phrase no longer restarts the rotation.
    if (!state[cycleKey] || !state[cycleKey].length || state[sigKey] !== sig) {
      state[cycleKey] = buildCycle(pool, weighted, state[passKey]);
      state[cursorKey] = 0;
      state[sigKey] = sig;
      if (!state[cycleKey].length) {          // nothing owed → begin a new pass
        state[passKey] = {};
        state[cycleKey] = buildCycle(pool, weighted);
      }
    }

    var out = [];
    var guard = 0;
    while (out.length < count && guard < 5000) {
      guard++;
      if (state[cursorKey] >= state[cycleKey].length) {
        // The cycle has served everything it owed, so lay out the next pass in
        // full. (Filtering by what's been *seen* only applies when the pool
        // changes — see above; doing it here would re-serve the same phrase
        // over and over, because the pre-fetch runs ahead of what's displayed.)
        state[cycleKey] = avoidEarlyRepeat(buildCycle(pool, weighted), state[key + 'Last']);
        state[cursorKey] = 0;
        if (!state[cycleKey].length) break;
      }
      var id = state[cycleKey][state[cursorKey]];
      state[cursorKey]++;
      var p = byId[id];
      if (p) out.push(p);                     // skip ids no longer in the pool
    }
    save();
    return out;
  }

  // Keeps the phrase you just saw from reappearing at the top of the next pass
  function avoidEarlyRepeat(cyc, lastId) {
    if (!lastId || cyc.length < 8) return cyc;
    var guard = Math.min(20, Math.floor(cyc.length / 2));
    for (var i = 0; i < guard; i++) {
      if (cyc[i] === lastId) {
        var half = Math.floor(cyc.length / 2);
        var k = Math.min(cyc.length - 1, half + Math.floor(Math.random() * half));
        var t = cyc[i]; cyc[i] = cyc[k]; cyc[k] = t;
      }
    }
    return cyc;
  }

  // Counts a phrase as covered in the current pass (called when it's shown).
  // If the previous pass was already complete, this card opens a new one — so
  // the final card of a pass still displays "221 / 221" before it rolls over.
  function markPassSeen(key, id, poolSize) {
    var passKey = key + 'Pass';
    if (!state[passKey]) state[passKey] = {};
    if (poolSize && passProgress(key) >= poolSize) state[passKey] = {};
    state[passKey][id] = (state[passKey][id] || 0) + 1;
    state[key + 'Last'] = id;
    save();
  }

  // How many distinct phrases have been covered in the current pass
  function passProgress(key) {
    var p = state[key + 'Pass'] || {};
    var n = 0;
    for (var id in p) { if (p[id] > 0) n++; }
    return n;
  }

  // Called when boost/difficulty changes so the cycle is rebuilt with new weights.
  // Difficulty also changes who belongs in the ⚑ Écouter pass, so reconcile that
  // queue here too — one hook covers every place a flag can be toggled.
  function invalidateCycles() {
    state.hfSig = null;
    state.acqSig = null;
    syncEcouterQueue();
  }

  // ── ⚑ Écouter queue ────────────────────────────────────
  // The flagged pool is small, so it skips the weighted rotation and gets a
  // plain playlist instead: each flagged phrase contributes its main and its alt
  // as two independent items, shuffled together. `ecCursor` walks the list
  // across sessions; when it reaches the end the pass is over (félicitations)
  // and the next session shuffles a fresh one.

  function ecKey(id, exercise) { return id + ':' + exercise; }

  function ecParse(key) {
    var bits = String(key).split(':');
    return { id: parseInt(bits[0], 10), exercise: bits[1] === 'alt' ? 'alt' : 'main' };
  }

  // Every sentence that belongs in a pass right now, phrase order.
  function ecEligibleKeys() {
    var keys = [], hard = getHardPhrases();
    for (var i = 0; i < hard.length; i++) {
      keys.push(ecKey(hard[i].id, 'main'));
      if (hard[i].alt_usage) keys.push(ecKey(hard[i].id, 'alt'));
    }
    return keys;
  }

  // Guards a queued item at play time against changes the queue never saw
  // (phrase deleted from data.js, un-mastered, un-flagged on another device).
  function ecPlayable(id) {
    if (!isHard(id)) return false;
    if ((state.deletedIds || []).indexOf(id) !== -1) return false;
    if (getPhraseData(id).level !== 4) return false;
    return !!findPhraseById(id);
  }

  function ecTooClose(list, pos, key, minGap) {
    var id = ecParse(key).id;
    var from = Math.max(0, pos - minGap + 1), to = Math.min(list.length, pos + minGap);
    for (var k = from; k < to; k++) {
      if (k !== pos && list[k] && ecParse(list[k]).id === id) return true;
    }
    return false;
  }

  // Shuffle, then push apart the two sentences of the same phrase — a raw
  // shuffle of ~32 items lands several pairs side by side, and hearing a
  // phrase's alt right after its main defeats the point of separating them.
  function ecSpread(keys) {
    var out = shuffleIds(keys.slice());
    var minGap = Math.max(2, Math.floor(out.length / 8));
    for (var attempt = 0; attempt < 6; attempt++) {
      var clean = true;
      for (var i = 0; i < out.length; i++) {
        if (!ecTooClose(out, i, out[i], minGap)) continue;
        clean = false;
        for (var j = 0; j < out.length; j++) {      // find a swap that suits both
          if (j === i) continue;
          var a = out[i], b = out[j];
          out[i] = b; out[j] = a;
          if (!ecTooClose(out, i, b, minGap) && !ecTooClose(out, j, a, minGap)) break;
          out[i] = a; out[j] = b;                   // no good — put them back
        }
      }
      if (clean) break;   // nothing left to fix (or nothing fixable — best effort)
    }
    return out;
  }

  function ecBuildPass() {
    state.ecCycle = ecSpread(ecEligibleKeys());
    state.ecCursor = 0;
  }

  // Keeps a pass in progress in step with the flag list: a phrase flagged now
  // drops into the part not played yet, so it's heard in this same session; an
  // un-flagged one disappears from the pass entirely. Items already played keep
  // their place, so nothing is repeated and nothing loses its turn.
  function syncEcouterQueue() {
    var cycle = state.ecCycle || [];
    if (!cycle.length) return;                     // no pass in progress
    var cursor = Math.min(state.ecCursor || 0, cycle.length);
    if (cursor >= cycle.length) return;            // finished; rebuilt on next start

    var eligible = {}, order = ecEligibleKeys();
    for (var i = 0; i < order.length; i++) eligible[order[i]] = true;

    var seen = {}, head = [], tail = [];
    for (var i = 0; i < cycle.length; i++) {
      var k = cycle[i];
      if (!eligible[k] || seen[k]) continue;       // dropped, or a stray duplicate
      seen[k] = true;
      (i < cursor ? head : tail).push(k);
    }
    for (var i = 0; i < order.length; i++) {       // newly flagged → still to come
      if (seen[order[i]]) continue;
      seen[order[i]] = true;
      tail.splice(Math.floor(Math.random() * (tail.length + 1)), 0, order[i]);
    }

    state.ecCycle = head.concat(tail);
    state.ecCursor = head.length;
    save();
  }

  // Next sentence of the pass, or null when it's complete. Builds a fresh pass
  // when there isn't one. Returns { p, exercise, position }.
  function ecTakeNext() {
    if (!state.ecCycle || !state.ecCycle.length) ecBuildPass();
    var cycle = state.ecCycle || [];
    while ((state.ecCursor || 0) < cycle.length) {
      var item = ecParse(cycle[state.ecCursor]);
      state.ecCursor++;
      var p = ecPlayable(item.id) ? findPhraseById(item.id) : null;
      var text = p && (item.exercise === 'alt' ? p.alt_usage : p.fr);
      if (text) {
        save();
        return { p: p, exercise: item.exercise, position: state.ecCursor };
      }
    }
    save();
    return null;
  }

  // The pass is over — clear it so the next session shuffles a new order.
  function ecResetPass() {
    state.ecCycle = [];
    state.ecCursor = 0;
    save();
  }

  function updateHomeScreen() {
    var mastered = getMasteredPhrases();
    var count = mastered.length;
    var remaining = activePhrases().length - count;
    $('apprentissage-count').textContent = '(' + remaining + ')';
    $('acquis-count').textContent = '(' + count + ')';
    $('btn-acquis').disabled = count === 0;
    $('handsfree-count').textContent = '(' + count + ')';
    $('btn-handsfree').disabled = count === 0;

    var hardCount = getHardPhrases().length;
    [['btn-difficiles', '⚑ Écouter'], ['btn-difficiles-acquis', '⚑ Réviser']].forEach(function (pair) {
      var btn = $(pair[0]);
      if (!btn) return;
      btn.textContent = pair[1] + ' (' + hardCount + ')';
      if (hardCount === 0) hide(btn); else show(btn);
    });
  }

  // A session pulls a batch from the cycle; whatever it doesn't reach is handed
  // back on exit so no phrase loses its turn.
  var SESSION_BATCH = 60;

  function releaseBatch(key, batchLen, maxSeen) {
    if (batchLen > 0) {
      var unused = batchLen - maxSeen;
      if (unused > 0) state[key + 'Cursor'] = Math.max(0, (state[key + 'Cursor'] || 0) - unused);
      save();
    }
  }

  // pool omitted → the full mastered rotation; pool given → a filtered session
  // (Difficiles), which uses a plain shuffle since the set is small.
  function startAcquis(pool) {
    acquisCustomPool = !!pool;
    var source = pool || getMasteredPhrases();
    if (source.length === 0) return;
    if (acquisCustomPool) {
      acquisPhrases = weightedShuffle(source);
      acquisBatchLen = 0;
    } else {
      acquisPhrases = takeFromCycle('acq', source, Math.min(SESSION_BATCH, source.length * 4));
      acquisBatchLen = acquisPhrases.length;
    }
    acquisMaxSeen = 0;
    acquisIndex = 0;
    if (acquisPhrases.length === 0) return;
    showAcquisPhrase();
  }

  function endAcquisSession() {
    releaseBatch('acq', acquisBatchLen, acquisMaxSeen);
    acquisBatchLen = 0;
  }

  function showAcquisPhrase() {
    if (acquisIndex >= acquisPhrases.length) {
      // batch spent — pull the next slice of the cycle so the session continues
      // (a filtered Difficiles session just ends instead)
      var pool = acquisCustomPool ? [] : getMasteredPhrases();
      var more = pool.length ? takeFromCycle('acq', pool, SESSION_BATCH) : [];
      if (more.length) {
        acquisPhrases = acquisPhrases.concat(more);
        acquisBatchLen += more.length;
      } else {
        endAcquisSession();
        showScreen('screen-acquis-done');
        return;
      }
    }
    acquisMaxSeen = Math.max(acquisMaxSeen, acquisIndex + 1);
    var p = acquisPhrases[acquisIndex];
    if (!acquisCustomPool) markPassSeen('acq', p.id, getMasteredPhrases().length);
    showScreen('screen-acquis');
    $('acquis-context').textContent = p.context;
    $('acquis-english').textContent = p.en;
    $('acquis-french').textContent = p.fr;
    $('acquis-alt').textContent = p.alt_usage || '';
    // Shows progress through the current pass over your whole collection —
    // it carries across sessions, so "45 / 221" means 45 covered so far.
    $('acquis-counter').textContent = acquisCustomPool
      ? (acquisIndex + 1) + ' / ' + acquisPhrases.length
      : passProgress('acq') + ' / ' + getMasteredPhrases().length;
    updateAcquisSixButton();
    show($('acquis-reveal-area'));
    hide($('acquis-revealed'));
    hide($('btn-suivant'));
  }

  function updateAcquisSixButton() {
    var btn = $('btn-acquis-six');
    if (!btn) return;
    var p = acquisPhrases[acquisIndex];
    var boosted = p ? isBoosted(p.id) : false;
    btn.classList.toggle('activated', boosted);
    btn.textContent = '×6';
    updateFlagButton('btn-acquis-hard', p);
  }

  // Shared by both screens — reflects the difficulty flag of the current phrase
  function updateFlagButton(btnId, phrase) {
    var btn = $(btnId);
    if (!btn) return;
    btn.classList.toggle('activated', phrase ? isHard(phrase.id) : false);
  }

  function revealAcquis() {
    hide($('acquis-reveal-area'));
    show($('acquis-revealed'));
    show($('btn-suivant'));
  }

  function speakFrench(text) {
    if (!('speechSynthesis' in window)) return;
    var u = new SpeechSynthesisUtterance(text);
    u.lang = 'fr-FR';
    u.rate = 0.9;
    var voices = speechSynthesis.getVoices();
    for (var i = 0; i < voices.length; i++) {
      if (voices[i].lang.indexOf('fr') === 0) {
        u.voice = voices[i];
        break;
      }
    }
    speechSynthesis.speak(u);
  }

  // ── Hands-free mode ────────────────────────────────────

  function speakEnglish(text, onEnd) {
    if (!('speechSynthesis' in window)) { if (onEnd) onEnd(); return; }
    var u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    u.rate = 0.95;
    var voices = speechSynthesis.getVoices();
    for (var i = 0; i < voices.length; i++) {
      if (voices[i].lang.indexOf('en') === 0) {
        u.voice = voices[i];
        break;
      }
    }
    if (onEnd) u.onend = onEnd;
    speechSynthesis.speak(u);
  }

  function speakFrenchCb(text, onEnd) {
    if (!('speechSynthesis' in window)) { if (onEnd) onEnd(); return; }
    var u = new SpeechSynthesisUtterance(text);
    u.lang = 'fr-FR';
    u.rate = 0.9;
    var voices = speechSynthesis.getVoices();
    for (var i = 0; i < voices.length; i++) {
      if (voices[i].lang.indexOf('fr') === 0) {
        u.voice = voices[i];
        break;
      }
    }
    if (onEnd) u.onend = onEnd;
    speechSynthesis.speak(u);
  }

  function initAudio() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
  }

  function playDing(type, cb) {
    if (!audioCtx) { if (cb) cb(); return; }
    try {
      if (audioCtx.state === 'suspended') audioCtx.resume();
      var freq = (type === 'fr') ? 880 : 440;
      var osc = audioCtx.createOscillator();
      var gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.frequency.value = freq;
      gain.gain.value = 0.3;
      osc.start();
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.15);
      osc.stop(audioCtx.currentTime + 0.15);
      setTimeout(function () { if (cb) cb(); }, 200);
    } catch (e) {
      if (cb) cb();
    }
  }

  function requestWakeLock() {
    if ('wakeLock' in navigator) {
      navigator.wakeLock.request('screen').then(function (wl) {
        wakeLock = wl;
        // Re-request when the lock is released by the browser (screen dimmed, tab hidden, etc.)
        wl.addEventListener('release', function () {
          wakeLock = null;
        });
      }).catch(function () {});
    }
  }

  function releaseWakeLock() {
    if (wakeLock) {
      wakeLock.release().catch(function () {});
      wakeLock = null;
    }
  }

  // Shared cancellation — stops speech, timers, and final-pause flag.
  // Bumps the generation token so callbacks from the cancelled step
  // (e.g. a cancelled utterance's onend, a pending ding) become no-ops.
  function cancelCurrentStep() {
    handsfreeGen++;
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    if (handsfreeTimerId) { clearTimeout(handsfreeTimerId); handsfreeTimerId = null; }
    if (handsfreeCountdownId) { clearInterval(handsfreeCountdownId); handsfreeCountdownId = null; }
    handsfreeFinalPause = false;
    handsfreeLastReadNum = 0;
    handsfreeCountdownDone = null;
    handsfreeCountdownTick = null;
    handsfreeResumeSpeak = null;
    handsfreeResumeAction = null;
  }

  function endHandsfreeSession() {
    if (handsfreeCustomPool) {
      // Hand back the sentence that was playing when you quit, so resuming
      // later picks it up again instead of skipping it (same idea as
      // releaseBatch for the main rotation).
      var pos = handsfreePositions[handsfreeIndex];
      if (pos && pos === state.ecCursor) { state.ecCursor = pos - 1; save(); }
      return;
    }
    releaseBatch('hf', handsfreeBatchLen, handsfreeMaxSeen);
    handsfreeBatchLen = 0;
  }

  // Whole ⚑ Écouter pass done: say so out loud (the phone is probably in a
  // pocket), stop, and clear the pass so the next session shuffles a new one.
  function finishEcouterPass() {
    handsfreeActive = false;
    endHandsfreeSession();
    ecResetPass();
    releaseWakeLock();
    updateHomeScreen();
    showScreen('screen-ecouter-done');
    speakFrenchCb(ECOUTER_DONE_SPEECH);
  }

  function stopHandsfree() {
    handsfreeActive = false;
    handsfreePaused = false;
    cancelCurrentStep();
    endHandsfreeSession();
    releaseWakeLock();
    updateHomeScreen();
    showScreen('screen-home');
  }

  function pauseHandsfree() {
    if (!handsfreeActive) return;
    handsfreePaused = true;
    if (handsfreeCountdownId) {
      // Freeze the countdown; resume restarts it with the seconds left.
      clearInterval(handsfreeCountdownId);
      handsfreeCountdownId = null;
      var label = handsfreeCountdownLabel, remaining = handsfreeCountdownRemaining,
          done = handsfreeCountdownDone, tick = handsfreeCountdownTick;
      handsfreeResumeAction = function () { startCountdown(remaining, label, done, tick); };
    } else if (handsfreeResumeSpeak) {
      // Mid-sentence: cancel and re-read it from the start on resume
      // (mobile speech engines can't reliably resume a paused utterance).
      if ('speechSynthesis' in window) speechSynthesis.cancel();
      handsfreeResumeAction = handsfreeResumeSpeak;
    } else {
      // Mid-gap (e.g. during a beep): replay the current exercise.
      if (handsfreeHistory.length > 0) handsfreeHistory.pop();
      handsfreeResumeAction = function () { handsfreeStep(); };
    }
    $('handsfree-phase').textContent = 'En pause…';
    $('btn-handsfree-pause').textContent = '▶ Reprendre';
  }

  function resumeHandsfree() {
    if (!handsfreeActive) return;
    handsfreePaused = false;
    $('btn-handsfree-pause').textContent = '⏸ Pause';
    var action = handsfreeResumeAction;
    handsfreeResumeAction = null;
    if (action) action();
    else handsfreeStep();
  }

  function clearPausedUI() {
    handsfreePaused = false;
    $('btn-handsfree-pause').textContent = '⏸ Pause';
  }

  // Move on to the next thing to play. In the full rotation a phrase is two
  // exercises (main, then alt); in ⚑ Écouter every sentence is its own queue
  // item, so there is no main→alt step inside a phrase.
  function advanceHandsfreeItem(p) {
    if (handsfreeCustomPool) { handsfreeIndex++; return; }
    if (handsfreeExercise === 'main' && p && p.alt_usage) {
      handsfreeExercise = 'alt';
    } else {
      handsfreeExercise = 'main';
      handsfreeIndex++;
    }
  }

  function skipNextHandsfree() {
    if (!handsfreeActive) return;
    clearPausedUI();
    handsfreeLastPrevTime = 0;
    cancelCurrentStep();
    advanceHandsfreeItem(handsfreePhrases[handsfreeIndex]);
    handsfreeStep();
  }

  // Apple-Music-style "back": first press restarts the current sentence;
  // a second press within 3s jumps to the previous item.
  function skipPrevHandsfree() {
    if (!handsfreeActive) return;
    clearPausedUI();
    cancelCurrentStep();
    var now = Date.now();
    var doublePress = (now - handsfreeLastPrevTime) < 3000;
    handsfreeLastPrevTime = now;
    // Drop the current entry (handsfreeStep re-pushes it).
    if (handsfreeHistory.length > 0) handsfreeHistory.pop();
    if (doublePress && handsfreeHistory.length > 0) {
      // Go to the actual previous item.
      var prev = handsfreeHistory.pop();
      handsfreeIndex = prev.index;
      handsfreeExercise = prev.exercise;
      handsfreeLastPrevTime = 0; // a further back restarts that item first
    }
    // else: first press → restart current item (index/exercise unchanged)
    handsfreeStep();
  }

  // pool omitted → the full mastered rotation; pool given → the ⚑ Écouter
  // session, which walks its own persistent queue one sentence at a time.
  function startHandsfree(pool) {
    handsfreeCustomPool = !!pool;
    handsfreeExercises = [];
    handsfreePositions = [];
    if (handsfreeCustomPool) {
      if (pool.length === 0) return;
      syncEcouterQueue();     // pick up flags added since the pass was built
      handsfreePhrases = [];  // filled from the queue as the session goes
      handsfreeBatchLen = 0;
    } else {
      var source = getMasteredPhrases();
      handsfreePhrases = source.length ? takeFromCycle('hf', source, Math.min(SESSION_BATCH, source.length * 4)) : [];
      handsfreeBatchLen = handsfreePhrases.length;
      if (handsfreePhrases.length === 0) return;
    }
    handsfreeMaxSeen = 0;
    handsfreeIndex = 0;
    handsfreeExercise = 'main';
    handsfreePaused = false;
    handsfreeHistory = [];
    initAudio(); // create AudioContext on user gesture (tap)
    handsfreeActive = true;
    $('btn-handsfree-pause').textContent = '⏸ Pause';
    requestWakeLock();
    showScreen('screen-handsfree');
    handsfreeStep();
  }

  // Reusable countdown: ring stays visible at all times, calls onDone when it hits 0
  // Two-digit values need a smaller font or they overflow / wrap inside the
  // 80px ring (especially when the webfont hasn't loaded and the wider
  // fallback serif is used, e.g. offline).
  function setCountdownNum(value) {
    var el = $('handsfree-countdown-num');
    var txt = String(value);
    el.textContent = txt;
    el.classList.toggle('two-digit', txt.length > 1);
  }

  // Sets the phase caption and keeps it in sync for pause/resume
  function setPhaseLabel(txt) {
    $('handsfree-phase').textContent = txt;
    handsfreeCountdownLabel = txt;
  }

  // onTick(remaining) is optional — used to change the caption partway through
  // a countdown without restarting the numbers.
  function startCountdown(seconds, label, onDone, onTick) {
    if (!handsfreeActive) return;
    // Never allow two countdown intervals at once — kill any leftover first.
    if (handsfreeCountdownId) { clearInterval(handsfreeCountdownId); handsfreeCountdownId = null; }
    handsfreeResumeSpeak = null; // we're in a countdown, not speaking
    setPhaseLabel(label);
    handsfreeCountdownDone = onDone;
    handsfreeCountdownTick = onTick || null;
    handsfreeCountdownRemaining = seconds;
    setCountdownNum(seconds);
    if (onTick) onTick(seconds);
    var intervalId = setInterval(function () {
      if (!handsfreeActive) { clearInterval(intervalId); return; }
      handsfreeCountdownRemaining--;
      setCountdownNum(Math.max(0, handsfreeCountdownRemaining));
      if (handsfreeCountdownTick) handsfreeCountdownTick(handsfreeCountdownRemaining);
      if (handsfreeCountdownRemaining <= 0) {
        clearInterval(intervalId);
        if (handsfreeCountdownId === intervalId) handsfreeCountdownId = null;
        var done = handsfreeCountdownDone;
        handsfreeCountdownDone = null;
        handsfreeCountdownTick = null;
        if (done) done();
      }
    }, 1000);
    handsfreeCountdownId = intervalId;
  }

  // Show ♪ in countdown ring to indicate speech is playing
  function showSpeakingIndicator(label) {
    if (label) $('handsfree-phase').textContent = label;
    setCountdownNum('♪');
  }

  // Speak a sentence and register a resume hook, so pausing mid-sentence and
  // resuming re-reads it from the start (reliable across browsers).
  // Browsers fire onend even for CANCELLED utterances, so the callback checks
  // the generation token and bails if this step has since been cancelled.
  function speakHF(label, speakFn, text, onEnd) {
    if (!handsfreeActive || handsfreePaused) return;
    var gen = handsfreeGen;
    handsfreeResumeSpeak = function () { speakHF(label, speakFn, text, onEnd); };
    showSpeakingIndicator(label);
    speakFn(text, function () {
      if (!handsfreeActive || handsfreePaused || gen !== handsfreeGen) return;
      handsfreeResumeSpeak = null;
      onEnd();
    });
  }

  // Recursive French readings — checks handsfreeReadTarget live so ×6 works mid-exercise
  function doFrenchReads(frenchText, readNum, onDone) {
    if (!handsfreeActive) return;
    var gen = handsfreeGen;
    playDing('fr', function () {
      if (!handsfreeActive || handsfreePaused || gen !== handsfreeGen) return;
      speakHF('Répétez !', speakFrenchCb, frenchText, function () {
        handsfreeLastReadNum = readNum; // record completed read
        if (readNum >= handsfreeReadTarget) {
          onDone();
        } else {
          startCountdown(8, 'Encore…', function () {
            doFrenchReads(frenchText, readNum + 1, onDone);
          });
        }
      });
    });
  }

  // Reflects the persistent boost flag of the current phrase
  function updateSixButton() {
    var btn = $('btn-handsfree-six');
    if (!btn) return;
    var p = handsfreePhrases[handsfreeIndex];
    var boosted = p ? isBoosted(p.id) : false;
    btn.classList.toggle('activated', boosted);
    btn.textContent = '×6';
    updateFlagButton('btn-handsfree-hard', p);
  }

  function handsfreeStep() {
    if (!handsfreeActive) return;
    if (handsfreeIndex >= handsfreePhrases.length) {
      if (handsfreeCustomPool) {
        // ⚑ Écouter: one sentence at a time, so a phrase flagged mid-session is
        // already in the queue by the time we get here.
        var item = ecTakeNext();
        if (!item) { finishEcouterPass(); return; }
        handsfreePhrases.push(item.p);
        handsfreeExercises.push(item.exercise);
        handsfreePositions.push(item.position);
      } else {
        // full rotation: pull the next slice and keep going
        var src = getMasteredPhrases();
        var more = src.length ? takeFromCycle('hf', src, SESSION_BATCH) : [];
        if (more.length) {
          handsfreePhrases = handsfreePhrases.concat(more);
          handsfreeBatchLen += more.length;
        } else {
          handsfreeActive = false;
          endHandsfreeSession();
          releaseWakeLock();
          showScreen('screen-acquis-done');
          return;
        }
      }
    }
    if (handsfreeCustomPool) handsfreeExercise = handsfreeExercises[handsfreeIndex];
    handsfreeMaxSeen = Math.max(handsfreeMaxSeen, handsfreeIndex + 1);

    // Push current state to history for multi-step skip-back
    handsfreeHistory.push({ index: handsfreeIndex, exercise: handsfreeExercise });
    if (handsfreeHistory.length > 30) handsfreeHistory.shift(); // cap history

    var p = handsfreePhrases[handsfreeIndex];
    // count the phrase once per visit, not once per exercise (main + alt)
    if (!handsfreeCustomPool && handsfreeExercise === 'main') markPassSeen('hf', p.id, getMasteredPhrases().length);
    $('handsfree-counter').textContent = handsfreeCustomPool
      ? handsfreePositions[handsfreeIndex] + ' / ' + (state.ecCycle || []).length
      : passProgress('hf') + ' / ' + getMasteredPhrases().length;

    // Reset per-exercise state — boosted phrases start at 6 reads, except in a
    // ⚑ Écouter session, where every sentence gets ECOUTER_READS regardless.
    handsfreeReadTarget = handsfreeCustomPool ? ECOUTER_READS : (isBoosted(p.id) ? 6 : 3);
    handsfreeFinalPause = false;
    handsfreeLastReadNum = 0;
    updateSixButton();

    var englishText, frenchText;
    if (handsfreeExercise === 'main') {
      englishText = p.en;
      frenchText = p.fr;
    } else {
      englishText = p.alt_usage_en || p.alt_usage || '';
      frenchText = p.alt_usage || '';
    }

    // Phase 1: show both English and French immediately, EN beep, speak English
    $('handsfree-english').textContent = englishText;
    $('handsfree-french').textContent = frenchText;
    show($('handsfree-english-card'));
    show($('handsfree-french-area'));
    incrementHfSeen(p.id);
    showSpeakingIndicator('Écoutez en anglais…');

    var gen = handsfreeGen;
    playDing('en', function () {
      if (!handsfreeActive || handsfreePaused || gen !== handsfreeGen) return;
      speakHF('Écoutez en anglais…', speakEnglish, englishText, function () {
        // 2s countdown after English, then 9s thinking countdown
        handsfreeCurrentFrench = frenchText;
        var advanceFn = function () {
          if (!handsfreeActive) return;
          handsfreeFinalPause = true;
          startCountdown(8, 'Suivant…', function () {
            handsfreeFinalPause = false;
            advanceHandsfreeItem(p);
            handsfreeStep();
          });
        };
        handsfreeCurrentReadsDoneCallback = advanceFn;
        // One continuous 11s countdown (2s to finish taking in the English,
        // then 9s to recall). Previously these were two separate countdowns,
        // so the ring showed "2, 1" and then restarted at "9" — which read
        // like a broken 12, 11, 10… Now the number runs straight down and only
        // the caption changes when the thinking time starts.
        startCountdown(11, 'Écoutez en anglais…', function () {
          doFrenchReads(frenchText, 1, advanceFn);
        }, function (remaining) {
          if (remaining === 9) setPhaseLabel('Rappelez-vous…');
        });
      });
    });
  }

  // ── Chercher mode ─────────────────────────────────────

  function startChercher() {
    showScreen('screen-chercher');
    $('chercher-input').value = '';
    renderChercherResults('');
    $('chercher-input').focus();
  }

  function renderChercherResults(query) {
    var q = query.trim().toLowerCase();
    var all = activePhrases();
    var results = q ? all.filter(function (p) {
      if (p.fr && p.fr.toLowerCase().indexOf(q) !== -1) return true;
      if (p.alt_usage && p.alt_usage.toLowerCase().indexOf(q) !== -1) return true;
      return false;
    }) : all;

    $('chercher-count').textContent = results.length + ' expression' + (results.length !== 1 ? 's' : '');

    var container = $('chercher-results');
    container.innerHTML = '';

    for (var i = 0; i < results.length; i++) {
      (function (p) {
        var d = getPhraseData(p.id);
        var card = document.createElement('div');
        card.className = 'chercher-card';

        // Main phrase
        var fr = document.createElement('p');
        fr.className = 'chercher-fr';
        fr.textContent = p.fr;

        var en = document.createElement('p');
        en.className = 'chercher-en';
        en.textContent = p.en;

        card.appendChild(fr);
        card.appendChild(en);

        // Alt usage
        if (p.alt_usage) {
          var divider = document.createElement('hr');
          divider.className = 'chercher-divider';

          var altFr = document.createElement('p');
          altFr.className = 'chercher-alt-fr';
          altFr.textContent = p.alt_usage;

          var altEn = document.createElement('p');
          altEn.className = 'chercher-alt-en';
          altEn.textContent = p.alt_usage_en || '';

          card.appendChild(divider);
          card.appendChild(altFr);
          card.appendChild(altEn);
        }

        // Footer: status + pool actions + delete
        var footer = document.createElement('div');
        footer.className = 'chercher-card-footer';

        var isMastered = d.level === 4;

        var boosted = isBoosted(p.id);

        var stats = document.createElement('span');
        stats.className = 'chercher-stats';
        var status = isMastered ? ('Acquise ' + (boosted ? '×6' : '×3')) : 'En apprentissage';
        var parts = [status];
        if (isHard(p.id)) parts.push('Difficile');
        if (d.timesSeen > 0) parts.push('×' + d.timesSeen + ' apprentissage');
        if (d.hfSeen > 0) parts.push('◆' + d.hfSeen + ' mains libres');
        stats.textContent = parts.join('  ·  ');

        var actions = document.createElement('div');
        actions.className = 'chercher-actions';

        function moveBtn(label, cls, title, disabled, onClick) {
          var b = document.createElement('button');
          b.className = cls;
          b.textContent = label;
          b.title = title;
          b.disabled = disabled;
          b.addEventListener('click', function () {
            onClick();
            renderChercherResults($('chercher-input').value);
            updateHomeScreen();
          });
          return b;
        }

        var toAcquis3 = moveBtn('→ Acquis ×3', 'chercher-move',
          'Déplacer vers Mes Acquis (×3)', isMastered && !boosted,
          function () { moveToPool(p.id, true, false); });

        var toAcquis6 = moveBtn('→ Acquis ×6', 'chercher-move chercher-move-boost',
          'Déplacer vers Mes Acquis avec ×6', isMastered && boosted,
          function () { moveToPool(p.id, true, true); });

        var toAppr = moveBtn('→ Apprentissage', 'chercher-move',
          'Déplacer vers Apprentissage', !isMastered,
          function () { moveToPool(p.id, false); });

        var hardNow = isHard(p.id);
        var hardBtn = moveBtn(hardNow ? 'Difficile ✓' : 'Difficile',
          'chercher-move chercher-move-hard' + (hardNow ? ' activated' : ''),
          hardNow ? 'Ne plus marquer comme difficile' : 'Marquer comme difficile',
          false,
          function () {
            // clearing also resets the automatic score, otherwise it stays hard
            if (hardNow) writePhrase(p.id, { hardManual: false, hardScore: 0 });
            else setHardManual(p.id, true);
            invalidateCycles();
          });

        var delBtn = document.createElement('button');
        delBtn.className = 'chercher-delete';
        delBtn.textContent = 'Supprimer';
        delBtn.addEventListener('click', function () {
          if (confirm('Supprimer "' + p.fr + '" définitivement ?')) {
            deletePhrase(p.id);
            renderChercherResults($('chercher-input').value);
            updateHomeScreen();
          }
        });

        actions.appendChild(toAcquis3);
        actions.appendChild(toAcquis6);
        actions.appendChild(toAppr);
        if (isMastered) actions.appendChild(hardBtn);
        actions.appendChild(delBtn);

        footer.appendChild(stats);
        footer.appendChild(actions);
        card.appendChild(footer);
        container.appendChild(card);
      })(results[i]);
    }

    if (results.length === 0) {
      var empty = document.createElement('p');
      empty.className = 'chercher-empty';
      empty.textContent = 'Aucun résultat.';
      container.appendChild(empty);
    }
  }

  // ── Event binding ─────────────────────────────────────

  function setup() {
    initFirebase();

    // Preload voices
    if ('speechSynthesis' in window) {
      speechSynthesis.getVoices();
    }

    load(function () {
      state.sessionCount++;
      save();
      updateHomeScreen();
    });

    $('btn-apprentissage').addEventListener('click', function () {
      advance();
    });

    $('btn-acquis').addEventListener('click', function () {
      startAcquis();
    });

    $('btn-handsfree').addEventListener('click', function () {
      startHandsfree();
    });

    $('btn-difficiles').addEventListener('click', function () {
      var hard = getHardPhrases();
      if (hard.length === 0) return;
      startHandsfree(hard);
    });

    $('btn-difficiles-acquis').addEventListener('click', function () {
      var hard = getHardPhrases();
      if (hard.length === 0) return;
      startAcquis(hard);
    });

    $('btn-chercher').addEventListener('click', function () {
      startChercher();
    });

    $('btn-chercher-home').addEventListener('click', function () {
      updateHomeScreen();
      showScreen('screen-home');
    });

    $('chercher-input').addEventListener('input', function () {
      renderChercherResults(this.value);
    });

    // Apprentissage back to home
    $('btn-phrase-home').addEventListener('click', function () {
      updateHomeScreen();
      showScreen('screen-home');
    });

    // Delete buttons (appear in every screen header)
    $('btn-phrase-delete').addEventListener('click', function () {
      if (!currentPhrase) return;
      if (!confirm('Supprimer définitivement :\n\n« ' + currentPhrase.fr + ' »')) return;
      deletePhrase(currentPhrase.id);
      updateHomeScreen();
      advance();
    });

    $('btn-acquis-delete').addEventListener('click', function () {
      var p = acquisPhrases[acquisIndex];
      if (!p) return;
      if (!confirm('Supprimer définitivement :\n\n« ' + p.fr + ' »')) return;
      deletePhrase(p.id);
      acquisPhrases.splice(acquisIndex, 1);
      if (acquisIndex >= acquisPhrases.length) acquisIndex = 0;
      updateHomeScreen();
      if (acquisPhrases.length === 0) { showScreen('screen-acquis-done'); return; }
      showAcquisPhrase();
    });

    $('btn-handsfree-delete').addEventListener('click', function () {
      var p = handsfreePhrases[handsfreeIndex];
      if (!p) return;
      if (!confirm('Supprimer définitivement :\n\n« ' + p.fr + ' »')) return;
      deletePhrase(p.id);
      updateHomeScreen();
      cancelCurrentStep();
      if (handsfreeCustomPool) {
        // The queue drops the phrase's other sentence on its own; just move on.
        syncEcouterQueue();
        handsfreeIndex++;
        handsfreeStep();
        return;
      }
      handsfreePhrases.splice(handsfreeIndex, 1);
      if (handsfreePhrases.length === 0) { stopHandsfree(); return; }
      if (handsfreeIndex >= handsfreePhrases.length) handsfreeIndex = 0;
      handsfreeExercise = 'main';
      handsfreeStep();
    });

    // Handsfree stop
    $('btn-handsfree-home').addEventListener('click', function () {
      stopHandsfree();
    });

    // Handsfree pause/resume
    $('btn-handsfree-pause').addEventListener('click', function () {
      if (handsfreePaused) {
        resumeHandsfree();
      } else {
        pauseHandsfree();
      }
    });

    $('btn-handsfree-prev').addEventListener('click', skipPrevHandsfree);

    // Apprentissage prev/next (header)
    $('btn-phrase-prev').addEventListener('click', phrasePrev);
    $('btn-phrase-next').addEventListener('click', function () {
      advance(); // skip without rating
    });

    // Acquis prev/next (header)
    $('btn-acquis-prev').addEventListener('click', function () {
      if (acquisIndex > 0) { acquisIndex--; showAcquisPhrase(); }
    });
    $('btn-acquis-next').addEventListener('click', function () {
      acquisIndex++;
      showAcquisPhrase();
    });

    // Acquis ×6 boost toggle
    $('btn-acquis-six').addEventListener('click', function () {
      var p = acquisPhrases[acquisIndex];
      if (!p) return;
      toggleBoost(p.id);
      invalidateCycles();
      updateAcquisSixButton();
    });
    $('btn-handsfree-next').addEventListener('click', skipNextHandsfree);

    $('btn-handsfree-six').addEventListener('click', function () {
      var p = handsfreePhrases[handsfreeIndex];
      if (!p) return;
      var nowBoosted = toggleBoost(p.id); // persistent — stays until cancelled
      invalidateCycles();
      // In a filtered (⚑ Écouter) session the flag is recorded for the main
      // rotation but never changes this session's readings — always 3.
      if (handsfreeCustomPool) { updateSixButton(); return; }
      if (nowBoosted) {
        handsfreeReadTarget = Math.max(6, handsfreeLastReadNum + 3);
        // If we're in the 8s final pause, cancel it and do more reads
        if (handsfreeFinalPause && handsfreeCurrentFrench && handsfreeCurrentReadsDoneCallback) {
          handsfreeFinalPause = false;
          if (handsfreeTimerId) { clearTimeout(handsfreeTimerId); handsfreeTimerId = null; }
          if (handsfreeCountdownId) { clearInterval(handsfreeCountdownId); handsfreeCountdownId = null; }
          doFrenchReads(handsfreeCurrentFrench, handsfreeLastReadNum + 1, handsfreeCurrentReadsDoneCallback);
        }
      } else {
        // Cancelled — finish the basic 3, or stop after current read if past 3
        handsfreeReadTarget = handsfreeLastReadNum < 3 ? 3 : handsfreeLastReadNum + 1;
      }
      updateSixButton();
    });

    // Acquis mode buttons
    $('btn-reveler').addEventListener('click', revealAcquis);

    $('btn-tts').addEventListener('click', function () {
      if (acquisPhrases[acquisIndex]) {
        speakFrench(acquisPhrases[acquisIndex].fr);
      }
    });

    $('btn-suivant').addEventListener('click', function () {
      acquisIndex++;
      showAcquisPhrase();
    });

    // Difficulty flag — on/off, from either practice screen
    $('btn-acquis-hard').addEventListener('click', function () {
      var p = acquisPhrases[acquisIndex];
      if (!p) return;
      toggleHard(p.id);
      updateFlagButton('btn-acquis-hard', p);
    });

    $('btn-handsfree-hard').addEventListener('click', function () {
      var p = handsfreePhrases[handsfreeIndex];
      if (!p) return;
      toggleHard(p.id);
      updateFlagButton('btn-handsfree-hard', p);
    });

    $('btn-acquis-home').addEventListener('click', function () {
      endAcquisSession();
      updateHomeScreen();
      showScreen('screen-home');
    });

    $('btn-acquis-done-home').addEventListener('click', function () {
      releaseWakeLock();
      updateHomeScreen();
      showScreen('screen-home');
    });

    $('btn-ecouter-done-home').addEventListener('click', function () {
      if ('speechSynthesis' in window) speechSynthesis.cancel();
      releaseWakeLock();
      updateHomeScreen();
      showScreen('screen-home');
    });

    // Acquis keyboard shortcuts (desktop): ← previous, → next, space reveal
    document.addEventListener('keydown', function (e) {
      if (!$('screen-acquis').classList.contains('screen--active')) return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (acquisIndex > 0) { acquisIndex--; showAcquisPhrase(); }
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        acquisIndex++;
        showAcquisPhrase();
      } else if (e.key === ' ') {
        e.preventDefault();
        if ($('acquis-revealed').classList.contains('hidden')) {
          revealAcquis();
        }
      }
    });

    // Rating buttons
    var ratingBtns = document.querySelectorAll('.rating-btn');
    for (var i = 0; i < ratingBtns.length; i++) {
      ratingBtns[i].addEventListener('click', function () {
        if (this.disabled) return;
        var level = parseInt(this.getAttribute('data-level'), 10);
        var boostAttr = this.getAttribute('data-boost');
        var boost = boostAttr === null ? undefined : (boostAttr === 'true');
        handleRating(level, boost, this);
      });
    }

    // Next button
    $('btn-next').addEventListener('click', function () {
      advance();
    });

    // Summary dismiss
    $('btn-dismiss-summary').addEventListener('click', function () {
      advance();
    });

    // Progress overlay
    $('btn-home-progress').addEventListener('click', function () {
      expandedProgressId = null;
      renderProgress();
      show($('overlay-progress'));
    });

    $('btn-close-progress').addEventListener('click', function () {
      hide($('overlay-progress'));
    });

    // Reset phrase (delegated)
    $('progress-list').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-reset-id]');
      if (!btn) return;
      var id = parseInt(btn.getAttribute('data-reset-id'), 10);
      state.phrases[id] = { level: 0, lastSeen: 0, timesSeen: 0 };
      save();
      expandedProgressId = null;
      renderProgress();
    });

    // Reset all (progress overlay)
    $('btn-reset-progress').addEventListener('click', function () {
      if (!confirm('Réinitialiser tout le progrès ?')) return;
      state = defaults();
      state.sessionCount = 1;
      save();
      sessionSeen = 0;
      sessionNew = 0;
      lastShownId = null;
      hide($('overlay-progress'));
      updateHomeScreen();
      advance();
    });

    // Reset all (completion screen)
    $('btn-reset-all').addEventListener('click', function () {
      state = defaults();
      state.sessionCount = 1;
      save();
      sessionSeen = 0;
      sessionNew = 0;
      lastShownId = null;
      updateHomeScreen();
      showScreen('screen-home');
    });
  }

  function handleRating(level, boost, chosenBtn) {
    if (!currentPhrase) return;

    // disable buttons; dim all except the one chosen
    var btns = document.querySelectorAll('.rating-btn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].disabled = true;
      if (chosenBtn && btns[i] !== chosenBtn) {
        btns[i].style.opacity = '0.35';
      }
    }

    var wasNew = setPhraseData(currentPhrase.id, level);
    if (typeof boost === 'boolean') setBoost(currentPhrase.id, boost);
    sessionSeen++;
    if (wasNew) sessionNew++;

    setTimeout(function () { revealTranslation(); }, 300);
  }

  // ── Init ──────────────────────────────────────────────

  // Re-acquire wake lock whenever the screen comes back on (Samsung / iOS release it automatically)
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && handsfreeActive && !handsfreePaused) {
      requestWakeLock();
    }
  });

  document.addEventListener('DOMContentLoaded', setup);

  // Offline support — cache the app shell so it works without internet
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }
})();
