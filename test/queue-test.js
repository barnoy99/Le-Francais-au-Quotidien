// Tests for the ⚑ flagged-pass queue (⚑ Écouter and ⚑ Réviser).
//
//   node test/queue-test.js
//
// It pulls the real fq* functions straight out of app.js and evals them against
// a simulated pool, so there is no copy of the logic here to drift out of date.
// If you rename one of the functions in NAMES below, this fails loudly — which
// is the point. It has caught two real bugs: a pass that re-served phrases after
// a mid-pass rebuild, and a counter that ran past its own total.
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

var NAMES = ['shuffleIds', 'fqKey', 'fqParse', 'fqEligibleKeys', 'fqPlayable',
             'fqTooClose', 'fqSpread', 'fqPair', 'fqIsPaired', 'fqCycleKey', 'fqCursorKey', 'fqBuildPass',
             'syncFlagQueue', 'fqTakeNext', 'fqResetPass', 'fqTexts',
             'startCycleClock', 'cycleDay'];
var code = NAMES.map(extract).join('\n\n');

// ── simulated world ────────────────────────────────────
var PHRASES = [], flagged = {}, state, saves = 0;
for (var i = 1; i <= 40; i++) {
  PHRASES.push({ id: i, fr: 'fr' + i, en: 'en' + i,
                 alt_usage: i === 7 ? '' : 'alt' + i });   // id 7 has no alt
}
function findPhraseById(id) {
  for (var i = 0; i < PHRASES.length; i++) if (PHRASES[i].id === id) return PHRASES[i];
  return null;
}
function getPhraseData(id) { return { level: 4 }; }
function isHard(id) { return !!flagged[id]; }
function getHardPhrases() { return PHRASES.filter(function (p) { return flagged[p.id]; }); }
// only reached on the 'ap' branch, which these tests do not exercise
function getLearningPhrases() { return []; }
function save() { saves++; }

var raw = eval('(function () {' + code + '\nreturn {fqTakeNext:fqTakeNext, syncFlagQueue:syncFlagQueue,' +
               ' fqResetPass:fqResetPass, fqParse:fqParse, fqEligibleKeys:fqEligibleKeys,' +
               ' fqBuildPass:fqBuildPass, fqTexts:fqTexts, cycleDay:cycleDay, fqIsPaired:fqIsPaired};})()');
// the suite below runs once per pass prefix ('ec' = Écouter, 'rv' = Réviser)
var PREFIX = 'ec';
var api = {
  ecTakeNext:       function () { return raw.fqTakeNext(PREFIX); },
  syncEcouterQueue: function () { return raw.syncFlagQueue(PREFIX); },
  ecResetPass:      function () { return raw.fqResetPass(PREFIX); },
  ecBuildPass:      function () { return raw.fqBuildPass(PREFIX); },
  ecParse:          raw.fqParse,
  ecEligibleKeys:   function () { return raw.fqEligibleKeys(PREFIX); },
  fqTexts:          raw.fqTexts
};

function reset(ids) {
  flagged = {}; ids.forEach(function (id) { flagged[id] = true; });
  state = { deletedIds: [], ecCycle: [], ecCursor: 0, rvCycle: [], rvCursor: 0, phrases: {} };
}
function ids(n) { var a = []; for (var i = 1; i <= n; i++) a.push(i); return a; }

