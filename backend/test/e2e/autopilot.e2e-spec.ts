import { ApplicationAttempt } from '@prisma/client';
import * as dns from 'dns';
import { resetEnvForTests } from '../../src/common/env';
import { MAILBOX_FULL_RETRY_DAYS } from '../../src/domain/autopilot';
import { AddressBookService } from '../../src/engine/address-book.service';
import { AiService } from '../../src/engine/ai/ai.service';
import { TEXT_PROVIDERS } from '../../src/engine/ai/providers';
import { AutopilotService } from '../../src/engine/autopilot.service';
import { InboxService } from '../../src/engine/inbox.service';
import * as smtpProbe from '../../src/engine/mail/smtp-probe';
import { IngestService } from '../../src/engine/ingest.service';
import { ResearchService } from '../../src/engine/research.service';
import { SendingService } from '../../src/engine/sending.service';
import { createDraft, createHarness, Harness, idem, resetDb, setupUser, User } from './harness';

let h: Harness;
let u: User;
let inbox: InboxService;
let autopilot: AutopilotService;
let research: ResearchService;
let serial = 0;

const DAY_MS = 86_400_000;
const workspaceId = () => u.candidate.workspaceId as string;

interface ContactSeed {
  email: string;
  verified?: boolean;
  kind?: string;
}

async function firm(name: string, contacts: ContactSeed[]) {
  const domain = `${name}.example`;
  const company = (await h.http().post('/api/v1/companies').set(u.auth).send({ name: `${name} ajans`, website: domain, sectors: ['kreatif ajans'], district: 'Kadıköy' }).expect(201)).body;
  for (const c of contacts) {
    const verified = c.verified !== false;
    await h.prisma.contactPoint.create({ data: { workspaceId: workspaceId(), companyId: company.id, email: c.email, kind: c.kind ?? 'official_hr', verifiedAt: verified ? new Date() : null, verifiedBy: verified ? 'source' : null, sourceUrl: `https://${domain}/kariyer` } });
  }
  await h.worker.drain();
  return company as { id: string; name: string };
}

const clearPacing = () => h.prisma.keyValue.deleteMany({ where: { key: { startsWith: 'send:pace:' } } });

async function send(companyId: string, toEmail: string, documentIds?: string[]) {
  const draft = await createDraft(h, u, companyId, null, documentIds ? { documentIds } : {});
  await h.http().patch(`/api/v1/drafts/${draft.id}`).set(u.auth).send({ revision: draft.currentRevision, toEmail }).expect(200);
  const fresh = await h.prisma.applicationDraft.findUniqueOrThrow({ where: { id: draft.id } });
  await clearPacing();
  const res = await h.http().post(`/api/v1/drafts/${fresh.id}/send`).set(u.auth).set('Idempotency-Key', idem()).send({ expectedRevision: fresh.currentRevision }).expect(202);
  await h.worker.drain();
  const attempt = await h.prisma.applicationAttempt.findUniqueOrThrow({ where: { id: res.body.applicationId } });
  expect(attempt.state).toBe('provider_accepted');
  return attempt;
}

/** Gelen kutusu taramasının yaptığını yapar: dönüşü kaydeder ve başvuruya etkilerini işler. */
async function returned(attempt: ApplicationAttempt, category: string, extra: { suggestedEmail?: string; suggestedUrl?: string; bodyText?: string; receivedAt?: Date } = {}) {
  const message = await h.prisma.inboundMessage.create({
    data: {
      workspaceId: attempt.workspaceId,
      mailAccountId: attempt.mailAccountId,
      attemptId: attempt.id,
      providerMessageId: `test-return-${++serial}`,
      fromEmail: 'mailer-daemon@posta.example',
      subject: 'Undeliverable',
      bodyText: extra.bodyText ?? 'İleti teslim edilemedi.',
      category,
      classification: 'bounce',
      suggestedEmail: extra.suggestedEmail ?? null,
      suggestedUrl: extra.suggestedUrl ?? null,
      status: 'open',
      source: 'imap',
      receivedAt: extra.receivedAt ?? new Date(),
    },
  });
  await (inbox as any).applyEffects({ id: attempt.id }, category, extra.suggestedEmail ?? null);
  return message;
}

async function setAutoSend(on: boolean, sendImmediately = true) {
  await h.prisma.automationPolicy.deleteMany({ where: { workspaceId: workspaceId() } });
  if (!on) return;
  await h.prisma.automationPolicy.create({
    data: { workspaceId: workspaceId(), candidateId: u.candidate.id, searchProfileId: u.profile.id, mailAccountId: u.account.id, name: 'Otomatik başvuru', active: true, autoSend: true, sendImmediately },
  });
}

const actionOf = (messageId: string) => h.prisma.autopilotAction.findUniqueOrThrow({ where: { inboundMessageId: messageId } });
const retryOf = (attemptId: string) => h.prisma.applicationAttempt.findFirst({ where: { retryOfId: attemptId }, orderBy: { createdAt: 'desc' } });
const messageOf = (id: string) => h.prisma.inboundMessage.findUniqueOrThrow({ where: { id } });

async function sentContent(attempt: ApplicationAttempt) {
  return h.prisma.draftRevision.findUniqueOrThrow({ where: { draftId_revision: { draftId: attempt.draftId, revision: attempt.draftRevision } } });
}

function aiAnswers(output: (req: any) => unknown) {
  return jest.spyOn(h.app.get(AiService), 'run').mockImplementation(async (req) => ({ status: 'succeeded', output: output(req), provider: 'cli_codex', taskId: `fake-${req.kind}`, cached: false }));
}

beforeAll(async () => {
  h = await createHarness();
  await resetDb(h.prisma);
  inbox = h.app.get(InboxService);
  autopilot = h.app.get(AutopilotService);
  research = h.app.get(ResearchService);
  u = await setupUser(h, 'otopilot');
  await h.prisma.mailAccount.update({ where: { id: u.account.id }, data: { dailyLimit: 500 } });
  await h.worker.drain();
});

afterAll(async () => {
  await h.close();
});

afterEach(async () => {
  jest.restoreAllMocks();
  await setAutoSend(false);
  await h.prisma.workspace.update({ where: { id: workspaceId() }, data: { automationPaused: false } });
});

