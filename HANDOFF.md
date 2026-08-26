# Handoff — Le Français au Quotidien

Everything a fresh session needs. Read this plus `CLAUDE.md` before touching
anything — and `CORPUS.md` before touching `data.js`, for what the phrases are
for and how the user judges them.

---

## 1. What this is

A French phrase-learning PWA for one user (a tutor learning French). Plain
HTML/CSS/JS, no build step, no framework.

- **Code:** `C:\Users\User\Documents\Claude Code\Le-Francais-au-Quotidien`
- **Files:** `index.html`, `app.js` (one IIFE), `data.js` (content), `style.css`,
  `sw.js` (offline), `manifest.json`, `firebase-config.js`, icons
- **Live at:** https://barnoy99.github.io/Le-Francais-au-Quotidien/ — served from
  the `master` branch of `github.com/barnoy99/Le-Francais-au-Quotidien`
- **Firebase = progress sync only, NOT hosting**

### Deploying (mandatory)

A change reaches the user only after `git commit` + `git push origin master`,
then the user hard-refreshes. On **every** asset change:

1. bump that file's `?v=N` in `index.html`
2. update the same URL in the `SHELL` array in `sw.js`
3. bump `CACHE_VERSION` in `sw.js`

Skip any of these and devices keep serving stale files from the service worker.

**Current versions:** `app.js?v=67`, `style.css?v=52`, `data.js?v=29`,
`firebase-config.js?v=3`, `CACHE_VERSION = 'v50'`.

**Pages can silently fail.** A deploy once returned a 503 from GitHub's Pages
API; the build then sat reporting `status: building` forever while the site kept
serving the previous version. `gh run list` showed the real state (`failure`).
`gh api --method POST repos/<repo>/pages/builds` re-deploys the same commit
without adding a no-op commit. Always confirm the live URL actually serves the
new `?v=N` — pushed is not deployed.

### Tests

```
node test/queue-test.js     # the ⚑ flagged passes
node test/sync-test.js      # which device's state wins a cross-device merge
```

Covers the ⚑ flagged-pass queue (`fq*` in `app.js`) for both prefixes: a pass
covers every sentence once, main and alt are kept apart, quitting resumes on the
sentence you were on, flagging mid-pass splices into what's left, un-flagging
drops it, the two passes don't touch each other. It extracts the real functions
from `app.js` rather than copying them, so it fails loudly if one is renamed.
Run them after touching anything in the rotation, the ⚑ passes, or `load`/`save`.

**Always `git pull` first** — the user also runs Claude Code sessions from their
phone against this repo and merges PRs, so master moves independently. Phrase-id
collisions have happened; check the max id after pulling.

---

## 2. The four modes

| Mode | What it is |
|---|---|
| **Apprentissage** | Walks a persistent shuffled **set** of every unmastered phrase — each exactly once, order fixed until the set is finished, then a fresh shuffle. No longer spaced repetition. Three inline choices: **Plus tard** (pure navigation — writes nothing), **×6 — Mes Acquis** (the only rating left; there is no ×3 and no *Pas encore*) and **Supprimer**. Only buttons carrying `data-level` reach `handleRating` — the other two share `.rating-btn` for styling only. Tapping the French card reveals the English and commits nothing, so you can read it and then choose; choosing goes straight to the next phrase. **⏮ / ⏭ walk the set itself**, so ⏮ reaches cards served on an earlier visit or another device. No sticky bottom bar on this screen. |
| **Mes Acquis** | Recall practice over mastered phrases. English prompt → **Révéler** → French + alt + TTS. Keyboard: ← prev, → next, space reveals. |
| **Mains Libres** | Hands-free audio drill of the mastered pool. Wake-lock, TTS. |
| **Chercher** | Search all phrases; move between pools (→ Acquis ×3 / ×6 / Apprentissage), toggle **Difficile**, delete. |

Plus **Progrès** (overlay with per-level groups) and two filtered entry points,
**⚑ Écouter (N)** and **⚑ Réviser (N)**, described below.

### Mains Libres timing (per exercise)

Beep → speak English → **one continuous 11s countdown** (caption switches from
"Écoutez en anglais…" to "Rappelez-vous…" at 9) → then N French readings, each
preceded by a beep, with **8s** gaps ("Encore…") → **8s** "Suivant…" → next.

