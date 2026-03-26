import express from "express";
import { createServer as createViteServer } from "vite";
import { initializeApp } from "firebase/app";
import { getFirestore, collection, doc, setDoc, getDoc, query, where, orderBy, limit, getDocs, count, writeBatch, getCountFromServer } from "firebase/firestore";
import Parser from "rss-parser";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { createServer } from "http";
import { Server } from "socket.io";
import Database from "better-sqlite3";

// Initialize SQLite for local caching
const sqlite = new Database("news_cache.db");
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS news (
    id TEXT PRIMARY KEY,
    docId TEXT,
    title TEXT,
    link TEXT,
    pubDate TEXT,
    content TEXT,
    source TEXT,
    category TEXT,
    summary TEXT,
    imageUrl TEXT,
    serverKey TEXT
  )
`);

const insertNews = sqlite.prepare(`
  INSERT OR REPLACE INTO news (id, docId, title, link, pubDate, content, source, category, summary, imageUrl, serverKey)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const getCachedNews = sqlite.prepare(`
  SELECT * FROM news 
  WHERE pubDate >= ? 
  ORDER BY pubDate DESC 
  LIMIT ?
`);

const getCachedNewsByCategory = sqlite.prepare(`
  SELECT * FROM news 
  WHERE pubDate >= ? AND category = ?
  ORDER BY pubDate DESC 
  LIMIT ?
`);

const countCachedNews = sqlite.prepare(`SELECT count(*) as count FROM news`);

// Import the Firebase configuration
import firebaseConfig from "./firebase-applet-config.json" assert { type: "json" };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Firebase Client SDK on server
const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp, firebaseConfig.firestoreDatabaseId);

const newsCollection = collection(db, "news");

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = 3000;
const parser = new Parser();
const FEEDS = [
  { name: "TechCrunch AI", url: "https://techcrunch.com/category/artificial-intelligence/feed/" },
  { name: "VentureBeat AI", url: "https://venturebeat.com/category/ai/feed/" },
  { name: "MIT Tech Review", url: "https://www.technologyreview.com/topic/artificial-intelligence/feed/" },
  { name: "arXiv AI", url: "https://arxiv.org/rss/cs.AI" },
  { name: "The Verge AI", url: "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml" },
  { name: "Wired AI", url: "https://www.wired.com/feed/tag/ai/latest/rss" },
  { name: "SCMP Tech (China)", url: "https://www.scmp.com/rss/318208/feed" },
  { name: "Pandaily AI (China)", url: "https://pandaily.com/feed/" },
  { name: "Technode AI (China)", url: "https://technode.com/tag/ai/feed/" }
];

const CATEGORIES = [
  { name: "AI Research", keywords: ["research", "paper", "arxiv", "study", "algorithm", "model", "neural", "deepseek", "qwen", "internlm"] },
  { name: "AI Industry", keywords: ["google", "microsoft", "meta", "openai", "nvidia", "baidu", "alibaba", "tencent", "huawei", "bytedance", "sensetime", "moonshot", "zhipu"] },
  { name: "AI Tools", keywords: ["tool", "app", "software", "release", "launch", "feature", "chatgpt", "claude", "gemini", "ernie", "tongyi", "hunyuan"] },
  { name: "AI Policy", keywords: ["regulation", "law", "policy", "ethics", "government", "eu", "safety", "copyright", "cac", "china"] },
  { name: "AI Startups", keywords: ["startup", "funding", "seed", "series", "venture", "founder", "unicorn", "01.ai", "baichuan"] },
  { name: "AI Hardware", keywords: ["chip", "gpu", "h100", "tpu", "semiconductor", "hardware", "infrastructure", "server", "ascend", "kunlun"] }
];

async function getOgImage(url: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000); // 3s timeout
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    const html = await res.text();
    const match = html.match(/<meta[^>]+property="og:image"[^>]+content="([^">]+)"/i) ||
                  html.match(/<meta[^>]+content="([^">]+)"[^>]+property="og:image"/i);
    return match ? match[1] : null;
  } catch (e) {
    return null;
  }
}