describe('otopilot: "Otomatik başvur" açıkken geri dönen başvuru kendiliğinden düzeltilir', () => {
  it('adres geçersizse aynı yazı firmanın doğrulanmış sıradaki adresine gider', async () => {
    const company = await firm('siradaki', [{ email: 'kariyer@siradaki.example' }, { email: 'ik@siradaki.example' }, { email: 'info@siradaki.example', kind: 'general', verified: false }]);
    const first = await send(company.id, 'kariyer@siradaki.example');
    await setAutoSend(true);
    const message = await returned(first, 'bad_address');
    const ai = jest.spyOn(h.app.get(AiService), 'run');
    await clearPacing();
    expect(await autopilot.onInbound(message.id)).toEqual({ status: 'recorded', state: 'executed' });
    expect(ai).not.toHaveBeenCalled();
    const retry = (await retryOf(first.id))!;
    expect(retry).toMatchObject({ toEmail: 'ik@siradaki.example', sendMode: 'autopilot', state: 'queued', createdById: null });
    expect(await actionOf(message.id)).toMatchObject({ step: 'resend', state: 'executed', mode: 'auto', toEmail: 'ik@siradaki.example', resultAttemptId: retry.id, aiTasks: 0 });
    expect((await messageOf(message.id)).status).toBe('resent');
    await h.worker.drain();
    expect((await h.prisma.applicationAttempt.findUniqueOrThrow({ where: { id: retry.id } })).state).toBe('provider_accepted');
    const [before, after] = await Promise.all([sentContent(first), sentContent(retry)]);
    expect([after.subject, after.body, after.documentIds]).toEqual([before.subject, before.body, before.documentIds]);
    const notes = (await h.http().get('/api/v1/notifications').set(u.auth).expect(200)).body;
    expect(notes.find((n: any) => n.type === 'autopilot').title).toBe('Otopilot: siradaki ajans başvurusu yeniden gönderiliyor');
  });

  it('gönderim penceresi dışındaysa düzeltme pencerenin başına planlanır', async () => {
    const company = await firm('pencere', [{ email: 'kariyer@pencere.example' }, { email: 'ik@pencere.example' }]);
    const first = await send(company.id, 'kariyer@pencere.example');
    await setAutoSend(true, false);
    await h.prisma.automationPolicy.updateMany({ where: { workspaceId: workspaceId() }, data: { sendWindowStart: '00:00', sendWindowEnd: '00:01', sendDays: [1, 2, 3, 4, 5, 6, 7] } });
    const message = await returned(first, 'closed_address');
    await autopilot.onInbound(message.id);
    const retry = (await retryOf(first.id))!;
    expect(retry.state).toBe('queued');
    expect(retry.scheduledAt!.getTime()).toBeGreaterThan(Date.now());
    expect(retry.scheduledAt!.getTime()).toBeLessThan(Date.now() + DAY_MS + 60_000);
    const overview = (await h.http().get('/api/v1/home/inbox').set(u.auth).expect(200)).body.autopilot;
    expect(overview.actions.find((a: any) => a.messageId === message.id)).toMatchObject({ state: 'executed', retry: { id: retry.id, state: 'queued' } });
  });

  it('firmanın bildirdiği adres İK adresiyse başvuru o adrese gider', async () => {
    const company = await firm('tasinan', [{ email: 'kariyer@tasinan.example' }]);
    const first = await send(company.id, 'kariyer@tasinan.example');
    await setAutoSend(true);
    const message = await returned(first, 'address_changed', { suggestedEmail: 'ik@tasinan.example', bodyText: 'Bu adres artık kullanılmamaktadır. Lütfen ik@tasinan.example adresine yazınız.' });
    await clearPacing();
    await autopilot.onInbound(message.id);
    expect(await retryOf(first.id)).toMatchObject({ toEmail: 'ik@tasinan.example', sendMode: 'autopilot' });
  });

  it('ekler alıcının sınırını aştıysa yalnızca CV ile aynı adrese gider', async () => {
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1');
    const portfolio = (await h.http().post('/api/v1/documents').set(u.auth).field('candidateId', u.candidate.id).field('type', 'portfolio').field('language', 'tr').attach('file', pdf, 'portfolyo.pdf').expect(201)).body;
    const company = await firm('buyukek', [{ email: 'kariyer@buyukek.example' }]);
    const first = await send(company.id, 'kariyer@buyukek.example', [u.doc.id, portfolio.id]);
    await setAutoSend(true);
    const message = await returned(first, 'too_large');
    await clearPacing();
    await autopilot.onInbound(message.id);
    const retry = (await retryOf(first.id))!;
    expect(retry.toEmail).toBe('kariyer@buyukek.example');
    expect((await sentContent(retry)).documentIds).toEqual([u.doc.id]);
    expect((await actionOf(message.id)).detail).toContain('yalnızca CV');
  });

  it('kutu doluysa üç gün sonra aynı adrese, yine doluysa diğer adrese gider', async () => {
    const company = await firm('dolukutu', [{ email: 'kariyer@dolukutu.example' }, { email: 'ik@dolukutu.example' }]);
    const first = await send(company.id, 'kariyer@dolukutu.example');
    await setAutoSend(true);
    const message = await returned(first, 'mailbox_full');
    await autopilot.onInbound(message.id);
    const retry = (await retryOf(first.id))!;
    expect(retry.toEmail).toBe('kariyer@dolukutu.example');
    expect(retry.scheduledAt!.getTime()).toBeGreaterThanOrEqual(Date.now() + MAILBOX_FULL_RETRY_DAYS * DAY_MS - 60_000);
    await h.prisma.applicationAttempt.update({ where: { id: retry.id }, data: { state: 'provider_accepted', acceptedAt: new Date(), scheduledAt: null } });
    const again = await returned(retry, 'mailbox_full');
    await clearPacing();
    await autopilot.onInbound(again.id);
    expect(await retryOf(retry.id)).toMatchObject({ toEmail: 'ik@dolukutu.example', sendMode: 'autopilot' });
  });

  it('bilinen başka adres yoksa geçersiz adres dışında yeni adres aranır ve bulunana gönderilir', async () => {
    const company = await firm('arayan', [{ email: 'kariyer@arayan.example' }]);
    const first = await send(company.id, 'kariyer@arayan.example');
    await setAutoSend(true);
    const message = await returned(first, 'bad_address');
    const ai = aiAnswers(() => ({ contacts: [{ email: 'ik@arayan.example', sourceUrl: 'https://arayan.example/kariyer', purpose: 'hr' }], offices: [] }));
    await clearPacing();
    await autopilot.onInbound(message.id);
    expect(ai.mock.calls.map((c) => c[0].kind)).toEqual(['company_contacts', 'contact_review']);
    expect(ai.mock.calls[0][0]).toMatchObject({ kind: 'company_contacts', input: { avoidEmails: ['kariyer@arayan.example'] } });
    expect(await retryOf(first.id)).toMatchObject({ toEmail: 'ik@arayan.example', sendMode: 'autopilot' });
    expect((await h.prisma.company.findUniqueOrThrow({ where: { id: company.id } })).researchMeta).toMatchObject({ contactsDepth: 'max' });
  });

  it('arama sonuçsuzsa durur, kullanıcıya diğer kanalları söyler ve aynı firma için yeniden aramaz', async () => {
    const company = await firm('adressiz', [{ email: 'kariyer@adressiz.example' }]);
    const first = await send(company.id, 'kariyer@adressiz.example');
    await setAutoSend(true);
    const message = await returned(first, 'bad_address');
    const ai = aiAnswers(() => ({ contacts: [], offices: [] }));
    await autopilot.onInbound(message.id);
    expect(ai).toHaveBeenCalledTimes(1);
    expect(await retryOf(first.id)).toBeNull();
    expect(await actionOf(message.id)).toMatchObject({ step: 'stop', state: 'info' });
    expect((await actionOf(message.id)).detail).toContain('bulunamadı');
    expect((await messageOf(message.id)).status).toBe('open');
    expect(await research.findDetails(company.id, null, { deep: true, since: message.receivedAt })).toEqual({ status: 'skipped', reason: 'exhausted' });
    expect(ai).toHaveBeenCalledTimes(1);
    const home = (await h.http().get('/api/v1/home/companies').set(u.auth).expect(200)).body;
    const listed = home.companies.find((c: any) => c.id === company.id);
    if (listed) expect(listed.opportunities.every((o: any) => o.emailSearchExhausted)).toBe(true);
  });

  it('firma biçim istediyse yazı talimata göre düzeltilip aynı adrese gider', async () => {
    const company = await firm('bicimci', [{ email: 'kariyer@bicimci.example' }]);
    const first = await send(company.id, 'kariyer@bicimci.example');
    await setAutoSend(true);
    const message = await returned(first, 'format_issue', { bodyText: 'Başvurunuz işleme alınamadı. Konu satırına "REF-2026" yazarak yeniden gönderiniz.' });
    const ai = aiAnswers((req) => ({ action: 'resend', toEmail: req.input.sentTo, subject: 'REF-2026 Açık Başvuru', body: null, attachments: 'all', reason: 'Konu satırına firmanın istediği referans eklendi.' }));
    await clearPacing();
    await autopilot.onInbound(message.id);
    expect(ai.mock.calls.map((c) => c[0].kind)).toEqual(['inbound_fix']);
    const retry = (await retryOf(first.id))!;
    expect(retry).toMatchObject({ toEmail: 'kariyer@bicimci.example', sendMode: 'autopilot' });
    expect(await sentContent(retry)).toMatchObject({ subject: 'REF-2026 Açık Başvuru', generator: 'ai:autopilot' });
    expect(await actionOf(message.id)).toMatchObject({ step: 'resend', state: 'executed' });
  });

  it('kariyer sitesi isteyen firmaya mail yeniden gönderilmez', async () => {
    const company = await firm('portalci', [{ email: 'kariyer@portalci.example' }, { email: 'ik@portalci.example' }]);
    const first = await send(company.id, 'kariyer@portalci.example');
    await setAutoSend(true);
    const message = await returned(first, 'apply_elsewhere', { suggestedUrl: 'https://portalci.example/kariyer/basvuru' });
    await autopilot.onInbound(message.id);
    expect(await retryOf(first.id)).toBeNull();
    expect(await actionOf(message.id)).toMatchObject({ step: 'use_link', state: 'info' });
    expect((await messageOf(message.id)).status).toBe('open');
  });

  it('bir başvuru iki otomatik düzeltmeden sonra kullanıcıya bırakılır', async () => {
    const company = await firm('inatci', [{ email: 'a@inatci.example' }, { email: 'b@inatci.example' }, { email: 'c@inatci.example' }, { email: 'd@inatci.example' }]);
    let attempt = await send(company.id, 'a@inatci.example');
    await setAutoSend(true);
    for (const expected of ['b@inatci.example', 'c@inatci.example']) {
      const message = await returned(attempt, 'bad_address');
      await clearPacing();
      await autopilot.onInbound(message.id);
      await h.worker.drain();
      attempt = (await retryOf(attempt.id))!;
      expect(attempt).toMatchObject({ toEmail: expected, state: 'provider_accepted', sendMode: 'autopilot' });
    }
    const third = await returned(attempt, 'bad_address');
    await autopilot.onInbound(third.id);
    expect(await retryOf(attempt.id)).toBeNull();
    expect(await actionOf(third.id)).toMatchObject({ step: 'stop', state: 'info' });
  });

  it('sıradaki adres doğrulanmamışsa kendiliğinden gönderilmez; onaya düşer', async () => {
    const company = await firm('teyitsiz', [{ email: 'kariyer@teyitsiz.example' }, { email: 'info@teyitsiz.example', kind: 'general', verified: false }]);
    const first = await send(company.id, 'kariyer@teyitsiz.example');
    await setAutoSend(true);
    const message = await returned(first, 'bad_address');
    await autopilot.onInbound(message.id);
    expect(await retryOf(first.id)).toBeNull();
    const action = await actionOf(message.id);
    expect(action).toMatchObject({ step: 'resend', state: 'proposed', toEmail: 'info@teyitsiz.example' });
    expect(action.detail).toContain('genel iletişim adresi');
    expect(action.detail).toContain('Onaylarsan gönderilir');
    await clearPacing();
    await h.http().post('/api/v1/home/autopilot/approve').set(u.auth).send({ ids: [action.id] }).expect(201);
    await h.worker.drain();
    expect(await retryOf(first.id)).toMatchObject({ toEmail: 'info@teyitsiz.example', sendMode: 'manual', state: 'provider_accepted' });
    expect(await actionOf(message.id)).toMatchObject({ state: 'executed', mode: 'approved' });
  });

  it('düzeltme sıradayken "Otomatik başvur" kapatılırsa gönderilmez ve öneriye döner', async () => {
    const company = await firm('vazgecen', [{ email: 'kariyer@vazgecen.example' }, { email: 'ik@vazgecen.example' }]);
    const first = await send(company.id, 'kariyer@vazgecen.example');
    await setAutoSend(true);
    const message = await returned(first, 'bad_address');
    await clearPacing();
    await autopilot.onInbound(message.id);
    const retry = (await retryOf(first.id))!;
    await setAutoSend(false);
    await h.worker.drain();
    expect(await h.prisma.applicationAttempt.findUniqueOrThrow({ where: { id: retry.id } })).toMatchObject({ state: 'cancelled', stateReason: 'AUTOPILOT_OFF' });
    expect((await messageOf(message.id)).status).toBe('open');
    expect(await actionOf(message.id)).toMatchObject({ state: 'proposed', resultAttemptId: null, toEmail: 'ik@vazgecen.example' });
  });

  it('acil durdurma açıkken hiçbir düzeltme kendiliğinden gitmez', async () => {
    const company = await firm('durduran', [{ email: 'kariyer@durduran.example' }, { email: 'ik@durduran.example' }]);
    const first = await send(company.id, 'kariyer@durduran.example');
    await setAutoSend(true);
    await h.prisma.workspace.update({ where: { id: workspaceId() }, data: { automationPaused: true } });
    const message = await returned(first, 'bad_address');
    await autopilot.onInbound(message.id);
    expect(await retryOf(first.id)).toBeNull();
    expect(await actionOf(message.id)).toMatchObject({ state: 'proposed', toEmail: 'ik@durduran.example' });
    expect((await h.http().get('/api/v1/home/inbox').set(u.auth).expect(200)).body.autopilot.mode).toBe('stopped');
  });
});

