// Bounds how many memory-heavy requests may be in flight at once. A full gate
// refuses immediately instead of queueing, so memory stays bounded.
export function createGate(limit: number) {
  let active = 0;
  return {
    tryAcquire(): (() => void) | undefined {
      if (active >= limit) return undefined;
      active += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active -= 1;
      };
    },
  };
}