N = **6 if the phrase is ×6, else 3**. Difficulty does *not* change N (user's
explicit choice). Each phrase plays as two exercises: main sentence, then alt.
**⚑ Écouter is different on both counts** — see §5a.

Pause freezes a countdown and resumes it; pausing mid-sentence re-reads that
sentence from the start on resume (mobile speech engines can't resume reliably).
⏮ restarts the current sentence; a second press within 3s goes to the previous.

---

## 3. Data model

`data.js`: `var PHRASES = [ { id, fr, en, context, alt_usage, alt_usage_en }, … ]`

**Every entry must have both a main sentence and an alt** — "add a sentence"
always means main + alt. Ids are integers, append after the current max, never
renumber (gaps are fine; ~34 ids were deliberately deleted).

Progress lives in one object: localStorage key `frenchSR_state`, mirrored to
Firebase Realtime DB at `progress/user1`.

```
state = {
  version, sessionCount, deletedIds: [ids],
  phrases: { id: { level, lastSeen, timesSeen, hfSeen,
                   boost, hardManual, hardScore, misses } },
  acqCycle: [ids], acqCursor, acqPass: {id:count}, acqSig, acqLast,
  hfCycle:  [ids], hfCursor,  hfPass:  {id:count}, hfSig,  hfLast, hfBase,
  ecCycle: ["id:main"|"id:alt"], ecCursor,       // ⚑ Écouter pass, §5a
  rvCycle: ["id:main"|"id:alt"], rvCursor,       // ⚑ Réviser pass, §5a
  apCycle: ["id:main"], apCursor,                // Apprentissage set, §4
  acquisAutoPlay: bool,                          // "auto" toggle, §5b
  updatedAt, settingsAt                          // merge stamps, §7.4
}
```

- `level === 4` = mastered → feeds **both** Mes Acquis and Mains Libres.
  Anything lower is in the Apprentissage rotation.
- `boost` = the ×6 flag. `hardManual` = the ⚑ difficulty flag.
  `isHard()` also honours a legacy `hardScore >= 2`; `hardScore`/`misses` are
  vestigial (an auto-scoring experiment that was removed).
- **All phrase writes must go through `writePhrase(id, changes)`** — it merges,
  so no field gets silently dropped. Don't rebuild the record inline.

---

## 4. Rotation ("playlist") — the subtle part

Sessions used to reshuffle the whole pool every time, which gave wildly uneven
coverage (simulated: some ×6 phrases heard 15×, others 2×, some never — the user
had 21 mastered phrases never played). Replaced with a persistent cycle:

- **Mes Acquis cycle:** every phrase exactly **once** per pass → no repeats.
- **Mains Libres cycle:** once per unit of weight — plain 1, ×6 or ⚑ 2, ×6+⚑ 4 —
  with copies placed by **even stride** around the cycle (closest repeat ~100
  cards, median ~200), so you never meet the same phrase twice in a sitting.
- The cycle persists across sessions via `*Cursor`. **Mes Acquis** pre-fetches a
  batch of `SESSION_BATCH = 60` and hands back whatever it didn't reach on exit
  (`releaseBatch`). That hand-back is best effort: if the app is force-closed the
  exit path never runs and the pre-fetched remainder is skipped for that round —
  which is exactly why Mains Libres stopped batching (next bullet).
- **Mains Libres pulls one phrase at a time** (like the ⚑ passes) and no longer
  pre-fetches a batch. That is what makes its counter exact: nothing is consumed
  until it is played, so quitting can't skip a phrase. Mes Acquis still batches
  and still uses `releaseBatch`.
- **Apprentissage uses the same `fq*` queue as the ⚑ passes**, prefix `'ap'`,
  state `apCycle`/`apCursor`. One key per unmastered phrase (`id:main` — the alt
  is never shown on that screen), so a set is every phrase once. `fqEligibleKeys`
  and `fqPlayable` take the prefix: `'ap'` means *not* mastered, `'ec'`/`'rv'`
  mean flagged *and* mastered.
  This replaced weighted-random selection (`WEIGHTS`, `INTERVALS`, `weightedPick`
  — all now deleted), which had no order and drew with replacement, so a phrase
  rated *Pas encore* (weight 4, 2-minute cooldown) could reappear several times
  in one sitting. The counter is the position through the set in sentences,
  `currentPassPos * 2` over `apCycle.length * 2`, climbing 2 per card.
  Leaving the screen calls `releaseCurrentCard()` to hand the un-rated card
  back, so quitting mid-card cannot silently skip a phrase — but only when you
  are on the newest card, since a card you browsed back to was never yours to
  hand back.
- **Apprentissage navigates the set, not a session history.** `phraseAt(pos)`
  reads `apCycle` and `seekPlayable(pos, step, limit)` walks it in either
  direction, skipping positions whose phrase has since been mastered or deleted.
  There is no in-memory `phraseHistory` any more, which is what makes ⏮ work on
  a fresh visit: the cards behind the cursor persist and sync. Entering the
  screen sets `currentPassPos = apCursor` so the first ⏭ serves a *new* card
  rather than replaying position 1; ⏭ only takes a new item once you have caught
  up with the cursor.
- **Apprentissage has no fixed bottom bar.** `#screen-phrase .phrase-content`
  therefore has only 1rem of bottom padding — the 5.5rem that used to clear the
  bar made the page scroll, which this app never does. `showSummary()` was dead
  code (never called) and referenced the removed `btn-next`; it is gone, though
  the hidden `#summary-card` markup remains unused.
- **Every user-facing count is in sentences, not phrases** (`sentenceCount()`),
  because each entry is a main sentence plus an alt. Home buttons read
  `sentences / all sentences in the app`, e.g. `(442 / 874)` — which is also
  where the app-wide total is surfaced, since the home screen has no vertical
  room for another line. **Apprentissage is the exception**: both its home
  button and its own header show position through the current *set*, so the two
  numbers agree. Home shows the position you will resume on —
  `min(apCursor + 1, apCycle.length) * 2` — because leaving hands the un-rated
  card back and leaves the cursor one behind the card you were looking at.
  Before any set exists it previews `0 / <pool sentences>`. Mes Acquis shows
  `passProgress * 2` over mastered sentences.
- **The Mains Libres counter is a sentence position through the round**:
  `slot * 2 + (main ? 1 : 2)` over `roundSentenceTotal()`, e.g. `137 / 762`.
  Each slot is two sentences (main, alt), and a ×6/⚑ phrase holds several slots
  per round, so its sentences are counted again each time they come round.
  The denominator is `(hfBase + hfCycle.length) * 2` — taken from the round
  actually queued, **not** recomputed from current weights, which drift the
  moment you toggle ×6 mid-round and would let the position read past the total.
- `hfBase` = slots of this round served before the current `hfCycle` was laid
  out. A rebuild re-lays only what is still owed and resets the cursor, so
  without this the counter would restart mid-round. Set to `passPlayed(key)` on
  a rebuild, 0 when a round is laid out in full.
- **Pass progress** (`*Pass` map) = copies played this round. Mes Acquis' counter
  is still distinct-coverage (`passProgress / masteredCount`) and passes
  `poolSize` to `markPassSeen` so it wraps at full coverage; Mains Libres does
  not pass it, because clearing mid-round would let a rebuild re-queue copies
  already heard. A fresh pass avoids opening with the phrase just shown
  (`avoidEarlyRepeat`).
- Pool changes (mastering, deleting, toggling ×6/⚑) call `invalidateCycles()`;
  the rebuild covers **only what's still owed**, so progress isn't lost.
- **Both ⚑ modes bypass all of the above.** Écouter and Réviser each have their
  own persistent pass (`ecCycle`/`ecCursor`, `rvCycle`/`rvCursor`) and leave
  `hfCycle`/`hfPass` and `acqCycle`/`acqPass` completely alone — see §5a.

---

## 5. Difficulty (⚑)

A single on/off toggle, behaving like ×6, present in the bottom bar of **both**
Mes Acquis and Mains Libres (`btn-acquis-hard`, `btn-handsfree-hard`), plus a
**Difficile** toggle in Chercher. Amber when active, sage outline when off.

Effect: **doubles frequency only** (2 copies per Mains Libres cycle). It does not
change the number of readings.

Two home-screen links appear when the count > 0, hidden at 0:
- **⚑ Écouter (N)** → Mains Libres with only flagged phrases (see §5a)
- **⚑ Réviser (N)** → Mes Acquis recall with only flagged phrases (see §5a)

### 5a. The two ⚑ passes — persistent, and independent of each other

Neither filtered mode shares the rotation its parent mode uses. Both run on one
implementation, the `fq*` helpers, parameterised by a prefix:

| prefix | mode | state |
|---|---|---|
| `'ec'` | ⚑ Écouter (Mains Libres) | `ecCycle` / `ecCursor` |
| `'rv'` | ⚑ Réviser (Mes Acquis) | `rvCycle` / `rvCursor` |

They are **independent** — listening never consumes your reviewing. Shared rules:

- **Écouter reads every sentence 2×** (`ECOUTER_READS`), ×6 or not. Tapping ×6
  during an Écouter session records the flag for the main rotation but never
  changes the current sentence's reading count.
- **Main and alt are independent items**, shuffled apart from each other — not
  the "phrase = two exercises back-to-back" of the normal rotation. `fqSpread`
  shuffles, then pushes any two sentences of the same phrase at least
  `max(2, n/8)` slots apart (measured on live data: closest pair 5 of 32).
  In **Réviser** this also means one sentence per card: the "Autre exemple"
  block (`acquis-alt-block`) is hidden, since it would give the answer away.
- **The order persists**: the cycle is a list of `"id:main"` / `"id:alt"` keys
  and the cursor walks it across sessions. Quitting hands the
  interrupted sentence back (cursor − 1), so you resume on it rather than past
  it. Counter shows `cursor / total`, e.g. `4 / 32`.
- **The pass ends with a *Félicitations* screen** — `screen-ecouter-done` or
  `screen-reviser-done`. Écouter also speaks it, since the phone is probably in
  a pocket; Réviser doesn't. Either way the pass is cleared and the next session
  shuffles a brand-new order.
- **Flag changes reach a pass already in progress**: `syncFlagQueue(prefix)`
  (hung off `invalidateCycles`, which syncs both passes, so every toggle path
  hits it) splices newly flagged sentences into the part not yet reached and
  drops un-flagged ones. Items before
  the cursor keep their place, so nothing repeats and nothing loses its turn.
- Sentences are pulled from the queue **one at a time** — in `handsfreeStep`
  for Écouter, `showAcquisPhrase` for Réviser — which is what lets a mid-session
  flag be picked up without restarting. Each mode keeps `*Exercises` and
  `*Positions` arrays parallel to its phrase array, for these modes only.
- Regression risk: `showAcquisPhrase` and `handsfreeStep` now serve both the
  normal rotation and a ⚑ pass. Check plain Mes Acquis / Mains Libres still work
  after touching either. Both **clamp the index** to at most one past the array:
  they pull one item per step, and a stray advance after a pass closes would
  otherwise push to the end and leave the current index empty (a crash).
- **Every screen's counter is large** — accent red, upright, lining + tabular
  figures, via `handsfree-skip-row--large` on the row (set by `setCounterSize`,
  now called with `true` from all four screens). Nothing uses the small grey
  italic style any more. The row's gap drops 2.5rem → 1rem to pay for the width: at 375px
  "13 / 32" is 85px against the small counter's 29px, which otherwise shoves the
  row into Accueil. The gap rule needs the doubled class
  `.handsfree-skip-row.handsfree-skip-row--large` — the base rule is ~1000 lines
  further down style.css and wins at equal specificity.
- **Long values step down** via `--long`: 1.35rem and a 0.7rem gap. Mains Libres
  counts sentences ("137 / 762"), which at 1.7rem would crowd Accueil. The class
  is chosen from the widest value the round can reach (the total's digits × 2 + 1
  ≥ 7), **not** the current value, so the size doesn't change when the numerator
  passes 100. Measured at 375px: 94px wide, 43px clear of Accueil, and 19px clear
  even at a four-digit "1024 / 1180". Tabular figures keep the width fixed as the
  digits change.

### 5b. Lecture automatique (`auto`)

A gold pill on the **context line** of the Mes Acquis screen (so it serves both
plain Mes Acquis and ⚑ Réviser), persisted as `state.acquisAutoPlay`, off by
default. When armed, `revealAcquis` speaks the sentence: in ⚑ Réviser the single
sentence on the card; in the normal rotation the main sentence and then its alt,
chained off the first one's `onend` and abandoned if you advance or leave.
Tapping it while a card is already revealed plays immediately, so the toggle
proves itself without waiting for the next Révéler.

Placement was forced by measurement, not taste — see §6.

---

## 6. UI layout rules (hard-won; re-measure if you touch them)

The user cares a lot about **no scrolling** and **no mis-taps**. Verify at the
mobile preset (375×812).

- Every practice screen has the same **sticky bottom bar**: delete at the left,
  ×6 and ⚑ grouped next to it (`.toggle-group` in the middle column), and the
  frequently-tapped action (Suivant / Pause) at the right. Grid is
  `auto auto 1fr`, inset to the 540px content column.
- At 375px the usable width is **339px** and the content edge is **357px**. All
  three states — Acquis/Suivant, Mains Libres/Pause, Mains Libres/**Reprendre**
  (the widest) — currently end exactly at 357. Mes Acquis' Suivant is
  deliberately narrower than Apprentissage's because it carries four controls.
- **The Mes Acquis bar is full at four controls.** Adding a fifth (the `auto`
  pill) pushed Suivant to a right edge of **411px** on a 375px screen — clipped
  rather than scrolled, since the bar is `position: fixed`. Putting it in the
  French card instead cost that sentence a third of its width (225px → 152px,
  4 lines → 6). It lives on the context line, which costs **16px of height and
  nothing horizontally**: with a long phrase plus its alt, normal Mes Acquis
  still clears the bar by 100px, ⚑ Réviser by 282px, and neither scrolls.
- The home screen has **~5px of vertical slack** — a 5th full-size button
  overflows by 91px. That's why Écouter/Réviser/Progrès share one row as small
  text links (span 321px, all exactly 44px tall).
- Headers: home/Accueil at the left, ⏮ counter ⏭ pushed right. "Accueil" is used
  on every screen (was inconsistent once).
- Countdown ring: 80px, inner 74px. Digits are forced to **lining figures**
  (Cormorant Garamond defaults to old-style figures, which made 3/4/5/7/9 sit
  low). Two-digit values get a `.two-digit` class dropping the font to 2.4rem,
  plus `white-space: nowrap`, so 10/11/12 fit — important because the offline
  Georgia fallback is wider.

---

## 7. Gotchas that will bite you

1. **The local preview reads and writes the user's LIVE Firebase progress.**
   Prefer read-only checks (`getBoundingClientRect`, `getComputedStyle`, reading
   classes). If you must exercise a state-changing path, use **one scratch
   phrase**, capture its record first, and restore it afterwards — then say so.
2. **Editing localStorage does not change the app's in-memory `state`.** To make
   an edit stick: write localStorage, **bump `sessionCount`** (so the local copy
   wins the cloud merge), then reload.
3. **The service worker serves the cached shell.** In the preview, navigate to
   `http://localhost:8099/index.html?bust=<something-new>` to load fresh assets.
   If you edit CSS *after* bumping its version, bump again — the browser already
   cached that version.
4. **Sync merge is last-write-wins by `updatedAt`** (`pickFreshest` / `isNewer`).
   Every `save()` stamps `updatedAt`, so the device that wrote most recently
   wins; `sessionCount` is only the fallback for states written before the stamp
   existed. It used to compare `sessionCount` — a count of app *opens* on any
   device — which let a device holding stale data outrank the cloud and then push
   its copy over everything. That lost two flagged phrases, and later an
   Apprentissage position. **Settings merge separately** on `settingsAt`, so a
   progress save cannot silently revert a toggle made on the other device.
   If the cloud read fails, `cloudReadOk` stays false and the session writes
   **locally only** — the work still wins the merge on the next open that reaches
   the cloud, but it cannot clobber something newer in the meantime.
   The app reads the cloud **only at startup**: a tab left open on one device
   still holds its old state, so switching devices wants a reload, not a
   returning tab. (Deliberate — the user chose this over re-reading on focus.)
5. **Cloud state can differ from the file.** `state.phrases` may contain `null`
   entries and ids no longer in `data.js`; guard for both.
6. Run the app via `preview_start` with the `quotidien` launch config
   (`.claude/launch.json`, port 8099). Never start a server with Bash.

---

## 8. Current numbers (verified at handoff)

- **437** entries in `data.js` = **874** sentences (every entry has an alt).
  After the user's in-app deletions: **~379 active** = ~758 sentences.
- One round in Mains Libres is ~390 weighted slots ≈ 780 sentence-plays, about
  three weeks at the user's ~40/day pace.
- ~221 mastered, ~17 flagged ⚑, ~150 of the mastered ones ×6. These drift daily —
  re-count rather than trusting the figures. The live state can be read directly
  with a GET on the Realtime DB (read-only, nothing is written):
  `curl -s https://francais-quotidien-default-rtdb.firebaseio.com/progress/user1.json`
  Note Firebase returns `phrases` and `hfPass` as **arrays** (numeric keys), not
  objects — handle both shapes.

## 9. Content conventions

> Fuller treatment in **`CORPUS.md`** — the register split, the deletion
> criterion, and the two inferences about the user's taste that turned out wrong.


- Natural spoken French. Subjunctive conjunctions (`à moins que`, `avant que`,
  `sans que`, `de peur que`) are written **without** the *ne explétif*.
- `context` is a short English label shown above the card, and now also names the
  register — e.g. "Chores — casual", "Ordering — vous".
- **Three registers coexist deliberately** (ids tell you which): the older
  entries are careful `tu`; ids 334–413 are casual `tu` with the `ne` dropped
  (`t'as`, `y a`, `faut que`); ids 414–433 are polite `vous` with the full `ne`,
  for shops, transport and problems abroad. Drop the `ne`, but **never
  phonetically respell** (`chuis`, `j'sais`) — the TTS mangles it.
- **The user's deletion criterion is frequency in real spoken French** — not
  formality and not function. They keep formal phrases they'd actually say and
  delete casual ones they wouldn't. When in doubt, ask rather than infer; an
  earlier inference from their choices ("they dislike discourse management")
  was wrong and they corrected it.
- Themes covered: subjunctive triggers, `à peine`, `s'y prendre`, `là-dedans`,
  `tout à fait`, `carrément`, `n'empêche`, `il faut` in four tenses, concordance
  des temps, participial absolutes, conversation-driving questions, home & family
  life, hosting & rapport, `dont`/`lequel`/`se faire`/`si` + plus-que-parfait/
  reported speech, spoken connectors, travel `vous`, and a B2 domestic/parenting
  set (laundry, splitting the chores, the children's behaviour, bedtime, agreeing
  as a couple). Check `data.js` before adding — duplicates are easy.
- **The user speaks French to his wife, not to his children.** Sentences aimed at
  a child (*Range ta chambre*, *Mets tes chaussettes…*) are wrong for him; write
  *about* the kids, addressed to her. He has three, aged 5–10.
- UI text is French; code comments English.

## 10. Loose ends / possible next steps

- **Firebase security rules:** the DB started in Test Mode, whose rules expire
  after 30 days; the user was given scoped-open rules to publish. Verified since:
  a client read succeeds and cloud/local data match exactly, so access is *not*
  blocked. A client can't tell whether the rules are now permanent, so if sync
  ever stops this is still the first suspect (console → Realtime Database →
  Rules). Note Firebase strips `null` values, so the cloud holds fewer phrase
  records than localStorage — that's expected, not data loss.
- The **⚑ glyph** uses a system font stack so it resolves; if it looks wrong on
  the user's phone, swap it for `!` or a short word.
- `hardScore` / `misses` are dead fields — safe to remove if ever tidying.
- The user considered building a sibling app ("Les Chiffres", a French numbers
  trainer) — brief at `C:\Users\User\Documents\Claude Code\Les Chiffres\BRIEF.md`.

---

## 11. How the user likes to work

- Wants things **done**, not just proposed — but asks first on anything
  destructive or outward-facing (pushing to the public repo).
- Values honest reporting: when something can't be verified (screenshots failed
  repeatedly in one session), say so rather than implying it was checked.
- Appreciates concrete numbers (measured pixels, simulated exposure counts)
  over assurances.
- Frequently asks for phrase batches; sometimes asks "is this a good phrase?"
  first and wants a real opinion, including corrections to their French.
