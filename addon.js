const { addonBuilder } = require("stremio-addon-sdk");
const axios = require("axios");
const cheerio = require("cheerio");
const NodeCache = require("node-cache");
const AdmZip = require("adm-zip");
const manifest = require("./manifest.json");

const builder = new addonBuilder(manifest);
const cache = new NodeCache({ stdTTL: 86400 });
const TIMEOUT = 7000;
const headers = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" };

// --- دوال مساعدة ---
async function fetchSafe(url, opts={}) {
  try {
    const r = await axios.get(url, { headers, timeout: TIMEOUT, ...opts });
    return r.data;
  } catch(e){ return null; }
}

async function translateGoogle(text){
  try{
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ar&dt=t&q=$`{encodeURIComponent(text)}`;
    const r = await axios.get(url, {timeout:5000});
    return r.data[0].map(x=>x[0]).join('');
  }catch{ return null; }
}

async function translateSRT(srtText){
  const SrtParser2 = require('srt-parser-2').default;
  const parser = new SrtParser2();
  const subs = parser.fromSrt(srtText);
  let out = [];
  for(let i=0; i<subs.length; i+=15){
    let chunk = subs.slice(i, i+15);
    let joint = chunk.map(c=>c.text).join('\n---\n');
    let trans = await translateGoogle(joint);
    if(!trans) trans = joint;
    let lines = trans.split('\n---\n');
    chunk.forEach((c,idx)=>{ c.text = lines[idx] || c.text; out.push(c); });
    await new Promise(r=>setTimeout(r,300));
  }
  return parser.toSrt(out);
}

async function getYify(imdbId){
  const html = await fetchSafe(`https://yifysubtitles.ch/movie-imdb/`${imdbId}`);
  if(!html) return [];
  const $` = cheerio.load(html);
  let subs=[];
  `$("tbody tr").each((_,el)=>{
    const lang = $`(el).find(".flag-cell").text().toLowerCase();
    const href = `$(el).find("a").attr("href");
    if(!href) return;
    const pageUrl = "https://yifysubtitles.ch"+href;
    if(lang.includes("arabic")) subs.push({lang:"ar", pageUrl});
    if(lang.includes("english")) subs.push({lang:"en", pageUrl, isEnglish:true});
  });
  return subs;
}

async function getZipUrl(pageUrl){
  const html = await fetchSafe(pageUrl);
  if(!html) return null;
  const $` = cheerio.load(html);
  const dl = `$(".btn-download").attr("href");
  if(!dl) return null;
  return "https://yifysubtitles.ch"+dl;
}

// --- معالج الترجمات ---
builder.defineSubtitlesHandler(async ({id})=>{
  const imdbId = id.split(":")[0];
  const cacheKey = imdbId;
  if(cache.has(cacheKey)) return {subtitles: cache.get(cacheKey)};

  const subs = await getYify(imdbId);
  // 1. حاول جلب العربي الجاهز
  for(let s of subs.filter(x=>x.lang==="ar")){
    const zipUrl = await getZipUrl(s.pageUrl);
    if(zipUrl){
      const result=[{id:"ar-yify", url: zipUrl, lang:"ar", label:"Arabic - YIFY ✅"}];
      cache.set(cacheKey, result);
      return {subtitles: result};
    }
  }
  // 2. اذا لم يوجد عربي -> ترجمة AI
  const eng = subs.find(x=>x.isEnglish);
  if(eng){
    const zipUrl = await getZipUrl(eng.pageUrl);
    if(zipUrl){
      const host = process.env.VERCEL_URL ? `https://$`{process.env.VERCEL_URL}` : `https://`${process.env.VERCEL_PROJECT_PRODUCTION_URL || 'localhost:7000'}`;
      // رابط الترجمة الخاص بنا
      const aiUrl = `$`{host}/translate?url=`${encodeURIComponent(zipUrl)}`;
      const result=[{id:"ai-ar", url: aiUrl, lang:"ar", label:"Arabic [AI Translated] ✨"}];
      cache.set(cacheKey, result);
      return {subtitles: result};
    }
  }
  return {subtitles:[]};
});

const addonInterface = builder.getInterface();

// --- معالج Vercel مع دعم /translate ---
module.exports = async (req, res)=>{
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Headers","*");

  if(req.url && req.url.startsWith("/translate")){
    try{
      const url = new URL(req.url, `https://${req.headers.host}`);
      const zipUrl = url.searchParams.get("url");
      if(!zipUrl){ res.statusCode=400; return res.end("missing url");}
      
      const resp = await axios.get(zipUrl, {responseType:"arraybuffer", headers, timeout:8000});
      const zip = new AdmZip(Buffer.from(resp.data));
      const entry = zip.getEntries().find(e=>e.entryName.endsWith(".srt"));
      if(!entry){ res.statusCode=404; return res.end("no srt in zip");}
      const srtText = entry.getData().toString("utf8");
      const translated = await translateSRT(srtText);
      
      res.setHeader("Content-Type","text/plain; charset=utf-8");
      return res.end(translated);
    }catch(e){
      res.statusCode=500; return res.end("translate error: "+e.message);
    }
  }

  // باقي الطلبات لـ Stremio
  const { getRouter } = require("stremio-addon-sdk/src/getRouter");
  const router = getRouter(addonInterface);
  router(req, res, ()=>{res.statusCode=404; res.end("not found");});
};

// للتشغيل المحلي فقط
if(require.main===module){
  const { serveHTTP } = require("stremio-addon-sdk");
  serveHTTP(addonInterface, {port: process.env
