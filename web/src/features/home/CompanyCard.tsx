import { ChevronDown, ChevronUp, CircleHelp, EllipsisVertical, ExternalLink, Lightbulb, MapPin, Users } from 'lucide-react';
import type { ApplyLink, HomeAnalysis, HomeCompany, HomeOpportunity } from '@/api/types';
import { cn } from '@/lib/cn';
import { Badge } from '@/ui/Badge';
import { Button, IconButton, LinkButton } from '@/ui/Button';
import { InlineBusy, Skeleton } from '@/ui/feedback';
import { Checkbox } from '@/ui/fields';
import { Menu } from '@/ui/Menu';
import { Panel } from '@/ui/Panel';
import { CATEGORY_INFO, CLASS_INFO, employeesHint, employeesLabel, hasEmail } from './model';

const ADDRESS_SOURCE_NOTE = /\s*\((kaynak|source):[^)]*\)/gi;
const MAX_OFFICES_SHOWN = 3;

export interface CompanyCardActions {
  onToggleSelect: (opportunityId: string) => void;
  onApply: (opportunity: HomeOpportunity) => void;
  onMarkApplied: (opportunity: HomeOpportunity) => void;
  onDismiss: (opportunity: HomeOpportunity) => void;
  onResearch: (companyId: string) => void;
  onToggleAnalysis: (companyId: string) => void;
}

interface CompanyCardProps extends CompanyCardActions {
  company: HomeCompany;
  showClass: boolean;
  selected: ReadonlySet<string>;
  applying: ReadonlySet<string>;
  researching: boolean;
  analysisOpen: boolean;
  busy: boolean;
}

function RegionBadge({ match }: { match: HomeCompany['regionMatch'] }) {
  if (match === 'yes') return <Badge tone="good" icon={<MapPin className="size-3" aria-hidden />}>Bölgende ofisi var</Badge>;
  if (match === 'no') return <Badge icon={<MapPin className="size-3" aria-hidden />}>Bölgende ofisi yok</Badge>;
  return <Badge icon={<CircleHelp className="size-3" aria-hidden />}>Ofis bilgisi yok</Badge>;
}

function Offices({ company, researching, onResearch }: { company: HomeCompany; researching: boolean; onResearch: () => void }) {
  if (company.offices.length === 0) {
    return (
      <div className="flex min-h-8 flex-wrap items-center gap-x-2 text-sm text-ink-soft">
        {researching ? (
          <InlineBusy>Ofis ve iletişim bilgisi aranıyor…</InlineBusy>
        ) : (
          <>
            Ofis adresi henüz bulunamadı.
            <button type="button" onClick={onResearch} className="font-medium text-brand hover:underline">
              Ofis bilgisini bul
            </button>
          </>
        )}
      </div>
    );
  }
  const shown = company.offices.slice(0, MAX_OFFICES_SHOWN);
  return (
    <ul className="flex flex-col gap-0.5 text-sm text-ink-soft">
      {shown.map((office) => {
        const place = [office.district, office.city].filter(Boolean).join(', ');
        const address = office.address?.replace(ADDRESS_SOURCE_NOTE, '').trim();
        return (
          <li key={office.id} className={cn('flex items-start gap-1.5', office.inRegion && 'font-medium text-ink')}>
            <MapPin className={cn('mt-0.5 size-3.5 shrink-0', office.inRegion ? 'text-good' : 'text-ink-faint')} aria-hidden />
            <span className="min-w-0 break-words">
              {office.label && office.label !== 'Ofis' ? `${office.label}: ` : ''}
              {place}
              {address ? ` — ${address}` : ''}
            </span>
          </li>
        );
      })}
      {company.offices.length > shown.length && <li className="pl-5 text-xs">+{company.offices.length - shown.length} ofis daha</li>}
    </ul>
  );
}

function Analysis({ analysis }: { analysis: HomeAnalysis }) {
  const parts: [string, string | null][] = [
    ['Firma', analysis.summary],
    ['Pozisyon açma potansiyeli', analysis.potential],
    ['Nasıl yaklaşmalısın', analysis.approach],
  ];
  return (
    <dl className="flex flex-col gap-2 rounded-lg bg-sunken p-3 text-sm">
      {parts.map(([label, text]) =>
        text ? (
          <div key={label}>
            <dt className="text-xs font-semibold text-ink-soft">{label}</dt>
            <dd>{text}</dd>
          </div>
        ) : null,
      )}
    </dl>
  );
}