let isQuotaExceeded = false;
let lastQuotaErrorTime = 0;
const QUOTA_RETRY_DELAY = 60 * 60 * 1000; // 1 hour

function handleQuotaError(e: any, context: string) {
  if (e instanceof Error && e.message.includes("Quota exceeded")) {
    isQuotaExceeded = true;
    lastQuotaErrorTime = Date.now();
    console.warn(`[QUOTA] Firestore quota exceeded during ${context}. Falling back to local cache.`);
    return true;
  }
  return false;
}

function shouldTryFirestore() {
  if (isQuotaExceeded && Date.now() - lastQuotaErrorTime < QUOTA_RETRY_DELAY) {
    return false;
  }
  if (isQuotaExceeded) {
    isQuotaExceeded = false; // Reset after delay
  }
  return true;
}

async function testConnection() {
  if (!shouldTryFirestore()) return;
  try {
    await getDoc(doc(db, 'test', 'connection'));
    console.log("Firebase connection successful");
  } catch (error) {
    if (!handleQuotaError(error, "connection test")) {
      console.error("Firebase connection test failed:", error);
    }
  }
}

function classify(title: string, content: string): string {
  const text = (title + " " + content).toLowerCase();
  for (const cat of CATEGORIES) {
    if (cat.keywords.some(kw => text.includes(kw))) {
      return cat.name;
    }
  }
  return "General AI";
}

let lastFetchTime = 0;
const FETCH_INTERVAL = 4 * 60 * 60 * 1000; // 4 hours (increased from 1 to save quota)

