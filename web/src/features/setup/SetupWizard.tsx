import { CircleCheck, Search } from 'lucide-react';
import { useState } from 'react';
import { homeApi, type DocumentType } from '@/api/home';
import { useAction } from '@/api/queries';
import type { HomeState, ProfileInput } from '@/api/types';
import { useMe } from '@/auth/session-context';
import { CITY_OPTIONS, DEFAULT_CITY } from '@/features/shared/cities';
import { DocumentRow } from '@/features/shared/DocumentRow';
import { DOCUMENT_LABELS } from '@/features/shared/documents';
import { MailConnectForm } from '@/features/shared/MailConnectForm';
import { cn } from '@/lib/cn';
import { Button } from '@/ui/Button';
import { Field, Input, Switch } from '@/ui/fields';
import { Panel } from '@/ui/Panel';
import { TagsInput } from '@/ui/TagsInput';
import { toast } from '@/ui/toast';

const STEPS = ['Seni tanıyalım', 'CV ve portföy', 'Aradığın pozisyonlar', 'Gönderim maili'] as const;
const ABOUT_STEP = 0;
const DOCUMENTS_STEP = 1;
const POSITIONS_STEP = 2;
const MAIL_STEP = 3;

function firstStep(missing: HomeState['setup']['missing']) {
  if (missing.includes('profile')) return ABOUT_STEP;
  if (missing.includes('cv')) return DOCUMENTS_STEP;
  return POSITIONS_STEP;
}

