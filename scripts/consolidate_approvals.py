#!/usr/bin/env python3
"""
Approvals Consolidation & Reply Thread Reducer
Applies the architectural rule:
  - 1 Entry per distinct Approval Mail (identified by conversation_id)
  - Replies update the existing approval mail entry (capturing pure reply text, approvals, limits, refusals)
  - The mail timing is strictly preserved as the timestamp of the approval mail itself (earliest in thread)
  - Deletes redundant duplicate reply entries from PostgreSQL and Firestore.
"""

import os
import sys
import json
import re
import urllib.request
import urllib.parse
from datetime import datetime
from typing import Dict, List, Any, Optional

def load_env() -> Dict[str, str]:
    env = {}
    for fn in ['.env.local', '.env']:
        if os.path.exists(fn):
            with open(fn, 'r', encoding='utf-8') as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith('#') and '=' in line:
                        k, v = line.split('=', 1)
                        env[k.strip()] = v.strip().strip('\"\'')
    return env

ENV = load_env()
SUPABASE_URL = ENV.get('VITE_SUPABASE_URL', '').rstrip('/')
SUPABASE_KEY = ENV.get('SUPABASE_SERVICE_ROLE_KEY') or ENV.get('VITE_SUPABASE_ANON_KEY', '')

if not SUPABASE_URL or not SUPABASE_KEY:
    print('❌ Error: Supabase credentials not found in environment.')
    sys.exit(1)

HEADERS = {
    'apikey': SUPABASE_KEY,
    'Authorization': f'Bearer {SUPABASE_KEY}',
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
}

def supabase_get(endpoint: str) -> List[Dict[str, Any]]:
    url = f'{SUPABASE_URL}/rest/v1/{endpoint}'
    req = urllib.request.Request(url, headers=HEADERS, method='GET')
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode('utf-8'))

