import type { ReactNode } from "react";

// Public legal pages (privacy policy, data deletion). Linked from the
// Meta app settings, so they must load without a session — neither path
// is in the middleware's protected list.

export default function LegalLayout({ children }: { children: ReactNode }) {
  return (
    <main className="min-h-screen bg-background px-4 py-12 text-foreground">
      <article className="mx-auto max-w-3xl space-y-6 text-sm leading-relaxed text-muted-foreground [&_h1]:text-3xl [&_h1]:font-bold [&_h1]:tracking-tight [&_h1]:text-foreground [&_h2]:mt-8 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-foreground [&_a]:text-primary [&_a]:underline [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:space-y-1 [&_ol]:pl-5 [&_strong]:text-foreground">
        {children}
      </article>
    </main>
  );
}
