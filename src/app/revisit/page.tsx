import Link from "next/link";
import ReturnPage from "./return-page";
export const dynamic = "force-dynamic";
export const metadata = { title: "Come back to this · Later", robots: { index: false, follow: false } };
export default function RevisitPage() {
  return <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 p-5 sm:p-8">
    <h1 className="text-3xl font-semibold">Come back to this</h1>
    <ReturnPage />
    <nav aria-label="Separate research"><Link className="underline" href="/research">Research</Link></nav>
  </main>;
}
