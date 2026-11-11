// Shared state for browser persistence errors without a storage/config import cycle.
export const storageFailures = new Set();
export function storageResult(key, ok) {
  if (ok) storageFailures.delete(key); else storageFailures.add(key);
  window.dispatchEvent(new CustomEvent('kd-storage-state', { detail: { failed: storageFailures.size > 0 } }));
  return ok;
}
