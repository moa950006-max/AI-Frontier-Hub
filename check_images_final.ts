import Database from "better-sqlite3";
const db = new Database("news.db");
const sample = db.prepare("SELECT title, imageUrl FROM news LIMIT 10").all();
console.log(JSON.stringify(sample, null, 2));