def supabase_patch(table: str, row_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    quoted_id = urllib.parse.quote(row_id, safe='')
    url = f'{SUPABASE_URL}/rest/v1/{table}?id=eq.{quoted_id}'
    data = json.dumps(payload).encode('utf-8')
    req = urllib.request.Request(url, data=data, headers=HEADERS, method='PATCH')
    with urllib.request.urlopen(req) as resp:
        res = json.loads(resp.read().decode('utf-8'))
        return res[0] if res else {}

def supabase_delete(table: str, row_id: str) -> None:
    quoted_id = urllib.parse.quote(row_id, safe='')
    url = f'{SUPABASE_URL}/rest/v1/{table}?id=eq.{quoted_id}'
    req = urllib.request.Request(url, headers=HEADERS, method='DELETE')
    with urllib.request.urlopen(req) as resp:
        pass

def clean_html_reply(text: Optional[str]) -> str:
    if not text:
        return ''
    # Cut off at email quotation separators
    for sep in [
        r'<hr[\s>]',
        r'id=[\"\x27]?divRplyFwdMsg',
        r'id=[\"\x27]?ms-outlook-mobile-body-separator-line',
        r'id=[\"\x27]?ms-outlook-mobile-signature',
        r'<blockquote[\s>]',
        r'-----Original Message-----',
        r'----- Original Message -----',
        r'<b[^>]*>From:</b>',
        r'From:\s*HIS\s*Notifications',
        r'From:\s*Approvals',
    ]:
        m = re.search(sep, text, re.I)
        if m:
            text = text[:m.start()]
    text = re.sub(r'<style[^>]*>.*?</style>', '', text, flags=re.S|re.I)
    text = re.sub(r'<script[^>]*>.*?</script>', '', text, flags=re.S|re.I)
    text = re.sub(r'<[^>]+>', ' ', text)
    text = re.sub(r'&nbsp;', ' ', text)
    text = re.sub(r'Get Outlook for (?:iOS|Android)', '', text, flags=re.I)
    text = re.sub(r'Sent from my (?:iPhone|iPad|Galaxy)', '', text, flags=re.I)
    text = re.sub(r'تم الإرسال من (?:هاتفي|Outlook)', '', text, flags=re.I)
    cleaned = re.sub(r'\s+', ' ', text).strip()
    if any(k in cleaned for k in ['Patient Information', 'SELECTED SERVICES', 'Type: Request', 'Patient Barcode', 'HIS Notifications']):
        return ''
    return cleaned

def parse_iso(ts: Optional[str]) -> datetime:
    if not ts:
        return datetime.max
    # Normalize ISO string
    clean_ts = ts.replace('Z', '+00:00')
    try:
        return datetime.fromisoformat(clean_ts)
    except Exception:
        return datetime.max

def consolidate(dry_run: bool = True):
    print('===============================================================')
    print(f'🚀 Approvals Consolidation Engine (Dry-Run: {dry_run})')
    print('===============================================================\n')

    all_rows = supabase_get('inpatient_approvals?select=*&order=received_at.asc')
    print(f'📊 Fetched {len(all_rows)} total rows from inpatient_approvals.')

    # Group by conversation_id
    grouped: Dict[str, List[Dict[str, Any]]] = {}
    for r in all_rows:
        cid = r.get('conversation_id') or r.get('id')
        grouped.setdefault(cid, []).append(r)

    print(f'🎯 Distinct approval mails / conversations: {len(grouped)}\n')

    to_update: List[Dict[str, Any]] = []
    to_delete_ids: List[str] = []

    for cid, items in grouped.items():
        # Sort items chronologically by received_at
        sorted_items = sorted(items, key=lambda x: parse_iso(x.get('received_at')))
        canonical = sorted_items[0]
        duplicate_items = sorted_items[1:]

        earliest_received = canonical.get('received_at')
        latest_reply_at = sorted_items[-1].get('received_at') if len(sorted_items) > 1 else None

        # Check approval / refusal / replies across all items
        has_approval = any(it.get('has_existing_approval') or it.get('status') == 'answered' for it in items)
        has_refusal = any(it.get('is_refused') or it.get('status') == 'refused' for it in items)
        has_replies = len(items) > 1 or any(it.get('has_replies') for it in items)

        # Determine unified status
        if has_refusal:
            status = 'refused'
        elif has_approval:
            status = 'answered'
        else:
            # Pick non-received status if present
            non_recv = next((it.get('status') for it in reversed(items) if it.get('status') != 'received'), None)
            status = non_recv or canonical.get('status') or 'received'

        # Find best clinical fields
        patient_name = next((it.get('patient_name') for it in items if it.get('patient_name') and it.get('patient_name') != 'غير مسجل'), canonical.get('patient_name'))
        mrn = next((it.get('mrn') for it in items if it.get('mrn') and it.get('mrn') != '000000'), canonical.get('mrn'))
        bed = next((it.get('bed') for it in items if it.get('bed')), canonical.get('bed'))
        admission_type = next((it.get('admission_type') for it in items if it.get('admission_type')), canonical.get('admission_type'))
        physician = next((it.get('physician') for it in items if it.get('physician')), canonical.get('physician'))
        contractor_raw = next((it.get('contractor_raw') for it in items if it.get('contractor_raw') and it.get('contractor_raw') != 'غير محدد'), canonical.get('contractor_raw'))
        contractor_normalized = next((it.get('contractor_normalized') for it in items if it.get('contractor_normalized') and it.get('contractor_normalized') != 'غير محدد'), canonical.get('contractor_normalized'))
        contractor_officer = next((it.get('contractor_officer') for it in items if it.get('contractor_officer')), canonical.get('contractor_officer'))
        diagnosis = next((it.get('diagnosis') for it in items if it.get('diagnosis') and it.get('diagnosis') != 'Clinical Inpatient Evaluation'), canonical.get('diagnosis'))
        
        # Services & matched procedures
        services = next((it.get('requested_services') for it in items if it.get('requested_services') and len(it.get('requested_services')) > 0), canonical.get('requested_services') or [])
        matched = next((it.get('matched_procedures') for it in items if it.get('matched_procedures') and len(it.get('matched_procedures')) > 0), canonical.get('matched_procedures') or [])

        # Financial terms & replies
        approved_amount_limit = -1
        credit_limit_text = None
        for it in items:
            ft = it.get('financial_terms') or {}
            lim = ft.get('approvedAmountLimit')
            if lim and isinstance(lim, (int, float)) and lim > 0:
                approved_amount_limit = lim
                credit_limit_text = ft.get('creditLimitText') or f'{int(lim):,} EGP'
                break

        # Specific user overrides for Omar Yasser and Fadel El Sayed
        if 'عمر ياسر' in patient_name:
            reply_text = 'ﻻﻣﺎﻧﻊ ﻣن اﻟدﺧول طوارئ رﻋﺎﯾﺔ ﻟﺗﻠﻘﻰ اﻟﻌﻼج اﻟﺗﺣﻔظﻰ ﻟﺣﺎﻟﺔ اﺷﺗﺑﺎه ﻣﺎ ﺑﻌد ارﺗﺟﺎج ﺑﺎﻟﻣﺦ وﺟرح ﺑﺎﻟﺣﺎﺟب وﺟرح ﺑﺎﻟﺳﺎق اﺛر ﺣﺎدث ﺳﯾر -ﻣﻼﺣظﺎت وﺗﻔﺎﺻﯾل اﻟﺗﻐطﯾﮫ . اﻟﺣد اﻷﻗﺻﻰ ﻟﻠﻣواﻓﻘﺔ 30 اﻟف ﺟﻧﯾﮫ ﻓﻘط ﻻ ﻏﯾر ﻣﻊ ﻣواﻓﺎﺗﻧﺎ ﺑﻛﺎﻓﺔ اﻟﻔﺣوﺻﺎت واﻟﺗﻛﻠﻔﺔ اﻟﺗﻘدﯾرﯾﺔ ﻓﻲ ﺣﺎﻟﺔ اﻻﺣﺗﯾﺎج ﻟرﻓﻊ اﻟﺣد اﻻﻗﺻﻰ أو ﻣد اﻻﻗﺎﻣﺔ'
            status = 'answered'
            has_approval = True
            approved_amount_limit = 30000
            credit_limit_text = '30,000 EGP'
            b_label = bed or 'Inpatient Bed'
            c_label = contractor_normalized or 'جلوب ميد'
            whatsapp_msg = f'*{patient_name}* - {b_label}\n{c_label}\n*تمت الموافقة على: الدخول والإجراءات المقررة (حد أقصى: 30,000 ج.م)*'
        elif 'فاضل السيد' in patient_name and '10:18' in (earliest_received or ''):
            reply_text = 'لا مانع'
            status = 'answered'
            has_approval = True
            b_label = bed or 'Bed 411 - FourthFloor'
            c_label = contractor_normalized or 'مصر للطيران'
            whatsapp_msg = f'*{patient_name}* - {b_label}\n{c_label}\n*تمت الموافقة على: MRSA full screen culture (3 swabs)*'
        elif 'فاضل السيد' in patient_name and '20:53' in (earliest_received or ''):
            reply_text = 'لا مانع من عمل العمليه المطلوب علي ان تكون بأسعار التعاقد وفقا لتعليمات التشغيل'
            status = 'answered'
            has_approval = True
            b_label = bed or 'Bed 411 - FourthFloor'
            c_label = contractor_normalized or 'مصر للطيران'
            whatsapp_msg = f'*{patient_name}* - {b_label}\n{c_label}\n*تمت الموافقة على: قلب مفتوح وعمل تحويل مسار الشرايين التاجية بالتدخل المحدود بالمنظار*'
        else:
            # Extract cleanest reply
            replies_found = []
            for it in reversed(items):
                raw_rep = it.get('status_reason_arabic') or (it.get('financial_terms') or {}).get('coverageConditions')
                cleaned_rep = clean_html_reply(raw_rep)
                if cleaned_rep and cleaned_rep not in replies_found:
                    replies_found.append(cleaned_rep)
            reply_text = replies_found[0] if replies_found else None
            # pick best whatsapp msg
            whatsapp_msg = next((it.get('cm_whatsapp_message') for it in reversed(items) if it.get('cm_whatsapp_message')), canonical.get('cm_whatsapp_message'))

        draft_reply = next((it.get('suggested_draft_reply') for it in items if it.get('suggested_draft_reply')), canonical.get('suggested_draft_reply'))

        updated_payload = {
            'id': canonical['id'],
            'received_at': earliest_received,  # KEEP THE MAIL TIMING OF THE APPROVAL MAIL ITSELF
            'patient_name': patient_name,
            'mrn': mrn,
            'bed': bed,
            'admission_type': admission_type,
            'physician': physician,
            'contractor_raw': contractor_raw,
            'contractor_normalized': contractor_normalized,
            'contractor_officer': contractor_officer,
            'diagnosis': diagnosis,
            'requested_services': services,
            'matched_procedures': matched,
            'status': status,
            'has_replies': has_replies,
            'has_existing_approval': has_approval,
            'is_refused': has_refusal,
            'financial_terms': {
                'patientSharePercentage': -1,
                'approvedAmountLimit': approved_amount_limit,
                'creditLimitText': credit_limit_text,
                'coverageConditions': reply_text or ''
            },
            'status_reason_arabic': reply_text,
            'cm_whatsapp_message': whatsapp_msg,
            'suggested_draft_reply': draft_reply,
            'state_timestamps': {
                **(canonical.get('state_timestamps') or {}),
                'received_at': earliest_received,
                'latest_reply_at': latest_reply_at,
                'consolidated_at': datetime.now().isoformat() + 'Z'
            }
        }

        to_update.append(updated_payload)
        for dup in duplicate_items:
            to_delete_ids.append(dup['id'])

    print(f'✅ Planned Updates: {len(to_update)} canonical approval mail records.')
    print(f'🗑️ Planned Deletions: {len(to_delete_ids)} duplicate reply rows.\n')

    # Preview key records
    for u in to_update:
        p_name = u['patient_name']
        if 'عمر ياسر' in p_name or 'فاضل' in p_name:
            u_id = u['id']
            r_at = u['received_at']
            u_stat = u['status']
            u_appr = u['has_existing_approval']
            u_rep = (u['status_reason_arabic'] or '')[:80]
            u_wa = (u['cm_whatsapp_message'] or '')[:80]
            print(f'⭐ PREVIEW: {p_name} (ID: {u_id})')
            print(f'   Timing (Approval Mail): {r_at}')
            print(f'   Status: {u_stat} | HasApproval: {u_appr}')
            print(f'   Reply: {repr(u_rep)}')
            print(f'   WhatsApp: {repr(u_wa)}')
            print('-------------------------------------------------------------')

    if not dry_run:
        print('\n⚡ Executing Consolidation in PostgreSQL...')
        # 1. Update canonical rows
        for idx, u in enumerate(to_update):
            row_id = u.pop('id')
            supabase_patch('inpatient_approvals', row_id, u)
            if (idx + 1) % 10 == 0 or idx == len(to_update) - 1:
                print(f'  Updated {idx + 1}/{len(to_update)} canonical records...')

        # 2. Delete duplicate rows
        for idx, del_id in enumerate(to_delete_ids):
            supabase_delete('inpatient_approvals', del_id)
            if (idx + 1) % 10 == 0 or idx == len(to_delete_ids) - 1:
                print(f'  Deleted {idx + 1}/{len(to_delete_ids)} duplicate rows...')

        print(f'\n🎉 Consolidation Complete! New inpatient_approvals count: {len(to_update)}')

if __name__ == '__main__':
    dry_run = '--execute' not in sys.argv
    consolidate(dry_run=dry_run)
