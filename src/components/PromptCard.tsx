import { useState, useRef, useEffect } from 'react';
import type { Prompt } from '../types/queue';
import { api } from '../api/client';

interface PromptCardProps {
  prompt: Prompt;
  project: string;
  onMutate: () => void;
  onDragStart?: (id: string) => void;
  onDragOver?: (id: string, position: 'before' | 'after') => void;
  onDragEnd?: () => void;
  onDrop?: (targetId: string) => void;
  dropPosition?: 'before' | 'after' | null;
  isDragging?: boolean;
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
  onDragEnd,
  onDrop,
  dropPosition = null,
  isDragging = false,
}: PromptCardProps) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(prompt.text);
  const [saving, setSaving] = useState(false);
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
    if (!isPending || editing) return;
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

  async function handleDelete(e: React.MouseEvent) {
    e.stopPropagation();
    const confirmed = window.confirm('Delete this prompt?');
    if (!confirmed) return;
    try {
      await api.deletePrompt(project, prompt.id);
      onMutate();
    } catch {
      // Silent fail
    }
  }

  function handleCardClick() {
    if (!editing && isPending) {
      handleEditStart();
    }
  }

  return (
    <div
      className="relative group transition-all duration-150"
      draggable={isPending && !editing}
      onDragStart={isPending && !editing ? (e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', prompt.id);
        onDragStart?.(prompt.id);
      } : undefined}
      onDragOver={isPending ? (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const rect = e.currentTarget.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        onDragOver?.(prompt.id, e.clientY < midY ? 'before' : 'after');
      } : undefined}
      onDrop={isPending ? (e) => {
        e.preventDefault();
        onDrop?.(prompt.id);
      } : undefined}
      onDragEnd={onDragEnd}
      aria-label={`Prompt: ${prompt.text.slice(0, 50)}`}
    >
      {/* Drop indicator — top */}
      {dropPosition === 'before' && (
        <div
          className="absolute top-0 left-2 right-2 h-0.5 rounded-full bg-[var(--color-active)] shadow-[0_0_6px_var(--color-active)]"
          aria-hidden="true"
        />
      )}
      {/* Drop indicator — bottom */}
      {dropPosition === 'after' && (
        <div
          className="absolute bottom-0 left-2 right-2 h-0.5 rounded-full bg-[var(--color-active)] shadow-[0_0_6px_var(--color-active)]"
          aria-hidden="true"
        />
      )}

      <div
        onClick={handleCardClick}
        className={[
          'flex gap-0 bg-white/5 backdrop-blur-sm border border-white/10 rounded-lg overflow-hidden',
          'transition-all duration-150',
          isCompleted ? 'opacity-60' : '',
          isPending && !editing ? 'cursor-pointer hover:border-white/20 hover:bg-white/8' : '',
          isRunning ? 'border-l-0' : '',
          isDragging ? 'opacity-40 scale-[0.98]' : '',
        ].join(' ')}
      >
        {/* Left color border */}
        <div
          className={['w-1 shrink-0', isRunning ? 'animate-pulse-dot' : ''].join(' ')}
          style={{ background: styles.color }}
          aria-hidden="true"
        />

        {/* Drag handle — only for pending */}
        {isPending && !editing && (
          <div className="flex items-center px-2 shrink-0 cursor-grab active:cursor-grabbing">
            <span
              className="text-[var(--color-muted)]/50 text-sm select-none"
              aria-hidden="true"
              title="Drag to reorder"
            >
              ⠿
            </span>
          </div>
        )}

        {/* Card body */}
        <div className="flex-1 px-3 py-3 min-w-0">
          {/* Top row: status badge + actions */}
          <div className="flex items-start justify-between gap-2 mb-2">
            <span
              className={[
                'inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium leading-none',
                styles.badge,
              ].join(' ')}
              aria-label={`Status: ${styles.label}`}
            >
              {styles.label}
            </span>

            {/* Action buttons */}
            {!editing && !isRunning && (
              <button
                type="button"
                onClick={handleDelete}
                className={[
                  'text-xs px-1.5 py-0.5 rounded text-[var(--color-muted)] cursor-pointer opacity-0 group-hover:opacity-100',
                  'hover:text-red-400 hover:bg-red-400/10',
                  'transition-all duration-100 focus:outline-none',
                ].join(' ')}
                aria-label="Delete prompt"
              >
                ✕
              </button>
            )}
          </div>

          {/* Prompt text or edit textarea */}
          {editing ? (
            <div className="space-y-2" onClick={(e) => e.stopPropagation()}>
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
            <p className="text-sm text-[var(--color-text)] leading-relaxed whitespace-pre-wrap break-words">
              {prompt.text}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
