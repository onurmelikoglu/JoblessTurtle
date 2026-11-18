-- Kapanan ilanın yeniden açıldığı an: Şirketler sayfası "başvurudan sonra yeniden açıldı" bilgisini buradan okur.
ALTER TABLE "Job" ADD COLUMN "reopenedAt" TIMESTAMP(3);
