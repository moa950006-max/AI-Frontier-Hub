import express from "express";
import { createServer as createViteServer } from "vite";
import Database from "better-sqlite3";
import Parser from "rss-parser";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;
const db = new Database("news.db");
const parser = new Parser({
  customFields: {
    item: [
      ['media:content', 'mediaContent', { keepArray: true }],
      ['media:thumbnail', 'mediaThumbnail'],
      ['content:encoded', 'contentEncoded'],
      ['enclosure', 'enclosure'],
    ],
  },
});

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

// Initialize Database - Ensure imageUrl column exists
try {
  db.exec("ALTER TABLE news ADD COLUMN imageUrl TEXT");
} catch (e) {
  // Column might already exist or table doesn't exist yet
}

db.exec(`
  CREATE TABLE IF NOT EXISTS news (
    id TEXT PRIMARY KEY,
    title TEXT,
    link TEXT,
    pubDate TEXT,
    content TEXT,
    source TEXT,
    category TEXT,
    summary TEXT,
    imageUrl TEXT
  )
`);

const FEEDS = [
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
  console.log("Fetching news...");
  const oneMonthAgo = new Date();
  oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);

  for (const feed of FEEDS) {
    try {
      const data = await parser.parseURL(feed.url);
      const insert = db.prepare(`
        INSERT OR IGNORE INTO news (id, title, link, pubDate, content, source, category, summary, imageUrl)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const item of data.items) {
        const pubDateStr = item.pubDate || new Date().toISOString();
        const pubDate = new Date(pubDateStr);
        
        // Skip news older than 1 month
        if (pubDate < oneMonthAgo) continue;

        const id = item.guid || item.link || item.title;
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
          const existing = db.prepare("SELECT imageUrl FROM news WHERE id = ?").get(id) as any;
          if (!existing || !existing.imageUrl || existing.imageUrl.includes("picsum.photos")) {
             const ogImage = await getOgImage(link);
             if (ogImage) imageUrl = ogImage;
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

        insert.run(id, title, link, pubDate.toISOString(), content, source, category, summary, imageUrl);
      }
    } catch (err) {
      console.error(`Error fetching ${feed.name}:`, err);
    }
  }
  
  // Cleanup news older than 1 month
  const cleanup = db.prepare("DELETE FROM news WHERE pubDate < ?");
  cleanup.run(oneMonthAgo.toISOString());
  
  console.log("News fetch and cleanup complete.");
}

// Initial fetch and schedule
fetchNews();
setInterval(fetchNews, 10 * 60 * 1000); // Every 10 minutes

app.use(express.json());

// API Endpoints
app.get("/api/news", (req, res) => {
  const { category, search, limit = 50 } = req.query;
  const oneMonthAgo = new Date();
  oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);

  let query = "SELECT * FROM news WHERE pubDate >= ?";
  const params: any[] = [oneMonthAgo.toISOString()];

  if (category && category !== "All") {
    query += " AND category = ?";
    params.push(category);
  }

  if (search) {
    query += " AND (title LIKE ? OR content LIKE ?)";
    params.push(`%${search}%`, `%${search}%`);
  }

  query += " ORDER BY pubDate DESC LIMIT ?";
  params.push(limit);

  const rows = db.prepare(query).all(...params);
  res.json(rows);
});

app.get("/api/categories", (req, res) => {
  res.json(["All", ...CATEGORIES.map(c => c.name)]);
});

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(__dirname, "dist", "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
