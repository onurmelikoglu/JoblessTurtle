import { Injectable } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { ExtensionKeyCreated, ExtensionKeyStatus } from '../../contracts/scrapers';
import { ServerShape } from '../../contracts/wire';
import { randomToken, sha256 } from '../../common/crypto';
import { AppError } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';

const KEY_PREFIX = 'jt_';
const KEY_FORMAT = /^jt_([a-z0-9]{20,40})\.([A-Za-z0-9_-]{40,60})$/;
const USE_RECORD_INTERVAL_MS = 60_000;

/**
 * Tarayıcı eklentisinin anahtarı: "jt_<kimlik>.<gizli>". Kimlikle kayıt bulunur, gizli kısmın özeti sabit zamanlı
 * karşılaştırılır; düz metin yalnızca üretildiği yanıtta döner. Yeni anahtar eskisini geçersiz kılar.
 */
@Injectable()
export class ExtensionKeyService {
  constructor(private readonly prisma: PrismaService) {}

  async status(userId: string): Promise<ServerShape<ExtensionKeyStatus>> {
    const row = await this.prisma.extensionKey.findUnique({ where: { userId } });
    return { exists: !!row, created_at: row?.createdAt ?? null, last_used_at: row?.lastUsedAt ?? null };
  }

  async create(userId: string): Promise<ServerShape<ExtensionKeyCreated>> {
    const secret = randomToken(32);
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.extensionKey.deleteMany({ where: { userId } });
      return tx.extensionKey.create({ data: { userId, secretHash: sha256(secret) } });
    });
    return { key: `${KEY_PREFIX}${row.id}.${secret}`, created_at: row.createdAt };
  }

  async revoke(userId: string): Promise<void> {
    await this.prisma.extensionKey.deleteMany({ where: { userId } });
  }

  async displayName(userId: string): Promise<string> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { displayName: true } });
    return user.displayName;
  }

  /** Anahtarın sahibi; anahtar yoksa, biçimi bozuksa, iptal edildiyse ya da eşleşmiyorsa 401. */
  async verify(header: string | undefined): Promise<string> {
    if (!header?.trim()) throw new AppError(401, 'IMPORT_KEY_REQUIRED', 'Eklenti anahtarı gerekli (X-Import-Token)');
    const match = header.trim().match(KEY_FORMAT);
    const row = match ? await this.prisma.extensionKey.findUnique({ where: { id: match[1] } }) : null;
    const expected = Buffer.from(row?.secretHash ?? sha256(''), 'hex');
    const given = Buffer.from(sha256(match?.[2] ?? ''), 'hex');
    if (!row || !timingSafeEqual(expected, given)) throw new AppError(401, 'IMPORT_KEY_INVALID', 'Eklenti anahtarı geçersiz ya da iptal edilmiş; Profilim > Tarayıcı eklentisi bölümünden yeni anahtar üret');
    const now = new Date();
    if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() > USE_RECORD_INTERVAL_MS) await this.prisma.extensionKey.update({ where: { id: row.id }, data: { lastUsedAt: now } });
    return row.userId;
  }
}
