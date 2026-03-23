import { useState } from 'react';
import { selectProject } from '../hooks/useQueue';
import { api } from '../api/client';
import type { ProjectView } from '../types/queue';
import { SessionSection } from './SessionSection';
import { InlineAlert } from './InlineAlert';
import { toErrorMessage } from '../utils/errors';

interface ProjectDetailProps {
  project: string;
  projects: ProjectView[];
  onProjectDeleted: () => void;
  onMutate: () => void | Promise<void>;
}

export function ProjectDetail({ project, projects, onProjectDeleted, onMutate }: ProjectDetailProps) {
  const projectView = selectProject(project, projects);
  const [actionError, setActionError] = useState<string | null>(null);

  async function handleDeleteProject() {
    const confirmed = window.confirm(
      `Delete project "${project}"? This removes all sessions and prompts.`
    );
    if (!confirmed) return;
    setActionError(null);
    try {
      await api.deleteProject(project);
      onProjectDeleted();
      await onMutate();
    } catch (error) {
      setActionError(toErrorMessage(error));
    }
  }

  if (!projectView) return null;

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
        {actionError && <InlineAlert message={actionError} className="mt-3" />}
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
        {projectView.sessions.length === 0 && (
          <div className="flex flex-col items-center gap-3 py-12 select-none opacity-40">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--color-muted)]">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
            </svg>
            <div className="text-center">
              <p className="text-sm text-[var(--color-muted)] font-medium">No sessions yet</p>
              <p className="text-xs text-[var(--color-muted)] mt-1">Start a Claude Code session in this project to begin</p>
            </div>
          </div>
        )}

        {projectView.sessions.map(session => (
          <SessionSection
            key={session.sessionId}
            session={session}
            project={project}
            onMutate={onMutate}
            defaultExpanded
          />
        ))}

        <div className="h-4" aria-hidden="true" />
      </div>
    </div>
  );
}
