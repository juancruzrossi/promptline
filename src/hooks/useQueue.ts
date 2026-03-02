import type { ProjectView } from '../types/queue';

export function selectProject(project: string | null, projects: ProjectView[]): ProjectView | null {
  if (!project) return null;
  return projects.find(p => p.project === project) ?? null;
}
