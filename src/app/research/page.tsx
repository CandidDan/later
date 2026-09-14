import ResearchConsole from "./console";

export const dynamic = "force-dynamic";

export const metadata = { title: "Later research", robots: { index: false, follow: false } };

/**
 * The research console shell. It renders no capture, analysis or evaluation data: everything
 * on screen arrives from the authenticated API, so an unauthenticated visit — or a signed-in
 * stranger — receives a page with nothing in it to read.
 */
export default function ResearchPage() {
  return (
    <main className="flex flex-1 flex-col items-center gap-6 p-6">
      <h1 className="text-sm uppercase tracking-wide text-zinc-500">Evaluate one capture</h1>
      <ResearchConsole />
    </main>
  );
}
