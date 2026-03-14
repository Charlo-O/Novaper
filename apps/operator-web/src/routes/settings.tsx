import { createFileRoute } from '@tanstack/react-router';
import * as React from 'react';
import { useState, useEffect, useCallback } from 'react';
import {
  Settings,
  Globe,
  Github,
  Smartphone,
  ExternalLink,
  Eye,
  EyeOff,
  Server,
  Brain,
  Sparkles,
  Cpu,
  Info,
  ShieldCheck,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useLocale, useTranslation } from '../lib/i18n-context';
import { ThemeToggle } from '../components/ThemeToggle';
import { Toast, type ToastType } from '../components/Toast';
import {
  getStatus,
  checkVersion,
  getConfig,
  getAuthStatus,
  saveConfig,
  startCodexOAuthLogin,
  getErrorMessage,
  type VersionCheckResponse,
  type ConfigSaveRequest,
  type AuthStatusResponse,
} from '../api';

export const Route = createFileRoute('/settings')({
  component: SettingsComponent,
});

const CODEX_PRESET_NAME = 'codex';
const CODEX_AGENT_NAME = 'codex-agent';
const CODEX_BACKEND_AGENT_NAME = 'glm-async';
const CODEX_DEFAULT_MODEL = 'gpt-5.4';

const VISION_PRESETS = [
  {
    name: 'bigmodel',
    config: {
      base_url: 'https://open.bigmodel.cn/api/paas/v4',
      model_name: 'autoglm-phone',
    },
    apiKeyUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
  },
  {
    name: 'modelscope',
    config: {
      base_url: 'https://api-inference.modelscope.cn/v1',
      model_name: 'ZhipuAI/AutoGLM-Phone-9B',
    },
    apiKeyUrl: 'https://www.modelscope.cn/my/myaccesstoken',
  },
  {
    name: 'custom',
    config: {
      base_url: '',
      model_name: 'autoglm-phone-9b',
    },
  },
  {
    name: CODEX_PRESET_NAME,
    config: {
      base_url: '',
      model_name: CODEX_DEFAULT_MODEL,
    },
    authAction: true,
  },
] as const;

const AGENT_PRESETS = [
  {
    name: 'glm-async',
    displayName: 'GLM Agent',
    description: '基于 GLM 模型优化，成熟稳定，适合大多数任务',
    icon: Cpu,
    defaultConfig: {},
  },
  {
    name: 'mai',
    displayName: 'MAI Agent',
    description: '阿里通义团队开发，支持多张历史截图上下文',
    icon: Brain,
    defaultConfig: { history_n: 3 },
  },
  {
    name: 'gemini',
    displayName: 'Gemini Agent',
    description: '通用视觉模型，支持 Gemini/GPT-4o 等，使用 Function Calling',
    icon: Sparkles,
    defaultConfig: {},
  },
  {
    name: 'droidrun',
    displayName: 'DroidRun Agent',
    description: '基于 DroidRun 框架，需安装 Portal APK',
    icon: Smartphone,
    defaultConfig: {},
  },
  {
    name: 'midscene',
    displayName: 'Midscene Agent',
    description: '基于 Midscene.js 视觉驱动，需要 Node.js 环境',
    icon: Eye,
    defaultConfig: { model_family: 'doubao-vision' },
  },
  {
    name: CODEX_AGENT_NAME,
    displayName: 'Codex Agent',
    description: 'Use Codex OAuth through Codex.',
    icon: ShieldCheck,
    defaultConfig: {},
  },
] as const;

const DECISION_PRESETS = [
  {
    name: 'bigmodel',
    config: {
      decision_base_url: 'https://open.bigmodel.cn/api/paas/v4',
      decision_model_name: 'glm-4.7',
    },
    apiKeyUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
  },
  {
    name: 'modelscope',
    config: {
      decision_base_url: 'https://api-inference.modelscope.cn/v1',
      decision_model_name: 'Qwen/Qwen3-235B-A22B-Instruct-2507',
    },
    apiKeyUrl: 'https://www.modelscope.cn/my/myaccesstoken',
  },
  {
    name: 'custom',
    config: {
      decision_base_url: '',
      decision_model_name: '',
    },
  },
  {
    name: CODEX_PRESET_NAME,
    config: {
      decision_base_url: '',
      decision_model_name: CODEX_DEFAULT_MODEL,
    },
    authAction: true,
  },
] as const;

function inferVisionProvider(config: Partial<ConfigSaveRequest> | null | undefined) {
  if (!config) return VISION_PRESETS[0].name;
  if (config.vision_provider) return config.vision_provider;
  const matched = VISION_PRESETS.find(preset => {
    if ('authAction' in preset) {
      return config.model_name === preset.config.model_name && !config.base_url;
    }
    return config.base_url === preset.config.base_url;
  });
  return matched?.name || 'custom';
}

