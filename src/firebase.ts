import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  User,
} from 'firebase/auth';
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  memoryLocalCache,
  getFirestore,
  doc,
  setDoc,
  getDoc,
  deleteDoc,
  collection,
  addDoc,
  query,
  orderBy,
  limit,
  getDocs,
  writeBatch,
  serverTimestamp,
  Firestore,
} from 'firebase/firestore';
import firebaseAppletConfig from '../firebase-applet-config.json';
import { SaveSearchOptions, UserSearchRecord } from './types';

const getEnvVar = (key: string): string => {
  if (typeof import.meta !== 'undefined' && (import.meta as any).env && (import.meta as any).env[key]) {
    return String((import.meta as any).env[key]).trim();
  }
  if (typeof process !== 'undefined' && process.env && process.env[key]) {
    return String(process.env[key]).trim();
  }
  return '';
};

// Determine if we have a valid external Firebase API key set in the environment
const hasValidEnvConfig = (): boolean => {
  const envKey = getEnvVar('VITE_FIREBASE_API_KEY');
  return envKey.startsWith('AIzaSy');
};

const useEnv = hasValidEnvConfig();

// Construct config, prioritizing environment variables, falling back to pre-configured values
const firebaseConfig = useEnv ? {
  apiKey: getEnvVar('VITE_FIREBASE_API_KEY'),
  authDomain: getEnvVar('VITE_FIREBASE_AUTH_DOMAIN'),
  projectId: getEnvVar('VITE_FIREBASE_PROJECT_ID'),
  storageBucket: getEnvVar('VITE_FIREBASE_STORAGE_BUCKET'),
  messagingSenderId: getEnvVar('VITE_FIREBASE_MESSAGING_SENDER_ID'),
  appId: getEnvVar('VITE_FIREBASE_APP_ID'),
  firestoreDatabaseId: getEnvVar('VITE_FIREBASE_DATABASE_ID'),
} : {
  apiKey: firebaseAppletConfig.apiKey,
  authDomain: firebaseAppletConfig.authDomain,
  projectId: firebaseAppletConfig.projectId,
  storageBucket: firebaseAppletConfig.storageBucket,
  messagingSenderId: firebaseAppletConfig.messagingSenderId,
  appId: firebaseAppletConfig.appId,
  firestoreDatabaseId: firebaseAppletConfig.firestoreDatabaseId || (firebaseAppletConfig as any).firestoreDatabaseId,
};


console.log('Firebase Init Config Debug (Safe):', {
  usingEnvOverrides: useEnv,
  apiKeyLength: firebaseConfig.apiKey ? firebaseConfig.apiKey.length : 0,
  apiKeyPrefix: firebaseConfig.apiKey ? firebaseConfig.apiKey.substring(0, 6) : 'none',
  projectId: firebaseConfig.projectId,
  authDomain: firebaseConfig.authDomain,
  firestoreDatabaseId: firebaseConfig.firestoreDatabaseId,
});

// Initialize Firebase App
const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// Initialize Firestore with Optimized Multi-Tier Persistent Cache
function setupOptimizedFirestore(): Firestore {
  const multiTabSettings = {
    localCache: persistentLocalCache({
      tabManager: persistentMultipleTabManager(),
    }),
    experimentalAutoDetectLongPolling: true,
  };

  try {
    if (firebaseConfig.firestoreDatabaseId) {
      return initializeFirestore(app, multiTabSettings, firebaseConfig.firestoreDatabaseId);
    }
    return initializeFirestore(app, multiTabSettings);
  } catch (err: any) {
    // If persistent IndexedDB is restricted (e.g. Safari private browsing, isolated iframes), fallback gracefully to memory cache
    console.warn('Persistent IndexedDB cache unavailable, falling back to memory cache:', err?.message || err);
    try {
      const memorySettings = {
        localCache: memoryLocalCache(),
        experimentalAutoDetectLongPolling: true,
      };
      if (firebaseConfig.firestoreDatabaseId) {
        return initializeFirestore(app, memorySettings, firebaseConfig.firestoreDatabaseId);
      }
      return initializeFirestore(app, memorySettings);
    } catch {
      // If already initialized, return standard instance
      return firebaseConfig.firestoreDatabaseId
        ? getFirestore(app, firebaseConfig.firestoreDatabaseId)
        : getFirestore(app);
    }
  }
}

