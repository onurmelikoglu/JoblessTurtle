import { describe, expect, it } from 'vitest';
import { legacyTarget, redirectLegacyHash } from './legacy-links';

describe('"#/" biçimli eski bağlantılar', () => {
  it('sade ekranları yeni adreslerine çevirir', () => {
    expect(legacyTarget('#/home')).toBe('/');
    expect(legacyTarget('#/profile')).toBe('/profile');
    expect(legacyTarget('#/notifications')).toBe('/notifications');
    expect(legacyTarget('#/login')).toBe('/login');
  });

  it('sade ekrana giden bağlantının sorgusunu korur', () => {
    expect(legacyTarget('#/home?tab=donusler')).toBe('/?tab=donusler');
  });

  it('mail hesabı dönüşü profile, kayda bağlı bağlantı ilgili sekmeye, ekranı olmayan rota ana sayfaya gider', () => {
    expect(legacyTarget('#/accounts?gmail=ok')).toBe('/profile?gmail=ok');
    expect(legacyTarget('#/drafts/abc')).toBe('/');
    expect(legacyTarget('#/applications?attempt=1')).toBe('/?tab=basvurular&basvuru=1');
  });

  it('rota olmayan adres parçasına dokunmaz', () => {
    expect(legacyTarget('')).toBeNull();
    expect(legacyTarget('#icerik')).toBeNull();
  });

  it('yalnızca kök adreste yönlendirir', () => {
    const visited: string[] = [];
    const at = (pathname: string, hash: string) => ({ pathname, hash, replace: (url: string) => void visited.push(url) });
    expect(redirectLegacyHash(at('/', '#/home'))).toBe(true);
    expect(redirectLegacyHash(at('/profile', '#/home'))).toBe(false);
    expect(redirectLegacyHash(at('/', ''))).toBe(false);
    expect(visited).toEqual(['/']);
  });
});
