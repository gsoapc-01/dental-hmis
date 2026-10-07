import { useEffect, useState } from 'react'
import { loadCorrections } from './clinicalCorrections'
import type { ClinicalCorrection } from './clinicalCorrections'

export function useCorrections(clinicId: string, visitId?: string) {
  const [rows,setRows] = useState<ClinicalCorrection[]>([])
  const [error,setError] = useState<string | null>(null)
  const [loading,setLoading] = useState(true)
  const [revision,setRevision] = useState(0)
  useEffect(() => {
    const changed = () => { setLoading(true); setRevision((value) => value+1) }
    window.addEventListener('clinical-corrections-changed',changed)
    return () => window.removeEventListener('clinical-corrections-changed',changed)
  },[])
  useEffect(() => {
    let cancelled=false
    void loadCorrections(clinicId,visitId).then((result) => {
      if (!cancelled) { setRows(result); setError(null); setLoading(false) }
    }).catch(() => { if (!cancelled) { setError('Correction history could not be verified. Refresh before using this record.'); setLoading(false) } })
    return () => { cancelled=true }
  },[clinicId,visitId,revision])
  return { rows,error,loading }
}
export function correctionsChanged() { window.dispatchEvent(new Event('clinical-corrections-changed')) }
