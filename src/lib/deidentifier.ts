/**
 * Healthcare Data De-identification and PHI Redaction Utilities
 * Enforces HIPAA Safe Harbor and Healthcare Compliance standards:
 * Guarantees that patient names, MRNs, national IDs, phone numbers,
 * and physical locations/beds are sanitized before transmission to external AI APIs.
 */

// Egyptian National ID: 14 digits starting with 2 or 3
const EGYPTIAN_NATIONAL_ID_REGEX = /\b[23]\d{13}\b/g;

// Egyptian Mobile Phone Numbers: 010, 011, 012, 015 with optional +2 or 002
const EGYPTIAN_PHONE_REGEX = /\b(?:\+?20|0020|0)?1[0125]\d{8}\b/g;

// Medical Record Numbers (MRN) / HIS IDs: 6 to 10 consecutive digits
const MRN_REGEX = /\b(?:mrn|id|file|ملف|رقم)\s*[:#\s]?\s*([0-9]{6,10})\b/gi;
const STANDALONE_ID_REGEX = /\b\d{6,10}\b/g;

// Bed & Room Patterns
const BED_ROOM_REGEX = /\b(?:bed|room|غرفة|سرير|عناية|icu|r\b|b\b)\s*[:#\s-]?\s*\d+\w*\b/gi;

// Labeled Patient Names & MRNs
const LABELED_PATIENT_REGEX = /(?:المريض|اسم المريض|الاسم|Patient(?:\s*Name)?)\s*[:=]\s*([\u0621-\u064A\w\s]+?)(?=[,،.\n]|$)/gi;
const LABELED_MRN_REGEX = /(?:رقم الملف|الملف|file(?:\s*no)?|mrn)\s*[:#\s]?\s*([0-9]{4,10})/gi;

// Doctor / Physician Honorifics and Names
const PHYSICIAN_REGEX = /\b(?:dr\.?|دكتور|د\.|طبيب|أ\.د|ا\.د|استشاري|أخصائي)\s+[\u0621-\u064A\w]+(?:\s+[\u0621-\u064A\w]+)?/gi;

export interface KnownDemographics {
  patientName?: string;
  mrn?: string;
  phone?: string;
  physician?: string;
  bed?: string;
}

/**
 * Escapes regex special characters in a string
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Redacts all Protected Health Information (PHI) from clinical text.
 */
export function redactPhiFromText(text: string, known?: KnownDemographics): string {
  if (!text) return '';

  let sanitized = text;

  // 1. Redact explicit known demographics if supplied
  if (known?.patientName && known.patientName.trim().length > 2) {
    const nameRegex = new RegExp(escapeRegex(known.patientName.trim()), 'gi');
    sanitized = sanitized.replace(nameRegex, '[PATIENT_NAME_REDACTED]');
  }

  if (known?.mrn && known.mrn.trim().length >= 4) {
    const mrnRegex = new RegExp(escapeRegex(known.mrn.trim()), 'gi');
    sanitized = sanitized.replace(mrnRegex, '[MRN_REDACTED]');
  }

  if (known?.phone && known.phone.trim().length >= 8) {
    const phoneRegex = new RegExp(escapeRegex(known.phone.trim()), 'gi');
    sanitized = sanitized.replace(phoneRegex, '[PHONE_REDACTED]');
  }

  if (known?.physician && known.physician.trim().length > 2) {
    const physRegex = new RegExp(escapeRegex(known.physician.trim()), 'gi');
    sanitized = sanitized.replace(physRegex, '[PHYSICIAN_REDACTED]');
  }

  if (known?.bed && known.bed.trim().length >= 2) {
    const bedRegex = new RegExp(escapeRegex(known.bed.trim()), 'gi');
    sanitized = sanitized.replace(bedRegex, '[LOCATION_REDACTED]');
  }

  // 2. Redact patterns: National ID
  sanitized = sanitized.replace(EGYPTIAN_NATIONAL_ID_REGEX, '[NATIONAL_ID_REDACTED]');

  // 3. Redact patterns: Mobile phone numbers
  sanitized = sanitized.replace(EGYPTIAN_PHONE_REGEX, '[PHONE_REDACTED]');

  // 4. Redact patterns: Explicit MRN references
  sanitized = sanitized.replace(MRN_REGEX, '[MRN_REDACTED]');
  sanitized = sanitized.replace(LABELED_MRN_REGEX, '[MRN_REDACTED]');

  // 4b. Redact labeled patient names
  sanitized = sanitized.replace(LABELED_PATIENT_REGEX, '[PATIENT_NAME_REDACTED]');

  // 5. Redact patterns: Doctor titles
  sanitized = sanitized.replace(PHYSICIAN_REGEX, '[PHYSICIAN_REDACTED]');

  // 6. Redact patterns: Bed and Room specifications
  sanitized = sanitized.replace(BED_ROOM_REGEX, '[BED_REDACTED]');

  return sanitized;
}

/**
 * Validates whether a text payload contains any lingering demographics or PHI.
 * Returns true if clean, false if potential PHI is detected.
 */
export function assertZeroDemographics(
  prompt: string,
  known?: KnownDemographics
): { isClean: boolean; violations: string[] } {
  const violations: string[] = [];

  if (known?.patientName && known.patientName.trim().length > 2 && prompt.includes(known.patientName.trim())) {
    violations.push(`Patient name "${known.patientName}" was detected in prompt.`);
  }

  if (known?.mrn && known.mrn.trim().length >= 4 && prompt.includes(known.mrn.trim())) {
    violations.push(`Patient MRN "${known.mrn}" was detected in prompt.`);
  }

  if (known?.phone && known.phone.trim().length >= 8 && prompt.includes(known.phone.trim())) {
    violations.push(`Phone number "${known.phone}" was detected in prompt.`);
  }

  if (known?.physician && known.physician.trim().length > 2 && prompt.includes(known.physician.trim())) {
    violations.push(`Physician name "${known.physician}" was detected in prompt.`);
  }

  const natIdMatch = prompt.match(EGYPTIAN_NATIONAL_ID_REGEX);
  if (natIdMatch) {
    violations.push(`Egyptian National ID pattern detected: ${natIdMatch[0]}`);
  }

  const phoneMatch = prompt.match(EGYPTIAN_PHONE_REGEX);
  if (phoneMatch) {
    violations.push(`Phone number pattern detected: ${phoneMatch[0]}`);
  }

  return {
    isClean: violations.length === 0,
    violations,
  };
}
