import { createFileRoute } from '@tanstack/react-router';
import { useState, useEffect, useRef, useCallback } from 'react';
import {
  listWorkflows,
  createWorkflow,
  updateWorkflow,
  deleteWorkflow,
  createRecordedWorkflow,
  replayWorkflow as apiReplayWorkflow,
  getReplayStatus,
  stopReplay as apiStopReplay,
  type Workflow,
  type RecordedAction,
  type WorkflowReplayStatus,
} from '../api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Plus,
  Edit,
  Trash2,
  Loader2,
  ArrowUp,
  ArrowDown,
  Circle,
  Square,
  Play,
  MousePointer,
  Keyboard,
  Navigation,
  Clock,
} from 'lucide-react';
import { useTranslation } from '../lib/i18n-context';
import { useElectron } from '../hooks/useElectron';

export const Route = createFileRoute('/workflows')({
  component: WorkflowsComponent,
});

interface WorkflowStep {
  id: string;
  title: string;
  description: string;
}

const STEP_PREFIX_REGEX =
  /^(?:步骤\s*\d+\s*[:：.]?\s*|step\s*\d+\s*[:：.]?\s*|\d+\s*[.)、．]\s+|[-*]\s+)/i;
const DESCRIPTION_PREFIX_REGEX =
  /^(?:描述|说明|备注|验证(?:点|标准)?|校验(?:点)?|检查(?:点)?|断言|expected|assert(?:ion)?|verify|description|desc)\s*[:：-]?\s*/i;

