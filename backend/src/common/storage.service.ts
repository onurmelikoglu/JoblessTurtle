import { Injectable } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';
import { env } from './env';

/**
 * Depolama adaptörü: pilotta özel kalıcı volume. S3 uyumlu depo aynı arayüzle eklenebilir.
 * Dosyalar hiçbir zaman doğrudan internete açılmaz; yetkili indirme API üzerinden yapılır.
 */
export interface ObjectStore {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

@Injectable()
export class StorageService implements ObjectStore {
  private root() {
    return path.resolve(env().STORAGE_DIR);
  }

  private resolve(key: string) {
    const safe = key.replace(/\.\.+/g, '').replace(/^\/+/, '');
    const full = path.join(this.root(), safe);
    if (!full.startsWith(this.root())) throw new Error('Geçersiz depolama anahtarı');
    return full;
  }

  async put(key: string, data: Buffer) {
    const full = this.resolve(key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, data, { mode: 0o600 });
  }

  async get(key: string) {
    return fs.readFile(this.resolve(key));
  }

  async delete(key: string) {
    await fs.rm(this.resolve(key), { force: true });
  }
}
