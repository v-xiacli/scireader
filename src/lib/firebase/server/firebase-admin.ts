import { cert, getApps, initializeApp, type App, type AppOptions } from 'firebase-admin/app';

const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_KEY
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)
  : undefined;

const storageBucket = process.env.FIREBASE_STORAGE_BUCKET;

const appOptions: AppOptions = {
  storageBucket,
};

if (serviceAccount) {
  appOptions.credential = cert(serviceAccount);
}

let adminApp: App;

if (!getApps().length) {
  adminApp = initializeApp(appOptions);
} else {
  adminApp = getApps()[0];
}

export { adminApp };
