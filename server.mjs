import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {fileURLToPath} from 'node:url';

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const PORT=Number(process.env.PORT||8787);
const TLS_CERT=process.env.TLS_CERT||'';
const TLS_KEY=process.env.TLS_KEY||'';
const BRIDGE_TOKEN=process.env.BRIDGE_TOKEN||'';
const ALLOWED_ORIGIN=process.env.ALLOWED_ORIGIN||'*';
const ALLOW_PUBLIC_PRINTER_IPS=process.env.ALLOW_PUBLIC_PRINTER_IPS==='1';
const VERSION='1.0.0';
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.webmanifest':'application/manifest+json'};

function cors(){return{'access-control-allow-origin':ALLOWED_ORIGIN,'access-control-allow-headers':'content-type,x-simplepos-token','access-control-allow-methods':'GET,POST,OPTIONS','cache-control':'no-store'}}
function json(res,code,obj){res.writeHead(code,{'content-type':'application/json',...cors()});res.end(JSON.stringify(obj))}
function readBody(req){return new Promise((resolve,reject)=>{let b='';req.on('data',d=>{b+=d;if(b.length>1024*1024){reject(new Error('payload too large'));req.destroy()}});req.on('end',()=>{try{resolve(b?JSON.parse(b):{})}catch(e){reject(e)}});req.on('error',reject)})}
function authorized(req){return !BRIDGE_TOKEN||req.headers['x-simplepos-token']===BRIDGE_TOKEN}
function isPrivateIp(ip){if(ALLOW_PUBLIC_PRINTER_IPS)return true;if(net.isIP(ip)===4){const p=ip.split('.').map(Number);return p[0]===10||(p[0]===172&&p[1]>=16&&p[1]<=31)||(p[0]===192&&p[1]===168)||p[0]===127}if(net.isIP(ip)===6)return ip==='::1'||ip.toLowerCase().startsWith('fc')||ip.toLowerCase().startsWith('fd')||ip.toLowerCase().startsWith('fe80:');return false}
function escpos(text,cut=true){const init=Buffer.from([0x1b,0x40]);const body=Buffer.from(text+'\n','utf8');const feed=Buffer.from([0x1b,0x64,0x04]);const cutter=cut?Buffer.from([0x1d,0x56,0x00]):Buffer.alloc(0);return Buffer.concat([init,body,feed,cutter])}
function tcpPrint(ip,port,data){return new Promise((resolve,reject)=>{let settled=false;const done=err=>{if(settled)return;settled=true;err?reject(err):resolve()};const s=net.createConnection({host:ip,port,timeout:5000},()=>{s.write(data,err=>{if(err)return done(err);s.end()})});s.on('close',hadError=>{if(!hadError)done()});s.on('timeout',()=>s.destroy(new Error('timeout')));s.on('error',done)})}

async function handler(req,res){try{
  if(req.method==='OPTIONS'){res.writeHead(204,cors());return res.end()}
  if(req.url==='/health'&&req.method==='GET'){if(!authorized(req))return json(res,401,{error:'unauthorized'});return json(res,200,{ok:true,service:'SimplePOS Print Bridge',version:VERSION,https:!!(TLS_CERT&&TLS_KEY),time:new Date().toISOString()})}
  if(req.method==='POST'&&req.url==='/print'){
    if(!authorized(req))return json(res,401,{error:'unauthorized'});
    const b=await readBody(req);const ip=String(b.ip||'');const port=Number(b.port||9100);
    if(!net.isIP(ip)||!isPrivateIp(ip))return json(res,400,{error:'adresse imprimante locale invalide'});
    if(!Number.isInteger(port)||port<1||port>65535)return json(res,400,{error:'port invalide'});
    if(!b.text)return json(res,400,{error:'text requis'});
    await tcpPrint(ip,port,escpos(String(b.text),b.cut!==false));
    return json(res,200,{ok:true,ip,port});
  }
  let u=(req.url||'/').split('?')[0];if(u==='/')u='/index.html';
  const f=path.resolve(__dirname,'.'+u);if(!f.startsWith(__dirname+path.sep)||!fs.existsSync(f)||fs.statSync(f).isDirectory()){res.writeHead(404);return res.end('Not found')}
  res.writeHead(200,{'content-type':mime[path.extname(f)]||'application/octet-stream'});fs.createReadStream(f).pipe(res)
}catch(e){json(res,500,{error:e.message})}}

const useTls=TLS_CERT&&TLS_KEY;
const server=useTls?https.createServer({cert:fs.readFileSync(TLS_CERT),key:fs.readFileSync(TLS_KEY)},handler):http.createServer(handler);
server.listen(PORT,'0.0.0.0',()=>console.log(`SimplePOS bridge: ${useTls?'https':'http'}://0.0.0.0:${PORT}`));
