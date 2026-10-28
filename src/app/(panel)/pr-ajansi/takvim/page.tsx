import Link from "next/link";
import { requireBrand, flash, type SP } from "@/lib/current";
import { Flash, PageHeader } from "@/components/ui";
import { Icon } from "@/components/icons";
import { Calendar } from "../tabs";

export const metadata = { title: "İçerik Takvimi" };
export const dynamic = "force-dynamic";

export default async function ContentCalendarPage({ searchParams }: { searchParams: SP }) {
  const { ok, err } = await flash(searchParams);
  const brand = await requireBrand();
  return (
    <div>
      <PageHeader eyebrow="PR Ajansı" title="İçerik Takvimi" subtitle="ABD için 12 aylık kampanya takvimi: resmî tarihler yasa/kuralla hesaplanır, organizatör tarihleri sahibin doğruladığı kaynakla girilir. Her etkinliğin onay son günü ve koleksiyon uyumu gösterilir."
        actions={<><Link href="/takvim" className="btn"><Icon name="share" />Sosyal medya yayın takvimi</Link><Link href="/pr-ajansi/strateji#monthly" className="btn"><Icon name="strategy" />Aylık kampanya planı</Link></>} />
      <Flash ok={ok} err={err} />
      <Calendar brandId={brand.id} />
    </div>
  );
}
