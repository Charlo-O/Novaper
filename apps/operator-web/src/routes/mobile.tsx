import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import {
  AlertTriangle,
  Link2,
  Loader2,
  MessageSquare,
  QrCode,
  RefreshCw,
  Send,
  ShieldCheck,
  Smartphone,
  Trash2,
  Wifi,
} from 'lucide-react'
import {
  createMobileBridgePairing,
  getErrorMessage,
  getMobileBridgeMessages,
  getMobileBridgeStatus,
  listMobileBridgeClients,
  removeMobileBridgeClient,
  sendMobileBridgeMessage,
  type MobileBridgeClient,
  type MobileBridgeMessage,
  type MobileBridgePairingResponse,
  type MobileBridgeStatusResponse,
} from '../api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'

export const Route = createFileRoute('/mobile')({
  component: MobileBridgePage,
})

function formatDateTime(value: string | null) {
  if (!value) {
    return 'No activity yet'
  }
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value))
  } catch {
    return value
  }
}

function clientSubtitle(client: MobileBridgeClient) {
  return `${client.platform.toUpperCase()} · last seen ${formatDateTime(client.last_seen_at)}`
}

function bubbleTone(message: MobileBridgeMessage) {
  if (message.direction === 'desktop_to_mobile') {
    return 'self-end rounded-3xl rounded-br-md bg-sky-500/12 text-sky-950 dark:text-sky-100'
  }
  if (message.direction === 'mobile_to_desktop') {
    return 'self-start rounded-3xl rounded-bl-md bg-slate-900/6 text-slate-900 dark:bg-slate-100/10 dark:text-slate-100'
  }
  return 'self-center rounded-full border border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
}

