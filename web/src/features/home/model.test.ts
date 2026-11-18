import { describe, expect, it } from 'vitest';
import { workModeBadge } from './model';

describe('workModeBadge', () => {
  it('ilanda yazan çalışma şeklini olduğu gibi gösterir', () => {
    expect(workModeBadge({ workMode: 'hybrid', workModeEstimated: false })).toMatchObject({ text: 'Hibrit', tone: 'neutral' });
    expect(workModeBadge({ workMode: 'remote', workModeEstimated: false })).toMatchObject({ text: 'Uzaktan', tone: 'info' });
  });

  it('tahmini "(tahmini)" ekiyle ve vurgusuz gösterir', () => {
    expect(workModeBadge({ workMode: 'onsite', workModeEstimated: true })).toMatchObject({ text: 'İş yerinde (tahmini)', tone: 'neutral' });
    expect(workModeBadge({ workMode: 'remote', workModeEstimated: true })).toMatchObject({ text: 'Uzaktan (tahmini)', tone: 'neutral' });
  });

  it('firmaya genel başvuruda rozet yok', () => {
    expect(workModeBadge({ workMode: null, workModeEstimated: false })).toBeNull();
  });
});
