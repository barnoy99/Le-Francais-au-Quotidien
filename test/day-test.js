// Tests for the per-day exposure counter behind the home subtitle and the
// Progrès chart.
//
//   node test/day-test.js
//
// Pulls the real functions out of app.js, so there is no second copy of the
// logic here to drift away from the app. What is actually being guarded:
// distinctness (a sentence counts once a day however often it is shown), the
// lazy midnight rollover (the phone is asleep at midnight, so the day is closed
// on the next look), and the difference between "no record" and "a real zero".
var fs = require('fs');
var path = require('path');
var SRC = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

function extract(name) {
  var start = SRC.indexOf('function ' + name + '(');
  if (start === -1) throw new Error('not found: ' + name);
  var i = SRC.indexOf('{', start), depth = 0;
  for (var j = i; j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}') { depth--; if (depth === 0) return SRC.slice(start, j + 1); }
  }
  throw new Error('unbalanced: ' + name);
}

var NAMES = ['dayStamp', 'dayStampShift', 'countKeys', 'rollDay', 'dayKey',
             'markDaySeen', 'daySnapshot'];
var DAY_HISTORY = parseInt(/var DAY_HISTORY = (\d+)/.exec(SRC)[1], 10);

var state, saves;
var api = eval(
  '(function () {' +
  '  var DAY_HISTORY = ' + DAY_HISTORY + ';' +
  '  function save() { saves++; }' +
  NAMES.map(extract).join('\n') +
  '  return {' + NAMES.map(function (n) { return n + ': ' + n; }).join(', ') + '};' +
  '})()');

function reset(over) {
  state = { dayDate: '', dayFirst: '', daySeen: {}, dayHistory: {} };
  for (var k in (over || {})) state[k] = over[k];
  saves = 0;
}

var failures = [];
function check(label, cond, detail) {
  if (!cond) failures.push(label + (detail ? ' — ' + detail : ''));
}

var today = api.dayStampShift(0);
var yesterday = api.dayStampShift(-1);

// ── the key packing ────────────────────────────────────
check('main and alt of one phrase are different keys',
      api.dayKey(12, 'main') !== api.dayKey(12, 'alt'));
check('no key collides with a neighbouring id',
      api.dayKey(12, 'alt') !== api.dayKey(13, 'main'),
      'ids 12 and 13 shared a slot');

// ── distinctness ───────────────────────────────────────
reset();
api.markDaySeen(12, 'main');
api.markDaySeen(12, 'main');   // ⏮ back, or a second copy in the same round
api.markDaySeen(12, 'main');
check('a sentence shown three times counts once',
      api.daySnapshot().today === 1, 'counted ' + api.daySnapshot().today);
api.markDaySeen(12, 'alt');
check('the alt is its own sentence', api.daySnapshot().today === 2);
var before = saves;
api.markDaySeen(12, 'alt');
check('a repeat writes nothing', saves === before, 'it saved again');

// ── the first day ──────────────────────────────────────
reset();
api.markDaySeen(1, 'main');
check('the first mark stamps the day the counter started',
      state.dayFirst === today, 'dayFirst = ' + state.dayFirst);
check('before the counter existed, yesterday has no number',
      api.daySnapshot().yesterday === null, 'got ' + api.daySnapshot().yesterday);

// ── the rollover ───────────────────────────────────────
// Yesterday's session, looked at today: the day must close itself.
reset({ dayDate: yesterday, dayFirst: api.dayStampShift(-3),
        daySeen: { 2: 1, 3: 1, 4: 1, 5: 1, 6: 1 } });
var snap = api.daySnapshot();
check('yesterday is closed into the history at the first look today',
      snap.yesterday === 5, 'got ' + snap.yesterday);
check('today starts empty', snap.today === 0);
check('the date moves on', state.dayDate === today);
check('closing the day is saved', saves > 0);

// A day simply not practised is a zero, not a blank.
reset({ dayDate: api.dayStampShift(-4), dayFirst: api.dayStampShift(-9),
        daySeen: { 2: 1 } });
check('a skipped day reads as a real zero',
      api.daySnapshot().yesterday === 0, 'got ' + api.daySnapshot().yesterday);

// Marking a sentence after midnight rolls the day too — the app can be left
// open across the boundary.
reset({ dayDate: yesterday, dayFirst: yesterday, daySeen: { 2: 1, 3: 1 } });
api.markDaySeen(9, 'main');
check('marking after midnight closes yesterday first',
      state.dayHistory[yesterday] === 2 && api.daySnapshot().today === 1,
      JSON.stringify(state.dayHistory) + ' today=' + api.daySnapshot().today);

// ── the history window ─────────────────────────────────
var wide = {};
for (var n = 1; n <= 25; n++) wide[api.dayStampShift(-n)] = n;
reset({ dayDate: yesterday, dayFirst: api.dayStampShift(-25),
        daySeen: {}, dayHistory: wide });
api.daySnapshot();
var kept = Object.keys(state.dayHistory).sort();
check('the history is trimmed to its window',
      kept.length === DAY_HISTORY, 'kept ' + kept.length);
check('it keeps the newest days, not the oldest',
      kept[kept.length - 1] === yesterday && kept[0] === api.dayStampShift(-DAY_HISTORY),
      kept[0] + ' … ' + kept[kept.length - 1]);

var days = api.daySnapshot().days;
check('the chart never shows more days than the window',
      days.length <= DAY_HISTORY, 'got ' + days.length);
check('the chart ends on today, flagged as in progress',
      days[days.length - 1].stamp === today && days[days.length - 1].today === true);
check('only the last day is flagged as today',
      days.filter(function (d) { return d.today; }).length === 1);

// A young counter shows only the days it has actually seen.
reset({ dayDate: yesterday, dayFirst: api.dayStampShift(-2),
        daySeen: { 2: 1 },
        dayHistory: { } });
var young = api.daySnapshot().days;
check('a counter three days old draws three bars, not fourteen',
      young.length === 3, 'got ' + young.length);
check('the days run oldest to newest',
      young[0].stamp < young[young.length - 1].stamp);

if (failures.length) {
  console.log('FAIL (' + failures.length + ')');
  failures.forEach(function (f) { console.log('  ✗ ' + f); });
  process.exit(1);
}
console.log('day-test: all checks passed');
