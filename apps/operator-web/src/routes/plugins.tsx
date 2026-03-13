import { createFileRoute } from '@tanstack/react-router';
import { useState, useEffect, useCallback } from 'react';
import {
  listInstalledSkills,
  uninstallSkill,
  discoverSkills,
  installSkill,
  listSkillRepos,
  addSkillRepo,
  updateSkillRepo,
  deleteSkillRepo,
  listMcpServers,
  createMcpServer,
  updateMcpServer,
  deleteMcpServer,
  getSystemCapabilities,
  type InstalledSkill,
  type DiscoverableSkill,
  type SkillRepo,
  type McpServerConfig,
  type DiscoverSkillsResult,
  type CapabilityItem,
  type CapabilitySnapshot,
} from '../api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Plus,
  Edit,
  Trash2,
  Loader2,
  X,
  RefreshCw,
  Search,
  ExternalLink,
  Settings,
} from 'lucide-react';
import { useTranslation } from '../lib/i18n-context';

export const Route = createFileRoute('/plugins')({
  component: PluginsComponent,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseRepoInput(input: string): { owner: string; name: string } | null {
  let s = input.trim();
  s = s.replace(/^https?:\/\/github\.com\//, '');
  s = s.replace(/\.git$/, '');
  s = s.replace(/\/$/, '');
  const parts = s.split('/');
  if (parts.length === 2 && parts[0] && parts[1]) {
    return { owner: parts[0], name: parts[1] };
  }
  return null;
}

function buildGithubViewUrl(skill: DiscoverableSkill): string {
  return `https://github.com/${skill.repoOwner}/${skill.repoName}/blob/${skill.repoBranch}/${skill.directory}/SKILL.md`;
}

type SkillFilter = 'all' | 'installed' | 'not_installed';

// ---------------------------------------------------------------------------
// Repo Manager Dialog
// ---------------------------------------------------------------------------

function RepoManagerDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslation();
  const [repos, setRepos] = useState<SkillRepo[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [repoInput, setRepoInput] = useState('');
  const [branchInput, setBranchInput] = useState('main');
  const [deleteTarget, setDeleteTarget] = useState<SkillRepo | null>(null);

  const refresh = useCallback(async () => {
    try {
      setRepos(await listSkillRepos());
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  const handleAdd = async () => {
    const parsed = parseRepoInput(repoInput);
    if (!parsed) return;
    try {
      await addSkillRepo({
        owner: parsed.owner,
        name: parsed.name,
        branch: branchInput.trim() || 'main',
      });
      setRepoInput('');
      setBranchInput('main');
      setAddOpen(false);
      await refresh();
    } catch {
      // ignore
    }
  };

  const handleToggle = async (repo: SkillRepo) => {
    await updateSkillRepo(repo.owner, repo.name, { enabled: !repo.enabled });
    await refresh();
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    await deleteSkillRepo(deleteTarget.owner, deleteTarget.name);
    setDeleteTarget(null);
    await refresh();
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-lg max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>{t.plugins.repoManagement}</DialogTitle>
          </DialogHeader>
          <div className="flex-1 overflow-auto space-y-3 py-2">
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-5 h-5 animate-spin text-slate-400" />
              </div>
            ) : repos.length === 0 ? (
              <div className="text-center py-8 text-slate-400 text-sm">
                {t.plugins.noRepos}
              </div>
            ) : (
              repos.map(repo => (
                <div
                  key={`${repo.owner}/${repo.name}`}
                  className="flex items-center gap-3 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-800"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium truncate">
                        {repo.owner}/{repo.name}
                      </span>
                      <Badge variant="outline" className="text-xs shrink-0">
                        {repo.branch}
                      </Badge>
                    </div>
                  </div>
                  <Switch
                    checked={repo.enabled}
                    onCheckedChange={() => handleToggle(repo)}
                  />
                  <Button variant="ghost" size="icon" className="h-8 w-8" asChild>
                    <a
                      href={`https://github.com/${repo.owner}/${repo.name}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <ExternalLink className="w-4 h-4" />
                    </a>
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-red-500 hover:text-red-600"
                    onClick={() => setDeleteTarget(repo)}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              ))
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(true)}>
              <Plus className="w-4 h-4 mr-1" />
              {t.plugins.addRepo}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Repo Sub-Dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t.plugins.addRepo}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid gap-2">
              <Label>{t.plugins.repoUrl}</Label>
              <Input
                value={repoInput}
                onChange={e => setRepoInput(e.target.value)}
                placeholder={t.plugins.repoUrlPlaceholder}
              />
            </div>
            <div className="grid gap-2">
              <Label>{t.plugins.repoBranch}</Label>
              <Input
                value={branchInput}
                onChange={e => setBranchInput(e.target.value)}
                placeholder="main"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>
              {t.common.cancel}
            </Button>
            <Button onClick={handleAdd} disabled={!parseRepoInput(repoInput)}>
              {t.common.confirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Repo Confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t.plugins.deleteRepoTitle}</AlertDialogTitle>
            <AlertDialogDescription>
              {t.plugins.deleteRepoConfirm.replace(
                '{repo}',
                deleteTarget ? `${deleteTarget.owner}/${deleteTarget.name}` : ''
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t.common.cancel}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>{t.common.delete}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// Skills Page — unified browser (matches cc-switch UI)
// ---------------------------------------------------------------------------

function SkillsPage() {
  const t = useTranslation();
  const [available, setAvailable] = useState<DiscoverableSkill[]>([]);
  const [installed, setInstalled] = useState<InstalledSkill[]>([]);
  const [loading, setLoading] = useState(false);
  const [initialLoaded, setInitialLoaded] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [uninstallKey, setUninstallKey] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filter, setFilter] = useState<SkillFilter>('all');
  const [repoDialogOpen, setRepoDialogOpen] = useState(false);
  const [discoverErrors, setDiscoverErrors] = useState<string[]>([]);

  const installedSet = new Set(installed.map(s => s.id));

  const loadAll = useCallback(async (forceRefresh = false) => {
    setLoading(true);
    setDiscoverErrors([]);
    try {
      const [result, inst] = await Promise.all([
        discoverSkills(forceRefresh),
        listInstalledSkills(),
      ]);
      setAvailable(result.skills);
      setDiscoverErrors(result.errors || []);
      setInstalled(inst);
      setInitialLoaded(true);
    } catch (err) {
      setDiscoverErrors([err instanceof Error ? err.message : String(err)]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Auto-load on mount
  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const handleInstall = async (skill: DiscoverableSkill) => {
    setInstalling(skill.key);
    try {
      await installSkill(skill);
      setInstalled(await listInstalledSkills());
    } catch {
      // ignore
    } finally {
      setInstalling(null);
    }
  };

  const handleUninstall = async () => {
    if (!uninstallKey) return;
    try {
      await uninstallSkill(uninstallKey);
      setInstalled(await listInstalledSkills());
    } catch {
      // ignore
    } finally {
      setUninstallKey(null);
    }
  };

  // Filter and search
  const filtered = available.filter(skill => {
    // Filter
    if (filter === 'installed' && !installedSet.has(skill.key)) return false;
    if (filter === 'not_installed' && installedSet.has(skill.key)) return false;
    // Search
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      return (
        skill.name.toLowerCase().includes(q) ||
        skill.description.toLowerCase().includes(q) ||
        skill.repoOwner.toLowerCase().includes(q) ||
        skill.repoName.toLowerCase().includes(q) ||
        skill.directory.toLowerCase().includes(q)
      );
    }
    return true;
  });

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <h1 className="text-xl font-bold">{t.plugins.skillsTitle}</h1>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => loadAll(true)}
            disabled={loading}
          >
            <RefreshCw className={`w-4 h-4 mr-1 ${loading ? 'animate-spin' : ''}`} />
            {t.plugins.refresh}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setRepoDialogOpen(true)}
          >
            <Settings className="w-4 h-4 mr-1" />
            {t.plugins.repoManagement}
          </Button>
        </div>
      </div>

      {/* Search + Filter Row */}
      <div className="flex items-center gap-3 mb-5">
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input
            className="pl-9"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder={t.plugins.searchPlaceholder}
          />
        </div>
        <Select value={filter} onValueChange={v => setFilter(v as SkillFilter)}>
          <SelectTrigger className="w-[130px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t.plugins.filterAll}</SelectItem>
            <SelectItem value="installed">{t.plugins.filterInstalled}</SelectItem>
            <SelectItem value="not_installed">{t.plugins.filterNotInstalled}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Errors */}
      {discoverErrors.length > 0 && (
        <div className="mb-4 p-3 rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-sm text-red-700 dark:text-red-400">
          <p className="font-medium mb-1">{t.plugins.discoveryErrors}</p>
          {discoverErrors.map((err, i) => (
            <p key={i} className="text-xs opacity-80">{err}</p>
          ))}
        </div>
      )}

      {/* Content */}
      {loading && !initialLoaded ? (
        <div className="flex flex-col items-center justify-center py-16">
          <Loader2 className="w-8 h-8 animate-spin text-slate-400 mb-3" />
          <span className="text-sm text-slate-400">{t.plugins.scanningRepos}</span>
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 text-slate-400">
          {initialLoaded ? t.plugins.noSkillsFound : t.plugins.scanningRepos}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {filtered.map(skill => {
            const isInst = installedSet.has(skill.key);
            return (
              <Card key={skill.key} className="flex flex-col">
                <CardContent className="p-4 flex flex-col flex-1">
                  {/* Top: name + badge */}
                  <div className="flex items-start justify-between mb-1">
                    <h3 className="text-sm font-semibold leading-tight">
                      {skill.name}
                    </h3>
                    {isInst && (
                      <Badge className="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 border-0 shrink-0 ml-2">
                        {t.plugins.installedBadge}
                      </Badge>
                    )}
                  </div>

                  {/* Path + repo */}
                  <div className="flex items-center gap-2 mb-2 text-xs text-slate-500 dark:text-slate-400">
                    <span className="truncate">{skill.directory}</span>
                    <Badge variant="outline" className="text-xs shrink-0">
                      {skill.repoOwner}/{skill.repoName}
                    </Badge>
                  </div>

                  {/* Description */}
                  <p className="text-xs text-slate-600 dark:text-slate-400 line-clamp-3 flex-1 mb-3">
                    {skill.description || skill.directory}
                  </p>

                  {/* Actions */}
                  <div className="flex items-center justify-between pt-2 border-t border-slate-100 dark:border-slate-800">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-xs px-2 h-8"
                      asChild
                    >
                      <a
                        href={buildGithubViewUrl(skill)}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <ExternalLink className="w-3.5 h-3.5 mr-1" />
                        {t.plugins.view}
                      </a>
                    </Button>

                    {isInst ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-xs px-3 h-8 text-red-500 border-red-200 hover:bg-red-50 hover:text-red-600 dark:border-red-800 dark:hover:bg-red-950"
                        onClick={() => setUninstallKey(skill.key)}
                      >
                        <Trash2 className="w-3.5 h-3.5 mr-1" />
                        {t.plugins.uninstall}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        className="text-xs px-3 h-8"
                        onClick={() => handleInstall(skill)}
                        disabled={installing === skill.key}
                      >
                        {installing === skill.key ? (
                          <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                        ) : null}
                        {t.plugins.install}
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Repo Manager Dialog */}
      <RepoManagerDialog open={repoDialogOpen} onOpenChange={setRepoDialogOpen} />

      {/* Uninstall Confirmation */}
      <AlertDialog open={!!uninstallKey} onOpenChange={() => setUninstallKey(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t.plugins.uninstallSkillTitle}</AlertDialogTitle>
            <AlertDialogDescription>{t.plugins.uninstallSkillConfirm}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t.common.cancel}</AlertDialogCancel>
            <AlertDialogAction onClick={handleUninstall}>{t.common.confirm}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// MCP Servers Page
// ---------------------------------------------------------------------------

interface EnvEntry {
  key: string;
  value: string;
}

function McpServersPage() {
  const t = useTranslation();
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingServer, setEditingServer] = useState<McpServerConfig | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [type, setType] = useState<'stdio' | 'sse' | 'http'>('stdio');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [url, setUrl] = useState('');
  const [envEntries, setEnvEntries] = useState<EnvEntry[]>([]);

  const refresh = useCallback(async () => {
    try {
      setServers(await listMcpServers());
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const resetForm = () => {
    setName(''); setType('stdio'); setCommand(''); setArgs(''); setUrl(''); setEnvEntries([]);
  };

  const openCreate = () => { setEditingServer(null); resetForm(); setDialogOpen(true); };

  const openEdit = (server: McpServerConfig) => {
    setEditingServer(server);
    setName(server.name);
    setType(server.type);
    setCommand(server.command ?? '');
    setArgs(server.args?.join(' ') ?? '');
    setUrl(server.url ?? '');
    setEnvEntries(server.env ? Object.entries(server.env).map(([key, value]) => ({ key, value })) : []);
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!name.trim()) return;
    const env: Record<string, string> = {};
    for (const entry of envEntries) { if (entry.key.trim()) env[entry.key.trim()] = entry.value; }

    const payload: Record<string, unknown> = { name: name.trim(), type, env: Object.keys(env).length > 0 ? env : undefined };
    if (type === 'stdio') {
      if (!command.trim()) return;
      payload.command = command.trim();
      payload.args = args.trim() ? args.trim().split(/\s+/) : undefined;
    } else {
      if (!url.trim()) return;
      payload.url = url.trim();
    }

    if (editingServer) {
      await updateMcpServer(editingServer.id, payload);
    } else {
      await createMcpServer({ ...payload, enabled: true } as Parameters<typeof createMcpServer>[0]);
    }
    setDialogOpen(false);
    await refresh();
  };

  const handleToggle = async (server: McpServerConfig) => {
    await updateMcpServer(server.id, { enabled: !server.enabled });
    await refresh();
  };

  const handleDelete = async () => {
    if (!deleteId) return;
    await deleteMcpServer(deleteId);
    setDeleteId(null);
    await refresh();
  };

  const addEnvEntry = () => setEnvEntries([...envEntries, { key: '', value: '' }]);
  const updateEnvEntry = (i: number, field: 'key' | 'value', val: string) => {
    const copy = [...envEntries]; copy[i] = { ...copy[i], [field]: val }; setEnvEntries(copy);
  };
  const removeEnvEntry = (i: number) => setEnvEntries(envEntries.filter((_, idx) => idx !== i));

  const isFormValid = name.trim() && (type === 'stdio' ? command.trim() : url.trim());

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
      </div>
    );
  }

  return (
    <>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-slate-500 dark:text-slate-400">{t.plugins.mcpDescription}</p>
        <Button size="sm" onClick={openCreate}>
          <Plus className="w-4 h-4 mr-1" />
          {t.plugins.addMcpServer}
        </Button>
      </div>

      {servers.length === 0 ? (
        <div className="text-center py-12 text-slate-400">{t.plugins.noMcpServers}</div>
      ) : (
        <div className="grid gap-3">
          {servers.map(server => (
            <Card key={server.id}>
              <CardContent className="py-3 px-4">
                <div className="flex items-center justify-between">
                  <div className="flex-1 min-w-0 flex items-center gap-2">
                    <span className="text-sm font-medium truncate">{server.name}</span>
                    <Badge variant="outline" className="text-xs shrink-0">{server.type}</Badge>
                  </div>
                  <div className="flex items-center gap-2 ml-4">
                    <Switch checked={server.enabled} onCheckedChange={() => handleToggle(server)} />
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(server)}>
                      <Edit className="w-4 h-4" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-red-500 hover:text-red-600" onClick={() => setDeleteId(server.id)}>
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400 font-mono truncate mt-1">
                  {server.type === 'stdio' ? `${server.command} ${server.args?.join(' ') ?? ''}` : server.url}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Create / Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingServer ? t.plugins.editMcpServer : t.plugins.addMcpServer}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid gap-2">
              <Label>{t.plugins.mcpName}</Label>
              <Input value={name} onChange={e => setName(e.target.value)} placeholder={t.plugins.mcpNamePlaceholder} />
            </div>
            <div className="grid gap-2">
              <Label>{t.plugins.mcpType}</Label>
              <Select value={type} onValueChange={v => setType(v as typeof type)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="stdio">stdio</SelectItem>
                  <SelectItem value="sse">sse</SelectItem>
                  <SelectItem value="http">http</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {type === 'stdio' ? (
              <>
                <div className="grid gap-2">
                  <Label>{t.plugins.mcpCommand}</Label>
                  <Input value={command} onChange={e => setCommand(e.target.value)} placeholder="e.g., npx" />
                </div>
                <div className="grid gap-2">
                  <Label>{t.plugins.mcpArgs}</Label>
                  <Input value={args} onChange={e => setArgs(e.target.value)} placeholder="e.g., -y @modelcontextprotocol/server-filesystem" />
                </div>
              </>
            ) : (
              <div className="grid gap-2">
                <Label>{t.plugins.mcpUrl}</Label>
                <Input value={url} onChange={e => setUrl(e.target.value)} placeholder="e.g., http://localhost:3001/sse" />
              </div>
            )}
            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <Label>{t.plugins.mcpEnvVars}</Label>
                <Button variant="outline" size="sm" onClick={addEnvEntry}><Plus className="w-3 h-3 mr-1" />{t.plugins.addEnvVar}</Button>
              </div>
              {envEntries.map((entry, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input className="flex-1" value={entry.key} onChange={e => updateEnvEntry(i, 'key', e.target.value)} placeholder="KEY" />
                  <Input className="flex-1" value={entry.value} onChange={e => updateEnvEntry(i, 'value', e.target.value)} placeholder="value" />
                  <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => removeEnvEntry(i)}><X className="w-4 h-4" /></Button>
                </div>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>{t.common.cancel}</Button>
            <Button onClick={handleSave} disabled={!isFormValid}>{t.common.save}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteId} onOpenChange={() => setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t.plugins.deleteMcpTitle}</AlertDialogTitle>
            <AlertDialogDescription>{t.plugins.deleteMcpConfirm}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t.common.cancel}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>{t.common.delete}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// Runtime Capabilities Page
// ---------------------------------------------------------------------------

function capabilityStatusClass(status: CapabilityItem['status']) {
  if (status === 'active') {
    return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300 border-0';
  }

  return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300 border-0';
}

function capabilitySourceLabel(source: CapabilityItem['source']) {
  switch (source) {
    case 'skill':
      return 'Skill';
    case 'mcp':
      return 'MCP';
    default:
      return 'Built-in';
  }
}

function CapabilitiesPage() {
  const t = useTranslation();
  const [snapshot, setSnapshot] = useState<CapabilitySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      setSnapshot(await getSystemCapabilities());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const summaryCards = snapshot
    ? [
        {
          label: 'Built-in',
          value: snapshot.summary.builtInCount,
        },
        {
          label: 'Active Skills',
          value: snapshot.summary.activeSkillCount,
        },
        {
          label: 'Enabled MCP',
          value: snapshot.summary.enabledMcpCount,
        },
        {
          label: 'Routes',
          value: snapshot.summary.routes.length,
        },
      ]
    : [];

  if (loading && !snapshot) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold">Runtime Capabilities</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Milady-style capability catalog for the current Novaper runtime.
          </p>
          {snapshot ? (
            <p className="mt-2 text-xs text-slate-400">
              {`Updated ${new Date(snapshot.generatedAt).toLocaleString()}`}
            </p>
          ) : null}
        </div>
        <Button variant="ghost" size="sm" onClick={refresh} disabled={refreshing}>
          <RefreshCw className={`w-4 h-4 mr-1 ${refreshing ? 'animate-spin' : ''}`} />
          {t.plugins.refresh}
        </Button>
      </div>

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </div>
      ) : null}

      {summaryCards.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {summaryCards.map(card => (
            <Card key={card.label}>
              <CardContent className="px-4 py-4">
                <div className="text-xs uppercase tracking-[0.18em] text-slate-400">
                  {card.label}
                </div>
                <div className="mt-2 text-2xl font-semibold text-slate-900 dark:text-slate-50">
                  {card.value}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-2">
        {snapshot?.sections.map(section => (
          <Card key={section.id} className="overflow-hidden">
            <CardContent className="px-4 py-4 space-y-4">
              <div>
                <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
                  {section.title}
                </h2>
                <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                  {section.description}
                </p>
              </div>

              {section.items.length === 0 ? (
                <div className="rounded-lg border border-dashed border-slate-200 px-4 py-5 text-sm text-slate-400 dark:border-slate-800">
                  No active items in this section yet.
                </div>
              ) : (
                <div className="space-y-3">
                  {section.items.map(item => (
                    <div
                      key={item.id}
                      className="rounded-xl border border-slate-200 bg-white/70 px-4 py-3 dark:border-slate-800 dark:bg-slate-950/40"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                            {item.title}
                          </div>
                          <div className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                            {item.description}
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Badge className={capabilityStatusClass(item.status)}>
                            {item.status === 'active'
                              ? 'Active'
                              : 'Configured'}
                          </Badge>
                          <Badge variant="outline">{capabilitySourceLabel(item.source)}</Badge>
                          <Badge variant="outline">
                            Route: {item.route}
                          </Badge>
                        </div>
                      </div>

                      {item.notes && item.notes.length > 0 ? (
                        <ul className="mt-3 space-y-1 text-xs text-slate-500 dark:text-slate-400">
                          {item.notes.map(note => (
                            <li key={note}>• {note}</li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Plugins Page
// ---------------------------------------------------------------------------

function PluginsComponent() {
  const t = useTranslation();

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      <Tabs defaultValue="capabilities">
        <TabsList>
          <TabsTrigger value="capabilities">Capabilities</TabsTrigger>
          <TabsTrigger value="skills">{t.plugins.skillsTab}</TabsTrigger>
          <TabsTrigger value="mcp">{t.plugins.mcpTab}</TabsTrigger>
        </TabsList>
        <TabsContent value="capabilities" className="mt-4">
          <CapabilitiesPage />
        </TabsContent>
        <TabsContent value="skills" className="mt-4">
          <SkillsPage />
        </TabsContent>
        <TabsContent value="mcp" className="mt-4">
          <McpServersPage />
        </TabsContent>
      </Tabs>
    </div>
  );
}