var failures = [];
function runSuite(prefix) {
PREFIX = prefix;
function check(label, cond, detail) {
  if (!cond) failures.push('[' + PREFIX + '] ' + label + (detail ? ' — ' + detail : ''));
}

// ── 1. a full pass covers every sentence exactly once ──
reset(ids(16));
var seen = [], item;
while ((item = api.ecTakeNext())) seen.push(item.p.id + ':' + item.exercise);
check('pass length', seen.length === 31, 'got ' + seen.length + ' (16 phrases, id 7 has no alt → 31)');
check('no duplicates', new Set(seen).size === seen.length);
check('covers eligible', new Set(seen).size === api.ecEligibleKeys().length);
check('completes → null', item === null);

// ── 2. main/alt spacing over 300 builds ──
// Écouter spreads a phrase's two sentences apart; Réviser deliberately puts
// them next to each other (main first), so the rule differs by pass.
var minGapSeen = Infinity, adjacent = 0, pairs = 0, mainFirst = 0, wrongOrder = 0;
for (var t = 0; t < 300; t++) {
  reset(ids(16));
  api.ecBuildPass();
  var pos = {}, prevKey = {};
  state[PREFIX+'Cycle'].forEach(function (k, idx) {
    var it = api.ecParse(k);
    if (pos[it.id] !== undefined) {
      var gap = idx - pos[it.id];
      if (gap < minGapSeen) minGapSeen = gap;
      if (gap === 1) adjacent++;
      if (gap === 1) {
        pairs++;
        if (api.ecParse(prevKey[it.id]).exercise === 'main' && it.exercise === 'alt') mainFirst++;
        else wrongOrder++;
      }
    }
    pos[it.id] = idx; prevKey[it.id] = k;
  });
}
if (PREFIX === 'rv') {
  check('Réviser puts both sentences of a phrase side by side',
        pairs === 300 * 15, pairs + ' adjacent pairs (expected 4500: 15 phrases with an alt × 300 builds)');
  check('and the main comes first', wrongOrder === 0, wrongOrder + ' pairs in the wrong order');
  console.log('   Réviser: ' + mainFirst + ' main→alt pairs, none reversed');
} else {
  check('Écouter never puts main/alt adjacent', adjacent === 0,
        adjacent + ' adjacent pairs in 300 builds');
  console.log('   Écouter: smallest main→alt gap over 300 builds: ' + minGapSeen + ' slots');
}

// ── 3. resume across sessions (with the hand-back on exit) ──
reset(ids(16));
var firstRun = [];
for (var i = 0; i < 5; i++) firstRun.push(api.ecTakeNext());
var last = firstRun[firstRun.length - 1];
if (last.position === state[PREFIX+'Cursor']) state[PREFIX+'Cursor'] = last.position - 1;  // endHandsfreeSession
var resumed = api.ecTakeNext();
check('resume repeats the interrupted sentence',
      resumed.p.id === last.p.id && resumed.exercise === last.exercise);
var rest = [resumed];
while ((item = api.ecTakeNext())) rest.push(item);
var all = firstRun.slice(0, 4).concat(rest).map(function (x) { return x.p.id + ':' + x.exercise; });
check('resumed pass still covers everything once',
      all.length === 31 && new Set(all).size === 31, 'got ' + all.length + '/' + new Set(all).size);

// ── 4. flagging mid-pass joins the ongoing session ──
reset(ids(16));
var played = [];
for (var i = 0; i < 10; i++) { var x = api.ecTakeNext(); played.push(x.p.id + ':' + x.exercise); }
flagged[30] = true;                       // newly flagged, has an alt
api.syncEcouterQueue();
check('total grew by 2', state[PREFIX+'Cycle'].length === 33, 'got ' + state[PREFIX+'Cycle'].length);
var after = [];
while ((item = api.ecTakeNext())) after.push(item.p.id + ':' + item.exercise);
check('new phrase heard this session',
      after.filter(function (k) { return k.indexOf('30:') === 0; }).length === 2);
check('nothing replayed after sync', new Set(after).size === after.length);
check('sync did not replay the first 10', after.filter(function (k) {
  return played.indexOf(k) !== -1;
}).length === 0);
check('whole pass still adds up', played.length + after.length === 33,
      played.length + ' + ' + after.length);

// ── 5. un-flagging mid-pass drops it, played items stay put ──
reset(ids(16));
var before = [];
for (var i = 0; i < 8; i++) before.push(api.ecTakeNext());
var playedIds = before.map(function (x) { return x.p.id; });
// pick a phrase not yet played
var victim = null;
for (var i = 1; i <= 16; i++) if (playedIds.indexOf(i) === -1) { victim = i; break; }
delete flagged[victim];
api.syncEcouterQueue();
var tail = [];
while ((item = api.ecTakeNext())) tail.push(item.p.id + ':' + item.exercise);
check('un-flagged phrase never played',
      tail.filter(function (k) { return k.indexOf(victim + ':') === 0; }).length === 0,
      'victim ' + victim);
var beforeKeys = before.map(function (b) { return b.p.id + ':' + b.exercise; });
check('no repeat of already-played',
      tail.filter(function (k) { return beforeKeys.indexOf(k) !== -1; }).length === 0);

// ── 6. un-flagging something already played ──
reset(ids(16));
var head = [];
for (var i = 0; i < 6; i++) head.push(api.ecTakeNext());
var alreadyPlayed = head[0].p.id;
delete flagged[alreadyPlayed];
api.syncEcouterQueue();
var rest2 = [];
while ((item = api.ecTakeNext())) rest2.push(item.p.id);
check('played-then-unflagged is not replayed', rest2.indexOf(alreadyPlayed) === -1);

// ── 7. pass ends → next build is a fresh order ──
reset(ids(16));
while (api.ecTakeNext()) {}
api.ecResetPass();
check('pass cleared', state[PREFIX+'Cycle'].length === 0 && state[PREFIX+'Cursor'] === 0);
var order1 = [];
while ((item = api.ecTakeNext())) order1.push(item.p.id + ':' + item.exercise);
check('new pass covers everything again', order1.length === 31);

// ── 8. degenerate pools don't hang ──
reset([7]);            // one phrase, no alt → 1 item
var n = 0; while (api.ecTakeNext()) n++;
check('single sentence pool', n === 1, 'got ' + n);
reset([1]);            // one phrase with an alt → 2 items, gap impossible
n = 0; while (api.ecTakeNext()) n++;
check('single phrase pool', n === 2, 'got ' + n);
reset([]);             // nothing flagged
check('empty pool → null', api.ecTakeNext() === null);

// ── 9. deleted / un-mastered phrases are skipped at play time ──
reset(ids(16));
api.ecBuildPass();
state.deletedIds = [3];
var out = [];
while ((item = api.ecTakeNext())) out.push(item.p.id);
check('deleted phrase skipped', out.indexOf(3) === -1);

}
runSuite('ec');
runSuite('rv');

