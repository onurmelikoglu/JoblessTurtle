import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, KeyRound, ShieldCheck, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { extensionApi } from '@/api/extension';
import { useAction } from '@/api/queries';
import { EXTENSION_STEPS, keySummary } from '@/features/shared/extension-model';
import { fmtDateTime } from '@/lib/format';
import { Button } from '@/ui/Button';
import { useConfirm } from '@/ui/confirm-context';
import { Notice } from '@/ui/Notice';
import { copyText } from './clipboard';
import { Loaded, Section, SubSection } from './parts';

const KEY_QUERY = ['extension', 'key'] as const;

/**
 * Kariyer.net ve Indeed'de açtığın arama sayfalarını aktaran Chrome eklentisinin kurulumu ve anahtarı. Anahtar
 * yalnızca üretildiğinde bir kez gösterilir; sunucuda düz metni tutulmaz.
 */
export function ExtensionSection() {
  const client = useQueryClient();
  const status = useQuery({ queryKey: KEY_QUERY, queryFn: extensionApi.keyStatus });
  const { busy, run } = useAction();
  const confirm = useConfirm();
  const [created, setCreated] = useState<string | null>(null);
  const refresh = () => client.invalidateQueries({ queryKey: KEY_QUERY });

  const create = async (replacing: boolean) => {
    if (replacing && !(await confirm({ title: 'Yeni anahtar üretilsin mi?', message: 'Eski anahtar hemen geçersiz olur; eklentinin ayarlarına yenisini girmen gerekir.', confirmLabel: 'Yeni anahtar üret' }))) return;
    const result = await run(() => extensionApi.createKey(), { refresh: false });
    if (!result) return;
    setCreated(result.key);
    await refresh();
  };

  const revoke = async () => {
    if (!(await confirm({ title: 'Anahtar iptal edilsin mi?', message: 'Eklenti bu anahtarla artık ilan aktaramaz.', confirmLabel: 'İptal et', danger: true }))) return;
    await run(() => extensionApi.revokeKey(), { refresh: false, success: 'Anahtar iptal edildi' });
    setCreated(null);
    await refresh();
  };

  return (
    <Section title="Tarayıcı eklentisi">
      <p className="text-sm text-ink-soft">
        Kariyer.net ve Indeed sunucudan gelen istekleri bot korumasıyla engelliyor. Eklenti, senin tarayıcında açtığın arama sonuç sayfasındaki ilanları okuyup buraya aktarır; siteye kendi başına istek atmaz, gezinmez, tıklamaz. Sayfada
        güvenlik doğrulaması çıkarsa aktarım yapılmaz, doğrulamayı tamamlayıp tekrar denersin.
      </p>
      <SubSection title="Kurulum">
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          {EXTENSION_STEPS.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <p className="text-sm text-ink-soft">Firmalar sekmesindeki "Kariyer.net'te ara" ve "Indeed'de ara" bağlantılarıyla açılan sekmede her sonuç sayfası kendiliğinden aktarılır.</p>
      </SubSection>
      <SubSection title="Eklenti anahtarı">
        <Loaded query={status}>
          {(data) => (
            <div className="flex flex-col gap-3">
              <p className="text-sm">{keySummary(data, fmtDateTime)}</p>
              {created && (
                <Notice
                  icon={<ShieldCheck className="size-5 shrink-0" aria-hidden />}
                  action={
                    <Button size="sm" icon={<Copy className="size-4" aria-hidden />} onClick={() => void copyText(created, 'Anahtar panoya kopyalandı')}>
                      Kopyala
                    </Button>
                  }
                >
                  <span className="flex flex-col gap-1">
                    <span>Anahtarı eklentinin ayarlarına gir; bu sayfadan çıkınca bir daha gösterilmez.</span>
                    <code className="font-mono text-xs break-all">{created}</code>
                  </span>
                </Notice>
              )}
              <div className="flex flex-wrap gap-2">
                <Button icon={<KeyRound className="size-4" aria-hidden />} disabled={busy} onClick={() => void create(data.exists)}>
                  {data.exists ? 'Yeni anahtar üret' : 'Anahtar üret'}
                </Button>
                {data.exists && (
                  <Button variant="danger" icon={<Trash2 className="size-4" aria-hidden />} disabled={busy} onClick={() => void revoke()}>
                    Anahtarı iptal et
                  </Button>
                )}
              </div>
            </div>
          )}
        </Loaded>
      </SubSection>
    </Section>
  );
}
