import express from "express";
import { createServer as createViteServer } from "vite";
import { initializeApp } from "firebase/app";
import { 
  getFirestore, 
  collection, 
  doc, 
  setDoc, 
  getDoc, 
  query, 
  where, 
  orderBy, 
  limit, 
  getDocs, 
  writeBatch,
  getCountFromServer,
  count
} from "firebase/firestore";
import Parser from "rss-parser";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { createServer } from "http";
import { Server } from "socket.io";
import { GoogleGenAI } from "@google/genai";

// Import the Firebase configuration
let firebaseConfig;
try {
  const configPath = path.join(process.cwd(), "firebase-applet-config.json");
  if (fs.existsSync(configPath)) {
    firebaseConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } else if (process.env.FIREBASE_CONFIG) {
    firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
  } else {
    console.warn("Firebase configuration not found! Using placeholders.");
    firebaseConfig = { projectId: "placeholder" };
  }
} catch (e) {
  console.error("Error loading Firebase config:", e);
  firebaseConfig = { projectId: "placeholder" };
}

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

// Use /tmp for cache in read-only environments like Vercel
const CACHE_FILE = process.env.VERCEL ? path.join("/tmp", "news_cache.json") : path.join(process.cwd(), "news_cache.json");

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

async function testConnection() {
  try {
    await getDoc(doc(db, 'test', 'connection'));
    console.log("Firebase connection successful");
  } catch (error) {
    console.error("Firebase connection test failed:", error);
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
let quotaExceededUntil = 0;
let cachedNews: any[] = [];
let lastCacheTime = 0;
const FETCH_INTERVAL = 4 * 60 * 60 * 1000; // 4 hours
const CACHE_TTL = 60 * 60 * 1000; // 1 hour memory cache

// Helper to save cache to file
function saveCacheToFile(data: any[]) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({
      timestamp: Date.now(),
      data
    }));
  } catch (e) {
    console.error("Failed to save cache to file:", e);
  }
}

// Helper to load cache from file
function loadCacheFromFile(): any[] {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const content = fs.readFileSync(CACHE_FILE, "utf-8");
      const { data, timestamp } = JSON.parse(content);
      // Even if old, it's better than nothing when quota is hit
      lastCacheTime = timestamp;
      return data;
    }
  } catch (e) {
    console.error("Failed to load cache from file:", e);
  }
  return [];
}

