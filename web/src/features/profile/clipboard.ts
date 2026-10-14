import { toast } from '@/ui/toast';

/** Pano yalnızca güvenli bağlamda ve kullanıcı etkileşiminin hemen ardından yazılabilir; yazılamazsa metin kaybolmasın diye bildirimde gösterilir. */
export async function copyText(text: string, message = 'Panoya kopyalandı') {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(message);
  } catch {
    toast.warn(`Panoya kopyalanamadı, elle kopyala: ${text}`);
  }
}
