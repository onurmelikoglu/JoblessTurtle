import { useQuery } from '@tanstack/react-query';
import { ExternalLink, Layers } from 'lucide-react';
import { extensionApi } from '@/api/extension';
import type { ExtensionSearch } from '@/api/types';
import { extensionVersion, openAllUrls, SEARCH_SOURCES, searchesOf, searchLabel } from '@/features/shared/extension-model';
import { Button } from '@/ui/Button';
import { Menu, type MenuEntry } from '@/ui/Menu';
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
 * sekmedeki sonuç sayfaları kendiliğinden aktarılır (adresin sonundaki #jt-import). Firmalar çubuğunda yer kaplamasın
 * diye tek menü düğmesidir.
 */
export function JobSiteSearch() {
  const searches = useQuery({ queryKey: SEARCHES_QUERY, queryFn: extensionApi.searches, staleTime: 5 * 60_000 });
  if (!searches.data?.searches.length) return null;
  const all = openAllUrls(searches.data.searches);
  const items: MenuEntry[] = [];
  if (all.length > 1) items.push({ label: `Hepsini aç (${all.length} sekme)`, icon: <Layers className="size-4" aria-hidden />, onSelect: () => openAll(all) });
  for (const { source, button } of SEARCH_SOURCES) {
    const found = searchesOf(searches.data.searches, source);
    if (!found.length) continue;
    if (items.length) items.push('separator');
    items.push({ heading: button });
    const siteUrls = openAllUrls(found);
    if (found.length > 1) items.push({ label: `Tümünü aç (${siteUrls.length} sekme)`, icon: <Layers className="size-4" aria-hidden />, onSelect: () => openAll(siteUrls) });
    for (const search of found) items.push({ label: searchLabel(search), icon: <ExternalLink className="size-4" aria-hidden />, onSelect: () => open(search) });
  }
  return (
    <Menu
      align="end"
      items={items}
      trigger={
        <Button variant="outline" icon={<ExternalLink className="size-4" aria-hidden />} aria-label="İlan sitelerinde ara" title="Tarayıcı eklentisi kuruluysa açılan sekmedeki ilanlar buraya aktarılır (Profilim → Tarayıcı eklentisi)">
          <span className="max-sm:hidden">İlan sitelerinde ara</span>
        </Button>
      }
    />
  );
}
