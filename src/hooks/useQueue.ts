import { useMemo } from 'react';
import type { ProjectView } from '../types/queue';

interface UseProjectOptions {
  project: string | null;
  projects: ProjectView[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useProject({ project, projects, loading, error, refresh }: UseProjectOptions) {
  const projectView = useMemo(() => {
    if (!project) return null;
    return projects.find(p => p.project === project) ?? null;
  }, [project, projects]);

  return { projectView, loading, error, refresh };
}
