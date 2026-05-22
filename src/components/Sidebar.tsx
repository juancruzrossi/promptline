import { useMemo } from 'react';
import type { ProjectView } from '../types/queue';
import { StatusDot } from './StatusDot';
import { TrashIcon } from './TrashIcon';

interface SidebarProps {
  projects: ProjectView[];
  selectedProject: string | null;
  onSelectProject: (name: string) => void;
  onDeleteProject: (name: string) => void | Promise<void>;
  onDeleteAllProjects: () => void | Promise<void>;
  width: number;
  onWidthChange: (width: number) => void;
}

const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 560;
const DEFAULT_SIDEBAR_WIDTH = 280;

function clampSidebarWidth(width: number): number {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));
}

function getSessionStatus(project: ProjectView): 'active' | 'idle' | 'none' {
  if (project.sessions.length === 0) return 'none';
  return project.sessions.some(s => s.status === 'active') ? 'active' : 'idle';
}

function getPendingCount(project: ProjectView): number {
  return project.sessions.reduce(
    (sum, s) => sum + s.prompts.filter(p => p.status === 'pending').length,
    0,
  );
}

function getProjectRank(project: ProjectView, pendingCount: number): number {
  if (pendingCount > 0) return 0;
  if (getSessionStatus(project) === 'active') return 1;
  return 2;
}

export function Sidebar({
  projects,
  selectedProject,
  onSelectProject,
  onDeleteProject,
  onDeleteAllProjects,
  width,
  onWidthChange,
}: SidebarProps) {
  const pendingCounts = useMemo(
    () => new Map(projects.map((project) => [project.project, getPendingCount(project)])),
    [projects],
  );

  const sortedProjects = useMemo(
    () => [...projects].sort((a, b) => {
      const aPending = pendingCounts.get(a.project) ?? 0;
      const bPending = pendingCounts.get(b.project) ?? 0;
      return getProjectRank(a, aPending) - getProjectRank(b, bPending);
    }),
    [pendingCounts, projects],
  );

  function handleResizePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    const handle = event.currentTarget;

    handle.setPointerCapture(event.pointerId);

    function handlePointerMove(moveEvent: PointerEvent) {
      onWidthChange(clampSidebarWidth(startWidth + moveEvent.clientX - startX));
    }

    function handlePointerUp() {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
    }

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
  }

  return (
    <aside
      className="relative flex flex-col shrink-0 h-full bg-[var(--color-surface)] border-r border-[var(--color-border)]"
      style={{ width }}
      aria-label="Project navigation"
    >
      {/* Header */}
      <div className="px-5 py-4 border-b border-[var(--color-border)] flex items-center justify-between gap-3">
        <h1
          className="text-base font-bold tracking-widest uppercase text-[var(--color-active)]"
          style={{ textShadow: '0 0 12px rgba(74, 222, 128, 0.4)' }}
        >
          PromptLine
        </h1>
        {projects.length > 0 && (
          <button
            type="button"
            onClick={() => void onDeleteAllProjects()}
            className={[
              'shrink-0 p-1.5 rounded cursor-pointer',
              'text-[var(--color-muted)]/50 hover:text-red-400 hover:bg-red-400/10',
              'transition-all duration-100 focus:outline-none focus:ring-1 focus:ring-red-500/30',
            ].join(' ')}
            aria-label="Remove all projects from PromptLine"
            title="Remove all projects from PromptLine"
          >
            <TrashIcon />
          </button>
        )}
      </div>

      {/* Project list */}
      <nav className="flex-1 overflow-y-auto py-2" aria-label="Projects">
        {projects.length === 0 && (
          <p className="px-5 py-4 text-xs text-[var(--color-muted)]">No projects found.</p>
        )}
        <ul role="list">
          {sortedProjects.map((project) => {
            const status = getSessionStatus(project);
            const pending = pendingCounts.get(project.project) ?? 0;
            const isSelected = project.project === selectedProject;
            const sessionCount = project.sessions.length;

            return (
              <li key={project.project} role="listitem" className="group relative">
                <button
                  type="button"
                  onClick={() => onSelectProject(project.project)}
                  aria-current={isSelected ? 'page' : undefined}
                  className={[
                    'w-full text-left pl-5 pr-12 py-3 flex items-start gap-3 transition-colors duration-150 cursor-pointer',
                    'border-l-2',
                    isSelected
                      ? 'border-[var(--color-running)] bg-[var(--color-border)]'
                      : 'border-transparent hover:bg-white/5',
                  ].join(' ')}
                >
                  <span className="mt-[3px]">
                    <StatusDot status={status} />
                  </span>

                  <span className="flex flex-col gap-0.5 min-w-0">
                    <span className="text-sm font-bold leading-tight truncate text-[var(--color-text)]">
                      {project.project}
                    </span>

                    <span
                      className="text-xs text-[var(--color-muted)] truncate leading-tight"
                      title={project.directory}
                      aria-label={project.directory}
                    >
                      {project.directory}
                    </span>

                    <span className="flex items-center gap-2 mt-1">
                      {project.queueStatus === 'completed' && (
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-[var(--color-active)]/15 text-[var(--color-active)] leading-none">
                          completed
                        </span>
                      )}
                      {pending > 0 && (
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-[var(--color-pending)]/15 text-[var(--color-pending)] leading-none">
                          {pending} queued
                        </span>
                      )}
                      {sessionCount > 1 && (
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-white/10 text-[var(--color-muted)] leading-none">
                          {sessionCount} sessions
                        </span>
                      )}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    void onDeleteProject(project.project);
                  }}
                  className={[
                    'absolute right-3 top-3 p-1.5 rounded cursor-pointer',
                    'text-[var(--color-muted)]/40 opacity-0',
                    'group-hover:opacity-100 focus:opacity-100',
                    'hover:text-red-400 hover:bg-red-400/10',
                    'transition-all duration-100 focus:outline-none focus:ring-1 focus:ring-red-500/30',
                  ].join(' ')}
                  aria-label={`Remove ${project.project} from PromptLine`}
                  title={`Remove ${project.project} from PromptLine`}
                >
                  <TrashIcon />
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        tabIndex={0}
        title="Drag to resize sidebar"
        onPointerDown={handleResizePointerDown}
        onDoubleClick={() => onWidthChange(DEFAULT_SIDEBAR_WIDTH)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') onWidthChange(clampSidebarWidth(width - 24));
          if (event.key === 'ArrowRight') onWidthChange(clampSidebarWidth(width + 24));
          if (event.key === 'Home') onWidthChange(MIN_SIDEBAR_WIDTH);
          if (event.key === 'End') onWidthChange(MAX_SIDEBAR_WIDTH);
        }}
        className={[
          'absolute top-0 right-[-4px] z-20 h-full w-2 cursor-col-resize',
          'after:absolute after:top-0 after:right-[3px] after:h-full after:w-px after:bg-transparent',
          'hover:after:bg-[var(--color-running)] focus:after:bg-[var(--color-running)]',
          'focus:outline-none',
        ].join(' ')}
      />
    </aside>
  );
}