function ResearchPlaceholder() {
  return (
    <div className="flex flex-col gap-2.5 border-t border-line px-4 py-3">
      <InlineBusy>AI bu firmayı araştırıyor: kariyer sayfası, ilgili ilanlar ve iletişim bilgileri bulunuyor. Bitince başvuru seçenekleri burada görünecek.</InlineBusy>
      <Skeleton className="h-3 w-1/2" />
      <Skeleton className="h-3 w-4/5" />
    </div>
  );
}

function statusText(o: HomeOpportunity, flags: { sending: boolean; emailSearching: boolean; hasChannel: boolean }): { text: string; problem: boolean } {
  const noEmail = !hasEmail(o);
  const plain = (text: string) => ({ text, problem: false });
  if (flags.sending) return plain('Başvuru sıraya alındı…');
  if (flags.emailSearching) return plain('Firmanın mail adresi aranıyor…');
  if (noEmail && o.manualRecipients > 0)
    return plain(`Firmanın İK ya da genel adresi bulunamadı; çalışan veya yönetimden ${o.manualRecipients} kişinin herkese açık iş adresi bulundu. Kullanmak için "Başvur"a bas ve önizlemede adresi kendin seç.`);
  if (noEmail && o.groupSuggestion) return plain(`Firmanın güncel mail adresi yok. Öneri: ${o.groupSuggestion.email} (${o.groupSuggestion.label}). ${o.groupSuggestion.note} Kullanmak için "Başvur"a bas ve önizlemede onayla.`);
  if (noEmail && flags.hasChannel) return plain('Mail adresi bulunamadı. Aşağıdaki kanaldan başvurup "Başvurdum" de; adresi biliyorsan "Başvur"da elle girebilirsin.');
  if (noEmail && o.emailSearchExhausted) return plain('Web araştırması ve doğrulamayla arandı; firma başvuru için e-posta yayımlamıyor. Firmanın sitesinden başvur ya da adresi biliyorsan "Başvur"da elle gir.');
  if (noEmail) return plain('Mail adresi bulunamadı. Menüden "Mail adresini ara"yı dene ya da adresi biliyorsan "Başvur"da elle gir.');
  if (!o.draft) return plain(o.title ? 'Başvur dediğinde yazın hazırlanıp önizlemeye gelir.' : 'Başvur dediğinde firmaya özel bir tanışma yazısı hazırlanıp önizlemeye gelir.');
  if (o.draft.problems.length) return { text: 'Yazı hazır; göndermeden önce kontrol etmen gereken bir nokta var.', problem: true };
  return plain('Yazı hazır.');
}

interface OpportunityRowProps {
  opportunity: HomeOpportunity;
  fallbackLinks: ApplyLink[];
  selected: boolean;
  sending: boolean;
  emailSearching: boolean;
  busy: boolean;
  actions: CompanyCardActions;
}

