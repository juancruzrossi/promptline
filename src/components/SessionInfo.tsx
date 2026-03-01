import { useState, useEffect, useRef } from 'react';
import type { ActiveSession } from '../types/queue';

interface SessionInfoProps {
  session: ActiveSession | null;
}

function relativeTime(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function SessionInfo({ session }: SessionInfoProps) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  if (!session) {
    return (
      <div className="flex items-center gap-2 px-4 py-2.5 bg-white/3 border border-white/8 rounded-lg">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--color-muted)]" aria-hidden="true" />
        <span className="text-xs text-[var(--color-muted)]">No active session</span>
      </div>
    );
  }

  const shortId = session.sessionId.slice(0, 8) + '...';
  const isActive = session.status === 'active';

  async function handleResume() {
    try {
      await navigator.clipboard.writeText(`claude --resume ${session!.sessionId}`);
      setCopied(true);
      timerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback: do nothing if clipboard not available
    }
  }

  return (
    <div
      className="flex items-center gap-3 px-4 py-2.5 bg-white/3 border border-white/8 rounded-lg"
      role="status"
      aria-label="Session information"
    >
      {/* Status badge */}
      <span
        className={[
          'inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-medium leading-none',
          isActive
            ? 'bg-[var(--color-active)]/15 text-[var(--color-active)]'
            : 'bg-[var(--color-idle)]/15 text-[var(--color-idle)]',
        ].join(' ')}
      >
        <span
          className={[
            'inline-block w-1.5 h-1.5 rounded-full',
            isActive ? 'bg-[var(--color-active)] animate-pulse-dot' : 'bg-[var(--color-idle)]',
          ].join(' ')}
          aria-hidden="true"
        />
        {isActive ? 'active' : 'idle'}
      </span>

      {/* Session ID */}
      <span className="text-xs text-[var(--color-muted)] font-mono tracking-tight" aria-label="Session ID">
        {shortId}
      </span>

      {/* Separator */}
      <span className="text-[var(--color-border)] select-none" aria-hidden="true">·</span>

      {/* Last activity */}
      <span className="text-xs text-[var(--color-muted)]" aria-label="Last activity">
        {relativeTime(session.lastActivity)}
      </span>

      {/* Spacer */}
      <span className="flex-1" />

      {/* Resume button */}
      <button
        type="button"
        onClick={handleResume}
        className={[
          'text-xs px-2.5 py-1 rounded border transition-all duration-150 cursor-pointer',
          'border-[var(--color-border)] text-[var(--color-muted)]',
          'hover:border-[var(--color-running)]/50 hover:text-[var(--color-running)] hover:bg-[var(--color-running)]/5',
          'focus:outline-none focus:ring-1 focus:ring-[var(--color-running)]/50',
        ].join(' ')}
        aria-label="Copy resume command to clipboard"
      >
        {copied ? '✓ Copied!' : '▶ Resume'}
      </button>
    </div>
  );
}
