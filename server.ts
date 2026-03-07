import express from "express";
import { createServer as createViteServer } from "vite";
import { initializeApp } from "firebase/app";
import { getFirestore, collection, doc, setDoc, getDoc, query, where, getDocs, writeBatch, count, getCountFromServer, orderBy, limit } from "firebase/firestore";
import Parser from "rss-parser";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { createServer } from "http";
import { Server } from "socket.io";

// Import the Firebase configuration
import firebaseConfig from "./firebase-applet-config.json" assert { type: "json" };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Firebase Client SDK
const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp, firebaseConfig.firestoreDatabaseId);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = 3000;
const parser = new Parser({
  { name: "TechCrunch AI", url: "https://techcrunch.com/category/artificial-intelligence/feed/" },
  { name: "VentureBeat AI", url: "https://venturebeat.com/category/ai/feed/" },
  { name: "MIT Tech Review", url: "https://www.technologyreview.com/topic/artificial-intelligence/feed/" },
  { name: "arXiv AI", url: "https://arxiv.org/rss/cs.AI" },
  { name: "The Verge AI", url: "https://www.theverge.com/ai-artificial-intelligence/rss/index.xml" },
  { name: "Wired AI", url: "https://www.wired.com/feed/category/ai/latest/rss" },
  { name: "SCMP Tech (China)", url: "https://www.scmp.com/rss/318208/feed" },
  { name: "Pandaily AI (China)", url: "https://pandaily.com/category/ai/feed/" },
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

function classify(title: string, content: string): string {
  const text = (title + " " + content).toLowerCase();
  for (const cat of CATEGORIES) {
    if (cat.keywords.some(kw => text.includes(kw))) {
      return cat.name;
    }
  }
  return "General AI";
}

async function fetchNews() {
  console.log(`[${new Date().toISOString()}] Fetching news...`);
  const oneMonthAgo = new Date();
  oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);

  let totalFetched = 0;
  const newsCollection = collection(db, "news");

  for (const feed of FEEDS) {
    try {
      console.log(`Fetching ${feed.name} from ${feed.url}`);
      const data = await parser.parseURL(feed.url);
      console.log(`Received ${data.items.length} items from ${feed.name}`);
      
      let feedCount = 0;
      for (const item of data.items) {
        const pubDateStr = item.pubDate || new Date().toISOString();
        const pubDate = new Date(pubDateStr);
        
        // Skip news older than 1 month
        if (pubDate < oneMonthAgo) continue;

        const id = item.guid || item.link || item.title;
        const docId = Buffer.from(id).toString('base64').replace(/\//g, '_').replace(/\+/g, '-');

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

        // 5. Deep fetch if still no image (only for new items)
        if (!imageUrl && link) {
          const docRef = doc(newsCollection, docId);
          const docSnap = await getDoc(docRef);
          const existingData = docSnap.data();
          if (!existingData || !existingData.imageUrl || existingData.imageUrl.includes("picsum.photos")) {
             const ogImage = await getOgImage(link);
             if (ogImage) imageUrl = ogImage;
          } else {
            imageUrl = existingData.imageUrl;
          }
        }
        
        // 6. Fallback
        if (!imageUrl || imageUrl.includes("feedburner")) {
          imageUrl = `https://picsum.photos/seed/${encodeURIComponent(id)}/800/450`;
        }

        // Use images.weserv.nl to proxy and resize images (helps with hotlinking and performance)
        if (imageUrl && !imageUrl.includes("picsum.photos") && !imageUrl.includes("weserv.nl")) {
          imageUrl = `https://images.weserv.nl/?url=${encodeURIComponent(imageUrl)}&w=800&h=450&fit=cover`;
        }

        await setDoc(doc(newsCollection, docId), {
          id, title, link, pubDate: pubDate.toISOString(), content, source, category, summary, imageUrl
        }, { merge: true });
        
        feedCount++;
      }
      totalFetched += feedCount;
      console.log(`Saved ${feedCount} new/updated items from ${feed.name}`);
    } catch (err) {
      console.error(`Error fetching ${feed.name}:`, err);
    }
  }
  
  // Cleanup news older than 1 month
  const oldNewsQuery = query(newsCollection, where("pubDate", "<", oneMonthAgo.toISOString()));
  const oldNewsSnapshot = await getDocs(oldNewsQuery);
  const batch = writeBatch(db);
  oldNewsSnapshot.forEach(doc => batch.delete(doc.ref));
  await batch.commit();
  
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
  try {
    const snapshot = await getCountFromServer(collection(db, "news"));
    newsCount = snapshot.data().count;
  } catch (e) {}
  
  res.json({ 
    status: "ok", 
    dbConnected: !!db,
    newsCount,
    distExists,
    nodeEnv: process.env.NODE_ENV
  });
});

// API Endpoints
app.get("/api/news", async (req, res) => {
  const { category, search, limit: limitVal = 50 } = req.query;
  const oneMonthAgo = new Date();
  oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);

  try {
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
    console.error("Error fetching news from Firestore:", err);
    res.status(500).json({ error: "Failed to fetch news" });
  }
});

app.get("/api/categories", (req, res) => {
  res.json(["All", ...CATEGORIES.map(c => c.name)]);
});

async function startServer() {
  console.log("Starting server...");
  
  // Initial fetch
  fetchNews().catch(err => console.error("Initial fetch failed:", err));
  
  // Schedule periodic fetch
  setInterval(() => {
    fetchNews().catch(err => console.error("Periodic fetch failed:", err));
  }, 10 * 60 * 1000);

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
