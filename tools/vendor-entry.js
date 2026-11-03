// Entry point for the bundled Firebase SDK. Only what the app uses is exported,
// which keeps js/vendor/firebase.js small. Rebuild with: npm run build:vendor
export { initializeApp, deleteApp } from 'firebase/app';
export {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
  sendPasswordResetEmail, createUserWithEmailAndPassword
} from 'firebase/auth';
export {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, collection, getDoc, getDocs, query, where, orderBy, limit, startAfter,
  onSnapshot, writeBatch, serverTimestamp, Timestamp
} from 'firebase/firestore';
