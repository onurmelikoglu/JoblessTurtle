import { createHarness, Harness, resetDb, setupUser, User } from './harness';

let h: Harness;
let owner: User;
let stranger: User;
let pager: User;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

interface Seed {
  key: string;
  title: string;
  body?: string;
  ageMs: number;
  read?: boolean;
  channel?: 'in_app' | 'telegram';
  userId?: string;
  workspaceId?: string;
}

const userIdOf = async (u: User) => (await h.http().get('/api/v1/me').set(u.auth).expect(200)).body.user.id as string;

async function seed(u: User, rows: Seed[]) {
  const userId = await userIdOf(u);
  const now = Date.now();
  await h.prisma.notification.createMany({
    data: rows.map((r) => ({
      workspaceId: r.workspaceId ?? u.candidate.workspaceId,
      userId: r.userId ?? userId,
      eventId: `${r.key}-${now}`,
      type: 'test',
      title: r.title,
      body: r.body ?? null,
      channel: r.channel ?? 'in_app',
      readAt: r.read ? new Date(now) : null,
      createdAt: new Date(now - r.ageMs),
    })),
  });
}

const list = (u: User, query: Record<string, string | number | boolean> = {}) => h.http().get('/api/v1/notifications').query(query).set(u.auth);
const titles = async (u: User, query: Record<string, string | number | boolean> = {}) => ((await list(u, query).expect(200)).body.items as { title: string }[]).map((n) => n.title);
const iso = (ageMs: number) => new Date(Date.now() - ageMs).toISOString();

beforeAll(async () => {
  h = await createHarness();
  await resetDb(h.prisma);
  owner = await setupUser(h, 'bildirim');
  stranger = await setupUser(h, 'yabanci');
  pager = await setupUser(h, 'sayfa');
  const teammateId = await userIdOf(stranger);
  await seed(owner, [
    { key: 'yeni-ilan', title: 'Yeni İŞ İLANI: Kıdemli Tasarımcı', body: 'Kurgu Ajans, Kadıköy', ageMs: 30 * MINUTE },
    { key: 'basvuru', title: 'Başvuru gönderildi', body: 'Örnek Stüdyo kariyer adresine', ageMs: 3 * HOUR },
    { key: 'donus', title: 'Mail dönüşü geldi', body: 'Çınar Yapım yanıt verdi', ageMs: 2 * DAY, read: true },
    { key: 'ozet', title: 'Haftalık özet', body: '12 yeni fırsat', ageMs: 10 * DAY },
    { key: 'eski', title: 'Eski iş ilanı', ageMs: 40 * DAY },
    { key: 'telegram', title: 'İş ilanı Telegram kopyası', ageMs: 10 * MINUTE, channel: 'telegram' },
    { key: 'ekip', title: 'Ekip arkadaşının iş ilanı', ageMs: 20 * MINUTE, userId: teammateId },
  ]);
  await seed(stranger, [{ key: 'baska', title: 'Başka alanın iş ilanı', ageMs: 15 * MINUTE }]);
});

afterAll(async () => {
  await h.close();
});

describe('bildirim listesi', () => {
  it('yalnızca isteyen kullanıcının son 30 günlük uygulama içi bildirimleri, en yeni önce', async () => {
    const r = (await list(owner).expect(200)).body;
    expect(r.items.map((n: { title: string }) => n.title)).toEqual(['Yeni İŞ İLANI: Kıdemli Tasarımcı', 'Başvuru gönderildi', 'Mail dönüşü geldi', 'Haftalık özet']);
    expect(r.total).toBe(4);
    expect(r.unread).toBe(3);
    expect(r.next_cursor).toBeNull();
    expect(Object.keys(r.items[0]).sort()).toEqual(['body', 'createdAt', 'id', 'link', 'readAt', 'title', 'type']);
  });

  it('metin araması büyük/küçük harf ve Türkçe harf farkı gözetmez; başlıkta ve gövdede arar', async () => {
    expect(await titles(owner, { q: 'is ilani' })).toEqual(['Yeni İŞ İLANI: Kıdemli Tasarımcı']);
    expect(await titles(owner, { q: 'BASVURU' })).toEqual(['Başvuru gönderildi']);
    expect(await titles(owner, { q: 'cinar yapim' })).toEqual(['Mail dönüşü geldi']);
    expect(await titles(owner, { q: 'kadıköy tasarımcı' })).toEqual(['Yeni İŞ İLANI: Kıdemli Tasarımcı']);
    const none = (await list(owner, { q: 'olmayan sözcük' }).expect(200)).body;
    expect(none).toMatchObject({ items: [], total: 0, unread: 3, next_cursor: null });
  });

  it('arama joker karakterlerini metin olarak ele alır', async () => {
    expect(await titles(owner, { q: '%' })).toHaveLength(4);
    expect(await titles(owner, { q: '_' })).toHaveLength(4);
  });

  it('tarih-saat aralığı süzer; saklama sınırı korunur', async () => {
    expect(await titles(owner, { from: iso(4 * HOUR) })).toEqual(['Yeni İŞ İLANI: Kıdemli Tasarımcı', 'Başvuru gönderildi']);
    expect(await titles(owner, { from: iso(3 * DAY), to: iso(DAY) })).toEqual(['Mail dönüşü geldi']);
    expect(await titles(owner, { to: iso(5 * DAY) })).toEqual(['Haftalık özet']);
    expect(await titles(owner, { from: iso(60 * DAY) })).not.toContain('Eski iş ilanı');
    expect(await titles(owner, { q: 'ilan', from: iso(HOUR) })).toEqual(['Yeni İŞ İLANI: Kıdemli Tasarımcı']);
  });

  it('okunmamış süzgeci çalışır', async () => {
    expect(await titles(owner, { unread: true })).toEqual(['Yeni İŞ İLANI: Kıdemli Tasarımcı', 'Başvuru gönderildi', 'Haftalık özet']);
  });

  it('geçersiz sorgular 400 döner', async () => {
    await list(owner, { from: iso(HOUR), to: iso(2 * HOUR) }).expect(400);
    await list(owner, { from: 'dün' }).expect(400);
    await list(owner, { limit: 0 }).expect(400);
    await list(owner, { cursor: 'bozuk' }).expect(400);
  });
});

