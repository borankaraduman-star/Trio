/** `GET <origin>/api/health` must answer 200 `{"ok": true}`. */
export type HealthResult = { ok: true } | { ok: false; message: string };

export type Fetcher = (url: string, init: { signal: AbortSignal }) => Promise<{
  status: number;
  json(): Promise<unknown>;
}>;

export async function checkHealth(
  origin: string,
  fetcher: Fetcher,
  timeoutMs = 8000,
): Promise<HealthResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetcher(`${origin}/api/health`, { signal: controller.signal });
    if (res.status !== 200) {
      return { ok: false, message: `Sunucu beklenmeyen bir yanıt verdi (HTTP ${res.status}). Adres doğru mu?` };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { ok: false, message: "Bu adreste bir Trio sunucusu yok gibi görünüyor." };
    }
    if (typeof body === "object" && body !== null && (body as { ok?: unknown }).ok === true) {
      return { ok: true };
    }
    return { ok: false, message: "Bu adreste bir Trio sunucusu yok gibi görünüyor." };
  } catch {
    return {
      ok: false,
      message: controller.signal.aborted
        ? "Sunucu zamanında yanıt vermedi."
        : "Sunucuya ulaşılamadı. Adresi ve internet bağlantını kontrol et.",
    };
  } finally {
    clearTimeout(timer);
  }
}