describe('otopilot: "Otomatik başvur" kapalıyken düzeltmeler onaya düşer', () => {
  it('öneri kaydedilir; onaylanınca hemen gönderilir', async () => {
    const company = await firm('onayli', [{ email: 'kariyer@onayli.example' }, { email: 'ik@onayli.example' }]);
    const first = await send(company.id, 'kariyer@onayli.example');
    const message = await returned(first, 'bad_address');
    expect(await autopilot.onInbound(message.id)).toEqual({ status: 'recorded', state: 'proposed' });
    expect(await retryOf(first.id)).toBeNull();
    const inboxView = (await h.http().get('/api/v1/home/inbox').set(u.auth).expect(200)).body;
    expect(inboxView.autopilot).toMatchObject({ mode: 'approval' });
    const item = inboxView.autopilot.actions.find((a: any) => a.messageId === message.id);
    expect(item).toMatchObject({ company: 'onayli ajans', label: 'Adres bulunamadı', step: 'resend', state: 'proposed', toEmail: 'ik@onayli.example', usesAi: false, retry: null });
    expect(inboxView.autopilot.pending).toBeGreaterThanOrEqual(1);
    await clearPacing();
    expect((await h.http().post('/api/v1/home/autopilot/approve').set(u.auth).send({ ids: [item.id] }).expect(201)).body).toEqual({ queued: 1 });
    expect((await actionOf(message.id)).state).toBe('running');
    await h.worker.drain();
    const retry = (await retryOf(first.id))!;
    expect(retry).toMatchObject({ toEmail: 'ik@onayli.example', sendMode: 'manual', state: 'provider_accepted', scheduledAt: null });
    expect(await actionOf(message.id)).toMatchObject({ state: 'executed', mode: 'approved', decidedById: retry.createdById });
  });

  it('gelişte adres araması yapılır, bulunan adres onaya sunulur', async () => {
    const company = await firm('onayarama', [{ email: 'kariyer@onayarama.example' }]);
    const first = await send(company.id, 'kariyer@onayarama.example');
    const message = await returned(first, 'closed_address');
    const ai = aiAnswers(() => ({ contacts: [{ email: 'ik@onayarama.example', sourceUrl: 'https://onayarama.example/kariyer', purpose: 'hr' }], offices: [] }));
    await autopilot.onInbound(message.id);
    expect(ai.mock.calls.map((c) => c[0].kind)).toEqual(['company_contacts', 'contact_review']);
    expect(await retryOf(first.id)).toBeNull();
    expect(await actionOf(message.id)).toMatchObject({ step: 'resend', state: 'proposed', toEmail: 'ik@onayarama.example' });
  });

  it('vazgeçilen öneri uygulanmaz; elle yeniden gönderim ve "çözüldü" işareti öneriyi kapatır', async () => {
    const company = await firm('vazgec', [{ email: 'kariyer@vazgec.example' }, { email: 'ik@vazgec.example' }]);
    const first = await send(company.id, 'kariyer@vazgec.example');
    const message = await returned(first, 'bad_address');
    await autopilot.onInbound(message.id);
    const action = await actionOf(message.id);
    expect((await h.http().post('/api/v1/home/autopilot/dismiss').set(u.auth).send({ ids: [action.id] }).expect(201)).body).toEqual({ dismissed: 1 });
    expect((await h.http().post('/api/v1/home/autopilot/approve').set(u.auth).send({ ids: [action.id] }).expect(201)).body).toEqual({ queued: 0 });
    const overview = (await h.http().get('/api/v1/home/inbox').set(u.auth).expect(200)).body.autopilot;
    expect(overview.actions.some((a: any) => a.id === action.id)).toBe(false);

    const other = await firm('elle', [{ email: 'kariyer@elle.example' }, { email: 'ik@elle.example' }]);
    const sent = await send(other.id, 'kariyer@elle.example');
    const bounce = await returned(sent, 'bad_address');
    await autopilot.onInbound(bounce.id);
    await clearPacing();
    await h.http().post(`/api/v1/home/applications/${sent.id}/resend`).set(u.auth).send({ toEmail: 'ik@elle.example', subject: 'Açık Başvuru', body: 'Merhaba, başvurumu yeniden iletiyorum. İyi çalışmalar.' }).expect(201);
    expect((await actionOf(bounce.id)).state).toBe('dismissed');

    const third = await firm('cozuldu', [{ email: 'kariyer@cozuldu.example' }, { email: 'ik@cozuldu.example' }]);
    const thirdSent = await send(third.id, 'kariyer@cozuldu.example');
    const thirdBounce = await returned(thirdSent, 'bad_address');
    await autopilot.onInbound(thirdBounce.id);
    await h.http().post('/api/v1/home/inbox/status').set(u.auth).send({ ids: [thirdBounce.id], status: 'resolved' }).expect(201);
    expect((await actionOf(thirdBounce.id)).state).toBe('dismissed');
  });

  it('nedeni belirsiz dönüş yapay zekâ harcanmadan onaya sunulur; onaylanınca yapay zekâ karar verir', async () => {
    const company = await firm('belirsiz', [{ email: 'kariyer@belirsiz.example' }, { email: 'ik@belirsiz.example' }]);
    const first = await send(company.id, 'kariyer@belirsiz.example');
    await setAutoSend(true);
    const message = await returned(first, 'rejected', { bodyText: '550 5.7.1 Message rejected due to content policy.' });
    const ai = aiAnswers(() => ({ action: 'resend', toEmail: 'ik@belirsiz.example', subject: null, body: null, attachments: 'cv_only', reason: 'Alıcı sunucu içeriği reddetti; diğer adrese yalnızca CV ile gönderilecek.' }));
    await autopilot.onInbound(message.id);
    expect(ai).not.toHaveBeenCalled();
    const action = await actionOf(message.id);
    expect(action).toMatchObject({ step: 'ai_review', state: 'proposed' });
    const listed = (await h.http().get('/api/v1/home/inbox').set(u.auth).expect(200)).body.autopilot.actions.find((a: any) => a.id === action.id);
    expect(listed.usesAi).toBe(true);
    await clearPacing();
    await h.http().post('/api/v1/home/autopilot/approve').set(u.auth).send({ ids: [action.id] }).expect(201);
    await h.worker.drain();
    expect(ai.mock.calls.map((c) => c[0].kind)).toEqual(['inbound_fix']);
    expect(await retryOf(first.id)).toMatchObject({ toEmail: 'ik@belirsiz.example', sendMode: 'manual' });
    expect((await actionOf(message.id)).detail).toContain('yalnızca CV eklendi');
  });

  it('yapay zekâ "düzeltilemez" derse gönderim yapılmaz', async () => {
    const company = await firm('duzelmez', [{ email: 'kariyer@duzelmez.example' }]);
    const first = await send(company.id, 'kariyer@duzelmez.example');
    const message = await returned(first, 'unknown', { bodyText: 'Talebiniz ilgili birime iletilmiştir.' });
    await autopilot.onInbound(message.id);
    const action = await actionOf(message.id);
    aiAnswers(() => ({ action: 'skip', toEmail: null, subject: null, body: null, attachments: 'all', reason: 'Firma başvuruyu aldığını bildiriyor; yeniden göndermeye gerek yok.' }));
    await h.http().post('/api/v1/home/autopilot/approve').set(u.auth).send({ ids: [action.id] }).expect(201);
    await h.worker.drain();
    expect(await retryOf(first.id)).toBeNull();
    expect(await actionOf(message.id)).toMatchObject({ state: 'info', detail: 'Firma başvuruyu aldığını bildiriyor; yeniden göndermeye gerek yok.' });
  });
});