/** İlk kurulum: profil, CV, aranan pozisyonlar ve gönderim maili. Bitince arama kendiliğinden başlar. */
export function SetupWizard({ state }: { state: HomeState }) {
  const me = useMe();
  const { setup } = state;
  const { busy, run } = useAction();
  const [step, setStep] = useState(() => firstStep(setup.missing));
  const [about, setAbout] = useState(() => ({
    displayName: setup.candidate?.displayName ?? me.user.displayName,
    headline: setup.candidate?.headline ?? '',
    email: setup.candidate?.email ?? me.user.email,
    portfolioUrl: setup.candidate?.portfolioUrl ?? '',
  }));
  const [positions, setPositions] = useState(setup.positions);
  const [cities, setCities] = useState(setup.cities.length ? setup.cities : [DEFAULT_CITY]);
  const [allowRemote, setAllowRemote] = useState(setup.allowRemote);
  const [uploading, setUploading] = useState<DocumentType | null>(null);

  const profile = (): ProfileInput => ({
    displayName: about.displayName.trim(),
    email: about.email.trim() || null,
    headline: about.headline.trim() || null,
    portfolioUrl: about.portfolioUrl.trim() || null,
  });

  const saveAbout = async () => {
    if (!about.displayName.trim() || !about.headline.trim()) return toast.error('Adını ve unvanını gir');
    const saved = await run(() => homeApi.saveProfile(profile()));
    if (!saved) return;
    if (positions.length === 0) setPositions([about.headline.trim()]);
    setStep(DOCUMENTS_STEP);
  };

  const upload = async (type: DocumentType, file: File) => {
    const candidateId = setup.candidate?.id;
    if (!candidateId) return toast.error('Önce ilk adımdaki bilgilerini kaydet');
    setUploading(type);
    await run(() => homeApi.uploadDocument(candidateId, type, file), { success: `${DOCUMENT_LABELS[type]} yüklendi` });
    setUploading(null);
  };

  const finish = () => {
    if (positions.length === 0) return toast.error('En az bir pozisyon ekle');
    return run(() => homeApi.saveProfile({ ...profile(), positions, cities, allowRemote }), { success: 'Kurulum tamamlandı; arama başladı' });
  };

  const setField = (key: keyof typeof about) => (value: string) => setAbout((current) => ({ ...current, [key]: value }));
  const back = step > ABOUT_STEP && (
    <Button variant="ghost" disabled={busy} onClick={() => setStep(step - 1)}>
      Geri
    </Button>
  );

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <header>
        <h1 className="text-xl font-semibold">Hoş geldin! 4 kısa adımda kuruyoruz.</h1>
        <p className="text-sm text-ink-soft">Bitirdiğinde Jobless Turtle sana uygun firmaları ve ilanları kendisi aramaya başlar.</p>
      </header>
      <ol className="flex flex-wrap gap-2" aria-label="Kurulum adımları">
        {STEPS.map((label, index) => (
          <li key={label} aria-current={index === step ? 'step' : undefined} className={cn('flex items-center gap-2 rounded-full border px-3 py-1 text-[13px]', index === step ? 'border-brand bg-brand-soft font-medium text-brand-strong' : 'border-line text-ink-soft')}>
            <span className="flex size-5 items-center justify-center rounded-full bg-surface text-[11px] font-semibold">{index + 1}</span>
            {label}
          </li>
        ))}
      </ol>
      <Panel className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">{STEPS[step]}</h2>
        {step === ABOUT_STEP && (
          <>
            <Field label="Ad soyad">{(props) => <Input {...props} autoComplete="name" value={about.displayName} onChange={(e) => setField('displayName')(e.target.value)} />}</Field>
            <Field label="Unvanın">{(props) => <Input {...props} placeholder="Senior Flutter Developer" value={about.headline} onChange={(e) => setField('headline')(e.target.value)} />}</Field>
            <Field label="İletişim mail adresin">{(props) => <Input {...props} type="email" inputMode="email" autoComplete="email" value={about.email} onChange={(e) => setField('email')(e.target.value)} />}</Field>
            <Field label="Portföy linki (isteğe bağlı)">{(props) => <Input {...props} type="url" inputMode="url" placeholder="https://" value={about.portfolioUrl} onChange={(e) => setField('portfolioUrl')(e.target.value)} />}</Field>
            <div className="flex justify-end">
              <Button variant="primary" loading={busy} onClick={saveAbout}>
                Devam
              </Button>
            </div>
          </>
        )}
        {step === DOCUMENTS_STEP && (
          <>
            <div className="divide-y divide-line">
              <DocumentRow label="CV" document={setup.cv} uploading={uploading === 'cv'} disabled={busy} onPick={(file) => void upload('cv', file)} />
              <DocumentRow label="Portföy dosyası (isteğe bağlı)" document={setup.portfolio} uploading={uploading === 'portfolio'} disabled={busy} onPick={(file) => void upload('portfolio', file)} />
            </div>
            <p className="text-xs text-ink-soft">PDF, DOCX, PPTX veya görsel. Başvurularına otomatik eklenir.</p>
            <div className="flex justify-between">
              {back}
              <Button variant="primary" disabled={busy || !setup.cv} onClick={() => setStep(POSITIONS_STEP)}>
                Devam
              </Button>
            </div>
          </>
        )}
        {step === POSITIONS_STEP && (
          <>
            <TagsInput label="Aradığın pozisyonlar" values={positions} onChange={setPositions} hint="Örn. Flutter Developer, Mobile Developer. Yakın pozisyonları AI kendisi önerir." />
            <TagsInput label="Şehirler" values={cities} onChange={setCities} options={CITY_OPTIONS} placeholder="Şehir ekle (yazarak ara)" hint="Birden fazla şehir seçebilirsin; İstanbul'da yalnızca bir yakayı da seçebilirsin." />
            <Switch label="Uzaktan çalışmaya da açığım" checked={allowRemote} onChange={setAllowRemote} />
            <div className="flex justify-between">
              {back}
              <Button variant="primary" disabled={positions.length === 0} onClick={() => setStep(MAIL_STEP)}>
                Devam
              </Button>
            </div>
          </>
        )}
        {step === MAIL_STEP && (
          <>
            {setup.mailAccount ? (
              <p className="flex items-center gap-2 text-sm">
                <CircleCheck className="size-5 text-good" aria-hidden />
                {setup.mailAccount.accountEmail} bağlandı
              </p>
            ) : (
              <>
                <p className="text-sm text-ink-soft">Başvuruların bu adresten gönderilir. Yanıtlar da doğrudan bu adrese gelir.</p>
                <MailConnectForm
                  initialEmail={about.email.trim()}
                  onSubmit={async (input) => {
                    const candidateId = setup.candidate?.id;
                    if (!candidateId) throw new Error('Önce ilk adımdaki bilgilerini kaydet');
                    await homeApi.connectMail(candidateId, input);
                    await run(homeApi.state, { success: 'Mail hesabı bağlandı' });
                  }}
                />
              </>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-4">
              {back}
              <div className="flex flex-wrap gap-2">
                {!setup.mailAccount && (
                  <Button variant="ghost" disabled={busy} onClick={finish}>
                    Sonra bağlarım
                  </Button>
                )}
                <Button variant="primary" loading={busy} icon={<Search className="size-4" aria-hidden />} onClick={finish}>
                  Aramayı başlat
                </Button>
              </div>
            </div>
          </>
        )}
      </Panel>
    </div>
  );
}
