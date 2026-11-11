import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

try {
  const env = await readFile(new URL('./.env', import.meta.url), 'utf8');
  for (const line of env.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
} catch {}

const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const API_KEY = process.env.GEMINI_API_KEY || '';
const PUBLIC_DIR = resolve(process.cwd(), 'public');
const MAX_BODY = 12 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES = 4;
const SYSTEM = `You are NEXORA, a capable personal AI assistant. Be intelligent, thoughtful, accurate, and naturally conversational. Answer in the same language as the user's latest message, especially German or English. Reason carefully before answering, but do not reveal hidden chain-of-thought; provide concise explanations and useful conclusions. For images, describe what is visible and answer the user's question without guessing uncertain details. When web search is enabled, research the question using the provided Google Search tool, prioritize reliable and current sources, distinguish facts from uncertainty, and cite sources in the response when useful. Never claim to have searched the web unless the search tool was used. Never claim to perform actions you cannot perform. Your name is NEXORA.`;
const MIME = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.json':'application/json; charset=utf-8', '.svg':'image/svg+xml', '.webmanifest':'application/manifest+json' };
const buckets = new Map();

function headers(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob:; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
}
function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store' });
  res.end(JSON.stringify(payload));
}
async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > MAX_BODY) throw Object.assign(new Error('Die Anfrage ist zu groß (maximal 12 MB).'), { status:413 });
  }
  try { return JSON.parse(raw || '{}'); }
  catch { throw Object.assign(new Error('Ungültige Anfrage. Bitte versuche es erneut.'), { status:400 }); }
}
function rateLimit(req) {
  const ip = req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b || now - b.started > 60_000) { b = { started:now, count:0 }; buckets.set(ip,b); }
  return ++b.count <= 20;
}
function cleanImages(images) {
  if (images == null) return [];
  if (!Array.isArray(images) || images.length > MAX_IMAGES) throw Object.assign(new Error(`Bitte höchstens ${MAX_IMAGES} Bilder gleichzeitig senden.`), {status:400});
  return images.map(image => {
    const mimeType = image?.mimeType;
    const data = image?.data;
    if (!['image/jpeg','image/png','image/webp'].includes(mimeType) || typeof data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
      throw Object.assign(new Error('Nicht unterstütztes Bildformat. Erlaubt sind JPG, PNG und WEBP.'), {status:400});
    }
    const bytes = Buffer.byteLength(data, 'base64');
    if (!bytes || bytes > MAX_IMAGE_BYTES) throw Object.assign(new Error('Jedes Bild darf maximal 5 MB groß sein.'), {status:413});
    return { inline_data:{ mime_type:mimeType, data } };
  });
}
function extractSources(candidate) {
  const chunks = candidate?.groundingMetadata?.groundingChunks || [];
  const seen = new Set();
  return chunks.map(x => x.web).filter(x => x?.uri && /^https?:\/\//i.test(x.uri)).filter(x => {
    if (seen.has(x.uri)) return false;
    seen.add(x.uri); return true;
  }).slice(0,8).map(x => ({title:x.title || x.uri, url:x.uri}));
}
async function chat(req,res) {
  if (!rateLimit(req)) return json(res,429,{error:'Zu viele Anfragen in kurzer Zeit. Bitte warte eine Minute.'});
  if (!API_KEY || API_KEY.includes('PASTE_YOUR')) return json(res,503,{error:'Die Gemini-Verbindung ist noch nicht eingerichtet. Hinterlege GEMINI_API_KEY in den Server-Umgebungsvariablen.'});
  const data = await readJson(req);
  if (!Array.isArray(data.messages) || !data.messages.length) return json(res,400,{error:'Bitte schreibe zuerst eine Nachricht oder füge ein Bild hinzu.'});
  if (data.messages.length > 40) return json(res,400,{error:'Der Chat ist zu lang. Bitte starte einen neuen Chat.'});
  const images = cleanImages(data.images);
  const messages = [];
  for (let i=0;i<data.messages.length;i++) {
    const item=data.messages[i];
    if (!item || !['user','assistant'].includes(item.role) || typeof item.content!=='string') continue;
    const content=item.content.trim();
    if (content.length>12000) return json(res,413,{error:'Eine Nachricht ist zu lang (maximal 12.000 Zeichen).'});
    const role=item.role==='assistant'?'model':'user';
    const parts=[];
    if (content) parts.push({text:content});
    if (i===data.messages.length-1 && role==='user') parts.push(...images);
    if (!parts.length) continue;
    if (messages.length && messages[messages.length-1].role===role) messages[messages.length-1].parts.push(...parts);
    else messages.push({role,parts});
  }
  if (!messages.length || messages[messages.length-1].role!=='user') return json(res,400,{error:'Die letzte Nachricht muss von dir stammen.'});
  const useSearch = data.search === true;
  const payload = {
    systemInstruction:{parts:[{text:SYSTEM}]},
    contents:messages,
    generationConfig:{temperature:0.65,maxOutputTokens:4096}
  };
  if (useSearch) payload.tools=[{google_search:{}}];
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),55000);
  try {
    const response=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`,{
      method:'POST',signal:controller.signal,
      headers:{'Content-Type':'application/json','x-goog-api-key':API_KEY},
      body:JSON.stringify(payload)
    });
    const result=await response.json().catch(()=>({}));
    if (!response.ok) {
      let detail=result?.error?.message || `Gemini API Fehler (${response.status}).`;
      if (response.status===429) detail='Das kostenlose Gemini-Kontingent ist gerade ausgeschöpft. Bitte später erneut versuchen.';
      else if (response.status===401 || response.status===403) detail='Google hat den API-Schlüssel abgelehnt. Prüfe GEMINI_API_KEY und den API-Zugriff in Google AI Studio.';
      else if (response.status===400 && /model/i.test(detail)) detail+=` Prüfe GEMINI_MODEL (aktuell: ${MODEL}).`;
      return json(res,response.status===429?429:response.status===400?400:502,{error:detail});
    }
    const candidate=result?.candidates?.[0];
    const answer=candidate?.content?.parts?.map(p=>p.text||'').join('').trim();
    if (!answer) {
      const reason=result?.promptFeedback?.blockReason;
      return json(res,502,{error:reason?'Diese Anfrage konnte aus Sicherheitsgründen nicht beantwortet werden.':'Gemini hat keine Textantwort zurückgegeben. Bitte versuche es erneut.'});
    }
    return json(res,200,{answer,model:MODEL,sources:extractSources(candidate),searched:useSearch});
  } catch(error) {
    if(error.name==='AbortError') return json(res,504,{error:'Die Antwort hat zu lange gedauert. Bitte versuche es erneut.'});
    throw error;
  } finally { clearTimeout(timeout); }
}

const server=http.createServer(async(req,res)=>{
  headers(res);
  let pathname;
  try { pathname=new URL(req.url,'http://localhost').pathname; } catch { return json(res,400,{error:'Ungültige URL.'}); }
  if(req.method==='GET' && pathname==='/api/health') return json(res,200,{ok:true,app:'NEXORA AI',model:MODEL,configured:Boolean(API_KEY&&!API_KEY.includes('PASTE_YOUR')),features:{images:true,webSearch:true,voice:true}});
  if(req.method==='POST' && pathname==='/api/chat') { try{return await chat(req,res);}catch(e){return json(res,e.status||500,{error:e.status?e.message:'Ein Serverfehler ist aufgetreten. Bitte versuche es später erneut.'});} }
  if(pathname.startsWith('/api/')) return json(res,404,{error:'API-Endpunkt nicht gefunden.'});
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405,{'Allow':'GET, HEAD'});return res.end('Method not allowed');}
  let decoded; try{decoded=decodeURIComponent(pathname);}catch{res.writeHead(400);return res.end('Bad request');}
  const relative=decoded==='/'?'index.html':decoded.replace(/^\/+/,'');
  const filePath=resolve(PUBLIC_DIR,relative);
  if(filePath!==PUBLIC_DIR&&!filePath.startsWith(PUBLIC_DIR+sep)){res.writeHead(403);return res.end('Forbidden');}
  try{const file=await readFile(filePath);res.writeHead(200,{'Content-Type':MIME[extname(filePath)]||'application/octet-stream','Cache-Control':relative==='index.html'?'no-cache':'public, max-age=3600'});return res.end(req.method==='HEAD'?undefined:file);}
  catch{res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'});return res.end('Not found');}
});
server.listen(PORT,'0.0.0.0',()=>console.log(`NEXORA AI läuft auf Port ${PORT} · Modell: ${MODEL}`));
