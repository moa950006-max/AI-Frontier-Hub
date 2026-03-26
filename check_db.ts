import { initializeApp } from "firebase/app";
import { getFirestore, collection, getCountFromServer } from "firebase/firestore";
import firebaseConfig from "./firebase-applet-config.json" assert { type: "json" };

const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp, firebaseConfig.firestoreDatabaseId);

async function checkCount() {
  try {
    const countSnapshot = await getCountFromServer(collection(db, "news"));
    console.log("News Count:", countSnapshot.data().count);
  } catch (e) {
    console.error("Error checking count:", e);
  }
  process.exit(0);
}

checkCount();
