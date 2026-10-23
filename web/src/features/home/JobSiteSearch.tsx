import { useQuery } from '@tanstack/react-query';
import { ExternalLink, Layers } from 'lucide-react';
import { extensionApi } from '@/api/extension';
import type { ExtensionSearch } from '@/api/types';
import { extensionVersion, openAllUrls, SEARCH_SOURCES, searchesOf, searchLabel } from '@/features/shared/extension-model';
import { Button } from '@/ui/Button';
import { Menu } from '@/ui/Menu';
import { toast } from '@/ui/toast';

const SEARCHES_QUERY = ['extension', 'searches'] as const;
const OPEN_REQUEST = 'jt-open-searches';
const OPEN_RESULT = 'jt-open-searches-result';

const open = (search: ExtensionSearch) => window.open(search.url, '_blank', 'noopener');

/**
 * Bütün aramaları ayrı sekmelerde açar. Tarayıcı tek tıkla birden çok sekme açılmasını engellediği için sekmeleri
 * eklenti açar (uygulama sayfasındaki köprüsüne mesajla); eklenti yoksa yalnızca ilk arama açılır.
 */
function openAll(urls: string[]) {
  if (!extensionVersion()) {
    window.open(urls[0], '_blank', 'noopener');
    toast.warn("Tek tıkla hepsini açmak için tarayıcı eklentisi gerekiyor (Profilim › Tarayıcı eklentisi; kuruluysa chrome://extensions'ta yenile). Şimdilik ilk arama açıldı.");
    return;
  }
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const onResult = (event: MessageEvent) => {
    if (event.source !== window || event.data?.type !== OPEN_RESULT || event.data.id !== id) return;
    window.removeEventListener('message', onResult);
    if (event.data.ok) toast.success(`${event.data.opened} sekme açıldı; ilanlar sekmeler yüklendikçe aktarılır.`);
    else toast.error(event.data.message ?? 'Sekmeler açılamadı.');
  };
  window.addEventListener('message', onResult);
  window.postMessage({ type: OPEN_REQUEST, id, urls }, window.location.origin);
}

/**
 * Profildeki unvan ve şehirlerle Kariyer.net / Indeed araması yeni sekmede açılır. Tarayıcı eklentisi kuruluysa o
 * sekmedeki sonuç sayfaları kendiliğinden aktarılır (adresin sonundaki #jt-import).
 */
export function JobSiteSearch() {
  const searches = useQuery({ queryKey: SEARCHES_QUERY, queryFn: extensionApi.searches, staleTime: 5 * 60_000 });
  if (!searches.data?.searches.length) return null;
  const all = openAllUrls(searches.data.searches);
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm text-ink-soft">
      <span title="Tarayıcı eklentisi kuruluysa açılan sekmedeki ilanlar buraya aktarılır (Profilim → Tarayıcı eklentisi)">İlan sitelerinde ara:</span>
      {SEARCH_SOURCES.map(({ source, button }) => {
        const items = searchesOf(searches.data.searches, source);
        if (!items.length) return null;
        const trigger = (
          <Button variant="outline" size="sm" icon={<ExternalLink className="size-4" aria-hidden />} onClick={items.length === 1 ? () => open(items[0]) : undefined}>
            {button}
          </Button>
        );
        return items.length === 1 ? <span key={source}>{trigger}</span> : <Menu key={source} align="start" trigger={trigger} items={items.map((search) => ({ label: searchLabel(search), onSelect: () => open(search) }))} />;
      })}
      {all.length > 1 && (
        <Button variant="tonal" size="sm" icon={<Layers className="size-4" aria-hidden />} onClick={() => openAll(all)} title="Bütün pozisyon ve şehir aramaları ayrı sekmelerde açılır">
          Hepsini aç ({all.length} sekme)
        </Button>
      )}
    </div>
  );
}
