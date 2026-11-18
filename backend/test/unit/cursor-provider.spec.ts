import { withCursor } from '../../src/engine/ai/ai.service';
import { cursorAuthState, parseCursorResult } from '../../src/engine/ai/providers';

describe('Cursor CLI sağlayıcısı', () => {
  it('JSON sonucundan metni ve hatayı ayıklar', () => {
    expect(parseCursorResult('{"type":"result","subtype":"success","is_error":false,"result":"{\\"ok\\":true}","duration_ms":900}\n')).toEqual({ text: '{"ok":true}', error: null, model: null });
    expect(parseCursorResult('{"type":"result","is_error":true,"result":"You have hit your usage limit"}').error).toMatch(/usage limit/);
    expect(parseCursorResult('Error: Authentication required. Please run agent login first.').error).toMatch(/Authentication required/);
  });

  it('oturum durumunu ve geçersiz anahtarı ayırt eder', () => {
    expect(cursorAuthState('{\n  "status": "authenticated",\n  "isAuthenticated": true\n}')).toBe('ok');
    expect(cursorAuthState('{"isAuthenticated": false}')).toBe('signed_out');
    expect(cursorAuthState('⚠ Warning: The provided API key is invalid.')).toBe('invalid_key');
  });

  it('Cursor, Claude ve ChatGPT CLI\'larından sonra yedek olarak sıraya girer', () => {
    expect(withCursor(['cli_claude', 'cli_codex', 'manual', 'template'])).toEqual(['cli_claude', 'cli_codex', 'cli_cursor', 'manual', 'template']);
    expect(withCursor(['manual', 'template'])).toEqual(['cli_cursor', 'manual', 'template']);
  });
});
