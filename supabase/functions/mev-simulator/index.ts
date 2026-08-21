import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// See mev-gateway/index.ts for why this is required, not optional -- confirmed live
// against this project that a preflight without it gets blocked before the real POST.
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};

type SimulationMode = "accepted" | "rejected" | "retryable" | "timeout";
type DocumentType = "addition" | "closing_receipt" | "credit_note" | "correction";
type MevEnvelope = {
  invoice_id: string | null;
  table_id: string | null;
  operation: string;
  document_type: DocumentType;
  totals: { subtotal:number; gst:number; qst:number; total:number; tip:number; payment_total:number };
  payment_method: string | null;
  items: Array<{name:string; quantity:number; unit_price:number; line_total:number}>;
  simulation: SimulationMode;
};

const round2 = (n:unknown) => {
  const v = Number(n ?? 0);
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
};

class MevEnvelopeFactory {
  static from(input:Record<string,unknown>):MevEnvelope {
    const requested = String(input.simulate ?? "accepted") as SimulationMode;
    const simulation:SimulationMode = ["accepted","rejected","retryable","timeout"].includes(requested) ? requested : "accepted";
    const documentType = ["addition","closing_receipt","credit_note","correction"].includes(String(input.document_type))
      ? String(input.document_type) as DocumentType
      : "closing_receipt";
    return {
      invoice_id: typeof input.id === "string" ? input.id : null,
      table_id: typeof input.table_id === "string" ? input.table_id : null,
      operation: typeof input.operation === "string" ? input.operation : "sale_close",
      document_type: documentType,
      totals: {
        subtotal: round2(input.subtotal),
        gst: round2(input.gst),
        qst: round2(input.qst),
        total: round2(input.total),
        tip: round2(input.tip),
        payment_total: round2(input.payment_total ?? input.total),
      },
      payment_method: typeof input.payment_method === "string" ? input.payment_method : null,
      items: Array.isArray(input.items) ? input.items.map((x:any) => ({
        name: String(x?.name ?? "Article"),
        quantity: round2(x?.quantity ?? 1),
        unit_price: round2(x?.unit_price ?? x?.price),
        line_total: round2(x?.line_total ?? x?.price),
      })) : [],
      simulation,
    };
  }
}

class SimulatorTransport {
  async submit(envelope:MevEnvelope) {
    const now = new Date();
    const transactionId = `SIM-${now.toISOString().replace(/[-:.TZ]/g, "").slice(0,14)}-${crypto.randomUUID().slice(0,8).toUpperCase()}`;
    const documentId = `SIM-DOC-${crypto.randomUUID().slice(0,12).toUpperCase()}`;
    const base = {
      environment: "SIMULATOR",
      certified: false,
      transaction_id: transactionId,
      invoice_id: envelope.invoice_id,
      received_at: now.toISOString(),
      operation: envelope.operation,
      document_type: envelope.document_type,
    };

    if (envelope.simulation === "timeout") {
      await new Promise(r => setTimeout(r, 350));
      return { ...base, status:"retryable", remote_status:"timeout", document_id:null, retryable:true, retry_after_seconds:60, error_code:"SIM_TIMEOUT", error_message:"Timeout simulé. Transaction à retransmettre.", qr_payload:null, receipt:null };
    }
    if (envelope.simulation === "retryable") {
      return { ...base, status:"retryable", remote_status:"temporary_error", document_id:null, retryable:true, retry_after_seconds:60, error_code:"SIM_TEMPORARY", error_message:"Erreur temporaire simulée.", qr_payload:null, receipt:null };
    }
    if (envelope.simulation === "rejected") {
      return { ...base, status:"rejected", remote_status:"validation_rejected", document_id:null, retryable:false, retry_after_seconds:null, error_code:"SIM_REJECTED", error_message:"Transaction rejetée par le simulateur.", qr_payload:null, receipt:null };
    }

    const qr = `RESTO360|SIMULATED-NOT-FISCAL|${transactionId}|${documentId}|${envelope.totals.total.toFixed(2)}`;
    return {
      ...base,
      status:"accepted",
      remote_status:"completed",
      document_id:documentId,
      retryable:false,
      retry_after_seconds:null,
      error_code:null,
      error_message:null,
      qr_payload:qr,
      receipt:{
        document_type:envelope.document_type,
        fiscal_document_id:documentId,
        invoice_id:envelope.invoice_id,
        totals:envelope.totals,
        payment_method:envelope.payment_method,
        items:envelope.items,
        generated_at:now.toISOString(),
        simulated:true,
        qr_payload:qr,
      },
      warnings:[
        "Simulation seulement — aucune transmission à Revenu Québec.",
        "Le QR est volontairement non fiscal et sera remplacé par le format officiel lors de l'intégration MEV-WEB."
      ],
    };
  }
}

class MevController {
  constructor(private transport:SimulatorTransport) {}
  createEnvelope(input:Record<string,unknown>) { return MevEnvelopeFactory.from(input); }
  async submit(input:Record<string,unknown>) { return this.transport.submit(this.createEnvelope(input)); }
}

Deno.serve(async (req:Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method === "GET") {
    return Response.json({
      service:"Resto360 MEV simulator",
      status:"ready",
      environment:"SIMULATOR",
      certified:false,
      states:["accepted","rejected","retryable","timeout"],
      documents:["addition","closing_receipt","credit_note","correction"],
    }, { headers:{"cache-control":"no-store", ...cors} });
  }
  if (req.method !== "POST") return Response.json({ error:"POST required" }, { status:405, headers: cors });
  const input = await req.json().catch(() => ({}));
  if (!input.id) return Response.json({ environment:"SIMULATOR", certified:false, status:"rejected", retryable:false, error_code:"SIM_MISSING_ID", error_message:"Invoice id required" }, { status:422, headers: cors });
  const result = await new MevController(new SimulatorTransport()).submit(input);
  return Response.json(result, { status:200, headers:{"cache-control":"no-store", ...cors} });
});