async function fetchNews(): Promise<any[]> {
  if (Date.now() < quotaExceededUntil) {
    console.warn("Skipping fetch: Firestore quota recently exceeded. Waiting for reset.");
    return [];
  }

  try {
    console.log(`[${new Date().toISOString()}] Fetching news from RSS feeds (parallel)...`);
    lastFetchTime = Date.now();
    const oneMonthAgo = new Date();
    oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);

    const allFetchedItems: any[] = [];

    // Fetch all feeds in parallel to speed up
    const feedPromises = FEEDS.map(async (feed) => {
      try {
        console.log(`Fetching ${feed.name} from ${feed.url}`);
        
        // Add timeout to feed fetch (8 seconds)
        const fetchPromise = parser.parseURL(feed.url);
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error(`Timeout fetching ${feed.name}`)), 8000)
        );
        
        const data = await Promise.race([fetchPromise, timeoutPromise]) as any;
        
        const feedItems: any[] = [];
        let batch = writeBatch(db);
        let batchCount = 0;

        // Only process top 15 items per feed to avoid timeout on serverless
        const itemsToProcess = data.items.slice(0, 15);

        for (const item of itemsToProcess) {
          const pubDateStr = item.pubDate || new Date().toISOString();
          let pubDate = new Date(pubDateStr);
          if (isNaN(pubDate.getTime())) {
            pubDate = new Date();
          }
          
          if (pubDate < oneMonthAgo) continue;

          const id = item.guid || item.link || item.title;
          if (!id) continue;
          const docId = Buffer.from(id).toString('base64').replace(/\//g, '_').replace(/\+/g, '-');

          const title = item.title || "No Title";
          const link = item.link || "";
          const content = item.contentSnippet || item.content || "";
          const source = feed.name;
          const category = classify(title, content);
          const summary = content.substring(0, 200) + "...";
          
          let imageUrl = "";
          if (item.mediaContent && Array.isArray(item.mediaContent)) {
            const media = item.mediaContent.find((m: any) => m.$ && m.$.url);
            if (media) imageUrl = media.$.url;
          } else if (item.mediaContent && (item.mediaContent as any).$ && (item.mediaContent as any).$.url) {
            imageUrl = (item.mediaContent as any).$.url;
          }
          
          if (!imageUrl && item.mediaThumbnail && item.mediaThumbnail.$) {
            imageUrl = item.mediaThumbnail.$.url;
          }

          if (!imageUrl && item.enclosure && item.enclosure.url) {
            imageUrl = item.enclosure.url;
          }

          if (!imageUrl) {
            const searchIn = (item.content || "") + (item.contentEncoded || "");
            const imgMatch = searchIn.match(/<img[^>]+src="([^">]+)"/i);
            if (imgMatch) imageUrl = imgMatch[1];
          }

          // OG Image scraping is slow, only do it if we're not in a hurry or if it's the first few items
          if (!imageUrl && link && feedItems.length < 3) {
            const ogImage = await getOgImage(link);
            if (ogImage) imageUrl = ogImage;
          }
          
          if (!imageUrl || imageUrl.includes("feedburner")) {
            imageUrl = `https://picsum.photos/seed/${encodeURIComponent(id)}/800/450`;
          }

          if (imageUrl && !imageUrl.includes("picsum.photos") && !imageUrl.includes("weserv.nl")) {
            imageUrl = `https://images.weserv.nl/?url=${encodeURIComponent(imageUrl)}&w=800&h=450&fit=cover`;
          }

          const newsItem = {
            id, title, link, pubDate: pubDate.toISOString(), content, source, category, summary, imageUrl,
            serverKey: process.env.SERVER_KEY || "default_secret"
          };

          feedItems.push(newsItem);

          // Only write to Firestore if not in quota lockout
          if (Date.now() > quotaExceededUntil) {
            batch.set(doc(db, "news", docId), newsItem, { merge: true });
            batchCount++;
            if (batchCount >= 50) {
              await batch.commit();
              batch = writeBatch(db);
              batchCount = 0;
            }
          }
        }

        if (batchCount > 0) {
          await batch.commit();
        }
        return feedItems;
      } catch (err) {
        console.error(`[ERROR] ${feed.name} failed:`, err);
        return [];
      }
    });

    const results = await Promise.all(feedPromises);
    results.forEach(items => allFetchedItems.push(...items));
    
    // Cleanup news older than 1 month
    if (Date.now() > quotaExceededUntil) {
      try {
        const q = query(
          collection(db, "news"), 
          where("pubDate", "<", oneMonthAgo.toISOString()),
          limit(20)
        );
        const oldNewsSnapshot = await getDocs(q);
        
        if (!oldNewsSnapshot.empty) {
          const batch = writeBatch(db);
          oldNewsSnapshot.forEach(d => batch.delete(d.ref));
          await batch.commit();
        }
      } catch (e) {}
    }
    
    if (allFetchedItems.length > 0) {
      // Sort by date desc
      allFetchedItems.sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime());
      
      io.emit("news-updated", { count: allFetchedItems.length, timestamp: new Date().toISOString() });
      
      // Update memory and file cache immediately
      cachedNews = allFetchedItems;
      lastCacheTime = Date.now();
      saveCacheToFile(allFetchedItems);
    }
    return allFetchedItems;
  } catch (err) {
    console.error("Global fetchNews error:", err);
    if (err instanceof Error && err.message.includes("Quota exceeded")) {
      quotaExceededUntil = Date.now() + (60 * 60 * 1000);
    }
    return [];
  }
}

// Initial fetch and schedule removed from top level - moved to startServer

app.use(express.json());

// Health Check
app.get("/api/health", async (req, res) => {
  const distExists = fs.existsSync(path.join(__dirname, "dist"));
  let newsCount = 0;
  try {
    const countSnapshot = await getCountFromServer(collection(db, "news"));
    newsCount = countSnapshot.data().count;
  } catch (e) {}
  
  res.json({ 
    status: "ok", 
    dbConnected: !!db,
    newsCount,
    distExists,
    lastFetch: lastFetchTime ? new Date(lastFetchTime).toISOString() : "never",
    quotaExceededUntil: quotaExceededUntil > Date.now() ? new Date(quotaExceededUntil).toISOString() : "no",
    nodeEnv: process.env.NODE_ENV
  });
});