async function fetchNews() {
  console.log(`[${new Date().toISOString()}] Fetching news...`);
  lastFetchTime = Date.now();
  const oneMonthAgo = new Date();
  oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);

  // Fetch existing IDs to avoid redundant writes and reads
  let existingIds = new Set<string>();
  if (shouldTryFirestore()) {
    try {
      const q = query(collection(db, "news"), orderBy("pubDate", "desc"), limit(300));
      const snapshot = await getDocs(q);
      existingIds = new Set(snapshot.docs.map(d => d.id));
      console.log(`Found ${existingIds.size} existing items in Firestore to skip.`);
    } catch (e) {
      if (!handleQuotaError(e, "fetching existing IDs")) {
        console.error("Failed to fetch existing IDs:", e);
      }
    }
  } else {
    console.log("[QUOTA] Skipping Firestore ID fetch due to active quota limit.");
  }

  let totalFetched = 0;

  for (const feed of FEEDS) {
    try {
      console.log(`[Fetch] Fetching ${feed.name} from ${feed.url}...`);
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout per feed
      
      try {
        const response = await fetch(feed.url, { signal: controller.signal });
        clearTimeout(timeoutId);
        
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const xml = await response.text();
        const data = await parser.parseString(xml);
        
        console.log(`[Fetch] Received ${data.items?.length || 0} items from ${feed.name}`);
        if (!data.items) continue;
        
        let feedCount = 0;
        for (const item of data.items) {
        try {
          const pubDateStr = item.pubDate || new Date().toISOString();
          const pubDate = new Date(pubDateStr);
          
          // Skip news older than 1 month
          if (pubDate < oneMonthAgo) continue;

          const id = item.guid || item.link || item.title;
          const docId = Buffer.from(id).toString('base64').replace(/\//g, '_').replace(/\+/g, '-');

          // Skip if already in Firestore (if we have the list)
          if (existingIds.has(docId)) continue;

          const title = item.title || "No Title";
          const link = item.link || "";
          const content = item.contentSnippet || item.content || "";
          const source = feed.name;
          const category = classify(title, content);
          const summary = content.substring(0, 200) + "...";
          
          // Extract image URL with better logic
          let imageUrl = "";
          
          // 1. Check media:content
          if (item.mediaContent && Array.isArray(item.mediaContent)) {
            const media = item.mediaContent.find((m: any) => m.$ && m.$.url);
            if (media) imageUrl = media.$.url;
          } else if (item.mediaContent && (item.mediaContent as any).$ && (item.mediaContent as any).$.url) {
            imageUrl = (item.mediaContent as any).$.url;
          }
          
          // 2. Check media:thumbnail
          if (!imageUrl && item.mediaThumbnail && item.mediaThumbnail.$) {
            imageUrl = item.mediaThumbnail.$.url;
          }

          // 3. Check enclosure
          if (!imageUrl && item.enclosure && item.enclosure.url) {
            imageUrl = item.enclosure.url;
          }

          // 4. Check content for <img> tags
          if (!imageUrl) {
            const searchIn = (item.content || "") + (item.contentEncoded || "");
            const imgMatch = searchIn.match(/<img[^>]+src="([^">]+)"/i);
            if (imgMatch) imageUrl = imgMatch[1];
          }

          // 5. Deep fetch if still no image
          if (!imageUrl && link) {
            const ogImage = await getOgImage(link);
            if (ogImage) imageUrl = ogImage;
          }
          
          // 6. Fallback
          if (!imageUrl || imageUrl.includes("feedburner")) {
            imageUrl = `https://picsum.photos/seed/${encodeURIComponent(id)}/800/450`;
          }

          // Use images.weserv.nl to proxy and resize images
          if (imageUrl && !imageUrl.includes("picsum.photos") && !imageUrl.includes("weserv.nl")) {
            imageUrl = `https://images.weserv.nl/?url=${encodeURIComponent(imageUrl)}&w=800&h=450&fit=cover`;
          }

          // Save to SQLite cache FIRST - this is our reliable fallback
          try {
            insertNews.run(
              id, docId, title, link, pubDate.toISOString(), content, source, category, summary, imageUrl, 
              process.env.SERVER_KEY || "default_secret"
            );
          } catch (e) {
            console.error("Failed to cache news in SQLite:", e);
          }

          // Try to save to Firestore, but don't let it block the loop if it fails (e.g. quota)
          if (shouldTryFirestore()) {
            try {
              await setDoc(doc(db, "news", docId), {
                id, title, link, pubDate: pubDate.toISOString(), content, source, category, summary, imageUrl,
                serverKey: process.env.SERVER_KEY || "default_secret"
              }, { merge: true });
            } catch (e) {
              if (!handleQuotaError(e, `setDoc for ${docId}`)) {
                console.error(`Firestore setDoc failed for ${docId}:`, e);
              }
            }
          }
          
          feedCount++;
        } catch (itemErr) {
          console.error(`Error processing item in ${feed.name}:`, itemErr);
        }
        }
        totalFetched += feedCount;
        console.log(`[SUCCESS] ${feed.name}: Processed ${feedCount} items`);
      } catch (fetchErr) {
        clearTimeout(timeoutId);
        console.error(`[ERROR] Failed to fetch or parse ${feed.name}:`, fetchErr);
      }
    } catch (err) {
      console.error(`[ERROR] ${feed.name} loop failed:`, err);
    }
  }
  
  // Cleanup news older than 1 month
  if (shouldTryFirestore()) {
    try {
      const q = query(collection(db, "news"), where("pubDate", "<", oneMonthAgo.toISOString()));
      const oldNewsSnapshot = await getDocs(q);
      const batch = writeBatch(db);
      oldNewsSnapshot.forEach(d => batch.delete(d.ref));
      await batch.commit();
    } catch (e) {
      if (!handleQuotaError(e, "cleanup")) {
        console.error("Cleanup failed:", e);
      }
    }
  }
  
  console.log(`[${new Date().toISOString()}] News fetch complete. Total items processed: ${totalFetched}`);
  
  if (totalFetched > 0) {
    io.emit("news-updated", { count: totalFetched, timestamp: new Date().toISOString() });
  }
}

// Initial fetch and schedule removed from top level - moved to startServer

app.use(express.json());

  // Health Check
  app.get("/api/health", async (req, res) => {
    const distExists = fs.existsSync(path.join(__dirname, "dist"));
    let newsCount = 0;
    
    if (shouldTryFirestore()) {
      try {
        const coll = collection(db, "news");
        const snapshot = await getCountFromServer(coll);
        newsCount = snapshot.data().count;
      } catch (e) {
        if (!handleQuotaError(e, "health check count")) {
          console.error("Health check Firestore news count failed, using SQLite count:", e);
        }
        const row = countCachedNews.get() as { count: number };
        newsCount = row.count;
      }
    } else {
      const row = countCachedNews.get() as { count: number };
      newsCount = row.count;
    }
  
  res.json({ 
    status: "ok", 
    dbConnected: !!db,
    newsCount,
    distExists,
    nodeEnv: process.env.NODE_ENV
  });
});

