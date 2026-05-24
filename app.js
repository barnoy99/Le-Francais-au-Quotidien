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

  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        state = JSON.parse(raw);
        if (!state.version) state = defaults();
      } else {
        state = defaults();
      }
    } catch (e) {
      state = defaults();
    }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) { /* quota exceeded — silent */ }
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
      timesSeen: d.timesSeen + 1
    };
    save();
    return wasNew;
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

        item.appendChild(dot);
        item.appendChild(text);
        item.appendChild(seen);
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

  // ── Event binding ─────────────────────────────────────

  function setup() {
    load();
    state.sessionCount++;
    save();

    // Splash → start
    $('screen-splash').addEventListener('click', function () {
      advance();
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
      advance();
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