function MobileBridgePage() {
  const [status, setStatus] = useState<MobileBridgeStatusResponse | null>(null)
  const [pairing, setPairing] = useState<MobileBridgePairingResponse | null>(null)
  const [clients, setClients] = useState<MobileBridgeClient[]>([])
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null)
  const [messages, setMessages] = useState<MobileBridgeMessage[]>([])
  const [draft, setDraft] = useState('')
  const [isRefreshing, setIsRefreshing] = useState(true)
  const [isGeneratingPairing, setIsGeneratingPairing] = useState(false)
  const [isSending, setIsSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    const loadOverview = async (showSpinner: boolean) => {
      if (showSpinner) {
        setIsRefreshing(true)
      }
      try {
        const [nextStatus, nextClients] = await Promise.all([
          getMobileBridgeStatus(),
          listMobileBridgeClients(),
        ])
        if (cancelled) {
          return
        }
        setStatus(nextStatus)
        setClients(nextClients.clients)
        setError(null)
      } catch (nextError) {
        if (!cancelled) {
          setError(getErrorMessage(nextError))
        }
      } finally {
        if (!cancelled) {
          setIsRefreshing(false)
        }
      }
    }

    void loadOverview(true)
    const intervalId = window.setInterval(() => {
      void loadOverview(false)
    }, 4000)

    return () => {
      cancelled = true
      window.clearInterval(intervalId)
    }
  }, [])

  useEffect(() => {
    if (clients.length === 0) {
      if (selectedClientId !== null) {
        setSelectedClientId(null)
      }
      return
    }
    if (!selectedClientId || !clients.some((client) => client.id === selectedClientId)) {
      setSelectedClientId(clients[0].id)
    }
  }, [clients, selectedClientId])

  useEffect(() => {
    if (!selectedClientId) {
      setMessages([])
      return
    }

    let cancelled = false

    const loadMessages = async () => {
      try {
        const nextMessages = await getMobileBridgeMessages(selectedClientId)
        if (!cancelled) {
          setMessages(nextMessages.messages)
        }
      } catch (nextError) {
        if (!cancelled) {
          setError(getErrorMessage(nextError))
        }
      }
    }

    void loadMessages()
    const intervalId = window.setInterval(() => {
      void loadMessages()
    }, 3000)

    return () => {
      cancelled = true
      window.clearInterval(intervalId)
    }
  }, [selectedClientId])

  const selectedClient =
    selectedClientId == null
      ? null
      : clients.find((client) => client.id === selectedClientId) ?? null

  async function handleRefresh() {
    setIsRefreshing(true)
    try {
      const [nextStatus, nextClients] = await Promise.all([
        getMobileBridgeStatus(),
        listMobileBridgeClients(),
      ])
      setStatus(nextStatus)
      setClients(nextClients.clients)
      setError(null)
    } catch (nextError) {
      setError(getErrorMessage(nextError))
    } finally {
      setIsRefreshing(false)
    }
  }

  async function handleGeneratePairing() {
    setIsGeneratingPairing(true)
    try {
      const nextPairing = await createMobileBridgePairing()
      setPairing(nextPairing)
      setError(null)
      await handleRefresh()
    } catch (nextError) {
      setError(getErrorMessage(nextError))
    } finally {
      setIsGeneratingPairing(false)
    }
  }

  async function handleSendMessage() {
    if (!selectedClientId || !draft.trim()) {
      return
    }
    setIsSending(true)
    try {
      const message = await sendMobileBridgeMessage(selectedClientId, draft.trim())
      setMessages((current) => [...current, message])
      setDraft('')
      setError(null)
      await handleRefresh()
    } catch (nextError) {
      setError(getErrorMessage(nextError))
    } finally {
      setIsSending(false)
    }
  }

  async function handleRemoveClient(clientId: string) {
    try {
      await removeMobileBridgeClient(clientId)
      if (selectedClientId === clientId) {
        setSelectedClientId(null)
        setMessages([])
      }
      setError(null)
      await handleRefresh()
    } catch (nextError) {
      setError(getErrorMessage(nextError))
    }
  }

  return (
    <div className="min-h-full bg-[radial-gradient(circle_at_top,_rgba(125,211,252,0.22),_transparent_30%),linear-gradient(180deg,_rgba(240,249,255,0.95),_rgba(248,250,252,0.94))] px-4 py-5 dark:bg-[radial-gradient(circle_at_top,_rgba(14,165,233,0.18),_transparent_26%),linear-gradient(180deg,_rgba(2,6,23,0.96),_rgba(15,23,42,0.98))] sm:px-6">
      <div className="mx-auto flex max-w-7xl flex-col gap-5">
        <Card className="overflow-hidden border-sky-200/60 bg-white/85 shadow-[0_24px_80px_-42px_rgba(14,165,233,0.45)] backdrop-blur dark:border-sky-400/10 dark:bg-slate-950/80">
          <CardHeader className="gap-4 md:flex-row md:items-center md:justify-between">
            <div className="space-y-2">
              <Badge variant="secondary" className="w-fit bg-sky-500/10 text-sky-700 dark:text-sky-300">
                OpenClaw-style mobile pairing
              </Badge>
              <CardTitle className="flex items-center gap-3 text-2xl">
                <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-sky-500/12 text-sky-600 dark:text-sky-300">
                  <Smartphone className="h-5 w-5" />
                </span>
                Mobile Bridge
              </CardTitle>
              <CardDescription className="max-w-3xl text-sm leading-6">
                Novaper now exposes a separate mobile companion endpoint with a one-time setup
                code, QR pairing flow, and live message bridge. The desktop control API stays on
                loopback, while the phone only sees the scoped companion surface.
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              {status && (
                <>
                  <Badge variant="outline" className="border-slate-300/70 bg-white/80 dark:bg-slate-900/70">
                    <Wifi className="mr-1 h-3.5 w-3.5" />
                    {status.lan_host}:{status.companion_port}
                  </Badge>
                  <Badge variant={status.online_clients > 0 ? 'success' : 'secondary'}>
                    {status.online_clients} online / {status.total_clients} paired
                  </Badge>
                </>
              )}
              <Button onClick={handleRefresh} disabled={isRefreshing} className="gap-2">
                {isRefreshing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                Refresh
              </Button>
            </div>
          </CardHeader>
        </Card>

        {error && (
          <Card className="border-amber-300/70 bg-amber-50/90 dark:border-amber-500/20 dark:bg-amber-500/10">
            <CardContent className="flex items-start gap-3 p-4 text-sm text-amber-900 dark:text-amber-100">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <span>{error}</span>
            </CardContent>
          </Card>
        )}

        <div className="grid gap-5 xl:grid-cols-[1.05fr_1.45fr]">
          <div className="space-y-5">
            <Card className="border-slate-200/80 bg-white/90 dark:border-slate-800 dark:bg-slate-950/82">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <ShieldCheck className="h-4 w-4 text-sky-500" />
                  Bridge Status
                </CardTitle>
                <CardDescription>
                  Reachable companion endpoint and current pairing activity.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 text-sm">
                <div className="grid gap-2 rounded-2xl border border-slate-200/80 bg-slate-50/80 p-4 dark:border-slate-800 dark:bg-slate-900/50">
                  <span className="text-xs uppercase tracking-[0.18em] text-slate-500">
                    Public companion URL
                  </span>
                  <a
                    href={status?.public_url ?? '#'}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-2 break-all font-medium text-sky-700 hover:text-sky-800 dark:text-sky-300"
                  >
                    <Link2 className="h-4 w-4 flex-shrink-0" />
                    {status?.public_url ?? 'Loading...'}
                  </a>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div className="rounded-2xl bg-slate-950 px-4 py-3 text-white dark:bg-slate-900">
                    <div className="text-xs uppercase tracking-[0.16em] text-slate-400">Paired</div>
                    <div className="mt-2 text-2xl font-semibold">{status?.total_clients ?? '-'}</div>
                  </div>
                  <div className="rounded-2xl bg-sky-500 px-4 py-3 text-sky-950">
                    <div className="text-xs uppercase tracking-[0.16em] text-sky-900/70">Online</div>
                    <div className="mt-2 text-2xl font-semibold">{status?.online_clients ?? '-'}</div>
                  </div>
                  <div className="rounded-2xl bg-emerald-500/12 px-4 py-3 text-emerald-800 dark:text-emerald-200">
                    <div className="text-xs uppercase tracking-[0.16em] text-emerald-700/70 dark:text-emerald-200/70">
                      Active Codes
                    </div>
                    <div className="mt-2 text-2xl font-semibold">{status?.active_pairings ?? '-'}</div>
                  </div>
                </div>
                {status?.warning_messages?.length ? (
                  <div className="space-y-2 rounded-2xl border border-amber-300/60 bg-amber-50/80 p-4 text-amber-900 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-100">
                    {status.warning_messages.map((message) => (
                      <div key={message} className="flex items-start gap-2">
                        <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                        <span>{message}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </CardContent>
            </Card>

            <Card className="border-slate-200/80 bg-white/90 dark:border-slate-800 dark:bg-slate-950/82">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <QrCode className="h-4 w-4 text-sky-500" />
                  Pair a Phone
                </CardTitle>
                <CardDescription>
                  Generate a short-lived setup code using the same bootstrap-token pattern as
                  OpenClaw.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <Button onClick={handleGeneratePairing} disabled={isGeneratingPairing} className="w-full gap-2">
                  {isGeneratingPairing ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <QrCode className="h-4 w-4" />
                  )}
                  Generate Pairing QR
                </Button>

                {pairing ? (
                  <div className="space-y-4">
                    <div className="rounded-[28px] border border-sky-200/70 bg-white p-4 dark:border-sky-400/10 dark:bg-slate-900">
                      <div className="flex justify-center rounded-[24px] bg-white p-4">
                        <QRCodeSVG value={pairing.pairing_url} size={220} includeMargin />
                      </div>
                    </div>
                    <div className="grid gap-3">
                      <div className="rounded-2xl bg-slate-50/80 p-3 dark:bg-slate-900/60">
                        <div className="mb-2 text-xs uppercase tracking-[0.16em] text-slate-500">
                          Pairing URL
                        </div>
                        <Input readOnly value={pairing.pairing_url} className="bg-white/90 dark:bg-slate-950" />
                      </div>
                      <div className="rounded-2xl bg-slate-50/80 p-3 dark:bg-slate-900/60">
                        <div className="mb-2 text-xs uppercase tracking-[0.16em] text-slate-500">
                          Setup Code
                        </div>
                        <Textarea readOnly value={pairing.setup_code} rows={4} className="bg-white/90 dark:bg-slate-950" />
                      </div>
                      <div className="text-xs text-slate-500">
                        Expires at {formatDateTime(new Date(pairing.expires_at).toISOString())}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="rounded-2xl border border-dashed border-slate-300/80 bg-slate-50/80 p-5 text-sm text-slate-500 dark:border-slate-700 dark:bg-slate-900/50">
                    Generate a pairing code, then scan it from the mobile companion page or open the
                    encoded URL directly on the phone.
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-5 lg:grid-cols-[0.9fr_1.1fr]">
            <Card className="border-slate-200/80 bg-white/90 dark:border-slate-800 dark:bg-slate-950/82">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <Smartphone className="h-4 w-4 text-sky-500" />
                  Paired Phones
                </CardTitle>
                <CardDescription>Select a device to inspect its bridge traffic.</CardDescription>
              </CardHeader>
              <CardContent className="pt-0">
                <ScrollArea className="h-[34rem] rounded-2xl">
                  <div className="space-y-3 pr-3">
                    {clients.length === 0 ? (
                      <div className="rounded-2xl border border-dashed border-slate-300/80 bg-slate-50/70 p-5 text-sm text-slate-500 dark:border-slate-700 dark:bg-slate-900/40">
                        No phones are paired yet.
                      </div>
                    ) : (
                      clients.map((client) => {
                        const isActive = client.id === selectedClientId
                        return (
                          <button
                            key={client.id}
                            type="button"
                            onClick={() => setSelectedClientId(client.id)}
                            className={[
                              'w-full rounded-2xl border px-4 py-4 text-left transition-all',
                              isActive
                                ? 'border-sky-300 bg-sky-500/10 shadow-[0_20px_40px_-28px_rgba(14,165,233,0.5)] dark:border-sky-400/30'
                                : 'border-slate-200 bg-white/80 hover:border-slate-300 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900/60 dark:hover:border-slate-700',
                            ].join(' ')}
                          >
                            <div className="flex items-center justify-between gap-3">
                              <div className="min-w-0">
                                <div className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
                                  {client.name}
                                </div>
                                <div className="mt-1 text-xs text-slate-500">{clientSubtitle(client)}</div>
                              </div>
                              <Badge variant={client.status === 'online' ? 'success' : 'secondary'}>
                                {client.status}
                              </Badge>
                            </div>
                          </button>
                        )
                      })
                    )}
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>

            <Card className="border-slate-200/80 bg-white/90 dark:border-slate-800 dark:bg-slate-950/82">
              <CardHeader className="flex-row items-start justify-between gap-3">
                <div>
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <MessageSquare className="h-4 w-4 text-sky-500" />
                    {selectedClient ? selectedClient.name : 'Conversation'}
                  </CardTitle>
                  <CardDescription>
                    {selectedClient
                      ? `Bridge lane for ${selectedClient.platform.toUpperCase()} · paired ${formatDateTime(selectedClient.paired_at)}`
                      : 'Choose a paired phone to open the message lane.'}
                  </CardDescription>
                </div>
                {selectedClient ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-2"
                    onClick={() => void handleRemoveClient(selectedClient.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                    Remove
                  </Button>
                ) : null}
              </CardHeader>
              <CardContent className="grid gap-4">
                <ScrollArea className="h-[26rem] rounded-3xl border border-slate-200/80 bg-slate-50/80 p-4 dark:border-slate-800 dark:bg-slate-900/60">
                  <div className="flex min-h-full flex-col gap-3 pr-3">
                    {selectedClient == null ? (
                      <div className="flex h-full items-center justify-center text-sm text-slate-500">
                        Select a phone from the list to view its live bridge messages.
                      </div>
                    ) : messages.length === 0 ? (
                      <div className="flex h-full items-center justify-center text-sm text-slate-500">
                        No messages yet. Send the first note from desktop or from the phone.
                      </div>
                    ) : (
                      messages.map((message) => (
                        <div key={message.id} className={['max-w-[85%] px-4 py-3 text-sm shadow-sm', bubbleTone(message)].join(' ')}>
                          <div className="whitespace-pre-wrap break-words">{message.body}</div>
                          <div className="mt-2 text-[11px] uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
                            {message.direction === 'desktop_to_mobile'
                              ? 'Desktop'
                              : message.direction === 'mobile_to_desktop'
                                ? 'Mobile'
                                : 'System'}{' '}
                            · {formatDateTime(message.created_at)}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </ScrollArea>

                <div className="rounded-3xl border border-slate-200/80 bg-white/80 p-4 dark:border-slate-800 dark:bg-slate-950/60">
                  <Textarea
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    rows={4}
                    placeholder={
                      selectedClient
                        ? 'Send a message to the paired phone. The mobile companion will receive it instantly.'
                        : 'Select a phone before sending a message.'
                    }
                    disabled={!selectedClient || isSending}
                    className="border-none bg-transparent p-0 shadow-none focus-visible:ring-0"
                  />
                  <div className="mt-4 flex items-center justify-between gap-3">
                    <div className="text-xs text-slate-500">
                      {selectedClient
                        ? `Last activity ${formatDateTime(selectedClient.last_message_at ?? selectedClient.last_seen_at)}`
                        : 'No active device selected'}
                    </div>
                    <Button
                      onClick={() => void handleSendMessage()}
                      disabled={!selectedClient || !draft.trim() || isSending}
                      className="gap-2"
                    >
                      {isSending ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Send className="h-4 w-4" />
                      )}
                      Send
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}
