import { useState, useEffect } from 'react';
import { CompanyInfo, CompanyConfigRecord } from '../types';
import { loadCompanies, setCachedCompanies } from '../services/companyService';
import {
  subscribeToCompanyConfigs,
  seedInitialCompaniesIfEmpty,
} from '../services/approvalsFirebaseService';

export function useCompaniesData() {
  const [companies, setCompanies] = useState<CompanyInfo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;

    // 1. Initial fast load from cache / API / local
    loadCompanies().then((initial) => {
      if (isMounted && initial && initial.length > 0) {
        setCompanies(initial);
        setLoading(false);
      }
    });

    // 2. Real-time subscription to authoritative "Contractors & Officers" collection
    const unsubscribe = subscribeToCompanyConfigs(
      (configs: CompanyConfigRecord[]) => {
        if (!isMounted) return;
        if (configs && configs.length > 0) {
          const mapped: CompanyInfo[] = configs.map((c) => ({
            id: c.id,
            name: c.name,
            priceListYear: c.priceListYear || '2025',
            discount: c.discountPercentage ?? 0,
            responsiblePerson: c.contractorOfficer || 'غير محدد',
            contractorOfficer: c.contractorOfficer || 'غير محدد',
            aliases: c.aliases || [c.name],
          }));
          setCompanies(mapped);
          setCachedCompanies(mapped);
          setLoading(false);
        } else {
          // If Firestore collection was empty, attempt initial seed from loaded companies
          loadCompanies().then((fallback) => {
            if (isMounted && fallback && fallback.length > 0) {
              seedInitialCompaniesIfEmpty(fallback);
            }
          });
        }
      },
      (err) => {
        console.warn('[useCompaniesData] Real-time company subscription error:', err);
      }
    );

    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, []);

  return { companies, loading };
}
