/**
 * "Now", in epoch seconds. Normally the wall clock; the benchmark pins it to the moment a historical
 * bug was hit (BLAST_RADIUS_AS_OF=<epoch seconds>), so recency is measured the way a developer
 * would have experienced it then, and git history after that moment is ignored.
 */
let pinned: number | undefined = process.env.BLAST_RADIUS_AS_OF ? Number(process.env.BLAST_RADIUS_AS_OF) : undefined;

export const nowSec = (): number => pinned ?? Date.now() / 1000;
export const isPinned = (): boolean => pinned !== undefined;
export function pinClock(epochSec: number | undefined) {
  pinned = epochSec;
}