describe('otopilot: gelen kutusundan günlüğe', () => {
  it('geri dönme bildirimi kaydedilince karar arka planda kendiliğinden verilir', async () => {
    const company = await firm('zincir', [{ email: 'kariyer@zincir.example' }, { email: 'ik@zincir.example' }]);
    const first = await send(company.id, 'kariyer@zincir.example');
    await setAutoSend(true);
    const account = await h.prisma.mailAccount.findUniqueOrThrow({ where: { id: u.account.id } });
    const mail = {
      messageId: '<bounce-zincir@posta.example>',
      date: new Date(),
      fromEmail: 'mailer-daemon@googlemail.com',
      fromName: 'Mail Delivery Subsystem',
      subject: 'Delivery Status Notification (Failure)',
      text: 'Address not found\nFinal-Recipient: rfc822; kariyer@zincir.example\nStatus: 5.1.1\nDiagnostic-Code: smtp; 550 5.1.1 The email account that you tried to reach does not exist.',
      headers: {},
      contentType: 'multipart/report; report-type=delivery-status',
      raw: '',
      dsn: '',
    };
    expect(await (inbox as any).store(account, first, mail, null)).toBe('bad_address');
    await clearPacing();
    await h.worker.drain();
    expect(await retryOf(first.id)).toMatchObject({ toEmail: 'ik@zincir.example', sendMode: 'autopilot', state: 'provider_accepted' });
    expect((await h.prisma.applicationAttempt.findUniqueOrThrow({ where: { id: first.id } })).state).toBe('bounced');
  });

  it('otomatik yanıt kuralla tanınır, yapay zekâya sorulmaz; içinde bağlantı varsa sorulur', async () => {
    const company = await firm('otoyanit', [{ email: 'kariyer@otoyanit.example' }]);
    const first = await send(company.id, 'kariyer@otoyanit.example');
    const ai = jest.spyOn(h.app.get(AiService), 'run');
    const base = { messageId: null, date: new Date(), fromEmail: 'kariyer@otoyanit.example', fromName: 'İK', subject: 'Otomatik yanıt: Başvurunuz', headers: { 'auto-submitted': 'auto-replied' }, contentType: 'text/plain', raw: '', dsn: '' };
    expect(await (inbox as any).review(first, { ...base, text: 'Başvurunuz bize ulaşmıştır. Teşekkür ederiz.' })).toMatchObject({ category: 'auto_reply', suggestedUrl: null });
    expect(ai).not.toHaveBeenCalled();
    await (inbox as any).review(first, { ...base, text: 'Başvurunuz bize ulaşmıştır. Açık pozisyonlar: https://otoyanit.example/kariyer' });
    expect(ai).toHaveBeenCalledTimes(1);
  });

  it('karar verilmemiş eski dönüşler için yapay zekâ harcamadan öneri hazırlanır', async () => {
    const company = await firm('eski', [{ email: 'kariyer@eski.example' }, { email: 'ik@eski.example' }]);
    const first = await send(company.id, 'kariyer@eski.example');
    const lonely = await firm('eskiyalniz', [{ email: 'kariyer@eskiyalniz.example' }]);
    const second = await send(lonely.id, 'kariyer@eskiyalniz.example');
    const stale = await firm('cokeski', [{ email: 'kariyer@cokeski.example' }, { email: 'ik@cokeski.example' }]);
    const third = await send(stale.id, 'kariyer@cokeski.example');
    await setAutoSend(true);
    const withAlternative = await returned(first, 'bad_address');
    const needsSearch = await returned(second, 'bad_address');
    const tooOld = await returned(third, 'bad_address', { receivedAt: new Date(Date.now() - 60 * DAY_MS) });
    const ai = jest.spyOn(h.app.get(AiService), 'run');
    const result = await autopilot.sweep(workspaceId());
    expect(result.proposed).toBeGreaterThanOrEqual(2);
    expect(ai).not.toHaveBeenCalled();
    expect(await actionOf(withAlternative.id)).toMatchObject({ step: 'resend', state: 'proposed', toEmail: 'ik@eski.example' });
    expect(await actionOf(needsSearch.id)).toMatchObject({ step: 'research', state: 'proposed' });
    expect(await h.prisma.autopilotAction.findUnique({ where: { inboundMessageId: tooOld.id } })).toBeNull();
    expect(await retryOf(first.id)).toBeNull();
    await h.worker.drain();
    const notes = (await h.http().get('/api/v1/notifications').set(u.auth).expect(200)).body;
    expect(notes.some((n: any) => n.type === 'autopilot' && /mail dönüşü için öneri hazırladı/.test(n.title))).toBe(true);
    expect((await autopilot.sweep(workspaceId())).proposed).toBe(0);

    aiAnswers(() => ({ contacts: [{ email: 'ik@eskiyalniz.example', sourceUrl: 'https://eskiyalniz.example/kariyer', purpose: 'hr' }], offices: [] }));
    await clearPacing();
    await h.http().post('/api/v1/home/autopilot/approve').set(u.auth).send({ ids: [(await actionOf(needsSearch.id)).id] }).expect(201);
    await h.worker.drain();
    expect(await retryOf(second.id)).toMatchObject({ toEmail: 'ik@eskiyalniz.example', sendMode: 'manual' });
    expect(await actionOf(needsSearch.id)).toMatchObject({ state: 'executed', toEmail: 'ik@eskiyalniz.example' });
  });

  it('özet, zincirin aşamalarındaki sayıları verir', async () => {
    const { pipeline } = (await h.http().get('/api/v1/home/inbox').set(u.auth).expect(200)).body.autopilot;
    expect(pipeline.companies).toBeGreaterThan(15);
    expect(pipeline.withAddress).toBeGreaterThan(5);
    expect(pipeline.sent).toBeGreaterThan(15);
    expect(pipeline.bounced).toBeGreaterThan(5);
    expect(pipeline.noAddress).toBeGreaterThanOrEqual(1);
  });
});

