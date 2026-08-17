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

**Current versions:** `app.js?v=54`, `style.css?v=48`, `data.js?v=27`,
`firebase-config.js?v=3`, `CACHE_VERSION = 'v34'`.

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
  hfCycle:  [ids], hfCursor,  hfPass:  {id:count}, hfSig,  hfLast,
  ecCycle: ["id:main"|"id:alt"], ecCursor        // ⚑ Écouter pass, §5a
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
- The cycle persists across sessions via `*Cursor`. A session pre-fetches a
  batch of `SESSION_BATCH = 60` and **hands back whatever it didn't reach** on
  exit (`releaseBatch`), so nothing loses its turn.
- **Pass progress** (`*Pass` map) = distinct phrases covered. The header counter
  shows `passProgress / masteredCount`, e.g. `45 / 221`, and carries across
  sessions. Closed in `markPassSeen` at *display* time (not when the pre-fetch
  crosses the boundary), and a fresh pass avoids opening with the phrase just
  shown (`avoidEarlyRepeat`).
- Pool changes (mastering, deleting, toggling ×6/⚑) call `invalidateCycles()`;
  the rebuild covers **only what's still owed**, so progress isn't lost.
- **⚑ Réviser** uses a plain `weightedShuffle` and deliberately does **not**
  touch the cycles or pass counts. **⚑ Écouter** has its own persistent pass
  (`ecCycle`/`ecCursor`) and likewise leaves `hfCycle`/`hfPass` alone — see §5a.

---

## 5. Difficulty (⚑)

A single on/off toggle, behaving like ×6, present in the bottom bar of **both**
Mes Acquis and Mains Libres (`btn-acquis-hard`, `btn-handsfree-hard`), plus a
**Difficile** toggle in Chercher. Amber when active, sage outline when off.

Effect: **doubles frequency only** (2 copies per Mains Libres cycle). It does not
change the number of readings.

Two home-screen links appear when the count > 0, hidden at 0:
- **⚑ Écouter (N)** → Mains Libres with only flagged phrases (see §5a)
- **⚑ Réviser (N)** → Mes Acquis recall with only flagged phrases

### 5a. ⚑ Écouter — its own persistent pass

Écouter does *not* share the Mains Libres rotation, and its rules differ:

- **Every sentence is read 4×** (`ECOUTER_READS`), ×6 or not. Tapping ×6 during
  an Écouter session records the flag for the main rotation but never changes
  the current sentence's reading count.
- **Main and alt are independent items**, shuffled apart from each other — not
  the "phrase = two exercises back-to-back" of the normal rotation. `ecSpread`
  shuffles, then pushes any two sentences of the same phrase at least
  `max(2, n/8)` slots apart (measured on live data: closest pair 5 of 32).
- **The order persists**: `state.ecCycle` is a list of `"id:main"` / `"id:alt"`
  keys, `state.ecCursor` walks it across sessions. Quitting hands the
  interrupted sentence back (cursor − 1), so you resume on it rather than past
  it. Counter shows `cursor / total`, e.g. `4 / 32`.
- **The pass ends with `screen-ecouter-done`** ("Félicitations !", also spoken,
  since the phone is probably in a pocket), which clears `ecCycle` — the next
  session shuffles a brand-new order.
- **Flag changes reach a pass already in progress**: `syncEcouterQueue()` (hung
  off `invalidateCycles`, so every toggle path hits it) splices newly flagged
  sentences into the part not yet played and drops un-flagged ones. Items before
  the cursor keep their place, so nothing repeats and nothing loses its turn.
- Sentences are pulled from the queue **one at a time** in `handsfreeStep`,
  which is what lets a mid-session flag be picked up without restarting.
  `handsfreeExercises` / `handsfreePositions` are parallel to `handsfreePhrases`
  for this mode only.

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
