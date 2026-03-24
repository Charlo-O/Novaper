import * as React from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useTranslation } from '../lib/i18n-context';
import { DeviceMonitor } from './DeviceMonitor';
import { ChatComposer } from './ChatComposer';
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  Send,
  RotateCcw,
  ChevronLeft,
  ChevronRight,
  Layers,
  MessageSquare,
  Wrench,
  ChevronDown,
  ChevronUp,
  History,
  ListChecks,
  Square,
} from 'lucide-react';
import { MarkdownContent } from './MarkdownContent';
import type { Workflow, HistoryRecordResponse } from '../api';
import {
  abortLayeredAgentChat,
  listWorkflows,
  getErrorMessage,
  listHistory,
  clearHistory as clearHistoryApi,
  deleteHistoryRecord,
  resetLayeredAgentSession,
  sendLayeredMessageStream,
} from '../api';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { HistoryItemCard } from './HistoryItemCard';
import { useLocalStorage } from '../hooks/useLocalStorage';

interface ChatKitPanelProps {
  deviceId: string;
  deviceSerial: string; // Used for history storage
  deviceName: string;
  deviceConnectionType?: string;
  isVisible: boolean;
}

// 执行步骤类型
interface ExecutionStep {
  id: string;
  type: 'user' | 'thinking' | 'tool_call' | 'tool_result' | 'assistant';
  content: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: string;
  timestamp: Date;
  isExpanded?: boolean;
}

// 消息类型
interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  steps?: ExecutionStep[];
  isStreaming?: boolean;
  success?: boolean;
}

interface CachedExecutionStep extends Omit<ExecutionStep, 'timestamp'> {
  timestamp: string;
}

interface CachedMessage extends Omit<Message, 'timestamp' | 'steps' | 'isStreaming'> {
  timestamp: string;
  steps?: CachedExecutionStep[];
}

interface CachedChatKitState {
  input: string;
  error: string | null;
  messages: CachedMessage[];
}

function serializeStepForCache(step: ExecutionStep): CachedExecutionStep {
  return {
    ...step,
    timestamp: step.timestamp.toISOString(),
  };
}

function deserializeStepFromCache(step: CachedExecutionStep): ExecutionStep {
  return {
    ...step,
    timestamp: new Date(step.timestamp),
  };
}

function serializeMessageForCache(message: Message): CachedMessage {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    timestamp: message.timestamp.toISOString(),
    steps: message.steps?.map(serializeStepForCache),
    success: message.success,
  };
}

function deserializeMessageFromCache(message: CachedMessage): Message {
  return {
    ...message,
    timestamp: new Date(message.timestamp),
    steps: message.steps?.map(deserializeStepFromCache),
    isStreaming: false,
  };
}

