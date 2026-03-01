import type { ProjectQueue } from '../types/queue';

interface StatusBarProps {
  queues: ProjectQueue[];
}

interface AggregateStats {
  active: number;
  queued: number;
  completed: number;
}

function computeStats(queues: ProjectQueue[]): AggregateStats {
  let active = 0;
  let queued = 0;
  let completed = 0;

  for (const queue of queues) {
    if (queue.activeSession?.status === 'active') active += 1;

    for (const prompt of queue.prompts) {
      if (prompt.status === 'pending') queued += 1;
      if (prompt.status === 'completed') completed += 1;
    }
  }

  return { active, queued, completed };
}

interface StatSegmentProps {
  value: number;
  label: string;
  color: string;
}

function StatSegment({ value, label, color }: StatSegmentProps) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`text-[${color}] font-bold`} style={{ color }}>
        {value}
      </span>
      <span className="text-[var(--color-muted)]">{label}</span>
    </span>
  );
}

export function StatusBar({ queues }: StatusBarProps) {
  const { active, queued, completed } = computeStats(queues);

  return (
    <footer
      className="flex items-center gap-4 px-5 h-8 shrink-0 bg-[var(--color-surface)] border-t border-[var(--color-border)]"
      aria-label="Status bar"
    >
      <StatSegment value={active} label="active" color="var(--color-active)" />

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
