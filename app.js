(function () {
  'use strict';

  var STORAGE_KEY = 'frenchSR_state';
  var VERSION = 1;
  var SUMMARY_INTERVAL = 10;
  // level → minimum cooldown in ms
  var INTERVALS = [0, 120000, 86400000, 604800000, Infinity];
  // level → selection weight (0=unseen, 1=hard, 2=learning, 3=familiar)
  var WEIGHTS = [2, 4, 3, 1];

  var state;
  var sessionSeen = 0;
  var sessionNew = 0;
  var lastShownId = null;
  var currentPhrase = null;
  var expandedProgressId = null;
  var acquisPhrases = [];
  var acquisIndex = 0;
  var handsfreeActive = false;
  var handsfreePhrases = [];
  var handsfreeIndex = 0;
  var handsfreeExercise = 'main'; // 'main' or 'alt'
  var handsfreeTimerId = null;
  var handsfreeCountdownId = null;
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
    return { version: VERSION, phrases: {}, sessionCount: 0 };
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
    return { level: 0, lastSeen: 0, timesSeen: 0 };
  }

  function setPhraseData(id, level) {
    var d = getPhraseData(id);
    var wasNew = d.timesSeen === 0;
    state.phrases[id] = {
      level: level,
      lastSeen: Date.now(),
      timesSeen: d.timesSeen + 1,
      hfSeen: d.hfSeen || 0
    };
    save();
    return wasNew;
  }

  function incrementHfSeen(id) {
    var d = getPhraseData(id);
    state.phrases[id] = {
      level: d.level,
      lastSeen: d.lastSeen,
      timesSeen: d.timesSeen,
      hfSeen: (d.hfSeen || 0) + 1
    };
    save();
  }

  // ── Spaced repetition selection ────────────────────────

  function countMastered() {
    var n = 0;
    for (var i = 0; i < PHRASES.length; i++) {
      if (getPhraseData(PHRASES[i].id).level === 4) n++;
    }
    return n;
  }

  function selectNext() {
    var now = Date.now();
    var eligible = [];
    var weights = [];

    for (var i = 0; i < PHRASES.length; i++) {
      var p = PHRASES[i];
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
      for (var i = 0; i < PHRASES.length; i++) {
        var p = PHRASES[i];
        var d = getPhraseData(p.id);
        if (d.level === 4) continue;
        if (p.id === lastShownId && countMastered() < PHRASES.length - 1) continue;
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
  }

  function showSummary() {
    $('summary-seen').textContent = sessionSeen;
    $('summary-new').textContent = sessionNew;
    var mastered = countMastered();
    $('summary-mastered').textContent = mastered + ' / ' + PHRASES.length;
    $('summary-progress').style.width = Math.round((mastered / PHRASES.length) * 100) + '%';

    hide($('rating-buttons'));
    hide($('translation-reveal'));
    show($('summary-card'));
  }

  function advance() {
    var next = selectNext();
    if (!next) {
      showComplete();
      return;
    }
    lastShownId = next.id;
    showScreen('screen-phrase');
    renderPhrase(next);
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
    var hard = [];
    var unseen = [];

    for (var i = 0; i < PHRASES.length; i++) {
      var p = PHRASES[i];
      var d = getPhraseData(p.id);
      var entry = { phrase: p, data: d };
      switch (d.level) {
        case 4: mastered.push(entry); break;
        case 3: familiar.push(entry); break;
        case 2: learning.push(entry); break;
        case 1: hard.push(entry); break;
        default: unseen.push(entry); break;
      }
    }

    var masteredCount = mastered.length;
    var pct = Math.round((masteredCount / PHRASES.length) * 100);
    $('progress-overview-text').textContent = masteredCount + ' / ' + PHRASES.length + ' maîtrisées (' + pct + ' %)';
    $('progress-bar-fill').style.width = pct + '%';

    var totalReviews = 0;
    var totalHf = 0;
    var phrasesSeen = 0;
    for (var i = 0; i < PHRASES.length; i++) {
      var d = getPhraseData(PHRASES[i].id);
      totalReviews += d.timesSeen;
      totalHf += (d.hfSeen || 0);
      if (d.timesSeen > 0) phrasesSeen++;
    }
    $('progress-stats-text').textContent =
      totalReviews + ' révisions · ' + phrasesSeen + ' / ' + PHRASES.length + ' expressions vues' +
      (totalHf > 0 ? ' · ◆' + totalHf + ' Mains Libres' : '');

    var list = $('progress-list');
    list.innerHTML = '';

    var groups = [
      { title: 'Maîtrisées', cls: 'mastered', items: mastered },
      { title: 'Familières', cls: 'familiar', items: familiar },
      { title: 'En apprentissage', cls: 'learning', items: learning },
      { title: 'Difficiles', cls: 'new', items: hard },
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
    for (var i = 0; i < PHRASES.length; i++) {
      if (getPhraseData(PHRASES[i].id).level === 4) result.push(PHRASES[i]);
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

  function updateHomeScreen() {
    var mastered = getMasteredPhrases();
    var count = mastered.length;
    $('acquis-count').textContent = '(' + count + ')';
    $('btn-acquis').disabled = count === 0;
    $('handsfree-count').textContent = '(' + count + ')';
    $('btn-handsfree').disabled = count === 0;
  }

  function startAcquis() {
    acquisPhrases = shuffle(getMasteredPhrases());
    acquisIndex = 0;
    if (acquisPhrases.length === 0) return;
    showAcquisPhrase();
  }

  function showAcquisPhrase() {
    if (acquisIndex >= acquisPhrases.length) {
      showScreen('screen-acquis-done');
      return;
    }
    var p = acquisPhrases[acquisIndex];
    showScreen('screen-acquis');
    $('acquis-context').textContent = p.context;
    $('acquis-english').textContent = p.en;
    $('acquis-french').textContent = p.fr;
    $('acquis-alt').textContent = p.alt_usage || '';
    $('acquis-counter').textContent = (acquisIndex + 1) + ' / ' + acquisPhrases.length;
    show($('acquis-reveal-area'));
    hide($('acquis-revealed'));
  }

  function revealAcquis() {
    hide($('acquis-reveal-area'));
    show($('acquis-revealed'));
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
      }).catch(function () {});
    }
  }

  function releaseWakeLock() {
    if (wakeLock) {
      wakeLock.release().catch(function () {});
      wakeLock = null;
    }
  }

  function stopHandsfree() {
    handsfreeActive = false;
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    if (handsfreeTimerId) { clearTimeout(handsfreeTimerId); handsfreeTimerId = null; }
    if (handsfreeCountdownId) { clearInterval(handsfreeCountdownId); handsfreeCountdownId = null; }
    releaseWakeLock();
    updateHomeScreen();
    showScreen('screen-home');
  }

  function startHandsfree() {
    handsfreePhrases = shuffle(getMasteredPhrases());
    handsfreeIndex = 0;
    handsfreeExercise = 'main';
    if (handsfreePhrases.length === 0) return;
    initAudio(); // create AudioContext on user gesture (tap)
    handsfreeActive = true;
    requestWakeLock();
    showScreen('screen-handsfree');
    handsfreeStep();
  }

  function handsfreeStep() {
    if (!handsfreeActive) return;
    if (handsfreeIndex >= handsfreePhrases.length) {
      handsfreeActive = false;
      releaseWakeLock();
      showScreen('screen-acquis-done');
      return;
    }
    var p = handsfreePhrases[handsfreeIndex];
    $('handsfree-counter').textContent = (handsfreeIndex + 1) + ' / ' + handsfreePhrases.length;

    // Determine which exercise: main phrase or alt_usage
    var englishText, frenchText;
    if (handsfreeExercise === 'main') {
      englishText = p.en;
      frenchText = p.fr;
    } else {
      englishText = p.alt_usage_en || p.alt_usage || '';
      frenchText = p.alt_usage || '';
    }

    // Phase 1: EN beep → show English → speak English
    $('handsfree-phase').textContent = 'Écoutez en anglais…';
    $('handsfree-english').textContent = englishText;
    show($('handsfree-english-card'));
    hide($('handsfree-countdown'));
    hide($('handsfree-french-area'));

    playDing('en', function () {
      if (!handsfreeActive) return;
      speakEnglish(englishText, function () {
        if (!handsfreeActive) return;

        // Phase 2: 9-second countdown
        $('handsfree-phase').textContent = 'Rappelez-vous…';
        show($('handsfree-countdown'));
        var remaining = 9;
        $('handsfree-countdown-num').textContent = remaining;

        handsfreeCountdownId = setInterval(function () {
          if (!handsfreeActive) { clearInterval(handsfreeCountdownId); return; }
          remaining--;
          $('handsfree-countdown-num').textContent = remaining;
          if (remaining <= 0) {
            clearInterval(handsfreeCountdownId);
            handsfreeCountdownId = null;
            hide($('handsfree-countdown'));

            // Phase 3: FR beep → reveal French → speak French (1st)
            playDing('fr', function () {
              if (!handsfreeActive) return;
              $('handsfree-phase').textContent = 'Réponse';
              $('handsfree-french').textContent = frenchText;
              show($('handsfree-french-area'));
              incrementHfSeen(p.id);

              speakFrenchCb(frenchText, function () {
                if (!handsfreeActive) return;

                // Phase 4: 6.5s pause → FR beep → speak French (2nd)
                handsfreeTimerId = setTimeout(function () {
                  if (!handsfreeActive) return;
                  playDing('fr', function () {
                    if (!handsfreeActive) return;
                    speakFrenchCb(frenchText, function () {
                      if (!handsfreeActive) return;

                      // Phase 5: 6.5s pause → FR beep → speak French (3rd)
                      handsfreeTimerId = setTimeout(function () {
                        if (!handsfreeActive) return;
                        playDing('fr', function () {
                          if (!handsfreeActive) return;
                          speakFrenchCb(frenchText, function () {
                            if (!handsfreeActive) return;

                            // Phase 6: 7s pause → advance
                            handsfreeTimerId = setTimeout(function () {
                              if (handsfreeExercise === 'main' && p.alt_usage) {
                                handsfreeExercise = 'alt';
                              } else {
                                handsfreeExercise = 'main';
                                handsfreeIndex++;
                              }
                              handsfreeStep();
                            }, 7000);
                          });
                        });
                      }, 6500);
                    });
                  });
                }, 6500);
              });
            });
          }
        }, 1000);
      });
    });
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

    // Apprentissage back to home
    $('btn-phrase-home').addEventListener('click', function () {
      updateHomeScreen();
      showScreen('screen-home');
    });

    // Handsfree stop
    $('btn-handsfree-home').addEventListener('click', function () {
      stopHandsfree();
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

    $('btn-acquis-home').addEventListener('click', function () {
      updateHomeScreen();
      showScreen('screen-home');
    });

    $('btn-acquis-done-home').addEventListener('click', function () {
      releaseWakeLock();
      updateHomeScreen();
      showScreen('screen-home');
    });

    // Rating buttons
    var ratingBtns = document.querySelectorAll('.rating-btn');
    for (var i = 0; i < ratingBtns.length; i++) {
      ratingBtns[i].addEventListener('click', function () {
        if (this.disabled) return;
        var level = parseInt(this.getAttribute('data-level'), 10);
        handleRating(level);
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
    $('btn-progress').addEventListener('click', function () {
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

  function handleRating(level) {
    if (!currentPhrase) return;

    // disable buttons
    var btns = document.querySelectorAll('.rating-btn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].disabled = true;
      if (parseInt(btns[i].getAttribute('data-level'), 10) !== level) {
        btns[i].style.opacity = '0.35';
      }
    }

    var wasNew = setPhraseData(currentPhrase.id, level);
    sessionSeen++;
    if (wasNew) sessionNew++;

    // check if summary time
    if (sessionSeen > 0 && sessionSeen % SUMMARY_INTERVAL === 0) {
      setTimeout(function () {
        revealTranslation();
        setTimeout(function () { showSummary(); }, 1200);
      }, 300);
    } else {
      setTimeout(function () { revealTranslation(); }, 300);
    }
  }

  // ── Init ──────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', setup);
})();
