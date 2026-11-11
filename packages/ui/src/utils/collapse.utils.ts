const KEY = 'bumper-collapsed-stages';

/** Stage indices the user collapsed in the repo list; storage can be blocked, so every access is guarded. */
export function storedCollapsed(): Set<number> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return new Set(Array.isArray(value) ? value.filter(item => typeof item === 'number') : []);
  } catch {
    return new Set();
  }
}

export function storeCollapsed(collapsed: ReadonlySet<number>): void {
  try {
    if (collapsed.size === 0) {
      localStorage.removeItem(KEY);
    } else {
      localStorage.setItem(KEY, JSON.stringify([...collapsed].sort((a, b) => a - b)));
    }
  } catch {
    // not persisted; still applied for this page
  }
}
