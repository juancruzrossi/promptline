import { useState } from 'react';
import { useProject } from '../hooks/useQueue';
import { api } from '../api/client';
import type { ProjectView, SessionWithStatus } from '../types/queue';
import { SessionSection } from './SessionSection';

interface ProjectDetailProps {
  project: string;
  projects: ProjectView[];
  refresh: () => Promise<void>;
  onProjectDeleted: () => void;
}

function isVisible(session: SessionWithStatus): boolean {
  if (session.status === 'active') return true;
  return session.prompts.some(p => p.status === 'pending' || p.status === 'running');
}

export function ProjectDetail({ project, projects, refresh, onProjectDeleted }: ProjectDetailProps) {
  const { projectView, loading, error } = useProject({ project, projects, loading: false, error: null, refresh });
  const [historyOpen, setHistoryOpen] = useState(false);

  async function handleDeleteProject() {
    const confirmed = window.confirm(
      `Delete project "${project}"? This removes all sessions and prompts.`
    );
    if (!confirmed) return;
    try {
      await api.deleteProject(project);
      onProjectDeleted();
    } catch {
      // Silent fail
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-sm text-[var(--color-muted)] animate-pulse">Loading...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-sm text-red-400">Error: {error}</p>
      </div>
    );
  }

  if (!projectView) return null;

  const visibleSessions = projectView.sessions.filter(isVisible);
  const historySessions = projectView.sessions.filter(s => !isVisible(s));

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="shrink-0 px-6 pt-6 pb-4 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-lg font-bold text-[var(--color-text)] truncate leading-tight">
              {projectView.project}
            </h2>
            <p className="text-xs text-[var(--color-muted)] mt-0.5 truncate font-mono">
              {projectView.directory}
            </p>
          </div>

          <button
            type="button"
            onClick={handleDeleteProject}
            className={[
              'shrink-0 text-xs px-3 py-1.5 rounded border transition-all duration-150 cursor-pointer',
              'border-red-900/40 text-red-500/60',
              'hover:border-red-500/60 hover:text-red-400 hover:bg-red-500/5',
              'focus:outline-none focus:ring-1 focus:ring-red-500/30',
            ].join(' ')}
            aria-label={`Delete project ${projectView.project}`}
          >
            Delete Project
          </button>
        </div>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
        {visibleSessions.length === 0 && historySessions.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-8 select-none">
            <span className="text-2xl text-[var(--color-border)]">&#x25A1;</span>
            <p className="text-sm text-[var(--color-muted)]">No sessions yet</p>
          </div>
        )}

        {visibleSessions.map(session => (
          <SessionSection
            key={session.sessionId}
            session={session}
            project={project}
            onMutate={refresh}
            defaultExpanded
          />
        ))}

        {historySessions.length > 0 && (
          <div className="pt-2">
            <button
              type="button"
              onClick={() => setHistoryOpen(v => !v)}
              className={[
                'flex items-center gap-2 text-xs text-[var(--color-muted)] uppercase tracking-wider py-1 cursor-pointer',
                'hover:text-[var(--color-text)] transition-colors duration-150 focus:outline-none',
              ].join(' ')}
              aria-expanded={historyOpen}
            >
              <span
                className="inline-block transition-transform duration-200"
                style={{ transform: historyOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}
                aria-hidden="true"
              >
                ▶
              </span>
              History ({historySessions.length} {historySessions.length === 1 ? 'session' : 'sessions'})
            </button>

            {historyOpen && (
              <div className="mt-2 space-y-3">
                {historySessions.map(session => (
                  <SessionSection
                    key={session.sessionId}
                    session={session}
                    project={project}
                    onMutate={refresh}
                    defaultExpanded={false}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        <div className="h-4" aria-hidden="true" />
      </div>
    </div>
  );
}
