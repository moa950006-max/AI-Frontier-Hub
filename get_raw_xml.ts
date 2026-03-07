async function getRaw() {
  const res = await fetch("https://techcrunch.com/category/artificial-intelligence/feed/");
  const text = await res.text();
  console.log(text.substring(0, 5000));
}
getRaw();
