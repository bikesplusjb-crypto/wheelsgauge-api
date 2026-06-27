/* ===============================
   HOTWHEELSGAUGE
   EBAY DIECAST MARKET BACKEND
   server.js — v1 (search lookup + hot board, NO scanner)
   Same compliant pattern as CardGauge/ComicGauge:
   eBay Browse API (active listings) + EPN affiliate sold-comps deep links.
================================ */

const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

/* ── CONFIG (set in Render dashboard, not GitHub) ──
   EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, REFRESH_SECRET
   No vision/OpenAI key needed — there is no scanner.
*/
const EPN_CAMPAIGN_ID = "5339149252";
const EPN_MKRID       = "711-53200-19255-0";
const EBAY_CLIENT_ID     = process.env.EBAY_CLIENT_ID || "";
const EBAY_CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET || "";
const REFRESH_SECRET     = process.env.REFRESH_SECRET || "";

// eBay Diecast & Toy Vehicles > Cars/Trucks/Vans category. 222 = Diecast-Toy Vehicles root.
const EBAY_DIECAST_CATEGORY = "222";

/* ── AFFILIATE URL BUILDERS ── */
function ebaySearchUrl(query, sold) {
  const base = "https://www.ebay.com/sch/i.html";
  const q = encodeURIComponent(query);
  const soldParams = sold ? "&LH_Sold=1&LH_Complete=1" : "";
  return `${base}?_nkw=${q}${soldParams}&_sacat=${EBAY_DIECAST_CATEGORY}` +
    `&mkcid=1&mkrid=${EPN_MKRID}&siteid=0&campid=${EPN_CAMPAIGN_ID}&toolid=10001&mkevt=1`;
}
function addAffiliate(url) {
  if (!url) return "";
  try {
    const u = new URL(url);
    u.searchParams.set("mkcid", "1");
    u.searchParams.set("mkrid", EPN_MKRID);
    u.searchParams.set("siteid", "0");
    u.searchParams.set("campid", EPN_CAMPAIGN_ID);
    u.searchParams.set("toolid", "10001");
    u.searchParams.set("mkevt", "1");
    return u.toString();
  } catch (e) {
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}campid=${EPN_CAMPAIGN_ID}&mkevt=1`;
  }
}

/* ── HOT WHEELS QUERY NORMALIZER ──
   Casting + year + variant. Always scope to "Hot Wheels" so we don't
   pull generic diecast. Preserve Redline / Treasure Hunt / STH signals.
*/
function normalizeHWQuery(raw) {
  if (!raw) return "Hot Wheels";
  let q = String(raw).trim().replace(/\s+/g, " ");

  // Normalize the key collector terms.
  q = q
    .replace(/\bsuper\s*t\.?h\.?\b/gi, "Super Treasure Hunt")
    .replace(/\bsth\b/gi, "Super Treasure Hunt")
    .replace(/\bt\.?h\.?\b/gi, "Treasure Hunt")
    .replace(/\bred\s*lines?\b/gi, "Redline");

  // Ensure brand scope.
  if (!/hot\s*wheels/i.test(q)) q = "Hot Wheels " + q;

  return q.replace(/\s+/g, " ").trim();
}

/* ── EBAY BROWSE (active listings only) ── */
let cachedToken = null, tokenExpiry = 0;
async function getEbayToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET) throw new Error("Missing eBay credentials");
  const creds = Buffer.from(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`).toString("base64");
  const resp = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${creds}` },
    body: "grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope",
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error("eBay token request failed");
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

async function fetchActiveMarket(query) {
  const cleanQuery = normalizeHWQuery(query);
  const token = await getEbayToken();
  const url =
    "https://api.ebay.com/buy/browse/v1/item_summary/search" +
    `?q=${encodeURIComponent(cleanQuery)}` +
    `&category_ids=${EBAY_DIECAST_CATEGORY}` +
    "&filter=buyingOptions:{FIXED_PRICE}" +
    "&limit=20";
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" },
  });
  const data = await resp.json();
  const items = (data.itemSummaries || []).map((it) => ({
    title: it.title,
    price: it.price ? Number(it.price.value) : null,
    currency: it.price ? it.price.currency : "USD",
    condition: it.condition || "",
    image: it.image ? it.image.imageUrl : "",
    url: addAffiliate(it.itemWebUrl),
  })).filter((it) => it.price != null);
  const prices = items.map((i) => i.price).sort((a, b) => a - b);
  const avg = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null;
  return {
    cleanQuery,
    avgPrice: avg ? Math.round(avg * 100) / 100 : null,
    lowPrice: prices.length ? prices[0] : null,
    highPrice: prices.length ? prices[prices.length - 1] : null,
    listingCount: items.length,
    image: items[0] ? items[0].image : "",
    listings: items.slice(0, 8),
    priceSource: "ebay_active",
  };
}

/* ── HOT BOARD watchlist: vintage Redlines + key TH/STH ── */
const HOT_HW_SEED = [
  "Hot Wheels Redline Custom Camaro 1968",
  "Hot Wheels Redline Beatnik Bandit 1968",
  "Hot Wheels Redline Python 1968",
  "Hot Wheels Redline Splittin Image 1969",
  "Hot Wheels Redline Twin Mill 1969",
  "Hot Wheels Redline Olds 442 1971",
  "Hot Wheels Treasure Hunt 1995 Olds 442",
  "Hot Wheels Treasure Hunt VW Bug",
  "Hot Wheels Super Treasure Hunt Datsun 240Z",
  "Hot Wheels Super Treasure Hunt Porsche",
  "Hot Wheels Redline Pink Beatnik Bandit",
  "Hot Wheels Redline Boss Hoss 1971",
];
let hotBoardCache = { ts: 0, items: [] };
const HOT_CACHE_MS = 15 * 60 * 1000;
async function buildHotBoard() {
  const results = [];
  for (const title of HOT_HW_SEED) {
    try {
      const m = await fetchActiveMarket(title);
      results.push({
        title: title.replace(/^Hot Wheels /, ""),
        fullQuery: title,
        avgPrice: m.avgPrice, lowPrice: m.lowPrice, highPrice: m.highPrice,
        listingCount: m.listingCount, image: m.image,
        soldCompsUrl: ebaySearchUrl(title, true),
        listingsUrl: ebaySearchUrl(title, false),
      });
    } catch (e) {}
  }
  results.sort((a, b) => (b.listingCount || 0) - (a.listingCount || 0));
  return results;
}

/* ── ROUTES ── */
app.get("/api/market", async (req, res) => {
  try {
    const query = req.query.q;
    if (!query) return res.status(400).json({ success: false, error: "Missing q param" });
    const m = await fetchActiveMarket(query);
    return res.json({
      success: true,
      query: m.cleanQuery,
      note: "Active eBay listings shown. Tap Sold Comps for completed-sale prices on eBay.",
      avgPrice: m.avgPrice, lowPrice: m.lowPrice, highPrice: m.highPrice,
      listingCount: m.listingCount, image: m.image, priceSource: m.priceSource,
      listings: m.listings,
      soldCompsUrl: ebaySearchUrl(m.cleanQuery, true),
      activeListingsUrl: ebaySearchUrl(m.cleanQuery, false),
      affiliate: { campid: EPN_CAMPAIGN_ID, active: true },
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error("Market error:", error);
    return res.status(500).json({ success: false, error: "Market lookup failed", details: error.message });
  }
});

app.get("/api/hot", async (req, res) => {
  try {
    if (Date.now() - hotBoardCache.ts < HOT_CACHE_MS && hotBoardCache.items.length) {
      return res.json({ success: true, cached: true, items: hotBoardCache.items, timestamp: hotBoardCache.ts });
    }
    const items = await buildHotBoard();
    hotBoardCache = { ts: Date.now(), items };
    return res.json({ success: true, cached: false, items, timestamp: hotBoardCache.ts });
  } catch (error) {
    return res.status(500).json({ success: false, error: "Hot board failed", details: error.message });
  }
});

app.post("/api/hot/refresh", async (req, res) => {
  if (!REFRESH_SECRET || req.headers["x-refresh-secret"] !== REFRESH_SECRET) {
    return res.status(403).json({ success: false, error: "Forbidden" });
  }
  try {
    const items = await buildHotBoard();
    hotBoardCache = { ts: Date.now(), items };
    return res.json({ success: true, refreshed: true, count: items.length });
  } catch (error) {
    return res.status(500).json({ success: false, error: "Refresh failed", details: error.message });
  }
});

app.get("/api/affiliate-test", (req, res) => {
  const t = "Hot Wheels Redline Custom Camaro 1968";
  res.json({ success: true, message: "HotWheelsGauge eBay affiliate tracking is active",
    campid: EPN_CAMPAIGN_ID, sampleActiveUrl: ebaySearchUrl(t, false), sampleSoldUrl: ebaySearchUrl(t, true) });
});
app.get("/api/health", (req, res) => res.json({ ok: true, service: "hotwheelsgauge-api" }));

app.use(express.static("public"));
app.use((req, res) => res.status(404).json({ success: false, error: "Endpoint not found" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HotWheelsGauge backend on port ${PORT} | EPN ${EPN_CAMPAIGN_ID}`));
