import "jsr:@supabase/functions-js/edge-runtime.d.ts";

type Json = Record<string, unknown>;

const money = (n: unknown) => {
  const v = Number(n ?? 0);
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
};

class MevOrderEnvelope {
  static fromInvoice(invoice: Json) {
    return {
      operation: "SALE_CLOSE",
      source: "SIMPLEPOS",
      environment: "SIMULATOR",
      invoice_id: invoice.id ?? null,
      table_id: invoice.table_id ?? null,
      payment_method: invoice.payment_method ?? null,
      amounts: {
        subtotal: money(invoice.subtotal),
        gst: money(invoice.gst),
        qst: money(invoice.qst),
        total: money(invoice.total),
        tip: money(invoice.tip),
        payment_total: money(invoice.payment_total),
      },
      items: Array.isArray(invoice.items) ? invoice.items : [],
      client_timestamp: new Date().toISOString(),
    };
  }
}

class MevController {
  async submit(invoice: Json) {
    const request = MevOrderEnvelope.fromInvoice(invoice);
    const now = new Date();
    const tx = `SIM-${now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    const documentId = `DOC-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
    const total = money(invoice.total);

    // Simulation only. These field names model the architecture of a fiscal
    // gateway; they do not claim to reproduce Revenu Quebec's private protocol.
    return {
      environment: "SIMULATOR",
      certified: false,
      status: "accepted",
      remote_status: "completed",
      retryable: false,
      transaction_id: tx,
      document_id: documentId,
      invoice_id: invoice.id ?? null,
      received_at: now.toISOString(),
      total,
      request_summary: request,
      order_summary: {
        table_id: invoice.table_id ?? null,
        item_count: Array.isArray(invoice.items) ? invoice.items.length : 0,
        payment_method: invoice.payment_method ?? null,
      },
      receipt: {
        type: "CLOSING_RECEIPT",
        transaction_id: tx,
        document_id: documentId,
        total,
        qr_payload: `SIMPLEPOS|SIMULATOR|${tx}|${documentId}|${total.toFixed(2)}`,
      },
      qr_payload: `SIMPLEPOS|SIMULATOR|${tx}|${documentId}|${total.toFixed(2)}`,
      warnings: [
        "Simulation seulement — aucune transmission à Revenu Québec.",
        "Le format final sera remplacé par les spécifications et certificats officiels MEV-WEB.",
      ],
    };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "GET") {
    return Response.json({
      service: "SimplePOS MEV simulator",
      status: "ready",
      environment: "SIMULATOR",
      certified: false,
      architecture: ["order-envelope", "controller", "response-status", "receipt", "retryable-status"],
    }, { headers: { "cache-control": "no-store" } });
  }

  if (req.method !== "POST") {
    return Response.json({ error: "POST required" }, { status: 405 });
  }

  const invoice = await req.json().catch(() => ({})) as Json;
  if (!invoice.id || money(invoice.total) < 0) {
    return Response.json({
      environment: "SIMULATOR",
      certified: false,
      status: "rejected",
      remote_status: "validation_error",
      retryable: false,
      error_code: "SIM_INVALID_INVOICE",
      error: "Invoice id and a valid total are required.",
    }, { status: 422, headers: { "cache-control": "no-store" } });
  }

  return Response.json(await new MevController().submit(invoice), {
    headers: { "cache-control": "no-store" },
  });
});
