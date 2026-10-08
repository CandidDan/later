import Link from "next/link";
export default function Home() {
  return <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-6 p-6">
    <h1 className="text-4xl font-semibold">Later</h1>
    <p className="text-lg">A few things you saved, ready when you are.</p>
    <Link className="rounded-lg bg-foreground px-5 py-4 text-background" href="/revisit">Come back to your saves</Link>
    <nav aria-label="Separate research"><Link className="underline" href="/research">Research</Link></nav>
  </main>;
}
