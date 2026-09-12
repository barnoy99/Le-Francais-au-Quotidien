# Corpus — what's in it, and how content decisions get made

Companion to `HANDOFF.md`. That file tells you how the app works; this one tells
you what the phrases are for, how they were chosen, and — most importantly — the
rules the user applies when judging them. Read it before adding or deleting
anything.

The user's goal: **B2 French for daily speech with friends and family**, plus
`vous` for travel in French-speaking countries. He is an Israeli tutor; his wife
grew up with a French-speaking mother and speaks well in everyday domains. Three
children, 5–10.

---

## The rules that govern content

These were learned the hard way. Two of them overturned inferences that looked
well-supported by evidence.

**1. The criterion is how commonly a phrase is really said** — not how formal it
is, and not what conversational job it does. The user kept the *most formal*
phrase in a review pool (*Loin de moi l'idée de te critiquer*) and deleted the
*most casual* one (*Bref, on s'en fout*, later reinstated). Formality is not a
defect. Do not "modernise" existing entries.

**2. He speaks French to his wife, not to his children.** Sentences addressed to
a child (*Range ta chambre*, *Mets tes chaussettes dans le panier*) are wrong for
him. Write *about* the kids, addressed to her.

**3. Real spoken connectors matter more than proverbs.** His words: he'd take a
connector over "a proverb that only elders really use" any day. `du coup`,
`en fait`, `bref`, `en gros`, tag-`quoi` all earn their place.

**4. When his stated choice conflicts with your judgement, his learning history
decides.** Three states in the saved progress carry meaning:

| state | meaning |
|---|---|
| mastered | he promoted it deliberately — he wants it |
| deleted in-app | he already threw it out on his own device |
| seen 2+ times, never promoted | repeatedly met, repeatedly passed over |

This resolved eleven disputed phrases: six were mastered (reinstated), five had
already been rejected in practice (stayed deleted). Read the live state with a
read-only GET — the command is in `HANDOFF.md` §8.

**5. Don't infer a rule from his choices and apply it silently.** A deletion vote
split 82% / 10% between two categories, and 64% of his keeps shared a grammatical
marker that 0% of his deletions had. The inferred rule — "he wants language that
acts on the other person, not language that manages his own talk" — was clean,
well-evidenced, and *wrong*. He corrected it. Show him the evidence and ask.

**6. Show him numbered lists to pick from.** He'd rather judge 37 sentences
himself than accept a summary of them. He asks for a real opinion on his French,
including corrections — give it, then defer.

---

## What the corpus is

494 entries / 988 sentences. Each entry is a main sentence plus an alt.

**The 2026 coverage probe (517–535).** Probing ~90 constructions found the
corpus was rich in the *clever* connectors and nearly empty of the ordinary
ones: `parce que` appeared **once** in 950 sentences, and `par contre`,
`alors que`, `vu que`, `puisque`, `c'est pour ça que` not at all. A whole
category was missing rather than a word — speculation aloud: `apparemment`,
`il paraît que`, `j'imagine`, `ça m'étonnerait que` and `devoir` in its
probability sense were all zero, so he could state and react but not wonder.
Also zero: `pendant que`, `depuis que`, `chaque fois que`, `au moment où`,
`être en train de`, `avoir du mal à`, `au cas où`, `arrêter pas de`, and the
causative `faire + infinitif`.
**No entry was written for `parce que` itself** — he knows it; the gap is its
alternatives, not the word. Deliberately left out as more written than spoken:
`à mesure que`, `quand bien même`, `de sorte que`, `auquel`/`duquel`.
**Watch the regexes when probing.** The first pass reported false zeros for
`se faire + infinitif` (7 hits, at 396–399) and false positives for `vu que`
(18, all inside other words). Verify every hit by eye before calling something
a hole.

**Argument-building entries (480–499) break the alt rule on purpose.** Everywhere
else `alt_usage` is an independent second use of the phrase. In these twenty the
alt *continues* the main sentence, so the pair rehearses the join between two
moves of an argument — which is the actual B2 skill the corpus was missing (it
could react but not hold the floor: 0 sentences framing a view, 0 structuring
markers, before this batch). Constraint that makes it safe: the ⚑ passes serve
main and alt as separate items, so **every alt must still be a complete sentence
that stands alone** — a continuation, never a dangling clause. The validation
script checks this.

- **Function-first, not topic-first.** Most entries are a conversational *move* —
  hedging, conceding, softening — rather than a subject. Roughly 300 distinct
  `context` labels: near-zero repetition.
- **A recognisable shape:** hedge + assertion. *"Ça ne me regarde pas, mais…"*,
  *"Sans vouloir te contredire…"*. Diplomatic, adult, peer-to-peer.
- **Strong on friction** — disagreement, indignation, boundaries, disbelief.
- **A grammar spine** (~90 entries): subjunctive triggers, superlative +
  subjonctif, `pourvu que`, concordance des temps, `il faut` in four tenses,
  participial absolutes, `à peine`, `s'y prendre`, `là-dedans`, `tout à fait`,
  `carrément`, `n'empêche`, `quand même`.
- **Idioms in good health** — *ça sent le roussi*, *retourner sa veste*, *mettre
  les pieds dans le plat*, *d'autres chats à fouetter*, *anguille sous roche*.
- **L'ennui (511–513)** was a total blank until asked for: `s'ennuyer`,
  `ennuyeux` and `l'ennui` appeared **0 times** in 938 sentences. The nearest
  thing was 463 (*sinon ils vont tourner en rond*), which talks around the word.
  A reminder that a gap this size can sit unnoticed in a corpus that looks full:
  the entries cover a function-first vocabulary well and everyday *states*
  poorly. One entry per form — the reflexive verb, the argument he actually
  makes about it to his wife (boredom is good for the children), and the
  adjective plus *mourir d'ennui*.

### The careful `tu` band was converted to spoken form (Sept 2026)

The three-register split is now **two**. Everything addressed to `tu` reads the
way it is actually said: the dropped `ne` (*je sais pas*, *c'est pas grave*),
`t'as` / `t'es` / `t'étais`, *faut que* for *il faut que*, *y a* for *il y a*.
169 sentences below id 334 were rewritten; everything from 334 up already read
that way, so it was left untouched — running rules over it could only break it.

**This reverses the earlier "formality is not a defect" decision**, on the
tutor's own instruction: *"change them by this rationale — how would a French
person say it in this situation."* Situation, not blanket rule, so **24
sentences keep the full form** because a French speaker would use it there:

- **proverbs** — *on ne fait pas d'omelette…*, *les chiens ne font pas des
  chats*, *…vendre la peau de l'ours*;
- **frozen `n'`** — *n'empêche*, *n'importe quoi*, *n'est-ce pas*. The `n'` is
  part of the word. My rules stripped it and produced *"Empêche, il aurait pu
  nous prévenir"* and *"Importe quoi !"* before I caught it;
- **elevated frames** — *Il est regrettable/étrange/surprenant que…*, *Quoi que
  tu dises*, *Quelle que soit*, participial absolutes. Nobody drops the `ne`
  inside a sentence that formal;
- **subject negation** — *rien ne change*, *personne ne l'avait prévenu*. Dropped
  in speech, but far more marked than *je sais pas*, and it reads as an error
  written down. The softest of these calls — easy to revisit;
- **`ni…ni`** — *ça n'a ni queue ni tête*: the `ne` is obligatory;
- **`ne…que` after a full noun** — *ces erreurs ne sont que…*; fine to drop
  after a clitic (*c'est qu'une question de temps*), broken after a noun phrase;
- **object-pronoun imperatives** — *Ne l'invite pas*, *Ne me parle pas*. Said
  without the `ne`, but *"L'invite pas"* at the head of a sentence reads like a
  typo.

The `vous` travel set (414–433) keeps everything: full `ne`, no contractions.
That register is the whole point of those entries.

**If you ever rewrite French with a script, `\b` is a trap.** JavaScript's `\b`
is ASCII-only, so it fires *inside* accented words: `\bne\s+` turned
*"ça traîne depuis hier"* into *"ça traîdepuis hier"* and *"je les emmène au
parc"* into *"je les emmèau parc"*. Use explicit unicode lookarounds
(`(?<![A-Za-zÀ-ÖØ-öø-ÿ])`). Neither a syntax check nor a duplicate check catches
that — only reading the diff does.

### Three registers coexist deliberately

| ids | register |
|---|---|
| up to ~333 | careful `tu`, full `ne` |
| 334–413, 434–475 | casual `tu`, `ne` dropped — `t'as`, `y a`, `faut que` |
| 414–433 | polite `vous`, full `ne` — shops, transport, problems abroad |

Every `context` label names its register. **Drop the `ne`, but never phonetically
respell** (`chuis`, `j'sais`, `ptêt`) — the app speaks every sentence aloud and
the TTS mangles those. `t'as`, `t'es`, `y a` are standard and read correctly.

Subjunctive conjunctions (`à moins que`, `avant que`, `sans que`, `de peur que`)
are written **without** the *ne explétif*.

---

## The 2026 round — what changed and why

The corpus was measured against the goal before anything was added. It was strong
at holding a position in a discussion and thin everywhere else:

| gap | evidence, out of 650 sentences at the time |
|---|---|
| questions that draw someone out | 74 contained "?" — only **7** invited the other person to speak |
| concrete daily life | kids **7**, money **5**, health **9**, food **13**, household **13** |
| B2 grammar | `dont` **0**, `lequel` **0**, `se faire` + inf **0**, `si` + plus-que-parfait **2**, reported speech **2** |
| spoken connectors | `en fait` **0**, `alors` **0**, `du coup` **2**, `tu vois` **2** |
| `vous` for public life | 20 hits, all *openers* — nothing for transacting |

**Added 130:** conversation-driving questions (20), home & family (20), hosting &
rapport (15), the missing B2 grammar (15), spoken connectors (10), travel `vous`
(20), and a B2 domestic/parenting set (30) — laundry, splitting the chores, the
children's behaviour, bedtime, agreeing as a couple, talking *about* the kids.

**Deleted 27:** one ungrammatical (*Il vaut mieux tard que jamais* — `il vaut
mieux` needs an infinitive or a clause), three exact duplicates, twelve confirmed
as not genuinely spoken, five he'd already rejected in practice, four sententious
proverbs, and two he'd seen repeatedly without ever promoting. **13 of the 27 he
had already deleted in-app himself** before any of the analysis — independent
confirmation of the criterion.

### Still arguably off-goal

Not everything left fits perfectly. Roughly a quarter is unverified or below
level:

- **8 superlative + subjonctif** (*C'est le meilleur livre que j'aie jamais lu*)
  — correct, but the careful register; relaxed speech uses the indicative.
- **8 `il est + adj + que`** frames — a notch formal for family talk.
- **11 at A2/B1** — possessive pronouns, location and directions. He asked to
  keep them: he doesn't know them all, and would rather delete them himself in
  the app later.
- **~47 never shown to him**, so neither he nor any session has judged them.

---

## What the app is for

An app to master ready-made French turns of phrase until they come out without
thinking. Not vocabulary, not grammar rules — *moves*. Meet it in Apprentissage,
recall it in Mes Acquis, drill it aloud in Mains Libres.

It won't broaden vocabulary, train listening to fast speech in noise, or teach
reading, writing, or building novel sentences beyond the patterns drilled. It is
a fluency engine for the recurring 80% of daily talk — deliberately, and that is
why it works.

## Dropping `ne` — where it stops

Casual entries (334+, except the `vous` block) drop `ne`. Three limits found in a
full read of all 922 sentences:

- **`personne` as subject keeps its `ne`** — *personne n'en parle*, not *personne
  en parle*. Dropping it is far more marked than with `pas`, and before a vowel
  it barely survives.
- **Never mix a subjunctive with a dropped `ne`.** *c'est qu'il ait rien dit*
  clashes: the subjunctive is careful register, the missing `ne` is casual. Pick
  one — in speech that means the indicative.
- **Watch `plus`.** Without `ne`, *j'ai plus de batterie* reads as "I have MORE
  battery" — its own opposite. In speech /ply/ vs /plys/ disambiguates, but this
  app reads sentences aloud and the synthesiser may not honour it. Either keep
  a disambiguating word (*y a plus rien*) or use another phrasing.
