import Parser from "rss-parser";
const parser = new Parser({
  customFields: {
    item: [
      ['media:content', 'mediaContent', { keepArray: true }],
      ['media:thumbnail', 'mediaThumbnail'],
      ['content:encoded', 'contentEncoded'],
    ],
  },
});

async function checkFeed() {
  const feed = await parser.parseURL("https://techcrunch.com/category/artificial-intelligence/feed/");
  console.log(JSON.stringify(feed.items[0], null, 2));
}
checkFeed();
