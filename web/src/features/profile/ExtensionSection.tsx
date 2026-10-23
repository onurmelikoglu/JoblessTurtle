import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, Copy, Download, KeyRound, ShieldCheck, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { extensionApi } from '@/api/extension';
import { useAction } from '@/api/queries';
import { EXTENSION_DOWNLOAD, EXTENSION_STEPS, extensionVersion, keySummary, pairingCode } from '@/features/shared/extension-model';
import { extensionOutdated } from '@/features/setup/setup-model';
import { fmtDateTime } from '@/lib/format';
import { Button, LinkButton } from '@/ui/Button';
import { useConfirm } from '@/ui/confirm-context';
import { Notice } from '@/ui/Notice';
import { copyText } from './clipboard';
import { Loaded, Section, SubSection } from './parts';

const KEY_QUERY = ['extension', 'key'] as const;

/**
 * İlan sitelerinde açtığın arama sayfalarını aktaran Chrome eklentisinin kurulumu ve anahtarı. Anahtar, eklentiye
 * tek seferde yapıştırılan eşleştirme kodunun içinde yalnızca üretildiğinde bir kez gösterilir; sunucuda düz metni tutulmaz.
 */
export function ExtensionSection() {
  const client = useQueryClient();
  const status = useQuery({ queryKey: KEY_QUERY, queryFn: extensionApi.keyStatus });
  const { busy, run } = useAction();
  const confirm = useConfirm();
  const [created, setCreated] = useState<string | null>(null);
  const installed = extensionVersion();
  const appUrl = window.location.origin;
  const refresh = () => client.invalidateQueries({ queryKey: KEY_QUERY });

  const create = async (replacing: boolean) => {
    if (replacing && !(await confirm({ title: 'Yeni anahtar üretilsin mi?', message: 'Eski kod ve anahtar hemen geçersiz olur; eklentinin ayarlarına yeni kodu yapıştırman gerekir.', confirmLabel: 'Yeni kod üret' }))) return;
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
        Kariyer.net, Indeed ve Yenibiriş sunucudan gelen istekleri bot korumasıyla engelliyor. Eklenti (Kariyer.net, Indeed, Eleman.net, İşin Olsun, Secretcv, Yenibiriş), senin tarayıcında açtığın arama sonuç sayfasındaki ilanları okuyup buraya aktarır; siteye kendi başına istek atmaz, gezinmez, tıklamaz. Sayfada
        güvenlik doğrulaması çıkarsa aktarım yapılmaz, doğrulamayı tamamlayıp tekrar denersin.
      </p>
      <SubSection
        title="Kurulum"
        action={
          <LinkButton size="sm" href={EXTENSION_DOWNLOAD} download icon={<Download className="size-4" aria-hidden />}>
            Eklentiyi indir
          </LinkButton>
        }
      >
        {installed && (
          <p className="flex items-center gap-1.5 text-sm text-good">
            <CircleCheck className="size-4 shrink-0" aria-hidden />
            Eklenti bu tarayıcıda kurulu ve bu adresle eşleşmiş (sürüm {installed}).
          </p>
        )}
        {extensionOutdated(installed, __EXTENSION_VERSION__) && (
          <p className="text-sm text-warn">Yeni sürüm var ({__EXTENSION_VERSION__}). İndirip eski klasörün üzerine aç, sonra chrome://extensions sayfasında eklentiyi yenile.</p>
        )}
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          {EXTENSION_STEPS.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <p className="text-sm text-ink-soft">Firmalar sekmesindeki "Kariyer.net'te ara" ve "Indeed'de ara" bağlantılarıyla açılan sekmede her sonuç sayfası kendiliğinden aktarılır.</p>
      </SubSection>
      <SubSection title="Eşleştirme kodu">
        <Loaded query={status}>
          {(data) => (
            <div className="flex flex-col gap-3">
              <p className="text-sm">{keySummary(data, fmtDateTime)}</p>
              {created && (
                <Notice
                  icon={<ShieldCheck className="size-5 shrink-0" aria-hidden />}
                  action={
                    <Button size="sm" icon={<Copy className="size-4" aria-hidden />} onClick={() => void copyText(pairingCode(appUrl, created), 'Eşleştirme kodu panoya kopyalandı')}>
                      Kopyala
                    </Button>
                  }
                >
                  <span className="flex flex-col gap-1">
                    <span>Kodu eklenti ayarlarındaki Eşleştirme kodu alanına yapıştır; bu sayfadan çıkınca bir daha gösterilmez.</span>
                    <code className="font-mono text-xs break-all">{pairingCode(appUrl, created)}</code>
                    <span className="text-xs text-ink-soft">
                      Elle girmek istersen adres: {appUrl}, anahtar: <code className="font-mono break-all">{created}</code>
                    </span>
                  </span>
                </Notice>
              )}
              <div className="flex flex-wrap gap-2">
                <Button icon={<KeyRound className="size-4" aria-hidden />} disabled={busy} onClick={() => void create(data.exists)}>
                  {data.exists ? 'Yeni eşleştirme kodu üret' : 'Eşleştirme kodu üret'}
                </Button>
                {data.exists && (
                  <Button variant="danger" icon={<Trash2 className="size-4" aria-hidden />} disabled={busy} onClick={() => void revoke()}>
                    Eşleştirmeyi iptal et
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
