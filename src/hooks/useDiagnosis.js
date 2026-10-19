import { useState, useCallback } from 'react';
import { base44 } from '@/api/base44Client';

// Shared hook for invoking the unified Morpheus diagnosis agent.
// Works across deploy, compile, github, and build flows.
// Returns { diagnosis, diagnosing, diagnose, clearDiagnosis }.
//
// Usage:
//   const { diagnosis, diagnosing, diagnose } = useDiagnosis();
//   await diagnose({ type: 'compile', projectId, errorContext: { error, repoUrl, target } });

export function useDiagnosis() {
  const [diagnosis, setDiagnosis] = useState(null);
  const [diagnosing, setDiagnosing] = useState(false);

  const diagnose = useCallback(async (payload) => {
    setDiagnosing(true);
    setDiagnosis(null);
    try {
      const res = await base44.functions.invoke('diagnoseIssue', payload);
      setDiagnosis(res.data?.diagnosis || null);
      return res.data?.diagnosis || null;
    } catch (e) {
      setDiagnosis({ summary: `Diagnosis failed: ${e.message}`, autoFixed: [], needsUserAction: [], totalErrors: 0, allClear: false });
      return null;
    } finally {
      setDiagnosing(false);
    }
  }, []);

  const clearDiagnosis = useCallback(() => setDiagnosis(null), []);

  return { diagnosis, diagnosing, diagnose, clearDiagnosis };
}