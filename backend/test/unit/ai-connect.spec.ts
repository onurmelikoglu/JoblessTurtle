import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { AiService } from '../../src/engine/ai/ai.service';
import { AiConnectService, lastLines, parseClaudeStatus, parseCodexStatus, parseLoginPrompt, redactSecrets, stripAnsi } from '../../src/modules/ai/ai-connect.service';

interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  kill: (signal?: string) => boolean;
  written: string;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.written = '';
  child.stdin.on('data', (d) => (child.written += d.toString()));
  child.kill = () => {
    setImmediate(() => child.emit('close', null));
    return true;
  };
  return child;
}

/** Komut başına davranış: anında çıktı verip kapanan ya da elle sürülen süreç. */
function fakeSpawner(script: (args: string[], child: FakeChild) => void) {
  const calls: string[][] = [];
  const children: FakeChild[] = [];
  const spawner = (_command: string, args: string[]) => {
    calls.push(args);
    const child = fakeChild();
    children.push(child);
    setImmediate(() => script(args, child));
    return child as never;
  };
  return { spawner, calls, children };
}

/** Bağlantı değişince worker'a verilen sinyal sayılır; veritabanı gerekmez. */
function newService() {
  const ai = { changes: 0, markProvidersChanged: async () => void ai.changes++ };
  return Object.assign(new AiConnectService(ai as unknown as AiService), { aiStub: ai });
}

const finish = (child: FakeChild, output: string, code = 0) => {
  child.stdout.write(output);
  setImmediate(() => child.emit('close', code));
};

const CLAUDE_URL = 'https://claude.com/cai/oauth/authorize?code=true&client_id=abc&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=xyz';

describe('yapay zekâ hesabı bağlama: çıktı çözümleme', () => {
  it('Claude giriş adresini ve ChatGPT cihaz kodunu renk kodları arasından ayıklar', () => {
    expect(parseLoginPrompt('cli_claude', `\x1b[1mBrowser didn't open? Use the url below\x1b[0m\n\n${CLAUDE_URL}\n\nPaste code here if prompted >`)).toEqual({ url: CLAUDE_URL, userCode: null });
    const codex = 'Follow these steps:\n1. Open \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n2. Enter this one-time code \x1b[94mK7QX-4MZP\x1b[0m (expires in 15 minutes)';
    expect(parseLoginPrompt('cli_codex', codex)).toEqual({ url: 'https://auth.openai.com/codex/device', userCode: 'K7QX-4MZP' });
    expect(stripAnsi('\x1b]8;;https://x\x07bağlantı\x1b]8;;\x07')).toBe('bağlantı');
  });

  it('durum çıktıları', () => {
    expect(parseClaudeStatus('{"loggedIn":true,"email":"a@b.c","subscriptionType":"pro"}')).toEqual({ connected: true, account: 'a@b.c', plan: 'pro' });
    expect(parseClaudeStatus('{"loggedIn":false}').connected).toBe(false);
    expect(parseClaudeStatus('Not logged in').connected).toBe(false);
    expect(parseCodexStatus(0, 'Logged in using ChatGPT\n')).toEqual({ connected: true, account: null, plan: 'ChatGPT' });
    expect(parseCodexStatus(1, 'Not logged in\n').connected).toBe(false);
  });

  it('hata metninde adres ve belirteç benzeri dizgiler gizlenir', () => {
    expect(redactSecrets(`Hata: ${CLAUDE_URL} token=sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWxYz0123`)).toBe('Hata: [adres] [gizli]');
    expect(lastLines(`If the browser didn't open, visit: ${CLAUDE_URL}\nPaste code here if prompted > OAuth error: invalid code\n`)).toBe('OAuth error: invalid code');
  });
});

