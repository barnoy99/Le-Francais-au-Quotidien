# Handoff — Le Français au Quotidien

Everything a fresh session needs. Read this plus `CLAUDE.md` before touching anything.

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

**Current versions:** `app.js?v=59`, `style.css?v=50`, `data.js?v=27`,
`firebase-config.js?v=3`, `CACHE_VERSION = 'v39'`.

**Pages can silently fail.** A deploy once returned a 503 from GitHub's Pages
API; the build then sat reporting `status: building` forever while the site kept
serving the previous version. `gh run list` showed the real state (`failure`).
`gh api --method POST repos/<repo>/pages/builds` re-deploys the same commit
without adding a no-op commit. Always confirm the live URL actually serves the
new `?v=N` — pushed is not deployed.

**Always `git pull` first** — the user also runs Claude Code sessions from their
phone against this repo and merges PRs, so master moves independently. Phrase-id
collisions have happened; check the max id after pulling.

---

## 2. The four modes

| Mode | What it is |
|---|---|
| **Apprentissage** | Spaced repetition for phrases not yet mastered. Shows French → you rate: **Pas encore** (stays), **×3 — Mes Acquis**, or **×6 — Mes Acquis** (masters it, with/without boost). Then the English is revealed and a sticky **Suivant** appears. |
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
  acquisAutoPlay: bool                           // "auto" toggle, §5b
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
- **The counter is large in both Mains Libres modes and in ⚑ Réviser** — accent
  red, upright, lining + tabular figures, via `handsfree-skip-row--large` on the
  row (set by `setCounterSize`). Plain Mes Acquis keeps the small grey italic
  one. The row's gap drops 2.5rem → 1rem to pay for the width: at 375px
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
4. **Sync merge is last-write-wins by `sessionCount`.** A write from the phone
   can overwrite a change made elsewhere; two flagged phrases were lost this way.
5. **Cloud state can differ from the file.** `state.phrases` may contain `null`
   entries and ids no longer in `data.js`; guard for both.
6. Run the app via `preview_start` with the `quotidien` launch config
   (`.claude/launch.json`, port 8099). Never start a server with Bash.

---

## 8. Current numbers (verified at handoff)

- **325** entries in `data.js`; **34** deleted → **293 active** phrases
  = **586 French sentences** (every entry has an alt) / 1,172 with English
- **223 mastered**, ~25 in progress, ~45 never seen (these drift daily — the
  user practises most days, so re-count rather than trusting these figures)
- **16 flagged difficult**; ~151 of the mastered ones are ×6
- ~3,000 sentences heard in Mains Libres, ~560 sessions, roughly 40/day

---

## 9. Content conventions

- Natural spoken French. Subjunctive conjunctions (`à moins que`, `avant que`,
  `sans que`, `de peur que`) are written **without** the *ne explétif*.
- `context` is a short English label shown above the card
  (e.g. "Polite disagreement", "Il faut — imparfait").
- Recent themes already covered: subjunctive triggers (~34 cards incl.
  superlatives + `pourvu que` both senses), `à peine`, `s'y prendre`, `là-dedans`,
  `tout à fait`, `carrément`, `n'empêche`, `il faut` in four tenses,
  concordance des temps, participial absolutes. Check `data.js` before adding —
  duplicates are easy.
- UI text is French; code comments English.

---

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
