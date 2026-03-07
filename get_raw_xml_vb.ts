async function getRaw() {
  const res = await fetch("https://venturebeat.com/category/ai/feed/");
  const text = await res.text();
  console.log(text.substring(0, 5000));
}
getRaw();
