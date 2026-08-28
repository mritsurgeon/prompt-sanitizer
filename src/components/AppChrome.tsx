import { Lock, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'

export function Header() {
  return (
    <header className="flex items-center justify-between px-6 py-5 sm:px-10">
      <div className="flex items-center gap-2.5">
        <div className="border-primary/30 bg-primary/12 grid size-9 place-items-center rounded-xl border">
          <ShieldCheck className="text-primary size-5" />
        </div>
        <div className="leading-tight">
          <div className="text-[0.95rem] font-semibold tracking-tight">
            AI Safe
          </div>
          <div className="text-muted-foreground text-[0.68rem] tracking-[0.14em] uppercase">
            prompt sanitizer
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <div className="border-primary/25 bg-primary/8 hidden items-center gap-2 rounded-full border px-3.5 py-1.5 sm:flex">
          <span className="relative flex size-1.5">
            <span className="bg-primary absolute inline-flex size-full animate-ping rounded-full opacity-60" />
            <span className="bg-primary relative inline-flex size-1.5 rounded-full" />
          </span>
          <span className="text-primary text-xs font-medium">
            Running locally
          </span>
        </div>
        <HowItWorks />
      </div>
    </header>
  )
}

function HowItWorks() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground hover:text-foreground rounded-full text-xs"
        >
          How it works
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>How this works</DialogTitle>
          <DialogDescription>
            Three quick things worth knowing.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 text-sm">
          <Point title="Nothing is uploaded">
            The whole tool runs inside this browser tab. Your text and files are
            read in memory, scanned in memory, and thrown away when you close
            the tab. It makes no network calls once the page has loaded — you
            can check that in your browser's network tab.
          </Point>
          <Point title="Three passes over your content">
            First a set of precise rules for things with a known shape — email
            addresses, card numbers, keys and tokens. Then a local name and
            company recogniser. Then your company's own patterns: server names,
            customer numbers, case references.
          </Point>
          <Point title="You stay in control">
            Every detection shows what it found, why, and what it will be
            replaced with. Switch off anything you would rather keep. Passwords
            and keys are always removed completely, whichever style you pick.
          </Point>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Point({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div>
      <h4 className="mb-1 font-medium">{title}</h4>
      <p className="text-muted-foreground leading-relaxed">{children}</p>
    </div>
  )
}

export function PrivacyFooter() {
  return (
    <footer className="text-muted-foreground flex flex-col items-center gap-1 px-6 py-8 text-center text-xs">
      <div className="flex items-center gap-2">
        <Lock className="text-primary size-3.5" />
        <span>
          Processed locally. Your original content never leaves this device.
        </span>
      </div>
      <span className="text-muted-foreground/60">
        No account, no upload, no cloud service.
      </span>
    </footer>
  )
}