function OpportunityRow({ opportunity: o, fallbackLinks, selected, sending, emailSearching, busy, actions }: OpportunityRowProps) {
  const noEmail = !hasEmail(o);
  const channels = o.links.length ? o.links : noEmail ? fallbackLinks.filter((l) => l.kind === 'careers') : [];
  const status = statusText(o, { sending, emailSearching, hasChannel: channels.length > 0 });
  const category = CATEGORY_INFO[o.category];
  const name = o.title ?? 'Firmaya genel başvuru';
  return (
    <div className="flex flex-wrap items-start gap-x-3 gap-y-2 border-t border-line px-3 py-3 sm:px-4">
      <Checkbox className="mt-0.5" checked={selected} disabled={sending || noEmail} onChange={() => actions.onToggleSelect(o.id)} aria-label={`${o.company} · ${name} seç`} title={noEmail ? 'Mail adresi olmayan fırsat toplu başvuruya eklenemez' : undefined} />
      <div className="min-w-0 flex-1 basis-64">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h4 className="font-medium">{name}</h4>
          {o.title && category && <Badge tone={category.tone}>{category.tag}</Badge>}
          {o.scope === 'remote' && <Badge tone="info">Uzaktan</Badge>}
          {o.scope === 'abroad' && <Badge tone="info">Yurt dışı</Badge>}
          {o.fit === 'strong' && <Badge tone="good">Çok uygun</Badge>}
        </div>
        <p className="mt-0.5 text-sm text-ink-soft">{o.summary}</p>
        <p className={cn('mt-1.5 text-[13px]', status.problem ? 'text-bad' : 'text-ink-soft')}>{status.text}</p>
        {(channels.length > 0 || noEmail) && (
          <div className="mt-2 flex flex-wrap gap-2">
            {channels.map((link) => (
              <LinkButton key={link.url} href={link.url} size="sm" variant="outline" icon={<ExternalLink className="size-3.5" aria-hidden />}>
                {link.label}
              </LinkButton>
            ))}
            <Button size="sm" variant="ghost" disabled={busy || sending} onClick={() => actions.onMarkApplied(o)} title="Başka bir kanaldan başvurduysan işaretle; firma Başvurularım'a taşınır">
              Başvurdum
            </Button>
          </div>
        )}
      </div>
      <div className="ml-auto flex items-center gap-1">
        <Button variant="tonal" size="sm" disabled={busy || sending} onClick={() => actions.onApply(o)}>
          Başvur
        </Button>
        <Menu
          trigger={
            <IconButton label={`${o.company} için diğer işlemler`} size="sm">
              <EllipsisVertical className="size-4" aria-hidden />
            </IconButton>
          }
          items={[
            noEmail && !emailSearching && { label: 'Mail adresini ara', onSelect: () => actions.onResearch(o.companyId) },
            !noEmail && channels.length === 0 && { label: 'Kendim başvurdum, işaretle', onSelect: () => actions.onMarkApplied(o) },
            { label: 'İlgilenmiyorum, gizle', onSelect: () => actions.onDismiss(o), danger: true },
          ]}
        />
      </div>
    </div>
  );
}

export function CompanyCard({ company, showClass, selected, applying, researching, analysisOpen, busy, ...actions }: CompanyCardProps) {
  const waitingFirstResult = company.researching && company.opportunities.length === 0;
  return (
    <Panel padded={false} className="offscreen-lazy overflow-hidden">
      <div className="flex flex-col gap-2 px-3 py-3 sm:px-4">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <h3 className="text-base font-semibold break-words">{company.name}</h3>
          {showClass && <Badge tone={CLASS_INFO[company.class].tone}>{CLASS_INFO[company.class].short}</Badge>}
          <RegionBadge match={company.regionMatch} />
          {company.employees && (
            <Badge icon={<Users className="size-3" aria-hidden />} title={employeesHint(company.employees)}>
              {employeesLabel(company.employees)}
            </Badge>
          )}
          {company.matchingJobs > 1 && <span className="text-xs text-ink-soft">{company.matchingJobs} eşleşen ilan</span>}
          <div className="ml-auto flex items-center gap-1">
            {company.analysis && (
              <Button variant="ghost" size="sm" aria-expanded={analysisOpen} icon={analysisOpen ? <ChevronUp className="size-4" aria-hidden /> : <Lightbulb className="size-4" aria-hidden />} onClick={() => actions.onToggleAnalysis(company.id)}>
                <span className="max-sm:sr-only">{analysisOpen ? 'Analizi gizle' : 'Firma analizi'}</span>
                {!analysisOpen && <ChevronDown className="size-3.5 sm:hidden" aria-hidden />}
              </Button>
            )}
            {company.links.map((link) => (
              <LinkButton key={link.url} href={link.url} size="sm" variant="ghost" icon={<ExternalLink className="size-3.5" aria-hidden />}>
                {link.label}
              </LinkButton>
            ))}
          </div>
        </div>
        {company.sectors.length > 0 && <p className="text-xs text-ink-soft">{company.sectors.slice(0, 4).join(' · ')}</p>}
        <Offices company={company} researching={researching} onResearch={() => actions.onResearch(company.id)} />
        {analysisOpen && company.analysis && <Analysis analysis={company.analysis} />}
      </div>
      {waitingFirstResult && <ResearchPlaceholder />}
      {company.opportunities.map((opportunity) => (
        <OpportunityRow
          key={opportunity.id}
          opportunity={opportunity}
          fallbackLinks={company.links}
          selected={selected.has(opportunity.id)}
          sending={applying.has(opportunity.id)}
          emailSearching={researching && !hasEmail(opportunity)}
          busy={busy}
          actions={actions}
        />
      ))}
    </Panel>
  );
}
