import { useCallback, useSyncExternalStore } from 'react';

export type ThemeChoice = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'jt.theme';
const listeners = new Set<() => void>();
const systemDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;

function stored(): ThemeChoice {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

function apply(choice: ThemeChoice) {
  document.documentElement.classList.toggle('dark', choice === 'dark' || (choice === 'system' && systemDark()));
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const onSystemChange = () => apply(stored());
  media.addEventListener('change', onSystemChange);
  return () => {
    listeners.delete(listener);
    media.removeEventListener('change', onSystemChange);
  };
}

export function useTheme() {
  const choice = useSyncExternalStore(subscribe, stored);
  const setChoice = useCallback((next: ThemeChoice) => {
    try {
      if (next === 'system') localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, next);
    } catch {
      return;
    }
    apply(next);
    listeners.forEach((listener) => listener());
  }, []);
  return { choice, setChoice };
}