// ── 10. the two passes are independent ──
PREFIX = 'ec';
reset(ids(16));
var ecSeen = [];
for (var i = 0; i < 12; i++) { var e = api.ecTakeNext(); ecSeen.push(e.p.id + ':' + e.exercise); }
if (ecSeen.length !== 12 || state.ecCursor !== 12) failures.push('[both] Ecouter setup consumed the wrong count');
var ecCursorNow = state.ecCursor, ecLen = state.ecCycle.length;
PREFIX = 'rv';
var rvFirst = api.ecTakeNext();                     // start the Reviser pass
if (state.ecCursor !== ecCursorNow) failures.push('[both] Reviser moved the Ecouter cursor');
if (state.ecCycle.length !== ecLen) failures.push('[both] Reviser rebuilt the Ecouter pass');
if (state.rvCursor !== 1) failures.push('[both] Reviser cursor did not start at 1');
if (!rvFirst) failures.push('[both] Reviser pass produced nothing');
// and the reverse: finishing Reviser must not clear Ecouter
while (api.ecTakeNext()) {}
api.ecResetPass();
if (state.ecCycle.length !== ecLen) failures.push('[both] finishing Reviser cleared the Ecouter pass');
if (state.rvCycle.length !== 0) failures.push('[both] Reviser pass not cleared');

// ── 11. fqTexts picks the right sentence for each item ──
var ph = { id: 99, fr: 'FR-main', en: 'EN-main', alt_usage: 'FR-alt', alt_usage_en: 'EN-alt' };
var m = api.fqTexts(ph, 'main'), a = api.fqTexts(ph, 'alt');
if (m.en !== 'EN-main' || m.fr !== 'FR-main') failures.push('[texts] main sentence wrong');
if (a.en !== 'EN-alt'  || a.fr !== 'FR-alt')  failures.push('[texts] alt sentence wrong');
var noEn = api.fqTexts({ id:1, fr:'f', en:'e', alt_usage:'ALT' }, 'alt');
if (noEn.en !== 'ALT') failures.push('[texts] alt without alt_usage_en should fall back to the French');

// ── cycle clock ────────────────────────────────────────
function check(label, cond, detail) {          // runSuite's `check` is scoped to it
  if (!cond) failures.push('[clock] ' + label + (detail ? ' — ' + detail : ''));
}
// Laying out a pass must start its clock, and the day count is calendar-based:
// "Jour 2" arrives the next morning, not 24 hours later.
state = { ecCycle: [], ecCursor: 0 };
flagged = { 1: true, 2: true };
raw.fqBuildPass('ec');
check('laying out a pass starts its clock', !!state.ecStartedAt);
check('the day a cycle starts is Jour 1', raw.cycleDay('ec') === 1);

state.ecStartedAt = Date.now() - 36 * 3600 * 1000;   // 36h ago
var d = raw.cycleDay('ec');
check('a cycle started yesterday reads Jour 2 or 3, never 1',
      d === 2 || d === 3, 'got ' + d);

state.ecStartedAt = new Date().setHours(0, 0, 0, 0) - 9 * 86400000;
check('nine calendar days back reads Jour 10', raw.cycleDay('ec') === 10,
      'got ' + raw.cycleDay('ec'));

state.ecStartedAt = 0;
check('no clock yet reads 0, so the row shows nothing', raw.cycleDay('ec') === 0);

// ── an old scattered Réviser pass is repaired in place ──
if (PREFIX === 'rv') {
  reset(ids(10));
  raw.fqBuildPass('rv');
  var cyc = state.rvCycle;
  // scramble it the way fqSpread would have, and pretend 4 are already done
  state.rvCycle = cyc.slice().sort(function () { return Math.random() - 0.5; });
  state.rvCursor = 4;
  var servedBefore = state.rvCycle.slice(0, 4).join(',');
  raw.syncFlagQueue('rv');
  var served = state.rvCycle.slice(0, state.rvCursor).join(',');
  var tail = state.rvCycle.slice(state.rvCursor);
  check('the part already served is untouched', served === servedBefore,
        'served head changed: ' + served);
  check('what is still to come gets paired', raw.fqIsPaired(tail),
        'tail still scattered: ' + tail.join(' '));
  check('nothing is lost or duplicated in the repair',
        state.rvCycle.length === cyc.length &&
        state.rvCycle.slice().sort().join() === cyc.slice().sort().join());
  // and an already-paired pass is left exactly as it was
  raw.fqBuildPass('rv');
  var before = state.rvCycle.join(',');
  raw.syncFlagQueue('rv');
  check('an already-paired pass is not reshuffled', state.rvCycle.join(',') === before);
}

console.log('');
if (failures.length === 0) console.log('ALL CHECKS PASSED (' + saves + ' saves)');
else { console.log('FAILURES:'); failures.forEach(function (f) { console.log('  ✗ ' + f); }); }
