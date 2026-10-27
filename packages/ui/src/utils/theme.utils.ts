export type ThemeMode = 'auto' | 'light' | 'dark';

const KEY = 'bumper-theme';
const ORDER: ThemeMode[] = ['auto', 'dark', 'light'];

/** Stored choice; storage can be blocked, so every access is guarded. */
export function storedTheme(): ThemeMode {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'light' || value === 'dark' ? value : 'auto';
  } catch {
    return 'auto';
  }
}

/** Put the effective theme on <html>: Web Awesome switches palettes on the `wa-dark` class. */
export function applyTheme(mode: ThemeMode): void {
  const dark =
    mode === 'dark' || (mode === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('wa-dark', dark);
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
}

/** Next mode in auto → dark → light; persists and applies it. */
export function cycleTheme(current: ThemeMode): ThemeMode {
  const next = ORDER[(ORDER.indexOf(current) + 1) % ORDER.length] ?? 'auto';
  try {
    if (next === 'auto') {
      localStorage.removeItem(KEY);
    } else {
      localStorage.setItem(KEY, next);
    }
  } catch {
    // not persisted; still applied for this page
  }
  applyTheme(next);
  return next;
}

/** Apply the stored mode now and follow the OS setting while in `auto`. */
export function initTheme(): void {
  applyTheme(storedTheme());
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (storedTheme() === 'auto') {
      applyTheme('auto');
    }
  });
}
