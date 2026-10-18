import { useState, useEffect } from 'react';
import { CompanyInfo } from '../types';
import { loadCompanies } from '../services/companyService';

export function useCompaniesData() {
  const [companies, setCompanies] = useState<CompanyInfo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;
    loadCompanies().then((data) => {
      if (isMounted) {
        setCompanies(data);
        setLoading(false);
      }
    });

    return () => {
      isMounted = false;
    };
  }, []);

  return { companies, loading };
}
