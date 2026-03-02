import type { ProjectView } from '../types/queue';

interface SidebarProps {
  projects: ProjectView[];
  selectedProject: string | null;
  onSelectProject: (name: string) => void;
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

function StatusDot({ status }: { status: 'active' | 'idle' | 'none' }) {
  if (status === 'active') {
    return (
      <span
        className="animate-pulse-dot inline-block w-2 h-2 rounded-full bg-[var(--color-active)] shrink-0"
        aria-label="Active session"
      />
    );
  }
  if (status === 'idle') {
    return (
      <span
        className="inline-block w-2 h-2 rounded-full bg-[var(--color-idle)] shrink-0"
        aria-label="Idle session"
      />
    );
  }
  return (
    <span
      className="inline-block w-2 h-2 rounded-full bg-[var(--color-muted)] shrink-0"
      aria-label="No session"
    />
  );
}

export function Sidebar({ projects, selectedProject, onSelectProject }: SidebarProps) {
  return (
    <aside
      className="flex flex-col w-[280px] shrink-0 h-full bg-[var(--color-surface)] border-r border-[var(--color-border)]"
      aria-label="Project navigation"
    >
      {/* Header */}
      <div className="px-5 py-4 border-b border-[var(--color-border)]">
        <h1
          className="text-base font-bold tracking-widest uppercase text-[var(--color-active)]"
          style={{ textShadow: '0 0 12px rgba(74, 222, 128, 0.4)' }}
        >
          PromptLine
        </h1>
      </div>

      {/* Project list */}
      <nav className="flex-1 overflow-y-auto py-2" aria-label="Projects">
        {projects.length === 0 && (
          <p className="px-5 py-4 text-xs text-[var(--color-muted)]">No projects found.</p>
        )}
        <ul role="list">
          {[...projects].sort((a, b) => {
            const rank = (p: ProjectView) => {
              if (getPendingCount(p) > 0) return 0;
              if (getSessionStatus(p) === 'active') return 1;
              return 2;
            };
            return rank(a) - rank(b);
          }).map((project) => {
            const status = getSessionStatus(project);
            const pending = getPendingCount(project);
            const isSelected = project.project === selectedProject;
            const sessionCount = project.sessions.length;

            return (
              <li key={project.project} role="listitem">
                <button
                  type="button"
                  onClick={() => onSelectProject(project.project)}
                  aria-current={isSelected ? 'page' : undefined}
                  className={[
                    'w-full text-left px-5 py-3 flex items-start gap-3 transition-colors duration-150 cursor-pointer',
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

                    <span className="text-xs text-[var(--color-muted)] truncate leading-tight">
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
              </li>
            );
          })}
        </ul>
      </nav>
    </aside>
  );
}
