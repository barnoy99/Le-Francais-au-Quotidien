// Tests for removing a deleted phrase from an in-flight session batch.
//
//   node test/delete-test.js
//
// Pulls dropAllCopies straight out of app.js, so there is no copy of the logic
// here to drift. The bug this guards: a session batch is laid out from a cycle
// that may be shorter than the batch (and the Mains Libres cycle deliberately
// repeats ×6/⚑ phrases), so one phrase can sit in the batch several times.
// Delete used to splice only the copy on screen, and the phrase came back later
// in the same session.
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
var dropAllCopies = eval('(function () {' + extract('dropAllCopies') +
                         '\nreturn dropAllCopies;})()');

var failures = [];
function check(label, cond, detail) {
  if (!cond) failures.push(label + (detail ? ' — ' + detail : ''));
}
function batch(ids) { return ids.map(function (id) { return { id: id }; }); }

// ── the bug itself ─────────────────────────────────────
// 14 phrases, batch of 56: four copies of everything.
var ids = [];
for (var pass = 0; pass < 4; pass++) for (var i = 1; i <= 14; i++) ids.push(i);
var phrases = batch(ids);
var idx = dropAllCopies(7, phrases, ids.indexOf(7), []);
check('every copy of the deleted phrase is gone',
      phrases.filter(function (p) { return p.id === 7; }).length === 0,
      'copies survived the delete');
check('nothing else was removed', phrases.length === 56 - 4);

// ── the index keeps pointing at the same place ─────────
var b = batch([1, 2, 3, 4, 5]);
check('index unchanged when all copies are after it',
      dropAllCopies(4, b, 1, []) === 1);
b = batch([9, 2, 9, 4, 5]);
check('index shifts back once per copy removed before it',
      dropAllCopies(9, b, 3, []) === 1, 'index drifted off its card');
b = batch([1, 2, 3]);
check('deleting the card you are on leaves the index on the next one',
      dropAllCopies(2, b, 1, []) === 1 && b[1].id === 3);
b = batch([1, 2, 3]);
check('deleting the last card runs the index past the end (batch extends)',
      dropAllCopies(3, b, 2, []) === 2 && b.length === 2,
      'a reset to 0 here replays the whole session');

// ── parallel arrays stay aligned ───────────────────────
var ph = batch([1, 5, 2, 5, 3]);
var ex = ['main', 'alt', 'main', 'main', 'alt'];
var pos = [1, 2, 3, 4, 5];
dropAllCopies(5, ph, 0, [ex, pos]);
check('parallel arrays shrink with the batch', ex.length === 3 && pos.length === 3);
check('parallel arrays keep their pairing',
      ph.map(function (p) { return p.id; }).join() === '1,2,3' &&
      ex.join() === 'main,main,alt' && pos.join() === '1,3,5',
      'exercise/position no longer match their phrase');

// ── empty parallels (normal mode leaves them unfilled) ──
var ph2 = batch([1, 2, 2]);
var empty = [];
check('an empty parallel array is left alone',
      dropAllCopies(2, ph2, 0, [empty]) === 0 && empty.length === 0 && ph2.length === 1);

// ── deleting something not in the batch ────────────────
var ph3 = batch([1, 2, 3]);
check('deleting an absent id changes nothing',
      dropAllCopies(99, ph3, 2, []) === 2 && ph3.length === 3);

console.log('');
if (failures.length === 0) console.log('ALL CHECKS PASSED');
else { console.log('FAILURES:'); failures.forEach(function (f) { console.log('  ✗ ' + f); }); process.exit(1); }
