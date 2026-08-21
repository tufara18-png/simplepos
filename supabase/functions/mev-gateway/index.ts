import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Without these, a real cross-origin browser call (any deployed origin, or a Capacitor
// app's localhost) never gets past its own CORS preflight: the POST carries
// Content-Type: application/json + Authorization, which forces an OPTIONS preflight first,
// and a 405 with no Access-Control-Allow-Origin makes the browser block the real request
// before it is ever sent. Confirmed live against this project with a manual OPTIONS probe.
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};

const json = (body: unknown, status = 200) => Response.json(body, {
  status,
  headers: { "cache-control": "no-store", ...cors },
});

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method === "GET") {
    const transport = Deno.env.get("MEV_TRANSPORT") || "simulator";
    return json({
      service: "Resto360 MEV gateway",
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
    headers: { "content-type": "application/json", "cache-control": "no-store", ...cors },
  });
});
