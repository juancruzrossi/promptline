import { useState, useEffect, useCallback } from 'react';
import { api, type QueueWithStatus } from '../api/client';

export function useQueues(pollIntervalMs = 2000) {
  const [queues, setQueues] = useState<QueueWithStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await api.listQueues();
      setQueues(data);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, pollIntervalMs);
    return () => clearInterval(interval);
  }, [refresh, pollIntervalMs]);

  return { queues, loading, error, refresh };
}
