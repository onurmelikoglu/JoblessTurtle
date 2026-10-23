/**
 * Bildirimlerin taşıdığı bağlantılar sunucunun kavramlarıyla yazılır (`/applications?attempt=…`, `/jobs?ids=…`).
 * Arayüzde bunların karşılığı ana sayfanın ilgili sekmesi ve o kaydı öne çıkaran adres parametreleridir. Eski
 * bildirimlerin ve Telegram mesajlarının bağlantıları da buradan geçer.
 */
export const LINK_PARAMS = {
  /** Firmalar sekmesinde yalnızca bu ilanları (iş kaydı kimlikleri) içeren firmalar gösterilir. */
  jobs: 'ilan',
  /** Firmalar sekmesinde yalnızca bu fırsatları içeren firmalar gösterilir. */
  opportunities: 'firsat',
  /** Başvurularım sekmesinde bu başvurunun ayrıntısı açılır. */
  application: 'basvuru',
  /** Mail dönüşleri sekmesinde bu mail açılır. */
  inbound: 'donus',
  /** Bekleyen yapay zekâ görevinin penceresi açılır. */
  aiTask: 'gorev',
} as const;

const SCREENS: Record<string, string> = { '/': '/', '/home': '/', '/profile': '/profile', '/accounts': '/profile', '/notifications': '/notifications', '/login': '/login' };

/** Bağlantısı ayrıntı taşımayan (eski) bildirimler türlerine göre ilgili sekmeye ya da sıralamaya gider. */
const FALLBACK_OF_TYPE: Record<string, Record<string, string>> = {
  new_jobs: { sira: 'yeni' },
  new_opportunity: { sira: 'yeni' },
  catalog_seed: { sira: 'yeni' },
};

const TAB_OF_TYPE: Record<string, string> = {
  bounce: 'donusler',
  human_reply: 'donusler',
  interview: 'donusler',
  reply_other: 'donusler',
  auto_reply: 'donusler',
  autofix: 'donusler',
  autopilot: 'donusler',
  applied_company_job: 'basvurular',
  send_accepted: 'basvurular',
  send_blocked: 'basvurular',
  send_failed: 'basvurular',
  send_unknown: 'basvurular',
};

const home = (entries: Record<string, string | undefined>) => {
  const query = new URLSearchParams(Object.entries(entries).filter((e): e is [string, string] => !!e[1])).toString();
  return query ? `/?${query}` : '/';
};

const idList = (value: string | null | undefined) =>
  (value ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
    .join(',') || undefined;

/** Bildirim bağlantısının arayüzdeki adresi; ekranı olmayan bağlantı ana sayfaya (türüne uyan sekmeye) gider. */
export function appTarget(link: string | null | undefined, type?: string | null): string | null {
  const fallback = !type ? null : TAB_OF_TYPE[type] ? home({ tab: TAB_OF_TYPE[type] }) : FALLBACK_OF_TYPE[type] ? home(FALLBACK_OF_TYPE[type]) : null;
  if (!link) return fallback;
  const [path, rawQuery = ''] = link.split('?');
  const query = new URLSearchParams(rawQuery);
  const segments = path.split('/').filter(Boolean);
  switch (segments[0]) {
    case 'applications': {
      const attempt = segments[1] ?? query.get('attempt') ?? undefined;
      return home({ tab: 'basvurular', [LINK_PARAMS.application]: attempt });
    }
    case 'inbox':
      return home({ tab: 'donusler', [LINK_PARAMS.inbound]: segments[1] ?? query.get('id') ?? undefined });
    case 'jobs':
      return home({ [LINK_PARAMS.jobs]: idList(segments[1] ?? query.get('ids')) });
    case 'opportunities':
      return home({ [LINK_PARAMS.opportunities]: idList(segments[1] ?? query.get('id') ?? query.get('ids')) });
    case 'ai':
      return home({ [LINK_PARAMS.aiTask]: segments[1] ?? query.get('task') ?? undefined });
  }
  const screen = SCREENS[path];
  if (!screen) return fallback ?? '/';
  if (screen === '/' && !rawQuery && fallback) return fallback;
  return rawQuery ? `${screen}?${rawQuery}` : screen;
}

/** Adres parametresindeki virgülle ayrılmış kimlikler. */
export function idsOf(params: URLSearchParams, key: string): string[] {
  return (params.get(key) ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

/** Verilen parametreleri adresten çıkarır (pencere kapanınca ya da odak bırakılınca). */
export function withoutParams(params: URLSearchParams, ...keys: string[]): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const key of keys) next.delete(key);
  return next;
}
