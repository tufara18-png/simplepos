import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST,OPTIONS"};
const categories=["rent","utilities","inventory","payroll","insurance","software","professional","maintenance","marketing","taxes","financing","goodwill","equipment","other"];
const json=(status:number,body:unknown)=>new Response(JSON.stringify(body),{status,headers:{...cors,"content-type":"application/json"}});

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
  if(req.method!=="POST")return json(405,{error:"method_not_allowed"});
  const key=Deno.env.get("OPENAI_API_KEY");
  if(!key)return json(503,{error:"extractor_not_configured",message:"OPENAI_API_KEY is not configured on this Supabase project."});
  try{
    const body=await req.json();
    const {file_data,mime_type,file_name}=body||{};
    if(typeof file_data!=="string"||!file_data)return json(400,{error:"file_data_required"});
    const mime=String(mime_type||"image/jpeg");
    if(!["image/jpeg","image/png","image/webp","application/pdf"].includes(mime))return json(415,{error:"unsupported_file_type"});
    const instruction=`Extract accounting information from this restaurant supplier invoice, receipt, lease invoice or business expense document. Do not guess missing values. Amounts are decimal numbers in the document currency. Categorize using exactly one of: ${categories.join(", ")}. For Quebec documents, identify GST/TPS and QST/TVQ separately when visible. confidence is 0 to 1 for the overall extraction.`;
    const attachment=mime==="application/pdf"
      ? {type:"input_file",filename:String(file_name||"document.pdf"),file_data:`data:${mime};base64,${file_data}`}
      : {type:"input_image",image_url:`data:${mime};base64,${file_data}`,detail:"high"};
    const payload={model:Deno.env.get("OPENAI_RECEIPT_MODEL")||"gpt-5-mini",input:[{role:"user",content:[{type:"input_text",text:instruction},attachment]}],text:{format:{type:"json_schema",name:"business_cost_extraction",strict:true,schema:{type:"object",additionalProperties:false,properties:{vendor:{type:["string","null"]},invoice_reference:{type:["string","null"]},document_date:{type:["string","null"],description:"YYYY-MM-DD when visible"},currency:{type:["string","null"]},subtotal:{type:["number","null"]},gst:{type:["number","null"]},qst:{type:["number","null"]},total:{type:["number","null"]},category:{type:"string",enum:categories},description:{type:["string","null"]},recurrence_hint:{type:"string",enum:["one_time","weekly","monthly","quarterly","yearly","unknown"]},confidence:{type:"number",minimum:0,maximum:1},warnings:{type:"array",items:{type:"string"}}},required:["vendor","invoice_reference","document_date","currency","subtotal","gst","qst","total","category","description","recurrence_hint","confidence","warnings"]}}}};
    const r=await fetch("https://api.openai.com/v1/responses",{method:"POST",headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},body:JSON.stringify(payload)});
    const data=await r.json().catch(()=>({}));
    if(!r.ok)return json(502,{error:"extractor_upstream_error",status:r.status,detail:data?.error?.message||"OpenAI request failed"});
    const text=data?.output?.flatMap((x:any)=>x?.content||[]).find((x:any)=>x?.type==="output_text")?.text;
    if(!text)return json(502,{error:"empty_extraction"});
    return json(200,{ok:true,extracted:JSON.parse(text),model:data?.model||null});
  }catch(e){return json(500,{error:"extractor_failed",message:e instanceof Error?e.message:String(e)});}
});
