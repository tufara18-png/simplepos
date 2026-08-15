import "jsr:@supabase/functions-js/edge-runtime.d.ts";

type SimulationMode = "accepted" | "rejected" | "retryable" | "timeout";
type MevEnvelope = { invoice_id:string|null; table_id:string|null; document_type:"addition"|"closing_receipt"|"credit_note"|"correction"; totals:{subtotal:number;gst:number;qst:number;total:number;tip:number;payment_total:number}; payment_method:string|null; items:Array<{name:string;price:number}>; simulation:SimulationMode };
const round2=(n:unknown)=>{const v=Number(n??0);return Number.isFinite(v)?Math.round(v*100)/100:0};

class MevEnvelopeFactory {
  static from(input:Record<string,unknown>):MevEnvelope {
    const requested=String(input.simulate??"accepted") as SimulationMode;
    const simulation:SimulationMode=["accepted","rejected","retryable","timeout"].includes(requested)?requested:"accepted";
    return {
      invoice_id:typeof input.id==="string"?input.id:null,
      table_id:typeof input.table_id==="string"?input.table_id:null,
      document_type:(input.document_type as MevEnvelope["document_type"])??"closing_receipt",
      totals:{subtotal:round2(input.subtotal),gst:round2(input.gst),qst:round2(input.qst),total:round2(input.total),tip:round2(input.tip),payment_total:round2(input.payment_total??input.total)},
      payment_method:typeof input.payment_method==="string"?input.payment_method:null,
      items:Array.isArray(input.items)?input.items.map((x:any)=>({name:String(x?.name??"Article"),price:round2(x?.price)})):[],
      simulation
    };
  }
}

class SimulatorTransport {
  async submit(envelope:MevEnvelope) {
    const now=new Date();
    const transactionId=`SIM-${now.toISOString().replace(/[-:.TZ]/g,"").slice(0,14)}-${crypto.randomUUID().slice(0,8).toUpperCase()}`;
    const documentId=`SIM-DOC-${crypto.randomUUID().slice(0,12).toUpperCase()}`;

    if(envelope.simulation==="timeout"){
      await new Promise(r=>setTimeout(r,350));
      return {environment:"SIMULATOR",certified:false,status:"retryable",transaction_id:transactionId,document_id:null,received_at:now.toISOString(),retryable:true,retry_after_seconds:60,error:{code:"SIM_TIMEOUT",message:"Timeout simulé. Transaction à retransmettre."},qr_payload:null,receipt:null};
    }
    if(envelope.simulation==="retryable"){
      return {environment:"SIMULATOR",certified:false,status:"retryable",transaction_id:transactionId,document_id:null,received_at:now.toISOString(),retryable:true,retry_after_seconds:60,error:{code:"SIM_TEMPORARY",message:"Erreur temporaire simulée."},qr_payload:null,receipt:null};
    }
    if(envelope.simulation==="rejected"){
      return {environment:"SIMULATOR",certified:false,status:"rejected",transaction_id:transactionId,document_id:null,received_at:now.toISOString(),retryable:false,error:{code:"SIM_REJECTED",message:"Transaction rejetée par le simulateur."},qr_payload:null,receipt:null};
    }

    return {
      environment:"SIMULATOR",
      certified:false,
      status:"accepted",
      transaction_id:transactionId,
      document_id:documentId,
      received_at:now.toISOString(),
      retryable:false,
      retry_after_seconds:null,
      error:null,
      // Intentionally non-fiscal. Never treat this as an official RQ QR payload.
      qr_payload:`SIMPLEPOS|SIMULATED-NOT-FISCAL|${transactionId}|${envelope.totals.total.toFixed(2)}`,
      receipt:{document_type:envelope.document_type,fiscal_document_id:documentId,invoice_id:envelope.invoice_id,totals:envelope.totals,payment_method:envelope.payment_method,generated_at:now.toISOString(),simulated:true},
      warnings:["Simulation seulement — aucune transmission à Revenu Québec."]
    };
  }
}

class MevController {
  constructor(private transport:SimulatorTransport) {}
  createEnvelope(input:Record<string,unknown>){return MevEnvelopeFactory.from(input)}
  async submit(input:Record<string,unknown>){return this.transport.submit(this.createEnvelope(input))}
}

Deno.serve(async(req:Request)=>{
  if(req.method==="GET") return Response.json({service:"SimplePOS MEV simulator",status:"ready",environment:"SIMULATOR",certified:false,states:["accepted","rejected","retryable","timeout"]},{headers:{"cache-control":"no-store"}});
  if(req.method!=="POST") return new Response(JSON.stringify({error:"POST required"}),{status:405,headers:{"content-type":"application/json"}});
  const input=await req.json().catch(()=>({}));
  const result=await new MevController(new SimulatorTransport()).submit(input);
  return new Response(JSON.stringify(result),{status:200,headers:{"content-type":"application/json","cache-control":"no-store"}});
});
