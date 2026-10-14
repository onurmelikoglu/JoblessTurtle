import { useState } from 'react';
import { homeApi } from '@/api/home';
import { useAction } from '@/api/queries';
import type { HomeSetup } from '@/api/types';
import { CITY_OPTIONS } from '@/features/shared/cities';
import { Button } from '@/ui/Button';
import { Field, Input, Switch, Textarea } from '@/ui/fields';
import { TagsInput } from '@/ui/TagsInput';
import { toast } from '@/ui/toast';
import { Section } from './parts';

interface AboutForm {
  name: string;
  headline: string;
  email: string;
  portfolio: string;
  signature: string;
  positions: string[];
  adjacentPositions: string[];
  cities: string[];
  allowRemote: boolean;
  abroadRemote: boolean;
  abroadRelocation: boolean;
  abroadRegions: string[];
}

function initialForm(setup: HomeSetup): AboutForm {
  const candidate = setup.candidate;
  return {
    name: candidate?.displayName ?? '',
    headline: candidate?.headline ?? '',
    email: candidate?.email ?? '',
    portfolio: candidate?.portfolioUrl ?? '',
    signature: candidate?.signature ?? '',
    positions: setup.positions,
    adjacentPositions: setup.adjacentPositions,
    cities: setup.cities,
    allowRemote: setup.allowRemote,
    abroadRemote: setup.abroadRemote,
    abroadRelocation: setup.abroadRelocation,
    abroadRegions: setup.abroadRegions,
  };
}

const ABROAD_REGION_OPTIONS = ['Almanya', 'Hollanda', 'İngiltere', 'İrlanda', 'İspanya', 'Portekiz', 'Polonya', 'İsveç', 'Estonya', 'Birleşik Arap Emirlikleri', 'Katar', 'Kanada'];

const orNull = (text: string) => text.trim() || null;

interface AboutSectionProps {
  setup: HomeSetup;
  onPolicy: (blocker: string | null) => void;
}

export function AboutSection({ setup, onPolicy }: AboutSectionProps) {
  const { busy, run } = useAction();
  const [form, setForm] = useState(() => initialForm(setup));
  const set =
    <K extends keyof AboutForm>(key: K) =>
    (value: AboutForm[K]) =>
      setForm((current) => ({ ...current, [key]: value }));

  const save = () => {
    if (!form.name.trim()) return toast.error('Adını gir');
    if (form.positions.length === 0) return toast.error('En az bir pozisyon ekle');
    void run(
      async () => {
        const saved = await homeApi.saveProfile({
          displayName: form.name.trim(),
          headline: orNull(form.headline),
          email: orNull(form.email),
          portfolioUrl: orNull(form.portfolio),
          signature: orNull(form.signature),
          positions: form.positions,
          adjacentPositions: form.adjacentPositions,
          cities: form.cities,
          allowRemote: form.allowRemote,
          abroadRemote: form.abroadRemote,
          abroadRelocation: form.abroadRelocation,
          abroadRegions: form.abroadRelocation ? form.abroadRegions : [],
        });
        onPolicy(saved.policyBlocker);
      },
      { success: 'Kaydedildi. Pozisyonlar ya da arama kapsamı değiştiyse arama yenileniyor.' },
    );
  };

  return (
    <Section title="Bilgilerin">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Ad soyad">{(props) => <Input {...props} autoComplete="name" value={form.name} onChange={(e) => set('name')(e.target.value)} />}</Field>
        <Field label="Unvanın">{(props) => <Input {...props} autoComplete="organization-title" value={form.headline} onChange={(e) => set('headline')(e.target.value)} />}</Field>
        <Field label="İletişim mail adresin">{(props) => <Input {...props} type="email" inputMode="email" autoComplete="email" value={form.email} onChange={(e) => set('email')(e.target.value)} />}</Field>
        <Field label="Portföy linki">{(props) => <Input {...props} type="url" inputMode="url" autoComplete="url" value={form.portfolio} onChange={(e) => set('portfolio')(e.target.value)} />}</Field>
      </div>
      <TagsInput label="Aradığın pozisyonlar" values={form.positions} onChange={set('positions')} />
      <TagsInput label="Yakın pozisyonlar" values={form.adjacentPositions} onChange={set('adjacentPositions')} hint="Pozisyonlarına göre AI önerir; istemediklerini silebilir, yenilerini ekleyebilirsin." />
      <TagsInput label="Şehirler" options={CITY_OPTIONS} values={form.cities} onChange={set('cities')} placeholder="Şehir ekle (yazarak ara)" hint="Birden fazla şehir seçebilirsin; İstanbul'da yalnızca bir yakayı da seçebilirsin." />
      <Switch checked={form.allowRemote} onChange={set('allowRemote')} label="Uzaktan çalışmaya da açığım" />
      <fieldset className="flex flex-col gap-3 rounded-lg border border-line p-3">
        <legend className="px-1 text-sm font-medium">Yurt dışı</legend>
        <Switch checked={form.abroadRemote} onChange={set('abroadRemote')} label="Yurt dışındaki firmaların Türkiye'den çalışılabilen uzaktan ilanlarını da ara" />
        <Switch checked={form.abroadRelocation} onChange={set('abroadRelocation')} label="Taşınmayı gerektiren yurt dışı ilanlarını da ara" />
        {form.abroadRelocation && (
          <TagsInput label="Tercih ettiğin ülke ya da şehirler" options={ABROAD_REGION_OPTIONS} values={form.abroadRegions} onChange={set('abroadRegions')} placeholder="Ülke ya da şehir ekle" hint="Boş bırakırsan Avrupa geneli aranır." />
        )}
      </fieldset>
      <Field label="Yazılarının sonundaki imza" hint={'Firmalara giden yazıları ana sayfada her firmanın "Başvur" önizlemesinde tek tek düzenleyebilirsin.'}>
        {(props) => <Textarea {...props} rows={3} placeholder={'Ad Soyad\nTelefon · LinkedIn'} value={form.signature} onChange={(e) => set('signature')(e.target.value)} />}
      </Field>
      <div className="flex justify-end">
        <Button variant="primary" loading={busy} onClick={save}>
          Kaydet
        </Button>
      </div>
    </Section>
  );
}
