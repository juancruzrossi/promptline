import { useState, useEffect, useCallback } from 'react';
import type { ProjectQueue } from '../types/queue';
import { api } from '../api/client';

export function useQueue(project: string | null, pollIntervalMs = 2000) {
  const [queue, setQueue] = useState<ProjectQueue | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!project) {
      setLoading(false);
      return;
    }
    try {
      const data = await api.getQueue(project);
      setQueue(data);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [project]);

  useEffect(() => {
    setQueue(null);
    setLoading(true);
    refresh();
    const interval = setInterval(refresh, pollIntervalMs);
    return () => clearInterval(interval);
  }, [refresh, pollIntervalMs]);

  return { queue, loading, error, refresh };
}
