async function getRaw() {
  const res = await fetch("https://www.scmp.com/rss/318208/feed");
  const text = await res.text();
  console.log(text.substring(0, 5000));
}
getRaw();