describe('yapay zekâ hesabı bağlama: giriş akışı', () => {
  it('Claude: adres gelince bekler, yapıştırılan kodu sürece iletir, başarıda bağlı görünür', async () => {
    let loggedIn = false;
    const fake = fakeSpawner((args, child) => {
      if (args[0] === '--version') return finish(child, '2.5.0 (Claude Code)');
      if (args.join(' ') === 'auth status --json') return finish(child, JSON.stringify({ loggedIn, email: loggedIn ? 'ben@ornek.com' : undefined, subscriptionType: loggedIn ? 'max' : undefined }), loggedIn ? 0 : 1);
      if (args.join(' ') === 'auth login --claudeai') {
        child.stdout.write(`Use the url below to sign in\n${CLAUDE_URL}\nPaste code here if prompted > `);
        child.stdin.on('data', () => {
          loggedIn = true;
          finish(child, 'Login successful.\n');
        });
      }
    });
    const svc = newService();
    svc.spawner = fake.spawner;

    const started = await svc.start('cli_claude');
    expect(started.connected).toBe(false);
    expect(started.login).toMatchObject({ phase: 'waiting', url: CLAUDE_URL, needsCode: true });

    const done = await svc.submitCode('cli_claude', '  kod#durum  ');
    expect(fake.children.find((c) => c.written)?.written).toBe('kod#durum\n');
    expect(done).toMatchObject({ connected: true, account: 'ben@ornek.com', plan: 'max', login: null });
    expect(svc.aiStub.changes).toBe(1);
  });

  it('Claude: yanlış kod girilince yalnızca koddan sonraki hata satırı gösterilir', async () => {
    const fake = fakeSpawner((args, child) => {
      if (args[0] === '--version') return finish(child, '2.5.0 (Claude Code)');
      if (args.join(' ') === 'auth status --json') return finish(child, '{"loggedIn":false}', 1);
      child.stdout.write(`Opening browser to sign in…\nIf the browser didn't open, visit: ${CLAUDE_URL}\nPaste code here if prompted > `);
      child.stdin.on('data', () => finish(child, 'OAuth error: Invalid code\n', 1));
    });
    const svc = newService();
    svc.spawner = fake.spawner;
    await svc.start('cli_claude');
    expect(await svc.submitCode('cli_claude', 'yanlis')).toMatchObject({ connected: false, login: { phase: 'failed', message: 'OAuth error: Invalid code' } });
    expect(svc.aiStub.changes).toBe(0);
  });

  it('ChatGPT: cihaz kodunu döndürür; süreç başarıyla bitince oturum kapanır', async () => {
    let loggedIn = false;
    let loginChild: FakeChild | null = null;
    const fake = fakeSpawner((args, child) => {
      if (args[0] === '--version') return finish(child, 'codex-cli 0.164.0');
      if (args.join(' ') === 'login status') return finish(child, loggedIn ? 'Logged in using ChatGPT' : 'Not logged in', loggedIn ? 0 : 1);
      if (args.join(' ') === 'login --device-auth') {
        loginChild = child;
        child.stderr.write('Open https://auth.openai.com/codex/device\nEnter this one-time code AB12-CD34\n');
      }
    });
    const svc = newService();
    svc.spawner = fake.spawner;

    const started = await svc.start('cli_codex');
    expect(started.login).toMatchObject({ phase: 'waiting', url: 'https://auth.openai.com/codex/device', userCode: 'AB12-CD34', needsCode: false });
    await expect(svc.submitCode('cli_codex', 'kod1')).rejects.toMatchObject({ code: 'AI_LOGIN_NOT_WAITING' });

    loggedIn = true;
    finish(loginChild!, 'Successfully logged in\n');
    await new Promise((r) => setTimeout(r, 10));
    expect(await svc.status('cli_codex', true)).toMatchObject({ connected: true, plan: 'ChatGPT', login: null });
  });

  it('başarısız giriş son çıktı satırını gösterir; araç kurulu değilse başlatılmaz', async () => {
    const failing = fakeSpawner((args, child) => {
      if (args[0] === '--version') return finish(child, '2.5.0');
      if (args[0] === 'auth' && args[1] === 'status') return finish(child, '{"loggedIn":false}', 1);
      finish(child, 'Error: network unreachable\n', 1);
    });
    const svc = newService();
    svc.spawner = failing.spawner;
    expect((await svc.start('cli_claude')).login).toMatchObject({ phase: 'failed', message: 'Error: network unreachable' });

    const missing = newService();
    missing.spawner = fakeSpawner((_args, child) => finish(child, 'command not found', 127)).spawner;
    await expect(missing.start('cli_codex')).rejects.toMatchObject({ code: 'AI_CLI_MISSING' });
    expect((await missing.status('cli_codex')).installed).toBe(false);
  });

  it('iptal yarım girişi sonlandırır', async () => {
    const fake = fakeSpawner((args, child) => {
      if (args[0] === '--version') return finish(child, '2.5.0');
      if (args[0] === 'auth' && args[1] === 'status') return finish(child, '{"loggedIn":false}', 1);
      child.stdout.write(`${CLAUDE_URL}\n`);
    });
    const svc = newService();
    svc.spawner = fake.spawner;
    expect((await svc.start('cli_claude')).login?.phase).toBe('waiting');
    svc.cancel('cli_claude');
    expect((await svc.status('cli_claude')).login).toBeNull();
  });

  it('aynı anda tek giriş: ChatGPT girişi başlarken yarım Claude girişi kapatılır', async () => {
    const fake = fakeSpawner((args, child) => {
      if (args[0] === '--version') return finish(child, '1.0.0');
      if (args[0] === 'auth' && args[1] === 'status') return finish(child, '{"loggedIn":false}', 1);
      if (args.join(' ') === 'login status') return finish(child, 'Not logged in', 1);
      if (args[0] === 'auth') child.stdout.write(`${CLAUDE_URL}\n`);
      else child.stdout.write('https://auth.openai.com/codex/device\nAB12-CD34\n');
    });
    const svc = newService();
    svc.spawner = fake.spawner;
    await svc.start('cli_claude');
    await svc.start('cli_codex');
    expect((await svc.status('cli_claude')).login).toBeNull();
    expect((await svc.status('cli_codex')).login?.phase).toBe('waiting');
    svc.cancel('cli_codex');
  });

  it('15 dakika dolunca süreç kapatılır ve oturum "süre doldu" görünür', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    try {
      const fake = fakeSpawner((args, child) => {
        if (args[0] === '--version') return finish(child, 'codex-cli 0.164.0');
        if (args.join(' ') === 'login status') return finish(child, 'Not logged in', 1);
        child.stdout.write('https://auth.openai.com/codex/device\nAB12-CD34\n');
      });
      const svc = newService();
      svc.spawner = fake.spawner;
      expect((await svc.start('cli_codex')).login?.phase).toBe('waiting');
      jest.advanceTimersByTime(15 * 60_000);
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect((await svc.status('cli_codex')).login).toMatchObject({ phase: 'expired', message: expect.stringContaining('15 dakika') });
      expect(svc.aiStub.changes).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