// API Endpoints
app.get("/api/debug-news", async (req, res) => {
  try {
    const q = query(collection(db, "news"), limit(10));
    const snapshot = await getDocs(q);
    const items = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({
      count: items.length,
      sample: items
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/news", async (req, res) => {
  const { category, search, limit: limitVal = 50 } = req.query;
  console.log(`[API] GET /api/news - category: ${category}, search: ${search}, limit: ${limitVal}`);
  const oneMonthAgo = new Date();
  oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);

  // Lazy background fetch if stale
  if (Date.now() - lastFetchTime > FETCH_INTERVAL) {
    console.log("News is stale, triggering background fetch...");
    fetchNews().catch(err => console.error("Background fetch failed:", err));
  }

  try {
    if (!shouldTryFirestore()) throw new Error("Quota exceeded");

    let q = query(
      collection(db, "news"),
      where("pubDate", ">=", oneMonthAgo.toISOString()),
      orderBy("pubDate", "desc"),
      limit(Number(limitVal))
    );

    if (category && category !== "All") {
      q = query(q, where("category", "==", category));
    }

    const snapshot = await getDocs(q);
    let rows = snapshot.docs.map(doc => doc.data());
    
    if (search) {
      const s = String(search).toLowerCase();
      rows = rows.filter((row: any) => 
        row.title.toLowerCase().includes(s) || 
        row.content.toLowerCase().includes(s)
      );
    }
    
    res.json(rows);
  } catch (err) {
    if (!handleQuotaError(err, "API news fetch")) {
      console.error("Error fetching news from Firestore, falling back to SQLite:", err);
    }
    try {
      const oneMonthAgoStr = oneMonthAgo.toISOString();
      let rows: any[] = [];
      if (category && category !== "All") {
        rows = getCachedNewsByCategory.all(oneMonthAgoStr, category, Number(limitVal));
      } else {
        rows = getCachedNews.all(oneMonthAgoStr, Number(limitVal));
      }

      if (search) {
        const s = String(search).toLowerCase();
        rows = rows.filter((row: any) => 
          row.title.toLowerCase().includes(s) || 
          row.content.toLowerCase().includes(s)
        );
      }
      res.json(rows);
    } catch (sqliteErr) {
      console.error("SQLite fallback failed:", sqliteErr);
      res.status(500).json({ error: "Failed to fetch news" });
    }
  }
});

app.get("/api/categories", (req, res) => {
  res.json(["All", ...CATEGORIES.map(c => c.name)]);
});

app.post("/api/fetch-now", async (req, res) => {
  try {
    console.log("Manual fetch triggered via API");
    await fetchNews();
    res.json({ status: "success" });
  } catch (err) {
    console.error("Manual fetch failed:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

async function startServer() {
  console.log("Starting server...");
  
  await testConnection();
  
  // Check if we have news before initial fetch
  try {
    const row = countCachedNews.get() as { count: number };
    const newsCount = row.count;
    if (newsCount === 0) {
      console.log("No news found in SQLite, triggering initial fetch...");
      fetchNews().catch(err => console.error("Initial fetch failed:", err));
    } else {
      console.log(`Found ${newsCount} news items in SQLite. Skipping initial fetch.`);
      lastFetchTime = Date.now();
      // Still try to fetch if it's been a while, but don't block
    }
  } catch (e) {
    console.error("Initial news count check failed:", e);
    fetchNews().catch(err => console.error("Initial fetch failed:", err));
  }
  
  // Schedule periodic fetch (every 4 hours)
  setInterval(() => {
    fetchNews().catch(err => console.error("Periodic fetch failed:", err));
  }, FETCH_INTERVAL);

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, "dist");
    console.log(`Serving static files from ${distPath}`);
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      const indexPath = path.join(distPath, "index.html");
      res.sendFile(indexPath);
    });
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
