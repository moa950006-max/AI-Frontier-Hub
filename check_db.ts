import Database from "better-sqlite3";
const db = new Database("news.db");
const count = db.prepare("SELECT count(*) as count FROM news").get();
console.log("News count:", count);
const samples = db.prepare("SELECT title, pubDate FROM news LIMIT 5").all();
console.log("Samples:", samples);
