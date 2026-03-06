"use strict";

const WORLDMONITOR_NATIVE_SEVERITY_DIRECT_TAGS = [
  "severity",
  "alert_level",
  "alertlevel",
  "threat_level",
  "threatlevel",
  "priority",
  "urgency",
];

const WORLDMONITOR_NATIVE_SEVERITY_CATEGORY_TAGS = ["category", "subject", "label", "tag"];
const WORLDMONITOR_NATIVE_SEVERITY_CATEGORY_ATTRS = ["term", "label", "name", "value", "severity", "priority"];

const WORLDMONITOR_TAIWAN_KEYWORDS = [
  "taiwan", "taipei", "taiwan strait", "strait", "pla", "prc", "beijing", "china",
  "kinmen", "matsu", "penghu", "south china sea", "east china sea",
];

const WORLDMONITOR_COUNTRY_PATTERNS = Object.freeze([
  { code: "TW", patterns: ["taiwan", "taipei", "kinmen", "matsu", "penghu"] },
  { code: "CN", patterns: ["china", "beijing", "pla", "prc"] },
  { code: "US", patterns: ["united states", "u.s.", "washington", "pentagon", "white house", "american"] },
  { code: "RU", patterns: ["russia", "moscow", "kremlin"] },
  { code: "UA", patterns: ["ukraine", "kyiv", "kiev"] },
  { code: "IL", patterns: ["israel", "israeli", "tel aviv"] },
  { code: "IR", patterns: ["iran", "tehran"] },
  { code: "SY", patterns: ["syria", "damascus"] },
  { code: "YE", patterns: ["yemen", "houthi"] },
  { code: "KP", patterns: ["north korea", "pyongyang"] },
  { code: "KR", patterns: ["south korea", "seoul"] },
  { code: "JP", patterns: ["japan", "tokyo"] },
  { code: "PH", patterns: ["philippines", "manila"] },
  { code: "VN", patterns: ["vietnam", "hanoi"] },
  { code: "IN", patterns: ["india", "new delhi"] },
  { code: "PK", patterns: ["pakistan", "islamabad"] },
  { code: "SA", patterns: ["saudi arabia", "riyadh"] },
  { code: "AE", patterns: ["united arab emirates", "uae", "abu dhabi", "dubai"] },
  { code: "TR", patterns: ["turkey", "ankara"] },
  { code: "DE", patterns: ["germany", "berlin"] },
  { code: "FR", patterns: ["france", "paris"] },
  { code: "GB", patterns: ["united kingdom", "uk", "britain", "london"] },
  { code: "PL", patterns: ["poland", "warsaw"] },
  { code: "VE", patterns: ["venezuela", "caracas"] },
  { code: "MM", patterns: ["myanmar", "burma"] },
]);

const WORLDMONITOR_MARKET_SYMBOLS = Object.freeze({
  "^GSPC": "SP500",
  "^IXIC": "NASDAQ",
  "^DJI": "DOW",
  "^TWII": "TWSE",
  "^HSI": "HANG_SENG",
  "000001.SS": "SSE_COMPOSITE",
  "^N225": "NIKKEI225",
  "CL=F": "WTI_OIL",
  "GC=F": "GOLD",
  "DX-Y.NYB": "DOLLAR_INDEX",
  "TWD=X": "USD_TWD",
  "CNY=X": "USD_CNY",
  "JPY=X": "USD_JPY",
});

const WORLDMONITOR_NATIVE_ADSB_REGION = Object.freeze({
  lamin: 4,
  lamax: 44,
  lomin: 104,
  lomax: 133,
});

const WORLDMONITOR_NATIVE_ADSB_THEATERS = Object.freeze([
  {
    id: "taiwan_strait",
    name: "Taiwan Strait",
    bounds: { north: 30, south: 18, east: 130, west: 115 },
  },
  {
    id: "south_china_sea",
    name: "South China Sea",
    bounds: { north: 25, south: 5, east: 121, west: 105 },
  },
  {
    id: "east_china_sea",
    name: "East China Sea",
    bounds: { north: 33, south: 24, east: 132, west: 122 },
  },
  {
    id: "korean_peninsula",
    name: "Korean Peninsula",
    bounds: { north: 43, south: 33, east: 132, west: 124 },
  },
]);

