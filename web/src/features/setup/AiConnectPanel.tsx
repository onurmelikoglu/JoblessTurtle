import { CircleAlert, CircleCheck, CirclePause, ClipboardPaste, Copy, ExternalLink, KeyRound, LogOut, ShieldAlert, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { aiSetupApi } from '@/api/ai-setup';
import { useAction } from '@/api/queries';
import type { AiSetupStatus, ApiKeyProviderName, ApiKeyStatus, ConnectStatus } from '@/api/types';
import { copyText } from '@/features/profile/clipboard';
import { fmtDateTime, fmtTime } from '@/lib/format';
import { Badge } from '@/ui/Badge';
import { Button, LinkButton } from '@/ui/Button';
import { useConfirm } from '@/ui/confirm-context';
import { Field, Input } from '@/ui/fields';
import { Notice } from '@/ui/Notice';
import { CONNECT_LABELS, connectionSummary, loginInProgress } from './setup-model';
import { useRefreshAiSetup } from './setup-queries';

const CONNECT_ACTIONS: Record<ConnectStatus['provider'], string> = { cli_claude: "Claude'u bağla", cli_codex: "ChatGPT'yi bağla", cli_cursor: "Cursor'u bağla" };
const CONNECT_TITLES: Record<ConnectStatus['provider'], string> = { cli_claude: 'Claude (Pro / Max aboneliği)', cli_codex: 'ChatGPT (Plus / Pro aboneliği)', cli_cursor: 'Cursor (Pro / Ultra aboneliği)' };
const LOGIN_PAGE_LABELS: Record<ConnectStatus['provider'], string> = { cli_claude: 'Claude giriş sayfasını aç', cli_codex: 'ChatGPT giriş sayfasını aç', cli_cursor: 'Cursor giriş sayfasını aç' };
/** Kullandıkça ücretlenen anahtarlar; Cursor anahtarı aboneliği kullandığı için Cursor kartında durur. */
const PAID_API_KEYS: ApiKeyProviderName[] = ['anthropic_api', 'openai_api'];
const CURSOR_KEY_PLAN = 'API anahtarıyla';

const CLI_MISSING_HINT = 'install.sh ile kurulumda gelir. Elle kurulumda .env içinde INSTALL_AI_CLI=true yapıp imajı yeniden derle.';

const API_KEY_LABELS: Record<ApiKeyProviderName, { title: string; placeholder: string; console: string }> = {
  anthropic_api: { title: 'Claude API anahtarı', placeholder: 'sk-ant-…', console: 'https://console.anthropic.com/settings/keys' },
  openai_api: { title: 'OpenAI API anahtarı', placeholder: 'sk-…', console: 'https://platform.openai.com/api-keys' },
  cli_cursor: { title: 'Cursor kullanıcı API anahtarı', placeholder: 'key_…', console: 'https://cursor.com/dashboard?tab=integrations' },
};

function StatusIcon({ connection }: { connection: ConnectStatus }) {
  if (connection.connected) return <CircleCheck className="size-5 shrink-0 text-good" aria-hidden />;
  if (connection.login?.phase === 'failed' || connection.login?.phase === 'expired') return <CircleAlert className="size-5 shrink-0 text-bad" aria-hidden />;
  return <CirclePause className="size-5 shrink-0 text-ink-faint" aria-hidden />;
}

/** Claude: giriş sayfası sonunda verilen kod buraya yapıştırılır ve bekleyen CLI sürecine iletilir. */
function ClaudeCodeForm({ busy, onSubmit }: { busy: boolean; onSubmit: (code: string) => void }) {
  const [code, setCode] = useState('');
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (code.trim()) onSubmit(code.trim());
      }}
    >
      <Field label="Giriş sayfasının verdiği kod" className="min-w-0 flex-1 basis-60">
        {(props) => <Input {...props} autoComplete="off" spellCheck={false} placeholder="Kodu buraya yapıştır" value={code} onChange={(e) => setCode(e.target.value)} />}
      </Field>
      <Button type="submit" variant="primary" loading={busy} disabled={!code.trim()} icon={<ClipboardPaste className="size-4" aria-hidden />}>
        Kodu gönder
      </Button>
    </form>
  );
}

