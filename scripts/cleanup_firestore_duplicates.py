#!/usr/bin/env python3
"""
Scans inpatient_approvals for duplicate or obsolete single-MRN document keys and removes them.
Idempotent batch deletion utility.
"""

import os
import sys
import firebase_admin
from firebase_admin import credentials, firestore

FIRESTORE_PROJECT_ID = os.getenv("FIREBASE_PROJECT_ID", "ai-studio-applet-webapp-f4da3")
FIRESTORE_DATABASE_ID = os.getenv("FIRESTORE_DATABASE_ID", "(default)")
APPROVALS_COLLECTION = "inpatient_approvals"

if __name__ == "__main__":
    if not firebase_admin._apps:
        cred_path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
        if cred_path and os.path.exists(cred_path):
            cred = credentials.Certificate(cred_path)
            firebase_admin.initialize_app(cred, {"projectId": FIRESTORE_PROJECT_ID})
        else:
            firebase_admin.initialize_app(options={"projectId": FIRESTORE_PROJECT_ID})

    if FIRESTORE_DATABASE_ID and FIRESTORE_DATABASE_ID != "(default)":
        db = firestore.client(database=FIRESTORE_DATABASE_ID)
    else:
        db = firestore.client()

    col = db.collection(APPROVALS_COLLECTION)
    print(f"Scanning '{APPROVALS_COLLECTION}' in project '{FIRESTORE_PROJECT_ID}'...")

    docs = list(col.stream())
    print(f"Total documents scanned: {len(docs)}")

    deleted_count = 0
    batch = db.batch()
    batch_count = 0

    for doc in docs:
        doc_id = doc.id
        # Obsolete pattern: "mrn_123456" without thread hash
        parts = doc_id.split("_")
        if len(parts) == 2 and parts[0] == "mrn" and parts[1].isdigit():
            print(f"Flagged obsolete single-MRN document for purging: {doc_id}")
            batch.delete(doc.reference)
            batch_count += 1
            deleted_count += 1

            if batch_count >= 450:
                print(f"Committing batch deletion of {batch_count} records...")
                batch.commit()
                batch = db.batch()
                batch_count = 0

    if batch_count > 0:
        print(f"Committing final batch deletion of {batch_count} records...")
        batch.commit()

    print(f"Scrub complete: {deleted_count} obsolete documents purged.")
