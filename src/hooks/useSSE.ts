import { useEffect, useRef, useState, useCallback } from 'react';
import type { ProjectView } from '../types/queue';

interface UseSSEOptions {
  onProjects: (projects: ProjectView[]) => void;
}

export function useSSE({ onProjects }: UseSSEOptions) {
  const [connected, setConnected] = useState(false);
  const callbackRef = useRef(onProjects);
  callbackRef.current = onProjects;

  const connect = useCallback(() => {
    const es = new EventSource('/api/events');

    es.addEventListener('projects', (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data) as ProjectView[];
        callbackRef.current(data);
      } catch {
        // Ignore malformed events
      }
    });

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);

    return es;
  }, []);

  useEffect(() => {
    const es = connect();
    return () => es.close();
  }, [connect]);

  return { connected };
}
