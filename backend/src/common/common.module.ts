import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuditService } from './audit.service';
import { env } from './env';
import { OutboxService } from './outbox.service';
import { PrismaService } from './prisma.service';
import { StorageService } from './storage.service';
import { ScopeService } from './scope.service';
import { UsageService } from './usage.service';

@Global()
@Module({
  imports: [
    JwtModule.register({
      global: true,
      secret: env().JWT_SECRET,
      signOptions: { expiresIn: env().JWT_ACCESS_TTL_SECONDS },
    }),
  ],
  providers: [PrismaService, OutboxService, AuditService, StorageService, UsageService, ScopeService],
  exports: [PrismaService, OutboxService, AuditService, StorageService, UsageService, ScopeService],
})
export class CommonModule {}
