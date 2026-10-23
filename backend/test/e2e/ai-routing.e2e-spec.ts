import { AiService, CODEX_MODELS_KEY } from '../../src/engine/ai/ai.service';
import { createHarness, Harness, resetDb, setupUser, User } from './harness';

let h: Harness;
let admin: User;
let invitee: User;
let ai: AiService;

const workspaceOf = (u: User) => u.candidate.workspaceId as string;
const status = (u: User) => h.http().get('/api/v1/ai/status').set(u.auth).expect(200).then((r) => r.body);

beforeAll(async () => {
  h = await createHarness();
  await resetDb(h.prisma);
  ai = h.app.get(AiService);
  admin = await setupUser(h, 'yonetici');
  invitee = await setupUser(h, 'davetli');
  await h.prisma.keyValue.create({ data: { key: CODEX_MODELS_KEY, value: { models: [{ value: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' }, { value: 'gpt-6-luna', label: 'GPT-6-Luna', description: 'Hızlı' }] } } });
});

afterAll(async () => {
  await h.close();
});

describe('görev türüne göre sağlayıcı ve modeller (sunucu geneli)', () => {
  it('seçenekler: Claude takma adları ve worker\'ın bildirdiği ChatGPT modelleri', async () => {
    const s = await status(admin);
    expect(s.modelOptions.cli_claude.map((o: any) => o.value)).toEqual(['haiku', 'sonnet', 'opus']);
    expect(s.modelOptions.cli_codex.map((o: any) => o.value)).toEqual(['gpt-6.1-sol', 'gpt-6-luna']);
    expect(s.routing).toEqual({ providers: {}, models: {} });
  });

  it('yalnızca yönetici değiştirir; listede olmayan model ve bilinmeyen görev reddedilir', async () => {
    await h.http().patch('/api/v1/ai/routing').set(invitee.auth).send({ providers: { company_contacts: 'cli_codex' } }).expect(403);
    expect((await h.http().patch('/api/v1/ai/routing').set(admin.auth).send({ models: { cli_codex: { company_contacts: 'gpt-uydurma' } } }).expect(400)).body.error.code).toBe('AI_MODEL_UNKNOWN');
    expect((await h.http().patch('/api/v1/ai/routing').set(admin.auth).send({ providers: { yok_boyle_is: 'cli_codex' } }).expect(400)).body.error.code).toBe('AI_KIND_UNKNOWN');
    await h.http().patch('/api/v1/ai/routing').set(admin.auth).send({ providers: { company_contacts: 'yapay' } }).expect(400);
  });

  it('yöneticinin seçimi bütün çalışma alanlarına uygulanır; "otomatik" seçimi siler', async () => {
    const saved = await h.http().patch('/api/v1/ai/routing').set(admin.auth).send({ providers: { company_contacts: 'cli_codex', company_report: 'auto' }, models: { cli_codex: { company_contacts: 'gpt-6-luna' }, cli_claude: { company_report: 'opus' } } }).expect(200);
    expect(saved.body).toEqual({ providers: { company_contacts: 'cli_codex' }, models: { cli_codex: { company_contacts: 'gpt-6-luna' }, cli_claude: { company_report: 'opus' } } });

    for (const u of [admin, invitee]) {
      const s = await ai.settings(workspaceOf(u));
      expect(s.kindProviders).toEqual({ company_contacts: 'cli_codex' });
      expect(s.models?.cli_codex?.company_contacts).toBe('gpt-6-luna');
      expect((await status(u)).routing.providers).toEqual({ company_contacts: 'cli_codex' });
    }

    await h.http().patch('/api/v1/ai/routing').set(admin.auth).send({ providers: { company_contacts: 'auto' } }).expect(200);
    expect((await ai.settings(workspaceOf(invitee))).kindProviders).toEqual({});
    expect((await ai.settings(workspaceOf(invitee))).models?.cli_claude?.company_report).toBe('opus');
  });

  it('kayıtlı ama artık listede olmayan model seçeneklerde kalır ve yeniden kaydedilebilir', async () => {
    await h.prisma.keyValue.update({ where: { key: CODEX_MODELS_KEY }, data: { value: { models: [{ value: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' }] } } });
    const options = (await status(admin)).modelOptions.cli_codex;
    expect(options.find((o: any) => o.value === 'gpt-6-luna')).toMatchObject({ description: expect.stringContaining('Listede yok') });
    await h.http().patch('/api/v1/ai/routing').set(admin.auth).send({ models: { cli_codex: { company_contacts: 'gpt-6-luna' } } }).expect(200);
  });
});