function LoginSteps({ connection, busy, onCode, onCancel }: { connection: ConnectStatus; busy: boolean; onCode: (code: string) => void; onCancel: () => void }) {
  const login = connection.login!;
  const openLabel = LOGIN_PAGE_LABELS[connection.provider];
  return (
    <div className="flex flex-col gap-3 rounded-lg bg-sunken p-3">
      {login.phase === 'starting' && <p className="text-sm text-ink-soft">Giriş başlatılıyor…</p>}
      {login.url && (
        <ol className="list-decimal space-y-2 pl-5 text-sm">
          <li>
            <span className="flex flex-wrap items-center gap-2">
              <LinkButton size="sm" variant="tonal" href={login.url} icon={<ExternalLink className="size-4" aria-hidden />}>
                {openLabel}
              </LinkButton>
              <span className="text-ink-soft">ve hesabınla giriş yap.</span>
            </span>
          </li>
          {login.needsCode ? (
            <li>
              İzin verdikten sonra sayfada görünen kodu kopyalayıp aşağıya yapıştır.
              <div className="mt-2">
                <ClaudeCodeForm busy={busy || login.phase === 'verifying'} onSubmit={onCode} />
              </div>
            </li>
          ) : !login.userCode ? (
            <li>Açılan sayfada girişi onayla. Onayladıktan sonra bu ekran kendiliğinden güncellenir.</li>
          ) : (
            <li>
              <span className="flex flex-wrap items-center gap-2">
                Açılan sayfaya bu kodu gir:
                <code className="rounded bg-surface px-2 py-1 font-mono text-base font-semibold tracking-widest">{login.userCode}</code>
                <Button size="sm" variant="ghost" icon={<Copy className="size-4" aria-hidden />} onClick={() => void copyText(login.userCode ?? '', 'Kod panoya kopyalandı')}>
                  Kopyala
                </Button>
              </span>
              <span className="mt-1 block text-ink-soft">Onayladıktan sonra bu ekran kendiliğinden güncellenir.</span>
            </li>
          )}
        </ol>
      )}
      {!login.needsCode && login.userCode && (
        <Notice tone="warn" icon={<ShieldAlert className="size-5 shrink-0" aria-hidden />}>
          Bu kodu yalnızca girişi bu ekranda kendin başlattıysan gir. Bir site ya da başka biri sana bu kodu verdiyse girme; vazgeç.
        </Notice>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-ink-soft">
        <span>Bağlantı {fmtTime(login.expiresAt)} saatine kadar geçerli.</span>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          Vazgeç
        </Button>
      </div>
    </div>
  );
}

/** Kendi bilgisayarında `claude setup-token` ile üretilen bir yıllık belirteç buraya yapıştırılır. */
function ClaudeTokenForm({ busy, onSave }: { busy: boolean; onSave: (token: string) => void }) {
  const [token, setToken] = useState('');
  return (
    <details className="rounded-lg border border-line p-3">
      <summary className="cursor-pointer text-sm font-medium">Belirteci kendim üreteyim</summary>
      <form
        className="mt-3 flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (token.trim()) onSave(token.trim());
          setToken('');
        }}
      >
        <p className="text-xs text-ink-soft">
          Claude Code kurulu bir bilgisayarda terminalde <code className="rounded bg-sunken px-1">claude setup-token</code> çalıştır; tarayıcıda onayladıktan sonra çıkan sk-ant-oat… ile başlayan değeri buraya yapıştır. Belirteç şifreli saklanır ve bir daha gösterilmez.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Claude belirteci" className="min-w-0 flex-1 basis-60">
            {(props) => <Input {...props} type="password" autoComplete="off" spellCheck={false} placeholder="sk-ant-oat01-…" value={token} onChange={(e) => setToken(e.target.value)} />}
          </Field>
          <Button type="submit" variant="outline" loading={busy} disabled={!token.trim()} icon={<KeyRound className="size-4" aria-hidden />}>
            Kaydet
          </Button>
        </div>
      </form>
    </details>
  );
}

