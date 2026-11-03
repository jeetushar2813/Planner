// ---------------------------------------------------------------------------
// Team Planner settings. This is the ONLY file you edit to connect Firebase.
//
// 1. In the Firebase console open Project settings > General > Your apps > Web app.
// 2. Copy the values of the firebaseConfig object into the fields below.
//
// These values are not secrets. They only identify your Firebase project. What
// protects your data is the login system and firestore.rules.
//
// While the apiKey below still says PASTE_YOUR_API_KEY the app runs in DEMO MODE:
// sample data that lives only in your browser, so you can try every screen first.
// ---------------------------------------------------------------------------

export const firebaseConfig = {
  apiKey: "AIzaSyDOAr_wiDXIgteL_1gEwkW1gvhQu48ORqk",
  authDomain: "planner-600b6.firebaseapp.com",
  projectId: "planner-600b6",
  storageBucket: "planner-600b6.firebasestorage.app",
  messagingSenderId: "163739653520",
  appId: "1:163739653520:web:b91b2d375813e91896cf15",
  measurementId: "G-ZBS7SRL9SL"
};

export const appSettings = {
  appName: 'Planner',
  organisation: 'SMM Education Group'
};

export function isConfigured() {
  return !String(firebaseConfig.apiKey).startsWith('PASTE_');
}