describe('bildirim sayfalama', () => {
  it('imleçle tüm kayıtlar bir kez ve sırayla gelir; aynı andaki kayıtlar da atlanmaz', async () => {
    await seed(pager, [
      ...Array.from({ length: 4 }, (_, i) => ({ key: `ayni-${i}`, title: `Aynı an ${i}`, ageMs: 2 * HOUR })),
      ...Array.from({ length: 3 }, (_, i) => ({ key: `sira-${i}`, title: `Sıralı ${i}`, ageMs: (i + 3) * HOUR })),
    ]);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: { items: { title: string }[]; total: number; next_cursor: string | null } = (await list(pager, { limit: 2, ...(cursor ? { cursor } : {}) }).expect(200)).body;
      expect(page.total).toBe(7);
      seen.push(...page.items.map((n) => n.title));
      cursor = page.next_cursor;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(4);
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect(seen.slice(4)).toEqual(['Sıralı 0', 'Sıralı 1', 'Sıralı 2']);
  });

  it('imlecin gösterdiği kayıt silinse de sayfalama sürer', async () => {
    const first = (await list(pager, { limit: 3 }).expect(200)).body;
    await h.http().delete(`/api/v1/notifications/${first.items[2].id}`).set(pager.auth).expect(200);
    const second = (await list(pager, { limit: 3, cursor: first.next_cursor }).expect(200)).body;
    expect(second.items).toHaveLength(3);
    expect(second.items.map((n: { id: string }) => n.id)).not.toContain(first.items[1].id);
  });
});

describe('bildirim silme', () => {
  const remaining = () => h.prisma.notification.findMany({ select: { title: true }, orderBy: { createdAt: 'desc' } }).then((rows) => rows.map((r) => r.title));

  it('başka kullanıcının bildirimi tek tek silinemez', async () => {
    const theirs = (await list(stranger).expect(200)).body.items[0];
    await h.http().delete(`/api/v1/notifications/${theirs.id}`).set(owner.auth).expect(404);
    expect(await remaining()).toContain('Başka alanın iş ilanı');
  });

  it('geçersiz kapsam 400 döner', async () => {
    await h.http().delete('/api/v1/notifications').query({ range: '2h' }).set(owner.auth).expect(400);
    await h.http().delete('/api/v1/notifications').set(owner.auth).expect(400);
  });

  it('son 1 saat, son 24 saat, son 7 gün ve tümü kendi uygulama içi bildirimlerini siler', async () => {
    const clear = async (range: string) => (await h.http().delete('/api/v1/notifications').query({ range }).set(owner.auth).expect(200)).body;
    expect(await clear('1h')).toEqual({ deleted: 1 });
    expect(await titles(owner)).toEqual(['Başvuru gönderildi', 'Mail dönüşü geldi', 'Haftalık özet']);
    expect(await clear('24h')).toEqual({ deleted: 1 });
    expect(await clear('7d')).toEqual({ deleted: 1 });
    expect(await titles(owner)).toEqual(['Haftalık özet']);
    expect(await clear('all')).toEqual({ deleted: 2 });
    expect((await list(owner).expect(200)).body).toMatchObject({ items: [], total: 0, unread: 0 });
    const left = await remaining();
    expect(left).toEqual(expect.arrayContaining(['İş ilanı Telegram kopyası', 'Ekip arkadaşının iş ilanı', 'Başka alanın iş ilanı']));
    expect(left).not.toContain('Eski iş ilanı');
    expect(await titles(stranger)).toEqual(['Başka alanın iş ilanı']);
  });
});