function ConnectionCard({ connection, cursorKey }: { connection: ConnectStatus; cursorKey?: ApiKeyStatus }) {
  const { busy, run } = useAction();
  const refresh = useRefreshAiSetup();
  const confirm = useConfirm();
  const label = CONNECT_LABELS[connection.provider];
  const login = connection.login;
  const act = async (fn: () => Promise<ConnectStatus>, success?: (result: ConnectStatus) => string | null) => {
    await run(fn, { refresh: false, success });
    await refresh();
  };
  const isClaude = connection.provider === 'cli_claude';
  const viaKey = connection.provider === 'cli_cursor' && connection.plan === CURSOR_KEY_PLAN;
  const startLongLived = () => act(() => aiSetupApi.startLogin('cli_claude', 'long_lived'));
  const removeToken = async () => {
    if (!(await confirm({ title: 'Kalıcı Claude belirteci kaldırılsın mı?', message: 'Tarayıcı girişi varsa o kullanılır; yoksa Claude işleri durur.', confirmLabel: 'Kaldır', danger: true }))) return;
    await act(() => aiSetupApi.removeClaudeToken(), () => 'Kalıcı belirteç kaldırıldı');
  };
  const disconnect = async () => {
    if (!(await confirm({ title: `${label} bağlantısı kesilsin mi?`, message: 'Yapay zekâ işleri sıradaki sağlayıcıyla (ya da kopyala-yapıştırla) sürer. İstediğin zaman yeniden bağlayabilirsin.', confirmLabel: 'Bağlantıyı kes', danger: true }))) return;
    await act(() => aiSetupApi.logout(connection.provider), (result) => (result.connected ? null : `${label} bağlantısı kesildi`));
  };

  return (
    <li className="flex flex-col gap-3 rounded-xl border border-line p-3">
      <div className="flex flex-wrap items-center gap-3">
        <StatusIcon connection={connection} />
        <div className="min-w-0 flex-1 basis-44">
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
            {CONNECT_TITLES[connection.provider]}
            {connection.connected && <Badge tone="good">Bağlı</Badge>}
          </p>
          <p className="text-sm break-words text-ink-soft">{connectionSummary(connection)}</p>
        </div>
        {connection.installed && !loginInProgress(login) && (
          <span className="flex flex-wrap gap-2">
            {isClaude && !connection.longLived && (
              <Button size="sm" variant={connection.connected ? 'tonal' : 'primary'} loading={busy} icon={<KeyRound className="size-4" aria-hidden />} onClick={() => void startLongLived()}>
                Kalıcı bağla (1 yıl)
              </Button>
            )}
            {isClaude && connection.longLived && (
              <Button size="sm" variant="ghost" disabled={busy} icon={<Trash2 className="size-4" aria-hidden />} onClick={() => void removeToken()}>
                Belirteci kaldır
              </Button>
            )}
            {connection.connected && !connection.longLived && !viaKey ? (
              <Button size="sm" variant="ghost" disabled={busy} icon={<LogOut className="size-4" aria-hidden />} onClick={() => void disconnect()}>
                Bağlantıyı kes
              </Button>
            ) : (
              !connection.connected && (
                <Button size="sm" variant={isClaude ? 'ghost' : 'primary'} loading={busy} onClick={() => void act(() => aiSetupApi.startLogin(connection.provider))}>
                  {isClaude ? 'Tarayıcıyla bağla' : CONNECT_ACTIONS[connection.provider]}
                </Button>
              )
            )}
          </span>
        )}
      </div>
      {!connection.installed && <p className="text-xs text-ink-soft">{CLI_MISSING_HINT}</p>}
      {isClaude && connection.installed && !connection.longLived && !loginInProgress(login) && (
        <>
          <p className="text-xs text-ink-soft">Tarayıcıyla bağlantı birkaç haftada bir düşer. "Kalıcı bağla" aboneliğinle bir yıl geçerli bir belirteç oluşturur; Claude işleri kesintisiz sürer. Bitişine üç gün kala uyarı gelir.</p>
          <ClaudeTokenForm busy={busy} onSave={(token) => void act(() => aiSetupApi.saveClaudeToken(token), () => 'Kalıcı Claude belirteci kaydedildi')} />
        </>
      )}
      {connection.provider === 'cli_cursor' && connection.installed && cursorKey && !loginInProgress(login) && (
        <details className="rounded-lg border border-line p-3" open={viaKey}>
          <summary className="cursor-pointer text-sm font-medium">Tarayıcı yerine Cursor anahtarıyla bağla</summary>
          <div className="mt-3 flex flex-col gap-2">
            <p className="text-xs text-ink-soft">Cursor panelinde Integrations › User API Keys bölümünden bir anahtar oluştur. Anahtar senin Cursor hesabını temsil eder; işler bu hesabın kullanımına yazılır (Cursor panelindeki Usage bölümünden izleyebilirsin). Tarayıcı girişi düşse de çalışmaya devam eder.</p>
            <ApiKeyRow provider="cli_cursor" status={cursorKey} />
          </div>
        </details>
      )}
      {login && loginInProgress(login) && (
        <LoginSteps
          connection={connection}
          busy={busy}
          onCode={(code) => void act(() => aiSetupApi.submitCode(connection.provider, code), (result) => (result.connected ? `${label} bağlandı` : null))}
          onCancel={() => void act(() => aiSetupApi.cancelLogin(connection.provider))}
        />
      )}
      {login && (login.phase === 'failed' || login.phase === 'expired') && (
        <Notice tone="error" icon={<CircleAlert className="size-5 shrink-0" aria-hidden />}>
          <span className="block">{login.message ?? 'Giriş tamamlanmadı.'}</span>
          <span className="block text-ink-soft">Yeniden bağlamayı dene.</span>
        </Notice>
      )}
    </li>
  );
}

