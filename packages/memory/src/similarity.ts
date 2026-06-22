// Name-similarity heuristics used to catch near-duplicate canonical objects — the same real
// person/company filed twice under slightly different names (`aurelio` vs `aurelio-anastassiades`,
// `christian-gruenberg` vs `christian-grueneberg`). Pure and dependency-free, matching the rest of
// the memory package; the only consumers are `create` (refuse a near-duplicate before it is born)
// and `doctor` (flag the ones already on disk so they can be merged).
//
// The bar here is PRECISION, not recall: a false "these are the same" wrongly blocks a create or
// flags an unrelated record, so every rule below is deliberately conservative. The matcher only
// ever proposes *candidates* — the destructive `merge` is always gated by a model judgment on top,
// and `create`'s refusal carries an `--allow-similar` escape hatch — so being a little eager here
// is safe, but being eager on SHORT names (`ben`/`ken`) is not, and those are excluded.

// A normalized full-string must be at least this long before edit-distance matching kicks in.
// Below it, a one-character difference is far more likely to be two distinct short names
// (`ben`/`ken`, `anna`/`anya`) than a typo of the same name.
const MIN_FUZZY_LEN = 6;

// When two names share exactly one token (e.g. `aurelio` ⊆ `aurelio anastassiades`), that single
// shared token must be at least this long to count as a match. Filters out bare common first names
// and initials that legitimately recur across different people (`al`, `li`).
const MIN_SHARED_TOKEN_LEN = 4;

// Fold a display name or slug down to a comparable token string: lowercase, transliterate German
// umlauts/ß the way people actually spell them around (ü↔ue, so "Müller" and "Mueller" collapse),
// strip any remaining diacritics, and reduce every run of punctuation/whitespace/hyphens to a
// single space. Works on both titles ("Aurelio Anastassiades") and ids ("aurelio-anastassiades").
// This is Latin-script oriented: non-decomposable letters (Ł, Đ, Ø) lose their base and non-Latin
// scripts (e.g. CJK) fold to "", so near-duplicate detection is a no-op for those names. That recall
// gap is an accepted limitation of this precision-first, Latin-name heuristic, not a bug to "fix"
// by loosening matching (which would cost the precision the rest of the file is built to protect).
export function normalizeName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Classic Levenshtein edit distance (insertions/deletions/substitutions). Names are short, so the
// O(m·n) DP is trivially cheap; a single row is kept to avoid the full matrix.
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        (prev[j] ?? 0) + 1, // deletion
        (curr[j - 1] ?? 0) + 1, // insertion
        (prev[j - 1] ?? 0) + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length] ?? 0;
}

// How many edits we tolerate between two TOKENS, scaled to the shorter token's length: none below
// the fuzzy floor, one for medium tokens, two for long ones. Applied per-token (never to the whole
// multi-word string), so the budget is spent on the one word that actually differs — `gruenberg`
// vs `grueneberg` (1 edit over a 9-char token) matches, while `mario`/`maria` (a 5-char token,
// budget 0) does not.
function editBudget(shorterLength: number): number {
  if (shorterLength < MIN_FUZZY_LEN) return 0;
  return shorterLength >= 10 ? 2 : 1;
}

// Are these two token sets a same-entity match by containment? True when the smaller set is fully
// contained in the larger AND the overlap is distinctive enough to trust: two-plus shared tokens,
// or a single shared token that is long enough not to be a generic first name. Order-independent,
// so "Aurelio Anastassiades" and "Anastassiades, Aurelio" match as equal sets.
function tokenSetsContain(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  if (small.size === 0) return false;
  for (const token of small) {
    if (!large.has(token)) return false;
  }
  if (small.size >= 2) return true;
  const [only] = small;
  return (only?.length ?? 0) >= MIN_SHARED_TOKEN_LEN;
}

// Do these two names plausibly refer to the same real-world thing? Three signals, in order:
//   1. exact match after normalization (case/punctuation/umlaut spelling variants);
//   2. token containment — one name is a fuller version or a reordering of the other
//      (`aurelio` vs `aurelio anastassiades`, `anastassiades aurelio`);
//   3. a single mistyped token — the two names share every token but one, and that one differing
//      token is a spelling variant of its counterpart (`christian gruenberg` vs
//      `christian grueneberg`).
// Signal 3 deliberately compares ONLY the differing token, never the whole string: sizing the edit
// budget off the full multi-word length would fuse different people who share a surname
// (`mario lopez`/`maria lopez`, `hans gruber`/`hans huber`) because the lone differing word is
// short. Per-token keeps precision high — the destructive `merge` still gets a model judgment on
// top, but the candidate set it sees stays clean.
export function areNamesSimilar(a: string, b: string): boolean {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;

  const tokensA = new Set(na.split(" "));
  const tokensB = new Set(nb.split(" "));
  if (tokenSetsContain(tokensA, tokensB)) return true;

  // The tokens unique to each side. When exactly one differs on each side (every other token
  // matches exactly), test whether that pair is a spelling variant, budgeting by the token length.
  const onlyA = [...tokensA].filter((t) => !tokensB.has(t));
  const onlyB = [...tokensB].filter((t) => !tokensA.has(t));
  if (onlyA.length === 1 && onlyB.length === 1) {
    const [tokenA] = onlyA;
    const [tokenB] = onlyB;
    if (tokenA && tokenB) {
      const budget = editBudget(Math.min(tokenA.length, tokenB.length));
      if (budget > 0 && levenshtein(tokenA, tokenB) <= budget) return true;
    }
  }
  return false;
}

// Cross-product helper: do any of A's names look like any of B's names? A canonical record carries
// several names (title, id-as-slug, aliases); two records are near-duplicates if any pairing
// matches. Short-circuits on the first hit.
export function areAnyNamesSimilar(namesA: readonly string[], namesB: readonly string[]): boolean {
  for (const a of namesA) {
    for (const b of namesB) {
      if (areNamesSimilar(a, b)) return true;
    }
  }
  return false;
}
