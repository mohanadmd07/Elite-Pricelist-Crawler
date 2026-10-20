"""
Text normalization, multilingual cleaning, and number parsing utilities.
Specifically optimized for Egyptian healthcare, Arabic/English bilingual pricelists,
and OCR/Excel artifact sanitization.
"""

import re
from typing import Optional, Tuple, Any

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
    "ک": "ك",
    "ھ": "ه",
    "ۀ": "ه",
    "ے": "ي",
    **{chr(0x0660 + i): str(i) for i in range(10)},  # Arabic-Indic digits ٠-٩
    **{chr(0x06F0 + i): str(i) for i in range(10)},  # Eastern Arabic-Indic digits ۰-۹
})


def clean_text(value: Any) -> str:
    """Normalizes string encoding, strips diacritics/tatweel, and collapses whitespace."""
    if value is None:
        return ""
    text = str(value).replace("\xa0", " ").translate(CHAR_TRANSLATION_MAP)
    text = DIACRITICS_TATWEEL_PATTERN.sub("", text)
    return WHITESPACE_PATTERN.sub(" ", text).strip()


def parse_numeric_price(value: Any) -> Optional[float]:
    """Extracts a valid positive numeric float from int, float, or formatted strings."""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value) if value > 0 else None
    if isinstance(value, str):
        cleaned = clean_text(value).replace(",", "").replace("EGP", "").replace("LE", "").replace("L.E", "").strip()
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


def sanitize_procedure_names(en_raw: str, ar_raw: str) -> Tuple[str, str, bool]:
    """
    Sanitizes English and Arabic procedure names:
    - Resolves cross-column contamination (Arabic in English column or vice-versa)
    - Strips send-out test asterisks (*) and sets outsourced flag
    - Resolves broken PDF/OCR hyphens ('un- der' -> 'under')
    """
    en = clean_text(en_raw)
    ar = clean_text(ar_raw)

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
