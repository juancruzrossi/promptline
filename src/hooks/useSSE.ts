import { useEffect, useEffectEvent, useState } from 'react';
import type { ProjectView } from '../types/queue';

interface UseSSEOptions {
  onProjects: (projects: ProjectView[]) => void;
}

export function useSSE({ onProjects }: UseSSEOptions) {
  const [connected, setConnected] = useState(false);
  const handleProjects = useEffectEvent(onProjects);

  useEffect(() => {
    const es = new EventSource('/api/events');

    es.addEventListener('projects', (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data) as ProjectView[];
        handleProjects(data);
      } catch {
        // Ignore malformed events
      }
    });

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    return () => es.close();
  }, []);

  return { connected };
}