describe('adres araması: hafıza ve basamaklar', () => {
  const kinds = (ai: jest.SpyInstance) => ai.mock.calls.map((c) => c[0].kind);

  it('Sonnet toplar, kesin olmayan adayları Opus denetler; rol, güven ve kanıt saklanır', async () => {
    const company = await firm('denetimli', []);
    await h.app.get(AddressBookService).markDead('olu.adres@denetimli.example', 'bad_address');
    const page = 'Başvurular için ik@denetimli.example · Ekibimiz: ayse.kaya@denetimli.example, can.demir@denetimli.example, olu.adres@denetimli.example';
    jest.spyOn(research as any, 'sourcePage').mockResolvedValue(page.toLowerCase());
    const ai = aiAnswers((req) =>
      req.kind === 'contact_review'
        ? {
            reviews: req.input.candidates.map((c: any) => ({
              ref: c.ref,
              keep: !c.email.startsWith('uydurma'),
              roleType: c.email.startsWith('can.') ? 'management' : c.email.startsWith('ayse.') ? 'recruiting' : 'hr',
              confidence: c.email.startsWith('ayse.') ? 80 : 70,
              reason: 'Ekip sayfasında yayımlanmış',
            })),
          }
        : {
            contacts: [
              { email: 'ik@denetimli.example', roleType: 'hr', origin: 'published', sourceUrl: 'https://denetimli.example/kariyer' },
              { email: 'ayse.kaya@denetimli.example', name: 'Ayşe Kaya', title: 'İşe Alım Uzmanı', roleType: 'recruiting', origin: 'published', sourceUrl: 'https://denetimli.example/ekip', evidence: 'ayse.kaya@denetimli.example' },
              { email: 'can.demir@denetimli.example', name: 'Can Demir', title: 'CTO', roleType: 'management', origin: 'published', sourceUrl: 'https://denetimli.example/ekip' },
              { email: 'mert.ak@denetimli.example', name: 'Mert Ak', roleType: 'hr', origin: 'pattern', sourceUrl: 'https://denetimli.example/ekip' },
              { email: 'uydurma@denetimli.example', roleType: 'employee', origin: 'published', sourceUrl: 'https://denetimli.example/ekip' },
              { email: 'olu.adres@denetimli.example', roleType: 'employee', origin: 'published', sourceUrl: 'https://denetimli.example/ekip' },
            ],
            offices: [],
          },
    );
    expect(await research.findDetails(company.id, null, { deep: true })).toMatchObject({ status: 'succeeded', source: 'ai' });
    expect(kinds(ai)).toEqual(['company_contacts', 'contact_review']);
    const reviewed = ai.mock.calls[1][0].input.candidates;
    expect(reviewed.map((c: any) => c.email)).toEqual(['ayse.kaya@denetimli.example', 'can.demir@denetimli.example', 'mert.ak@denetimli.example', 'uydurma@denetimli.example']);
    expect(reviewed.find((c: any) => c.email === 'uydurma@denetimli.example').sourceCheck).toBe('missing');
    const saved = await h.prisma.contactPoint.findMany({ where: { companyId: company.id } });
    const of = (email: string) => saved.find((c) => c.email === email);
    expect(of('ik@denetimli.example')).toMatchObject({ kind: 'official_hr', roleType: 'hr', score: 85, confidence: 'high' });
    expect(of('ik@denetimli.example')?.verifiedAt).not.toBeNull();
    expect(of('ayse.kaya@denetimli.example')).toMatchObject({ kind: 'named_recruiter', roleType: 'recruiting', score: 80, name: 'Ayşe Kaya', role: 'İşe Alım Uzmanı' });
    expect(of('can.demir@denetimli.example')).toMatchObject({ kind: 'management', roleType: 'management', score: 70, role: 'CTO' });
    expect(of('mert.ak@denetimli.example')).toMatchObject({ kind: 'guessed', score: 30, verifiedAt: null });
    expect(of('uydurma@denetimli.example')).toBeUndefined();
    expect(of('olu.adres@denetimli.example')).toBeUndefined();
    expect((await h.prisma.company.findUniqueOrThrow({ where: { id: company.id } })).researchMeta).toMatchObject({ contactsDepth: 'max' });

    const opportunity = await h.prisma.opportunity.findFirstOrThrow({ where: { companyId: company.id } });
    const preview = (await h.http().get(`/api/v1/home/preview/${opportunity.id}`).set(u.auth).expect(200)).body;
    expect(preview.suggestedTo).toBe('ik@denetimli.example');
    expect(preview.recipientOptions.map((o: any) => [o.email, o.manualOnly])).toEqual([
      ['ik@denetimli.example', false],
      ['ayse.kaya@denetimli.example', false],
      ['can.demir@denetimli.example', true],
      ['mert.ak@denetimli.example', true],
    ]);
    expect(preview.recipientOptions[2]).toMatchObject({ label: 'Yönetim', person: 'Can Demir, CTO', score: 70 });
  });

  it('yalnız çalışan ya da yönetim adresi bulunan firmaya otomatik gönderim yapılmaz', async () => {
    const company = await firm('kisisel', []);
    jest.spyOn(research as any, 'sourcePage').mockResolvedValue('cto: can.demir@kisisel.example');
    aiAnswers((req) =>
      req.kind === 'contact_review'
        ? { reviews: req.input.candidates.map((c: any) => ({ ref: c.ref, keep: true, roleType: 'management', confidence: 75 })) }
        : { contacts: [{ email: 'can.demir@kisisel.example', roleType: 'management', origin: 'published', sourceUrl: 'https://kisisel.example/ekip' }], offices: [] },
    );
    await research.findDetails(company.id, null, { deep: true });
    expect(await research.hasSendableContact(company.id)).toBe(false);
    const listed = (await h.http().get('/api/v1/home/companies').set(u.auth).expect(200)).body.companies.find((c: any) => c.id === company.id);
    expect(listed.opportunities[0]).toMatchObject({ canEmail: false, manualRecipients: 1 });
  });

  it('arka plan araması denetçiyi çağırmaz; kişisel adres düşük güvende kalır', async () => {
    const company = await firm('arkaplan', []);
    jest.spyOn(research as any, 'sourcePage').mockResolvedValue('ali.veli@arkaplan.example');
    const ai = aiAnswers(() => ({ contacts: [{ email: 'ali.veli@arkaplan.example', roleType: 'employee', origin: 'published', sourceUrl: 'https://arkaplan.example/blog' }], offices: [] }));
    await research.findDetails(company.id, null);
    expect(kinds(ai)).toEqual(['company_contacts']);
    expect(await h.prisma.contactPoint.findFirstOrThrow({ where: { companyId: company.id } })).toMatchObject({ kind: 'employee', score: 40, confidence: 'low' });
    expect((await h.prisma.company.findUniqueOrThrow({ where: { id: company.id } })).researchMeta).toMatchObject({ contactsDepth: 'base' });
  });

  it('aynı derinlikteki arama süresi dolmadan tekrarlanmaz; derinleştirme kaldığı basamaktan sürer', async () => {
    const company = await firm('hafizali', []);
    const ai = aiAnswers(() => ({ contacts: [], offices: [] }));
    await research.findDetails(company.id, null);
    expect(ai).toHaveBeenCalledTimes(1);
    expect(await research.findDetails(company.id, null)).toEqual({ status: 'skipped', reason: 'recent' });
    await research.findDetails(company.id, null, { deep: true });
    expect(kinds(ai)).toEqual(['company_contacts', 'company_contacts']);
    expect(await research.findDetails(company.id, null, { deep: true, force: true })).toEqual({ status: 'skipped', reason: 'exhausted' });
    expect(ai).toHaveBeenCalledTimes(2);
    const meta = (await h.prisma.company.findUniqueOrThrow({ where: { id: company.id } })).researchMeta as any;
    await h.prisma.company.update({ where: { id: company.id }, data: { researchMeta: { ...meta, contactsSearchedAt: new Date(Date.now() - 31 * DAY_MS).toISOString() } } });
    await research.findDetails(company.id, null);
    expect(ai).toHaveBeenCalledTimes(3);
  });

  describe('posta sunucusu yoklaması açıkken', () => {
    beforeEach(() => {
      process.env.CONTACT_SMTP_PROBE = 'true';
      resetEnvForTests();
    });
    afterEach(() => {
      process.env.CONTACT_SMTP_PROBE = 'false';
      resetEnvForTests();
    });

    it('yayımlanmış adres yoksa olası adresler yoklanır; kutusu doğrulanan listeye girer, olmayan girmez', async () => {
      const company = await firm('yoklanan', []);
      jest.spyOn(research as any, 'sourcePage').mockResolvedValue('');
      const ai = aiAnswers((req) =>
        req.kind === 'contact_review'
          ? { reviews: req.input.candidates.map((c: any) => ({ ref: c.ref, keep: true, roleType: 'recruiting', confidence: 30 })) }
          : { contacts: [{ email: 'mert.ak@yoklanan.example', name: 'Mert Ak', roleType: 'recruiting', origin: 'likely', sourceUrl: null, evidence: 'İK yöneticisi; ad.soyad kalıbı' }], offices: [] },
      );
      const probe = jest.spyOn(smtpProbe, 'probeMailboxes').mockImplementation(async (_domain, emails) => ({
        mx: true,
        catchAll: false,
        verdicts: new Map(emails.map((e): [string, smtpProbe.MailboxVerdict] => [e, ['mert.ak@yoklanan.example', 'ik@yoklanan.example'].includes(e) ? 'exists' : 'missing'])),
      }));
      await research.findDetails(company.id, null, { deep: true });
      expect(kinds(ai)).toEqual(['company_contacts', 'contact_review']);
      expect(probe).toHaveBeenCalledTimes(1);
      expect(probe.mock.calls[0][0]).toBe('yoklanan.example');
      expect(probe.mock.calls[0][1].slice(0, 3)).toEqual(['mert.ak@yoklanan.example', 'kariyer@yoklanan.example', 'ik@yoklanan.example']);
      const saved = await h.prisma.contactPoint.findMany({ where: { companyId: company.id } });
      const of = (email: string) => saved.find((c) => c.email === email);
      expect(of('ik@yoklanan.example')).toMatchObject({ kind: 'official_hr', score: 55, verifiedAt: null });
      expect(of('mert.ak@yoklanan.example')).toMatchObject({ kind: 'named_recruiter', score: 55, name: 'Mert Ak' });
      expect(of('kariyer@yoklanan.example')).toBeUndefined();
      expect(await research.hasSendableContact(company.id)).toBe(true);
      expect((await h.prisma.company.findUniqueOrThrow({ where: { id: company.id } })).researchMeta).toMatchObject({ contactsDepth: 'max', contactsVersion: 2 });
    });

    it('posta sunucusu bir şey söylemezse kariyer@ ve info@ tahmini olarak listelenir ve elle seçilebilir', async () => {
      const company = await firm('sessiz', []);
      jest.spyOn(research as any, 'sourcePage').mockResolvedValue('');
      aiAnswers(() => ({ contacts: [], offices: [] }));
      jest.spyOn(smtpProbe, 'probeMailboxes').mockImplementation(async (_domain, emails) => ({ mx: true, catchAll: null, verdicts: new Map(emails.map((e): [string, smtpProbe.MailboxVerdict] => [e, 'unknown'])) }));
      await research.findDetails(company.id, null, { deep: true });
      const saved = await h.prisma.contactPoint.findMany({ where: { companyId: company.id }, orderBy: { email: 'asc' } });
      expect(saved.map((c) => [c.email, c.kind])).toEqual([
        ['info@sessiz.example', 'guessed'],
        ['kariyer@sessiz.example', 'guessed'],
      ]);
      const opportunity = await h.prisma.opportunity.findFirstOrThrow({ where: { companyId: company.id } });
      const preview = (await h.http().get(`/api/v1/home/preview/${opportunity.id}`).set(u.auth).expect(200)).body;
      expect(preview.suggestedTo).toBeNull();
      expect(preview.recipientOptions.map((o: any) => [o.email, o.manualOnly, o.label])).toEqual([
        ['kariyer@sessiz.example', true, 'Tahmini (yayımlanmamış)'],
        ['info@sessiz.example', true, 'Tahmini (yayımlanmamış)'],
      ]);

      const guessed = saved.find((c) => c.email === 'kariyer@sessiz.example')!;
      const draft = await createDraft(h, u, company.id, null, { intentType: 'general_intent', contactId: guessed.id });
      const queue = (sendMode: 'auto' | 'manual') => h.app.get(SendingService).queueSend({ workspaceId: workspaceId(), userId: null, draftId: draft.id, idempotencyKey: idem(), sendMode, mailAccountId: u.account.id });
      await expect(queue('auto')).rejects.toMatchObject({ code: 'CONTACT_UNVERIFIED' });
      expect((await queue('manual')).attempt).toMatchObject({ toEmail: 'kariyer@sessiz.example', sendMode: 'manual' });
    });

    it('alan adı mail almıyorsa tahmin üretilmez', async () => {
      const company = await firm('postasiz', []);
      jest.spyOn(research as any, 'sourcePage').mockResolvedValue('');
      aiAnswers(() => ({ contacts: [], offices: [] }));
      jest.spyOn(smtpProbe, 'probeMailboxes').mockImplementation(async (_domain, emails) => ({ mx: false, catchAll: null, verdicts: new Map(emails.map((e): [string, smtpProbe.MailboxVerdict] => [e, 'unknown'])) }));
      await research.findDetails(company.id, null, { deep: true });
      expect(await h.prisma.contactPoint.count({ where: { companyId: company.id } })).toBe(0);
    });
  });

  it('alan adı bilinmeyen firmada modelin bulduğu site benimsenir; bekleyen öneri adresi firmanın adresi olur', async () => {
    const company = (await h.http().post('/api/v1/companies').set(u.auth).send({ name: 'Sitesiz Gıda Ltd. Şti.', sectors: ['gıda'], district: 'Fatih' }).expect(201)).body;
    await h.worker.drain();
    await h.prisma.contactPoint.create({ data: { workspaceId: workspaceId(), companyId: company.id, email: 'info@sitesizgida.example', kind: 'candidate_hr', sourceUrl: 'https://www.sitesizgida.example/iletisim' } });
    jest.spyOn(dns.promises, 'lookup').mockResolvedValue({ address: '127.0.0.1', family: 4 } as never);
    jest.spyOn(research as any, 'crawlSite').mockResolvedValue([]);
    jest.spyOn(research as any, 'sourcePage').mockResolvedValue('iletişim: info@sitesizgida.example');
    aiAnswers(() => ({ website: 'https://www.sitesizgida.example', contacts: [], offices: [{ city: 'İstanbul', district: 'Fatih', sourceUrl: 'https://www.sitesizgida.example/iletisim' }] }));
    await research.findDetails(company.id, null);
    const updated = await h.prisma.company.findUniqueOrThrow({ where: { id: company.id } });
    expect(updated).toMatchObject({ canonicalDomain: 'sitesizgida.example', website: 'https://www.sitesizgida.example/' });
    expect(await h.prisma.contactPoint.findFirstOrThrow({ where: { companyId: company.id } })).toMatchObject({ email: 'info@sitesizgida.example', kind: 'general' });
    expect(await research.hasSendableContact(company.id)).toBe(true);
  });

  it('modelin bildirdiği site ilan sitesiyse ya da başka firmanınsa benimsenmez', async () => {
    const company = (await h.http().post('/api/v1/companies').set(u.auth).send({ name: 'Yoklanan Holding', sectors: ['holding'], district: 'Fatih' }).expect(201)).body;
    await h.worker.drain();
    jest.spyOn(dns.promises, 'lookup').mockResolvedValue({ address: '127.0.0.1', family: 4 } as never);
    aiAnswers(() => ({ website: 'https://yoklanan.example', contacts: [], offices: [] }));
    await research.findDetails(company.id, null);
    expect((await h.prisma.company.findUniqueOrThrow({ where: { id: company.id } })).canonicalDomain).toBeNull();
    const board = (await h.http().post('/api/v1/companies').set(u.auth).send({ name: 'Kariyer Tekstil', sectors: ['tekstil'], district: 'Fatih' }).expect(201)).body;
    await h.worker.drain();
    aiAnswers(() => ({ website: 'https://www.kariyer.net/firma-profil/kariyer-tekstil', contacts: [], offices: [] }));
    await research.findDetails(board.id, null);
    expect((await h.prisma.company.findUniqueOrThrow({ where: { id: board.id } })).canonicalDomain).toBeNull();
  });

  it('toplu adres araması yakın zamanda derin aranmış firmaları atlar', async () => {
    const idOf = (domain: string) => h.prisma.company.findFirstOrThrow({ where: { workspaceId: workspaceId(), canonicalDomain: domain } }).then((c) => c.id);
    const result = (await h.http().post('/api/v1/home/companies/missing-emails').set(u.auth).send({ force: false }).expect(201)).body;
    expect(result.companyIds).toContain(await idOf('hafizali.example'));
    expect(result.companyIds).not.toContain(await idOf('adressiz.example'));
    expect(result.skippedRecent).toBeGreaterThanOrEqual(1);
  });

  it('kaynağında doğrulanmış adres yapay zekâsız yeniden teyit edilir', async () => {
    const old = new Date(Date.now() - 40 * DAY_MS);
    const company = await firm('teyitli', [{ email: 'ik@teyitli.example' }, { email: 'kariyer@teyitli.example' }, { email: 'hr@teyitli.example' }, { email: 'cv@teyitli.example' }]);
    await h.prisma.contactPoint.updateMany({ where: { companyId: company.id }, data: { verifiedAt: old } });
    await h.prisma.contactPoint.update({ where: { companyId_email: { companyId: company.id, email: 'hr@teyitli.example' } }, data: { sourceUrl: 'https://teyitli.example/kayip' } });
    await h.prisma.contactPoint.update({ where: { companyId_email: { companyId: company.id, email: 'cv@teyitli.example' } }, data: { sourceUrl: 'https://teyitli.example/kapali' } });
    await h.prisma.addressRecord.upsert({ where: { email: 'ik@teyitli.example' }, create: { email: 'ik@teyitli.example', domain: 'teyitli.example', status: 'deliverable', delivered: 1 }, update: { status: 'deliverable', delivered: 1 } });
    const pages: Record<string, string | null> = { 'https://teyitli.example/kariyer': 'başvuru: kariyer@teyitli.example', 'https://teyitli.example/kayip': 'bu sayfada adres yok', 'https://teyitli.example/kapali': null };
    jest.spyOn(research as any, 'sourcePage').mockImplementation(async (...args: unknown[]) => pages[args[0] as string] ?? null);
    const ai = jest.spyOn(h.app.get(AiService), 'run');
    const now = new Date();
    const stats = await research.reverifyContacts(workspaceId(), now);
    expect(stats).toMatchObject({ confirmed: 2, lapsed: 1, postponed: 1, companyIds: [] });
    expect(ai).not.toHaveBeenCalled();
    const contacts = Object.fromEntries((await h.prisma.contactPoint.findMany({ where: { companyId: company.id } })).map((c) => [c.email, c]));
    expect(contacts['ik@teyitli.example']).toMatchObject({ verifiedBy: 'delivery', verifiedAt: now });
    expect(contacts['kariyer@teyitli.example']).toMatchObject({ verifiedBy: 'source', verifiedAt: now });
    expect(contacts['hr@teyitli.example'].verifiedAt).toBeNull();
    expect(contacts['cv@teyitli.example'].verifiedAt!.getTime()).toBeLessThan(now.getTime() - 20 * DAY_MS);
    expect((await research.reverifyContacts(workspaceId(), now)).checked).toBe(0);
  });

  it('doğrulaması düşen adresi kalmayan ve başvurulmamış firma için arama istenir; adres kaynağında yeniden görülürse doğrulanır', async () => {
    const company = await firm('dusen', [{ email: 'ik@dusen.example' }]);
    await h.prisma.contactPoint.updateMany({ where: { companyId: company.id }, data: { verifiedAt: new Date(Date.now() - 40 * DAY_MS) } });
    jest.spyOn(research as any, 'sourcePage').mockResolvedValue('adres kaldırılmış');
    expect((await research.reverifyContacts(workspaceId())).companyIds).toEqual([company.id]);
    jest.restoreAllMocks();
    await h.app.get(IngestService).saveContacts({ companyId: company.id } as never, [{ email: 'ik@dusen.example', sourceUrl: 'https://dusen.example/kariyer' }], 'cli_codex');
    expect(await h.prisma.contactPoint.findUniqueOrThrow({ where: { companyId_email: { companyId: company.id, email: 'ik@dusen.example' } } })).toMatchObject({ verifiedBy: 'source', verifiedAt: expect.any(Date) });
  });
});

