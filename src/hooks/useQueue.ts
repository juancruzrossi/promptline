import { useState, useEffect, useCallback } from 'react';
import type { ProjectView } from '../types/queue';
import { api } from '../api/client';

export function useProject(project: string | null, pollIntervalMs = 2000) {
  const [projectView, setProjectView] = useState<ProjectView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!project) {
      setLoading(false);
      return;
    }
    try {
      const data = await api.getProject(project);
      setProjectView(data);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [project]);

  useEffect(() => {
    setProjectView(null);
    setLoading(true);
    refresh();
    const interval = setInterval(refresh, pollIntervalMs);
    return () => clearInterval(interval);
  }, [refresh, pollIntervalMs]);

  return { projectView, loading, error, refresh };
}
