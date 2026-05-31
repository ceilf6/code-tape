const waitingMergeableStates = new Set(['blocked', 'dirty']);

export function shouldWaitForMergeableState(state) {
  if (!state) {
    return false;
  }
  return waitingMergeableStates.has(state);
}