const WORLDMONITOR_MILITARY_CALLSIGN_PREFIXES = Object.freeze([
  "RCH", "REACH", "MOOSE", "EVAC", "DUSTOFF", "PEDRO",
  "DUKE", "HAVOC", "KNIFE", "WARHAWK", "VIPER", "RAGE", "FURY",
  "SHELL", "TEXACO", "ARCO", "ESSO", "PETRO",
  "SENTRY", "AWACS", "MAGIC", "DISCO", "DARKSTAR",
  "COBRA", "PYTHON", "RAPTOR", "EAGLE", "HAWK", "TALON",
  "NATO", "RAF", "USAF", "USMC", "USCG",
  "RSAF", "UAEAF", "QAF", "KAF", "IRIAF", "IRGC", "TAF",
  "VKS", "RUSAF", "PLAAF", "PLA", "CNV",
]);

const WORLDMONITOR_COMMERCIAL_CALLSIGN_PREFIXES = new Set([
  "AAL", "DAL", "UAL", "SWA", "JBU", "FFT", "ACA", "WJA",
  "BAW", "AFR", "DLH", "KLM", "AUA", "SAS", "FIN", "LOT",
  "CPA", "SIA", "JAL", "ANA", "KAL", "EVA", "CAL", "CCA",
]);

const WORLDMONITOR_NATIVE_SERVICE_SOURCES = Object.freeze([
  { id: "openai", name: "OpenAI", url: "https://status.openai.com/api/v2/status.json" },
  { id: "cloudflare", name: "Cloudflare", url: "https://www.cloudflarestatus.com/api/v2/status.json" },
  { id: "github", name: "GitHub", url: "https://www.githubstatus.com/api/v2/status.json" },
  { id: "discord", name: "Discord", url: "https://discordstatus.com/api/v2/status.json" },
  { id: "zoom", name: "Zoom", url: "https://www.zoomstatus.com/api/v2/status.json" },
  { id: "twilio", name: "Twilio", url: "https://status.twilio.com/api/v2/status.json" },
]);

const WORLDMONITOR_NATIVE_MACRO_SYMBOLS = Object.freeze({
  "BTC-USD": "BTC",
  "QQQ": "QQQ",
  "XLP": "XLP",
  "JPY=X": "USD_JPY",
});

const WORLDMONITOR_NATIVE_PREDICTION_TAIWAN_PATTERN = /(taiwan|taipei|taiwan strait|formosa|china[-\s]?taiwan|south china sea|east china sea)/i;

const WORLDMONITOR_NATIVE_MARITIME_REGION_PATTERNS = Object.freeze([
  { id: "taiwan_strait", name: "Taiwan Strait", regex: /(taiwan strait|formosa strait)/i },
  { id: "south_china_sea", name: "South China Sea", regex: /(south china sea|spratly|paracel)/i },
  { id: "east_china_sea", name: "East China Sea", regex: /(east china sea|senkaku|diaoyu)/i },
  { id: "red_sea", name: "Red Sea", regex: /(red sea|bab el[-\s]?mandeb|gulf of aden)/i },
  { id: "persian_gulf", name: "Persian Gulf", regex: /(persian gulf|strait of hormuz|gulf of oman)/i },
  { id: "suez", name: "Suez", regex: /(suez canal)/i },
  { id: "panama", name: "Panama Canal", regex: /(panama canal)/i },
]);

module.exports = {
  WORLDMONITOR_NATIVE_SEVERITY_DIRECT_TAGS,
  WORLDMONITOR_NATIVE_SEVERITY_CATEGORY_TAGS,
  WORLDMONITOR_NATIVE_SEVERITY_CATEGORY_ATTRS,
  WORLDMONITOR_TAIWAN_KEYWORDS,
  WORLDMONITOR_COUNTRY_PATTERNS,
  WORLDMONITOR_MARKET_SYMBOLS,
  WORLDMONITOR_NATIVE_ADSB_REGION,
  WORLDMONITOR_NATIVE_ADSB_THEATERS,
  WORLDMONITOR_MILITARY_CALLSIGN_PREFIXES,
  WORLDMONITOR_COMMERCIAL_CALLSIGN_PREFIXES,
  WORLDMONITOR_NATIVE_SERVICE_SOURCES,
  WORLDMONITOR_NATIVE_MACRO_SYMBOLS,
  WORLDMONITOR_NATIVE_PREDICTION_TAIWAN_PATTERN,
  WORLDMONITOR_NATIVE_MARITIME_REGION_PATTERNS,
};
