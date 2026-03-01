import { useState } from 'react';
import { useQueues } from './hooks/useQueues';
import { Sidebar } from './components/Sidebar';
import { StatusBar } from './components/StatusBar';

function App() {
  const { queues, loading, error } = useQueues();
  const [selectedProject, setSelectedProject] = useState<string | null>(null);

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-[var(--color-bg)] text-[var(--color-text)] font-mono">
      {/* Main area: sidebar + content */}
      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          queues={queues}
          selectedProject={selectedProject}
          onSelectProject={setSelectedProject}
        />

        {/* Main content */}
        <main className="flex-1 flex items-center justify-center overflow-auto bg-[var(--color-bg)]">
          {loading && (
            <p className="text-sm text-[var(--color-muted)] animate-pulse">Loading...</p>
          )}

          {!loading && error && (
            <p className="text-sm text-red-400">Error: {error}</p>
          )}

          {!loading && !error && !selectedProject && (
            <div className="flex flex-col items-center gap-2 select-none">
              <span className="text-2xl text-[var(--color-border)]">&#x25A1;</span>
              <p className="text-sm text-[var(--color-muted)]">Select a project</p>
            </div>
          )}

          {!loading && !error && selectedProject && (
            <p className="text-sm text-[var(--color-muted)]">
              {/* Project detail panel will go here */}
              {selectedProject}
            </p>
          )}
        </main>
      </div>

      {/* Status bar pinned at bottom */}
      <StatusBar queues={queues} />
    </div>
  );
}

export default App;
