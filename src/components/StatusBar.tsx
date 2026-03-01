import type { ProjectView } from '../types/queue';

interface StatusBarProps {
  projects: ProjectView[];
}

interface AggregateStats {
  activeSessions: number;
  queued: number;
  completed: number;
}

function computeStats(projects: ProjectView[]): AggregateStats {
  let activeSessions = 0;
  let queued = 0;
  let completed = 0;

  for (const project of projects) {
    for (const session of project.sessions) {
      if (session.status === 'active') activeSessions += 1;
      for (const prompt of session.prompts) {
        if (prompt.status === 'pending') queued += 1;
        if (prompt.status === 'completed') completed += 1;
      }
    }
  }

  return { activeSessions, queued, completed };
}

interface StatSegmentProps {
  value: number;
  label: string;
  color: string;
}

function StatSegment({ value, label, color }: StatSegmentProps) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="font-bold" style={{ color }}>
        {value}
      </span>
      <span className="text-[var(--color-muted)]">{label}</span>
    </span>
  );
}

export function StatusBar({ projects }: StatusBarProps) {
  const { activeSessions, queued, completed } = computeStats(projects);

  return (
    <footer
      className="flex items-center gap-4 px-5 h-8 shrink-0 bg-[var(--color-surface)] border-t border-[var(--color-border)]"
      aria-label="Status bar"
    >
      <StatSegment value={activeSessions} label="active" color="var(--color-active)" />

      <span className="text-[var(--color-border)] select-none" aria-hidden="true">
        ·
      </span>

      <StatSegment value={queued} label="queued" color="var(--color-pending)" />

      <span className="text-[var(--color-border)] select-none" aria-hidden="true">
        ·
      </span>

      <StatSegment value={completed} label="completed" color="var(--color-completed)" />
    </footer>
  );
}