app.post("/api/fetch-news", async (req, res) => {
  try {
    await fetchNews();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
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
  const { category, search, limit: limitVal = 60 } = req.query;
  
  const categoryStr = category ? String(category) : "All";
  const searchStr = search ? String(search).toLowerCase() : "";

  function applyFilters(items: any[]) {
    let filtered = [...items];
    if (categoryStr !== "All") {
      filtered = filtered.filter(n => n.category === categoryStr);
    }
    if (searchStr) {
      filtered = filtered.filter(n => 
        n.title.toLowerCase().includes(searchStr) || 
        n.summary.toLowerCase().includes(searchStr)
      );
    }
    return filtered.slice(0, Number(limitVal));
  }

  // Lazy background fetch if stale
  if (Date.now() - lastFetchTime > FETCH_INTERVAL && Date.now() > quotaExceededUntil) {
    console.log("News is stale, triggering background fetch...");
    fetchNews().catch(err => console.error("Background fetch failed:", err));
  }

  // 1. Use memory cache if available and fresh
  if (cachedNews.length > 0 && (Date.now() - lastCacheTime < CACHE_TTL)) {
    console.log("Serving from fresh memory cache");
    return res.json(applyFilters(cachedNews));
  }

  // 2. If memory cache is stale or empty, try loading from file cache first
  if (cachedNews.length === 0) {
    const fileCache = loadCacheFromFile();
    if (fileCache.length > 0) {
      console.log("Loaded news from file cache");
      cachedNews = fileCache;
      // If file cache is still fresh enough, return it
      if (Date.now() - lastCacheTime < CACHE_TTL) {
        return res.json(applyFilters(cachedNews));
      }
    }
  }

  // 3. If we hit quota or Firestore fails, return whatever we have
  if (Date.now() < quotaExceededUntil) {
    console.log("Returning stale cache due to known quota limit");
    if (cachedNews.length > 0) {
      return res.json(applyFilters(cachedNews));
    }
  }

  // 4. Finally, try fetching from Firestore if we're not in quota lockout
  try {
    console.log("Fetching news from Firestore...");
    let q = query(
      collection(db, "news"),
      orderBy("pubDate", "desc"),
      limit(100)
    );

    const snapshot = await getDocs(q);
    const allItems = snapshot.docs.map(doc => doc.data());
    
    if (allItems.length > 0) {
      // Update memory and file cache
      cachedNews = allItems;
      lastCacheTime = Date.now();
      saveCacheToFile(allItems);
      return res.json(applyFilters(cachedNews));
    } else if (cachedNews.length > 0) {
      return res.json(applyFilters(cachedNews));
    }
    
    // If Firestore is empty, try direct fetch
    console.log("Firestore empty, attempting direct RSS fetch...");
    const directItems = await fetchNews();
    if (directItems.length > 0) {
      return res.json(applyFilters(directItems));
    }
  } catch (err) {
    console.error("Error fetching news from Firestore:", err);
    if (err instanceof Error && err.message.includes("Quota exceeded")) {
      quotaExceededUntil = Date.now() + (60 * 60 * 1000);
    }
    
    // Final fallback: return cache if we have it, otherwise try direct fetch
    if (cachedNews.length > 0) {
      console.log("Returning stale cache after Firestore error");
      return res.json(applyFilters(cachedNews));
    }
    
    console.log("Firestore failed and cache is empty, final attempt: direct RSS fetch...");
    const directItems = await fetchNews();
    if (directItems.length > 0) {
      return res.json(applyFilters(directItems));
    }
    
    res.status(500).json({ error: "Failed to fetch news", details: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/categories", (req, res) => {
  res.json(["All", ...CATEGORIES.map(c => c.name)]);
});

// Consolidate fetch endpoints
app.post("/api/fetch-now", (req, res) => {
  console.log("Manual fetch triggered via API (async)");
  // Return immediately to avoid browser timeout
  res.status(202).json({ status: "accepted", message: "Fetch started in background" });
  
  // Run fetch in background
  fetchNews().catch(err => {
    console.error("Background manual fetch failed:", err);
  });
});

async function startServer() {
  console.log("Starting server...");
  
  // Load cache from file immediately
  const fileCache = loadCacheFromFile();
  if (fileCache.length > 0) {
    cachedNews = fileCache;
    console.log(`Loaded ${cachedNews.length} items from file cache.`);
  }

  await testConnection();
  
  // Initial fetch if needed
  try {
    // If we have cache, we don't even need to check count immediately
    if (cachedNews.length === 0) {
      const countSnapshot = await getCountFromServer(collection(db, "news"));
      const newsCount = countSnapshot.data().count;
      
      if (newsCount === 0) {
        console.log("No news found, performing initial fetch...");
        fetchNews().catch(err => console.error("Initial fetch failed:", err));
      } else {
        console.log(`Found ${newsCount} existing news items. Skipping initial fetch.`);
        lastFetchTime = Date.now();
      }
    } else {
      console.log("Using file cache, skipping initial Firestore count check.");
      lastFetchTime = Date.now();
    }
  } catch (e) {
    console.error("Failed to check existing news count, attempting initial fetch anyway:", e);
    if (cachedNews.length === 0) {
      fetchNews().catch(err => console.error("Initial fetch failed:", err));
    }
  }
  
  // Schedule periodic fetch (every 4 hours)
  setInterval(() => {
    fetchNews().catch(err => console.error("Periodic fetch failed:", err));
  }, 4 * 60 * 60 * 1000);

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    console.log(`Serving static files from ${distPath}`);
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get("*", (req, res) => {
        res.sendFile(path.join(distPath, "index.html"));
      });
    } else {
      console.warn("Dist folder not found at:", distPath);
      // Fallback for Vercel where dist might be in a different place
      const altDistPath = path.join(__dirname, "dist");
      if (fs.existsSync(altDistPath)) {
        app.use(express.static(altDistPath));
        app.get("*", (req, res) => res.sendFile(path.join(altDistPath, "index.html")));
      }
    }
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
