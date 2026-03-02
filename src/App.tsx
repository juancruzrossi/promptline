import { useState } from 'react';
import { useProjects } from './hooks/useQueues';
import { Sidebar } from './components/Sidebar';
import { StatusBar } from './components/StatusBar';
import { ProjectDetail } from './components/ProjectDetail';

function App() {
  const { projects, loading, error } = useProjects();
  const [selectedProject, setSelectedProject] = useState<string | null>(null);

  function handleProjectDeleted() {
    setSelectedProject(null);
  }

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-[var(--color-bg)] text-[var(--color-text)] font-mono">
      {/* Main area: sidebar + content */}
      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          projects={projects}
          selectedProject={selectedProject}
          onSelectProject={setSelectedProject}
        />

        {/* Main content */}
        <main className="flex-1 overflow-hidden bg-[var(--color-bg)]">
          {loading && (
            <div className="flex items-center justify-center h-full">
              <p className="text-sm text-[var(--color-muted)] animate-pulse">Loading...</p>
            </div>
          )}

          {!loading && error && (
            <div className="flex items-center justify-center h-full">
              <p className="text-sm text-red-400">Error: {error}</p>
            </div>
          )}

          {!loading && !error && !selectedProject && (
            <div className="flex flex-col items-center justify-center h-full gap-3 select-none opacity-40">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--color-muted)]">
                <rect x="3" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" />
                <rect x="14" y="14" width="7" height="7" rx="1" />
              </svg>
              <div className="text-center">
                <p className="text-sm text-[var(--color-muted)] font-medium">No project selected</p>
                <p className="text-xs text-[var(--color-muted)] mt-1">Pick one from the sidebar to view its prompt queue</p>
              </div>
            </div>
          )}

          {!loading && !error && selectedProject && (
            <ProjectDetail
              project={selectedProject}
              projects={projects}
              onProjectDeleted={handleProjectDeleted}
            />
          )}
        </main>
      </div>

      {/* Status bar pinned at bottom */}
      <StatusBar projects={projects} />
    </div>
  );
}

export default App;