const createStep = (title = '', description = ''): WorkflowStep => ({
  id: `step-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  title,
  description,
});

const parseWorkflowTextToSteps = (text: string): WorkflowStep[] => {
  const rawLines = text.split(/\r?\n/);
  if (rawLines.every(line => line.trim().length === 0)) {
    return [createStep()];
  }

  const parsed: Array<{ title: string; description: string }> = [];
  let current: { title: string; descriptionLines: string[] } | null = null;
  let inDescriptionBlock = false;

  const pushCurrent = () => {
    if (!current) return;

    const title = current.title.trim();
    const descriptionLines = [...current.descriptionLines];
    while (descriptionLines.length > 0 && descriptionLines[0].trim() === '') {
      descriptionLines.shift();
    }
    while (
      descriptionLines.length > 0 &&
      descriptionLines[descriptionLines.length - 1].trim() === ''
    ) {
      descriptionLines.pop();
    }
    const description = descriptionLines.join('\n').trimEnd();

    if (title || description) {
      parsed.push({ title, description });
    }
  };

  for (const rawLine of rawLines) {
    const line = rawLine.replace(/\s+$/, '');
    const trimmedLine = line.trim();

    if (trimmedLine.length === 0) {
      if (current && inDescriptionBlock) {
        current.descriptionLines.push('');
      }
      continue;
    }

    const isTopLevel = /^\S/.test(line);
    if (isTopLevel && STEP_PREFIX_REGEX.test(trimmedLine)) {
      pushCurrent();
      current = {
        title: trimmedLine.replace(STEP_PREFIX_REGEX, '').trim(),
        descriptionLines: [],
      };
      inDescriptionBlock = false;
      continue;
    }

    if (!current) {
      current = { title: trimmedLine, descriptionLines: [] };
      inDescriptionBlock = false;
      continue;
    }

    if (DESCRIPTION_PREFIX_REGEX.test(trimmedLine)) {
      const descriptionLine = trimmedLine
        .replace(DESCRIPTION_PREFIX_REGEX, '')
        .trimEnd();
      if (descriptionLine) {
        current.descriptionLines.push(descriptionLine);
      }
      inDescriptionBlock = true;
      continue;
    }

    if (!current.title) {
      current.title = trimmedLine;
      continue;
    }

    const normalizedLine = line.replace(/^\s{1,4}/, '');
    current.descriptionLines.push(normalizedLine);
    inDescriptionBlock = true;
  }

  pushCurrent();
  if (parsed.length === 0) {
    return [createStep()];
  }

  return parsed.map(step => createStep(step.title, step.description));
};

const buildWorkflowTextFromSteps = (
  steps: WorkflowStep[],
  labels: { stepLabel: string; descriptionLabel: string }
): string => {
  const { stepLabel, descriptionLabel } = labels;
  return steps
    .map(step => ({
      title: step.title.trim(),
      description: step.description,
    }))
    .filter(step => step.title || step.description)
    .map((step, index) => {
      const fallbackTitle = `${stepLabel} ${index + 1}`;
      const lines = [`${index + 1}. ${step.title.trim() || fallbackTitle}`];
      if (step.description) {
        const descriptionLines = step.description
          .split(/\r?\n/)
          .map(line => line.trimEnd())
          .filter(
            (line, lineIndex, arr) =>
              line.trim().length > 0 ||
              (lineIndex > 0 && lineIndex < arr.length - 1)
          );
        if (descriptionLines.length > 0) {
          lines.push(`   ${descriptionLabel}:`);
        }
        for (const descriptionLine of descriptionLines) {
          lines.push(descriptionLine ? `   ${descriptionLine}` : '');
        }
      }
      return lines.join('\n');
    })
    .join('\n\n');
};

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes > 0) return `${minutes}m ${remainingSeconds}s`;
  return `${remainingSeconds}s`;
}

function getActionIcon(type: string) {
  switch (type) {
    case 'click':
    case 'dblclick':
      return <MousePointer className="w-3 h-3" />;
    case 'type':
    case 'keypress':
      return <Keyboard className="w-3 h-3" />;
    case 'navigate':
      return <Navigation className="w-3 h-3" />;
    default:
      return <Circle className="w-3 h-3" />;
  }
}

function getActionDescription(action: RecordedAction): string {
  switch (action.type) {
    case 'click':
      return `Click ${action.target.text ? `"${action.target.text.slice(0, 30)}"` : action.target.tag}`;
    case 'dblclick':
      return `Double click ${action.target.text ? `"${action.target.text.slice(0, 30)}"` : action.target.tag}`;
    case 'type':
      return `Type "${(action.value || '').slice(0, 30)}"`;
    case 'keypress':
      return `Press ${action.value || 'key'}`;
    case 'navigate':
      return `Navigate to ${(action.value || '').slice(0, 40)}`;
    case 'scroll':
      return 'Scroll page';
    case 'select':
      return `Select "${(action.value || '').slice(0, 30)}"`;
    case 'hover':
      return `Hover ${action.target.tag}`;
    case 'wait':
      return `Wait ${action.timestamp}ms`;
    default:
      return action.type;
  }
}

function WorkflowsComponent() {
  const t = useTranslation();
  const { isElectron, api } = useElectron();
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showDialog, setShowDialog] = useState(false);
  const [editingWorkflow, setEditingWorkflow] = useState<Workflow | null>(null);
  const [formData, setFormData] = useState({
    name: '',
    steps: [createStep()],
  });
  const [saving, setSaving] = useState(false);

  // Recording state
  const [showRecordDialog, setShowRecordDialog] = useState(false);
  const [recordingUrl, setRecordingUrl] = useState('');
  const [recordingName, setRecordingName] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [recordedActions, setRecordedActions] = useState<RecordedAction[]>([]);
  const [recordingWebviewId, setRecordingWebviewId] = useState<string | null>(null);
  const [recordingStartTime, setRecordingStartTime] = useState(0);
  const [savingRecording, setSavingRecording] = useState(false);
  const actionsEndRef = useRef<HTMLDivElement>(null);

  // Replay state
  const [replayingUuid, setReplayingUuid] = useState<string | null>(null);
  const [replayStatus, setReplayStatus] = useState<WorkflowReplayStatus | null>(null);
  const replayPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    loadWorkflows();
  }, []);

  // Auto-scroll action list during recording
  useEffect(() => {
    actionsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [recordedActions]);

  // Cleanup replay polling
  useEffect(() => {
    return () => {
      if (replayPollRef.current) clearInterval(replayPollRef.current);
    };
  }, []);

  const loadWorkflows = async () => {
    try {
      setLoading(true);
      const data = await listWorkflows();
      setWorkflows(data.workflows);
    } catch (error) {
      console.error('Failed to load workflows:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = () => {
    setEditingWorkflow(null);
    setFormData({ name: '', steps: [createStep()] });
    setShowDialog(true);
  };

  const handleEdit = (workflow: Workflow) => {
    setEditingWorkflow(workflow);
    setFormData({
      name: workflow.name,
      steps: parseWorkflowTextToSteps(workflow.text),
    });
    setShowDialog(true);
  };

  const updateStepTitle = (stepId: string, title: string) => {
    setFormData(prev => ({
      ...prev,
      steps: prev.steps.map(step =>
        step.id === stepId ? { ...step, title } : step
      ),
    }));
  };

  const updateStepDescription = (stepId: string, description: string) => {
    setFormData(prev => ({
      ...prev,
      steps: prev.steps.map(step =>
        step.id === stepId ? { ...step, description } : step
      ),
    }));
  };

  const insertStepAfter = (index: number) => {
    setFormData(prev => {
      const nextSteps = [...prev.steps];
      nextSteps.splice(index + 1, 0, createStep());
      return { ...prev, steps: nextSteps };
    });
  };

  const removeStep = (stepId: string) => {
    setFormData(prev => {
      if (prev.steps.length === 1) {
        return { ...prev, steps: [createStep()] };
      }
      return {
        ...prev,
        steps: prev.steps.filter(step => step.id !== stepId),
      };
    });
  };

  const moveStep = (index: number, direction: -1 | 1) => {
    setFormData(prev => {
      const targetIndex = index + direction;
      if (targetIndex < 0 || targetIndex >= prev.steps.length) {
        return prev;
      }
      const nextSteps = [...prev.steps];
      [nextSteps[index], nextSteps[targetIndex]] = [
        nextSteps[targetIndex],
        nextSteps[index],
      ];
      return { ...prev, steps: nextSteps };
    });
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      const payload = {
        name: formData.name.trim(),
        text: buildWorkflowTextFromSteps(formData.steps, {
          stepLabel: t.workflows.stepLabel,
          descriptionLabel: t.workflows.stepDescriptionLabel,
        }),
      };
      if (editingWorkflow) {
        await updateWorkflow(editingWorkflow.uuid, payload);
      } else {
        await createWorkflow(payload);
      }
      setShowDialog(false);
      await loadWorkflows();
    } catch (error) {
      console.error('Failed to save workflow:', error);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (uuid: string) => {
    if (!window.confirm(t.workflows.deleteConfirm)) return;
    try {
      await deleteWorkflow(uuid);
      await loadWorkflows();
    } catch (error) {
      console.error('Failed to delete workflow:', error);
    }
  };

  // ==================== Recording ====================

  const handleStartRecordDialog = () => {
    setRecordingUrl('');
    setRecordingName('');
    setRecordedActions([]);
    setIsRecording(false);
    setShowRecordDialog(true);
  };

  const handleStartRecording = useCallback(async () => {
    if (!api || !recordingUrl.trim()) return;

    try {
      // Create a webview for recording
      const webviewId = `rec-${Date.now()}`;
      const createResult = await api.createWebView(webviewId, recordingUrl.trim());
      if (!createResult?.success) {
        console.error('Failed to create webview:', createResult?.error);
        return;
      }

      await api.showWebview(webviewId);
      // Give the page time to load
      await new Promise(resolve => setTimeout(resolve, 2000));

      const result = await api.startRecording(webviewId);
      if (!result?.success) {
        console.error('Failed to start recording:', result?.error);
        return;
      }

      setRecordingWebviewId(webviewId);
      setRecordingStartTime(Date.now());
      setIsRecording(true);
      setRecordedActions([]);
    } catch (error) {
      console.error('Failed to start recording:', error);
    }
  }, [api, recordingUrl]);

  // Listen for recorded actions from Electron
  useEffect(() => {
    if (!api || !isRecording) return;

    const cleanup = api.onRecordedAction((_webviewId: string, action: RecordedAction) => {
      setRecordedActions(prev => [...prev, action]);
    });

    return cleanup;
  }, [api, isRecording]);

  const handleStopRecording = useCallback(async () => {
    if (!api || !recordingWebviewId) return;

    try {
      const result = await api.stopRecording(recordingWebviewId);
      if (result?.success && result.actions) {
        setRecordedActions(result.actions as RecordedAction[]);
      }
      setIsRecording(false);

      // Hide the webview
      await api.hideWebView(recordingWebviewId);
    } catch (error) {
      console.error('Failed to stop recording:', error);
      setIsRecording(false);
    }
  }, [api, recordingWebviewId]);

  const handleSaveRecording = async () => {
    if (!recordingName.trim() || recordedActions.length === 0) return;

    try {
      setSavingRecording(true);
      await createRecordedWorkflow({
        name: recordingName.trim(),
        recording_url: recordingUrl.trim(),
        recorded_actions: recordedActions,
        duration_ms: Date.now() - recordingStartTime,
      });

      // Cleanup webview
      if (api && recordingWebviewId) {
        await api.webviewDestroy(recordingWebviewId);
      }

      setShowRecordDialog(false);
      setRecordingWebviewId(null);
      await loadWorkflows();
    } catch (error) {
      console.error('Failed to save recording:', error);
    } finally {
      setSavingRecording(false);
    }
  };

  // ==================== Replay ====================

  const handleReplay = async (uuid: string) => {
    try {
      await apiReplayWorkflow(uuid);
      setReplayingUuid(uuid);

      // Start polling replay status
      const poll = setInterval(async () => {
        try {
          const status = await getReplayStatus(uuid);
          setReplayStatus(status);
          if (status.status !== 'running') {
            clearInterval(poll);
            replayPollRef.current = null;
          }
        } catch {
          clearInterval(poll);
          replayPollRef.current = null;
        }
      }, 1000);
      replayPollRef.current = poll;
    } catch (error) {
      console.error('Failed to start replay:', error);
    }
  };

  const handleStopReplay = async () => {
    if (!replayingUuid) return;
    try {
      await apiStopReplay(replayingUuid);
    } catch (error) {
      console.error('Failed to stop replay:', error);
    }
  };

  const hasValidStep = formData.steps.some(step => step.title.trim());

  return (
    <div className="container mx-auto p-6 max-w-7xl">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-3xl font-bold">{t.workflows.title}</h1>
        <div className="flex gap-2">
          {isElectron && (
            <Button variant="outline" onClick={handleStartRecordDialog}>
              <Circle className="w-4 h-4 mr-2 text-red-500" />
              {t.workflows.recordNew}
            </Button>
          )}
          <Button onClick={handleCreate}>
            <Plus className="w-4 h-4 mr-2" />
            {t.workflows.createNew}
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center items-center h-64">
          <Loader2 className="w-8 h-8 animate-spin text-slate-400" />
        </div>
      ) : workflows.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-slate-500 dark:text-slate-400">
            {t.workflows.empty}
          </p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {workflows.map(workflow => (
            <Card
              key={workflow.uuid}
              className="hover:shadow-md transition-shadow"
            >
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-lg">{workflow.name}</CardTitle>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${
                    workflow.type === 'recorded'
                      ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                      : 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400'
                  }`}>
                    {workflow.type === 'recorded' ? t.workflows.recorded : t.workflows.manual}
                  </span>
                </div>
              </CardHeader>
              <CardContent>
                {workflow.type === 'recorded' ? (
                  <RecordedWorkflowCard
                    workflow={workflow}
                    t={t}
                    onReplay={() => handleReplay(workflow.uuid)}
                    onDelete={() => handleDelete(workflow.uuid)}
                    replayStatus={replayingUuid === workflow.uuid ? replayStatus : null}
                    onStopReplay={handleStopReplay}
                  />
                ) : (
                  <ManualWorkflowCard
                    workflow={workflow}
                    t={t}
                    onEdit={() => handleEdit(workflow)}
                    onDelete={() => handleDelete(workflow.uuid)}
                  />
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Create/Edit Dialog for manual workflows */}
      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent
          className="sm:max-w-[680px] max-h-[85vh] flex flex-col p-0 gap-0 overflow-hidden"
          onOpenAutoFocus={e => e.preventDefault()}
        >
          <DialogHeader className="flex-shrink-0 px-6 pt-6 pb-3 pr-12 border-b border-slate-200 dark:border-slate-800">
            <DialogTitle>
              {editingWorkflow ? t.workflows.edit : t.workflows.create}
            </DialogTitle>
          </DialogHeader>
          <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
            <div className="space-y-4 pr-1">
              <div className="space-y-2">
                <Label htmlFor="name">{t.workflows.name}</Label>
                <Input
                  id="name"
                  value={formData.name}
                  onChange={e =>
                    setFormData(prev => ({ ...prev, name: e.target.value }))
                  }
                  placeholder={t.workflows.namePlaceholder}
                />
              </div>
              <div className="space-y-3">
                <Label>{t.workflows.steps}</Label>
                <div className="rounded-lg border bg-slate-50/40 dark:bg-slate-900/30">
                  <div className="space-y-3 p-3">
                    {formData.steps.map((step, index) => (
                      <div
                        key={step.id}
                        className="rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden bg-white dark:bg-slate-900 shadow-sm"
                      >
                        <div className="flex items-center justify-between px-3 py-2 bg-slate-100/90 dark:bg-slate-800/70 border-b border-slate-200 dark:border-slate-700">
                          <div className="flex items-center gap-2">
                            <span className="inline-flex items-center justify-center h-6 w-6 rounded-full bg-sky-500 text-white text-xs font-semibold">
                              {index + 1}
                            </span>
                            <p className="text-xs text-slate-700 dark:text-slate-200 font-semibold">
                              {t.workflows.stepLabel} {index + 1}
                            </p>
                          </div>
                          <div className="flex gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 rounded-full"
                              disabled={index === 0}
                              onClick={() => moveStep(index, -1)}
                            >
                              <ArrowUp className="w-3 h-3" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 rounded-full"
                              disabled={index === formData.steps.length - 1}
                              onClick={() => moveStep(index, 1)}
                            >
                              <ArrowDown className="w-3 h-3" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 rounded-full text-sky-600 hover:text-sky-700"
                              onClick={() => insertStepAfter(index)}
                              title={t.workflows.addStep}
                            >
                              <Plus className="w-3 h-3" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 rounded-full text-red-600 hover:text-red-700"
                              onClick={() => removeStep(step.id)}
                            >
                              <Trash2 className="w-3 h-3" />
                            </Button>
                          </div>
                        </div>
                        <div className="p-3 space-y-3">
                          <div className="space-y-1">
                            <Label className="text-xs text-slate-600 dark:text-slate-300">
                              {t.workflows.stepName}
                            </Label>
                            <Input
                              value={step.title}
                              onChange={e =>
                                updateStepTitle(step.id, e.target.value)
                              }
                              placeholder={t.workflows.stepNamePlaceholder}
                              className="h-10 bg-white dark:bg-slate-950"
                            />
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs text-slate-600 dark:text-slate-300">
                              {t.workflows.stepDescription}
                            </Label>
                            <Textarea
                              value={step.description}
                              onChange={e =>
                                updateStepDescription(step.id, e.target.value)
                              }
                              placeholder={
                                t.workflows.stepDescriptionPlaceholder
                              }
                              rows={7}
                              className="resize-y min-h-[180px] !rounded-lg bg-white dark:bg-slate-950"
                            />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {!hasValidStep ? t.workflows.requireStep : '\u00A0'}
                </p>
              </div>
            </div>
          </div>
          <DialogFooter className="flex-shrink-0 border-t border-slate-200 dark:border-slate-800 px-6 py-4">
            <Button variant="outline" onClick={() => setShowDialog(false)}>
              {t.common.cancel}
            </Button>
            <Button
              onClick={handleSave}
              disabled={!formData.name.trim() || !hasValidStep || saving}
            >
              {saving ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  {t.common.loading}
                </>
              ) : (
                t.common.save
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Recording Dialog */}
      <Dialog open={showRecordDialog} onOpenChange={(open) => {
        if (!open && isRecording) return; // Don't close while recording
        if (!open && recordingWebviewId && api) {
          api.hideWebView(recordingWebviewId);
          api.webviewDestroy(recordingWebviewId);
          setRecordingWebviewId(null);
        }
        setShowRecordDialog(open);
      }}>
        <DialogContent
          className="sm:max-w-[700px] max-h-[85vh] flex flex-col p-0 gap-0 overflow-hidden"
          onOpenAutoFocus={e => e.preventDefault()}
        >
          <DialogHeader className="flex-shrink-0 px-6 pt-6 pb-3 pr-12 border-b border-slate-200 dark:border-slate-800">
            <DialogTitle className="flex items-center gap-2">
              {isRecording && (
                <span className="relative flex h-3 w-3">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-3 w-3 bg-red-500" />
                </span>
              )}
              {isRecording ? t.workflows.recording : t.workflows.recordNew}
            </DialogTitle>
          </DialogHeader>

          <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
            <div className="space-y-4">
              {/* Name & URL inputs */}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">{t.workflows.name}</Label>
                  <Input
                    value={recordingName}
                    onChange={e => setRecordingName(e.target.value)}
                    placeholder={t.workflows.namePlaceholder}
                    disabled={isRecording}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">{t.workflows.recordingUrl}</Label>
                  <Input
                    value={recordingUrl}
                    onChange={e => setRecordingUrl(e.target.value)}
                    placeholder={t.workflows.recordingUrlPlaceholder}
                    disabled={isRecording}
                  />
                </div>
              </div>

              {/* Start/Stop recording button */}
              <div className="flex gap-2">
                {!isRecording ? (
                  <Button
                    onClick={handleStartRecording}
                    disabled={!recordingUrl.trim()}
                    className="bg-red-500 hover:bg-red-600 text-white"
                  >
                    <Circle className="w-4 h-4 mr-2" />
                    {t.workflows.recordingStart}
                  </Button>
                ) : (
                  <Button
                    onClick={handleStopRecording}
                    variant="destructive"
                  >
                    <Square className="w-4 h-4 mr-2" />
                    {t.workflows.recordingStop}
                  </Button>
                )}
                {isRecording && (
                  <span className="flex items-center text-xs text-slate-500 dark:text-slate-400">
                    <Clock className="w-3 h-3 mr-1" />
                    {recordedActions.length} {t.workflows.actionCount}
                  </span>
                )}
              </div>

              {/* Recorded actions list */}
              <div className="space-y-1">
                <Label className="text-xs">{t.workflows.recordingActions}</Label>
                <div className="rounded-lg border bg-slate-50/40 dark:bg-slate-900/30 max-h-[300px] overflow-y-auto">
                  {recordedActions.length === 0 ? (
                    <p className="text-xs text-slate-500 dark:text-slate-400 p-4 text-center">
                      {t.workflows.recordingNoActions}
                    </p>
                  ) : (
                    <div className="divide-y divide-slate-200 dark:divide-slate-700">
                      {recordedActions.map((action, index) => (
                        <div
                          key={action.id || index}
                          className="flex items-center gap-2 px-3 py-2 text-xs"
                        >
                          <span className="text-slate-400 w-5 text-right shrink-0">
                            {index + 1}
                          </span>
                          <span className="text-sky-500 shrink-0">
                            {getActionIcon(action.type)}
                          </span>
                          <span className="text-slate-600 dark:text-slate-300 truncate">
                            {getActionDescription(action)}
                          </span>
                          <span className="text-slate-400 ml-auto shrink-0">
                            {formatDuration(action.timestamp)}
                          </span>
                        </div>
                      ))}
                      <div ref={actionsEndRef} />
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          <DialogFooter className="flex-shrink-0 border-t border-slate-200 dark:border-slate-800 px-6 py-4">
            <Button
              variant="outline"
              onClick={() => {
                if (isRecording) handleStopRecording();
                if (recordingWebviewId && api) {
                  api.hideWebView(recordingWebviewId);
                  api.webviewDestroy(recordingWebviewId);
                  setRecordingWebviewId(null);
                }
                setShowRecordDialog(false);
              }}
            >
              {t.common.cancel}
            </Button>
            <Button
              onClick={handleSaveRecording}
              disabled={!recordingName.trim() || recordedActions.length === 0 || isRecording || savingRecording}
            >
              {savingRecording ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  {t.common.loading}
                </>
              ) : (
                t.workflows.recordingSave
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ==================== Sub-components ====================

function ManualWorkflowCard({
  workflow,
  t,
  onEdit,
  onDelete,
}: {
  workflow: Workflow;
  t: any;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const steps = parseWorkflowTextToSteps(workflow.text).filter(
    step => step.title.trim() || step.description.trim()
  );
  const previewSteps = steps.slice(0, 3);

  return (
    <>
      <div className="mb-4 space-y-2">
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {t.workflows.stepCount}: {steps.length}
        </p>
        {previewSteps.map((step, index) => (
          <div key={`${workflow.uuid}-preview-${index}`}>
            <p className="text-sm text-slate-600 dark:text-slate-400 line-clamp-1">
              {index + 1}. {step.title || step.description}
            </p>
            {step.description.trim() && (
              <p className="text-xs text-slate-500 dark:text-slate-400 line-clamp-1">
                {t.workflows.stepDescriptionLabel}: {step.description}
              </p>
            )}
          </div>
        ))}
        {steps.length > 3 && (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            +{steps.length - 3} {t.workflows.moreSteps}
          </p>
        )}
      </div>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={onEdit}>
          <Edit className="w-3 h-3 mr-1" />
          {t.common.edit}
        </Button>
        <Button variant="destructive" size="sm" onClick={onDelete}>
          <Trash2 className="w-3 h-3 mr-1" />
          {t.common.delete}
        </Button>
      </div>
    </>
  );
}

function RecordedWorkflowCard({
  workflow,
  t,
  onReplay,
  onDelete,
  replayStatus,
  onStopReplay,
}: {
  workflow: Workflow;
  t: any;
  onReplay: () => void;
  onDelete: () => void;
  replayStatus: WorkflowReplayStatus | null;
  onStopReplay: () => void;
}) {
  const actionCount = workflow.recording_metadata?.action_count ?? workflow.recorded_actions?.length ?? 0;
  const duration = workflow.recording_metadata?.duration_ms ?? 0;
  const isReplaying = replayStatus?.status === 'running';

  return (
    <>
      <div className="mb-4 space-y-2">
        <div className="flex items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
          <span>{actionCount} {t.workflows.actionCount}</span>
          {duration > 0 && (
            <span>{t.workflows.duration}: {formatDuration(duration)}</span>
          )}
        </div>
        {workflow.recording_url && (
          <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
            URL: {workflow.recording_url}
          </p>
        )}

        {/* Preview first 5 actions */}
        {workflow.recorded_actions && workflow.recorded_actions.length > 0 && (
          <div className="space-y-1 mt-2">
            {workflow.recorded_actions.slice(0, 5).map((action, index) => (
              <div key={action.id || index} className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-400">
                <span className="text-sky-500 shrink-0">{getActionIcon(action.type)}</span>
                <span className="truncate">{getActionDescription(action)}</span>
              </div>
            ))}
            {workflow.recorded_actions.length > 5 && (
              <p className="text-xs text-slate-400">
                +{workflow.recorded_actions.length - 5} {t.workflows.moreSteps}
              </p>
            )}
          </div>
        )}

        {/* Replay progress */}
        {replayStatus && replayStatus.status !== 'idle' && (
          <div className="mt-2 p-2 rounded-lg bg-slate-100 dark:bg-slate-800/50">
            <div className="flex items-center justify-between text-xs mb-1">
              <span className={`font-medium ${
                replayStatus.status === 'completed' ? 'text-green-600' :
                replayStatus.status === 'failed' ? 'text-red-600' :
                replayStatus.status === 'stopped' ? 'text-yellow-600' :
                'text-sky-600'
              }`}>
                {replayStatus.status === 'completed' ? t.workflows.replayCompleted :
                 replayStatus.status === 'failed' ? t.workflows.replayFailed :
                 replayStatus.status === 'stopped' ? t.workflows.replayStopped :
                 t.workflows.replayProgress}
              </span>
              <span className="text-slate-500">
                {replayStatus.currentAction}/{replayStatus.totalActions}
              </span>
            </div>
            <div className="w-full bg-slate-200 dark:bg-slate-700 rounded-full h-1.5">
              <div
                className={`h-1.5 rounded-full transition-all ${
                  replayStatus.status === 'completed' ? 'bg-green-500' :
                  replayStatus.status === 'failed' ? 'bg-red-500' :
                  'bg-sky-500'
                }`}
                style={{ width: `${replayStatus.totalActions > 0 ? (replayStatus.currentAction / replayStatus.totalActions) * 100 : 0}%` }}
              />
            </div>
            {replayStatus.errors.length > 0 && (
              <p className="text-xs text-red-500 mt-1 truncate">
                {replayStatus.errors[replayStatus.errors.length - 1].error}
              </p>
            )}
          </div>
        )}
      </div>
      <div className="flex gap-2">
        {isReplaying ? (
          <Button variant="outline" size="sm" onClick={onStopReplay}>
            <Square className="w-3 h-3 mr-1" />
            {t.workflows.replayStop}
          </Button>
        ) : (
          <Button variant="outline" size="sm" onClick={onReplay}>
            <Play className="w-3 h-3 mr-1" />
            {t.workflows.replay}
          </Button>
        )}
        <Button variant="destructive" size="sm" onClick={onDelete}>
          <Trash2 className="w-3 h-3 mr-1" />
          {t.common.delete}
        </Button>
      </div>
    </>
  );
}
