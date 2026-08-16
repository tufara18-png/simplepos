import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const json = (body: unknown, status = 200) => Response.json(body, {
  status,
  headers: { "cache-control": "no-store" },
});

Deno.serve(async (req: Request) => {
  if (req.method === "GET") {
    const transport = Deno.env.get("MEV_TRANSPORT") || "simulator";
    return json({
      service: "SimplePOS MEV gateway",
      transport,
      production_ready: false,
      note: transport === "simulator"
        ? "Simulator transport active."
        : "Official Revenu Quebec transport requires partner specifications and certificates.",
    });
  }

  if (req.method !== "POST") return json({ error: "POST required" }, 405);

  const transport = Deno.env.get("MEV_TRANSPORT") || "simulator";
  if (transport !== "simulator") {
    return json({
      environment: transport.toUpperCase(),
      certified: false,
      status: "configuration_required",
      retryable: false,
      error_code: "RQ_TRANSPORT_NOT_CONFIGURED",
      error_message: "Le transport MEV-WEB officiel est verrouille jusqu'a la configuration des specifications, identifiants et certificats Revenu Quebec.",
    }, 503);
  }

  const projectUrl = Deno.env.get("SUPABASE_URL");
  if (!projectUrl) return json({ error: "SUPABASE_URL missing" }, 500);

  const body = await req.text();
  const authorization = req.headers.get("authorization") || "";
  const apiKey = req.headers.get("apikey") || "";
  const upstream = await fetch(`${projectUrl}/functions/v1/mev-simulator`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorization ? { authorization } : {}),
      ...(apiKey ? { apikey: apiKey } : {}),
    },
    body,
  });

  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
});
