import { useState, useRef } from 'react';
import { api } from '../api/client';
import type { SessionWithStatus, SessionStatus, Prompt } from '../types/queue';
import { PromptCard } from './PromptCard';
import { AddPromptForm } from './AddPromptForm';

interface SessionSectionProps {
  session: SessionWithStatus;
  project: string;
  onMutate: () => void;
  defaultExpanded?: boolean;
}

function StatusDot({ status }: { status: SessionStatus }) {
  if (status === 'active') {
    return (
      <span
        className="animate-pulse-dot inline-block w-2 h-2 rounded-full bg-[var(--color-active)] shrink-0"
        aria-label="Active session"
      />
    );
  }
  return (
    <span
      className="inline-block w-2 h-2 rounded-full bg-[var(--color-idle)] shrink-0"
      aria-label="Idle session"
    />
  );
}

export function SessionSection({ session, project, onMutate, defaultExpanded = true }: SessionSectionProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [dragOver, setDragOver] = useState<{ id: string; position: 'before' | 'after' } | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const dragSourceRef = useRef<string | null>(null);

  async function handleDeleteSession(e: React.MouseEvent) {
    e.stopPropagation();
    try {
      await api.deleteSession(project, session.sessionId);
      onMutate();
    } catch {
      // Silent fail
    }
  }

  const activePrompts = session.prompts.filter(p => p.status !== 'completed');
  const completedPrompts = session.prompts.filter(p => p.status === 'completed').reverse();
  const pendingCount = session.prompts.filter(p => p.status === 'pending').length;

  const displayName = session.sessionName || '(session)';

  function handleDragStart(id: string) {
    dragSourceRef.current = id;
    setDraggingId(id);
  }

  function handleDragOver(id: string, position: 'before' | 'after') {
    if (!dragSourceRef.current || dragSourceRef.current === id) return;
    setDragOver(prev => {
      if (prev?.id === id && prev?.position === position) return prev;
      return { id, position };
    });
  }

  function handleDragEnd() {
    setDragOver(null);
    setDraggingId(null);
    dragSourceRef.current = null;
  }

  function handleDrop(targetId: string) {
    const sourceId = dragSourceRef.current;
    const position = dragOver?.position ?? 'before';
    if (!sourceId || sourceId === targetId) {
      handleDragEnd();
      return;
    }

    const pendingPrompts = session.prompts.filter(p => p.status === 'pending');
    const sourceIndex = pendingPrompts.findIndex(p => p.id === sourceId);
    const targetIndex = pendingPrompts.findIndex(p => p.id === targetId);
    if (sourceIndex === -1 || targetIndex === -1) {
      handleDragEnd();
      return;
    }

    const reordered = [...pendingPrompts];
    const [moved] = reordered.splice(sourceIndex, 1);
    const adjustedTarget = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
    const insertAt = position === 'after' ? adjustedTarget + 1 : adjustedTarget;
    reordered.splice(insertAt, 0, moved);

    const newOrder = reordered.map(p => p.id);
    handleDragEnd();
    api.reorderPrompts(project, session.sessionId, newOrder).then(onMutate).catch(() => {});
  }

  function renderPromptList(prompts: Prompt[], reorderable: boolean) {
    return prompts.map(prompt => (
      <PromptCard
        key={prompt.id}
        prompt={prompt}
        project={project}
        sessionId={session.sessionId}
        onMutate={onMutate}
        onDragStart={reorderable ? handleDragStart : undefined}
        onDragOver={reorderable ? handleDragOver : undefined}
        onDragEnd={reorderable ? handleDragEnd : undefined}
        onDrop={reorderable ? handleDrop : undefined}
        dropPosition={dragOver?.id === prompt.id ? dragOver.position : null}
        isDragging={draggingId === prompt.id}
      />
    ));
  }

  return (
    <div className="border border-[var(--color-border)] rounded-lg overflow-hidden bg-white/[0.02]">
      {/* Session header */}
      <div className="relative group">
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className={[
          'w-full flex items-center gap-3 pl-4 pr-10 py-3 text-left cursor-pointer',
          'hover:bg-white/5 transition-colors duration-150 focus:outline-none',
        ].join(' ')}
        aria-expanded={expanded}
      >
        <StatusDot status={session.status} />
        <span className={[
          'flex-1 text-sm truncate leading-tight',
          session.sessionName ? 'text-[var(--color-text)]' : 'text-[var(--color-muted)] italic',
        ].join(' ')}>
          {displayName}
        </span>
        {pendingCount > 0 && (
          <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-[var(--color-pending)]/15 text-[var(--color-pending)] leading-none">
            {pendingCount} queued
          </span>
        )}
        <span
          className="text-[var(--color-muted)] text-xs transition-transform duration-200"
          style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
          aria-hidden="true"
        >
          ▶
        </span>
      </button>
      <button
        type="button"
        onClick={handleDeleteSession}
        className={[
          'absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded cursor-pointer',
          'text-[var(--color-muted)]/40 hover:text-red-400 hover:bg-red-400/10',
          'transition-all duration-100 focus:outline-none',
        ].join(' ')}
        aria-label="Delete session"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="3 6 5 6 21 6" />
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        </svg>
      </button>
      </div>

      {/* Session content */}
      {expanded && (
        <div className="px-4 pb-4 space-y-2">
          {activePrompts.length === 0 && completedPrompts.length === 0 && (
            <p className="text-xs text-[var(--color-muted)] py-2">No prompts yet</p>
          )}

          {activePrompts.length > 0 && (
            <div className="space-y-2" role="list" aria-label="Active prompts">
              {renderPromptList(activePrompts, true)}
            </div>
          )}

          <AddPromptForm project={project} sessionId={session.sessionId} onAdded={onMutate} />

          {completedPrompts.length > 0 && (
            <div className="pt-1 space-y-2 opacity-60" role="list" aria-label="Completed prompts">
              {renderPromptList(completedPrompts, false)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
