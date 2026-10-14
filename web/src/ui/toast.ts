export type ToastTone = 'success' | 'error' | 'info' | 'warn';

export interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
}

const DURATION_MS: Record<ToastTone, number> = { success: 4000, info: 5000, warn: 7000, error: 8000 };
const MAX_VISIBLE = 4;

let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit(next: ToastItem[]) {
  items = next;
  listeners.forEach((listener) => listener());
}

function push(tone: ToastTone, message: string) {
  const id = nextId++;
  emit([...items, { id, tone, message }].slice(-MAX_VISIBLE));
  window.setTimeout(() => dismissToast(id), DURATION_MS[tone]);
}

export function dismissToast(id: number) {
  if (items.some((item) => item.id === id)) emit(items.filter((item) => item.id !== id));
}

export function subscribeToasts(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const currentToasts = () => items;

export const toast = {
  success: (message: string) => push('success', message),
  error: (message: string) => push('error', message),
  info: (message: string) => push('info', message),
  warn: (message: string) => push('warn', message),
};
