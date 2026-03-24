import { createFileRoute } from '@tanstack/react-router'
import { AlertTriangle } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

export const Route = createFileRoute('/mobile')({
  component: MobileRoutePlaceholder,
})

function MobileRoutePlaceholder() {
  return (
    <div className="min-h-full bg-slate-50 px-4 py-6 dark:bg-slate-950 sm:px-6">
      <div className="mx-auto max-w-4xl">
        <Card className="border-amber-300/70 bg-white/90 dark:border-amber-500/20 dark:bg-slate-950/90">
          <CardHeader className="space-y-3">
            <Badge variant="secondary" className="w-fit">
              Temporarily disabled
            </Badge>
            <CardTitle className="flex items-center gap-3 text-2xl">
              <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-amber-500/12 text-amber-700 dark:text-amber-300">
                <AlertTriangle className="h-5 w-5" />
              </span>
              Mobile Bridge
            </CardTitle>
            <CardDescription className="max-w-2xl text-sm leading-6">
              This section is temporarily excluded from the local build so the main
              application can start cleanly.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-sm text-slate-600 dark:text-slate-300">
            <p>
              The route is still reserved at <code>/mobile</code>, but the live pairing
              and messaging UI is disabled for now.
            </p>
            <p>
              Once the Mobile Bridge API surface is restored, this page can be switched
              back to the full implementation.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