export const db: Firestore = setupOptimizedFirestore();
export const googleProvider = new GoogleAuthProvider();

// Error Handling Spec for Firestore Operations
export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  };
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const message = error instanceof Error ? error.message : String(error);
  const errInfo: FirestoreErrorInfo = {
    error: message,
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map((provider) => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL,
      })) || [],
    },
    operationType,
    path,
  };
  console.warn(`[Firestore ${operationType.toUpperCase()}] at ${path}:`, message, errInfo);
  throw new Error(`Firestore operation failed (${operationType}): ${message}`);
}

// Auth Helper Functions
export const loginWithGoogle = async (): Promise<User> => {
  try {
    const result = await signInWithPopup(auth, googleProvider);
    const user = result.user;

    // Create or update user profile in Firestore with null-safe fields
    const userRef = doc(db, 'users', user.uid);
    const profileData: Record<string, any> = {
      uid: user.uid,
      email: user.email || '',
      displayName: user.displayName || null,
      photoURL: user.photoURL || null,
      lastLogin: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };

    await setDoc(userRef, profileData, { merge: true });
    return user;
  } catch (error) {
    console.error('Login error:', error);
    throw error;
  }
};

export const logout = () => signOut(auth);

// Firestore Data Helpers

/**
 * Persist user search inquiries to subcollection users/{userId}/searches
 */
export const saveSearch = async (
  userId: string,
  rawQuery: string,
  resultCount: number,
  options?: SaveSearchOptions
): Promise<string | null> => {
  const queryText = (rawQuery || '').trim();
  if (!userId || !queryText) return null;

  const searchesRef = collection(db, 'users', userId, 'searches');
  const count = Math.max(0, Math.round(Number(resultCount) || 0));

  const payload: Record<string, any> = {
    userId,
    query: queryText.substring(0, 500),
    timestamp: serverTimestamp(),
    resultCount: count,
  };

  if (options?.companyName) {
    payload.companyName = options.companyName.trim().substring(0, 128);
  }
  if (options?.priceListYear) {
    payload.priceListYear = String(options.priceListYear).trim().substring(0, 10);
  }
  if (typeof options?.aiUsed === 'boolean') {
    payload.aiUsed = options.aiUsed;
  }

  try {
    const docRef = await addDoc(searchesRef, payload);
    return docRef.id;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `users/${userId}/searches`);
    return null;
  }
};

/**
 * Remove an individual search history item
 */
export const deleteSearch = async (userId: string, searchId: string): Promise<boolean> => {
  if (!userId || !searchId) return false;
  const searchDocRef = doc(db, 'users', userId, 'searches', searchId);
  try {
    await deleteDoc(searchDocRef);
    return true;
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, `users/${userId}/searches/${searchId}`);
    return false;
  }
};

/**
 * Clear recent search inquiries in an atomic Firestore batch
 */
export const clearRecentSearches = async (userId: string, batchLimit = 30): Promise<void> => {
  if (!userId) return;
  const searchesRef = collection(db, 'users', userId, 'searches');
  try {
    const q = query(searchesRef, orderBy('timestamp', 'desc'), limit(batchLimit));
    const snapshot = await getDocs(q);
    if (snapshot.empty) return;

    const batch = writeBatch(db);
    snapshot.docs.forEach((docItem) => {
      batch.delete(docItem.ref);
    });
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, `users/${userId}/searches [batch]`);
  }
};

