import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Relay-only, on purpose: SW-76 4.1.2 is explicit that a serveur distant "ne peut pas créer,
// ni modifier, ni supprimer de transactions. Il peut seulement les acheminer au MEV-WEB." This
// function holds to that for "certificats" requests too -- it forwards the header/body a
// client already built and signed, and never generates or sees a private key. The client
// (MevKeystorePlugin on Android; nothing yet on iOS/web, since neither has a real Keystore-
// backed key) is the only place that ever touches key material.
//
// Locked until mev_partner_config has real values -- there is nothing to enrol with yet.
//
// NOT CURRENTLY USED FOR REAL REQUESTS. Confirmed live against Revenu Québec's DEV
// "enrolement" endpoint (2026-08-21) that requests relayed through this function's fetch()
// arrive with IDVERSI empty, even though the same headers sent directly (curl, Node's
// https module) are received correctly by the same endpoint -- something specific to this
// Deno/Supabase Edge Runtime's outbound fetch, not fixed by forcing HTTP/1.1 below, root
// cause still unknown. The app now calls Revenu Québec directly from the Android device
// instead (native networking, no relay), which sidesteps whatever this is. Kept here as a
// reference for a future "mode serveur" architecture, not wired into the app -- do not call
// this for a real certificats/transaction request until the Deno-side bug is understood.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

const json = (body: unknown, status = 200) => Response.json(body, {
  status,
  headers: { "cache-control": "no-store", ...cors },
});

// SW-73 Tableau 12: "AJO" goes to /enrolement, "REM"/"SUP" go to /certificats.
function endpointFor(modif: string, environment: string): string {
  const confirm = environment === "PROD" ? "" : "cnfr.";
  return modif === "AJO"
    ? `https://certificats.${confirm}api.rq-fo.ca/enrolement`
    : `https://${confirm}api.rq-fo.ca/certificats`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST required" }, 405);

  const envelope = await req.json().catch(() => null);
  const modif = envelope?.reqCertif?.modif;
  const headers = envelope?.headers;
  const environment = headers?.ENVIRN;
  if (!modif || !["AJO", "REM", "SUP"].includes(modif)) {
    return json({ error: "reqCertif.modif doit être AJO, REM ou SUP" }, 400);
  }
  if (!["DEV", "ESSAI", "PROD"].includes(environment)) {
    return json({ error: "headers.ENVIRN doit être DEV, ESSAI ou PROD" }, 400);
  }

  // Nothing upstream of this point can succeed without real partner enrolment: the caller's
  // headers still need a real IDPARTN/CODCERTIF/authorization code that only Revenu Québec
  // issues. Fail closed with a clear reason instead of attempting a request that would just
  // bounce off the MEV-WEB with an authorization error, which would be harder to diagnose.
  if (!headers?.IDPARTN || !headers?.NOTPS || !headers?.NOTVQ) {
    return json({
      error: "enrollment_not_configured",
      message: "Inscription partenaire incomplète (IDPARTN/NOTPS/NOTVQ manquants). Complétez l'inscription dans Mon dossier pour les partenaires avant de tenter une requête certificats.",
    }, 503);
  }

  const outgoingHeaders: Record<string, string> = {
    "content-type": "application/json",
    ENVIRN: headers.ENVIRN,
    CASESSAI: headers.CASESSAI || "000.000",
    APPRLINIT: headers.APPRLINIT || "SEV",
    ...(headers.IDAPPRL ? { IDAPPRL: headers.IDAPPRL } : {}),
    NOTPS: headers.NOTPS,
    NOTVQ: headers.NOTVQ,
    ...(headers.IDSEV ? { IDSEV: headers.IDSEV } : {}),
    ...(headers.IDVERSI ? { IDVERSI: headers.IDVERSI } : {}),
    ...(headers.CODCERTIF ? { CODCERTIF: headers.CODCERTIF } : {}),
    IDPARTN: headers.IDPARTN,
    ...(headers.VERSI ? { VERSI: headers.VERSI } : {}),
    ...(headers.VERSIPARN ? { VERSIPARN: headers.VERSIPARN } : {}),
  };

  // Forced to HTTP/1.1: HTTP/2 mandates lowercase header field names on the wire (RFC 7540
  // 8.1.2) regardless of the case used here. Confirmed live that going through Deno's default
  // fetch (HTTP/2) makes Revenu Québec report IDVERSI as absent, while an HTTP/1.1 curl with
  // the identical uppercase header names works -- their gateway/backend for this endpoint
  // apparently does a case-sensitive lookup on at least this one field.
  const http1Client = Deno.createHttpClient({ http1: true, http2: false });
  let text: string;
  let status: number;
  try {
    const upstream = await fetch(endpointFor(modif, environment), {
      method: "POST",
      headers: outgoingHeaders,
      body: JSON.stringify({ reqCertif: envelope.reqCertif }),
      client: http1Client,
    });
    text = await upstream.text();
    status = upstream.status;
  } catch (e) {
    text = JSON.stringify({ error: "network_error", message: String(e) });
    status = 502;
  } finally {
    http1Client.close();
  }

  return new Response(text, { status: status || 502, headers: { "content-type": "application/json", ...cors } });
});
