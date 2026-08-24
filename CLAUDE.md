# Le Français au Quotidien — conventions

French phrase-learning PWA. Plain HTML/CSS/JS, no build step. Deployed as a
static site straight from this repo's `master` branch — a change is live only
after it lands on `master`.

> **Read `HANDOFF.md` first** for the full picture: architecture, the rotation
> /pass system, difficulty flag, UI layout budgets, current stats, and the
> gotchas (chiefly: the local preview reads and writes the user's LIVE progress
> data, and the service worker serves cached assets).
>
> **Then read `CORPUS.md`** before touching `data.js`: what the phrases are for,
> the three registers, and the rules the user applies when judging content — two
> of which overturned well-evidenced inferences, so don't re-derive them.

## Keeping `HANDOFF.md` current (do not skip)

Nothing enforces this automatically — the handoff is only accurate because each
session updates it. Before finishing work, update it whenever you have:

- changed the asset versions (§1 **Current versions** — every deploy)
- added or deleted phrases (§8 counts)
- changed how a mode, counter, rotation or pass behaves (§2, §4, §5)
- learned something durable about how the user wants content chosen or written
  (§9) — their preferences have overturned reasonable-looking inferences twice

A session that leaves it stale costs the next one an hour of rediscovery.

## Adding phrases (most common request)

- Phrases live in `data.js` as `var PHRASES = [...]`.
- **Every phrase entry needs BOTH a main sentence and an alt example**:
  `{ id, fr, en, context, alt_usage, alt_usage_en }`. "Add a sentence" always
  means main + alt. Never add an entry without `alt_usage`/`alt_usage_en`.
- `id`: next integer after the current maximum (gaps in ids are fine — never
  renumber existing entries).
- Register: natural spoken French. Subjunctive conjunctions (à moins que,
  avant que, sans que, de peur que…) are written WITHOUT the "ne explétif".
- `context` is a short English label shown above the card
  (e.g. "Polite disagreement", "Il faut — imparfait").

## Cache-busting rules (required on EVERY asset change)

The app is offline-capable (service worker). When you change a file, you must:
1. Bump that file's `?v=N` query string in `index.html`
   (e.g. `data.js?v=18` → `data.js?v=19`).
2. Update the SAME versioned URL in the `SHELL` array in `sw.js`.
3. Bump `CACHE_VERSION` in `sw.js` (e.g. `'v4'` → `'v5'`).

Skipping any of these leaves users' devices serving stale files.

## Other facts

- Progress state: one object in localStorage key `frenchSR_state`, mirrored to
  Firebase Realtime DB (`firebase-config.js`). Firebase is sync-only, NOT
  hosting. Do not cache firebaseio.com requests in the service worker.
- Pools: `level === 4` = mastered (Mes Acquis + Mains Libres draw from it);
  anything lower is in the Apprentissage spaced-repetition rotation.
  Per-phrase `boost` flag = "×6" (six hands-free repetitions instead of three);
  `hardManual` = the ⚑ difficulty flag (doubles frequency only).
- All phrase writes go through `writePhrase(id, changes)` — it merges, so no
  field is silently dropped. Never rebuild a phrase record inline.
- Order comes from a persistent rotation cycle (`acqCycle`/`hfCycle` + cursors +
  `*Pass` progress maps), not a per-session shuffle. See `HANDOFF.md` §4.
- UI language is French; code comments in English. Keep edits minimal and scoped.
