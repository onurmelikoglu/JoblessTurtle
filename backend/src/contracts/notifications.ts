/**
 * Uygulama içi bildirimler API'sinin (/v1/notifications) yanıt sözleşmesi; web arayüzü bu dosyayı yalnızca tip olarak
 * içe aktarır.
 */
import type { NotificationClearRange } from '../domain/notifications';
import type { IsoDate } from './wire';

export type { NotificationClearRange };

export interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: IsoDate | null;
  createdAt: IsoDate;
}

/** Filtreye uyan bildirimlerin bir sayfası; en yeni önce. */
export interface NotificationPage {
  items: NotificationItem[];
  /** Filtreye uyan toplam kayıt. */
  total: number;
  /** Filtreden bağımsız, son 30 gündeki okunmamış bildirim sayısı. */
  unread: number;
  next_cursor: string | null;
}

export interface NotificationDeleteResult {
  deleted: number;
}
