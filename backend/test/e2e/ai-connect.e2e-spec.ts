import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { decryptSecret } from '../../src/common/crypto';
import { AiService, API_KEYS_KEY, PROVIDERS_CHANGED_KEY } from '../../src/engine/ai/ai.service';
import { setStoredApiKeys } from '../../src/engine/ai/providers';
import { AiConnectService } from '../../src/modules/ai/ai-connect.service';
import { createHarness, Harness, resetDb, setupUser, User } from './harness';

let h: Harness;
let admin: User;
let invitee: User;

/** Gerçek CLI çalıştırılmaz: sürüm sorusuna yanıt veren, girişte cihaz kodu yazan sahte süreç. */
function fakeSpawner(_command: string, args: string[]) {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: () => true });
  setImmediate(() => {
    if (args[0] === '--version') child.stdout.write('codex-cli 0.164.0');
    else if (args.join(' ') === 'login status') child.stdout.write('Not logged in');
    else if (args.join(' ') === 'auth status --json') child.stdout.write('{"loggedIn":false}');
    if (args.join(' ') === 'login --device-auth') return child.stdout.write('Open https://auth.openai.com/codex/device\nCode: WX12-YZ34\n');
    setImmediate(() => child.emit('close', args[0] === '--version' ? 0 : 1));
  });
  return child as never;
}

beforeAll(async () => {
  h = await createHarness();
  await resetDb(h.prisma);
  h.app.get(AiConnectService).spawner = fakeSpawner;
  admin = await setupUser(h, 'yonetici');
  invitee = await setupUser(h, 'davetli');
});

afterAll(async () => {
  h.app.get(AiConnectService).cancel('cli_codex');
  setStoredApiKeys({});
  await h.close();
});

describe('arayüzden yapay zekâ hesabı bağlama', () => {
  it('yalnızca yönetici görür ve başlatır; bilinmeyen sağlayıcı reddedilir', async () => {
    await h.http().get('/api/v1/ai/connect').set(invitee.auth).expect(403);
    await h.http().post('/api/v1/ai/connect/cli_codex/login').set(invitee.auth).expect(403);
    await h.http().post('/api/v1/ai/connect/ollama/login').set(admin.auth).expect(400);

    const list = (await h.http().get('/api/v1/ai/connect').set(admin.auth).expect(200)).body;
    expect(list.map((s: any) => [s.provider, s.installed, s.connected])).toEqual([
      ['cli_claude', true, false],
      ['cli_codex', true, false],
    ]);
  });

  it('ChatGPT girişi cihaz kodunu döndürür; iptal edilince oturum kalkar', async () => {
    const started = (await h.http().post('/api/v1/ai/connect/cli_codex/login').set(admin.auth).expect(201)).body;
    expect(started.login).toMatchObject({ phase: 'waiting', url: 'https://auth.openai.com/codex/device', userCode: 'WX12-YZ34' });
    await h.http().post('/api/v1/ai/connect/cli_codex/code').set(admin.auth).send({ code: 'abcd' }).expect(409);
    expect((await h.http().delete('/api/v1/ai/connect/cli_codex/login').set(admin.auth).expect(200)).body.login).toBeNull();
  });
});

describe('kurulum listesinin yapay zekâ adımı', () => {
  const ANTHROPIC_KEY = 'sk-ant-api03-ornek-anahtar-0000000000000000-abcd';
  const setup = (u: User) => h.http().get('/api/v1/ai/setup').set(u.auth).expect(200).then((r) => r.body);

  it('gerçek sağlayıcı yokken eksik; davetli bağlantı ve anahtar bilgisini görmez', async () => {
    const own = await setup(admin);
    expect(own).toMatchObject({ ready: false, usable: [], manualAccepted: false, canManage: true });
    expect(own.connections.map((c: any) => c.provider)).toEqual(['cli_claude', 'cli_codex']);
    expect(own.apiKeys).toEqual({ anthropic_api: { source: null, last4: null, savedAt: null }, openai_api: { source: null, last4: null, savedAt: null } });
    expect(await setup(invitee)).toMatchObject({ ready: false, canManage: false, connections: null, apiKeys: null });
  });

  it('kopyala-yapıştır seçimi yalnızca o çalışma alanına kaydedilir ve geri alınabilir', async () => {
    expect((await h.http().post('/api/v1/ai/setup/manual').set(invitee.auth).send({ accepted: true }).expect(201)).body.manualAccepted).toBe(true);
    expect((await setup(admin)).manualAccepted).toBe(false);
    await h.http().patch('/api/v1/ai/settings').set(invitee.auth).send({ webResearch: false }).expect(200);
    expect((await setup(invitee)).manualAccepted).toBe(true);
    await h.http().post('/api/v1/ai/setup/manual').set(invitee.auth).send({ accepted: false }).expect(201);
    expect((await setup(invitee)).manualAccepted).toBe(false);
  });

  it('API anahtarı şifreli saklanır, yalnızca son 4 karakteri döner ve yöneticinin sırasına girer', async () => {
    await h.http().put('/api/v1/ai/api-keys/anthropic_api').set(invitee.auth).send({ key: ANTHROPIC_KEY }).expect(403);
    await h.http().put('/api/v1/ai/api-keys/anthropic_api').set(admin.auth).send({ key: 'kisa' }).expect(400);
    await h.http().put('/api/v1/ai/api-keys/cli_claude').set(admin.auth).send({ key: ANTHROPIC_KEY }).expect(400);

    const saved = (await h.http().put('/api/v1/ai/api-keys/anthropic_api').set(admin.auth).send({ key: `  ${ANTHROPIC_KEY} ` }).expect(200)).body;
    expect(saved.anthropic_api).toMatchObject({ source: 'stored', last4: 'abcd' });
    expect(JSON.stringify(saved)).not.toContain(ANTHROPIC_KEY);

    const row = await h.prisma.keyValue.findUniqueOrThrow({ where: { key: API_KEYS_KEY } });
    const secret = (row.value as any).anthropic_api.secret as string;
    expect(secret).not.toContain('sk-ant');
    expect(decryptSecret(secret)).toBe(ANTHROPIC_KEY);
    expect(await h.prisma.keyValue.findUnique({ where: { key: PROVIDERS_CHANGED_KEY } })).not.toBeNull();

    const own = await setup(admin);
    expect(own).toMatchObject({ ready: true, usable: ['anthropic_api'] });
    expect((await h.app.get(AiService).settings(admin.candidate.workspaceId)).providerOrder).toEqual(['cli_claude', 'cli_codex', 'anthropic_api', 'manual', 'template']);
    // Davetli, yönetici CLI paylaşımını açmadıkça sunucunun anahtarını kullanmaz.
    expect((await setup(invitee)).ready).toBe(false);
  });

  it('anahtar silinince .env yedeği yoksa adım yeniden eksik olur', async () => {
    expect((await h.http().delete('/api/v1/ai/api-keys/anthropic_api').set(admin.auth).expect(200)).body.anthropic_api.source).toBeNull();
    expect((await setup(admin)).ready).toBe(false);
  });
});