describe('yapay zekâ payı: öncelik sınıfları', () => {
  const ai = () => h.app.get(AiService);
  const usage = (key: string) => h.prisma.usageCounter.findFirst({ where: { workspaceId: workspaceId(), key } }).then((row) => row?.count ?? 0);

  beforeEach(async () => {
    await h.prisma.usageCounter.deleteMany({ where: { workspaceId: workspaceId(), key: { startsWith: 'ai:' } } });
    await h.prisma.keyValue.deleteMany({ where: { OR: [{ key: { startsWith: 'provider:' } }, { key: 'worker:heartbeat' }] } });
  });

  it('düşük öncelikli sınıf payını aşamaz; kalan hak etkileşimli işlere kalır', async () => {
    const reserve = (cls: string) => (ai() as any).reserveBudget(workspaceId(), cls, 10) as Promise<boolean>;
    expect([await reserve('discovery'), await reserve('discovery'), await reserve('discovery')]).toEqual([true, true, false]);
    expect([await reserve('research'), await reserve('research'), await reserve('research'), await reserve('research'), await reserve('research')]).toEqual([true, true, true, true, false]);
    expect(await usage('ai:tasks')).toBe(6);
    expect(await usage('ai:class:discovery')).toBe(2);
    expect(await reserve('letters')).toBe(true);
    expect(await reserve('letters')).toBe(false);
    expect(await usage('ai:class:letters')).toBe(1);
    expect([await reserve('interactive'), await reserve('interactive'), await reserve('interactive'), await reserve('interactive')]).toEqual([true, true, true, false]);
    expect(await usage('ai:tasks')).toBe(10);
  });

  it('abonelik limitine yaklaşılınca keşif ve araştırma kapanır, kullanıcının işleri sürer; limiti bilinmeyen ikinci sağlayıcı varsa sınıf açık kalır', async () => {
    const resetsAt = new Date(Date.now() + 2 * 3_600_000).toISOString();
    await h.prisma.keyValue.create({ data: { key: 'provider:limits:cli_claude', value: { at: new Date().toISOString(), windows: [{ name: 'five_hour', utilization: 0.74, resetsAt }] } } });
    const allOpen = (await h.http().get('/api/v1/home').set(u.auth).expect(200)).body.ai.classes;
    expect(allOpen.every((c: any) => c.open)).toBe(true);
    await h.prisma.keyValue.upsert({ where: { key: 'worker:heartbeat' }, create: { key: 'worker:heartbeat', value: { providers: { cli_claude: true, cli_codex: false } } }, update: { value: { providers: { cli_claude: true, cli_codex: false } } } });
    const classes = (await h.http().get('/api/v1/home').set(u.auth).expect(200)).body.ai.classes;
    expect(classes.map((c: any) => [c.aiClass, c.open, c.blockedBy])).toEqual([
      ['interactive', true, null],
      ['fix', true, null],
      ['letters', true, null],
      ['research', false, 'subscription'],
      ['discovery', false, 'subscription'],
    ]);
    expect(new Date(classes[4].opensAt).toISOString()).toBe(resetsAt);
  });

  it('sınıf kapalıyken arka plan işi başlatılmaz; sağlayıcı kurulu değilse elle/şablon akışı sürer', async () => {
    const company = await firm('ertelenen', []);
    await h.prisma.keyValue.create({ data: { key: 'provider:limits:cli_claude', value: { at: new Date().toISOString(), windows: [{ name: 'five_hour', utilization: 0.74, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }] } } });
    const researchCompany = jest.spyOn(research, 'researchCompany').mockResolvedValue({ status: 'recent' });
    await h.worker.handle('research', { name: 'company', data: { companyId: company.id } } as never);
    expect(researchCompany).toHaveBeenCalledTimes(1);
    jest.spyOn(TEXT_PROVIDERS.cli_claude, 'available').mockResolvedValue({ ok: true, detail: 'test' });
    expect(await h.worker.handle('research', { name: 'company', data: { companyId: company.id } } as never)).toEqual({ status: 'deferred', reason: 'ai_class_closed', aiClass: 'research' });
    expect(researchCompany).toHaveBeenCalledTimes(1);
    await h.worker.handle('interactive', { name: 'company_details', data: { companyId: company.id, deep: true } } as never);
    expect(await h.app.get(AiService).classOpen(workspaceId(), 'interactive')).toBe(true);
  });
});
