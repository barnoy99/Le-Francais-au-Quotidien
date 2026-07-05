# Le Français au Quotidien — conventions

French phrase-learning PWA. Plain HTML/CSS/JS, no build step. Deployed as a
static site straight from this repo's `master` branch — a change is live only
after it lands on `master`.

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
  Per-phrase `boost` flag = "×6" (six hands-free repetitions instead of three).
- UI language is French; code comments in English. Keep edits minimal and scoped.
