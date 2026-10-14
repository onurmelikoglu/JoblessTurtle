import { describe, expect, it } from 'vitest';
import { subjectOf } from './tokens';

const token = (claims: object) => `h.${btoa(JSON.stringify(claims)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.s`;

describe('erişim anahtarının sahibi', () => {
  it('JWT içindeki kullanıcıyı okur', () => {
    expect(subjectOf(token({ sub: 'kullanici-1', adm: false }))).toBe('kullanici-1');
    expect(subjectOf(token({ sub: 'ç/ö?>~', typ: 'access' }))).toBe('ç/ö?>~');
  });

  it('çözülemeyen ya da kullanıcısı olmayan anahtarda null döner', () => {
    expect(subjectOf(null)).toBeNull();
    expect(subjectOf('expired')).toBeNull();
    expect(subjectOf('a.%%%.c')).toBeNull();
    expect(subjectOf(token({ adm: true }))).toBeNull();
    expect(subjectOf(token({ sub: 42 }))).toBeNull();
  });
});
