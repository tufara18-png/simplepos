import "jsr:@supabase/functions-js/edge-runtime.d.ts";

function money(n: unknown) {
  const v = Number(n ?? 0);
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST required" }), {
      status: 405,
      headers: { "content-type": "application/json" },
    });
  }

  const invoice = await req.json().catch(() => ({}));
  const now = new Date();
  const tx = `SIM-${now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const total = money(invoice.total);

  const fiscal = {
    environment: "SIMULATOR",
    certified: false,
    status: "accepted",
    transaction_id: tx,
    received_at: now.toISOString(),
    invoice_id: invoice.id ?? null,
    total,
    qr_payload: `SIMPLEPOS|SIM|${tx}|${total.toFixed(2)}`,
    retryable: false,
    warnings: ["Simulation seulement — ne constitue pas une transmission à Revenu Québec."],
  };

  return new Response(JSON.stringify(fiscal), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
});
