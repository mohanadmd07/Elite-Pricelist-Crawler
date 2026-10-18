import { useState, useEffect } from 'react';
import { StandardProcedure } from '../types';

let cachedStandardProcedures: StandardProcedure[] | null = null;

export function useStandardProcedures() {
  const [standardProcedures, setStandardProcedures] = useState<StandardProcedure[]>(
    cachedStandardProcedures || []
  );
  const [loading, setLoading] = useState(!cachedStandardProcedures);

  useEffect(() => {
    if (cachedStandardProcedures) return;

    let isMounted = true;
    fetch('/procedures.json')
      .then((res) => {
        if (!res.ok) throw new Error('Failed to load standard procedures catalog');
        return res.json();
      })
      .then((data: StandardProcedure[]) => {
        if (isMounted) {
          cachedStandardProcedures = data;
          setStandardProcedures(data);
          setLoading(false);
        }
      })
      .catch((err) => {
        console.error('Procedures catalog fetch error:', err);
        if (isMounted) setLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, []);

  return { standardProcedures, loading };
}
