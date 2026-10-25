"""
Text normalization, multilingual cleaning, and number parsing utilities.
Specifically optimized for Egyptian healthcare, Arabic/English bilingual pricelists,
and OCR/PDF/Excel artifact sanitization.

Mirrors src/lib/arabic-normalizer.ts for 1:1 cross-language matching consistency.
"""

import re
import unicodedata
from typing import Optional, Tuple, Any, List

# Pre-compiled Regex patterns
ARABIC_CHAR_PATTERN = re.compile(r"[\u0600-\u06FF]")
ARABIC_RUN_PATTERN = re.compile(r"[\u0600-\u06FF][\u0600-\u06FF\s,\u060C\-+/()]*")
DIACRITICS_TATWEEL_PATTERN = re.compile(r"[\u064B-\u065F\u0670\u0640]")
WHITESPACE_PATTERN = re.compile(r"\s+")
HYPHENATED_LINEBREAK_PATTERN = re.compile(r"([A-Za-z]{2,})-\s+([a-z]{2,})")
SENDOUT_ASTERISK_PATTERN = re.compile(r"^\*+\s*(.*)$")

# Persian/Urdu lookalike characters to Standard Arabic & Arabic-Indic digits to ASCII
CHAR_TRANSLATION_MAP = str.maketrans({
    "ی": "ي",
    "ى": "ي",
    "ك": "ك",
    "ک": "ك",
    "ھ": "ه",
    "ۀ": "ه",
    "ے": "ي",
    **{chr(0x0660 + i): str(i) for i in range(10)},  # Arabic-Indic digits ٠-٩
    **{chr(0x06F0 + i): str(i) for i in range(10)},  # Eastern Arabic-Indic digits ۰-۹
})


def is_reversed_arabic(text: str) -> bool:
    """
    Detects whether an Arabic string was extracted in visual LTR order (reversed characters/words).
    Analyzes Arabic word starts (prefixes) vs word endings (suffixes).
    """
    if not text:
        return False
    words = re.findall(r"[\u0600-\u06FF]+", text)
    if not words:
        return False

    reversed_score = 0
    logical_score = 0

    for w in words:
        # Isolated hamza 'ء' at start of word -> impossible in standard Arabic, indicates reversed (e.g. 'ءارجا' -> 'اجراء')
        if w.startswith("ء"):
            reversed_score += 5
        if w.endswith("ء"):
            logical_score += 2

        # Taa marbuta or Alef Maqsura at start of word -> impossible in Arabic, strongly indicates reversed
        if w.startswith(("ة", "ى")):
            reversed_score += 4
        if w.endswith(("ة", "ى")):
            logical_score += 2

        # 'ال' at start of word -> logical
        if w.startswith(("ال", "وال", "فال", "بال", "كال", "لل")):
            logical_score += 3
        # 'لا' at end of word -> reversed 'ال'
        if w.endswith(("لا", "لاو", "لاف", "لاب", "لاك")):
            reversed_score += 3

        # 'است' at start -> logical
        if w.startswith(("است", "واست")):
            logical_score += 4
        # 'تسا' at end -> reversed 'است'
        if w.endswith(("تسا", "تساو")):
            reversed_score += 4

    return reversed_score > logical_score


def reverse_visual_bidi(text: str) -> str:
    """
    Directly reverses a visual-order Arabic line back to logical order.
    Preserves embedded Latin characters and digits intact while reversing Arabic word flow.
    """
    if not text:
        return ""
    tokens = re.findall(r"[a-zA-Z0-9_.-]+|[\u0600-\u06FF]+|\s+|[^\s\w]", text)
    tokens.reverse()
    result = []
    for tok in tokens:
        if re.search(r"[\u0600-\u06FF]", tok):
            result.append(tok[::-1])
        else:
            result.append(tok)
    return "".join(result).strip()


def fix_bidi_arabic(text: str, force: bool = False) -> str:
    """
    Detects and fixes visual-order (reversed) Arabic text per cell or line.
    If force=True, reverses unconditionally (useful when entire table is verified reversed).
    """
    if not text:
        return ""
    if force or is_reversed_arabic(text):
        return reverse_visual_bidi(text)
    return text.strip()


def normalize_nfkc(text: str) -> str:
    """
    Applies Unicode NFKC normalization to collapse Arabic Presentation Forms
    (U+FB50-FDFF, U+FE70-FEFF) into canonical Unicode codepoints.
    """
    if not text:
        return ""
    return unicodedata.normalize("NFKC", text)


def clean_text(value: Any) -> str:
    """Normalizes string encoding, applies NFKC, strips diacritics/tatweel, and collapses whitespace."""
    if value is None:
        return ""
    text = normalize_nfkc(str(value)).replace("\xa0", " ").translate(CHAR_TRANSLATION_MAP)
    text = DIACRITICS_TATWEEL_PATTERN.sub("", text)
    return WHITESPACE_PATTERN.sub(" ", text).strip()


