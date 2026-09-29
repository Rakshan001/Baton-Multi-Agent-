// Copied from Orca (MIT, Copyright (c) 2026 Lovecast Inc.), src/renderer/src/components/ui/sonner.tsx.
// Modified for Baton where noted. See NOTICE.
import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon
} from 'lucide-react'
import { Toaster as Sonner, type ToasterProps } from 'sonner'

// Baton: the theme comes from usePrefs via the `theme` prop (Orca read its store).
const Toaster = ({ theme = 'system', ...props }: ToasterProps) => {

  return (
    <Sonner
      theme={theme as ToasterProps['theme']}
      position="bottom-right"
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />
      }}
      style={
        {
          '--normal-bg': 'var(--bg-elevated)',
          '--normal-text': 'var(--text-primary)',
          '--normal-border': 'var(--border-default)',
          '--border-radius': 'var(--r-lg)'
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
