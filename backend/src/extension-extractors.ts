import { writeFileSync } from 'fs';
import { join } from 'path';
import { EXTRACTORS_PATH, renderExtractors } from './engine/scrapers/extension-extractors';

/** Eklentinin okuma dosyasını sunucudaki okuma betiklerinden üretir. Kullanım: npm run extension:extractors */
const target = join(__dirname, '..', '..', EXTRACTORS_PATH);
writeFileSync(target, renderExtractors());
console.log(`Yazıldı: ${target}`);
