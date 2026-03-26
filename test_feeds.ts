import Parser from "rss-parser";

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

const parser = new Parser();

async function testFeeds() {
  for (const feed of FEEDS) {
    try {
      console.log(`Testing ${feed.name}...`);
      const data = await parser.parseURL(feed.url);
      console.log(`[SUCCESS] ${feed.name}: Found ${data.items.length} items`);
    } catch (e) {
      console.error(`[ERROR] ${feed.name}:`, e.message);
    }
  }
}

testFeeds();