def normalize_arabic(text: str) -> str:
    """
    Standardizes Arabic characters across Alef, Yaa, Haa/Taa Marbuta, Hamzas, and diacritics.
    Mirrors normalizeArabic() in src/lib/arabic-normalizer.ts.
    """
    if not text:
        return ""
    t = clean_text(text).lower()
    t = re.sub(r"[أإآا]", "ا", t)
    t = re.sub(r"[ىيی]", "ي", t)
    t = re.sub(r"[كک]", "ك", t)
    t = re.sub(r"[ةهھۀ]", "ه", t)
    t = re.sub(r"[ئؤ]", "ء", t)
    t = re.sub(r"[^a-zA-Z0-9\u0621-\u064A\s]", " ", t)
    return WHITESPACE_PATTERN.sub(" ", t).strip()


def normalize_text(text: str) -> str:
    """
    Normalizes English & Arabic medical text:
    - Merges dotted abbreviations ('E.E.G.' -> 'eeg')
    - Strips billing suffixes ('- investigation', 'procedure', etc.)
    - Mirrors normalizeText() in src/lib/arabic-normalizer.ts.
    """
    if not text:
        return ""
    t = text.lower()
    t = re.sub(r"\b([a-z])\s*\.\s*", r"\1", t)
    t = re.sub(r"\s*[-/,]\s*(investigations?|procedures?|tests?|testing|panels?|profiles?|screens?|screening|analysis|packages?|scans?|counts?)\b", "", t)
    t = re.sub(r"\s+\b(investigations?|procedures?|tests?|testing|panels?|profiles?|screens?|screening|analysis|packages?|scans?|counts?)$", "", t)
    return normalize_arabic(t)


def parse_numeric_price(value: Any) -> Optional[float]:
    """Extracts a valid positive numeric float from int, float, or formatted strings."""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value) if value > 0 else None
    if isinstance(value, str):
        cleaned = clean_text(value).replace(",", "").replace("EGP", "").replace("LE", "").replace("L.E", "").replace("ج.م", "").strip()
        match = re.search(r"(\d+(?:\.\d+)?)", cleaned)
        if match:
            try:
                num = float(match.group(1))
                return num if num > 0 else None
            except ValueError:
                return None
    return None


def format_price_string(price: float) -> str:
    """Formats numeric price into clean integer string if whole, else decimal."""
    return str(int(price)) if price.is_integer() else f"{price:.2f}".rstrip("0").rstrip(".")


def split_mixed_bilingual(text: str) -> Tuple[str, str]:
    """Splits a single cell containing mixed Arabic and English text into separate components."""
    t = clean_text(text)
    arabic_parts = [m.group(0) for m in ARABIC_RUN_PATTERN.finditer(t)]
    arabic_text = clean_text(" ".join(arabic_parts))
    english_text = clean_text(ARABIC_RUN_PATTERN.sub(" ", t))

    # Balance parentheses in English text
    english_text = re.sub(r"\(\s*\)", "", english_text).strip()
    if english_text.count("(") > english_text.count(")"):
        english_text += ")"
    elif english_text.count(")") > english_text.count("("):
        english_text = english_text.replace(")", "", english_text.count(")") - english_text.count("("))

    return english_text, arabic_text


def sanitize_procedure_names(en_raw: str, ar_raw: str, force_bidi: bool = False) -> Tuple[str, str, bool]:
    """
    Sanitizes English and Arabic procedure names:
    - Resolves cross-column contamination (Arabic in English column or vice-versa)
    - Fixes visual reversed Arabic if present (or forced on Arabic text)
    - Strips send-out test asterisks (*) and sets outsourced flag
    - Resolves broken PDF/OCR hyphens ('un- der' -> 'under')
    """
    # English column is Latin LTR and should not have forced bidi reversal
    en_fixed = fix_bidi_arabic(str(en_raw or ""), force=False)
    # Arabic column can be forced if entire table column was laid out in visual LTR
    ar_fixed = fix_bidi_arabic(str(ar_raw or ""), force=force_bidi)

    en = clean_text(en_fixed)
    ar = clean_text(ar_fixed)

    # Detect cross-column swapped values
    if en and ARABIC_CHAR_PATTERN.search(en) and not ar:
        en, ar = "", en
    elif ar and not ARABIC_CHAR_PATTERN.search(ar) and not en:
        en, ar = ar, ""

    # Check for outsourced send-out test marker (*)
    outsourced = False
    asterisk_match = SENDOUT_ASTERISK_PATTERN.match(en)
    if asterisk_match:
        en = asterisk_match.group(1)
        outsourced = True

    # Fix OCR / PDF hyphenation: "un- der" -> "under"
    en = HYPHENATED_LINEBREAK_PATTERN.sub(r"\1\2", en)
    en = re.sub(r"\s+([,.)])", r"\1", en)

    return en, ar, outsourced
