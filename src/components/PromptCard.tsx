import { useState, useRef, useEffect } from 'react';
import type { Prompt } from '../types/queue';
import { api } from '../api/client';

interface PromptCardProps {
  prompt: Prompt;
  project: string;
  onMutate: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  isFirst?: boolean;
  isLast?: boolean;
}

const STATUS_STYLES: Record<Prompt['status'], { color: string; badge: string; label: string }> = {
  running: {
    color: 'var(--color-running)',
    badge: 'bg-[var(--color-running)]/15 text-[var(--color-running)]',
    label: 'running',
  },
  pending: {
    color: 'var(--color-pending)',
    badge: 'bg-[var(--color-pending)]/15 text-[var(--color-pending)]',
    label: 'pending',
  },
  completed: {
    color: 'var(--color-completed)',
    badge: 'bg-[var(--color-completed)]/15 text-[var(--color-completed)]',
    label: 'completed',
  },
};

const MOVE_BTN = [
  'w-6 h-6 flex items-center justify-center rounded text-[var(--color-muted)] cursor-pointer',
  'hover:text-[var(--color-text)] hover:bg-white/10',
  'transition-all duration-100 focus:outline-none',
  'disabled:opacity-20 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-[var(--color-muted)]',
].join(' ');

export function PromptCard({
  prompt,
  project,
  onMutate,
  onMoveUp,
  onMoveDown,
  isFirst = false,
  isLast = false,
}: PromptCardProps) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(prompt.text);
  const [saving, setSaving] = useState(false);
  const [hovered, setHovered] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const styles = STATUS_STYLES[prompt.status];
  const isCompleted = prompt.status === 'completed';
  const isPending = prompt.status === 'pending';
  const isRunning = prompt.status === 'running';

  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.select();
    }
  }, [editing]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [editText]);

  function handleEditStart() {
    if (!isPending) return;
    setEditText(prompt.text);
    setEditing(true);
  }

  function handleEditCancel() {
    setEditText(prompt.text);
    setEditing(false);
  }

  async function handleEditSave() {
    const trimmed = editText.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    try {
      await api.updatePrompt(project, prompt.id, { text: trimmed });
      setEditing(false);
      onMutate();
    } catch {
      // Keep edit open on error
    } finally {
      setSaving(false);
    }
  }

  function handleEditKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleEditSave();
    }
    if (e.key === 'Escape') {
      handleEditCancel();
    }
  }

  async function handleDelete() {
    const confirmed = window.confirm('Delete this prompt?');
    if (!confirmed) return;
    try {
      await api.deletePrompt(project, prompt.id);
      onMutate();
    } catch {
      // Silent fail
    }
  }

  return (
    <div
      className="relative group transition-all duration-150"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-label={`Prompt: ${prompt.text.slice(0, 50)}`}
    >
      <div
        className={[
          'flex gap-0 bg-white/5 backdrop-blur-sm border border-white/10 rounded-lg overflow-hidden',
          'transition-all duration-150',
          isCompleted ? 'opacity-60' : '',
          hovered && !isCompleted ? 'border-white/20 bg-white/8' : '',
          isRunning ? 'border-l-0' : '',
        ].join(' ')}
      >
        {/* Left color border */}
        <div
          className={['w-1 shrink-0', isRunning ? 'animate-pulse-dot' : ''].join(' ')}
          style={{ background: styles.color }}
          aria-hidden="true"
        />

        {/* Move up/down buttons — only for pending prompts */}
        {isPending && (
          <div className="flex flex-col items-center justify-center px-1 gap-0.5 shrink-0">
            <button
              type="button"
              onClick={onMoveUp}
              disabled={isFirst}
              className={MOVE_BTN}
              aria-label="Move up"
              title="Move up"
            >
              ▲
            </button>
            <button
              type="button"
              onClick={onMoveDown}
              disabled={isLast}
              className={MOVE_BTN}
              aria-label="Move down"
              title="Move down"
            >
              ▼
            </button>
          </div>
        )}

        {/* Card body */}
        <div className="flex-1 px-3 py-3 min-w-0">
          {/* Top row: status badge + actions */}
          <div className="flex items-start justify-between gap-2 mb-2">
            {/* Status badge */}
            <span
              className={[
                'inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium leading-none',
                styles.badge,
              ].join(' ')}
              aria-label={`Status: ${styles.label}`}
            >
              {styles.label}
            </span>

            {/* Action buttons — visible on hover */}
            {!editing && !isRunning && (
              <div
                className={[
                  'flex items-center gap-1 transition-opacity duration-100',
                  hovered ? 'opacity-100' : 'opacity-0',
                ].join(' ')}
              >
                {!isCompleted && (
                  <button
                    type="button"
                    onClick={handleEditStart}
                    className={[
                      'text-xs px-1.5 py-0.5 rounded text-[var(--color-muted)] cursor-pointer',
                      'hover:text-[var(--color-text)] hover:bg-white/10',
                      'transition-all duration-100 focus:outline-none',
                    ].join(' ')}
                    aria-label="Edit prompt"
                  >
                    ✎
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleDelete}
                  className={[
                    'text-xs px-1.5 py-0.5 rounded text-[var(--color-muted)] cursor-pointer',
                    'hover:text-red-400 hover:bg-red-400/10',
                    'transition-all duration-100 focus:outline-none',
                  ].join(' ')}
                  aria-label="Delete prompt"
                >
                  ✕
                </button>
              </div>
            )}
          </div>

          {/* Prompt text or edit textarea */}
          {editing ? (
            <div className="space-y-2">
              <textarea
                ref={textareaRef}
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                onKeyDown={handleEditKeyDown}
                className={[
                  'w-full bg-transparent text-sm text-[var(--color-text)] leading-relaxed resize-none',
                  'outline-none border-b border-[var(--color-active)]/30 pb-1',
                  'placeholder:text-[var(--color-muted)]/60',
                ].join(' ')}
                aria-label="Edit prompt text"
                disabled={saving}
              />
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={handleEditCancel}
                  disabled={saving}
                  className={[
                    'text-xs px-2.5 py-1 rounded border border-[var(--color-border)] text-[var(--color-muted)] cursor-pointer',
                    'hover:text-[var(--color-text)] hover:border-white/20 transition-all duration-150',
                    'focus:outline-none disabled:opacity-40 disabled:cursor-not-allowed',
                  ].join(' ')}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleEditSave}
                  disabled={!editText.trim() || saving}
                  className={[
                    'text-xs px-2.5 py-1 rounded font-medium transition-all duration-150 cursor-pointer',
                    'bg-[var(--color-active)]/15 text-[var(--color-active)] border border-[var(--color-active)]/30',
                    'hover:bg-[var(--color-active)]/25 focus:outline-none',
                    'disabled:opacity-40 disabled:cursor-not-allowed',
                  ].join(' ')}
                >
                  {saving ? 'Saving...' : 'Save'}
                </button>
              </div>
            </div>
          ) : (
            <p
              className={[
                'text-sm text-[var(--color-text)] leading-relaxed whitespace-pre-wrap break-words',
                isPending ? 'cursor-text hover:bg-white/5 -mx-2 px-2 -my-1 py-1 rounded transition-colors duration-100' : '',
              ].join(' ')}
              onClick={isPending ? handleEditStart : undefined}
            >
              {prompt.text}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
