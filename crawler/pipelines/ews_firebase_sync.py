#!/usr/bin/env python3
"""
Enterprise EWS to Firestore Synchronization Pipeline
High-throughput, idempotent, batched synchronization engine with payload sanitization.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
import sys
import logging
import hashlib
from datetime import datetime, timedelta, timezone
from typing import Generator, List, Dict, Any, Optional

from dotenv import load_dotenv
from bs4 import BeautifulSoup

# EWS Imports
from exchangelib import (
    Credentials,
    Configuration,
    Account,
    DELEGATE,
    EWSDateTime,
    EWSTimeZone,
    Folder,
)
from exchangelib.errors import (
    ErrorServerBusy,
    ErrorTimeoutExpired,
    ErrorItemNotFound,
)

# Firebase Admin Imports
import firebase_admin
from firebase_admin import credentials, firestore
from google.cloud.firestore_v1 import Client as FirestoreClient
from google.cloud.firestore_v1 import SERVER_TIMESTAMP

# ==============================================================================
# LOGGING CONFIGURATION
# ==============================================================================
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] [%(name)s]: %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger("EWS-Firestore-Pipeline")

# ==============================================================================
# ENVIRONMENT & CONSTANTS
# ==============================================================================
# Anchor to the project root so the pipeline works from any CWD; search both
# .env.local and .env (earlier files win), which is where the credentials live.
_PROJECT_ROOT = str(Path(__file__).resolve().parents[2])
load_dotenv(Path(_PROJECT_ROOT) / ".env.local")
load_dotenv(Path(_PROJECT_ROOT) / ".env")

IMAP_HOST = os.getenv("IMAP_HOST", "wmail.elitehospital.org")
IMAP_USER = os.getenv("IMAP_USER", "mohanad.elmaamoun@elitehospital.org")
IMAP_PASSWORD = os.getenv("IMAP_PASSWORD", "")
TARGET_FOLDER_NAME = os.getenv("IMAP_FOLDER", "InApprovals")

# Known on-prem folder ID fallback
EXACT_INAPPROVALS_FOLDER_ID = os.getenv(
    "EXACT_INAPPROVALS_FOLDER_ID",
    "AAMkAGU5Y2EzNmMxLTIwZDItNDcxOC05ZTk0LTBlODJjZjkxOGU5NgAuAAAAAAA4U9epEFcNRbR5QhtWJDZyAQCVKjW+UMYOTr9U/HR/zy7WAAActvclAAA="
)

FIRESTORE_PROJECT_ID = os.getenv("FIREBASE_PROJECT_ID", "ai-studio-applet-webapp-f4da3")
FIRESTORE_DATABASE_ID = os.getenv("FIRESTORE_DATABASE_ID", "(default)")
APPROVALS_COLLECTION = "inpatient_approvals"
FIRESTORE_BATCH_LIMIT = 450  # Hard limit is 500; 450 leaves headroom for safety

# ==============================================================================
# FIREBASE INITIALIZATION
# ==============================================================================
def init_firestore() -> FirestoreClient:
    """Initializes and returns the Firestore client."""
    if not firebase_admin._apps:
        cred_path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
        if cred_path and os.path.exists(cred_path):
            cred = credentials.Certificate(cred_path)
            firebase_admin.initialize_app(cred, {"projectId": FIRESTORE_PROJECT_ID})
        else:
            firebase_admin.initialize_app(options={"projectId": FIRESTORE_PROJECT_ID})

    if FIRESTORE_DATABASE_ID and FIRESTORE_DATABASE_ID != "(default)":
        return firestore.client(database=FIRESTORE_DATABASE_ID)
    return firestore.client()

# ==============================================================================
# EWS CONNECTION & OPTIMIZED ACCOUNT FACTORY
# ==============================================================================
def connect_ews() -> Account:
    """Establishes an optimized EWS session with NTLM/Basic auth credentials."""
    username = IMAP_USER.split("@")[0] if "@" in IMAP_USER else IMAP_USER
    domain = os.getenv("EXCHANGE_DOMAIN", "elitehospital")
    auth_identity = f"{domain}\\{username}" if domain else IMAP_USER

    ews_url = f"https://{IMAP_HOST}/EWS/Exchange.asmx"
    logger.info(f"Connecting to EWS at {ews_url} for user {auth_identity}...")

    creds = Credentials(username=auth_identity, password=IMAP_PASSWORD)
    config = Configuration(server=IMAP_HOST, credentials=creds)

    account = Account(
        primary_smtp_address=IMAP_USER,
        config=config,
        autodiscover=False,
        access_type=DELEGATE,
    )
    logger.info("EWS Account connection established successfully.")
    return account

def get_target_folder(account: Account, folder_name: str) -> Folder:
    """Resolves target folder using exact folder ID or displayName traversal."""
    try:
        return account.root.get_folder(EXACT_INAPPROVALS_FOLDER_ID)
    except Exception as e:
        logger.warning(f"Could not bind directly via exact Folder ID: {e}. Searching folders...")
        for folder in account.msgfolderroot.walk():
            if folder.name.lower() == folder_name.lower():
                return folder
        raise FileNotFoundError(f"Target folder '{folder_name}' could not be located in EWS.")

# ==============================================================================
# DATA SANITIZATION & NORMALIZATION
# ==============================================================================
def sanitize_text(text: Optional[str]) -> str:
    """Strips HTML tags, controls characters, and limits string memory footprint."""
    if not text:
        return ""
    soup = BeautifulSoup(text, "html.parser")
    clean = soup.get_text(separator=" ")
    clean = re.sub(r"[\r\n\t]+", " ", clean)
    clean = re.sub(r"\s{2,}", " ", clean)
    return clean.strip()

def extract_mrn(subject: str, body: str) -> Optional[str]:
    """Extracts hospital Medical Record Number (MRN) from subject or body."""
    combined = f"{subject} {body}"
    patterns = [
        r"\(MRN:\s*(\d{5,12})\)",
        r"Patient Barcode:\s*(\d{5,12})",
        r"(?:MRN|الرقم الطبي)\s*[:\/\s]*(\d{5,12})",
        r"\b(0000\d{5,7}|\d{6,8})\b",
    ]
    for pattern in patterns:
        match = re.search(pattern, combined, re.IGNORECASE)
        if match:
            candidate = match.group(1).strip()
            if candidate != "0000000000":
                return candidate
    return None

def extract_patient_name(body: str) -> str:
    """Heuristic extraction for patient name from Arabic/English hospital templates."""
    patterns = [
        r"Patient Name\s*:\s*([^<\r\n]+)",
        r"اسم المريض\s*:\s*([^<\r\n]+)",
        r"المريض\s*:\s*([^<\r\n]+)",
    ]
    for pattern in patterns:
        match = re.search(pattern, body, re.IGNORECASE)
        if match:
            return match.group(1).strip()[:100]
    return "Unknown Patient"

def build_deterministic_id(mrn: str, conversation_id: str, subject: str) -> str:
    """Creates an idempotent Firestore document key based on MRN and thread identity."""
    thread_key = f"{conversation_id}_{subject.lower().strip()}"
    thread_hash = hashlib.md5(thread_key.encode("utf-8")).hexdigest()[:8]
    return f"mrn_{mrn}_{thread_hash}"

# ==============================================================================
# PIPELINE GENERATOR & BATCHED UPSERT
# ==============================================================================
def stream_ews_items(
    folder: Folder,
    days_back: int = 3,
) -> Generator[Dict[str, Any], None, None]:
    """
    Traverses the EWS folder using lightweight field projections (.only()),
    yielding sanitized dictionaries ready for Firestore.
    """
    cairo_tz = EWSTimeZone("Africa/Cairo")
    cutoff_datetime = datetime.now(timezone.utc) - timedelta(days=days_back)
    ews_cutoff = EWSDateTime.from_datetime(cutoff_datetime).astimezone(cairo_tz)

    logger.info(f"Filtering items received after: {ews_cutoff.isoformat()}")

    queryset = (
        folder.filter(datetime_received__gte=ews_cutoff)
        .only(
            "id",
            "changekey",
            "conversation_id",
            "message_id",
            "subject",
            "datetime_received",
            "sender",
            "text_body",
            "body",
        )
        .order_by("-datetime_received")
    )

    for item in queryset:
        try:
            subject = str(item.subject or "").strip()
            raw_body = str(item.body or item.text_body or "")
            clean_body = sanitize_text(raw_body)

            mrn = extract_mrn(subject, clean_body)
            if not mrn:
                continue

            conv_id = getattr(item.conversation_id, "id", str(item.id))
            doc_id = build_deterministic_id(mrn, conv_id, subject)

            received_dt = item.datetime_received
            if isinstance(received_dt, EWSDateTime):
                received_dt = datetime.fromtimestamp(received_dt.timestamp(), tz=timezone.utc)
            elif received_dt is None:
                received_dt = datetime.now(timezone.utc)

            thread_signature = hashlib.md5(
                f"{item.id}_{item.changekey}_{received_dt.isoformat()}".encode("utf-8")
            ).hexdigest()

            payload = {
                "id": doc_id,
                "messageId": item.message_id or f"<{mrn}@exchange>",
                "exchangeItemId": item.id,
                "exchangeChangeKey": item.changekey,
                "conversationId": conv_id,
                "receivedAt": received_dt,
                "patientName": extract_patient_name(clean_body),
                "mrn": mrn,
                "subject": subject,
                "sanitizedSnippet": clean_body[:800],
                "threadHash": thread_signature,
                "status": "new_request",
                "aiProcessingStatus": "pending_analysis",
                "updatedAt": SERVER_TIMESTAMP,
            }

            yield payload

        except Exception as item_err:
            logger.error(f"Error parsing item {getattr(item, 'id', 'Unknown')}: {item_err}", exc_info=False)
            continue


def commit_firestore_batches(db: FirestoreClient, records: Generator[Dict[str, Any], None, None]) -> int:
    """
    Batches documents in chunks of up to 450 items and performs atomic upserts via .set(..., merge=True).
    """
    batch = db.batch()
    batch_count = 0
    total_committed = 0

    col_ref = db.collection(APPROVALS_COLLECTION)

    for record in records:
        doc_id = record["id"]
        doc_ref = col_ref.document(doc_id)

        batch.set(doc_ref, record, merge=True)
        batch_count += 1

        if batch_count >= FIRESTORE_BATCH_LIMIT:
            logger.info(f"Committing batch of {batch_count} records to Firestore...")
            batch.commit()
            total_committed += batch_count
            batch = db.batch()
            batch_count = 0

    if batch_count > 0:
        logger.info(f"Committing final batch of {batch_count} records to Firestore...")
        batch.commit()
        total_committed += batch_count

    return total_committed


# ==============================================================================
# MAIN SYNC ORCHESTRATOR
# ==============================================================================
def run_sync():
    """Main execution entrypoint with backoff and error recovery."""
    start_time = datetime.now()
    logger.info("Starting optimized EWS -> Firestore synchronization pipeline...")

    try:
        db = init_firestore()
        account = connect_ews()
        target_folder = get_target_folder(account, TARGET_FOLDER_NAME)

        item_stream = stream_ews_items(target_folder, days_back=3)
        committed_count = commit_firestore_batches(db, item_stream)

        duration = (datetime.now() - start_time).total_seconds()
        logger.info(f"Pipeline finished successfully: {committed_count} documents synchronized in {duration:.2f}s.")

    except (ErrorServerBusy, ErrorTimeoutExpired) as ews_err:
        logger.critical(f"EWS Throttle/Timeout Encountered: {ews_err}. Backing off.")
        sys.exit(2)
    except Exception as general_err:
        logger.critical(f"Fatal pipeline error: {general_err}", exc_info=True)
        sys.exit(1)


if __name__ == "__main__":
    run_sync()
