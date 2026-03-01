import { useState, useEffect, useRef } from 'react';
import { api } from '../api/client';

interface CreateQueueModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (project: string) => void;
}

const INPUT_CLASS = [
  'w-full bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg',
  'px-3 py-2 text-sm text-[var(--color-text)] placeholder:text-[var(--color-muted)]/50',
  'outline-none focus:border-[var(--color-active)]/50 focus:ring-1 focus:ring-[var(--color-active)]/20',
  'transition-all duration-150',
].join(' ');

export function CreateQueueModal({ open, onClose, onCreated }: CreateQueueModalProps) {
  const [project, setProject] = useState('');
  const [directory, setDirectory] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const projectInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setProject('');
      setDirectory('');
      setError(null);
      setTimeout(() => projectInputRef.current?.focus(), 50);
    }
  }, [open]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') onClose();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmedProject = project.trim();
    const trimmedDir = directory.trim();
    if (!trimmedProject || !trimmedDir || submitting) return;

    setSubmitting(true);
    setError(null);
    try {
      await api.createQueue(trimmedProject, trimmedDir);
      onCreated(trimmedProject);
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create queue');
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-label="Create new queue"
      onKeyDown={handleKeyDown}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Modal panel */}
      <div className="relative z-10 w-full max-w-md mx-4 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--color-border)]">
          <h2 className="text-sm font-bold tracking-wider text-[var(--color-text)] uppercase">
            New Queue
          </h2>
          <button
            type="button"
            onClick={onClose}
            className={[
              'text-[var(--color-muted)] hover:text-[var(--color-text)] transition-colors duration-100',
              'focus:outline-none focus:text-[var(--color-text)]',
            ].join(' ')}
            aria-label="Close modal"
          >
            ✕
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
          <div className="space-y-1.5">
            <label
              htmlFor="modal-project-name"
              className="block text-xs text-[var(--color-muted)] uppercase tracking-wider"
            >
              Project name
            </label>
            <input
              id="modal-project-name"
              ref={projectInputRef}
              type="text"
              value={project}
              onChange={(e) => setProject(e.target.value)}
              placeholder="my-project"
              className={INPUT_CLASS}
              required
              autoComplete="off"
              spellCheck={false}
              disabled={submitting}
            />
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="modal-directory"
              className="block text-xs text-[var(--color-muted)] uppercase tracking-wider"
            >
              Directory path
            </label>
            <input
              id="modal-directory"
              type="text"
              value={directory}
              onChange={(e) => setDirectory(e.target.value)}
              placeholder="/home/user/projects/my-project"
              className={INPUT_CLASS}
              required
              autoComplete="off"
              spellCheck={false}
              disabled={submitting}
            />
          </div>

          {error && (
            <p className="text-xs text-red-400" role="alert">
              Error: {error}
            </p>
          )}

          <div className="flex items-center justify-end gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className={[
                'text-xs px-4 py-2 rounded border border-[var(--color-border)] text-[var(--color-muted)]',
                'hover:border-white/20 hover:text-[var(--color-text)] transition-all duration-150',
                'focus:outline-none focus:ring-1 focus:ring-white/20',
                'disabled:opacity-40',
              ].join(' ')}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!project.trim() || !directory.trim() || submitting}
              className={[
                'text-xs px-4 py-2 rounded font-medium transition-all duration-150',
                'bg-[var(--color-active)]/15 text-[var(--color-active)] border border-[var(--color-active)]/30',
                'hover:bg-[var(--color-active)]/25 hover:border-[var(--color-active)]/60',
                'focus:outline-none focus:ring-1 focus:ring-[var(--color-active)]/50',
                'disabled:opacity-40 disabled:cursor-not-allowed',
              ].join(' ')}
            >
              {submitting ? 'Creating...' : 'Create Queue'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
