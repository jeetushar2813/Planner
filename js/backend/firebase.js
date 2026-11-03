// The real backend: Firebase Authentication + Firestore.
// The rest of the app only talks to the small interface exported here, which is
// also implemented by demo.js, so every screen works in both modes.

import * as fb from '../vendor/firebase.js';
import { firebaseConfig } from '../config.js';

let app, auth, db;

export const backend = {
  mode: 'firebase',

  async init() {
    app = fb.initializeApp(firebaseConfig);
    auth = fb.getAuth(app);
    try {
      // Keeps a local copy in the browser so repeat visits read less from the server.
      db = fb.initializeFirestore(app, {
        localCache: fb.persistentLocalCache({ tabManager: fb.persistentMultipleTabManager() })
      });
    } catch (err) {
      console.warn('Offline cache unavailable, continuing without it.', err);
      db = fb.initializeFirestore(app, {});
    }
  },

  // ---- sign-in
  onAuth(callback) {
    return fb.onAuthStateChanged(auth, (u) => callback(u ? { uid: u.uid, email: u.email } : null));
  },
  async signIn(email, password) {
    const cred = await fb.signInWithEmailAndPassword(auth, email, password);
    return { uid: cred.user.uid, email: cred.user.email };
  },
  signOut() { return fb.signOut(auth); },
  resetPassword(email) { return fb.sendPasswordResetEmail(auth, email); },

  // Creates a login for a new person WITHOUT signing the Director out: a second,
  // temporary Firebase app instance is used for the sign-up and then thrown away.
  async createAccount(email, password) {
    const secondary = fb.initializeApp(firebaseConfig, 'create-account-' + Date.now());
    try {
      const secondaryAuth = fb.getAuth(secondary);
      const cred = await fb.createUserWithEmailAndPassword(secondaryAuth, email, password);
      const uid = cred.user.uid;
      await fb.signOut(secondaryAuth);
      return uid;
    } finally {
      await fb.deleteApp(secondary);
    }
  },

  // ---- reading
  async getDoc(path) {
    const snap = await fb.getDoc(fb.doc(db, path));
    return snap.exists() ? { id: snap.id, ...snap.data() } : null;
  },

  // opts: { where: [[field, op, value]], orderBy: [[field, 'asc'|'desc']], limit, after }
  async query(path, opts = {}) {
    const snap = await fb.getDocs(buildQuery(path, opts));
    return {
      docs: snap.docs.map((d) => ({ id: d.id, ...d.data() })),
      cursor: snap.docs.length ? snap.docs[snap.docs.length - 1] : null
    };
  },

  // Live updates. Used only for "My Tasks" to keep reads low.
  watch(path, opts, onData, onError) {
    return fb.onSnapshot(
      buildQuery(path, opts),
      (snap) => onData(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
      (err) => onError && onError(err)
    );
  },

  // ---- writing: ops = [{ type: 'set' | 'update', path, data }], all or nothing.
  async commit(ops) {
    const batch = fb.writeBatch(db);
    for (const op of ops) {
      const ref = fb.doc(db, op.path);
      if (op.type === 'set') batch.set(ref, op.data);
      else batch.update(ref, op.data);
    }
    await batch.commit();
  },

  ts() { return fb.serverTimestamp(); },
  newId(collectionPath) { return fb.doc(fb.collection(db, collectionPath)).id; }
};

function buildQuery(path, opts) {
  const parts = [];
  for (const [field, op, value] of opts.where || []) parts.push(fb.where(field, op, value));
  for (const [field, dir] of opts.orderBy || []) parts.push(fb.orderBy(field, dir || 'asc'));
  if (opts.after) parts.push(fb.startAfter(opts.after));
  if (opts.limit) parts.push(fb.limit(opts.limit));
  return fb.query(fb.collection(db, path), ...parts);
}
