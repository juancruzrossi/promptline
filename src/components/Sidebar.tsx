import type { ProjectQueue } from '../types/queue';

interface SidebarProps {
  queues: ProjectQueue[];
  selectedProject: string | null;
  onSelectProject: (name: string) => void;
  onCreateQueue: () => void;
}

function getSessionStatus(queue: ProjectQueue): 'active' | 'idle' | 'none' {
  if (!queue.activeSession) return 'none';
  return queue.activeSession.status === 'active' ? 'active' : 'idle';
}

function getQueuedCount(queue: ProjectQueue): number {
  return queue.prompts.filter((p) => p.status === 'pending').length;
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

export function Sidebar({ queues, selectedProject, onSelectProject, onCreateQueue }: SidebarProps) {
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
        {queues.length === 0 && (
          <p className="px-5 py-4 text-xs text-[var(--color-muted)]">No projects found.</p>
        )}
        <ul role="list">
          {queues.map((queue) => {
            const status = getSessionStatus(queue);
            const queued = getQueuedCount(queue);
            const isSelected = queue.project === selectedProject;

            return (
              <li key={queue.project} role="listitem">
                <button
                  type="button"
                  onClick={() => onSelectProject(queue.project)}
                  aria-current={isSelected ? 'page' : undefined}
                  className={[
                    'w-full text-left px-5 py-3 flex items-start gap-3 transition-colors duration-150',
                    'border-l-2',
                    isSelected
                      ? 'border-[var(--color-running)] bg-[var(--color-border)]'
                      : 'border-transparent hover:bg-white/5',
                  ].join(' ')}
                >
                  {/* Status dot aligned with first line of text */}
                  <span className="mt-[3px]">
                    <StatusDot status={status} />
                  </span>

                  <span className="flex flex-col gap-0.5 min-w-0">
                    {/* Project name */}
                    <span className="text-sm font-bold leading-tight truncate text-[var(--color-text)]">
                      {queue.project}
                    </span>

                    {/* Directory path */}
                    <span className="text-xs text-[var(--color-muted)] truncate leading-tight">
                      {queue.directory}
                    </span>

                    {/* Prompt count badge */}
                    {queued > 0 && (
                      <span className="mt-1 inline-flex self-start items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-[var(--color-pending)]/15 text-[var(--color-pending)] leading-none">
                        {queued} queued
                      </span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* New Queue button */}
      <div className="shrink-0 p-3 border-t border-[var(--color-border)]">
        <button
          type="button"
          onClick={onCreateQueue}
          className={[
            'w-full text-xs text-[var(--color-muted)] py-2.5 px-3 rounded-lg',
            'border border-dashed border-[var(--color-border)]',
            'hover:border-[var(--color-active)]/40 hover:text-[var(--color-active)] hover:bg-[var(--color-active)]/5',
            'transition-all duration-150 focus:outline-none focus:ring-1 focus:ring-[var(--color-active)]/30',
          ].join(' ')}
          aria-label="Create new queue"
        >
          + New Queue
        </button>
      </div>
    </aside>
  );
}
