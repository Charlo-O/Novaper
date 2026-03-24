import { useState } from 'react';
import { Search, Sparkles, Download, Loader2, Check } from 'lucide-react';

interface SkillResolverProps {
  onResolved?: (skill: any) => void;
}

type ResolveStage = 'idle' | 'searching' | 'installing' | 'generating' | 'done' | 'error';

export function SkillResolver({ onResolved }: SkillResolverProps) {
  const [query, setQuery] = useState('');
  const [stage, setStage] = useState<ResolveStage>('idle');
  const [results, setResults] = useState<{ clawhub: any[]; github: any[] } | null>(null);
  const [resolvedSkill, setResolvedSkill] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSearch = async () => {
    if (!query.trim()) return;
    setStage('searching');
    setError(null);

    try {
      const res = await fetch('/api/plugins/skills/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: query.trim() }),
      });
      if (!res.ok) throw new Error(`Search failed: ${res.status}`);
      const data = await res.json();
      setResults(data);
      setStage('idle');
    } catch (err: any) {
      setError(err.message);
      setStage('error');
    }
  };

  const handleResolve = async () => {
    if (!query.trim()) return;
    setStage('searching');
    setError(null);

    try {
      const res = await fetch(`/api/plugins/skills/resolve?q=${encodeURIComponent(query.trim())}`);
      if (!res.ok) throw new Error(`Resolve failed: ${res.status}`);
      const data = await res.json();
      setResolvedSkill(data);
      setStage('done');
      onResolved?.(data);
    } catch (err: any) {
      setError(err.message);
      setStage('error');
    }
  };

  const handleGenerate = async () => {
    if (!query.trim()) return;
    setStage('generating');
    setError(null);

    try {
      const res = await fetch('/api/plugins/skills/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: query.trim() }),
      });
      if (!res.ok) throw new Error(`Generate failed: ${res.status}`);
      const skill = await res.json();
      setResolvedSkill({ skill, source: 'generated' });
      setStage('done');
      onResolved?.({ skill, source: 'generated' });
    } catch (err: any) {
      setError(err.message);
      setStage('error');
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card p-4 space-y-4">
      <h3 className="text-sm font-semibold flex items-center gap-2">
        <Sparkles className="w-4 h-4 text-primary" />
        Skill Resolver
      </h3>

      {/* Search input */}
      <div className="flex gap-2">
        <div className="flex-1 flex items-center gap-2 px-3 py-2 rounded-lg bg-muted border border-border">
          <Search className="w-4 h-4 text-muted-foreground" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleResolve(); }}
            placeholder="Describe a task or search for a skill..."
            className="flex-1 bg-transparent text-sm text-foreground outline-none"
          />
        </div>
        <button
          onClick={handleResolve}
          disabled={stage === 'searching' || stage === 'generating'}
          className="px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm hover:bg-primary/90 transition-colors disabled:opacity-50"
        >
          {stage === 'searching' ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            'Resolve'
          )}
        </button>
      </div>

      {/* Action buttons */}
      <div className="flex gap-2 text-xs">
        <button
          onClick={handleSearch}
          disabled={stage === 'searching'}
          className="px-3 py-1.5 rounded-md bg-muted hover:bg-accent transition-colors"
        >
          <Search className="w-3 h-3 inline mr-1" />
          Search Only
        </button>
        <button
          onClick={handleGenerate}
          disabled={stage === 'generating'}
          className="px-3 py-1.5 rounded-md bg-muted hover:bg-accent transition-colors"
        >
          <Sparkles className="w-3 h-3 inline mr-1" />
          Auto-Generate
        </button>
      </div>

      {/* Progress indicator */}
      {(stage === 'searching' || stage === 'installing' || stage === 'generating') && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin text-primary" />
          {stage === 'searching' && 'Searching installed skills, ClawHub, and GitHub...'}
          {stage === 'installing' && 'Installing skill...'}
          {stage === 'generating' && 'Generating skill with AI...'}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="text-sm text-destructive bg-destructive/10 rounded-lg px-3 py-2">
          {error}
        </div>
      )}

      {/* Search results */}
      {results && stage === 'idle' && (
        <div className="space-y-3">
          {results.clawhub.length > 0 && (
            <div>
              <h4 className="text-xs font-medium text-muted-foreground uppercase mb-1">ClawHub</h4>
              {results.clawhub.map((s: any, i: number) => (
                <div key={i} className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-muted">
                  <div>
                    <span className="text-sm font-medium">{s.name}</span>
                    <span className="text-xs text-muted-foreground ml-2">{s.description}</span>
                  </div>
                  <Download className="w-3.5 h-3.5 text-muted-foreground cursor-pointer hover:text-primary" />
                </div>
              ))}
            </div>
          )}
          {results.github.length > 0 && (
            <div>
              <h4 className="text-xs font-medium text-muted-foreground uppercase mb-1">GitHub</h4>
              {results.github.map((r: any, i: number) => (
                <div key={i} className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-muted">
                  <div>
                    <span className="text-sm font-medium">{r.owner}/{r.name}</span>
                    <span className="text-xs text-muted-foreground ml-2">{r.description}</span>
                  </div>
                  <Download className="w-3.5 h-3.5 text-muted-foreground cursor-pointer hover:text-primary" />
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Resolved skill */}
      {resolvedSkill && stage === 'done' && (
        <div className="flex items-center gap-2 text-sm bg-primary/10 rounded-lg px-3 py-2">
          <Check className="w-4 h-4 text-primary" />
          <span>
            Skill <strong>{resolvedSkill.skill?.name}</strong> resolved via{' '}
            <span className="text-primary">{resolvedSkill.source}</span>
          </span>
        </div>
      )}
    </div>
  );
}
