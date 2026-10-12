// The owner-only rule for every tool here that reads user data: other users'
// corrections and captures never leave the table, even with consent. aggregate
// feeds Claude and a candidate prompt that CI pushes to a public branch, and
// materialize writes eval cases into this public repo. Both read only the
// OWNER_USER_ID account's partition and refuse to run without it. The
// header of materialize-eval-cases.ts shows how to look up your userId.

/** The required owner userId; throws when OWNER_USER_ID is unset or blank. */
export function ownerUserIdFrom(env: Record<string, string | undefined>): string {
  const ownerUserId = env.OWNER_USER_ID?.trim();
  if (!ownerUserId) {
    throw new Error(
      'Set OWNER_USER_ID to your own userId. Only the owner\'s corrections and captures ' +
        'may be read (see the header of materialize-eval-cases.ts to look it up).',
    );
  }
  return ownerUserId;
}
