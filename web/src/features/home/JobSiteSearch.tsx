import { useQuery } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { extensionApi } from '@/api/extension';
import type { ExtensionSearch } from '@/api/types';
import { SEARCH_SOURCES, searchesOf, searchLabel } from '@/features/shared/extension-model';
import { Button } from '@/ui/Button';
import { Menu } from '@/ui/Menu';

const SEARCHES_QUERY = ['extension', 'searches'] as const;

const open = (search: ExtensionSearch) => window.open(search.url, '_blank', 'noopener');

/**
 * Profildeki unvan ve şehirlerle Kariyer.net / Indeed araması yeni sekmede açılır. Tarayıcı eklentisi kuruluysa o
 * sekmedeki sonuç sayfaları kendiliğinden aktarılır (adresin sonundaki #jt-import).
 */
export function JobSiteSearch() {
  const searches = useQuery({ queryKey: SEARCHES_QUERY, queryFn: extensionApi.searches, staleTime: 5 * 60_000 });
  if (!searches.data?.searches.length) return null;
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
    </div>
  );
}
