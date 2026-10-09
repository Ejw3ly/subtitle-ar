const { addonBuilder } = require("stremio-addon-sdk");
const axios = require("axios");
const cheerio = require("cheerio");
const NodeCache = require("node-cache");
const AdmZip = require("adm-zip");
const manifest = require("./manifest.json");

const builder = new addonBuilder(manifest);
const cache = new NodeCache({ stdTTL: 86400 });
const TIMEOUT = 7000;
const headers = { "User-Agent": "Mozilla/5.0" };

async function fetchSafe(url, opts={}) {
  try { const r = await axios.get(url, { headers, timeout: TIMEOUT, ...opts }); return r.data; } catch { return null; }
}
async function translateGoogle(text){
  try{
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ar&dt=t&q=${encodeURIComponent(text)}`;
    const r = await axios.get(url, {timeout:5000});
    return r.data[0].map(x=>x[0]).join(\'\');
  }catch{ return null; }
}
async function translateSRT(srtText){
  const SrtParser2 = require(\'srt-parser-2\').default;
  const parser = new SrtParser2();
  const subs = parser.fromSrt(srtText);
  let out = [];
  for(let i=0; i<subs.length; i+=15){
    let chunk = subs.slice(i, i+15);
    let joint = chunk.map(c=>c.text).join(\'\n---\n\');
    let trans = await translateGoogle(joint);
    if(!trans) trans = joint;
    let lines = trans.split(\'\n---\n\');
    chunk.forEach((c,idx)=>{ c.text = lines[idx] || c.text; out.push(c); });
    await new Promise(r=>setTimeout(r,300));
  }
  return parser.toSrt(out);
}
async function getYify(imdbId){
  const html = await fetchSafe(`https://yifysubtitles.ch/movie-imdb/${imdbId}`);
  if(!html) return [];
  const $ = cheerio.load(html);
  let subs=[];
  $("tbody tr").each((_,el)=>{
    const lang = $(el).find(".flag-cell").text().toLowerCase();
    const href = $(el).find("a").attr("href");
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
  const $ = cheerio.load(html);
  const dl = $(".btn-download").attr("href");
  if(!dl) return null;
  return "https://yifysubtitles.ch"+dl;
}

builder.defineSubtitlesHandler(async ({id})=>{
  const imdbId = id.split(":")[0];
  if(cache.has(imdbId)) return {subtitles: cache.get(imdbId)};
  const subs = await getYify(imdbId);
  for(let s of subs.filter(x=>x.lang==="ar")){
    const zipUrl = await getZipUrl(s.pageUrl);
    if(zipUrl){ const result=[{id:"ar-yify", url: zipUrl, lang:"ar", label:"Arabic - YIFY ✅"}]; cache.set(imdbId, result); return {subtitles: result}; }
  }
  const eng = subs.find(x=>x.isEnglish);
  if(eng){
    const zipUrl = await getZipUrl(eng.pageUrl);
    if(zipUrl){
      const host = `https://${process.env.VERCEL_URL || "subtitle-ar-79xn.vercel.app"}`;
      const aiUrl = `${host}/translate?url=${encodeURIComponent(zipUrl)}`;
      const result=[{id:"ai-ar", url: aiUrl, lang:"ar", label:"Arabic [AI Translated] ✨"}];
      cache.set(imdbId, result); return {subtitles: result};
    }
  }
  return {subtitles:[]};
});

const addonInterface = builder.getInterface();

// هذا هو الإصلاح لخطأ 500 - لا نستدعي getRouter في المستوى الأعلى
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Headers","*");

  // مهم للهاتف: تجاهل favicon
  if(req.url.includes("favicon")){ res.statusCode = 204; return res.end(); }

  if(req.url && req.url.startsWith("/translate")){
    try{
      const url = new URL(req.url, `https://${req.headers.host}`);
      const zipUrl = url.searchParams.get("url");
      if(!zipUrl) return res.status(400).end("missing url");
      const resp = await axios.get(zipUrl, {responseType:"arraybuffer", headers, timeout:8000});
      const zip = new AdmZip(Buffer.from(resp.data));
      const entry = zip.getEntries().find(e=>e.entryName.endsWith(".srt"));
      if(!entry) return res.status(404).end("no srt");
      const srtText = entry.getData().toString("utf8");
      const translated = await translateSRT(srtText);
      res.setHeader("Content-Type","text/plain; charset=utf-8");
      return res.end(translated);
    }catch(e){ return res.status(500).end("translate error: "+e.message); }
  }

  // باقي الطلبات لـ Stremio
  const { getRouter } = require("stremio-addon-sdk/src/getRouter");
  const router = getRouter(addonInterface);
  return router(req, res, ()=>{ res.statusCode=404; res.end("not found"); });
};