function ApiKeyRow({ provider, status }: { provider: ApiKeyProviderName; status: ApiKeyStatus }) {
  const { busy, run } = useAction();
  const refresh = useRefreshAiSetup();
  const confirm = useConfirm();
  const [key, setKey] = useState('');
  const meta = API_KEY_LABELS[provider];
  const save = async () => {
    const saved = await run(() => aiSetupApi.saveApiKey(provider, key.trim()), { refresh: false, success: `${meta.title} kaydedildi` });
    if (saved) setKey('');
    await refresh();
  };
  const remove = async () => {
    if (!(await confirm({ title: `${meta.title} silinsin mi?`, message: 'Sunucunun .env dosyasında yedek anahtar varsa o kullanılır.', confirmLabel: 'Sil', danger: true }))) return;
    await run(() => aiSetupApi.deleteApiKey(provider), { refresh: false, success: 'Anahtar silindi' });
    await refresh();
  };
  const current =
    status.source === 'stored'
      ? `Kayıtlı: …${status.last4}${status.savedAt ? ` (${fmtDateTime(status.savedAt)})` : ''}`
      : status.source === 'env'
        ? 'Sunucunun .env dosyasındaki anahtar kullanılıyor; buraya girersen bu kullanılır.'
        : 'Girilmedi.';

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (key.trim()) void save();
      }}
    >
      <div className="flex flex-wrap items-end gap-2">
        <Field label={meta.title} className="min-w-0 flex-1 basis-60">
          {(props) => <Input {...props} type="password" autoComplete="off" spellCheck={false} placeholder={meta.placeholder} value={key} onChange={(e) => setKey(e.target.value)} />}
        </Field>
        <Button type="submit" loading={busy} disabled={!key.trim()} icon={<KeyRound className="size-4" aria-hidden />}>
          Kaydet
        </Button>
        {status.source === 'stored' && (
          <Button variant="danger" disabled={busy} icon={<Trash2 className="size-4" aria-hidden />} onClick={() => void remove()}>
            Sil
          </Button>
        )}
      </div>
      <p className="text-xs text-ink-soft">
        {current}{' '}
        <a href={meta.console} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">
          Anahtarı nereden alırım?
        </a>
      </p>
    </form>
  );
}

function ManualChoice({ status }: { status: AiSetupStatus }) {
  const { busy, run } = useAction();
  const refresh = useRefreshAiSetup();
  const choose = async (accepted: boolean) => {
    await run(() => aiSetupApi.acceptManual(accepted), { refresh: false, success: accepted ? 'Kopyala-yapıştır ile devam ediliyor' : undefined });
    await refresh();
  };
  if (status.ready) return null;
  return status.manualAccepted ? (
    <p className="flex flex-wrap items-center gap-2 text-sm text-ink-soft">
      Kopyala-yapıştır ile devam ediyorsun.
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void choose(false)}>
        Geri al
      </Button>
    </p>
  ) : (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="tonal" loading={busy} icon={<ClipboardPaste className="size-4" aria-hidden />} onClick={() => void choose(true)}>
        Kopyala-yapıştır ile devam et
      </Button>
      <span className="text-xs text-ink-soft">Hesap bağlamadan: AI işi geldiğinde istemi Claude ya da ChatGPT sohbetine yapıştırıp cevabı geri yapıştırırsın.</span>
    </div>
  );
}

/**
 * Yapay zekâ bağlantısı: yönetici Claude / ChatGPT hesabını butonla bağlar ya da API anahtarı girer; herkes
 * kopyala-yapıştır köprüsüyle devam etmeyi seçebilir.
 */
export function AiConnectPanel({ status }: { status: AiSetupStatus }) {
  if (!status.canManage) {
    return (
      <div className="flex flex-col gap-3">
        {!status.ready && (
          <p className="text-sm text-ink-soft">
            {status.cliAllowed ? 'Sunucu yöneticisi henüz bir yapay zekâ hesabı bağlamadı.' : 'Yöneticinin aboneliği bu hesapla paylaşılmıyor.'} Yöneticiden hesabı bağlamasını isteyebilir ya da kopyala-yapıştır ile
            devam edebilirsin.
          </p>
        )}
        <ManualChoice status={status} />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col gap-2">
        {(status.connections ?? []).map((connection) => (
          <ConnectionCard key={connection.provider} connection={connection} cursorKey={status.apiKeys?.cli_cursor} />
        ))}
      </ul>
      {status.apiKeys && (
        <details className="group rounded-xl border border-line p-3">
          <summary className="cursor-pointer text-sm font-medium">Abonelik yerine API anahtarı kullan</summary>
          <div className="mt-3 flex flex-col gap-4">
            <p className="text-xs text-ink-soft">Kullandıkça ücretlendirilir. Anahtar şifreli saklanır ve bir daha gösterilmez; aboneliğin limiti dolduğunda da sıradaki sağlayıcı olarak kullanılır.</p>
            {PAID_API_KEYS.map((provider) => (
              <ApiKeyRow key={provider} provider={provider} status={status.apiKeys![provider]} />
            ))}
          </div>
        </details>
      )}
      <ManualChoice status={status} />
    </div>
  );
}
