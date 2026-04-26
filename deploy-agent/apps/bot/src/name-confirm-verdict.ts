// Name-confirmation verdict — used by the delete_project two-step flow.
//
// Why a verdict module:
//   delete_project nukes a Cloud Run service, all DB rows, and every
//   version. We have a button-style confirmation already (askConfirmation
//   in nl-handler) but a single button click is too low-friction for
//   "permanently delete production". Operators must also TYPE the slug
//   to confirm — same pattern GitHub uses to delete a repo.
//
//   This verdict is the type comparison: trim both, case-sensitive
//   compare (slugs are lowercase by convention; mismatched case is a
//   typo and we want it to fail closed).
//
// Pattern: pure function, discriminated union, zero side effects.

export type NameMatchVerdict =
  | { kind: 'match' }
  | { kind: 'mismatch' }
  | { kind: 'empty' };

/**
 * Compare a user-typed string against the expected resource name.
 *
 * - Trim both sides (operators commonly add a trailing space when
 *   pasting from another window).
 * - Case-sensitive: slugs ARE lowercase, and accidentally typing
 *   "Luca" when the slug is "luca" should fail closed.
 * - Empty (after trim) → distinct kind so the caller can show a
 *   different message ("you need to type the slug").
 */
export function verifyNameMatch(typed: string, expected: string): NameMatchVerdict {
  const t = typed.trim();
  const e = expected.trim();
  if (t.length === 0) return { kind: 'empty' };
  if (t === e) return { kind: 'match' };
  return { kind: 'mismatch' };
}
