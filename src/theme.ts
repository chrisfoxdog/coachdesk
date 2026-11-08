import { useState } from 'react';

// CoachDesk theme choice. Dark is the Elite brand default and what every
// first load gets; a saved choice (per browser, localStorage) is honored
// when one exists. OS preference is deliberately NOT consulted — brand
// consistency first. The pre-paint init in index.html applies the same
// rule before React mounts, so there is no flash of the wrong theme.

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'coachdesk-theme';

export function storedTheme(): Theme {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Storage unavailable (e.g. private browsing) — the choice still
    // applies for the rest of this session.
  }
}

export function useTheme(): { theme: Theme; toggleTheme: () => void } {
  const [theme, setTheme] = useState<Theme>(() =>
    document.documentElement.dataset.theme === 'light' ? 'light' : storedTheme(),
  );
  const toggleTheme = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    setTheme(next);
  };
  return { theme, toggleTheme };
}
