interface StatusDotProps {
  status: 'active' | 'idle' | 'none';
}

const STATUS_PROPS: Record<StatusDotProps['status'], { className: string; label: string }> = {
  active: {
    className: 'animate-pulse-dot bg-[var(--color-active)]',
    label: 'Active session',
  },
  idle: {
    className: 'bg-[var(--color-idle)]',
    label: 'Idle session',
  },
  none: {
    className: 'bg-[var(--color-muted)]',
    label: 'No session',
  },
};

export function StatusDot({ status }: StatusDotProps) {
  const dot = STATUS_PROPS[status];

  return (
    <span
      className={['inline-block w-2 h-2 rounded-full shrink-0', dot.className].join(' ')}
      aria-label={dot.label}
    />
  );
}
