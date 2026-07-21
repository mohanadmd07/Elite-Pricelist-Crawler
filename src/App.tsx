/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { GoogleGenAI, Type } from "@google/genai";
import { FileText, Search, Loader2, CheckCircle2, AlertCircle, X, Database, Hospital, DollarSign, LogOut, LogIn, User as UserIcon, Building2, Percent, Calendar, Copy, Check, Mail } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from './lib/utils';
import { auth, loginWithGoogle, logout, saveSearch, db, handleFirestoreError, OperationType } from './firebase';
import { onAuthStateChanged, User } from 'firebase/auth';
import { collection, query, where, orderBy, limit, onSnapshot, Timestamp } from 'firebase/firestore';
import * as XLSX from 'xlsx';

// Initialize Gemini
const ai = new GoogleGenAI({ 
  apiKey: process.env.GEMINI_API_KEY || import.meta.env.VITE_GEMINI_API_KEY || '' 
});

interface ProcedureResult {
  nameArabic: string;
  nameEnglish: string;
  price: string;
  sectionName: string;
  sourceFile: string;
  requestedProcedureName?: string;
}

interface CompanyInfo {
  name: string;
  priceListYear: string;
  discount: number;
  responsiblePerson?: string;
}

const MANUAL_REPS: Record<string, string> = {
  "المصرية الاماراتية": "ديانا",
  "عز للحديد والصلب": "محمد ابو الوفا",
  "حديد عز": "محمد ابو الوفا",
  "تكنولوجيا الاخشاب": "نادين",
  "صاان مصر": "محمد ابو الوفا",
  "صان مصر": "محمد ابو الوفا",
  "مصر للصيانة (صان مصر) EMC": "محمد ابو الوفا",
  "ميدرايت": "نادين",
  "Med Right": "نادين",
  "سوميد": "محمد ابو الوفا",
  "Sumed": "محمد ابو الوفا",
  "نيكست كير": "أحمد حمزة",
  "Next Care نكست كير": "أحمد حمزة",
  "بترومنت": "زياد",
  "Petromaint": "زياد",
  "الحمراويل": "نادين",
  "شركة الحمرا اويل": "نادين",
  "نقابة المهندسين": "ديانا",
  "نقابه المهندسين": "ديانا",
  "وزراة العدل": "ديانا",
  "وزاره العدل": "ديانا",
  "منصور جروب": "محمد ابو الوفا",
  "Mansour Group مجموعة منصور": "محمد ابو الوفا",
  "يونايد": "محمد جابر",
  "يونايتد": "محمد جابر"
};

const normalizeArabicForSales = (str: string) => {
  if (!str) return '';
  return str
    .toLowerCase()
    .replace(/[أإآا]/g, 'ا')
    .replace(/[ىي]/g, 'ي')
    .replace(/[ةه]/g, 'ه')
    .replace(/[ئؤ]/g, 'ء')
    .replace(/ة/g, 'ه')
    .replace(/[^a-z0-9\u0621-\u064A]/g, '')
    .trim();
};

const getBaseNameForSales = (str: string) => {
  if (!str) return '';
  let name = str.toLowerCase();
  
  name = name.replace(/\bethydco\b/gi, 'ايثدكو');
  name = name.replace(/\beprom\b/gi, 'ايبروم');
  name = name.replace(/\bamoc\b/gi, 'اموك');
  name = name.replace(/\baxa\b/gi, 'اكسا');
  name = name.replace(/\bwebco\b/gi, 'ويبكو');
  name = name.replace(/\bwepco\b/gi, 'ويبكو');
  name = name.replace(/\bel ahly\b/gi, 'الاهلي');
  name = name.replace(/\bnext care\b/gi, 'نكست كير');
  
  const wordsToRemove = [
    'شركه', 'شركة', 'هيئة', 'هيئه', 'نقابه', 'نقابة', 'نادى', 'نادي', 'جمعية', 'جمعيه',
    'بترول', 'للبترول', 'الاطباء', 'اطباء', 'المهندسين', 'مهندسين', 'الزراعيه', 'الزراعية',
    'الماسية', 'الماسيه', 'الخدمات', 'الطبية', 'الطبيه'
  ];
  
  for (const word of wordsToRemove) {
    name = name.replace(new RegExp(`\\b${word}\\b`, 'g'), '');
    name = name.replace(new RegExp(`${word}`, 'g'), '');
  }
  
  return normalizeArabicForSales(name);
};

