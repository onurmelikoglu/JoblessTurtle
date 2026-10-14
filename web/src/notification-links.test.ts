import { describe, expect, it } from 'vitest';
import { appTarget, idsOf, withoutParams } from './notification-links';

describe('bildirim bağlantıları', () => {
  it('yeni ilanlar o ilanlara odaklanmış firma listesine gider', () => {
    expect(appTarget('/jobs?ids=j1,j2', 'new_jobs')).toBe('/?ilan=j1%2Cj2');
    expect(appTarget('/jobs/j9', 'job_reopened')).toBe('/?ilan=j9');
    expect(appTarget('/opportunities?id=o1', 'new_opportunity')).toBe('/?firsat=o1');
  });

  it('gönderim ve yanıtlar başvurunun ayrıntısını, mail dönüşü o maili açar', () => {
    expect(appTarget('/applications?attempt=a1', 'send_accepted')).toBe('/?tab=basvurular&basvuru=a1');
    expect(appTarget('/inbox?id=m1', 'bounce')).toBe('/?tab=donusler&donus=m1');
  });

  it('bekleyen yapay zekâ görevi penceresini açar', () => {
    expect(appTarget('/ai?task=t1', 'ai_task_waiting')).toBe('/?gorev=t1');
  });

  it('ayrıntısız eski bildirim türüne uyan sekmeye gider', () => {
    expect(appTarget('/home', 'bounce')).toBe('/?tab=donusler');
    expect(appTarget('/home', 'new_jobs')).toBe('/?sira=yeni');
    expect(appTarget(null, 'send_failed')).toBe('/?tab=basvurular');
    expect(appTarget(null, 'daily_digest')).toBeNull();
  });

  it('sade ekranlar ve sorguları korunur; ekranı olmayan rota ana sayfaya gider', () => {
    expect(appTarget('/home?tab=donusler', 'autopilot')).toBe('/?tab=donusler');
    expect(appTarget('/home?sira=yeni', 'catalog_seed')).toBe('/?sira=yeni');
    expect(appTarget('/profile')).toBe('/profile');
    expect(appTarget('/sources', 'source_blocked')).toBe('/');
    expect(appTarget('/drafts/d1', 'draft_ready')).toBe('/');
  });

  it('kimlik listesi ve parametre temizliği', () => {
    const params = new URLSearchParams('tab=basvurular&basvuru=a1&ilan=j1,%20j2,');
    expect(idsOf(params, 'ilan')).toEqual(['j1', 'j2']);
    expect(withoutParams(params, 'basvuru', 'ilan').toString()).toBe('tab=basvurular');
  });
});
