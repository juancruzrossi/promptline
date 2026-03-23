import { useState, useRef, useEffect } from 'react';
import { api } from '../api/client';
import { InlineAlert } from './InlineAlert';
import { toErrorMessage } from '../utils/errors';

interface AddPromptFormProps {
  project: string;
  sessionId: string;
  onAdded: () => void | Promise<void>;
}

export function AddPromptForm({ project, sessionId, onAdded }: AddPromptFormProps) {
  const [expanded, setExpanded] = useState(false);
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (expanded && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [expanded]);

  // Auto-expand textarea height
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  function handleCancel() {
    setText('');
    setExpanded(false);
    setActionError(null);
  }

  async function handleSubmit() {
    const trimmed = text.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    setActionError(null);
    try {
      await api.addPrompt(project, sessionId, trimmed);
      setText('');
      setExpanded(false);
      await onAdded();
    } catch (error) {
      setActionError(toErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
    if (e.key === 'Escape') {
      handleCancel();
    }
  }

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className={[
          'w-full text-left text-xs text-[var(--color-muted)] px-4 py-2.5 cursor-pointer',
          'border border-dashed border-[var(--color-active)]/40 rounded-lg',
          'hover:border-[var(--color-active)]/40 hover:text-[var(--color-active)] hover:bg-[var(--color-active)]/5',
          'transition-all duration-150 focus:outline-none focus:ring-1 focus:ring-[var(--color-active)]/30',
        ].join(' ')}
        aria-label="Add a new prompt"
      >
        + Add Prompt
      </button>
    );
  }

  return (
    <div
      className="border border-[var(--color-active)]/30 rounded-lg bg-[var(--color-active)]/5 overflow-hidden"
      role="form"
      aria-label="Add prompt form"
    >
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        rows={2}
        placeholder="Type your prompt... (Enter to submit, Shift+Enter for newline)"
        className={[
          'w-full bg-transparent text-sm text-[var(--color-text)] placeholder:text-[var(--color-muted)]/60',
          'px-4 pt-3 pb-2 resize-none outline-none leading-relaxed',
          'min-h-[3.5rem]',
        ].join(' ')}
        aria-label="Prompt text"
        disabled={submitting}
      />
      {actionError && <InlineAlert message={actionError} className="px-4 pt-2" />}
      <div className="flex items-center justify-end gap-2 px-4 pb-3">
        <button
          type="button"
          onClick={handleCancel}
          disabled={submitting}
          className={[
            'text-xs px-3 py-1.5 rounded border border-[var(--color-border)] text-[var(--color-muted)] cursor-pointer',
            'hover:border-white/20 hover:text-[var(--color-text)] transition-all duration-150',
            'focus:outline-none focus:ring-1 focus:ring-white/20',
            'disabled:opacity-40 disabled:cursor-not-allowed',
          ].join(' ')}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!text.trim() || submitting}
          className={[
            'text-xs px-3 py-1.5 rounded font-medium transition-all duration-150 cursor-pointer',
            'bg-[var(--color-active)]/15 text-[var(--color-active)] border border-[var(--color-active)]/30',
            'hover:bg-[var(--color-active)]/25 hover:border-[var(--color-active)]/50',
            'focus:outline-none focus:ring-1 focus:ring-[var(--color-active)]/50',
            'disabled:opacity-40 disabled:cursor-not-allowed',
          ].join(' ')}
        >
          {submitting ? 'Adding...' : 'Add'}
        </button>
      </div>
    </div>
  );
}
