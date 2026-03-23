import { useState, useEffect, useCallback, useRef } from 'react';
import type { ProjectView } from '../types/queue';
import { api } from '../api/client';
import { useSSE } from './useSSE';
import { toErrorMessage } from '../utils/errors';

const FALLBACK_POLL_MS = 2000;

export function useProjects() {
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fallbackRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const handleProjects = useCallback((data: ProjectView[]) => {
    setProjects(data);
    setError(null);
    setLoading(false);
  }, []);

  const { connected } = useSSE({ onProjects: handleProjects });

  const refresh = useCallback(async () => {
    try {
      const data = await api.listProjects();
      setProjects(data);
      setError(null);
    } catch (err: unknown) {
      setError(toErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // Fallback polling when SSE is disconnected (also handles initial load if SSE is slow)
  useEffect(() => {
    if (connected) {
      if (fallbackRef.current) {
        clearInterval(fallbackRef.current);
        fallbackRef.current = null;
      }
      return;
    }
    void refresh();
    fallbackRef.current = setInterval(refresh, FALLBACK_POLL_MS);
    return () => {
      if (fallbackRef.current) {
        clearInterval(fallbackRef.current);
        fallbackRef.current = null;
      }
    };
  }, [connected, refresh]);

  return { projects, loading, error, refresh };
}
