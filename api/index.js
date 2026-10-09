const { addonBuilder } = require("stremio-addon-sdk");
const axios = require("axios");
const cheerio = require("cheerio");

const manifest = require("../manifest.json");
const builder = new addonBuilder(manifest);

builder.defineSubtitlesHandler(async ({id}) => {
    const imdbId = id.split(":")[0];
    try {
        const res = await axios.get(`https://yifysubtitles.ch/movie-imdb/${imdbId}`, {
            headers: {"User-Agent": "Mozilla/5.0"},
            timeout: 7000
        });
        const $ = cheerio.load(res.data);
        let subs = [];
        $("tbody tr").each((_,el)=>{
            const lang = $(el).find(".flag-cell").text().toLowerCase();
            const href = $(el).find("a").attr("href");
            if(!href) return;
            const url = "https://yifysubtitles.ch" + href;
            if(lang.includes("arabic")) subs.push({lang:"ar", url, id:"ar", label:"Arabic ✅"});
        });
        if(subs.length) return {subtitles: subs.map(s=>({url:s.url, lang:"ar", id:s.id, label:s.label}))};
    } catch(e){}
    return {subtitles: []};
});

const addonInterface = builder.getInterface();
const { getRouter } = require("stremio-addon-sdk/src/getRouter");
const router = getRouter(addonInterface);

module.exports = (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    if(req.url.includes("favicon")) { res.statusCode=204; return res.end(); }
    return router(req, res, () => { res.statusCode=404; res.end(); });
};