function inferDecisionProvider(config: Partial<ConfigSaveRequest> | null | undefined) {
  if (!config) return DECISION_PRESETS[0].name;
  if (config.decision_provider) return config.decision_provider;
  const matched = DECISION_PRESETS.find(preset => {
    if ('authAction' in preset) {
      return (
        config.decision_model_name === preset.config.decision_model_name &&
        !config.decision_base_url
      );
    }
    return config.decision_base_url === preset.config.decision_base_url;
  });
  return matched?.name || 'custom';
}

type ElectronRelaunchAPI = {
  app?: {
    relaunch: () => Promise<{ success: boolean }>;
  };
};

function SettingsComponent() {
  const t = useTranslation();
  const { locale, setLocale, localeName } = useLocale();
  const buildBackendVersion = __BACKEND_VERSION__ || 'unknown';
  const [backendVersion, setBackendVersion] = React.useState<string | null>(null);
  const [versionMismatch, setVersionMismatch] = React.useState(false);
  const [updateInfo, setUpdateInfo] =
    React.useState<VersionCheckResponse | null>(null);
  const [toast, setToast] = useState<{
    message: string;
    type: ToastType;
    visible: boolean;
  }>({ message: '', type: 'info', visible: false });

  // API Config state
  const [showApiKey, setShowApiKey] = useState(false);
  const [config, setConfig] = useState<ConfigSaveRequest | null>(null);
  const [authStatus, setAuthStatus] = useState<AuthStatusResponse | null>(null);
  const [authPending, setAuthPending] = useState(false);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [tempConfig, setTempConfig] = useState({
    vision_provider: VISION_PRESETS[0].name as string,
    base_url: VISION_PRESETS[0].config.base_url as string,
    model_name: VISION_PRESETS[0].config.model_name as string,
    api_key: '',
    agent_type: 'glm-async',
    agent_config_params: {} as Record<string, unknown>,
    default_max_steps: 100,
    layered_max_turns: 50,
    decision_provider: DECISION_PRESETS[0].name as string,
    decision_base_url: '',
    decision_model_name: '',
    decision_api_key: '',
  });

  const codexAuth = authStatus?.providers.codexOAuth;
  const codexAuthenticated = Boolean(codexAuth?.authenticated);
  const codexLoginBusy = Boolean(codexAuth?.loginInProgress || authPending);
  const isVisionCodeX = tempConfig.vision_provider === CODEX_PRESET_NAME;
  const isDecisionCodeX = tempConfig.decision_provider === CODEX_PRESET_NAME;

  const showToast = (message: string, type: ToastType = 'info') => {
    setToast({ message, type, visible: true });
  };

  const refreshAuthStatus = useCallback(async () => {
    try {
      const nextStatus = await getAuthStatus();
      setAuthStatus(nextStatus);
      return nextStatus;
    } catch (error) {
      console.error('Failed to load auth status:', error);
      return null;
    }
  }, []);

  const handleStartCodexAuth = useCallback(async () => {
    try {
      setAuthPending(true);
      const login = await startCodexOAuthLogin();
      window.open(login.authorizeUrl, '_blank', 'noopener,noreferrer');
      await refreshAuthStatus();
      showToast('认证页面已打开，请在浏览器中完成登录', 'info');
    } catch (error) {
      showToast(getErrorMessage(error), 'error');
    } finally {
      setAuthPending(false);
    }
  }, [refreshAuthStatus]);

  const openExternalPage = useCallback((url: string) => {
    window.open(url, '_blank', 'noopener,noreferrer');
  }, []);

  const applyVisionPreset = useCallback(
    (preset: (typeof VISION_PRESETS)[number]) => {
      setTempConfig(prev => ({
        ...prev,
        vision_provider: preset.name,
        base_url: preset.config.base_url,
        model_name: preset.config.model_name,
        agent_type:
          preset.name === CODEX_PRESET_NAME ? CODEX_AGENT_NAME : prev.agent_type,
        agent_config_params:
          preset.name === CODEX_PRESET_NAME ? {} : prev.agent_config_params,
      }));
    },
    []
  );

  const applyDecisionPreset = useCallback(
    (preset: (typeof DECISION_PRESETS)[number]) => {
      setTempConfig(prev => ({
        ...prev,
        decision_provider: preset.name,
        decision_base_url: preset.config.decision_base_url,
        decision_model_name: preset.config.decision_model_name,
        agent_type:
          preset.name === CODEX_PRESET_NAME ? CODEX_AGENT_NAME : prev.agent_type,
        agent_config_params:
          preset.name === CODEX_PRESET_NAME ? {} : prev.agent_config_params,
      }));
    },
    []
  );

  // Load config on mount
  useEffect(() => {
    const loadConfiguration = async () => {
      try {
        const [data, auth] = await Promise.all([
          getConfig(),
          getAuthStatus().catch(() => null),
        ]);
        const visionProvider = data.vision_provider || inferVisionProvider(data);
        const decisionProvider = data.decision_provider || inferDecisionProvider(data);
        const usesCodeX =
          visionProvider === CODEX_PRESET_NAME ||
          decisionProvider === CODEX_PRESET_NAME;
        const useDefaultConfig =
          !data.base_url && !data.model_name && visionProvider !== CODEX_PRESET_NAME;
        const useDefaultDecisionConfig =
          !data.decision_base_url &&
          !data.decision_model_name &&
          decisionProvider !== CODEX_PRESET_NAME;
        const nextAgentType = usesCodeX
          ? CODEX_AGENT_NAME
          : data.agent_type || 'glm-async';
        setAuthStatus(auth);
        setConfig({
          vision_provider: visionProvider,
          base_url: data.base_url,
          model_name: data.model_name,
          api_key: data.api_key || undefined,
          agent_type: nextAgentType,
          agent_config_params: data.agent_config_params || undefined,
          default_max_steps: data.default_max_steps || 100,
          layered_max_turns: data.layered_max_turns || 50,
          decision_provider: decisionProvider,
          decision_base_url: data.decision_base_url || undefined,
          decision_model_name: data.decision_model_name || undefined,
          decision_api_key: data.decision_api_key || undefined,
        });
        setTempConfig({
          vision_provider: visionProvider,
          base_url: useDefaultConfig
            ? VISION_PRESETS[0].config.base_url
            : data.base_url,
          model_name: useDefaultConfig
            ? VISION_PRESETS[0].config.model_name
            : data.model_name || (usesCodeX ? CODEX_DEFAULT_MODEL : ''),
          api_key: data.api_key || '',
          agent_type: nextAgentType,
          agent_config_params: data.agent_config_params || {},
          default_max_steps: data.default_max_steps || 100,
          layered_max_turns: data.layered_max_turns || 50,
          decision_provider: decisionProvider,
          decision_base_url: useDefaultDecisionConfig
            ? DECISION_PRESETS[0].config.decision_base_url
            : data.decision_base_url || '',
          decision_model_name: useDefaultDecisionConfig
            ? DECISION_PRESETS[0].config.decision_model_name
            : data.decision_model_name ||
              (decisionProvider === CODEX_PRESET_NAME ? CODEX_DEFAULT_MODEL : 'glm-4.7'),
          decision_api_key: data.decision_api_key || '',
        });
      } catch (err) {
        console.error('Failed to load config:', err);
      } finally {
        setConfigLoaded(true);
      }
    };
    loadConfiguration();
  }, []);

  // Poll codex auth status
  useEffect(() => {
    if (!codexAuth?.loginInProgress) return;
    const timer = window.setInterval(() => {
      void refreshAuthStatus();
    }, 2000);
    return () => clearInterval(timer);
  }, [codexAuth?.loginInProgress, refreshAuthStatus]);

  // Auto-select Codex Agent when vision is codex
  useEffect(() => {
    if (isVisionCodeX && tempConfig.agent_type !== CODEX_AGENT_NAME) {
      setTempConfig(prev => ({
        ...prev,
        agent_type: CODEX_AGENT_NAME,
        agent_config_params: {},
      }));
    }
  }, [isVisionCodeX, tempConfig.agent_type]);

  const handleSaveConfig = async () => {
    if (!isVisionCodeX && !tempConfig.base_url) {
      showToast(t.chat.baseUrlRequired, 'error');
      return;
    }
    if (isVisionCodeX && !codexAuthenticated) {
      showToast('请先完成 Codex 认证', 'error');
      return;
    }

    try {
      const nextAgentType =
        tempConfig.agent_type === CODEX_AGENT_NAME
          ? CODEX_BACKEND_AGENT_NAME
          : tempConfig.agent_type;
      const nextAgentConfig =
        Object.keys(tempConfig.agent_config_params).length === 0
          ? undefined
          : tempConfig.agent_config_params;
      const nextModelName = isVisionCodeX
        ? tempConfig.model_name || CODEX_DEFAULT_MODEL
        : tempConfig.model_name || 'autoglm-phone-9b';
      const nextDecisionModelName = isDecisionCodeX
        ? tempConfig.decision_model_name || CODEX_DEFAULT_MODEL
        : tempConfig.decision_model_name || undefined;

      const saveResult = await saveConfig({
        vision_provider: tempConfig.vision_provider,
        base_url: tempConfig.base_url,
        model_name: nextModelName,
        api_key: tempConfig.api_key || undefined,
        agent_type: nextAgentType,
        agent_config_params: nextAgentConfig,
        default_max_steps: tempConfig.default_max_steps,
        layered_max_turns: tempConfig.layered_max_turns,
        decision_provider: tempConfig.decision_provider,
        decision_base_url: tempConfig.decision_base_url || undefined,
        decision_model_name: nextDecisionModelName,
        decision_api_key: tempConfig.decision_api_key || undefined,
      });

      setConfig({
        vision_provider: tempConfig.vision_provider,
        base_url: tempConfig.base_url,
        model_name: nextModelName,
        api_key: tempConfig.api_key || undefined,
        agent_type: nextAgentType,
        agent_config_params: nextAgentConfig,
        default_max_steps: tempConfig.default_max_steps,
        layered_max_turns: tempConfig.layered_max_turns,
        decision_provider: tempConfig.decision_provider,
        decision_base_url: tempConfig.decision_base_url || undefined,
        decision_model_name: nextDecisionModelName,
        decision_api_key: tempConfig.decision_api_key || undefined,
      });
      setTempConfig(prev => ({
        ...prev,
        model_name: nextModelName,
        decision_model_name: nextDecisionModelName || '',
      }));

      showToast(t.toasts.configSaved, 'success');

      const electronApp = (
        window as Window & { electronAPI?: ElectronRelaunchAPI }
      ).electronAPI?.app;

      if (saveResult.restart_required && electronApp?.relaunch) {
        showToast('配置已保存，应用将立即重启以应用新配置', 'warning');
        await new Promise(resolve => setTimeout(resolve, 600));
        await electronApp.relaunch();
        return;
      }

      if (saveResult.restart_required) {
        showToast('配置已保存，请手动重启应用以立即生效', 'warning');
      }
    } catch (err) {
      console.error('Failed to save config:', err);
      showToast(`Failed to save: ${getErrorMessage(err)}`, 'error');
    }
  };

  // Version check
  useEffect(() => {
    getStatus()
      .then(status => {
        setBackendVersion(status.version);
        if (
          buildBackendVersion !== 'unknown' &&
          status.version !== buildBackendVersion
        ) {
          setVersionMismatch(true);
        }
      })
      .catch(() => setBackendVersion(null));

    const checkForUpdates = async () => {
      const cachedCheck = sessionStorage.getItem('version_check');
      if (cachedCheck) {
        try {
          const { data, timestamp } = JSON.parse(cachedCheck);
          if (Date.now() - timestamp < 3600000) {
            setUpdateInfo(data);
            return;
          }
        } catch {
          // Invalid cache
        }
      }
      try {
        const result = await checkVersion();
        setUpdateInfo(result);
        sessionStorage.setItem(
          'version_check',
          JSON.stringify({ data: result, timestamp: Date.now() })
        );
      } catch {
        // Non-critical
      }
    };
    checkForUpdates();
  }, [buildBackendVersion]);

  const displayedVersion = backendVersion ?? buildBackendVersion;

  const toggleLocale = () => {
    setLocale(locale === 'en' ? 'zh' : 'en');
  };

  return (
    <div className="h-full overflow-auto">
      {toast.visible && (
        <Toast
          message={toast.message}
          type={toast.type}
          onClose={() => setToast(prev => ({ ...prev, visible: false }))}
        />
      )}

      <div className="max-w-2xl mx-auto p-6 space-y-6">
        {/* Page Header */}
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 dark:bg-slate-800">
            <Settings className="h-5 w-5 text-slate-600 dark:text-slate-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">
              {t.settings?.title || 'Settings'}
            </h1>
          </div>
        </div>

        {/* API Configuration - inline */}
        <Card>
          <CardContent className="p-5 space-y-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Settings className="h-5 w-5 text-[#1d9bf0]" />
                <h2 className="font-semibold text-slate-900 dark:text-slate-100">
                  {t.settings?.apiConfiguration || 'API Configuration'}
                </h2>
              </div>
              <Button
                variant="twitter"
                size="sm"
                onClick={() => void handleSaveConfig()}
              >
                <CheckCircle2 className="w-4 h-4 mr-2" />
                {t.chat.saveConfig}
              </Button>
            </div>

            {configLoaded && (
              <Tabs defaultValue="vision" className="w-full">
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="vision">
                    <Eye className="w-4 h-4 mr-2" />
                    {t.chat.visionModelTab}
                  </TabsTrigger>
                  <TabsTrigger value="decision">
                    <Brain className="w-4 h-4 mr-2" />
                    {t.chat.decisionModelTab}
                  </TabsTrigger>
                </TabsList>

                {/* Vision Model Tab */}
                <TabsContent value="vision" className="space-y-4 mt-4">
                  {/* Vision Presets */}
                  <div className="space-y-2">
                    <Label className="text-sm font-medium">
                      {t.chat.selectPreset}
                    </Label>
                    <div className="grid grid-cols-1 gap-2">
                      {VISION_PRESETS.map(preset => (
                        <div key={preset.name} className="relative">
                          <button
                            type="button"
                            onClick={() => applyVisionPreset(preset)}
                            className={`w-full text-left p-3 rounded-lg border transition-all ${
                              tempConfig.vision_provider === preset.name
                                ? 'border-[#1d9bf0] bg-[#1d9bf0]/5'
                                : 'border-slate-200 dark:border-slate-700 hover:border-[#1d9bf0]/50 hover:bg-slate-50 dark:hover:bg-slate-800/50'
                            }`}
                          >
                            <div className="flex items-center gap-2">
                              <Server
                                className={`w-4 h-4 ${
                                  tempConfig.vision_provider === preset.name
                                    ? 'text-[#1d9bf0]'
                                    : 'text-slate-400 dark:text-slate-500'
                                }`}
                              />
                              <span className="font-medium text-sm text-slate-900 dark:text-slate-100">
                                {
                                  t.presetConfigs[
                                    preset.name as keyof typeof t.presetConfigs
                                  ].name
                                }
                              </span>
                            </div>
                            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 ml-6">
                              {
                                t.presetConfigs[
                                  preset.name as keyof typeof t.presetConfigs
                                ].description
                              }
                            </p>
                          </button>
                          {'apiKeyUrl' in preset ? (
                            <button
                              type="button"
                              onClick={e => {
                                e.stopPropagation();
                                openExternalPage(preset.apiKeyUrl);
                              }}
                              className="absolute top-3 right-3 rounded-md p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-[#1d9bf0] dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-[#1d9bf0]"
                              title={t.chat.getApiKey || '获取 API Key'}
                            >
                              <ExternalLink className="h-4 w-4" />
                            </button>
                          ) : 'authAction' in preset ? (
                            <button
                              type="button"
                              onClick={e => {
                                e.stopPropagation();
                                void handleStartCodexAuth();
                              }}
                              disabled={codexLoginBusy}
                              className={`absolute top-3 right-3 rounded-md p-1.5 transition-colors ${
                                codexAuthenticated
                                  ? 'text-emerald-600 hover:bg-emerald-50 dark:text-emerald-300 dark:hover:bg-emerald-950/50'
                                  : 'text-slate-400 hover:bg-slate-100 hover:text-[#1d9bf0] dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-[#1d9bf0]'
                              }`}
                              title="去认证"
                            >
                              <ExternalLink className="h-4 w-4" />
                            </button>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className={`space-y-2 ${isVisionCodeX ? 'opacity-50 pointer-events-none' : ''}`}>
                    <Label htmlFor="base_url">{t.chat.baseUrl} {!isVisionCodeX && '*'}</Label>
                    <Input
                      id="base_url"
                      value={isVisionCodeX ? '' : tempConfig.base_url}
                      onChange={e =>
                        setTempConfig({ ...tempConfig, base_url: e.target.value })
                      }
                      disabled={isVisionCodeX}
                      placeholder={isVisionCodeX ? 'Codex OAuth 无需配置' : 'http://localhost:8080/v1'}
                    />
                    {!tempConfig.base_url && !isVisionCodeX && (
                      <p className="text-xs text-red-500 flex items-center gap-1">
                        <AlertCircle className="w-3 h-3" />
                        {t.chat.baseUrlRequired}
                      </p>
                    )}
                  </div>

                  <div className={`space-y-2 ${isVisionCodeX ? 'opacity-50 pointer-events-none' : ''}`}>
                    <Label htmlFor="api_key">{t.chat.apiKey}</Label>
                    <div className="relative">
                      <Input
                        id="api_key"
                        type={showApiKey ? 'text' : 'password'}
                        value={isVisionCodeX ? '' : tempConfig.api_key}
                        onChange={e =>
                          setTempConfig({ ...tempConfig, api_key: e.target.value })
                        }
                        disabled={isVisionCodeX}
                        placeholder={isVisionCodeX ? 'Codex OAuth 无需配置' : 'Leave empty if not required'}
                        className="pr-10"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => setShowApiKey(!showApiKey)}
                        disabled={isVisionCodeX}
                        className="absolute right-0 top-0 h-full px-3 hover:bg-transparent"
                      >
                        {showApiKey ? (
                          <EyeOff className="w-4 h-4 text-slate-400" />
                        ) : (
                          <Eye className="w-4 h-4 text-slate-400" />
                        )}
                      </Button>
                    </div>
                  </div>

                  <div className={`space-y-2 ${isVisionCodeX ? 'opacity-50 pointer-events-none' : ''}`}>
                    <Label htmlFor="model_name">{t.chat.modelName}</Label>
                    <Input
                      id="model_name"
                      value={isVisionCodeX ? CODEX_DEFAULT_MODEL : tempConfig.model_name}
                      onChange={e =>
                        setTempConfig({ ...tempConfig, model_name: e.target.value })
                      }
                      disabled={isVisionCodeX}
                      placeholder="model-name"
                    />
                  </div>

                  {/* Agent Type */}
                  <div className="space-y-2">
                    <Label className="text-sm font-medium">
                      {t.chat.agentType || 'Agent 类型'}
                    </Label>
                    {isVisionCodeX && (
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        Codex 认证下推荐使用 Codex Agent。
                      </p>
                    )}
                    <div className="grid grid-cols-2 gap-2">
                      {AGENT_PRESETS.map(preset => (
                        <button
                          key={preset.name}
                          type="button"
                          onClick={() =>
                            setTempConfig(prev => ({
                              ...prev,
                              agent_type: preset.name,
                              agent_config_params: preset.defaultConfig,
                            }))
                          }
                          className={`text-left p-3 rounded-lg border transition-all ${
                            tempConfig.agent_type === preset.name
                              ? 'border-[#1d9bf0] bg-[#1d9bf0]/5'
                              : 'border-slate-200 dark:border-slate-700 hover:border-[#1d9bf0]/50 hover:bg-slate-50 dark:hover:bg-slate-800/50'
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            <preset.icon
                              className={`w-4 h-4 ${
                                tempConfig.agent_type === preset.name
                                  ? 'text-[#1d9bf0]'
                                  : 'text-slate-400 dark:text-slate-500'
                              }`}
                            />
                            <span
                              className={`font-medium text-sm ${
                                tempConfig.agent_type === preset.name
                                  ? 'text-[#1d9bf0]'
                                  : 'text-slate-900 dark:text-slate-100'
                              }`}
                            >
                              {preset.displayName}
                            </span>
                          </div>
                          <p
                            className={`text-xs mt-1 ml-6 ${
                              tempConfig.agent_type === preset.name
                                ? 'text-[#1d9bf0]/70'
                                : 'text-slate-500 dark:text-slate-400'
                            }`}
                          >
                            {preset.description}
                          </p>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* MAI Agent config */}
                  {tempConfig.agent_type === 'mai' && (
                    <div className="space-y-2">
                      <Label htmlFor="history_n">
                        {t.chat.history_n || '历史记录数量'}
                      </Label>
                      <Input
                        id="history_n"
                        type="number"
                        min={1}
                        max={10}
                        value={
                          (tempConfig.agent_config_params?.history_n as number | undefined) || 3
                        }
                        onChange={e => {
                          const value = parseInt(e.target.value) || 3;
                          setTempConfig(prev => ({
                            ...prev,
                            agent_config_params: {
                              ...prev.agent_config_params,
                              history_n: value,
                            },
                          }));
                        }}
                        className="w-full"
                      />
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        {t.chat.history_n_hint || '包含的历史截图数量（1-10）'}
                      </p>
                    </div>
                  )}

                  {/* Midscene Agent config */}
                  {tempConfig.agent_type === 'midscene' && (
                    <div className="space-y-2">
                      <Label htmlFor="model_family">模型家族 (Model Family)</Label>
                      <Input
                        id="model_family"
                        type="text"
                        placeholder="e.g. doubao-vision, gemini, qwen3.5"
                        value={
                          (tempConfig.agent_config_params?.model_family as string | undefined) ||
                          'doubao-vision'
                        }
                        onChange={e => {
                          setTempConfig(prev => ({
                            ...prev,
                            agent_config_params: {
                              ...prev.agent_config_params,
                              model_family: e.target.value,
                            },
                          }));
                        }}
                        className="w-full"
                      />
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        Midscene 视觉模型家族标识，常用：doubao-vision、doubao-seed、gemini、qwen3.5
                      </p>
                    </div>
                  )}

                  {/* Max Steps */}
                  <div className="space-y-2">
                    <Label htmlFor="default_max_steps">
                      {t.chat.maxSteps || '最大执行步数'}
                    </Label>
                    <Input
                      id="default_max_steps"
                      type="number"
                      min={1}
                      max={1000}
                      value={tempConfig.default_max_steps}
                      onChange={e => {
                        const value = parseInt(e.target.value) || 100;
                        setTempConfig(prev => ({
                          ...prev,
                          default_max_steps: Math.min(1000, Math.max(1, value)),
                        }));
                      }}
                      className="w-full"
                    />
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      {t.chat.maxStepsHint || '单次任务最大执行步数（1-1000）'}
                    </p>
                  </div>

                  {/* Layered Max Turns */}
                  <div className="space-y-2">
                    <Label htmlFor="layered_max_turns">分层代理最大轮次</Label>
                    <Input
                      id="layered_max_turns"
                      type="number"
                      min={1}
                      value={tempConfig.layered_max_turns}
                      onChange={e => {
                        const value = parseInt(e.target.value) || 50;
                        setTempConfig(prev => ({
                          ...prev,
                          layered_max_turns: Math.max(1, value),
                        }));
                      }}
                      className="w-full"
                    />
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      分层代理模式的最大轮次（最小值为1）
                    </p>
                  </div>
                </TabsContent>

                {/* Decision Model Tab */}
                <TabsContent value="decision" className="space-y-4 mt-4">
                  {/* Hint */}
                  <div className="rounded-lg border border-indigo-200 bg-indigo-50 dark:border-indigo-900 dark:bg-indigo-950/30 p-3 text-sm text-indigo-900 dark:text-indigo-100">
                    <div className="flex items-start gap-2">
                      <Info className="mt-0.5 h-4 w-4 flex-shrink-0" />
                      <div>{t.chat.decisionModelHint}</div>
                    </div>
                  </div>

                  {/* Decision Presets */}
                  <div className="space-y-2">
                    <Label className="text-sm font-medium">
                      {t.chat.selectDecisionPreset}
                    </Label>
                    <div className="grid grid-cols-1 gap-2">
                      {DECISION_PRESETS.map(preset => (
                        <div key={preset.name} className="relative">
                          <button
                            type="button"
                            onClick={() => applyDecisionPreset(preset)}
                            className={`w-full text-left p-3 rounded-lg border transition-all ${
                              tempConfig.decision_provider === preset.name
                                ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-950/50'
                                : 'border-slate-200 dark:border-slate-700 hover:border-indigo-500/50 hover:bg-indigo-50 dark:hover:bg-indigo-950/30'
                            }`}
                          >
                            <div className="flex items-center gap-2">
                              <Server
                                className={`w-4 h-4 ${
                                  tempConfig.decision_provider === preset.name
                                    ? 'text-indigo-600 dark:text-indigo-400'
                                    : 'text-slate-400 dark:text-slate-500'
                                }`}
                              />
                              <span className="font-medium text-sm text-slate-900 dark:text-slate-100">
                                {
                                  t.presetConfigs[
                                    preset.name as keyof typeof t.presetConfigs
                                  ].name
                                }
                              </span>
                            </div>
                            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 ml-6">
                              {
                                t.presetConfigs[
                                  preset.name as keyof typeof t.presetConfigs
                                ].description
                              }
                            </p>
                          </button>
                          {'apiKeyUrl' in preset ? (
                            <button
                              type="button"
                              onClick={e => {
                                e.stopPropagation();
                                openExternalPage(preset.apiKeyUrl);
                              }}
                              className="absolute top-3 right-3 rounded-md p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-indigo-600 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-indigo-400"
                              title={t.chat.getApiKey || '获取 API Key'}
                            >
                              <ExternalLink className="h-4 w-4" />
                            </button>
                          ) : 'authAction' in preset ? (
                            <button
                              type="button"
                              onClick={e => {
                                e.stopPropagation();
                                void handleStartCodexAuth();
                              }}
                              disabled={codexLoginBusy}
                              className={`absolute top-3 right-3 rounded-md p-1.5 transition-colors ${
                                codexAuthenticated
                                  ? 'text-emerald-600 hover:bg-emerald-50 dark:text-emerald-300 dark:hover:bg-emerald-950/50'
                                  : 'text-slate-400 hover:bg-slate-100 hover:text-indigo-600 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-indigo-400'
                              }`}
                              title="去认证"
                            >
                              <ExternalLink className="h-4 w-4" />
                            </button>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Decision Base URL */}
                  <div className={`space-y-2 ${isDecisionCodeX ? 'opacity-50 pointer-events-none' : ''}`}>
                    <Label htmlFor="decision_base_url">
                      {t.chat.decisionBaseUrl} {!isDecisionCodeX && '*'}
                    </Label>
                    <Input
                      id="decision_base_url"
                      value={isDecisionCodeX ? '' : tempConfig.decision_base_url}
                      onChange={e =>
                        setTempConfig({ ...tempConfig, decision_base_url: e.target.value })
                      }
                      disabled={isDecisionCodeX}
                      placeholder={isDecisionCodeX ? 'Codex OAuth 无需配置' : 'http://localhost:8080/v1'}
                    />
                  </div>

                  {/* Decision API Key */}
                  <div className={`space-y-2 ${isDecisionCodeX ? 'opacity-50 pointer-events-none' : ''}`}>
                    <Label htmlFor="decision_api_key">
                      {t.chat.decisionApiKey}
                    </Label>
                    <div className="relative">
                      <Input
                        id="decision_api_key"
                        type={showApiKey ? 'text' : 'password'}
                        value={isDecisionCodeX ? '' : tempConfig.decision_api_key}
                        onChange={e =>
                          setTempConfig({ ...tempConfig, decision_api_key: e.target.value })
                        }
                        disabled={isDecisionCodeX}
                        placeholder={isDecisionCodeX ? 'Codex OAuth 无需配置' : 'sk-...'}
                        className="pr-10"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => setShowApiKey(!showApiKey)}
                        disabled={isDecisionCodeX}
                        className="absolute right-0 top-0 h-full px-3 hover:bg-transparent"
                      >
                        {showApiKey ? (
                          <EyeOff className="w-4 h-4 text-slate-400" />
                        ) : (
                          <Eye className="w-4 h-4 text-slate-400" />
                        )}
                      </Button>
                    </div>
                  </div>

                  {/* Decision Model Name */}
                  <div className={`space-y-2 ${isDecisionCodeX ? 'opacity-50 pointer-events-none' : ''}`}>
                    <Label htmlFor="decision_model_name">
                      {t.chat.decisionModelName} {!isDecisionCodeX && '*'}
                    </Label>
                    <Input
                      id="decision_model_name"
                      value={isDecisionCodeX ? CODEX_DEFAULT_MODEL : tempConfig.decision_model_name}
                      onChange={e =>
                        setTempConfig({ ...tempConfig, decision_model_name: e.target.value })
                      }
                      disabled={isDecisionCodeX}
                      placeholder=""
                    />
                  </div>
                </TabsContent>
              </Tabs>
            )}
          </CardContent>
        </Card>

        {/* General */}
        <Card>
          <CardContent className="p-5 space-y-4">
            <div className="flex items-center gap-2">
              <Globe className="h-5 w-5 text-slate-500" />
              <h2 className="font-semibold text-slate-900 dark:text-slate-100">
                {t.settings?.general || 'General'}
              </h2>
            </div>

            {/* Language */}
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
                  {t.settings?.language || 'Language'}
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={toggleLocale}>
                <Globe className="w-4 h-4 mr-2" />
                {localeName}
              </Button>
            </div>

            <Separator />

            {/* Theme */}
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
                  {t.settings?.theme || 'Theme'}
                </p>
              </div>
              <ThemeToggle />
            </div>

            <Separator />

            {/* Version */}
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
                  {t.settings?.version || 'Version'}
                </p>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  v{displayedVersion}
                  {versionMismatch && backendVersion && (
                    <span className="ml-1 text-amber-500">
                      ({t.footer?.versionMismatch || 'Version mismatch'})
                    </span>
                  )}
                </p>
              </div>
              {updateInfo?.has_update && updateInfo.latest_version && (
                <Badge
                  variant="warning"
                  className="cursor-pointer hover:opacity-80 transition-opacity"
                  onClick={() =>
                    updateInfo.release_url &&
                    window.open(updateInfo.release_url, '_blank', 'noopener,noreferrer')
                  }
                >
                  {t.footer?.updateAvailable?.replace(
                    '{version}',
                    updateInfo.latest_version
                  ) || `Update: v${updateInfo.latest_version}`}
                </Badge>
              )}
            </div>

            <Separator />

            {/* GitHub */}
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
                  {t.settings?.github || 'GitHub'}
                </p>
              </div>
              <a
                href="https://github.com/Charlo-O/Novaper"
                target="_blank"
                rel="noopener noreferrer"
              >
                <Button variant="outline" size="sm">
                  <Github className="w-4 h-4 mr-2" />
                  {t.settings?.starOnGithub || 'Star on GitHub'}
                  <ExternalLink className="w-3 h-3 ml-1" />
                </Button>
              </a>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
