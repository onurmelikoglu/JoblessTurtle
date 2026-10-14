export type Tone = 'good' | 'info' | 'warn' | 'bad' | 'neutral';

export const TONE_SOFT: Record<Tone, string> = {
  good: 'bg-good-soft text-good',
  info: 'bg-info-soft text-info',
  warn: 'bg-warn-soft text-warn',
  bad: 'bg-bad-soft text-bad',
  neutral: 'bg-neutral-soft text-ink-soft',
};

export const TONE_TEXT: Record<Tone, string> = { good: 'text-good', info: 'text-info', warn: 'text-warn', bad: 'text-bad', neutral: 'text-ink-soft' };
export const TONE_FILL: Record<Tone, string> = { good: 'bg-good', info: 'bg-info', warn: 'bg-warn', bad: 'bg-bad', neutral: 'bg-ink-faint' };