const normalizeText = (str: string) => {
  if (!str) return '';
  let normalized = str.toLowerCase();
  
  // Replace single letters followed by dots (with optional spaces) to merge abbreviations like "E.E.G." or "E. C. G." -> "eeg" / "ecg"
  normalized = normalized.replace(/\b([a-z])\s*\.\s*/g, '$1');

  // Strip common suffixes/descriptions often appended to procedures in lists/searches (e.g., "- Investigation", " - Procedure", etc.)
  normalized = normalized
    .replace(/\s*[-/,]\s*(investigations?|procedures?|tests?|testing|panels?|profiles?|screens?|screening|analysis|packages?|scans?|counts?)\b/g, '')
    .replace(/\s+\b(investigations?|procedures?|tests?|testing|panels?|profiles?|screens?|screening|analysis|packages?|scans?|counts?)$/g, '');

  return normalized
    .replace(/[أإآا]/g, 'ا')
    .replace(/[ىي]/g, 'ي')
    .replace(/[ةه]/g, 'ه')
    .replace(/\./g, '') // strip any other remaining dots
    .replace(/[^a-zA-Z0-9\u0621-\u064A\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
};

const searchLocalPricelist = (cashList: ProcedureResult[], requestedProcedures: { name: string; arabic?: string; }[]) => {
  const finalResults: ProcedureResult[] = [];

  for (const proc of requestedProcedures) {
    const qEng = normalizeText(proc.name);
    const qAra = proc.arabic ? normalizeText(proc.arabic) : '';

    if (!qEng && !qAra) continue;

    const exactMatches: ProcedureResult[] = [];
    const partialMatches: ProcedureResult[] = [];

    for (const item of cashList) {
      const itemEng = normalizeText(item.nameEnglish);
      const itemAra = normalizeText(item.nameArabic);

      const isExactEng = qEng && itemEng === qEng;
      const isExactAra = qAra && itemAra === qAra;

      if (isExactEng || isExactAra) {
        exactMatches.push({
          ...item,
          requestedProcedureName: proc.name
        });
        continue;
      }

      const isSubEng = qEng && itemEng.includes(qEng);
      const isSubAra = qAra && itemAra.includes(qAra);

      if (isSubEng || isSubAra) {
        partialMatches.push({
          ...item,
          requestedProcedureName: proc.name
        });
      }
    }

    if (exactMatches.length > 0) {
      finalResults.push(...exactMatches);
    } else if (partialMatches.length > 0) {
      const sortedPartials = partialMatches.sort((a, b) => {
        const aEng = normalizeText(a.nameEnglish);
        const bEng = normalizeText(b.nameEnglish);
        const aStarts = qEng && aEng.startsWith(qEng);
        const bStarts = qEng && bEng.startsWith(qEng);
        if (aStarts && !bStarts) return -1;
        if (!aStarts && bStarts) return 1;
        return a.nameEnglish.length - b.nameEnglish.length;
      });
      finalResults.push(...sortedPartials.slice(0, 5));
    }
  }

  return finalResults;
};

export default function App() {
  const [procedure, setProcedure] = useState('');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<ProcedureResult[]>([]);
  const [recentSearches, setRecentSearches] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [fileStatus, setFileStatus] = useState<Record<string, boolean>>({});
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [copiedCC, setCopiedCC] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  // Preloaded cash pricelists arrays
  const [cashData2023, setCashData2023] = useState<ProcedureResult[] | null>(null);
  const [cashData2024, setCashData2024] = useState<ProcedureResult[] | null>(null);
  const [cashData2025, setCashData2025] = useState<ProcedureResult[] | null>(null);

  // Predictive procedures states
  const [standardProcedures, setStandardProcedures] = useState<{ english: string; arabic: string; }[]>([]);
  const [selectedProcedures, setSelectedProcedures] = useState<{ id: string; name: string; arabic?: string; isCustom?: boolean; }[]>([]);
  const [procedureInput, setProcedureInput] = useState('');
  const [isProcedureDropdownOpen, setIsProcedureDropdownOpen] = useState(false);
  const [aiSearchEnabled, setAiSearchEnabled] = useState(true);
  const [searchStatus, setSearchStatus] = useState<{
    foundCount: number;
    pendingCount: number;
    isExtendingToAI: boolean;
    stage: 'idle' | 'local' | 'ai' | 'done';
  }>({
    foundCount: 0,
    pendingCount: 0,
    isExtendingToAI: false,
    stage: 'idle'
  });

  // Company selection state
  const [companies, setCompanies] = useState<CompanyInfo[]>([]);
  const [selectedCompany, setSelectedCompany] = useState<CompanyInfo | null>(null);
  const [companySearch, setCompanySearch] = useState('');
  const [isCompanyDropdownOpen, setIsCompanyDropdownOpen] = useState(false);

  // Pre-defined list of price list files
  const priceLists = [
    { name: 'Elite Hospital 2025', path: '/2025.pdf' },
    { name: 'Elite Hospital 2024', path: '/2024.pdf' },
    { name: 'Elite Hospital 2023', path: '/2023.pdf' }
  ];

  // Listen for auth state changes and fetch history
  useEffect(() => {
    const unsubscribeAuth = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setAuthLoading(false);
    });

    return () => unsubscribeAuth();
  }, []);

  // Real-time listener for search history
  useEffect(() => {
    if (!user) {
      setRecentSearches([]);
      return;
    }

    const searchesRef = collection(db, 'users', user.uid, 'searches');
    const q = query(searchesRef, orderBy('timestamp', 'desc'), limit(5));

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const searches = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      setRecentSearches(searches);
    }, (error) => {
      // Use silent handling for history loading errors to not interrupt the main experience
      console.error("History load error:", error);
    });

    return () => unsubscribe();
  }, [user]);

  // Load companies from Excel
  useEffect(() => {
    const loadCompanies = async () => {
      try {
        // 1. Load Sales 2027 mapping
        let salesReps: { name: string; rep: string }[] = [];
        try {
          const salesRes = await fetch('/Sales%202027.xlsx');
          if (salesRes.ok) {
            const salesBuf = await salesRes.arrayBuffer();
            const salesWb = XLSX.read(salesBuf);
            const salesWs = salesWb.Sheets[salesWb.SheetNames[0]];
            const salesJson = XLSX.utils.sheet_to_json(salesWs, { header: 1 }) as any[][];
            
            if (salesJson && salesJson.length > 1) {
              const repsRow = salesJson[1] || []; // Row 1 has representatives
              for (let r = 2; r < salesJson.length; r++) {
                const row = salesJson[r];
                if (!row) continue;
                for (let c = 0; c < repsRow.length; c++) {
                  const rep = repsRow[c];
                  const comp = row[c];
                  if (rep && comp && typeof rep === 'string' && typeof comp === 'string') {
                    const trimmedRep = rep.trim();
                    const trimmedComp = comp.trim();
                    if (trimmedComp && trimmedRep) {
                      salesReps.push({ name: trimmedComp, rep: trimmedRep });
                    }
                  }
                }
              }
            }
          }
        } catch (salesErr) {
          console.error("Error loading Sales 2027.xlsx:", salesErr);
        }

        // 2. Load Consumables
        const response = await fetch('/Consumables.xlsx');
        if (!response.ok) throw new Error("File not found");
        const arrayBuffer = await response.arrayBuffer();
        const workbook = XLSX.read(arrayBuffer);
        const worksheet = workbook.Sheets[workbook.SheetNames[0]];
        const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 }) as any[][];

        if (!jsonData || jsonData.length < 2) {
          console.warn("Excel file is empty or has no data rows");
          return;
        }

        // Column A: Company names starting from Row 2 (index 1)
        // Column B: Price list year
        // Column C: Discount percentage
        const loadedCompanies: CompanyInfo[] = jsonData
          .slice(1) // Skip header row
          .filter(row => row && row[0]) // Only rows with company names
          .map(row => {
            let discountValue = 0;
            const rawDiscount = row[2];
            
            if (typeof rawDiscount === 'number') {
              // Handle Excel decimal percentages (e.g., 0.2 means 20%)
              discountValue = rawDiscount < 1 && rawDiscount > 0 ? rawDiscount * 100 : rawDiscount;
            } else {
              // Handle strings like "20%" or "15"
              discountValue = parseFloat(String(rawDiscount || '0').replace('%', '')) || 0;
            }

            const compName = String(row[0]).trim();
            
            // Resolve responsible person using manual mapping and sales mapping
            let responsiblePerson = MANUAL_REPS[compName];
            if (!responsiblePerson && salesReps.length > 0) {
              const exactMatch = salesReps.find(s => s.name.toLowerCase() === compName.toLowerCase());
              if (exactMatch) {
                responsiblePerson = exactMatch.rep;
              } else {
                const compBase = getBaseNameForSales(compName);
                if (compBase.length > 0) {
                  const normMatch = salesReps.find(s => getBaseNameForSales(s.name) === compBase);
                  if (normMatch) {
                    responsiblePerson = normMatch.rep;
                  } else if (compBase.length >= 3) {
                    const subMatch = salesReps.find(s => {
                      const sNorm = getBaseNameForSales(s.name);
                      if (sNorm.length < 3) return false;
                      return sNorm.includes(compBase) || compBase.includes(sNorm);
                    });
                    if (subMatch) {
                      responsiblePerson = subMatch.rep;
                    }
                  }
                }
              }
            }

            let priceListYearVal = String(row[1] || '').trim();
            const normCompName = compName.replace(/[أإآا]/g, 'ا').replace(/[ىي]/g, 'ي').replace(/[ةه]/g, 'ه').replace(/\s+/g, ' ').trim().toLowerCase();
            if (normCompName.includes('لايف هيلث كير') || normCompName.includes('لايف هيلثكير') || normCompName.includes('life health') || normCompName.includes('lifehealth')) {
              priceListYearVal = '2024';
            }

            return {
              name: compName,
              priceListYear: priceListYearVal,
              discount: Math.round(discountValue),
              responsiblePerson
            };
          })
          .filter(c => c.name.length > 0);

        console.log("Found companies in Excel with responsible persons:", loadedCompanies.slice(0, 5));
        setCompanies(loadedCompanies);
      } catch (err) {
        console.error("Error loading companies:", err);
      }
    };
    loadCompanies();
  }, []);

  // Load standard procedures list for autocomplete
  useEffect(() => {
    const loadProcedures = async () => {
      try {
        const response = await fetch('/procedures.json');
        if (response.ok) {
          const data = await response.json();
          setStandardProcedures(data);
        }
      } catch (err) {
        console.error("Failed to load standard procedures list:", err);
      }
    };
    loadProcedures();
  }, []);

  // Filtered companies based on search with Arabic normalization
  const normalizeArabic = (str: string) => {
    return str
      .replace(/[أإآا]/g, 'ا') // Normalize Alif
      .replace(/[ىي]/g, 'ي')    // Normalize Yaa
      .replace(/[ةه]/g, 'ه')    // Normalize Haa/Taa Marbuta
      .trim()
      .toLowerCase();
  };

  const filteredCompanies = companies.filter(c => {
    const search = normalizeArabic(companySearch);
    if (!search) return false;
    return normalizeArabic(c.name).includes(search);
  });

  // Filtered procedures based on search with Arabic/English normalization
  const filteredProcedures = standardProcedures.filter(p => {
    const search = normalizeArabic(procedureInput);
    if (!search) return false;
    return (
      normalizeArabic(p.english).includes(search) ||
      normalizeArabic(p.arabic).includes(search)
    );
  }).slice(0, 50);

  const calculateDiscountedPrice = (priceStr: string, discountPercent: number) => {
    // Remove non-numeric characters except decimals
    // Standardize arabic numerals to western if present
    const cleanPriceStr = priceStr.replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d).toString());
    const numericPart = cleanPriceStr.replace(/[^0-9.]/g, '');
    const price = parseFloat(numericPart);
    if (isNaN(price)) return null;

    // Apply discount percentage (e.g., 20 means 20% off)
    const discountAmount = (price * discountPercent) / 100;
    const finalPrice = price - discountAmount;
    
    // Attempt to preserve the currency if it's there
    const currencyMatch = priceStr.match(/[A-Za-z]+|[\u0600-\u06FF]+/);
    const currency = currencyMatch ? currencyMatch[0] : '';
    
    return {
      original: price,
      discounted: finalPrice,
      currency
    };
  };

  const cleanNamePrefix = (name: string) => {
    if (!name) return '';
    return name.trim().replace(/^\d+\s*[-.)\s]+\s*/, '');
  };

  const getSummaryText = () => {
    const lines: string[] = [];
    
    // Header info matching user request
    const priceListName = selectedCompany?.priceListYear 
      ? `Elite Hospital ${selectedCompany.priceListYear}` 
      : (results.length > 0 ? Array.from(new Set(results.map(r => r.sourceFile))).join(', ') : 'Elite Hospital 2025');
    
    const contractorName = selectedCompany ? selectedCompany.name : 'N/A';
    const discountName = selectedCompany ? `${selectedCompany.discount}%` : 'N/A';

    lines.push(`Price list: ${priceListName}`);
    lines.push(`Contractor: ${contractorName}`);
    if (selectedCompany?.responsiblePerson) {
      lines.push(`المسئول من قسم السيلز: ${selectedCompany.responsiblePerson}`);
    }
    lines.push(`Contractor Discount: ${discountName}`);
    lines.push(''); // Blank line spacing

    // 1. Identify found and not found procedures based on selectedProcedures
    const foundProcs = selectedProcedures.filter(proc => {
      const pNorm = normalizeText(proc.name);
      return results.some(r => {
        const rReqNorm = r.requestedProcedureName ? normalizeText(r.requestedProcedureName) : '';
        if (rReqNorm && rReqNorm === pNorm) return true;
        
        const rEngNorm = normalizeText(r.nameEnglish);
        if (rEngNorm && (rEngNorm.includes(pNorm) || pNorm.includes(rEngNorm))) return true;

        if (proc.arabic) {
          const pAraNorm = normalizeText(proc.arabic);
          const rAraNorm = normalizeText(r.nameArabic);
          if (rAraNorm && (rAraNorm.includes(pAraNorm) || pAraNorm.includes(rAraNorm))) return true;
        }
        return false;
      });
    });

    const notFoundProcs = selectedProcedures.filter(proc => {
      const pNorm = normalizeText(proc.name);
      return !results.some(r => {
        const rReqNorm = r.requestedProcedureName ? normalizeText(r.requestedProcedureName) : '';
        if (rReqNorm && rReqNorm === pNorm) return true;
        
        const rEngNorm = normalizeText(r.nameEnglish);
        if (rEngNorm && (rEngNorm.includes(pNorm) || pNorm.includes(rEngNorm))) return true;

        if (proc.arabic) {
          const pAraNorm = normalizeText(proc.arabic);
          const rAraNorm = normalizeText(r.nameArabic);
          if (rAraNorm && (rAraNorm.includes(pAraNorm) || pAraNorm.includes(rAraNorm))) return true;
        }
        return false;
      });
    });

    // 2. Build found section
    if (foundProcs.length > 0) {
      lines.push("الإجراءات المتواجدة بلائحة أسعار التعاقد:");
      
      let index = 1;
      foundProcs.forEach(proc => {
        const pNorm = normalizeText(proc.name);
        const matches = results.filter(r => {
          const rReqNorm = r.requestedProcedureName ? normalizeText(r.requestedProcedureName) : '';
          if (rReqNorm && rReqNorm === pNorm) return true;
          
          const rEngNorm = normalizeText(r.nameEnglish);
          if (rEngNorm && (rEngNorm.includes(pNorm) || pNorm.includes(rEngNorm))) return true;
 
          if (proc.arabic) {
            const pAraNorm = normalizeText(proc.arabic);
            const rAraNorm = normalizeText(r.nameArabic);
            if (rAraNorm && (rAraNorm.includes(pAraNorm) || pAraNorm.includes(rAraNorm))) return true;
          }
          return false;
        });
 
        matches.forEach(match => {
          const origPrice = match.price.trim();
          let discountedPriceText = '';
          if (selectedCompany) {
            const calculated = calculateDiscountedPrice(match.price, selectedCompany.discount);
            if (calculated) {
              const formattedDiscounted = calculated.discounted.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
              const curr = calculated.currency || 'ج.م';
              discountedPriceText = `${formattedDiscounted} ${curr}`;
            }
          }
 
          // Format details without duplicated index numbers from source
          const cleanArabic = cleanNamePrefix(match.nameArabic);
          const cleanEnglish = cleanNamePrefix(match.nameEnglish);
          lines.push(`${index}- ${cleanArabic} (${cleanEnglish})`);
          lines.push(''); // spacer line
          index++;
        });
      });
    }
 
    // 3. Build not found section
    if (notFoundProcs.length > 0) {
      if (lines.length > 0 && lines[lines.length - 1] !== '') {
        lines.push(''); // separation space
      }
      lines.push("الإجراءات الغير متواجدة بلائحة أسعار التعاقد:");
      notFoundProcs.forEach((proc, idx) => {
        const cleanArabic = proc.arabic ? cleanNamePrefix(proc.arabic) : '';
        const cleanEng = cleanNamePrefix(proc.name);
        const procName = cleanArabic ? `${cleanArabic} (${cleanEng})` : cleanEng;
        lines.push(`${idx + 1}- ${procName}`);
      });
    }
 
    return lines.join('\n').trim();
  };
 
  const handleCopy = () => {
    navigator.clipboard.writeText(getSummaryText());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleCopyCC = () => {
    navigator.clipboard.writeText("DirectInsurance@elitehospital.org; corporate@elitehospital.org");
    setCopiedCC(true);
    setTimeout(() => setCopiedCC(false), 2000);
  };

  // Close dropdown on click outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest('.company-select-container')) {
        setIsCompanyDropdownOpen(false);
      }
      if (!target.closest('.procedure-search-container')) {
        setIsProcedureDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Check which files are available on mount
  useEffect(() => {
    const checkFiles = async () => {
      const status: Record<string, boolean> = {};
      for (const list of priceLists) {
        try {
          const response = await fetch(list.path, { method: 'HEAD' });
          const contentType = response.headers.get('Content-Type');
          // Some servers return 200 with HTML content for missing files (SPA redirect)
          status[list.path] = response.ok && !!contentType?.includes('application/pdf');
        } catch {
          status[list.path] = false;
        }
      }
      setFileStatus(status);
    };
    checkFiles();
  }, []);

  const fetchFileAsBase64 = async (url: string): Promise<string> => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to load ${url}`);
    
    // Check if the response is actually a PDF
    const contentType = response.headers.get('Content-Type');
    if (contentType && !contentType.includes('application/pdf')) {
      throw new Error(`File at ${url} is not a valid PDF (received ${contentType}). This usually happens when the file is missing and the server returns the home page instead.`);
    }

    const blob = await response.blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64String = (reader.result as string).split(',')[1];
        resolve(base64String);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  };

  const addProcedure = (proc: { english: string; arabic: string; }) => {
    if (selectedProcedures.some(p => p.name.toLowerCase() === proc.english.toLowerCase())) {
      setProcedureInput('');
      setIsProcedureDropdownOpen(false);
      return;
    }
    const newProc = {
      id: Math.random().toString(36).substr(2, 9),
      name: proc.english,
      arabic: proc.arabic,
      isCustom: false
    };
    setSelectedProcedures(prev => [...prev, newProc]);
    setProcedureInput('');
    setIsProcedureDropdownOpen(false);
  };

  const addCustomProcedure = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (selectedProcedures.some(p => p.name.toLowerCase() === trimmed.toLowerCase())) {
      setProcedureInput('');
      return;
    }
    const newProc = {
      id: Math.random().toString(36).substr(2, 9),
      name: trimmed,
      isCustom: true
    };
    setSelectedProcedures(prev => [...prev, newProc]);
    setProcedureInput('');
    setIsProcedureDropdownOpen(false);
  };

  const getCashData = async (year: '2023' | '2024' | '2025'): Promise<ProcedureResult[]> => {
    if (year === '2023') {
      if (cashData2023) return cashData2023;
      const response = await fetch('/2023_cash.json');
      if (!response.ok) throw new Error("Could not load 2023 Cash pricelist file.");
      const data = await response.json();
      setCashData2023(data);
      return data;
    } else if (year === '2024') {
      if (cashData2024) return cashData2024;
      const response = await fetch('/2024_cash.json');
      if (!response.ok) throw new Error("Could not load 2024 Cash pricelist file.");
      const data = await response.json();
      setCashData2024(data);
      return data;
    } else {
      if (cashData2025) return cashData2025;
      const response = await fetch('/2025_cash.json');
      if (!response.ok) throw new Error("Could not load 2025 Cash pricelist file.");
      const data = await response.json();
      setCashData2025(data);
      return data;
    }
  };

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedProcedures.length === 0 || !user) return;

    setLoading(true);
    setError(null);
    setResults([]);
    setSearchStatus({
      foundCount: 0,
      pendingCount: selectedProcedures.length,
      isExtendingToAI: false,
      stage: 'local'
    });

    const currentQueryList = [...selectedProcedures];
    const combinedQuery = currentQueryList.map(p => p.name).join(', ');
    setProcedure(combinedQuery);

    try {
      const activeYear = selectedCompany?.priceListYear;
      const has2025 = !activeYear || activeYear === '2025';
      const has2023 = !activeYear || activeYear === '2023';
      const has2024 = !activeYear || activeYear === '2024';

      let localResults: ProcedureResult[] = [];
      let list2025: ProcedureResult[] = [];
      let list2024: ProcedureResult[] = [];
      let list2023: ProcedureResult[] = [];

      if (has2025) {
        try {
          list2025 = await getCashData('2025');
          const res2025 = searchLocalPricelist(list2025, currentQueryList);
          localResults.push(...res2025);
        } catch (err) {
          console.error("Local 2025 extraction failed:", err);
        }
      }

      if (has2024) {
        try {
          list2024 = await getCashData('2024');
          const res2024 = searchLocalPricelist(list2024, currentQueryList);
          localResults.push(...res2024);
        } catch (err) {
          console.error("Local 2024 extraction failed:", err);
        }
      }

      if (has2023) {
        try {
          list2023 = await getCashData('2023');
          const res2023 = searchLocalPricelist(list2023, currentQueryList);
          localResults.push(...res2023);
        } catch (err) {
          console.error("Local 2023 extraction failed:", err);
        }
      }

      // Find procedures that did not yield any local results (unmatched)
      const unmatchedProcedures = currentQueryList.filter(proc => {
        return !localResults.some(r => r.requestedProcedureName === proc.name);
      });

      const foundCount = currentQueryList.length - unmatchedProcedures.length;
      const pendingCount = unmatchedProcedures.length;
      const isExtendingToAI = pendingCount > 0 && aiSearchEnabled;

      setSearchStatus({
        foundCount,
        pendingCount,
        isExtendingToAI,
        stage: isExtendingToAI ? 'ai' : 'done'
      });

      // If extending to AI, wait briefly for beautiful UI animation pacing
      if (isExtendingToAI) {
        await new Promise(resolve => setTimeout(resolve, 600));
      }

      let geminiResults: ProcedureResult[] = [];

      // Determine which price lists we should query via Gemini automatically for unmatched procedures using Excel cache lists
      if (unmatchedProcedures.length > 0 && aiSearchEnabled) {
        const listsToSearch: { year: string; list: ProcedureResult[] }[] = [];
        if (has2025 && list2025.length > 0) listsToSearch.push({ year: '2025', list: list2025 });
        if (has2024 && list2024.length > 0) listsToSearch.push({ year: '2024', list: list2024 });
        if (has2023 && list2023.length > 0) listsToSearch.push({ year: '2023', list: list2023 });

        const candidates: ProcedureResult[] = [];
        const seenCandidateKeys = new Set<string>();

        const getSearchTokens = (text: string) => {
          return text
            .toLowerCase()
            .replace(/[^a-zA-Z0-9\u0621-\u064A\s]/g, ' ')
            .split(/\s+/)
            .map(t => t.trim())
            .filter(t => t.length >= 2 && !['and', 'the', 'for', 'with', 'test', 'blood', 'study', 'urine', 'stool', 'scan', 'profile', 'panel', 'investigation', 'procedure'].includes(t));
        };

        for (const proc of unmatchedProcedures) {
          const engTokens = getSearchTokens(proc.name);
          const araTokens = proc.arabic ? getSearchTokens(proc.arabic) : [];
          const allTokens = [...engTokens, ...araTokens];
          if (allTokens.length === 0) {
            // Fallback to any alphanumeric segment
            allTokens.push(...proc.name.toLowerCase().replace(/[^a-zA-Z0-9\u0621-\u064A\s]/g, ' ').split(/\s+/).map(t => t.trim()).filter(t => t.length >= 1));
          }

          for (const item of listsToSearch) {
            let count = 0;
            for (const row of item.list) {
              const rowEng = row.nameEnglish.toLowerCase();
              const rowAra = row.nameArabic ? row.nameArabic.toLowerCase() : '';
              
              const isValidToken = (token: string) => {
                return rowEng.includes(token) || (rowAra && rowAra.includes(token));
              };

              const hasOverlap = allTokens.some(token => isValidToken(token));
              if (hasOverlap) {
                const key = `${row.nameEnglish.toLowerCase()}|${row.sourceFile.toLowerCase()}|${row.price}`;
                if (!seenCandidateKeys.has(key)) {
                  seenCandidateKeys.add(key);
                  candidates.push(row);
                  count++;
                  if (count > 250) break; // Limit candidates per unmatched procedure name
                }
              }
            }
          }
        }

        if (candidates.length > 0) {
          const proceduresListText = unmatchedProcedures.map((p, idx) => {
            return `${idx + 1}. English: "${p.name}"${p.arabic ? ` / Arabic: "${p.arabic}"` : ''}`;
          }).join('\n');

          const candidatesText = JSON.stringify(candidates.map(c => ({
            nameEnglish: c.nameEnglish,
            nameArabic: c.nameArabic,
            price: c.price,
            sectionName: c.sectionName,
            sourceFile: c.sourceFile
          })), null, 2);

          const response = await ai.models.generateContent({
            model: "gemini-3.5-flash",
            contents: [
              {
                parts: [
                  {
                    text: `You are an expert AI medical assistant. Below is a subset of pricing rows from the hospital excel price lists (excel sheet data):\n\n<ExcelPricelistData>\n${candidatesText}\n</ExcelPricelistData>\n\nCompare and search for matches inside the provided data for the following requested procedures (Note: handle synonyms, spelling variations, abbreviations with/without dots, or partial matches. For example, "EEG" matches "ELECTROENCEPHALOGRAPHY (EEG)" or "Routine EEG", and "ECG" matches "Electrocardiogram (ECG)"): \n${proceduresListText}\n\nSTRICT REQUIREMENT: Only select procedures and rates explicitly present in the <ExcelPricelistData> above. Do not estimate or make up any prices or details.\nFor each matched procedure, map it to the exact English name of the requested procedure this item is a match for (requestedProcedureName).\nReturn a JSON array of matches. If none found, return an empty array []`
                  }
                ]
              }
            ],
            config: {
              responseMimeType: "application/json",
              responseSchema: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    nameArabic: { type: Type.STRING, description: "The name of the procedure in Arabic as text. If there is no Arabic name in the document, return an empty string (\"\")." },
                    nameEnglish: { type: Type.STRING, description: "The name of the procedure in English as text." },
                    price: { type: Type.STRING, description: "The price of the procedure. Extract this number as a string." },
                    sectionName: { type: Type.STRING, description: "The name of the section where the procedure was found" },
                    sourceFile: { type: Type.STRING, description: "The source file name exactly as shown in the candidate row" },
                    requestedProcedureName: { type: Type.STRING, description: "The exact English name from the prompt's requested list of unmatched procedures that this item match belongs to." }
                  },
                  required: ["nameArabic", "nameEnglish", "price", "sectionName", "sourceFile", "requestedProcedureName"]
                }
              }
            }
          });

          geminiResults = JSON.parse(response.text || '[]') as ProcedureResult[];
        }
      }

      // Merge and deduplicate results
      const seenResults = new Set<string>();
      const finalCombinedResults: ProcedureResult[] = [];
      const allResults = [...localResults, ...geminiResults];

      for (const res of allResults) {
        const key = `${res.nameEnglish.toLowerCase()}|${res.sourceFile.toLowerCase()}|${String(res.price).trim()}`;
        if (!seenResults.has(key)) {
          seenResults.add(key);
          finalCombinedResults.push(res);
        }
      }

      setResults(finalCombinedResults);

      if (user) {
        saveSearch(user.uid, combinedQuery, finalCombinedResults.length).catch(err => {
          console.warn("Failed to save search history:", err);
        });
      }

      if (finalCombinedResults.length === 0) {
        setError('No procedures matching your search items were found in the documents.');
      }
    } catch (err: any) {
      console.error('Search error:', err);
      let errorMessage = 'An error occurred while processing the search.';
      
      if (err.message && (err.message.includes('403') || err.message.includes('permission'))) {
        errorMessage = 'Gemini API Permission Denied (403). Please ensure your API key has access to the requested model.';
      } else if (err.message && (err.message.includes('429') || err.message.includes('exhausted'))) {
        errorMessage = 'The AI model is currently busy. Please try again or wait a moment.';
      } else if (err.message) {
        errorMessage = err.message;
      }
      
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  const reset = () => {
    setProcedure('');
    setResults([]);
    setError(null);
    setSelectedCompany(null);
    setCompanySearch('');
    setSelectedProcedures([]);
    setProcedureInput('');
    setCopied(false);
  };

  if (authLoading) {
    return (
      <div className="min-h-screen relative flex items-center justify-center font-sans overflow-hidden">
        {/* Background image overlay */}
        <div 
          className="fixed inset-0 bg-cover bg-center bg-no-repeat z-0 pointer-events-none"
          style={{
            backgroundImage: `url('https://images.unsplash.com/photo-1519494026892-80bbd2d6fd0d?auto=format&fit=crop&q=80&w=2400')`,
            filter: 'brightness(1.0) contrast(1.0) saturate(1.05)'
          }}
        />
        <div className="fixed inset-0 bg-slate-200/40 backdrop-blur-[6px] pointer-events-none z-0" />
        <div className="relative z-10 flex flex-col items-center gap-4 bg-white/40 backdrop-blur-xl border border-white/40 p-10 rounded-3xl shadow-2xl">
          <Loader2 className="animate-spin text-teal-600" size={48} />
          <p className="text-sm font-bold text-teal-900 tracking-wider font-display">Dr. Mohanad El Ma'moun • Presents ...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    const handleLoginClick = async () => {
      try {
        setLoginError(null);
        await loginWithGoogle();
      } catch (err: any) {
        console.error("Login click failed:", err);
        setLoginError(err.message || String(err));
      }
    };

    return (
      <div className="min-h-screen relative flex items-center justify-center p-6 font-sans overflow-hidden">
        {/* Background image overlay */}
        <div 
          className="fixed inset-0 bg-cover bg-center bg-no-repeat z-0 pointer-events-none"
          style={{
            backgroundImage: `url('https://images.unsplash.com/photo-1519494026892-80bbd2d6fd0d?auto=format&fit=crop&q=80&w=2400')`,
            filter: 'brightness(1.0) contrast(1.0) saturate(1.05)'
          }}
        />
        <div className="fixed inset-0 bg-slate-200/45 backdrop-blur-[6px] pointer-events-none z-0" />
        
        <motion.div 
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="max-w-md w-full bg-white/35 backdrop-blur-2xl border border-white/50 rounded-[2.5rem] p-10 shadow-2xl text-center relative z-10 overflow-hidden"
        >
          {/* Subtle decorative medical cross grid inside card */}
          <div className="absolute top-2 right-2 text-white/5 font-bold text-8xl user-select-none font-display pointer-events-none">+</div>
          
          <div className="w-24 h-24 bg-white/30 backdrop-blur-md rounded-3xl flex items-center justify-center shadow-xl border border-white/45 mx-auto mb-8 relative hover:rotate-3 transition-transform overflow-hidden">
            <img src="/elite_logo.png" alt="Elite Logo" className="w-18 h-18 object-contain" referrerPolicy="no-referrer" />
          </div>
          
          <h1 className="text-3xl font-black mb-2 font-display text-gray-950 tracking-tight">Elite Pricelist Explorer</h1>
          <p className="text-xs text-teal-700/80 font-bold uppercase tracking-widest mb-2 font-display">By Dr. Mohanad El Ma'moun</p>
          <p className="text-sm text-gray-700 font-medium mb-8 leading-relaxed max-w-xs mx-auto">Please sign in with your Google workspace or personal account to explore contract price lists.</p>
          
          {loginError && (
            <div className="mb-6 p-4 bg-red-50/90 border border-red-200/85 rounded-2xl text-left text-xs text-red-950 font-medium space-y-2.5 shadow-sm max-h-[300px] overflow-y-auto">
              <div className="flex items-center gap-2 text-red-800 font-extrabold text-[13px]">
                <AlertCircle size={15} />
                <span>Authentication Error</span>
              </div>
              <p className="font-semibold break-words leading-relaxed text-red-900 bg-red-100/50 p-2 rounded-lg font-mono text-[10px]">
                {loginError}
              </p>
              <div className="text-[11px] leading-relaxed pt-2 border-t border-red-100 space-y-1.5 text-red-950 font-medium">
                <p className="font-bold text-red-900">How to solve this on Vercel:</p>
                <p>
                  1. <strong>Authorized Domains:</strong> Since you are running on Vercel, go to your <strong>Firebase Console &gt; Authentication &gt; Settings &gt; Authorized domains</strong> and add your Vercel domain (e.g., <code>*.vercel.app</code>) to the list.
                </p>
                <p>
                  2. <strong>Set Environment Variables:</strong> If you are using your own Firebase project, ensure you added your credentials in your <strong>Vercel Project Dashboard</strong> with the <code>VITE_</code> prefix exactly as defined in <code>.env.example</code>:
                </p>
                <ul className="list-disc list-inside pl-1 text-[10px] font-mono bg-white/40 p-1.5 rounded-lg space-y-0.5 text-gray-750">
                  <li>VITE_FIREBASE_API_KEY</li>
                  <li>VITE_FIREBASE_AUTH_DOMAIN</li>
                  <li>VITE_FIREBASE_PROJECT_ID</li>
                </ul>
              </div>
            </div>
          )}

          <button
            onClick={handleLoginClick}
            className="w-full bg-white/75 hover:bg-white border border-white/80 hover:border-white text-gray-800 px-6 py-4 rounded-2xl font-bold hover:shadow-lg transition-all flex items-center justify-center gap-3.5 shadow-md active:scale-98 cursor-pointer"
          >
            <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" alt="Google" className="w-5 h-5 shrink-0" />
            <span className="text-sm font-semibold tracking-wide">Continue with Google</span>
          </button>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen relative text-gray-900 font-sans antialiased selection:bg-teal-100/60 pb-16">
      {/* Background image overlay */}
      <div 
        className="fixed inset-0 bg-cover bg-center bg-no-repeat z-0 pointer-events-none"
        style={{
          backgroundImage: `url('https://images.unsplash.com/photo-1519494026892-80bbd2d6fd0d?auto=format&fit=crop&q=80&w=2400')`,
          filter: 'brightness(1.02) contrast(0.99) saturate(1.02)'
        }}
      />
      <div className="fixed inset-0 bg-slate-150/45 backdrop-blur-[7px] pointer-events-none z-0" />
      
      {/* Header */}
      <header className="relative z-50 px-6 py-6 md:py-8 max-w-4xl mx-auto">
        <div className="flex flex-col sm:flex-row items-center justify-between gap-6 bg-white/20 backdrop-blur-md border border-white/40 rounded-[2rem] p-5 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 flex items-center justify-center">
              <img src="/elite_logo.png" alt="Elite Logo" className="w-10 h-10 object-contain hover:scale-110 transition-transform" referrerPolicy="no-referrer" />
            </div>
            <div className="text-left">
              <div className="flex items-center gap-1.5 leading-none">
                <h1 className="font-extrabold text-xl font-display text-gray-900 tracking-tight">Elite Pricelist Explorer</h1>
                <span className="text-blue-600 font-extrabold text-lg">$</span>
              </div>
              <p className="text-[10px] text-gray-650 font-black uppercase tracking-widest mt-1">By Dr. Mohanad El Ma'moun</p>
            </div>
          </div>
          
          <div className="flex items-center gap-3 bg-white/40 backdrop-blur-xl border border-white/50 rounded-full pl-2 pr-4 py-1.5 shadow-sm text-sm">
            {user.photoURL ? (
              <img src={user.photoURL} alt={user.displayName || ''} className="w-8 h-8 rounded-full border border-white/80" referrerPolicy="no-referrer" />
            ) : (
              <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-orange-500 to-amber-600 font-bold text-white flex items-center justify-center text-xs shadow-sm">
                {user.email ? user.email.slice(0, 1).toUpperCase() : 'M'}
              </div>
            )}
            <span className="text-xs font-bold text-gray-700 tracking-tight max-w-[170px] truncate">{user.email}</span>
            <div className="h-4 w-px bg-white/40" />
            <button 
              onClick={reset}
              className="p-1 text-gray-500 hover:text-red-500 transition-colors cursor-pointer"
              title="Reset Everything"
            >
              <X size={15} />
            </button>
            <button 
              onClick={logout}
              className="p-1 text-gray-500 hover:text-teal-600 transition-colors cursor-pointer"
              title="Sign Out"
            >
              <LogOut size={15} />
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-2 relative z-10">
        <div className="grid gap-6">
          {/* Active Price Lists & Company Search Card */}
          <section className="bg-white/40 backdrop-blur-xl border border-white/45 rounded-[2rem] p-6 shadow-xl relative z-20 transition-all duration-300">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
              <div className="flex items-center gap-2 px-3.5 py-1.5 bg-white/50 rounded-full border border-white/60 shadow-sm self-start">
                <Database size={14} className="text-teal-700" />
                <span className="text-xs font-black uppercase tracking-wider text-teal-900 font-display">Available PDF Documents</span>
              </div>
              <div className="text-[9px] bg-white/40 border border-white/45 text-teal-950 px-3 py-1.5 rounded-full font-black tracking-widest uppercase self-start">
                {companies.length} Companies Loaded
              </div>
            </div>
            
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div className="flex flex-wrap items-center gap-2">
                {priceLists.map((list) => {
                  const isAvailable = fileStatus[list.path];
                  const isTargeted = selectedCompany && list.name.includes(selectedCompany.priceListYear);
                  const isExcluded = selectedCompany && !list.name.includes(selectedCompany.priceListYear);
                  return (
                    <div 
                      key={list.path}
                      className={cn(
                        "px-3.5 py-2 border rounded-full text-xs font-bold flex items-center gap-2 transition-all shadow-sm",
                        isTargeted ? "bg-teal-500/10 border-teal-500/35 text-teal-900 ring-2 ring-teal-500/10 scale-102" :
                        isExcluded ? "opacity-35 filter grayscale scale-98 bg-white/10 border-white/10 text-gray-400" :
                        isAvailable === true ? "bg-white/60 border-green-250/30 text-green-800" : 
                        isAvailable === false ? "bg-red-50/50 border-red-200/50 text-red-850" :
                        "bg-white/40 border-white/30 text-gray-600"
                      )}
                    >
                      <div className={cn(
                        "w-2 h-2 rounded-full relative",
                        isTargeted ? "bg-teal-600 shadow-[0_0_8px_rgba(20,184,166,0.8)]" :
                        isAvailable === true ? "bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]" : 
                        isAvailable === false ? "bg-red-500" :
                        "bg-gray-400 animate-pulse"
                      )} />
                      <span className="font-display text-xs tracking-tight">{list.name}</span>
                      {isAvailable === false && <span className="opacity-60 text-[10px] font-normal">(Missing)</span>}
                    </div>
                  );
                })}
              </div>

              {/* Elegant integrated Company Selection dropdown inside Document panel */}
              <div className="relative w-full md:w-64 company-select-container shrink-0">
                {selectedCompany ? (
                  <motion.div 
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="flex items-center justify-between gap-3 bg-gradient-to-r from-teal-500/90 to-emerald-550/90 hover:from-teal-600 hover:to-emerald-600 text-white pl-4 pr-2 py-2 rounded-2xl shadow-md border border-white/20"
                  >
                    <div className="flex flex-col text-left">
                      <span className="text-[8px] uppercase font-bold text-teal-100 tracking-wider">Contractor</span>
                      <span className="text-xs font-black truncate max-w-[120px] font-display">{selectedCompany.name}</span>
                      {selectedCompany.responsiblePerson && (
                        <span className="text-[9px] font-bold text-teal-50 truncate max-w-[120px]">
                          المسئول: {selectedCompany.responsiblePerson}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="bg-white/20 text-[9px] font-black px-1.5 py-0.5 rounded text-white">{selectedCompany.discount}% OFF</span>
                      <button 
                        onClick={() => {
                          setSelectedCompany(null);
                          setCompanySearch('');
                          setResults([]);
                        }}
                        className="w-5 h-5 rounded-full bg-white/20 hover:bg-white/40 text-white flex items-center justify-center transition-colors cursor-pointer"
                      >
                        <X size={10} />
                      </button>
                    </div>
                  </motion.div>
                ) : (
                  <div className="relative">
                    <input
                      type="text"
                      value={companySearch}
                      onChange={(e) => {
                        setCompanySearch(e.target.value);
                        setIsCompanyDropdownOpen(true);
                        setResults([]);
                      }}
                      onFocus={() => setIsCompanyDropdownOpen(true)}
                      placeholder="Type name..."
                      className="w-full bg-white/55 hover:bg-white/75 focus:bg-white border border-white/60 focus:border-teal-400/80 rounded-full pl-9 pr-4 py-2 text-xs font-bold text-gray-800 placeholder:text-gray-400 focus:outline-none focus:ring-4 focus:ring-teal-500/5 transition-all shadow-sm"
                    />
                    <Building2 className="absolute left-3 top-1/2 -translate-y-1/2 text-teal-600/70" size={14} />
                  </div>
                )}

                <AnimatePresence>
                  {isCompanyDropdownOpen && companySearch.length >= 1 && !selectedCompany && (
                    <motion.div
                      initial={{ opacity: 0, y: 5 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      className="absolute right-0 top-full z-[120] w-full md:w-80 mt-2 bg-white/95 backdrop-blur-2xl border border-white/60 rounded-2xl shadow-2xl max-h-60 overflow-y-auto p-1.5"
                    >
                      {filteredCompanies.length > 0 ? (
                        <>
                          <div className="px-3 py-1.5 text-[9px] font-black text-teal-800 uppercase tracking-wider border-b border-gray-100/50 mb-1 flex items-center justify-between sticky top-0 bg-white/95">
                            <span>Found Contractors</span>
                            <span className="bg-teal-50 text-teal-700 px-1.5 py-0.5 rounded-full text-[8px]">{filteredCompanies.length}</span>
                          </div>
                          {filteredCompanies.map((company, idx) => (
                            <button
                              key={idx}
                              onClick={() => {
                                setSelectedCompany(company);
                                setIsCompanyDropdownOpen(false);
                                setCompanySearch('');
                              }}
                              className="w-full text-left px-3.5 py-2.5 hover:bg-teal-600 rounded-xl flex items-center justify-between group/comp transition-all mb-1 last:mb-0 bg-transparent border border-transparent hover:border-white/20 cursor-pointer"
                            >
                              <span className="font-bold text-xs text-gray-800 group-hover/comp:text-white truncate max-w-[150px]">{company.name}</span>
                              <div className="flex items-center gap-1.5 shrink-0">
                                <span className="text-[8px] bg-teal-50 text-teal-700 px-1 py-0.5 rounded font-black group-hover/comp:bg-white/20 group-hover/comp:text-white border border-teal-100/50 group-hover/comp:border-transparent">{company.discount}% OFF</span>
                                <span className="text-[8px] font-bold text-gray-400 group-hover/comp:text-white/80">{company.priceListYear}</span>
                              </div>
                            </button>
                          ))}
                        </>
                      ) : (
                        <div className="px-4 py-6 text-center">
                          <p className="text-xs font-bold text-gray-400">No matching contracts</p>
                        </div>
                      )}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>

            <AnimatePresence>
              {selectedCompany && (
                <motion.div
                  initial={{ opacity: 0, height: 0, y: 10 }}
                  animate={{ opacity: 1, height: "auto", y: 0 }}
                  exit={{ opacity: 0, height: 0, y: 10 }}
                  className="mt-4 overflow-hidden"
                >
                  <div
                    className="p-4 bg-gradient-to-r from-teal-500/15 via-teal-500/5 to-emerald-500/5 border border-teal-500/20 rounded-2xl flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 text-xs shadow-inner"
                    id="selected-company-info-banner"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-xl bg-teal-500/20 text-teal-700 flex items-center justify-center shrink-0 shadow-sm border border-teal-500/15">
                        <Building2 size={16} />
                      </div>
                      <div className="text-left">
                        <p className="font-black text-teal-950 font-display">Active Contract Linked</p>
                        <p className="text-gray-600 font-semibold mt-0.5">
                          Querying prices for <span className="font-extrabold text-teal-900">{selectedCompany.name}</span>.
                        </p>
                        {selectedCompany.responsiblePerson && (
                          <p className="text-teal-800 font-bold text-[11px] mt-1.5 flex items-center gap-1.5 bg-teal-50 px-2 py-1 rounded-lg border border-teal-100 w-fit">
                            <span className="w-1.5 h-1.5 rounded-full bg-teal-500 shrink-0"></span>
                            المسئول من قسم السيلز: <span className="font-extrabold text-teal-950">{selectedCompany.responsiblePerson}</span>
                          </p>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-2.5 items-center w-full sm:w-auto">
                      <div className="flex items-center gap-1.5 px-3 py-1.5 bg-white/70 border border-teal-200/40 rounded-xl text-teal-950 font-bold shadow-sm">
                        <Calendar size={13} className="text-teal-600" />
                        <span>Price List:</span>
                        <span className="font-black text-teal-950 font-display text-[12px]">{selectedCompany.priceListYear}</span>
                      </div>

                      <div className="flex items-center gap-1.5 px-3 py-1.5 bg-white/70 border border-emerald-200/40 rounded-xl text-emerald-950 font-bold shadow-sm">
                        <Percent size={13} className="text-emerald-600" />
                        <span>Discount:</span>
                        <span className="font-black text-emerald-950 font-display text-[12px]">{selectedCompany.discount}% OFF</span>
                      </div>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {Object.values(fileStatus).some(status => status === false) && (
              <div className="mt-4 p-4 bg-amber-50/70 border border-amber-200/50 rounded-2xl flex items-start gap-3 text-amber-900 text-xs backdrop-blur-md">
                <AlertCircle className="shrink-0 mt-0.5 text-amber-700" size={16} />
                <div>
                  <p className="font-bold">Missing Files Detected</p>
                  <p className="opacity-90">Please ensure 2025.pdf, 2024.pdf, and 2023.pdf are loaded in the public folder.</p>
                </div>
              </div>
            )}
          </section>

          {/* Card 2: Search Procedures */}
          <section className="bg-white/40 backdrop-blur-xl border border-white/45 rounded-[2rem] p-8 shadow-xl relative z-10 group">
            {/* ECG sinus heart waveform bg graphic clipped within rounding */}
            <div className="absolute inset-0 rounded-[2rem] overflow-hidden pointer-events-none z-0">
              <div className="absolute inset-0 opacity-[0.05] flex items-center justify-center overflow-hidden">
                <svg viewBox="0 0 1000 300" className="w-full h-full min-w-[800px] text-teal-700 stroke-current stroke-[2.5]" fill="none">
                  <path d="M0,150 L200,150 L220,130 L230,170 L240,110 L250,190 L260,130 L270,165 L280,150 L500,150 L520,140 L530,150 L540,150 L560,50 L585,270 L610,130 L630,175 L645,150 L800,150 L820,110 L840,180 L860,150 L1000,150" />
                </svg>
              </div>
            </div>
            
            <div className="relative z-10 text-left">
              <div className="flex items-center gap-3 mb-6">
                <div className="w-10 h-10 rounded-2xl bg-teal-600 text-white flex items-center justify-center font-bold text-lg shadow-lg shadow-teal-500/20">2</div>
                <div>
                  <h2 className="text-xl font-bold text-gray-900 font-display">Search Procedures</h2>
                  <p className="text-xs text-gray-500">Search and include multiple procedures to inquire about their prices.</p>
                </div>
              </div>

              {/* Selected procedures chips */}
              {selectedProcedures.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-6">
                  {selectedProcedures.map(p => (
                    <motion.div
                      initial={{ opacity: 0, scale: 0.9 }}
                      animate={{ opacity: 1, scale: 1 }}
                      key={p.id}
                      className="inline-flex items-center gap-2 bg-white/45 backdrop-blur-md border border-white/60 text-gray-800 rounded-full px-4 py-2 hover:border-teal-300 transition-all shadow-sm"
                    >
                      <div className="flex flex-col text-left">
                        <span className="text-[11px] text-gray-900 font-extrabold">{p.name}</span>
                        {p.arabic && <span className="text-[9px] text-teal-700/80 font-bold block mt-0.5" dir="rtl">{p.arabic}</span>}
                      </div>
                      <button
                        type="button"
                        onClick={() => setSelectedProcedures(prev => prev.filter(item => item.id !== p.id))}
                        className="w-4 h-4 rounded-full bg-gray-200 text-gray-600 hover:bg-red-500 hover:text-white flex items-center justify-center transition-colors font-bold ml-1 text-[8px] cursor-pointer"
                      >
                        <X size={8} />
                      </button>
                    </motion.div>
                  ))}
                </div>
              )}

              <form onSubmit={handleSearch} className="relative procedure-search-container z-50">
                <div className="relative flex items-center bg-white/55 hover:bg-white/70 focus-within:bg-white border-2 border-white/60 rounded-[1.8rem] px-5 py-2 shadow-sm focus-within:ring-4 focus-within:ring-teal-500/5 transition-all gap-3">
                  <Search className="text-teal-600/80 shrink-0" size={20} />
                  <input
                    type="text"
                    value={procedureInput}
                    onChange={(e) => {
                      setProcedureInput(e.target.value);
                      setIsProcedureDropdownOpen(true);
                    }}
                    onFocus={() => setIsProcedureDropdownOpen(true)}
                    placeholder="Search procedure in English or Arabic (e.g., Blood Test, قياس, غسيل)..."
                    className="w-full bg-transparent border-none text-gray-900 text-sm md:text-base focus:outline-none font-bold placeholder:text-gray-400 min-h-[44px]"
                    disabled={loading}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && procedureInput.trim()) {
                        e.preventDefault();
                        addCustomProcedure(procedureInput);
                      }
                    }}
                  />
                  
                  {procedureInput.trim() && (
                    <button
                      type="button"
                      onClick={() => addCustomProcedure(procedureInput)}
                      className="mr-2 bg-teal-50/70 hover:bg-teal-100 text-teal-700 px-3.5 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-wider transition-all shadow-sm active:scale-95 cursor-pointer shrink-0"
                    >
                      Add Custom
                    </button>
                  )}
                  
                  <button
                    type="submit"
                    disabled={loading || selectedProcedures.length === 0}
                    className="bg-white/50 backdrop-blur-md border border-white/50 text-teal-900 px-6 py-2.5 rounded-2xl font-extrabold hover:bg-white/80 hover:text-teal-950 transition-all flex items-center gap-1.5 shadow-sm hover:shadow-md disabled:bg-gray-150/40 disabled:text-gray-400 disabled:shadow-none disabled:cursor-not-allowed text-xs md:text-sm uppercase tracking-wider shrink-0 duration-300"
                  >
                    {loading ? <Loader2 className="animate-spin text-teal-600" size={16} /> : 'Extract'}
                  </button>
                </div>

                {/* Dropdown for procedure searches */}
                <AnimatePresence>
                  {isProcedureDropdownOpen && procedureInput.length >= 1 && (
                    <motion.div
                      initial={{ opacity: 0, y: 5 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      className="absolute z-[110] w-full mt-2 bg-white/95 backdrop-blur-2xl border border-white/60 rounded-2xl shadow-2xl max-h-64 overflow-y-auto p-1.5"
                    >
                      {filteredProcedures.length > 0 ? (
                        <>
                          <div className="px-3 py-1.5 text-[9px] font-black text-teal-800 uppercase tracking-wider border-b border-gray-100/50 mb-1 flex items-center justify-between sticky top-0 bg-white/95 z-10">
                            <span>Standard Procedures Found</span>
                            <span className="bg-teal-50 text-teal-700 px-1.5 py-0.5 rounded-full text-[8.5px] font-bold">{filteredProcedures.length} options</span>
                          </div>
                          {filteredProcedures.map((proc, idx) => (
                            <button
                              key={idx}
                              type="button"
                              onClick={() => addProcedure(proc)}
                              className="w-full text-left px-4 py-2.5 hover:bg-teal-600 rounded-xl flex items-center justify-between group/pitem transition-all mb-1 last:mb-0 bg-transparent border border-transparent hover:border-white/25 hover:shadow-sm cursor-pointer"
                            >
                              <span className="font-extrabold text-xs text-gray-800 group-hover/pitem:text-white transition-colors">{proc.english}</span>
                              <span className="font-bold text-xs text-teal-700 group-hover/pitem:text-teal-100 transition-colors" dir="rtl">{proc.arabic}</span>
                            </button>
                          ))}
                        </>
                      ) : (
                        <div className="px-5 py-6 text-center">
                          <p className="text-xs font-bold text-gray-400">No standard procedures match your keywords</p>
                          <button
                            type="button; "
                            onClick={() => addCustomProcedure(procedureInput)}
                            className="mt-3 px-3.5 py-2 bg-teal-50/70 hover:bg-teal-100/80 text-teal-700 rounded-xl font-black text-[10px] uppercase tracking-wider inline-flex items-center gap-1 transition-all"
                          >
                            Add "{procedureInput}" as custom extraction
                          </button>
                        </div>
                      )}
                    </motion.div>
                  )}
                </AnimatePresence>
              </form>

              {/* AI Search Options */}
              <div className="mt-4 flex flex-col sm:flex-row sm:items-center justify-between gap-2 px-2 text-xs text-gray-500">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="aiSearchEnabled"
                    checked={aiSearchEnabled}
                    onChange={(e) => setAiSearchEnabled(e.target.checked)}
                    className="w-4 h-4 text-teal-600 focus:ring-teal-500 border-gray-300 rounded cursor-pointer"
                  />
                  <label htmlFor="aiSearchEnabled" className="font-semibold text-gray-650 cursor-pointer select-none">
                    Enable AI Semantic Search (using Gemini flash model for custom extractions)
                  </label>
                </div>
                {selectedProcedures.some(p => p.isCustom) && (
                  <span className="text-[10px] font-black uppercase text-teal-700 bg-teal-100/60 px-3 py-1 rounded-full animate-pulse self-start sm:self-auto">
                    AI search is active for custom terms
                  </span>
                )}
              </div>

              {/* Suggestions / History as secondary section */}
              <AnimatePresence>
                {user && recentSearches.length > 0 && results.length === 0 && !loading && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="mt-6 border-t border-white/30 pt-4"
                  >
                    <label className="text-[10px] font-black text-teal-800/85 uppercase tracking-widest block mb-3">Recently Searched combinations</label>
                    <div className="flex flex-wrap gap-2">
                    {recentSearches.map((search) => (
                      <button
                        key={search.id}
                        type="button"
                        onClick={() => {
                          const parts = search.query.split(', ');
                          const newProcs = parts.map((name: string) => {
                            const match = standardProcedures.find(sp => sp.english.toLowerCase() === name.toLowerCase());
                            return {
                              id: Math.random().toString(36).substr(2, 9),
                              name: name,
                              arabic: match?.arabic,
                              isCustom: !match
                            };
                          });
                          setSelectedProcedures(newProcs);
                        }}
                        className="px-4 py-2 bg-white/30 hover:bg-white/55 border border-white/40 rounded-full text-xs font-bold text-gray-700 hover:text-teal-900 transition-all flex items-center gap-2 group shadow-sm hover:shadow-md backdrop-blur-sm cursor-pointer"
                      >
                        {search.query}
                        <span className="text-[10px] bg-teal-500/10 group-hover:bg-teal-500 group-hover:text-white px-2 py-0.5 rounded-full text-teal-700 font-black transition-all">
                          {search.resultCount}
                        </span>
                      </button>
                    ))}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </section>

          {/* Progress / Status Update Bar */}
          <AnimatePresence>
            {loading && (
              <motion.section
                initial={{ opacity: 0, y: 15, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -15, scale: 0.95 }}
                className="bg-white/40 backdrop-blur-xl border border-white/45 rounded-[2rem] p-6 shadow-xl text-left space-y-4"
              >
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-2xl bg-teal-500/10 border border-teal-500/20 text-teal-700 flex items-center justify-center animate-pulse">
                      <Loader2 className="animate-spin text-teal-600" size={18} />
                    </div>
                    <div>
                      <h4 className="text-sm font-black text-teal-950 uppercase tracking-wider font-display">
                        {searchStatus.stage === 'local' ? 'Scanning Local Database...' : 'Extending search with Gemini AI...'}
                      </h4>
                      <p className="text-[11px] text-gray-500 font-semibold">
                        {searchStatus.stage === 'local' 
                          ? 'Checking local preloaded cash price list files...' 
                          : 'Deep searching active PDF documents using semantic AI...'}
                      </p>
                    </div>
                  </div>
                  {searchStatus.stage === 'ai' && (
                    <span className="text-[9px] bg-amber-500/10 border border-amber-500/20 text-amber-700 px-3 py-1 rounded-full font-black uppercase tracking-widest animate-pulse self-start">
                      AI Active
                    </span>
                  )}
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs font-bold text-gray-650">
                    <div className="flex items-center gap-2">
                      <span className="text-teal-700 font-extrabold">{searchStatus.foundCount}</span>
                      <span className="font-semibold text-gray-600">found locally</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-amber-600 font-extrabold">{searchStatus.pendingCount}</span>
                      <span className="font-semibold text-gray-600">pending / extending</span>
                    </div>
                  </div>

                  {/* Progress/Percentage Bar */}
                  <div className="w-full bg-gray-200/50 rounded-full h-3.5 overflow-hidden border border-white/20 p-0.5 shadow-inner">
                    <motion.div 
                      className={cn(
                        "h-full rounded-full transition-all duration-500",
                        searchStatus.stage === 'local' 
                          ? "bg-gradient-to-r from-teal-500 to-emerald-500 shadow-[0_0_8px_rgba(20,184,166,0.5)]" 
                          : "bg-gradient-to-r from-teal-500 via-emerald-500 to-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.5)]"
                      )}
                      initial={{ width: '0%' }}
                      animate={{ 
                        width: searchStatus.stage === 'local' 
                          ? '35%' 
                          : searchStatus.stage === 'ai' 
                          ? '75%' 
                          : '100%' 
                      }}
                    />
                  </div>
                </div>

                <div className="p-3 bg-gradient-to-r from-teal-500/10 via-teal-500/5 to-transparent border border-teal-500/10 rounded-2xl text-[11px] font-bold text-teal-900 flex items-center gap-2 leading-relaxed">
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-teal-500 animate-ping shrink-0" />
                  <span>
                    Status update: <span className="font-extrabold text-teal-950">{searchStatus.foundCount}</span> numbers of procedures found,{' '}
                    pending <span className="font-extrabold text-amber-700">{searchStatus.pendingCount}</span> procedures{' '}
                    {searchStatus.isExtendingToAI && '— Extending to AI search.'}
                  </span>
                </div>
              </motion.section>
            )}
          </AnimatePresence>

          {/* Results */}
          <AnimatePresence>
            {(results.length > 0 || error) && (
              <motion.section
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                className="mt-4 space-y-6"
              >
                {/* Shareable Arabic Text Output Card */}
                {(() => {
                  const isNoResultsError = error && (
                    error.toLowerCase().includes('no procedures matching') ||
                    error.toLowerCase().includes('no matching procedures')
                  );
                  if (results.length > 0 || isNoResultsError) {
                    return (
                      <div className="bg-gradient-to-br from-[#ebf5f7]/85 to-[#def0f3]/85 border border-white/60 backdrop-blur-xl rounded-[2.5rem] p-8 shadow-xl space-y-4 text-left">
                        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-white/50">
                          <div className="flex items-center gap-3">
                            <span className="text-3xl">📋</span>
                            <div>
                              <h4 className="text-base font-black text-teal-950 font-display">تقرير عرض الأسعار للمشاركة / Copyable Text Report</h4>
                              <p className="text-[11px] text-teal-900/80 font-semibold">جاهز للنسخ المباشر والمشاركة مع العملاء والمرضى عبر الواتساب</p>
                            </div>
                          </div>
                          <div className="flex flex-col sm:flex-row gap-2 shrink-0 self-stretch md:self-auto">
                            <button
                              onClick={handleCopy}
                              className={cn(
                                "px-6 py-3 rounded-2xl font-extrabold text-xs uppercase tracking-wider flex items-center justify-center gap-2 shadow-lg transition-all active:scale-95 cursor-pointer w-full sm:w-auto",
                                copied 
                                  ? "bg-teal-600 text-white" 
                                  : "bg-white hover:bg-teal-50 text-teal-900 border border-white/80 shadow-sm"
                              )}
                            >
                              {copied ? (
                                <>
                                  <Check size={14} className="text-white animate-bounce" />
                                  <span>Report Copied!</span>
                                </>
                              ) : (
                                <>
                                  <Copy size={14} />
                                  <span>Copy Text Report</span>
                                </>
                              )}
                            </button>
                            <button
                              onClick={handleCopyCC}
                              className={cn(
                                "px-6 py-3 rounded-2xl font-extrabold text-xs uppercase tracking-wider flex items-center justify-center gap-2 shadow-lg transition-all active:scale-95 cursor-pointer w-full sm:w-auto",
                                copiedCC 
                                  ? "bg-teal-600 text-white" 
                                  : "bg-teal-900 hover:bg-teal-950 text-white shadow-sm"
                              )}
                              title="Copy CC email addresses to easily paste when replying in Outlook"
                            >
                              {copiedCC ? (
                                <>
                                  <Check size={14} className="text-white animate-bounce" />
                                  <span>CC Copied!</span>
                                </>
                              ) : (
                                <>
                                  <Mail size={14} />
                                  <span>Copy CC Emails</span>
                                </>
                              )}
                            </button>
                          </div>
                        </div>

                        {/* Outlook Reply Guide and Helper */}
                        <div className="bg-teal-50/70 border border-teal-100/80 p-5 rounded-2xl text-left text-[12px] text-teal-950 font-medium space-y-2 shadow-sm" dir="ltr">
                          <p className="font-extrabold flex items-center gap-1.5 justify-start text-teal-950 text-[13px]">
                            <span className="text-sm">✉️</span>
                            <span>💡 Outlook Reply Tips & Guide</span>
                          </p>
                          <p className="text-teal-900/90 leading-relaxed font-semibold">
                            Since you are replying to an existing email thread in Outlook:
                            <br />
                            1. Click <span className="text-teal-950 font-black">"Copy Text Report"</span> and paste it directly into your email reply.
                            <br />
                            2. Click <span className="text-teal-950 font-black">"Copy CC Emails"</span> and paste them straight into Outlook's To/CC fields!
                          </p>
                        </div>

                        <div className="relative">
                          <pre 
                            className="w-full bg-white/70 border border-white p-6 rounded-2xl text-[15px] font-bold text-gray-800 whitespace-pre-wrap text-right shadow-inner leading-relaxed overflow-x-auto"
                            dir="rtl"
                            style={{ fontFamily: 'monospace, "Inter"' }}
                          >
                            {getSummaryText()}
                          </pre>
                          <div className="absolute top-2 left-2 text-[8px] bg-teal-100/95 text-teal-800 px-2 py-1 rounded font-black tracking-wider uppercase font-display block">
                            ARABIC RTL REPORT
                          </div>
                        </div>
                      </div>
                    );
                  }
                  return null;
                })()}

                {error && results.length === 0 && !error.toLowerCase().includes('no procedures matching') ? (
                  <div className="bg-red-50/70 border border-red-200/50 backdrop-blur-md rounded-3xl p-8 flex items-start gap-4 text-red-800 shadow-xl">
                    <AlertCircle className="shrink-0 mt-1 text-red-600" size={28} />
                    <div>
                      <p className="text-lg font-bold">Extraction Failed</p>
                      <p className="opacity-95 text-sm leading-relaxed">{error}</p>
                    </div>
                  </div>
                ) : results.length > 0 ? (
                  <>
                    <div className="flex items-center justify-between px-4 mt-6">
                      <h3 className="text-sm font-black text-teal-950 font-display uppercase tracking-wider">
                        Found {results.length} result{results.length > 1 ? 's' : ''} for <span className="text-teal-900 px-3 py-1 bg-white/60 border border-white/50 rounded-xl font-bold">"{procedure}"</span>
                      </h3>
                      {selectedCompany && (
                        <div className="flex items-center gap-1.5 text-[10px] uppercase font-black text-emerald-700 bg-white/60 border border-emerald-100 px-3.5 py-2 rounded-full shadow-sm">
                          <Percent size={12} />
                          {selectedCompany.discount}% Off Applied
                        </div>
                      )}
                    </div>
                    
                    {results.map((result, index) => (
                      <motion.div 
                        key={index}
                        initial={{ opacity: 0, y: 15 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: index * 0.08 }}
                        className="bg-white/45 backdrop-blur-xl border border-white/45 rounded-[2rem] overflow-hidden shadow-xl hover:shadow-2xl transition-all border-b-4 border-b-teal-500 group text-left"
                      >
                        <div className="bg-gradient-to-r from-teal-600/90 to-blue-600/90 px-8 py-5 text-white flex items-center justify-between shadow-sm">
                          <div className="flex flex-col">
                            <span className="text-[9px] font-extrabold uppercase tracking-widest opacity-80">Source Document</span>
                            <span className="text-xs font-black font-display tracking-tight">{result.sourceFile}</span>
                          </div>
                          <div className="bg-white/20 backdrop-blur-md px-3 py-1.5 rounded-xl border border-white/20">
                            <span className="text-[9px] font-black uppercase tracking-widest leading-none font-display">{result.sectionName}</span>
                          </div>
                        </div>
                        
                        <div className="p-8 grid gap-6 lg:grid-cols-5 items-center">
                          <div className="lg:col-span-3 space-y-6">
                            <div>
                              <label className="text-[9px] font-black text-teal-800/50 uppercase tracking-widest block mb-2 font-display">English Nomenclature</label>
                              <p className="text-xl font-extrabold text-gray-900 leading-tight font-display">{result.nameEnglish}</p>
                            </div>
                            <div className="text-right">
                              <label className="text-[9px] font-black text-teal-800/50 uppercase tracking-widest block mb-2 font-display">الإسم باللغة العربية</label>
                              <p className="text-2xl font-black text-gray-900 leading-tight" dir="rtl">{result.nameArabic}</p>
                            </div>
                          </div>
                          
                          <div className="lg:col-span-2">
                            <div className="bg-white/55 border border-white rounded-[1.8rem] p-6 flex flex-col gap-4 text-center group-hover:bg-white/80 transition-all shadow-inner">
                              <div className="flex flex-col items-center">
                                <span className="text-[9px] font-black text-gray-400 uppercase tracking-widest block mb-1">Original Price</span>
                                <span className={cn(
                                  "font-black tracking-tight font-display transition-all",
                                  selectedCompany ? "text-2xl opacity-40 line-through text-gray-600" : "text-5xl text-teal-600"
                                )}>{result.price}</span>
                              </div>

                              {selectedCompany && (() => {
                                const calculated = calculateDiscountedPrice(result.price, selectedCompany.discount);
                                if (!calculated) return null;
                                return (
                                  <motion.div 
                                    initial={{ opacity: 0, scale: 0.95 }}
                                    animate={{ opacity: 1, scale: 1 }}
                                    className="pt-4 border-t border-gray-100 flex flex-col items-center"
                                  >
                                    <div className="px-2 py-0.5 bg-emerald-500 text-white rounded text-[8px] font-black uppercase tracking-widest mb-2 shadow-sm font-display leading-none">
                                      Discount Price
                                    </div>
                                    <div className="flex items-baseline gap-1">
                                      <span className="text-4xl font-black tracking-tight text-emerald-600 font-display">
                                        {calculated.discounted.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 1 })}
                                      </span>
                                      <span className="text-xs font-black text-emerald-600 uppercase tracking-tight font-display">{calculated.currency || 'ج.م'}</span>
                                    </div>
                                  </motion.div>
                                );
                              })()}
                            </div>
                          </div>
                        </div>
                      </motion.div>
                    ))}
                  </>
                ) : null}
              </motion.section>
            )}
          </AnimatePresence>
        </div>
      </main>

      {/* Footer */}
      <footer className="max-w-4xl mx-auto px-6 py-12 text-center relative z-10 select-none">
        <div className="inline-flex items-center gap-2 px-4 py-2 bg-white/40 backdrop-blur-md border border-white/60 rounded-full text-[9px] font-black text-teal-900 uppercase tracking-widest shadow-sm">
          <CheckCircle2 size={12} className="text-emerald-500 shadow-sm" />
          Elite Hospital • Price List v2.5
        </div>
        <p className="mt-4 text-[10px] text-gray-500/80 font-bold tracking-tight">
          Session Token Securely Logged: <span className="text-teal-800 font-mono">{user.email}</span>
        </p>
      </footer>
    </div>
  );
}