export function ChatKitPanel({
  deviceId,
  deviceSerial,
  deviceName,
  deviceConnectionType,
  isVisible,
}: ChatKitPanelProps) {
  const t = useTranslation();

  // Chat state
  const [messages, setMessages] = React.useState<Message[]>([]);
  const [input, setInput] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [aborting, setAborting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [isCacheHydrated, setIsCacheHydrated] = React.useState(false);
  const [isMonitorCollapsed, setIsMonitorCollapsed] =
    useLocalStorage<boolean>('device-monitor-collapsed', true);
  const messagesEndRef = React.useRef<HTMLDivElement>(null);
  const abortControllerRef = React.useRef<{ close: () => void } | null>(null);
  const chatCacheKey = `novaper:chat:chatkit:${deviceSerial || deviceId}`;

  // Workflow state
  const [workflows, setWorkflows] = React.useState<Workflow[]>([]);
  const [showWorkflowPopover, setShowWorkflowPopover] = React.useState(false);

  // History state
  const [historyItems, setHistoryItems] = React.useState<
    HistoryRecordResponse[]
  >([]);
  const [showHistoryPopover, setShowHistoryPopover] = React.useState(false);

  React.useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  React.useEffect(
    () => () => {
      abortControllerRef.current?.close();
      abortControllerRef.current = null;
    },
    []
  );

  React.useEffect(() => {
    setIsCacheHydrated(false);

    if (typeof window === 'undefined') {
      setIsCacheHydrated(true);
      return;
    }

    try {
      const raw = window.localStorage.getItem(chatCacheKey);
      if (!raw) {
        setMessages([]);
        setInput('');
        setError(null);
        setLoading(false);
        setAborting(false);
        setIsCacheHydrated(true);
        return;
      }

      const parsed = JSON.parse(raw) as CachedChatKitState;
      const restoredMessages = Array.isArray(parsed.messages)
        ? parsed.messages.map(deserializeMessageFromCache)
        : [];

      setMessages(restoredMessages);
      setInput(typeof parsed.input === 'string' ? parsed.input : '');
      setError(typeof parsed.error === 'string' ? parsed.error : null);
      setLoading(false);
      setAborting(false);
    } catch (error) {
      console.error('Failed to restore chat cache:', error);
      setMessages([]);
      setInput('');
      setError(null);
      setLoading(false);
      setAborting(false);
    } finally {
      setIsCacheHydrated(true);
    }
  }, [chatCacheKey]);

  React.useEffect(() => {
    if (!isCacheHydrated || typeof window === 'undefined') {
      return;
    }

    if (messages.length === 0 && !input && !error) {
      window.localStorage.removeItem(chatCacheKey);
      return;
    }

    const cachedState: CachedChatKitState = {
      input,
      error,
      messages: messages.map(serializeMessageForCache),
    };

    window.localStorage.setItem(chatCacheKey, JSON.stringify(cachedState));
  }, [chatCacheKey, error, input, isCacheHydrated, messages]);

  // Load workflows
  React.useEffect(() => {
    const loadWorkflows = async () => {
      try {
        const data = await listWorkflows();
        setWorkflows(data.workflows);
      } catch (error) {
        console.error('Failed to load workflows:', error);
      }
    };
    loadWorkflows();
  }, []);

  // Load history items when popover opens
  React.useEffect(() => {
    if (showHistoryPopover) {
      const loadItems = async () => {
        try {
          const data = await listHistory(deviceSerial, 20, 0);
          setHistoryItems(data.records);
        } catch (error) {
          console.error('Failed to load history:', error);
          setHistoryItems([]);
        }
      };
      loadItems();
    }
  }, [showHistoryPopover, deviceSerial]);

  const handleExecuteWorkflow = (workflow: Workflow) => {
    setInput(workflow.text);
    setShowWorkflowPopover(false);
  };

  const handleSelectHistory = (record: HistoryRecordResponse) => {
    const userMessage: Message = {
      id: `${record.id}-user`,
      role: 'user',
      content: record.task_text,
      timestamp: new Date(record.start_time),
    };
    const agentMessage: Message = {
      id: `${record.id}-agent`,
      role: 'assistant',
      content: record.final_message,
      timestamp: record.end_time
        ? new Date(record.end_time)
        : new Date(record.start_time),
      steps: [],
      success: record.success,
      isStreaming: false,
    };
    setMessages([userMessage, agentMessage]);
    setShowHistoryPopover(false);
  };

  const handleClearHistory = async () => {
    if (confirm(t.history?.clearAllConfirm || 'Clear all history?')) {
      try {
        await clearHistoryApi(deviceSerial);
        setHistoryItems([]);
      } catch (error) {
        console.error('Failed to clear history:', error);
      }
    }
  };

  const handleDeleteHistoryItem = async (itemId: string) => {
    try {
      await deleteHistoryRecord(deviceSerial, itemId);
      setHistoryItems(prev => prev.filter(item => item.id !== itemId));
    } catch (error) {
      console.error('Failed to delete history item:', error);
    }
  };

  // Toggle step expansion
  const toggleStepExpansion = (messageId: string, stepId: string) => {
    setMessages(prev =>
      prev.map(msg =>
        msg.id === messageId
          ? {
              ...msg,
              steps: msg.steps?.map(step =>
                step.id === stepId
                  ? { ...step, isExpanded: !step.isExpanded }
                  : step
              ),
            }
          : msg
      )
    );
  };

  // Send message using Layered Agent API
  const handleSend = React.useCallback(async () => {
    const inputValue = input.trim();
    if (!inputValue || loading) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: inputValue,
      timestamp: new Date(),
    };

    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setLoading(true);
    setError(null);

    const agentMessageId = (Date.now() + 1).toString();
    const agentMessage: Message = {
      id: agentMessageId,
      role: 'assistant',
      content: '',
      timestamp: new Date(),
      steps: [],
      isStreaming: true,
    };

    setMessages(prev => [...prev, agentMessage]);

    const steps: ExecutionStep[] = [];
    const syncSteps = () => {
      setMessages(prev =>
        prev.map(msg =>
          msg.id === agentMessageId ? { ...msg, steps: [...steps] } : msg
        )
      );
    };

    abortControllerRef.current = sendLayeredMessageStream(inputValue, deviceId, {
      onToolCall: event => {
        steps.push({
          id: `step-${Date.now()}-${Math.random()}`,
          type: 'tool_call',
          content:
            event.tool_name === 'chat'
              ? 'Send instruction to execution layer'
              : event.tool_name === 'list_devices'
                ? 'Load available devices'
                : `Call tool: ${event.tool_name}`,
          toolName: event.tool_name,
          toolArgs: event.tool_args,
          timestamp: new Date(),
          isExpanded: true,
        });
        syncSteps();
      },
      onToolResult: event => {
        steps.push({
          id: `step-${Date.now()}-${Math.random()}`,
          type: 'tool_result',
          content:
            event.tool_name === 'chat'
              ? 'Execution layer result'
              : `${event.tool_name} result`,
          toolResult: event.result,
          timestamp: new Date(),
          isExpanded: true,
        });
        syncSteps();
      },
      onMessage: event => {
        setMessages(prev =>
          prev.map(msg =>
            msg.id === agentMessageId ? { ...msg, content: event.content } : msg
          )
        );
      },
      onDone: event => {
        setMessages(prev =>
          prev.map(msg =>
            msg.id === agentMessageId
              ? {
                  ...agentMessage,
                  content: event.content,
                  isStreaming: false,
                  success: event.success,
                  steps: [...steps],
                  timestamp: new Date(),
                }
              : msg
          )
        );
        setLoading(false);
        abortControllerRef.current = null;
      },
      onError: event => {
        const errorMessage = getErrorMessage(event.message);
        setError(errorMessage);
        setMessages(prev =>
          prev.map(msg =>
            msg.id === agentMessageId
              ? {
                  ...agentMessage,
                  content: `Error: ${errorMessage}`,
                  isStreaming: false,
                  success: false,
                  steps: [...steps],
                  timestamp: new Date(),
                }
              : msg
          )
        );
        setLoading(false);
        abortControllerRef.current = null;
      },
    });
  }, [input, loading, deviceId]);

  const handleAbort = React.useCallback(() => {
    if (!abortControllerRef.current) return;

    setAborting(true);

    try {
      abortControllerRef.current.close();
      abortControllerRef.current = null;
      void abortLayeredAgentChat(deviceId).catch(e =>
        console.error('Backend abort failed:', e)
      );
    } catch (error) {
      console.error('Failed to abort chat:', error);
    } finally {
      setLoading(false);
      setAborting(false);
    }
  }, [deviceId]);

  const handleReset = React.useCallback(async () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.close();
      abortControllerRef.current = null;
    }
    setMessages([]);
    setError(null);
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(chatCacheKey);
    }
    try {
      await resetLayeredAgentSession(deviceId);
    } catch (e) {
      console.warn('Failed to reset backend session:', e);
    }
  }, [chatCacheKey, deviceId]);

  return (
    <div className="flex min-h-0 flex-1 items-stretch justify-center gap-3 p-3 md:gap-4 md:p-4 xl:gap-5">
      {/* Chat Area with Execution Steps */}
      <Card className="flex min-h-0 min-w-0 flex-[1_1_0%] flex-col overflow-hidden border-0 bg-white shadow-none dark:bg-slate-950">
        {/* Header */}
        <div className="flex items-center justify-between p-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-purple-500/10">
              <Layers className="h-5 w-5 text-purple-500" />
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <h2 className="font-bold text-slate-900 dark:text-slate-100">
                  {t.chatkit?.title || 'AI Agent'}
                </h2>
                <span className="relative flex h-2.5 w-2.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-500" />
                </span>
                {deviceConnectionType && (
                  <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 uppercase font-medium">
                    {deviceConnectionType}
                  </Badge>
                )}
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {deviceName} • {t.chatkit?.layeredAgent || '分层代理模式'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge
              variant="secondary"
              className="bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300"
            >
              {t.chatkit?.layeredAgent || '分层代理模式'}
            </Badge>
            {/* History button with Popover */}
            <Popover
              open={showHistoryPopover}
              onOpenChange={setShowHistoryPopover}
            >
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 rounded-full text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300"
                  title={t.history?.title || 'History'}
                >
                  <History className="h-4 w-4" />
                </Button>
              </PopoverTrigger>

              <PopoverContent className="w-96 p-0" align="end" sideOffset={8}>
                {/* Header */}
                <div className="flex items-center justify-between p-4 border-b border-slate-200 dark:border-slate-800">
                  <h3 className="font-semibold text-sm text-slate-900 dark:text-slate-100">
                    {t.history?.title || 'History'}
                  </h3>
                  {historyItems.length > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleClearHistory}
                      className="h-7 text-xs"
                    >
                      {t.history?.clearAll || 'Clear All'}
                    </Button>
                  )}
                </div>

                {/* Scrollable content */}
                <ScrollArea className="h-[400px]">
                  <div className="p-4 space-y-2">
                    {historyItems.length > 0 ? (
                      historyItems.map(item => (
                        <HistoryItemCard
                          key={item.id}
                          item={item}
                          onSelect={handleSelectHistory}
                          onDelete={handleDeleteHistoryItem}
                        />
                      ))
                    ) : (
                      <div className="text-center py-8">
                        <History className="h-12 w-12 text-slate-300 dark:text-slate-700 mx-auto mb-3" />
                        <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
                          {t.history?.noHistory || 'No history yet'}
                        </p>
                        <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                          {t.history?.noHistoryDescription ||
                            'Your completed tasks will appear here'}
                        </p>
                      </div>
                    )}
                  </div>
                </ScrollArea>
              </PopoverContent>
            </Popover>
            <Button
              variant="ghost"
              size="icon"
              onClick={handleReset}
              className="h-8 w-8 rounded-full"
              title="重置对话"
            >
              <RotateCcw className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setIsMonitorCollapsed(prev => !prev)}
              className="h-8 w-8 rounded-full text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300"
              title={isMonitorCollapsed ? 'Show device monitor' : 'Hide device monitor'}
              aria-label={isMonitorCollapsed ? 'Show device monitor' : 'Hide device monitor'}
            >
              {isMonitorCollapsed ? (
                <ChevronLeft className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>

        {/* Error message */}
        {error && (
          <div className="mx-4 mt-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl text-sm text-red-600 dark:text-red-400 flex items-center gap-2">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            {error}
          </div>
        )}

        {/* Messages with Execution Steps */}
        <ScrollArea className="flex-1 min-h-0">
          <div className="p-4 space-y-4">
            {messages.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center py-12">
                <div className="flex h-16 w-16 items-center justify-center rounded-full bg-purple-100 dark:bg-purple-900/30 mb-4">
                  <Layers className="h-8 w-8 text-purple-500" />
                </div>
                <p className="font-medium text-slate-900 dark:text-slate-100">
                  {t.chatkit?.title || '分层代理模式'}
                </p>
                <p className="mt-1 text-sm text-slate-500 dark:text-slate-400 max-w-xs">
                  {t.chatkit?.layeredAgentDesc ||
                    '决策模型负责规划任务，视觉模型负责执行。你可以看到每一步的执行过程。'}
                </p>
              </div>
            ) : (
              messages.map(message => (
                <div key={message.id} className="space-y-2">
                  {message.role === 'user' ? (
                    <div className="flex justify-end">
                      <div className="max-w-[80%]">
                        <div className="bg-purple-600 text-white px-4 py-2 rounded-2xl rounded-br-sm">
                          <p className="whitespace-pre-wrap">
                            {message.content}
                          </p>
                        </div>
                        <p className="text-xs text-slate-400 mt-1 text-right">
                          {message.timestamp.toLocaleTimeString()}
                        </p>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {/* Execution Steps */}
                      {message.steps && message.steps.length > 0 && (
                        <div className="space-y-2">
                          {message.steps.map((step, idx) => (
                            <div
                              key={step.id}
                              className="bg-slate-50 dark:bg-slate-800/50 rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden"
                            >
                              {/* Step Header */}
                              <button
                                onClick={() =>
                                  toggleStepExpansion(message.id, step.id)
                                }
                                className="w-full flex items-center justify-between p-3 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                              >
                                <div className="flex items-center gap-2">
                                  <div
                                    className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium ${
                                      step.type === 'tool_call'
                                        ? 'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400'
                                        : 'bg-green-100 text-green-600 dark:bg-green-900/30 dark:text-green-400'
                                    }`}
                                  >
                                    {step.type === 'tool_call' ? (
                                      <Wrench className="w-3 h-3" />
                                    ) : (
                                      <MessageSquare className="w-3 h-3" />
                                    )}
                                  </div>
                                  <span className="text-sm font-medium text-slate-700 dark:text-slate-300">
                                    Step {idx + 1}: {step.content}
                                  </span>
                                </div>
                                {step.isExpanded ? (
                                  <ChevronUp className="w-4 h-4 text-slate-400" />
                                ) : (
                                  <ChevronDown className="w-4 h-4 text-slate-400" />
                                )}
                              </button>

                              {/* Step Content */}
                              {step.isExpanded && (
                                <div className="px-3 pb-3 space-y-2">
                                  {step.type === 'tool_call' &&
                                    step.toolArgs && (
                                      <div className="bg-white dark:bg-slate-900 rounded-lg p-3 text-sm">
                                        <p className="text-xs text-slate-500 mb-1 font-medium">
                                          {step.toolName === 'chat'
                                            ? '发送给 Phone Agent 的指令:'
                                            : '工具参数:'}
                                        </p>
                                        {step.toolName === 'chat' ? (
                                          <p className="text-slate-700 dark:text-slate-300 whitespace-pre-wrap">
                                            {(
                                              step.toolArgs as {
                                                message?: string;
                                              }
                                            ).message ||
                                              JSON.stringify(
                                                step.toolArgs,
                                                null,
                                                2
                                              )}
                                          </p>
                                        ) : (
                                          <pre className="text-xs text-slate-600 dark:text-slate-400 overflow-x-auto">
                                            {JSON.stringify(
                                              step.toolArgs,
                                              null,
                                              2
                                            )}
                                          </pre>
                                        )}
                                      </div>
                                    )}
                                  {step.type === 'tool_result' &&
                                    step.toolResult && (
                                      <div className="bg-white dark:bg-slate-900 rounded-lg p-3 text-sm">
                                        <p className="text-xs text-slate-500 mb-1 font-medium">
                                          执行结果:
                                        </p>
                                        <MarkdownContent
                                          content={
                                            typeof step.toolResult === 'string'
                                              ? step.toolResult
                                              : JSON.stringify(
                                                  step.toolResult,
                                                  null,
                                                  2
                                                )
                                          }
                                          className="text-xs text-slate-600 dark:text-slate-400"
                                        />
                                      </div>
                                    )}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Final Response */}
                      {message.content && (
                        <div className="flex justify-start">
                          <div
                            className={`max-w-[85%] rounded-2xl rounded-tl-sm px-4 py-3 ${
                              message.success === false
                                ? 'bg-red-100 dark:bg-red-900/20 text-red-600 dark:text-red-400'
                                : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300'
                            }`}
                          >
                            <div className="flex items-start gap-2">
                              {message.success !== undefined && (
                                <CheckCircle2
                                  className={`w-5 h-5 flex-shrink-0 mt-0.5 ${
                                    message.success
                                      ? 'text-green-500'
                                      : 'text-red-500'
                                  }`}
                                />
                              )}
                              <MarkdownContent
                                content={message.content}
                                className="text-sm min-w-0"
                              />
                            </div>
                          </div>
                        </div>
                      )}

                      {/* Streaming indicator */}
                      {message.isStreaming && !message.content && (
                        <div className="flex items-center gap-2 text-sm text-slate-500">
                          <Loader2 className="w-4 h-4 animate-spin" />
                          正在思考和执行...
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))
            )}
            <div ref={messagesEndRef} />
          </div>
        </ScrollArea>

        {/* Input area */}
        <div className="bg-slate-50/60 p-0 dark:bg-slate-950/40">
          <ChatComposer
            value={input}
            onChange={setInput}
            onSubmit={() => void handleSend()}
            placeholder="描述你想要完成的任务..."
            disabled={loading}
            className="w-full border-slate-200/80 bg-white dark:border-slate-800/80 dark:bg-slate-900"
            compactMaxHeight={200}
            expandedMaxHeight={460}
            storageKey="layered-chat-composer"
            footerStart={
              <Tooltip>
              <TooltipTrigger asChild>
                <Popover
                  open={showWorkflowPopover}
                  onOpenChange={setShowWorkflowPopover}
                >
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      size="icon-sm"
                      className="rounded-full"
                    >
                      <ListChecks className="h-4 w-4" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="start" className="w-72 p-3">
                    <div className="space-y-2">
                      <h4 className="font-medium text-sm">
                        {t.workflows?.selectWorkflow || 'Select Workflow'}
                      </h4>
                      {workflows.length === 0 ? (
                        <div className="text-sm text-slate-500 dark:text-slate-400 space-y-1">
                          <p>{t.workflows?.empty || 'No workflows yet'}</p>
                          <p>
                            前往{' '}
                            <a
                              href="/workflows"
                              className="text-primary underline"
                            >
                              工作流
                            </a>{' '}
                            页面创建。
                          </p>
                        </div>
                      ) : (
                        <ScrollArea className="h-64">
                          <div className="space-y-1">
                            {workflows.map(workflow => (
                              <button
                                key={workflow.uuid}
                                onClick={() => handleExecuteWorkflow(workflow)}
                                className="w-full text-left p-2 rounded hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                              >
                                <div className="font-medium text-sm">
                                  {workflow.name}
                                </div>
                                <div className="text-xs text-slate-500 dark:text-slate-400 line-clamp-2">
                                  {workflow.text}
                                </div>
                              </button>
                            ))}
                          </div>
                        </ScrollArea>
                      )}
                    </div>
                  </PopoverContent>
                </Popover>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={8} className="max-w-xs">
                <div className="space-y-1">
                  <p className="font-medium">
                    {t.devicePanel?.tooltips?.workflowButton ||
                      'Quick Workflow'}
                  </p>
                  <p className="text-xs opacity-80">
                    {t.devicePanel?.tooltips?.workflowButtonDesc ||
                      'Select a workflow to quickly fill in the task'}
                  </p>
                </div>
              </TooltipContent>
              </Tooltip>
            }
            footerEnd={
              loading ? (
                <Button
                  onClick={() => void handleAbort()}
                  disabled={aborting}
                  size="icon"
                  variant="destructive"
                  className="h-10 w-10 rounded-full"
                  title={t.chat?.abortChat || '中断任务'}
                >
                  {aborting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Square className="h-4 w-4" />
                  )}
                </Button>
              ) : (
                <Button
                  onClick={() => void handleSend()}
                  disabled={!input.trim()}
                  size="icon"
                  className="h-10 w-10 rounded-full bg-purple-600 hover:bg-purple-700"
                >
                  <Send className="h-4 w-4" />
                </Button>
              )
            }
          />
        </div>
      </Card>

      {!isMonitorCollapsed ? (
      <DeviceMonitor
        deviceId={deviceId}
        serial={deviceSerial}
        connectionType={deviceConnectionType}
        isTaskActive={loading}
        isVisible={isVisible}
        isCollapsed={isMonitorCollapsed}
        onCollapsedChange={setIsMonitorCollapsed}
      />
      ) : null}
    </div>
  );
}

