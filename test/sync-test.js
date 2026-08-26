// Tests for the cross-device merge (which copy of the state wins).
//
//   node test/sync-test.js
//
// Pulls isNewer / mergeSettings / pickFreshest straight out of app.js and runs
// them against synthetic device states, so there is no copy of the logic here to
// drift. Nothing touches the real Firebase.
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

var code = ['isNewer', 'mergeSettings', 'pickFreshest'].map(extract).join('\n\n');
function defaults() { return { version: 1, sessionCount: 0, updatedAt: 0, settingsAt: 0 }; }
var api = eval('(function () {' + code +
  '\nreturn {isNewer:isNewer, mergeSettings:mergeSettings, pickFreshest:pickFreshest};})()');

var failures = [];
function check(label, cond, detail) {
  if (!cond) failures.push(label + (detail ? ' — ' + detail : ''));
}
function dev(o) {
  return Object.assign({ version: 1, sessionCount: 0, updatedAt: 0, settingsAt: 0 }, o);
}

// ── the bug that prompted this ─────────────────────────
// PC works to apCursor 30 and saves. Phone then opens holding stale data but a
// higher sessionCount — under the old rule the phone won and overwrote the PC.
var pc    = dev({ sessionCount: 640, updatedAt: 5000, apCursor: 30 });
var phone = dev({ sessionCount: 645, updatedAt: 1000, apCursor: 0  });
check('newer cloud beats a higher sessionCount',
      api.pickFreshest(phone, pc).apCursor === 30,
      'phone kept its stale position');

// ── ordinary cases ─────────────────────────────────────
check('local wins when it is genuinely newer',
      api.pickFreshest(dev({ updatedAt: 9000, apCursor: 7 }), dev({ updatedAt: 8000, apCursor: 2 })).apCursor === 7);
check('cloud wins when it is newer',
      api.pickFreshest(dev({ updatedAt: 8000, apCursor: 7 }), dev({ updatedAt: 9000, apCursor: 2 })).apCursor === 2);
check('ties go to the cloud',
      api.pickFreshest(dev({ updatedAt: 9000, apCursor: 7 }), dev({ updatedAt: 9000, apCursor: 2 })).apCursor === 2);
check('no cloud yet → keep local',
      api.pickFreshest(dev({ apCursor: 5 }), null).apCursor === 5);
check('no local yet → take cloud',
      api.pickFreshest(null, dev({ apCursor: 5 })).apCursor === 5);
check('cloud without a version is ignored',
      api.pickFreshest(dev({ apCursor: 5 }), { apCursor: 99 }).apCursor === 5);

// ── migration: states written before updatedAt existed ──
check('falls back to sessionCount when neither has a stamp',
      api.pickFreshest(dev({ sessionCount: 10, apCursor: 7 }), dev({ sessionCount: 5, apCursor: 2 })).apCursor === 7);
check('any stamp beats no stamp',
      api.pickFreshest(dev({ sessionCount: 1, updatedAt: 100, apCursor: 7 }),
                       dev({ sessionCount: 999, apCursor: 2 })).apCursor === 7);

// ── every position travels together ────────────────────
var rich = dev({ updatedAt: 9000, apCursor: 30, hfCursor: 12, acqCursor: 4, ecCursor: 6, rvCursor: 8, hfBase: 46 });
var won  = api.pickFreshest(dev({ updatedAt: 1000 }), rich);
check('all section positions survive the merge',
      won.apCursor === 30 && won.hfCursor === 12 && won.acqCursor === 4 &&
      won.ecCursor === 6 && won.rvCursor === 8 && won.hfBase === 46);

// ── settings are merged on their own stamp ─────────────
var progressNewer = dev({ updatedAt: 9000, acquisAutoPlay: false, settingsAt: 100 });
var settingNewer  = dev({ updatedAt: 1000, acquisAutoPlay: true,  settingsAt: 900 });
check('a newer toggle survives an older device winning on progress',
      api.pickFreshest(settingNewer, progressNewer).acquisAutoPlay === true,
      'the toggle was reverted by the other device');
check('and the progress still comes from the newer copy',
      api.pickFreshest(settingNewer, progressNewer).updatedAt === 9000);
check('older settings do not overwrite newer ones',
      api.pickFreshest(dev({ updatedAt: 1000, acquisAutoPlay: false, settingsAt: 10 }),
                       dev({ updatedAt: 9000, acquisAutoPlay: true, settingsAt: 900 })).acquisAutoPlay === true);

console.log('');
if (failures.length === 0) console.log('ALL CHECKS PASSED');
else { console.log('FAILURES:'); failures.forEach(function (f) { console.log('  ✗ ' + f); }); process.exit(1); }
