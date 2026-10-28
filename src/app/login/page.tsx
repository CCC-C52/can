import { loginAction } from "@/app/actions";
import { flash, type SP } from "@/lib/current";
import { config } from "@/lib/config";
import { Flash } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: SP }) {
  const { err, one } = await flash(searchParams);
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <form action={loginAction} className="card w-full max-w-sm space-y-3">
        <h1 className="h1">AI Operations Studio</h1>
        <p className="muted">Yönetici girişi</p>
        <Flash err={err} />
        {!config.adminPassword && <p className="text-sm text-danger">ADMIN_PASSWORD tanımlı değil; giriş yapılamaz. Sunucu ortamını yapılandırın.</p>}
        <input type="hidden" name="next" value={one("next") ?? "/"} />
        <label className="label" htmlFor="pw">Parola</label>
        <input id="pw" name="password" type="password" required autoComplete="current-password" className="input" />
        <button className="btn-primary w-full">Giriş yap</button>
      </form>
    </div>
  );
}
