import { useState, useRef, useEffect } from 'react';
import type { Prompt } from '../types/queue';
import { api } from '../api/client';

interface PromptCardProps {
  prompt: Prompt;
  project: string;
  onMutate: () => void;
  // Drag & drop
  onDragStart?: (e: React.DragEvent, id: string) => void;
  onDragOver?: (e: React.DragEvent, id: string) => void;
  onDrop?: (e: React.DragEvent, id: string) => void;
  isDragOver?: boolean;
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

export function PromptCard({
  prompt,
  project,
  onMutate,
  onDragStart,
  onDragOver,
  onDrop,
  isDragOver = false,
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

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [editText]);

  function handleEditStart() {
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
      className={[
        'relative group transition-all duration-150',
        isDragOver ? 'pt-2' : '',
      ].join(' ')}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      draggable={isPending}
      onDragStart={isPending ? (e) => onDragStart?.(e, prompt.id) : undefined}
      onDragOver={isPending ? (e) => { e.preventDefault(); onDragOver?.(e, prompt.id); } : undefined}
      onDrop={isPending ? (e) => onDrop?.(e, prompt.id) : undefined}
      aria-label={`Prompt: ${prompt.text.slice(0, 50)}`}
    >
      {/* Drop indicator line */}
      {isDragOver && (
        <div
          className="absolute top-0 left-4 right-4 h-0.5 bg-[var(--color-pending)] rounded-full"
          aria-hidden="true"
        />
      )}

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

        {/* Card body */}
        <div className="flex-1 px-4 py-3 min-w-0">
          {/* Top row: drag handle + status badge + actions */}
          <div className="flex items-start justify-between gap-2 mb-2">
            <div className="flex items-center gap-2">
              {/* Drag handle — only for pending */}
              {isPending && (
                <span
                  className="text-[var(--color-muted)] text-sm cursor-grab active:cursor-grabbing select-none"
                  aria-hidden="true"
                  title="Drag to reorder"
                >
                  ⠿
                </span>
              )}

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
            </div>

            {/* Action buttons — visible on hover (for non-completed, non-editing) */}
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
                      'text-xs px-1.5 py-0.5 rounded text-[var(--color-muted)]',
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
                    'text-xs px-1.5 py-0.5 rounded text-[var(--color-muted)]',
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
                    'text-xs px-2.5 py-1 rounded border border-[var(--color-border)] text-[var(--color-muted)]',
                    'hover:text-[var(--color-text)] hover:border-white/20 transition-all duration-150',
                    'focus:outline-none disabled:opacity-40',
                  ].join(' ')}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleEditSave}
                  disabled={!editText.trim() || saving}
                  className={[
                    'text-xs px-2.5 py-1 rounded font-medium transition-all duration-150',
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
            <p className="text-sm text-[var(--color-text)] leading-relaxed whitespace-pre-wrap break-words">
              {prompt.text}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
